// The formatted note editor of the web app (design opmaak-editor, part 6). Bundled by `npm run build:cloud-editor`
// into cloud/web/editor.mjs; the formatting core and the table grid stay separate files that the server serves.
//
// The Markdown text is and stays the source: the CodeMirror document is the note's text, byte for byte. Formatting
// only hides signs on the screen (decorations from the shared core, format.mjs), a button is one small replacement,
// and a table is a grid widget whose changes go back as tableEdit replacements. The module knows nothing of app.js:
// everything goes through createBodyEditor's functions, so the Obsidian edit window can use it later.
//
// The Content Security Policy allows no inline <style>. CodeMirror is mounted in a shadow root, where it uses an
// adopted (constructed) style sheet instead of a <style> element, and our own style comes in with a <link>.
import { EditorSelection, EditorState, Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, toggleTabFocusMode } from '@codemirror/commands';
import { activeFormats, applyFormat, backspaceEdit, blocks, checklistEdit, emptyPair, indentEdit, inlineSpans, linePrefix, listEnterEdit, listLevels, parseTable, tableEdit, tickEdit } from '/shared/format.mjs';
import { createTableGrid } from '/shared/table-grid.mjs';

// Above this many characters the note shows raw, for speed.
export const RAW_ABOVE = 50000;
const INLINE_COMMANDS = new Set(['bold', 'italic', 'strike', 'highlight', 'code']);
const LIST_COMMANDS = new Set(['indent', 'outdent', 'checklist']);
const TABLE_COMMANDS = new Set(['addRow', 'addColumn', 'deleteRow', 'deleteColumn', 'alignLeft', 'alignCenter', 'alignRight', 'deleteTable']);
const MARK_CLASS = { bold: 'cm-jd-bold', italic: 'cm-jd-italic', strike: 'cm-jd-strike', highlight: 'cm-jd-mark', code: 'cm-jd-code', link: 'cm-jd-link', wikilink: 'cm-jd-link', url: 'cm-jd-link' };
const setFormatted = StateEffect.define();

const DEFAULT_LABELS = {
  note: 'Note',
  placeholder: 'Take a note…',
  done: 'Done',
  table: 'Table',
  keys: 'In a list, Tab and Shift+Tab change the level of an item. To leave the note with Tab, press Ctrl+M first.',
};

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM(view) {
    const dot = view.dom.ownerDocument.createElement('span');
    dot.className = 'cm-jd-bullet';
    dot.textContent = '•';
    return dot;
  }
}

class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM(view) {
    const line = view.dom.ownerDocument.createElement('span');
    line.className = 'cm-jd-hr';
    line.setAttribute('aria-hidden', 'true');
    return line;
  }
}

/**
 * The box of a task: ☐ or ☑ (a shape, not only a color). A click ticks it in the source through the shared core, so
 * with "Move checked items to the bottom" the task moves too; the caret stays in its own text and does not jump.
 */
class BoxWidget extends WidgetType {
  constructor(checked, host) { super(); this.checked = checked; this.host = host; }
  eq(other) { return other.checked === this.checked; }
  toDOM(view) {
    const box = view.dom.ownerDocument.createElement('span');
    box.className = `cm-jd-box${this.checked ? ' cm-jd-box-checked' : ''}`;
    box.textContent = this.checked ? '☑' : '☐';
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(this.checked));
    box.setAttribute('aria-label', this.host.labels.done);
    box.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const line = view.state.doc.lineAt(view.posAtDOM(box)).number - 1, { main } = view.state.selection;
      const edit = tickEdit(view.state.doc.toString(), line, this.host.moveChecked(), main.from, main.to);
      if (!edit) return;
      view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: EditorSelection.single(edit.selFrom, edit.selTo), userEvent: 'input.check' });
    });
    return box;
  }
  ignoreEvent() { return true; }
}

// Levels show up to 8 deep in the editor (design kaarten-en-lijsten, part 7); deeper lines stay on level 8.
const MAX_LEVEL = 8;

/**
 * The list lines and the lines of more text under an item, per line number from 0: { level, kind } for a list line,
 * { level, kind, more: true } for more text (the level and kind of its item); null for every other line.
 */
function listLines(text) {
  const levels = listLevels(text), lines = text.split('\n'), out = [];
  lines.forEach((line, index) => {
    if (levels[index] >= 0) { out.push({ level: levels[index], kind: linePrefix(line).kind }); return; }
    // More text under an item: indented, not blank, right after a list line or more text, and not a new list.
    const above = out[index - 1];
    out.push(above && line.trim() && /^[ \t]/.test(line) && !linePrefix(line).kind ? { ...above, more: true } : null);
  });
  return out;
}

/** A table as a grid. Equal source means equal widget, so selection changes never redraw it. */
class TableWidget extends WidgetType {
  constructor(source, edges, host) { super(); this.source = source; this.edges = edges; this.host = host; }
  eq(other) { return other.source === this.source && other.edges.top === this.edges.top && other.edges.bottom === this.edges.bottom; }
  get table() { return parseTable(this.source.split('\n')); }
  toDOM(view) { return this.host.makeGrid(view, this); }
  updateDOM(dom) {
    if (!dom.jdGrid) return false;
    dom.jdGrid.update(this.table, this.edges);
    return true;
  }
  destroy(dom) { this.host.forget(dom); }
  ignoreEvent() { return true; }
  get estimatedHeight() { return (this.source.split('\n').length - 1) * 34 + 8; }
}

/**
 * The decorations: signs always hidden (Eric, 16 nov: a heading or bold text must never show its codes, not even at
 * the caret or in a selection; the Markdown switch is for seeing them), lines styled, tables as grids. `atomic` lists
 * the hidden ranges, so the caret and Backspace treat a hidden sign as one step instead of landing inside it.
 */
function decorate(state, formatted, host) {
  const none = { decorations: Decoration.none, atomic: Decoration.none, signs: [] };
  const source = state.doc.toString();
  if (!formatted || source.length > RAW_ABOVE) return none;
  const out = [], hidden = [];
  // A button pressed before typing leaves an empty pair at the caret: hidden, and read as spaces, so `****` is no rule
  // and `~~~~` no code fence while the caret waits in it.
  const { main } = state.selection, pair = emptyPair(source, main.from, main.to);
  const text = pair ? source.slice(0, pair.from) + ' '.repeat(pair.to - pair.from) + source.slice(pair.to) : source;
  const lineText = (line) => text.slice(line.from, line.to);
  // `signs`: only what is hidden outright (no widget), for Backspace (format.mjs, backspaceEdit).
  const signs = [];
  const hide = (from, to) => { if (to > from) { const range = Decoration.replace({}).range(from, to); out.push(range); hidden.push(range); signs.push([from, to]); } };
  const replaceWith = (widget, from, to) => { const range = Decoration.replace({ widget }).range(from, to); out.push(range); hidden.push(range); };
  if (pair) {
    hide(pair.from, main.from);
    hide(main.from, pair.to);
  }
  const lists = listLines(text);
  for (const run of blocks(text)) {
    if (run.kind === 'table') {
      const source = text.slice(run.from, run.to);
      const edges = { top: run.from === 0, bottom: run.to === text.length };
      out.push(Decoration.replace({ widget: new TableWidget(source, edges, host), block: true }).range(run.from, run.to));
      continue;
    }
    for (let number = run.fromLine; number <= run.toLine; number++) {
      const line = state.doc.line(number + 1);
      if (run.kind === 'code') {
        const fence = number === run.fromLine || (number === run.toLine && /^ {0,3}(`{3,}|~{3,})/.test(lineText(line)));
        out.push(Decoration.line({ class: fence ? 'cm-jd-codeblock cm-jd-fence' : 'cm-jd-codeblock' }).range(line.from));
        continue;
      }
      const prefix = linePrefix(lineText(line));
      const at = (offset) => line.from + offset;
      // A list line springs in per level and wraps under its own words; the tab or spaces themselves are hidden.
      const list = lists[number];
      if (list) {
        const level = Math.min(list.level, MAX_LEVEL);
        out.push(Decoration.line({ class: `${list.more ? 'cm-jd-more' : 'cm-jd-li'} cm-jd-li-${list.kind} cm-jd-l${level}` }).range(line.from));
        hide(line.from, at(prefix.indent));
      }
      switch (prefix.kind) {
        case 'heading':
          out.push(Decoration.line({ class: `cm-jd-h cm-jd-h${prefix.level}` }).range(line.from));
          hide(at(prefix.markFrom), at(prefix.markTo));
          break;
        case 'quote':
          out.push(Decoration.line({ class: 'cm-jd-quote' }).range(line.from));
          hide(at(prefix.markFrom), at(prefix.markTo));
          break;
        case 'rule':
          out.push(Decoration.line({ class: 'cm-jd-rule' }).range(line.from));
          replaceWith(new RuleWidget(), at(prefix.markFrom), line.to);
          continue;
        case 'bullet':
          replaceWith(new BulletWidget(), at(prefix.markFrom), at(prefix.markFrom + 1));
          break;
        case 'task': {
          const close = lineText(line).indexOf(']', prefix.markFrom) + 1;
          if (prefix.checked) out.push(Decoration.line({ class: 'cm-jd-done' }).range(line.from));
          replaceWith(new BoxWidget(prefix.checked, host), at(prefix.markFrom), at(close));
          break;
        }
        case 'ordered':
          out.push(Decoration.mark({ class: 'cm-jd-number' }).range(at(prefix.markFrom), at(prefix.markTo)));
          break;
        default:
      }
      // Inline signs after the line's own sign, so a bullet star is never read as italic.
      const offset = line.from + prefix.markTo;
      for (const span of inlineSpans(lineText(line).slice(prefix.markTo))) {
        const from = offset + span.from, to = offset + span.to, openTo = offset + span.openTo, closeFrom = offset + span.closeFrom;
        hide(from, openTo);
        hide(closeFrom, to);
        const name = MARK_CLASS[span.kind];
        if (name && closeFrom > openTo) out.push(Decoration.mark({ class: name }).range(openTo, closeFrom));
      }
    }
  }
  return { decorations: Decoration.set(out, true), atomic: Decoration.set(hidden, true), signs };
}

/**
 * createBodyEditor({ parent, value, formatted, labels, onChange, onState, isTableTool, stylesheet })
 *   → { element, getValue, setValue, focus, getSelection, setSelection, replace(edit), insertText(text),
 *       apply(command), activeFormats(), context(), setFormatted(bool), flush(), destroy() }
 * onChange(text) runs on every change the user makes (not for setValue); onState({ context, active }) whenever the
 * selection, the text or the focus changes, so the host can show which buttons are on and which bar to show.
 */
export function createBodyEditor({ parent, value = '', formatted = true, labels: given = {}, onChange, onState, isTableTool, moveChecked = () => false, stylesheet = '/editor.css' }) {
  const doc = parent.ownerDocument;
  const labels = { ...DEFAULT_LABELS, ...given };
  let view, context = 'text', activeGrid = null;
  const grids = new Set();

  const element = doc.createElement('div');
  element.className = 'jd-editor-host';
  parent.append(element);
  const root = element.attachShadow({ mode: 'open' });
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = stylesheet;
  const mount = doc.createElement('div');
  mount.className = 'jd-editor';
  root.append(link, mount);

  const notify = () => onState?.({ context, active: currentFormats() });

  /** Where the table with this grid starts, as a line number from 0. */
  const tableLine = (dom) => view.state.doc.lineAt(view.posAtDOM(dom)).number - 1;
  const gridAtLine = (line) => [...grids].find((dom) => dom.isConnected && tableLine(dom) === line)?.jdGrid;

  const host = {
    labels,
    moveChecked,
    makeGrid(editorView, widget) {
      let grid;
      grid = createTableGrid(doc, {
        table: widget.table,
        edges: widget.edges,
        labels: given.grid,
        onEdit: (op) => {
          const edit = tableEdit(editorView.state.doc.toString(), tableLine(grid.element), op);
          if (edit) editorView.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, userEvent: 'input.table' });
        },
        onFocusCell: () => { context = 'table'; activeGrid = grid; notify(); },
        // The table bar stays while the focus goes to the next cell or to the host's own table tools.
        onBlurCell: () => setTimeout(() => {
          if (activeGrid !== grid || grid.activeCell()) return;
          if (isTableTool?.(doc.activeElement) || (root.activeElement && grid.element.contains(root.activeElement))) return;
          context = 'text';
          activeGrid = null;
          notify();
        }),
        onLeave: (where) => leaveTable(grid, where),
        onTypeOutside: (where) => typeOutside(grid, where),
      });
      grid.element.jdGrid = grid;
      grids.add(grid.element);
      return grid.element;
    },
    forget(dom) { grids.delete(dom); if (activeGrid?.element === dom) activeGrid = null; },
  };

  /** The table run (format.mjs `blocks`) that starts on this line. */
  const runAt = (line) => blocks(view.state.doc.toString()).find((item) => item.kind === 'table' && item.fromLine === line);

  /** The caret in the text right before or after a table; at the edge of the text, a new line is made there. */
  function leaveTable(grid, where) {
    const run = runAt(tableLine(grid.element));
    if (!run) return;
    if (where === 'before' && run.from === 0) return typeOutside(grid, 'before');
    if (where === 'after' && run.to === view.state.doc.length) return typeOutside(grid, 'after');
    context = 'text';
    activeGrid = null;
    view.focus();
    view.dispatch({ selection: { anchor: where === 'before' ? run.from - 1 : run.to + 1 }, scrollIntoView: true });
  }

  /** Typing above a table at the very start or below one at the very end: a new line with a blank line between. */
  function typeOutside(grid, where) {
    const run = runAt(tableLine(grid.element));
    if (!run) return;
    const cr = view.state.doc.lineAt(run.from).text.endsWith('\r') ? '\r' : '';
    const pos = where === 'before' ? 0 : run.to;
    const insert = `${cr}\n${cr}\n`;
    context = 'text';
    activeGrid = null;
    view.focus();
    view.dispatch({ changes: { from: pos, insert }, selection: { anchor: where === 'before' ? 0 : pos + insert.length }, userEvent: 'input', scrollIntoView: true });
  }

  const formatField = StateField.define({
    create: (state) => ({ formatted, ...decorate(state, formatted, host) }),
    update(field, tr) {
      let next = field.formatted;
      for (const effect of tr.effects) if (effect.is(setFormatted)) next = effect.value;
      if (!tr.docChanged && !tr.selection && next === field.formatted) return field;
      return { formatted: next, ...decorate(tr.state, next, host) };
    },
    provide: (field) => [
      EditorView.decorations.from(field, (value) => value.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(field).atomic),
    ],
  });

  /**
   * Tab and Shift+Tab on a list line, Mod+] and Mod+[ anywhere (they replace CodeMirror's own indenting, which would
   * put 2 spaces before any line). On a list line Tab is always the editor's, also when the item cannot move; off a
   * list it leaves the field as before. Ctrl+M (CodeMirror's own switch, here also on a Mac) makes Tab leave it anyway.
   */
  const indentKey = (direction, always) => (target) => {
    const { from, to } = target.state.selection.main, text = target.state.doc.toString();
    const edit = indentEdit(text, from, to, direction);
    if (!edit) {
      if (always) return true;
      const levels = listLevels(text), first = target.state.doc.lineAt(from).number - 1, last = target.state.doc.lineAt(to).number - 1;
      return levels.slice(first, last + 1).some((level) => level >= 0) || !!indentEdit(text, from, to, direction === 'in' ? 'out' : 'in');
    }
    target.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: EditorSelection.single(edit.selFrom, edit.selTo), userEvent: 'input.indent', scrollIntoView: true });
    return true;
  };

  const keys = Prec.high(keymap.of([
    { key: 'Tab', run: indentKey('in', false), shift: indentKey('out', false) },
    { key: 'Ctrl-m', run: toggleTabFocusMode },
    { key: 'Mod-]', run: indentKey('in', true) },
    { key: 'Mod-[', run: indentKey('out', true) },
    {
      key: 'Enter',
      run: (target) => {
        const { from, to } = target.state.selection.main;
        const edit = listEnterEdit(target.state.doc.toString(), from, to);
        if (!edit) return false;
        target.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: { anchor: edit.selFrom }, userEvent: 'input', scrollIntoView: true });
        return true;
      },
    },
    // Backspace right behind hidden signs takes the last letter you see, not half a sign (shared with Android).
    {
      key: 'Backspace',
      run: (target) => {
        const { main } = target.state.selection, field = target.state.field(formatField);
        if (!main.empty || !field.formatted) return false;
        // At the start of the words of an item in a level, Backspace takes it one level back (its indent is hidden).
        const line = target.state.doc.lineAt(main.head), prefix = linePrefix(line.text);
        if (main.head <= line.from + prefix.markTo && ['bullet', 'ordered', 'task'].includes(prefix.kind)
          && listLevels(target.state.doc.toString())[line.number - 1] > 0) return indentKey('out', true)(target);
        const edit = backspaceEdit(target.state.doc.toString(), main.head, field.signs);
        if (!edit) return false;
        target.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: { anchor: edit.selFrom }, userEvent: 'delete.backward', scrollIntoView: true });
        return true;
      },
    },
    { key: 'Mod-b', run: () => apply('bold') },
    { key: 'Mod-i', run: () => apply('italic') },
  ]));

  let silent = false;
  const extensions = [
    // Only \n splits lines: a \r stays in the text, so a CRLF note comes back exactly as it went in.
    EditorState.lineSeparator.of('\n'),
    history(),
    keys,
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    placeholder(labels.placeholder),
    EditorView.contentAttributes.of({ spellcheck: 'true', autocapitalize: 'sentences', autocorrect: 'on', 'aria-label': labels.note, 'aria-description': labels.keys }),
    formatField,
    // An empty pair the caret leaves without typing in it (a button pressed, then the caret moved on) goes again, so
    // no `****` stays behind in the note.
    EditorState.transactionFilter.of((tr) => {
      if (!tr.selection && !tr.docChanged) return tr;
      const before = tr.startState.selection.main;
      const pair = emptyPair(tr.startState.doc.toString(), before.from, before.to);
      if (!pair) return tr;
      const from = tr.changes.mapPos(pair.from, 1), to = tr.changes.mapPos(pair.to, -1);
      const signs = tr.startState.doc.sliceString(pair.from, pair.to), after = tr.newSelection.main;
      if (to - from !== signs.length || tr.newDoc.sliceString(from, to) !== signs) return tr;
      if (after.empty && emptyPair(tr.newDoc.toString(), after.from)?.from === from) return tr;
      return [tr, { changes: { from, to }, sequential: true }];
    }),
    // Typing over a selection is CodeMirror's replacement, not the browser's: after deleting formatted text Chrome
    // tries to keep its look with a style attribute, which the page's CSP blocks (and reports). Backspace, Delete,
    // paste and cut already go through CodeMirror; a caret without a selection types as usual.
    EditorView.domEventHandlers({
      beforeinput(event, target) {
        if (event.inputType !== 'insertText' || event.isComposing || !event.cancelable || event.data == null) return false;
        if (target.state.selection.main.empty) return false;
        event.preventDefault();
        target.dispatch(target.state.replaceSelection(event.data), { userEvent: 'input.type', scrollIntoView: true });
        return true;
      },
      // An input method (IME) starting over a selection: Firefox does not replace a selection with hidden signs in
      // it, so the selection goes first and the composition starts at a plain caret.
      compositionstart(event, target) {
        const { main } = target.state.selection;
        if (main.empty) return false;
        target.dispatch({ changes: { from: main.from, to: main.to }, selection: { anchor: main.from }, userEvent: 'delete' });
        return false;
      },
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !silent) onChange?.(update.state.doc.toString());
      if (update.focusChanged && update.view.hasFocus) { context = 'text'; activeGrid = null; }
      if (update.docChanged || update.selectionSet || update.focusChanged) notify();
    }),
  ];
  const makeState = (text) => EditorState.create({ doc: text, extensions });
  view = new EditorView({ state: makeState(String(value)), parent: mount, root });

  function currentFormats() {
    if (context === 'table' && activeGrid) return [...new Set(['table', ...activeGrid.activeFormats()])].sort();
    const { from, to } = view.state.selection.main;
    return activeFormats(view.state.doc.toString(), from, to);
  }

  function flush() {
    for (const dom of grids) dom.jdGrid?.flush();
    // Saving or closing right after a button press: the empty pair is not kept.
    const { main } = view.state.selection, pair = emptyPair(view.state.doc.toString(), main.from, main.to);
    if (pair) view.dispatch({ changes: { from: pair.from, to: pair.to }, selection: { anchor: pair.from }, userEvent: 'delete' });
  }

  function replace(edit) {
    if (!edit) return false;
    view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: EditorSelection.single(edit.selFrom ?? edit.from + edit.insert.length, edit.selTo ?? edit.selFrom ?? edit.from + edit.insert.length), userEvent: 'input', scrollIntoView: true });
    view.focus();
    return true;
  }

  function tableCommand(command) {
    const grid = activeGrid;
    if (!grid) return false;
    const cell = grid.activeCell() || grid.lastCell() || { row: 0, column: 0 };
    grid.flush();
    const line = tableLine(grid.element), run = runAt(line);
    if (!run) return false;
    const current = parseTable(view.state.doc.sliceString(run.from, run.to).split('\n'));
    const align = { alignLeft: 'left', alignCenter: 'center', alignRight: 'right' }[command];
    const op = {
      addRow: { type: 'addRow', after: cell.row },
      addColumn: { type: 'addColumn', at: cell.column + 1 },
      deleteRow: { type: 'deleteRow', row: cell.row },
      deleteColumn: { type: 'deleteColumn', column: cell.column },
      deleteTable: { type: 'deleteTable' },
    }[command] || (align && { type: 'setAlign', column: cell.column, align: current.align[cell.column] === align ? '' : align });
    const edit = op && tableEdit(view.state.doc.toString(), line, op);
    if (!edit) { gridAtLine(line)?.focusCell(cell.row, cell.column); return false; }
    view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, userEvent: 'input.table' });
    if (command === 'deleteTable') {
      context = 'text';
      activeGrid = null;
      view.focus();
      view.dispatch({ selection: { anchor: Math.min(edit.selFrom, view.state.doc.length) }, scrollIntoView: true });
      return true;
    }
    const next = {
      addRow: [cell.row + 1, cell.column],
      addColumn: [cell.row, cell.column + 1],
      deleteRow: [Math.min(cell.row, current.rows.length - 1), cell.column],
      deleteColumn: [cell.row, Math.max(0, Math.min(cell.column, current.header.length - 2))],
    }[command] || [cell.row, cell.column];
    gridAtLine(line)?.focusCell(next[0], next[1]);
    return true;
  }

  /** A formatting button, a table button or a keyboard shortcut. */
  function apply(command) {
    if (TABLE_COMMANDS.has(command)) return tableCommand(command);
    if (context === 'table' && activeGrid && INLINE_COMMANDS.has(command)) {
      const done = activeGrid.applyToCell(command);
      notify();
      return done;
    }
    const { from, to } = view.state.selection.main, text = view.state.doc.toString();
    // Indent, outdent and the Checklist button go through the shared core too (design kaarten-en-lijsten, part 7).
    if (LIST_COMMANDS.has(command) && context === 'table') return false;
    const edit = command === 'indent' || command === 'outdent' ? indentEdit(text, from, to, command === 'indent' ? 'in' : 'out')
      : command === 'checklist' ? checklistEdit(text, from, to, moveChecked()) : applyFormat(text, from, to, command);
    if (!edit) { view.focus(); return false; }
    view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: EditorSelection.single(edit.selFrom, edit.selTo), userEvent: 'input.format', scrollIntoView: true });
    if (command === 'table') {
      // A new table opens with its first cell ready for typing.
      const grid = gridAtLine(view.state.doc.lineAt(edit.selFrom).number - 1);
      if (grid) { grid.focusCell(0, 0); return true; }
    }
    view.focus();
    return true;
  }

  function insertText(text) {
    if (context === 'table' && activeGrid?.activeCell()) {
      const area = activeGrid.element.querySelector('textarea');
      if (area) {
        const start = area.selectionStart, end = area.selectionEnd;
        area.setRangeText(text, start, end, 'end');
        area.dispatchEvent(new Event('input'));
        area.focus();
        return true;
      }
    }
    const { from, to } = view.state.selection.main;
    return replace({ from, to, insert: text, selFrom: from + text.length });
  }

  return {
    element,
    getValue: () => view.state.doc.toString(),
    setValue(text) {
      text = String(text ?? '');
      if (text === view.state.doc.toString()) return;
      // A different note starts with a fresh history.
      silent = true;
      try { view.setState(makeState(text)); } finally { silent = false; }
      context = 'text';
      activeGrid = null;
      notify();
    },
    focus: () => view.focus(),
    getSelection: () => ({ from: view.state.selection.main.from, to: view.state.selection.main.to }),
    setSelection: (from, to = from) => view.dispatch({ selection: EditorSelection.single(from, to), scrollIntoView: true }),
    replace,
    insertText,
    apply,
    activeFormats: currentFormats,
    context: () => context,
    setFormatted: (on) => view.dispatch({ effects: setFormatted.of(Boolean(on)) }),
    flush,
    destroy() { view.destroy(); element.remove(); },
  };
}

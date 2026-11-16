// The editable table grid (design opmaak-editor, part 5.4): a Markdown table drawn as a grid whose cells you can type
// in. It never writes the note itself: every change goes out as one tableEdit operation (format.mjs) through `onEdit`,
// and the host gives the grid the new table back with `update`. Used by the web editor (editor.mjs) and, later, by the
// Obsidian edit window. Built with createElement and textContent only; no inline style from markup, no innerHTML.
import { activeFormats, applyFormat, cellText, inlineSpans } from './format.mjs';

const CLASS = { bold: 'jd-bold', italic: 'jd-italic', strike: 'jd-strike', highlight: 'jd-mark', code: 'jd-code', link: 'jd-link', wikilink: 'jd-link', url: 'jd-link' };

/** A cell's text with its formatting shown and its signs left out, as the editor shows text outside the caret. */
export function appendInline(doc, parent, text) {
  String(text).split('\n').forEach((line, index) => {
    if (index) parent.append(doc.createElement('br'));
    const spans = inlineSpans(line);
    // Each character gets the classes of the spans whose content holds it; signs are not drawn.
    const hidden = new Array(line.length).fill(false), classes = Array.from({ length: line.length }, () => []);
    for (const span of spans) {
      for (let i = span.from; i < span.openTo; i++) hidden[i] = true;
      for (let i = span.closeFrom; i < span.to; i++) hidden[i] = true;
      const name = CLASS[span.kind];
      if (name) for (let i = span.openTo; i < span.closeFrom; i++) classes[i].push(name);
    }
    let i = 0;
    while (i < line.length) {
      if (hidden[i]) { i++; continue; }
      const key = classes[i].join(' ');
      let j = i + 1;
      while (j < line.length && !hidden[j] && classes[j].join(' ') === key) j++;
      const piece = line.slice(i, j);
      if (key) {
        const element = doc.createElement('span');
        element.className = key;
        element.textContent = piece;
        parent.append(element);
      } else parent.append(doc.createTextNode(piece));
      i = j;
    }
  });
}

const LABELS = { table: 'Table', cell: (row, column) => (row === 0 ? `Header, column ${column + 1}` : `Row ${row}, column ${column + 1}`), typeAbove: 'Type above the table', typeBelow: 'Type below the table' };

/**
 * createTableGrid(doc, { table, labels, onEdit(op), onFocusCell(cell), onBlurCell(), onLeave(where), onTypeOutside(where), edges })
 *   → { element, update(table, edges), flush(), focusCell(row, column), activeCell(), lastCell(), applyToCell(command), destroy() }
 * `table` is parseTable's { align, header, rows }. A cell opens for typing when it gets focus (a click, a tap, Tab) and
 * shows its source then, with Markdown signs; when it closes (another cell, Tab, Enter, a tap elsewhere) the new
 * text goes out as { type: 'setCell' }. Escape closes it without a change. `onLeave('before' | 'after')` asks the host
 * to put the caret in the text before or after the table. `edges.top`/`edges.bottom` add a strip to type above or
 * below a table at the very start or end of the text.
 */
export function createTableGrid(doc, options) {
  const labels = { ...LABELS, ...options.labels };
  let table = options.table, edges = options.edges || {};
  /** @type {{ row: number, column: number, area: HTMLTextAreaElement, original: string } | null} */
  let editing = null;
  let last = null;

  const element = doc.createElement('div');
  element.className = 'jd-grid-block';
  const top = doc.createElement('button'), bottom = doc.createElement('button');
  for (const [strip, where] of [[top, 'before'], [bottom, 'after']]) {
    strip.type = 'button';
    strip.className = `jd-grid-strip jd-grid-strip-${where}`;
    strip.textContent = where === 'before' ? labels.typeAbove : labels.typeBelow;
    strip.addEventListener('click', (event) => { event.preventDefault(); flush(); options.onTypeOutside?.(where); });
  }
  const frame = doc.createElement('div');
  frame.className = 'jd-table jd-grid';
  frame.setAttribute('role', 'region');
  frame.setAttribute('aria-label', labels.table);
  const grid = doc.createElement('table');
  frame.append(grid);
  element.append(top, frame, bottom);

  const rowCount = () => table.rows.length + 1;
  const columnCount = () => table.header.length;
  const sourceAt = (row, column) => (row === 0 ? table.header[column] : table.rows[row - 1]?.[column]) ?? '';
  const cellBox = (row, column) => grid.querySelector(`[data-row="${row}"][data-column="${column}"]`);

  function draw() {
    top.hidden = !edges.top;
    bottom.hidden = !edges.bottom;
    const head = doc.createElement('thead'), body = doc.createElement('tbody');
    for (let row = 0; row < rowCount(); row++) {
      const tr = doc.createElement('tr');
      for (let column = 0; column < columnCount(); column++) {
        const cell = doc.createElement(row === 0 ? 'th' : 'td');
        if (table.align[column]) cell.className = `jd-align-${table.align[column]}`;
        const box = doc.createElement('div');
        box.className = 'jd-cell';
        box.tabIndex = 0;
        box.dataset.row = String(row);
        box.dataset.column = String(column);
        box.setAttribute('role', 'textbox');
        box.setAttribute('aria-label', labels.cell(row, column));
        if (editing && editing.row === row && editing.column === column) {
          box.append(editing.area);
          box.classList.add('jd-editing');
        } else appendInline(doc, box, cellText(sourceAt(row, column)));
        box.addEventListener('focus', () => open(row, column));
        cell.append(box);
        tr.append(cell);
      }
      (row === 0 ? head : body).append(tr);
    }
    grid.replaceChildren(head, body);
  }

  function fit(area) {
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight}px`;
  }

  function open(row, column) {
    if (editing?.row === row && editing?.column === column) return;
    close(true);
    const box = cellBox(row, column);
    if (!box) return;
    const area = doc.createElement('textarea');
    area.className = 'jd-cell-input';
    area.rows = 1;
    area.spellcheck = true;
    area.setAttribute('aria-label', labels.cell(row, column));
    const original = cellText(sourceAt(row, column));
    area.value = original;
    editing = { row, column, area, original };
    last = { row, column };
    box.replaceChildren(area);
    box.classList.add('jd-editing');
    box.tabIndex = -1;
    area.addEventListener('keydown', (event) => keydown(event, row, column));
    area.addEventListener('input', () => fit(area));
    area.addEventListener('blur', () => { if (editing?.area === area) close(true); options.onBlurCell?.(); });
    area.focus();
    const end = area.value.length;
    area.setSelectionRange(end, end);
    fit(area);
    options.onFocusCell?.({ row, column });
  }

  /** Closes the open cell; `keep` sends its new text to the note. */
  function close(keep) {
    if (!editing) return;
    const { row, column, area, original } = editing;
    editing = null;
    const box = area.parentElement;
    if (box) {
      box.classList.remove('jd-editing');
      box.tabIndex = 0;
      box.replaceChildren();
      appendInline(doc, box, keep ? area.value : original);
    }
    if (keep && area.value !== original) options.onEdit({ type: 'setCell', row, column, text: area.value });
  }

  function flush() { close(true); }

  function focusCell(row, column) {
    const box = cellBox(Math.max(0, Math.min(rowCount() - 1, row)), Math.max(0, Math.min(columnCount() - 1, column)));
    box?.focus();
  }

  /** Out of the table into the text; at the very start or end of the note that is the strip, so nothing is written yet. */
  function leave(where) {
    const strip = where === 'before' ? top : bottom;
    if (!strip.hidden) strip.focus();
    else options.onLeave?.(where);
  }

  function keydown(event, row, column) {
    if (event.isComposing || event.keyCode === 229) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.altKey && ['b', 'i'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      applyToCell(event.key.toLowerCase() === 'b' ? 'bold' : 'italic');
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(false);
      leave('after');
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const columns = columnCount();
      const index = row * columns + column + (event.shiftKey ? -1 : 1);
      close(true);
      if (index < 0) { leave('before'); return; }
      if (index >= rowCount() * columns) {
        // Tab in the last cell makes a new row.
        options.onEdit({ type: 'addRow', after: rowCount() - 1 });
        focusCell(rowCount() - 1, 0);
        return;
      }
      focusCell(Math.floor(index / columns), index % columns);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !mod && !event.altKey) {
      // Enter closes the cell and goes down; Shift+Enter is a line break inside the cell.
      event.preventDefault();
      close(true);
      if (row + 1 < rowCount()) focusCell(row + 1, column);
      else leave('after');
    }
  }

  /** Bold, italic, highlight and the other inline buttons on the text of the open cell. */
  function applyToCell(command) {
    if (!editing) return false;
    const { area } = editing;
    const edit = applyFormat(area.value, area.selectionStart, area.selectionEnd, command);
    if (!edit) return true;
    area.value = area.value.slice(0, edit.from) + edit.insert + area.value.slice(edit.to);
    area.setSelectionRange(edit.selFrom, edit.selTo);
    area.focus();
    fit(area);
    return true;
  }

  function update(next, nextEdges = edges) {
    const previous = table;
    table = next;
    edges = nextEdges;
    const sameShape = previous.header.length === next.header.length && previous.rows.length === next.rows.length && previous.align.join() === next.align.join();
    if (sameShape) {
      // Only the cells whose text changed are drawn again, so the cell that is getting focus right now keeps it.
      top.hidden = !edges.top;
      bottom.hidden = !edges.bottom;
      for (let row = 0; row < rowCount(); row++) {
        for (let column = 0; column < columnCount(); column++) {
          const before = (row === 0 ? previous.header[column] : previous.rows[row - 1]?.[column]) ?? '';
          if (before === sourceAt(row, column) || (editing?.row === row && editing?.column === column)) continue;
          const box = cellBox(row, column);
          if (box) { box.replaceChildren(); appendInline(doc, box, cellText(sourceAt(row, column))); }
        }
      }
      return;
    }
    if (editing && (editing.row >= rowCount() || editing.column >= columnCount())) { editing.area.remove(); editing = null; }
    // In a shadow tree the document only knows the host, so the cell's own root says what has focus.
    const focused = editing && editing.area.getRootNode().activeElement === editing.area;
    const selection = focused ? [editing.area.selectionStart, editing.area.selectionEnd] : null;
    draw();
    if (focused && editing) { editing.area.focus(); editing.area.setSelectionRange(selection[0], selection[1]); }
  }

  draw();
  return {
    element,
    update,
    flush,
    focusCell,
    applyToCell,
    activeCell: () => (editing ? { row: editing.row, column: editing.column } : null),
    lastCell: () => last,
    /** Which inline buttons are on for the selection in the open cell. */
    activeFormats: () => (editing ? activeFormats(editing.area.value, editing.area.selectionStart, editing.area.selectionEnd) : []),
    destroy() { editing = null; element.remove(); },
  };
}

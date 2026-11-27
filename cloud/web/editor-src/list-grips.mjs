// The grips of a checklist in an open note (design checklists-77-v2, part 24): on every task line a handle to drag the
// item with, a cross on the task that has the caret, Alt+arrows to move an item, and pasting several lines as items.
// One CodeMirror 6 extension that knows nothing of the app around it: it uses the base of CodeMirror and the shared
// core (format.mjs), so the web app, Obsidian and Joplin can load the same one. The grips only draw and take the
// pointer; every action is one replacement from the core, the one Android makes too.
//
// The text does not change while an item is dragged. The lines it passes get a class that draws them one block further
// (the height of that block is one custom property on the scroller), and the item itself is a copy that follows the
// pointer, outside the editor's own content: it stays in view when its own line scrolls out of the part CodeMirror
// draws. Nothing here writes a style attribute in markup: what moves is a custom property, set through the CSSOM.
import { EditorSelection, Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { deleteItemEdit, dropItemEdit, dropSlots, itemSpan, linePrefix, listItems, listLevels, moveItemEdit, pasteLinesEdit } from '/shared/format.mjs';

/** Above this many characters a note gets no grips, as it gets no formatting (md-editor.mjs, RAW_ABOVE). */
const GRIPS_UNTIL = 50000;
/** A line an item is dragged past takes this long to make room, and an item that is let go this long to reach its place. */
const SLIDE_MS = 120;
/** How long the frame around an item that landed takes to fade. */
const GLOW_MS = 600;
/** While an item is dragged, the pointer going this far sideways, in px, is one level in or out. */
const LEVEL_STEP = 28;
/** This near the top or bottom of the scroller, in px, the note scrolls along with a drag. */
const SCROLL_EDGE = 40;
/** How far a pointer on a handle moves, in px, before the item comes along: a click on a handle does nothing. */
const SLOP = { mouse: 4 };
const SLOP_TOUCH = 8;
/** What the copy of a dragged item takes over from the editor's content, so its words look the same. */
const LOOK = ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'color', 'tab-size', 'direction'];

const DEFAULT_LABELS = { drag: 'Drag to move', deleteItem: 'Delete item' };

const rowsOf = new WeakMap();

/**
 * Per line of the text, from 0: 'task' for a task in a list, 'list' for every other line of a list with a task in it
 * (a bullet, a number, more text under an item), nothing for any other line. A list with a task stands a little to
 * the right as a whole and leaves the margin to the handles, as on Android (ListLayout.kt, `shifted`).
 */
function rows(state) {
  let found = rowsOf.get(state.doc);
  if (found) return found;
  found = [];
  const text = state.doc.length <= GRIPS_UNTIL ? state.doc.toString() : '';
  if (text.includes('[')) {
    const lines = text.split('\n'), levels = listLevels(text), items = listItems(text);
    for (let from = 0; from < lines.length; from++) {
      if (items[from] < 0) continue;
      // A run of list lines without a line between them is one list.
      let to = from, task = false;
      while (to + 1 < lines.length && items[to + 1] >= 0) to++;
      const kinds = [];
      for (let index = from; index <= to; index++) {
        kinds.push(levels[index] >= 0 && linePrefix(lines[index]).kind === 'task' ? 'task' : 'list');
        if (kinds[index - from] === 'task') task = true;
      }
      if (task) kinds.forEach((kind, index) => { found[from + index] = kind; });
      from = to;
    }
  }
  rowsOf.set(state.doc, found);
  return found;
}

/**
 * Where an item that is dragged lands (ListLayout.kt, `dropTarget`). `slots` are its places (dropSlots), `line` to
 * `end` its own lines, `level` its own level and `lines` the number of lines of the text. `y` is the height of the
 * pointer; `top` and `bottom` give those of a line. The place nearest to the pointer wins. A place is the gap in front
 * of its line (under the last line for the place after the text); the item's own place is all of its own lines, so a
 * pointer that stays on the item moves nothing. The item keeps its own level where the place takes it, else the nearest
 * level the place takes; `steps` is how many levels the pointer went sideways since the drag began. Null without a place.
 */
export function dropTarget(slots, line, end, level, lines, y, steps, top, bottom) {
  let best = null, nearest = Infinity;
  for (const slot of slots) {
    const distance = slot.before === line ? Math.max(top(line) - y, y - bottom(end), 0)
      : Math.abs(y - (slot.before < lines ? top(slot.before) : bottom(lines - 1)));
    if (distance < nearest) { nearest = distance; best = slot; }
  }
  if (!best) return null;
  const within = (value) => Math.max(best.minLevel, Math.min(best.maxLevel, value));
  return { before: best.before, level: within(within(level) + steps) };
}

// An item on its way: { line, end, before, slide }. `line` to `end` are its own lines, which are not drawn (the copy
// is); the lines between them and `before`, the line it would land in front of, stand a block further. With `slide`
// the lines take SLIDE_MS to get there. Null when nothing is dragged. Any other change to the text ends it.
const setDrag = StateEffect.define();
const dragField = StateField.define({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setDrag)) return effect.value;
    return tr.docChanged ? null : value;
  },
});

/** The class of line `index` while an item is dragged, with a space in front; empty for a line that stays. */
function dragClass(drag, index) {
  if (index >= drag.line && index <= drag.end) return ' cm-jd-away';
  if (drag.before === null) return '';
  if (drag.before < drag.line && index >= drag.before && index < drag.line) return ' cm-jd-down';
  if (drag.before > drag.end + 1 && index > drag.end && index < drag.before) return ' cm-jd-up';
  return '';
}

/** The element of a line that is drawn now, or null. */
function lineElement(view, index) {
  if (index < 0 || index >= view.state.doc.lines) return null;
  const line = view.state.doc.line(index + 1);
  if (line.from > view.viewport.to || line.to < view.viewport.from) return null;
  const { node } = view.domAtPos(line.from);
  const found = (node.nodeType === 1 ? node : node.parentElement)?.closest('.cm-line');
  return found && view.contentDOM.contains(found) ? found : null;
}

/** One list action: its own step for Undo, apart from the typing before and after it. */
function act(view, edit, userEvent, more = {}) {
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: EditorSelection.single(edit.selFrom, edit.selTo),
    annotations: isolateHistory.of('full'),
    userEvent,
    ...more,
  });
}

/**
 * Moves the list item the caret is in one place 'up' or 'down' among its siblings, with the lines under it
 * (moveItemEdit): a task, a bullet or a numbered line. True when the caret is in a list, also when the item is the
 * first or last and stays; false outside a list, so a key can do there what it did.
 */
export function moveListItem(view, direction) {
  const { state } = view, { main } = state.selection, text = state.doc.toString();
  const line = state.doc.lineAt(main.head).number - 1;
  if (state.readOnly || !itemSpan(text, line)) return false;
  const edit = moveItemEdit(text, line, direction, main.from, main.to);
  if (edit) act(view, edit, 'move.item', { scrollIntoView: true });
  return true;
}

const theme = EditorView.baseTheme({
  // The room of the handle and of the cross: wider for a finger than for a mouse.
  '.cm-scroller': { '--jd-grip-room': '20px', '--jd-cross-room': '24px' },
  '@media (pointer: coarse)': { '.cm-scroller': { '--jd-grip-room': '29px', '--jd-cross-room': '28px' } },
  '.cm-line.cm-jd-shift': { paddingInlineStart: 'var(--jd-grip-room)' },
  '.cm-line.cm-jd-task': { position: 'relative', paddingInlineEnd: 'var(--jd-cross-room)' },
  // The handle: the whole height of the line, from the edge of the editor (`--jd-edge`: how far the host's own margin
  // lets it reach out) to where the line starts. Six dots, two by three, at the height of the first row of words.
  '.cm-jd-grip': {
    position: 'absolute', insetInlineStart: 'calc(-1 * var(--jd-edge, 0px))', top: '0', bottom: '0',
    width: 'calc(var(--jd-grip-room) + var(--jd-edge, 0px))', cursor: 'grab', touchAction: 'none', userSelect: 'none',
    WebkitUserSelect: 'none', WebkitTouchCallout: 'none', opacity: '.45', textIndent: '0',
  },
  // Fuller under a mouse; a finger leaves no hover behind.
  '@media (hover: hover)': { '.cm-jd-grip:hover': { opacity: '.9' } },
  '.cm-jd-grip::before': {
    content: '""', position: 'absolute', left: 'calc(50% - 5px)', top_: 'calc(.775em - 7px)', top: 'calc((1lh - 15px) / 2)',
    width: '10px', height: '15px',
    backgroundImage: 'radial-gradient(circle, currentColor 1.3px, transparent 1.8px)', backgroundSize: '5px 5px',
  },
  // The cross: only on the task with the caret, in the room on the other side.
  '.cm-jd-cross': {
    position: 'absolute', insetInlineEnd: 'calc(-1 * var(--jd-edge, 0px))', top: '0', bottom: '0',
    width: 'calc(var(--jd-cross-room) + var(--jd-edge, 0px))', margin: '0', padding: '0', border: '0', borderRadius: '6px',
    background: 'none', color: 'inherit', font: 'inherit', cursor: 'pointer', opacity: '.6', textIndent: '0',
    appearance: 'none', WebkitAppearance: 'none', minWidth: '0', boxShadow: 'none',
  },
  '.cm-jd-cross:hover, .cm-jd-cross:focus-visible': { opacity: '1' },
  '.cm-jd-cross::before, .cm-jd-cross::after': {
    content: '""', position: 'absolute', left: 'calc(50% - 6px)', top_: 'calc(.775em - 1px)', top: 'calc(.5lh - 1px)',
    width: '12px', height: '1.6px', background: 'currentColor', transform: 'rotate(45deg)',
  },
  '.cm-jd-cross::after': { transform: 'rotate(-45deg)' },
  // While an item is dragged: its own lines are not drawn, the lines it passes stand a block further.
  '&.cm-jd-moving .cm-line': { transition: `transform ${SLIDE_MS}ms ease-out` },
  '.cm-line.cm-jd-down': { transform: 'translateY(var(--jd-room, 0px))' },
  '.cm-line.cm-jd-up': { transform: 'translateY(calc(-1 * var(--jd-room, 0px)))' },
  '.cm-line.cm-jd-away': { visibility: 'hidden' },
  // The item on its way: a copy of its lines over the text, with a frame, a light shadow and the editor's own ground.
  // `--jd-x`, `--jd-y` and `--jd-w` are where the item's lines stand and how wide they are; the block reaches as far
  // out on both sides as the handle does, and its frame is drawn inside it, so the scroller never cuts it off.
  '.cm-jd-carry, .cm-jd-frame': {
    position: 'absolute', left: 'calc(-1 * var(--jd-edge, 0px))', top: '0', width: 'calc(var(--jd-w, 0px) + 2 * var(--jd-edge, 0px))',
    padding: '0 var(--jd-edge, 0px)', boxSizing: 'border-box', pointerEvents: 'none',
    transform: 'translate(var(--jd-x, 0px), var(--jd-y, 0px))', outline: '1.5px solid var(--jd-lift-line, currentColor)',
    outlineOffset: '-2px', borderRadius: '6px',
  },
  '.cm-jd-carry': {
    zIndex: '5', whiteSpace: 'break-spaces', wordBreak: 'break-word', overflowWrap: 'anywhere', cursor: 'grabbing',
    background: 'var(--jd-lift-ground, Canvas)', boxShadow: '0 3px 10px rgba(0, 0, 0, .25)',
  },
  '.cm-jd-carry.cm-jd-settle': { transition: `transform ${SLIDE_MS}ms ease-out` },
  '.cm-jd-carry .cm-jd-cross': { display: 'none' },
  // Where it landed: the frame stays a moment and fades.
  '.cm-jd-frame': { zIndex: '4', height: 'var(--jd-h, 0px)', transition: `opacity ${GLOW_MS}ms ease-out` },
  '.cm-jd-frame.cm-jd-fade': { opacity: '0' },
});

/**
 * listGrips({ labels, onDeleted, levelWidth }) → a CodeMirror extension.
 * `labels`: { drag, deleteItem }, what the handle and the cross are called. `onDeleted(count)` runs after the cross
 * deleted an item, with the number of sub-items that went along. `levelWidth(view)`: how many px one level of a list
 * stands further in this editor (default 1.5 em of its text), for the copy of an item that is dragged in or out.
 */
export function listGrips({ labels: given = {}, onDeleted, levelWidth } = {}) {
  const labels = { ...DEFAULT_LABELS, ...given };
  let plugin;

  class Grip extends WidgetType {
    eq() { return true; }
    toDOM(view) {
      const grip = view.dom.ownerDocument.createElement('span');
      grip.className = 'cm-jd-grip';
      // A screen reader cannot drag: it gets Alt+arrows and the host's own buttons.
      grip.setAttribute('aria-hidden', 'true');
      grip.title = labels.drag;
      grip.addEventListener('pointerdown', (event) => view.plugin(plugin)?.press(grip, event));
      grip.addEventListener('mousedown', (event) => event.preventDefault());
      grip.addEventListener('contextmenu', (event) => event.preventDefault());
      return grip;
    }
    ignoreEvent() { return true; }
  }

  class Cross extends WidgetType {
    eq() { return true; }
    toDOM(view) {
      const cross = view.dom.ownerDocument.createElement('button');
      cross.type = 'button';
      cross.className = 'cm-jd-cross';
      cross.tabIndex = -1;
      cross.title = labels.deleteItem;
      cross.setAttribute('aria-label', labels.deleteItem);
      // The caret and the keyboard stay where they are.
      cross.addEventListener('mousedown', (event) => event.preventDefault());
      cross.addEventListener('click', (event) => {
        event.preventDefault();
        view.plugin(plugin)?.remove(view.state.doc.lineAt(view.posAtDOM(cross)).number - 1);
      });
      return cross;
    }
    ignoreEvent() { return true; }
  }

  const gripMark = Decoration.widget({ widget: new Grip(), side: -1 }), crossMark = Decoration.widget({ widget: new Cross(), side: 1 });

  function build(view) {
    const { state } = view, found = rows(state), drag = state.field(dragField), out = [];
    const caret = view.hasFocus && !drag && !state.readOnly ? state.doc.lineAt(state.selection.main.head).number - 1 : -1;
    for (let pos = view.viewport.from; pos <= view.viewport.to;) {
      const line = state.doc.lineAt(pos), index = line.number - 1, kind = found[index];
      const name = (kind === 'task' ? 'cm-jd-shift cm-jd-task' : kind ? 'cm-jd-shift' : '') + (drag ? dragClass(drag, index) : '');
      if (name) out.push(Decoration.line({ class: name.trim() }).range(line.from));
      if (kind === 'task' && !state.readOnly) {
        out.push(gripMark.range(line.from));
        if (index === caret) out.push(crossMark.range(line.to));
      }
      pos = line.to + 1;
    }
    return Decoration.set(out, true);
  }

  plugin = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.decorations = build(view);
      // A pointer on a handle; once it moved far enough it holds the item it carries too.
      this.held = null;
      this.own = false;
      this.wait = 0;
      this.timers = new Set();
      this.glowing = null;
      this.onMove = (event) => this.move(event);
      this.onUp = (event) => this.up(event);
      this.onKey = (event) => this.key(event);
      this.onScroll = () => this.ask();
    }

    update(update) {
      const drag = update.state.field(dragField);
      if (update.docChanged && !this.own) {
        // The text changed under a pointer on a handle (someone typed): the item goes back, and nothing is taken from
        // or dropped on another text than the one the pointer came down on.
        if (this.held) this.stop();
        this.glowing?.remove();
      }
      if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged || update.startState.field(dragField) !== drag) this.decorations = build(update.view);
    }

    destroy() {
      this.stop();
      for (const timer of this.timers) clearTimeout(timer);
      this.glowing?.remove();
    }

    /** The place on the screen of the scroller's own top left corner, scrolled along: what its children are placed from. */
    base() {
      const scroller = this.view.scrollDOM, box = scroller.getBoundingClientRect();
      return { left: box.left + scroller.clientLeft - scroller.scrollLeft, top: box.top + scroller.clientTop - scroller.scrollTop };
    }

    later(run, ms) {
      const timer = setTimeout(() => { this.timers.delete(timer); run(); }, ms);
      this.timers.add(timer);
    }

    /** Sets the drag in the editor's state: which lines make room. Not a change to the text. */
    show(drag) {
      this.own = true;
      try { this.view.dispatch({ effects: setDrag.of(drag) }); } finally { this.own = false; }
    }

    press(grip, event) {
      const { view } = this;
      if (this.held || view.state.readOnly || (event.pointerType === 'mouse' && event.button !== 0)) return;
      // No focus, no selection and no scrolling page from a pointer on a handle.
      event.preventDefault();
      event.stopPropagation();
      this.held = { id: event.pointerId, type: event.pointerType, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, line: view.state.doc.lineAt(view.posAtDOM(grip)).number - 1 };
      try { grip.setPointerCapture(event.pointerId); } catch { /* The listeners on the document get the pointer anyway. */ }
      // On the document, not on the handle: CodeMirror may draw the handle's line anew while the item is on its way.
      const page = view.dom.ownerDocument;
      page.addEventListener('pointermove', this.onMove, true);
      page.addEventListener('pointerup', this.onUp, true);
      page.addEventListener('pointercancel', this.onUp, true);
      page.addEventListener('keydown', this.onKey, true);
    }

    move(event) {
      const held = this.held;
      if (!held || event.pointerId !== held.id) return;
      // A mouse button that was let go outside the window: its release never came here.
      if (held.type === 'mouse' && event.buttons === 0) { this.release(false); return; }
      held.x = event.clientX;
      held.y = event.clientY;
      if (!held.carry) {
        if (Math.hypot(held.x - held.startX, held.y - held.startY) < (SLOP[held.type] ?? SLOP_TOUCH)) return;
        if (!this.lift()) { this.release(false); return; }
      }
      event.preventDefault();
      this.ask();
    }

    up(event) {
      const held = this.held;
      if (!held || event.pointerId !== held.id) return;
      const drop = event.type === 'pointerup';
      if (drop) { held.x = event.clientX; held.y = event.clientY; }
      this.release(drop);
    }

    key(event) {
      if (event.key !== 'Escape' || !this.held?.carry) return;
      // Escape puts the item back; it does not close what the editor stands in.
      event.preventDefault();
      event.stopImmediatePropagation();
      this.release(false);
    }

    /** The pointer moved far enough: the item comes along as a copy of its lines. False when there is nothing to take. */
    lift() {
      const { view, held } = this, { state } = view, text = state.doc.toString();
      const span = itemSpan(text, held.line), first = lineElement(view, held.line), slots = dropSlots(text, held.line);
      if (!span || span.line !== held.line || !first || !slots.length) return false;
      const page = view.dom.ownerDocument, scroller = view.scrollDOM;
      const carry = page.createElement('div');
      carry.className = 'cm-jd-carry';
      carry.setAttribute('aria-hidden', 'true');
      for (let index = span.line; index <= span.end; index++) {
        const element = lineElement(view, index);
        if (element) carry.append(element.cloneNode(true));
      }
      const look = page.defaultView.getComputedStyle(view.contentDOM);
      for (const name of LOOK) carry.style.setProperty(name, look.getPropertyValue(name));
      const box = first.getBoundingClientRect(), base = this.base();
      const top = view.lineBlockAt(state.doc.line(span.line + 1).from).top, bottom = view.lineBlockAt(state.doc.line(span.end + 1).from).bottom;
      carry.style.setProperty('--jd-w', `${box.width}px`);
      scroller.style.setProperty('--jd-room', `${bottom - top}px`);
      scroller.append(carry);
      Object.assign(held, {
        carry, span, slots, text, target: null, lines: state.doc.lines, level: listLevels(text)[span.line],
        // Where the pointer has the block, and where the block's lines start from the side.
        grabY: held.startY - box.top, left: box.left - base.left, height: carry.offsetHeight,
        step: (levelWidth?.(view) ?? parseFloat(look.fontSize) * 1.5) * (look.direction === 'rtl' ? -1 : 1),
        towards: look.direction === 'rtl' ? -1 : 1,
        motion: !page.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches,
      });
      scroller.addEventListener('scroll', this.onScroll);
      return true;
    }

    ask() {
      if (!this.wait) this.wait = requestAnimationFrame(() => { this.wait = 0; this.frame(); });
    }

    /** Where the item would land with the pointer where it is now. */
    aim() {
      const { view, held } = this, { doc } = view.state;
      const block = (index) => view.lineBlockAt(doc.line(index + 1).from);
      const steps = Math.round((held.x - held.startX) / LEVEL_STEP) * held.towards;
      held.target = dropTarget(held.slots, held.span.line, held.span.end, held.level, held.lines, held.y - view.documentTop, steps, (index) => block(index).top, (index) => block(index).bottom);
      return held.target;
    }

    /** One frame of a drag: scroll along at the edge, choose the place, let the lines make room, put the copy at the pointer. */
    frame() {
      const { view, held } = this;
      if (!held?.carry) return;
      const scroller = view.scrollDOM, box = scroller.getBoundingClientRect();
      const past = held.y < box.top + SCROLL_EDGE ? held.y - box.top - SCROLL_EDGE : held.y > box.bottom - SCROLL_EDGE ? held.y - box.bottom + SCROLL_EDGE : 0;
      if (past) {
        const was = scroller.scrollTop;
        scroller.scrollTop += Math.sign(past) * Math.min(16, 1 + Math.ceil(Math.abs(past) / 4));
        if (scroller.scrollTop !== was) this.ask();
      }
      const target = this.aim(), before = target ? target.before : null, drag = view.state.field(dragField);
      if (!drag || drag.before !== before) this.show({ line: held.span.line, end: held.span.end, before, slide: held.motion });
      this.place(target ? target.level - held.level : 0);
    }

    /** The copy at the pointer, `levels` further in or out; it stays inside the editor's content. */
    place(levels) {
      const { view, held } = this, base = this.base(), content = view.contentDOM.getBoundingClientRect();
      const y = Math.max(content.top - base.top, Math.min(content.bottom - base.top - held.height, held.y - base.top - held.grabY));
      held.carry.style.setProperty('--jd-x', `${held.left + levels * held.step}px`);
      held.carry.style.setProperty('--jd-y', `${y}px`);
    }

    /** Takes the listeners and the pointer away; what was carried is returned. */
    letGo() {
      const { view, held } = this;
      this.held = null;
      if (this.wait) cancelAnimationFrame(this.wait);
      this.wait = 0;
      const page = view.dom.ownerDocument;
      page.removeEventListener('pointermove', this.onMove, true);
      page.removeEventListener('pointerup', this.onUp, true);
      page.removeEventListener('pointercancel', this.onUp, true);
      page.removeEventListener('keydown', this.onKey, true);
      view.scrollDOM.removeEventListener('scroll', this.onScroll);
      return held;
    }

    /** The drag ends without a word to the editor's state: the text changed under it, or the editor goes away. */
    stop() {
      this.letGo()?.carry?.remove();
    }

    /**
     * The pointer let go (`drop`), or the drag was broken off. A drop is one replacement, at once: a note that is
     * saved or closed in the next moment has it. The copy then slides to where the item stands in the new text; the
     * item's own lines stay undrawn until it is there.
     */
    release(drop) {
      const { view } = this;
      const target = drop && this.held?.carry ? this.aim() : null;
      const held = this.letGo();
      if (!held?.carry) return;
      const { main } = view.state.selection;
      const edit = target && dropItemEdit(held.text, held.span.line, target.before, target.level, main.from, main.to);
      const size = held.span.end - held.span.line;
      const rest = edit ? { line: edit.line, end: edit.line + size, before: null, slide: false } : { line: held.span.line, end: held.span.end, before: null, slide: held.motion };
      if (edit) {
        this.own = true;
        try { act(view, edit, 'move.item', { effects: setDrag.of(rest) }); } finally { this.own = false; }
      } else this.show(rest);
      const first = lineElement(view, rest.line), base = this.base();
      const done = () => {
        held.carry.remove();
        if (view.state.field(dragField) === rest) this.show(null);
        if (edit) this.glow(rest);
      };
      if (!first || !held.motion) { done(); return; }
      const box = first.getBoundingClientRect();
      held.carry.classList.add('cm-jd-settle');
      held.carry.style.setProperty('--jd-x', `${box.left - base.left + (edit ? (target.level - held.level) * held.step : 0)}px`);
      held.carry.style.setProperty('--jd-y', `${box.top - base.top}px`);
      this.later(done, SLIDE_MS + 20);
    }

    /** A frame around the item that landed, which fades: where it went shows, also between lines that look alike. */
    glow(rest) {
      const { view } = this, first = lineElement(view, rest.line);
      if (!first) return;
      let last = first;
      for (let index = rest.line + 1; index <= rest.end; index++) last = lineElement(view, index) ?? last;
      const base = this.base(), box = first.getBoundingClientRect();
      const frame = view.dom.ownerDocument.createElement('div');
      frame.className = 'cm-jd-frame';
      frame.setAttribute('aria-hidden', 'true');
      frame.style.setProperty('--jd-x', `${box.left - base.left}px`);
      frame.style.setProperty('--jd-y', `${box.top - base.top}px`);
      frame.style.setProperty('--jd-w', `${box.width}px`);
      frame.style.setProperty('--jd-h', `${last.getBoundingClientRect().bottom - box.top}px`);
      this.glowing?.remove();
      this.glowing = frame;
      view.scrollDOM.append(frame);
      // Drawn once as it is, so the fade has something to start from.
      frame.getBoundingClientRect();
      frame.classList.add('cm-jd-fade');
      this.later(() => { frame.remove(); if (this.glowing === frame) this.glowing = null; }, GLOW_MS + 50);
    }

    /** The cross: the item goes with everything under it (deleteItemEdit). */
    remove(line) {
      const { view } = this, { main } = view.state.selection;
      if (view.state.readOnly) return;
      const edit = deleteItemEdit(view.state.doc.toString(), line, main.from, main.to);
      if (!edit) return;
      act(view, edit, 'delete.item', { scrollIntoView: true });
      onDeleted?.(edit.count);
    }
  }, { decorations: (value) => value.decorations });

  return [
    dragField,
    plugin,
    EditorView.editorAttributes.from(dragField, (drag) => (drag?.slide ? { class: 'cm-jd-moving' } : null)),
    Prec.high(keymap.of([
      { key: 'Alt-ArrowUp', run: (view) => moveListItem(view, 'up') },
      { key: 'Alt-ArrowDown', run: (view) => moveListItem(view, 'down') },
    ])),
    // Several lines pasted in a list item: every line an item of its own (pasteLinesEdit). Any other paste is the editor's.
    EditorView.domEventHandlers({
      paste(event, view) {
        const pasted = event.clipboardData?.getData('text/plain');
        if (!pasted || view.state.readOnly) return false;
        const { main } = view.state.selection;
        const edit = pasteLinesEdit(view.state.doc.toString(), main.from, main.to, pasted);
        if (!edit) return false;
        event.preventDefault();
        view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: { anchor: edit.selFrom }, userEvent: 'input.paste', scrollIntoView: true });
        return true;
      },
    }),
    theme,
  ];
}

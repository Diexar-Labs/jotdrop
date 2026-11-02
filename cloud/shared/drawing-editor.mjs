// The drawing screen the web app, the Obsidian plugin and the Joplin plugin share: plain DOM, pointer events
// (mouse, pen and touch), and the same behaviour as Android's DrawingActivity. Six named pens with a check mark on
// the chosen one, three widths, an eraser that takes whole lines, undo, redo and clear; saving gives a PNG with the
// lines inside (see drawing.mjs). The host puts `element` in its own dialog or modal and styles the jd-draw-* classes.
import { HEIGHT, PENS, SIZES, paint, paintStroke, touches, withDrawing, WIDTH } from './drawing.mjs';

export const LABELS = {
  title: 'Drawing', save: 'Save', cancel: 'Cancel', canvas: 'Drawing area', colors: 'Color', widths: 'Width',
  black: 'Black', blue: 'Blue', red: 'Red', green: 'Green', orange: 'Orange', purple: 'Purple',
  thin: 'Thin', medium: 'Medium', thick: 'Thick', eraser: 'Eraser', undo: 'Undo', redo: 'Redo', clear: 'Clear',
  clearAsk: 'Clear the whole drawing?', discardAsk: 'Discard this drawing?', saving: 'Saving...',
};

/**
 * @param options.initial   An existing drawing { width, height, strokes } to draw on, or nothing for white paper.
 * @param options.labels    Texts, see LABELS; a host with translations passes its own.
 * @param options.confirm   async (text) => boolean, asked before clearing or discarding work.
 * @param options.onSave    async ({ png: Uint8Array, drawing }) => void; a thrown error shows under the tools.
 * @param options.onCancel  () => void, after the person chose to leave (and confirmed when there was work).
 */
export function createDrawingEditor({ initial, labels = LABELS, confirm = async (text) => globalThis.confirm(text), onSave, onCancel }) {
  const text = (key) => labels[key] ?? LABELS[key];
  const width = initial?.width || WIDTH, height = initial?.height || HEIGHT;
  let strokes = initial ? initial.strokes.map((stroke) => ({ ...stroke, points: stroke.points.slice() })) : [];
  const undo = [], redo = [];
  let color = PENS[0].color, size = SIZES[1].size, erasing = false, saving = false;
  // The line being drawn, and the pointer drawing it (a second finger is ignored while one draws).
  let current = null, pointer = null, erasedThisGesture = false;

  const el = (tag, attributes = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) if (value !== undefined) node.setAttribute(key, value);
    node.append(...children);
    return node;
  };
  const check = () => el('span', { class: 'jd-draw-check', 'aria-hidden': 'true' }, '✓');

  const canvas = el('canvas', { width, height, role: 'img', 'aria-label': text('canvas'), tabindex: '0' });
  canvas.style.touchAction = 'none';
  const context = canvas.getContext('2d');
  const saveButton = el('button', { type: 'button', class: 'jd-draw-save mod-cta primary' }, text('save'));
  const cancelButton = el('button', { type: 'button', class: 'jd-draw-cancel' }, text('cancel'));
  const undoButton = el('button', { type: 'button', class: 'jd-draw-undo' }, text('undo'));
  const redoButton = el('button', { type: 'button', class: 'jd-draw-redo' }, text('redo'));
  const clearButton = el('button', { type: 'button', class: 'jd-draw-clear' }, text('clear'));
  const eraserButton = el('button', { type: 'button', class: 'jd-draw-eraser', 'aria-pressed': 'false' }, check(), text('eraser'));
  const message = el('p', { class: 'jd-draw-message', role: 'status', 'aria-live': 'polite' });
  const penButtons = PENS.map((pen) => {
    const dot = el('span', { class: 'jd-draw-dot', 'aria-hidden': 'true' }, check());
    dot.style.setProperty('--pen', pen.color);
    const button = el('button', { type: 'button', role: 'radio', class: 'jd-draw-pen', 'data-color': pen.color }, dot, text(pen.id));
    button.addEventListener('click', () => { color = pen.color; erasing = false; refresh(); });
    return button;
  });
  const sizeButtons = SIZES.map((item) => {
    const button = el('button', { type: 'button', role: 'radio', class: 'jd-draw-size', 'data-size': item.size }, check(), text(item.id));
    button.addEventListener('click', () => { size = item.size; erasing = false; refresh(); });
    return button;
  });
  eraserButton.addEventListener('click', () => { erasing = !erasing; refresh(); });

  const element = el('div', { class: 'jd-draw' },
    el('div', { class: 'jd-draw-head' }, el('h2', { class: 'jd-draw-title' }, text('title')), el('div', { class: 'jd-draw-head-actions' }, cancelButton, saveButton)),
    el('div', { class: 'jd-draw-paper' }, canvas),
    el('div', { class: 'jd-draw-row jd-draw-pens', role: 'radiogroup', 'aria-label': text('colors') }, ...penButtons),
    el('div', { class: 'jd-draw-row jd-draw-sizes' }, el('span', { class: 'jd-draw-row-sizes', role: 'radiogroup', 'aria-label': text('widths') }, ...sizeButtons), eraserButton),
    el('div', { class: 'jd-draw-row jd-draw-tools' }, undoButton, redoButton, clearButton),
    message);

  const dirty = () => undo.length > 0;
  function refresh() {
    for (const button of penButtons) button.setAttribute('aria-checked', String(!erasing && button.dataset.color === color));
    for (const button of sizeButtons) button.setAttribute('aria-checked', String(!erasing && Number(button.dataset.size) === size));
    eraserButton.setAttribute('aria-pressed', String(erasing));
    undoButton.disabled = !undo.length;
    redoButton.disabled = !redo.length;
    clearButton.disabled = !strokes.length;
    saveButton.disabled = saving || !strokes.length;
    element.dataset.strokes = String(strokes.length);
    element.classList.toggle('is-erasing', erasing);
  }
  function repaint() {
    paint(context, { width, height, strokes });
    if (current) paintStroke(context, { color, size, points: current });
  }
  function record(change) { undo.push(strokes); redo.length = 0; change(); refresh(); repaint(); }
  undoButton.addEventListener('click', () => { if (!undo.length) return; redo.push(strokes); strokes = undo.pop(); refresh(); repaint(); });
  redoButton.addEventListener('click', () => { if (!redo.length) return; undo.push(strokes); strokes = redo.pop(); refresh(); repaint(); });
  clearButton.addEventListener('click', async () => { if (strokes.length && await confirm(text('clearAsk'))) record(() => { strokes = []; }); });
  element.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key.toLowerCase() === 'z' && !event.shiftKey) { event.preventDefault(); undoButton.click(); }
    else if (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey)) { event.preventDefault(); redoButton.click(); }
  });

  // The canvas is scaled by CSS; points are kept in the pixels of the picture.
  function at(event) {
    const rect = canvas.getBoundingClientRect();
    return [(event.clientX - rect.left) * (width / rect.width), (event.clientY - rect.top) * (height / rect.height)];
  }
  function erase(x, y) {
    const kept = strokes.filter((stroke) => !touches(stroke, x, y));
    if (kept.length === strokes.length) return;
    if (!erasedThisGesture) { undo.push(strokes); redo.length = 0; erasedThisGesture = true; }
    strokes = kept;
    refresh();
    repaint();
  }
  canvas.addEventListener('pointerdown', (event) => {
    if (pointer !== null || saving || (event.pointerType === 'mouse' && event.button !== 0)) return;
    pointer = event.pointerId;
    try { canvas.setPointerCapture(event.pointerId); } catch { /* A synthetic pointer: the events still arrive. */ }
    event.preventDefault();
    const [x, y] = at(event);
    if (erasing) { erasedThisGesture = false; erase(x, y); return; }
    current = [x, y];
    repaint();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointer) return;
    event.preventDefault();
    const [x, y] = at(event);
    if (erasing) { erase(x, y); return; }
    if (!current) return;
    const previousX = current[current.length - 2], previousY = current[current.length - 1];
    // Skip points closer than a pixel and a half; keeps the file small without losing shape (same as Android).
    if (Math.hypot(x - previousX, y - previousY) < 1.5) return;
    current.push(x, y);
    paintStroke(context, { color, size, points: [previousX, previousY, x, y] });
  });
  const finish = (event) => {
    if (event.pointerId !== pointer) return;
    pointer = null;
    if (current) { const points = current; current = null; record(() => { strokes = [...strokes, { color, size, points }]; }); }
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  /** The picture as a PNG with the lines inside, drawn on white paper at full size. */
  async function renderPng() {
    const paper = document.createElement('canvas');
    paper.width = width;
    paper.height = height;
    paint(paper.getContext('2d'), { width, height, strokes });
    const blob = await new Promise((resolve) => paper.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The drawing could not be turned into a picture.');
    return withDrawing(new Uint8Array(await blob.arrayBuffer()), { width, height, strokes });
  }
  saveButton.addEventListener('click', async () => {
    if (saving || !strokes.length) return;
    saving = true;
    message.textContent = text('saving');
    refresh();
    try {
      await onSave({ png: await renderPng(), drawing: { width, height, strokes } });
    } catch (error) {
      saving = false;
      message.textContent = error?.message || String(error);
      refresh();
    }
  });
  async function close() {
    if (saving) return;
    if (dirty() && !await confirm(text('discardAsk'))) return;
    onCancel();
  }
  cancelButton.addEventListener('click', () => void close());

  refresh();
  repaint();
  return { element, canvas, close, get dirty() { return dirty(); }, get strokes() { return strokes; } };
}

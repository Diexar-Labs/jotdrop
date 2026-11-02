// A JotDrop drawing is an ordinary PNG, so Obsidian, Joplin and every browser show it as a picture.
// Its lines travel inside the same file, in a PNG tEXt chunk with the keyword "jotdrop-drawing",
// so JotDrop can open it again to draw on. Format v1, the same in the Android app, the web app and the plugins
// (the reference is android/.../DrawingFormat.kt; this file writes byte for byte the same text):
//
//     {"v":1,"w":1080,"h":1440,"strokes":[{"c":"#1f2937","s":10,"p":[x1,y1,x2,y2,...]}]}
//
// w and h are the size of the PNG in pixels; points and stroke sizes are pixels of that PNG;
// c is a #rrggbb colour. The background is white. Plain JavaScript, no DOM, so a check runs in Node.

export const KEYWORD = 'jotdrop-drawing';
export const WIDTH = 1080;
export const HEIGHT = 1440;

/** Colours with a name, so the choice never depends on seeing the colour (Eric is colour blind). Same six as Android. */
export const PENS = [
  { id: 'black', color: '#1f2937' },
  { id: 'blue', color: '#2563eb' },
  { id: 'red', color: '#dc2626' },
  { id: 'green', color: '#16a34a' },
  { id: 'orange', color: '#ea580c' },
  { id: 'purple', color: '#7c3aed' },
];
export const SIZES = [{ id: 'thin', size: 6 }, { id: 'medium', size: 14 }, { id: 'thick', size: 30 }];
/** The eraser takes a whole line when the finger is this close to it, on top of half the line's width. */
export const ERASE_SLACK = 24;

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const COLOR = /^#[0-9a-fA-F]{6}$/;

export const isDrawingName = (name) => /^drawing-.*\.png$/i.test(name);

/** The file name of a new drawing: drawing-yyyy-MM-dd HHmmss.png, like Android. */
export function drawingFileName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `drawing-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.png`;
}

/** Numbers are rounded to tenths, written without a trailing .0, like the Kotlin code. */
function number(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
const cleanColor = (color) => (COLOR.test(color) ? color.toLowerCase() : '#000000');

/** The JSON text of a drawing { width, height, strokes: [{ color, size, points }] }. */
export function encode(drawing) {
  const strokes = drawing.strokes.map((stroke) => `{"c":"${cleanColor(stroke.color)}","s":${number(stroke.size)},"p":[${stroke.points.map(number).join(',')}]}`);
  return `{"v":1,"w":${drawing.width},"h":${drawing.height},"strokes":[${strokes.join(',')}]}`;
}

/** Null for anything that is not a v1 drawing; a broken stroke is left out rather than failing the whole drawing. */
export function decode(text) {
  let root;
  try { root = JSON.parse(text); } catch { return null; }
  if (!root || typeof root !== 'object' || Array.isArray(root) || root.v !== 1) return null;
  const side = (value) => (typeof value === 'number' && Math.trunc(value) >= 1 && Math.trunc(value) <= 8192 ? Math.trunc(value) : null);
  const width = side(root.w), height = side(root.h);
  if (!width || !height) return null;
  const strokes = [];
  for (const stroke of Array.isArray(root.strokes) ? root.strokes : []) {
    if (!stroke || typeof stroke !== 'object') continue;
    if (typeof stroke.c !== 'string' || !COLOR.test(stroke.c)) continue;
    if (typeof stroke.s !== 'number' || !(stroke.s > 0 && stroke.s <= 400)) continue;
    if (!Array.isArray(stroke.p) || !stroke.p.length || stroke.p.length % 2 || !stroke.p.every((value) => typeof value === 'number' && Number.isFinite(value))) continue;
    strokes.push({ color: stroke.c.toLowerCase(), size: stroke.s, points: stroke.p.slice() });
  }
  return { width, height, strokes };
}

let table;
function crc32(...parts) {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  }
  let crc = 0xffffffff;
  for (const part of parts) for (const byte of part) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const latin1 = (text) => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
const fromLatin1 = (bytes) => { let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return text; };
const isPng = (png) => png.length >= 8 && SIGNATURE.every((byte, index) => png[index] === byte);

/** Every chunk of a PNG as { type, data }, or null for anything that is not a well-formed PNG. */
export function chunks(png) {
  if (!isPng(png)) return null;
  const list = [];
  let at = 8;
  while (at + 12 <= png.length) {
    const length = ((png[at] << 24) | (png[at + 1] << 16) | (png[at + 2] << 8) | png[at + 3]) >>> 0;
    if (at + 12 + length > png.length) return null;
    const type = fromLatin1(png.subarray(at + 4, at + 8));
    list.push({ type, data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
    if (type === 'IEND') break;
  }
  return list.length && list[0].type === 'IHDR' && list[list.length - 1].type === 'IEND' ? list : null;
}

function keywordOf(data) {
  const end = data.indexOf(0);
  return end <= 0 ? null : fromLatin1(data.subarray(0, end));
}

function writeChunk(out, type, data) {
  const typeBytes = latin1(type);
  const int = (value) => out.push(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  int(data.length);
  out.push(...typeBytes);
  for (let i = 0; i < data.length; i += 0x8000) out.push(...data.subarray(i, i + 0x8000));
  int(crc32(typeBytes, data));
}

/** The PNG with this drawing's lines in it, right after IHDR; an older jotdrop-drawing chunk is replaced. */
export function withDrawing(png, drawing) {
  const list = chunks(png);
  if (!list) throw new Error('Not a PNG');
  const out = [...SIGNATURE];
  for (const chunk of list) {
    if (chunk.type === 'tEXt' && keywordOf(chunk.data) === KEYWORD) continue;
    writeChunk(out, chunk.type, chunk.data);
    if (chunk.type === 'IHDR') writeChunk(out, 'tEXt', latin1(`${KEYWORD}\u0000${encode(drawing)}`));
  }
  return Uint8Array.from(out);
}

/** The lines inside a PNG made by JotDrop, or null for any other picture. */
export function read(png) {
  const chunk = chunks(png)?.find((item) => item.type === 'tEXt' && keywordOf(item.data) === KEYWORD);
  return chunk ? decode(fromLatin1(chunk.data.subarray(KEYWORD.length + 1))) : null;
}

/** Whether the point (x, y) touches this stroke: within half its width plus the eraser's slack. */
export function touches(stroke, x, y) {
  const reach = stroke.size / 2 + ERASE_SLACK;
  for (let i = 0; i < stroke.points.length; i += 2) if (Math.hypot(stroke.points[i] - x, stroke.points[i + 1] - y) <= reach) return true;
  return false;
}

/** Paints one stroke on a 2D canvas context, in the drawing's own pixels: round ends, a single point as a dot. */
export function paintStroke(context, stroke) {
  const p = stroke.points;
  context.fillStyle = context.strokeStyle = stroke.color;
  context.lineWidth = stroke.size;
  context.lineCap = context.lineJoin = 'round';
  if (p.length === 2) {
    context.beginPath();
    context.arc(p[0], p[1], stroke.size / 2, 0, Math.PI * 2);
    context.fill();
    return;
  }
  context.beginPath();
  context.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) context.lineTo(p[i], p[i + 1]);
  context.stroke();
}

/** White paper with every stroke on it. */
export function paint(context, drawing) {
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, drawing.width, drawing.height);
  for (const stroke of drawing.strokes) paintStroke(context, stroke);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crc32, inflateSync } from 'node:zlib';
import { KEYWORD, PENS, SIZES, chunks, decode, drawingFileName, encode, isDrawingName, read, touches, withDrawing } from './drawing.mjs';

// The same picture (a copy of android/checks/fixtures/drawing-v1.png) and the same expected text as android/checks/DrawingFormatCheck.kt, so every platform writes the same bytes.
const plain = new Uint8Array(readFileSync(new URL('./fixtures/drawing-v1.png', import.meta.url)));
const drawing = { width: 1080, height: 1440, strokes: [
  { color: '#1F2937', size: 10, points: [10, 20, 30.25, 40.5, 50, 60] },
  { color: '#dc2626', size: 4.5, points: [500, 500] },
] };
const expectedText = '{"v":1,"w":1080,"h":1440,"strokes":[{"c":"#1f2937","s":10,"p":[10,20,30.3,40.5,50,60]},{"c":"#dc2626","s":4.5,"p":[500,500]}]}';

/** A PNG a viewer can show: every chunk's CRC is right and the image data inflates to exactly the rows of the picture. */
function assertValidPng(png) {
  const list = chunks(png);
  assert.ok(list, 'well-formed chunks');
  let at = 8;
  for (const chunk of list) {
    const stored = ((png[at + 8 + chunk.data.length] << 24) | (png[at + 9 + chunk.data.length] << 16) | (png[at + 10 + chunk.data.length] << 8) | png[at + 11 + chunk.data.length]) >>> 0;
    assert.equal(stored, crc32(png.subarray(at + 4, at + 8 + chunk.data.length)), `CRC of ${chunk.type}`);
    at += 12 + chunk.data.length;
  }
  const header = list[0].data;
  const width = (header[0] << 24 | header[1] << 16 | header[2] << 8 | header[3]) >>> 0, height = (header[4] << 24 | header[5] << 16 | header[6] << 8 | header[7]) >>> 0;
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header[9]], bytes = Math.ceil(channels * header[8] / 8);
  const rows = inflateSync(Buffer.concat(list.filter((chunk) => chunk.type === 'IDAT').map((chunk) => Buffer.from(chunk.data))));
  assert.equal(rows.length, height * (1 + width * bytes), 'image rows intact');
  return { width, height };
}

test('the text form rounds to tenths and writes colours in lower case, exactly like Android', () => {
  assert.equal(encode(drawing), expectedText);
  const back = decode(expectedText);
  assert.equal(back.width, 1080);
  assert.equal(back.height, 1440);
  assert.equal(back.strokes.length, 2);
  assert.equal(back.strokes[0].color, '#1f2937');
  assert.deepEqual(back.strokes[0].points, [10, 20, 30.3, 40.5, 50, 60]);
  assert.equal(encode(back), expectedText);
});

test('inside a PNG: still a readable picture, the lines come back, and saving again keeps one copy', () => {
  assert.equal(read(plain), null, 'a plain picture has no drawing');
  const once = withDrawing(plain, drawing);
  assertValidPng(once);
  assert.deepEqual(read(once), decode(expectedText));
  assert.equal(chunks(once)[1].type, 'tEXt', 'the drawing sits right after IHDR');
  const twice = withDrawing(once, { ...drawing, strokes: drawing.strokes.slice(0, 1) });
  assertValidPng(twice);
  assert.equal(read(twice).strokes.length, 1);
  assert.equal(Buffer.from(twice).toString('latin1').split(KEYWORD).length, 2, 'only one drawing chunk');
});

test('anything else is not a drawing, and a broken stroke does not sink the rest', () => {
  for (const junk of ['', '[]', '{"v":2,"w":1,"h":1,"strokes":[]}', '{"v":1,"w":0,"h":1,"strokes":[]}', 'not json', '{"v":1,"w":9000,"h":1,"strokes":[]}']) assert.equal(decode(junk), null, junk);
  const partly = decode('{"v":1,"w":10,"h":10,"strokes":[{"c":"red","s":1,"p":[1,1]},{"c":"#00ff00","s":2,"p":[1]},{"c":"#00FF00","s":2,"p":[1,2]},{"c":"#00ff00","s":0,"p":[1,2]},{"c":"#00ff00","s":2,"p":[1,"2"]}]}');
  assert.deepEqual(partly.strokes, [{ color: '#00ff00', size: 2, points: [1, 2] }]);
  assert.throws(() => withDrawing(Uint8Array.from([1, 2, 3]), drawing));
  assert.equal(read(Uint8Array.from([1, 2, 3])), null);
  assert.ok(isDrawingName('drawing-2026-11-02 140501.png') && !isDrawingName('diexar-2026.png') && !isDrawingName('drawing-x.jpg'));
  assert.match(drawingFileName(new Date(2026, 10, 2, 14, 5, 1)), /^drawing-2026-11-02 140501\.png$/);
});

test('a drawing saved by the Android app opens here with its lines, and saving it again keeps the picture valid', () => {
  const android = new Uint8Array(readFileSync(new URL('./fixtures/drawing-android.png', import.meta.url)));
  assert.deepEqual(assertValidPng(android), { width: 1080, height: 1440 });
  const opened = read(android);
  assert.ok(opened && opened.strokes.length >= 5, 'the lines drawn on the emulator');
  assert.ok(opened.strokes.every((stroke) => PENS.some((pen) => pen.color === stroke.color) && SIZES.some((size) => size.size === stroke.size)), 'Android used the same pens');
  // Written again by this code: identical text, so Android reads it back unchanged.
  const text = Buffer.from(chunks(android).find((chunk) => chunk.type === 'tEXt').data).toString('latin1').slice(KEYWORD.length + 1);
  assert.equal(encode(opened), text);
  const edited = withDrawing(android, { ...opened, strokes: opened.strokes.slice(1) });
  assertValidPng(edited);
  assert.equal(read(edited).strokes.length, opened.strokes.length - 1);
});

test('the eraser takes a line within half its width plus a little slack', () => {
  const stroke = { color: '#1f2937', size: 14, points: [100, 100, 200, 100] };
  assert.ok(touches(stroke, 100, 130) && touches(stroke, 200, 69));
  assert.ok(!touches(stroke, 150, 100), 'between two points far apart: the points are what count, like Android');
  assert.ok(!touches(stroke, 100, 132));
});

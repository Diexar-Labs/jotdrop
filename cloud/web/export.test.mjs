import assert from 'node:assert/strict';
import test from 'node:test';
import { exportZip } from './export.mjs';

test('export preserves Markdown bytes, UTF-8 filenames and ZIP32 directory offsets', async () => {
  const bytes = new TextEncoder().encode('123456789');
  const path = 'notes/idee\u00ebn.md';
  const output = new Uint8Array(await exportZip([{ path, bytes }, { path: 'attachments/empty.bin', bytes: new Uint8Array() }]).arrayBuffer());
  const view = new DataView(output.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(6, true), 0x800);
  assert.equal(view.getUint32(14, true), 0xcbf43926);
  const length = view.getUint16(26, true);
  assert.equal(new TextDecoder().decode(output.slice(30, 30 + length)), path);
  assert.deepEqual(output.slice(30 + length, 30 + length + bytes.length), bytes);
  const end = output.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 8, true), 2);
  const central = view.getUint32(end + 16, true);
  assert.equal(view.getUint32(central, true), 0x02014b50);
  assert.equal(view.getUint32(central + 42, true), 0);
  const second = central + 46 + length;
  assert.equal(view.getUint32(second + 42, true), 30 + length + bytes.length);
  assert.equal(view.getUint32(end + 12, true), end - central);
});

test('export rejects traversal, duplicate names and ZIP64-size requests', () => {
  for (const path of ['../secret', '/absolute', 'notes/../secret', 'C:secret', 'notes\\secret']) assert.throws(() => exportZip([{ path, bytes: new Uint8Array() }]));
  assert.throws(() => exportZip([{ path: 'note.md', bytes: new Uint8Array() }, { path: 'note.md', bytes: new Uint8Array() }]));
  assert.throws(() => exportZip(Array(65536)));
});

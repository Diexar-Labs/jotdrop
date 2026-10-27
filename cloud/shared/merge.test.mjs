import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeNote } from './merge.mjs';

// The same cases run on Android (scripts/check-cloud-android.mjs), so both merge a note the same way.
const vectors = JSON.parse(readFileSync(new URL('./merge-vectors.json', import.meta.url), 'utf8'));
const text = (value) => new TextEncoder().encode(value);

test('notes changed on two devices merge only where the changes do not overlap', () => {
  for (const vector of vectors) {
    const merged = mergeNote(vector.base === null ? null : text(vector.base), text(vector.local), text(vector.cloud));
    assert.equal(merged === null ? null : new TextDecoder().decode(merged), vector.merged, vector.name);
  }
  assert.equal(mergeNote(null, new Uint8Array([0xff, 0xfe]), text('Body\n')), null, 'Bytes that are not UTF-8 never merge');
});

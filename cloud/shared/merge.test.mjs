import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeNote } from './merge.mjs';
import { hugeCase, longCase, randomCases } from './merge-cases.mjs';

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

test('a merged note has every line either device added, whichever device merges', () => {
  const tally = (value) => { const counts = new Map(); for (const line of value.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1); return counts; };
  let merges = 0, copies = 0;
  for (const { name, base, local, cloud } of randomCases(5000)) {
    const merged = mergeNote(text(base), text(local), text(cloud)), other = mergeNote(text(base), text(cloud), text(local));
    assert.equal(merged === null, other === null, name);
    if (merged === null) { copies++; continue; }
    merges++;
    const result = new TextDecoder().decode(merged), counts = tally(result), before = tally(base);
    for (const side of [local, cloud]) for (const [line, count] of tally(side)) assert.ok((counts.get(line) ?? 0) >= count - (before.get(line) ?? 0), `${name}: "${line}" was lost`);
    assert.deepEqual(result.split('\n').sort(), new TextDecoder().decode(other).split('\n').sort(), name);
  }
  assert.ok(merges > 1000 && copies > 1000, `Too few of each: ${merges} merged, ${copies} kept both`);
});

test('a very long note merges', () => {
  const { base, local, cloud } = longCase();
  const lines = new TextDecoder().decode(mergeNote(text(base), text(local), text(cloud))).split('\n');
  assert.deepEqual([lines.length, lines[10], lines[299990], lines.filter((line) => line === 'y').length], [300000, 'y', 'y', 2]);
});

test('too much changed to compare keeps both versions', () => {
  const { base, local, cloud } = hugeCase();
  assert.equal(mergeNote(text(base), text(local), text(cloud)), null);
});

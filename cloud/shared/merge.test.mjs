import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeNote } from './merge.mjs';
import { dragCases, hugeCase, listCases, longCase, randomCases, tickCases } from './merge-cases.mjs';

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
  let merges = 0, copies = 0, lopsided = 0;
  for (const { name, base, local, cloud } of randomCases(5000)) {
    const before = tally(base), sides = [local, cloud].map(tally);
    // A line that says something and stands once in all three texts: it stays once, wherever each device moved it.
    const once = [...before.keys()].filter((line) => line.trim() && sides.every((side) => side.get(line) === 1) && before.get(line) === 1);
    const results = [mergeNote(text(base), text(local), text(cloud)), mergeNote(text(base), text(cloud), text(local))].map((merged) => merged && new TextDecoder().decode(merged));
    for (const result of results) {
      if (result === null) continue;
      const counts = tally(result);
      for (const side of sides) for (const [line, count] of side) assert.ok((counts.get(line) ?? 0) >= count - (before.get(line) ?? 0), `${name}: "${line}" was lost`);
      for (const line of once) assert.equal(counts.get(line), 1, `${name}: "${line}" must stay once`);
    }
    // A line both devices moved goes where the cloud has it. Only there can it matter which device merges: on one of
    // them that place may be inside what it rewrote itself, and then both versions stay.
    if ((results[0] === null) !== (results[1] === null)) { assert.ok(once.length, name); lopsided++; }
    else if (results[0] === null) copies++;
    else { merges++; assert.deepEqual(results[0].split('\n').sort(), results[1].split('\n').sort(), name); }
  }
  assert.ok(merges > 1000 && copies > 1000 && lopsided < 5, `Too few of each: ${merges} merged, ${copies} kept both, ${lopsided} merged on one device only`);
});

test('a task dragged on one device is followed: a tick from the other device travels along, no task stands twice', () => {
  // One device drags a task, the other ticks it or drags it elsewhere: the old merge per line kept both versions for
  // the first and left the task twice for the second (design checklists-77, part 8).
  const tasks = (value) => value.split('\n').map((line) => line.replace('[x]', '[ ]')).sort();
  let exact = 0;
  for (const { name, base, local, cloud, merged } of dragCases()) {
    const result = mergeNote(text(base), text(local), text(cloud));
    assert.ok(result, `${name}: must merge`);
    const note = new TextDecoder().decode(result);
    assert.deepEqual(tasks(note), tasks(base), `${name}: every task once`);
    if (merged !== undefined) { assert.equal(note, merged, name); exact++; }
  }
  assert.equal(exact, 42 + 42 + 100);
});

test('a task ticked on two devices, on one of them moved to the bottom as well, stays one task', () => {
  // With "Move checked items to the bottom" a tick takes the line away and puts it back ticked further down, while the
  // other device ticked it where it stood: per line a line changed and removed (design checklists-77, part 21).
  const tasks = (value) => value.split('\n').map((line) => line.replace('[x]', '[ ]')).sort();
  let merges = 0;
  for (const { name, base, local, cloud, merged } of tickCases()) {
    const result = mergeNote(text(base), text(local), text(cloud));
    const note = result && new TextDecoder().decode(result);
    assert.equal(note, merged, name);
    if (note === null) continue;
    merges++;
    assert.deepEqual(tasks(note), tasks(base), `${name}: every task once`);
  }
  assert.equal(merges, 10 + 40 + 38);
});

test('lists ticked, dragged and changed on two devices merge with every line kept and no line twice', () => {
  const tally = (value) => { const counts = new Map(); for (const line of value.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1); return counts; };
  let merges = 0;
  for (const { name, base, local, cloud } of listCases(20000)) {
    const before = tally(base), sides = [local, cloud].map(tally);
    const once = [...before.keys()].filter((line) => line && sides.every((side) => side.get(line) === 1));
    for (const [mine, theirs] of [[local, cloud], [cloud, local]]) {
      const merged = mergeNote(text(base), text(mine), text(theirs));
      if (merged === null) continue;
      merges++;
      const counts = tally(new TextDecoder().decode(merged));
      for (const side of sides) for (const [line, count] of side) assert.ok((counts.get(line) ?? 0) >= count - (before.get(line) ?? 0), `${name}: "${line}" was lost`);
      for (const line of once) assert.equal(counts.get(line), 1, `${name}: "${line}" must stay once`);
    }
  }
  assert.ok(merges > 25000, `Too few lists merged: ${merges}`);
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

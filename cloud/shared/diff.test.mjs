import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, foldUnchanged } from './diff.mjs';

const kinds = (lines) => lines.map((line) => `${line.type[0]}:${line.text}`);

test('a changed line shows as removed and added, the rest stays', () => {
  assert.deepEqual(kinds(diffLines('milk\nbread\neggs', 'milk\nbutter\neggs')), ['s:milk', 'r:bread', 'a:butter', 's:eggs']);
});

test('added and removed lines at the edges', () => {
  assert.deepEqual(kinds(diffLines('one', 'zero\none\ntwo')), ['a:zero', 's:one', 'a:two']);
  assert.deepEqual(kinds(diffLines('zero\none\ntwo', 'one')), ['r:zero', 's:one', 'r:two']);
});

test('identical notes have no changes, line endings do not count', () => {
  assert.ok(diffLines('a\nb', 'a\r\nb').every((line) => line.type === 'same'));
});

test('an empty version shows every line of the other as a change', () => {
  assert.deepEqual(kinds(diffLines('', 'a')), ['r:', 'a:a']);
});

test('a note too long to compare says so instead of freezing the screen', () => {
  const lines = (prefix) => Array.from({ length: 3000 }, (_, index) => `${prefix}${index}`).join('\n');
  assert.equal(diffLines(lines('a'), lines('b')), null);
  // Long, but with only a small change: comparing stays possible.
  const long = lines('a');
  assert.ok(diffLines(long, `${long}\nextra`));
});

test('unchanged lines far from a change fold away', () => {
  const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
  const folded = foldUnchanged(diffLines(before, before.replace('line 10', 'changed')));
  assert.deepEqual(folded.map((line) => line.type), ['gap', 'same', 'same', 'removed', 'added', 'same', 'same', 'gap']);
  assert.equal(folded[0].count, 8);
  assert.equal(folded[7].count, 7);
});

test('nothing changed folds to one gap', () => {
  assert.deepEqual(foldUnchanged(diffLines('a\nb', 'a\nb')), [{ type: 'gap', count: 2 }]);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MIN_CHARS, findDuplicates, normalizeText, pairKey } from './similar.mjs';

const vectors = JSON.parse(readFileSync(new URL('./similar-vectors.json', import.meta.url), 'utf8'));

for (const vector of vectors.cases) {
  test(`similar: ${vector.name}`, () => {
    const result = findDuplicates(vector.notes, { dismissed: (vector.dismissed ?? []).map(([a, b]) => pairKey(a, b)) });
    assert.deepEqual(result.pairs, vector.expect);
    assert.equal(result.complete, true);
  });
}

test('similar: the answer does not depend on the order of the notes', () => {
  const notes = vectors.cases.find((vector) => vector.name.startsWith('three equal')).notes;
  const expected = vectors.cases.find((vector) => vector.name.startsWith('three equal')).expect;
  assert.deepEqual(findDuplicates([...notes].reverse()).pairs, expected);
});

test('similar: normalizing folds case, accents and white space, and the pair key does not care about order', () => {
  assert.equal(normalizeText('  Café\n\tAU   Lait '), 'cafe au lait');
  assert.equal(pairKey('b', 'a'), pairKey('a', 'b'));
  assert.equal(MIN_CHARS, 40);
});

test('similar: a note with fewer than three words still compares as a whole', () => {
  const text = 'Onderhoudscontract-verlenging-aanvraagformulier-ingevuld';
  const result = findDuplicates([{ id: 'a', title: 'A', text }, { id: 'b', title: 'B', text: `${text} ` }]);
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].kind, 'same');
});

test('similar: a time limit ends the search and says the list is not complete', () => {
  const base = Array.from({ length: 40 }, (_, i) => `woord${i}`).join(' ');
  const notes = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, title: `N${i}`, text: `${base} extra${i}` }));
  let tick = 0;
  const result = findDuplicates(notes, { timeLimitMs: 10, now: () => (tick += 5) });
  assert.equal(result.complete, false);
});

test('similar: too many pairs end the search with complete false', () => {
  const text = 'dit is een precies gelijke notitie die ruim veertig tekens lang is';
  const notes = Array.from({ length: 40 }, (_, i) => ({ id: `n${String(i).padStart(2, '0')}`, title: 'N', text }));
  const result = findDuplicates(notes);
  assert.equal(result.pairs.length, 500);
  assert.equal(result.complete, false);
});

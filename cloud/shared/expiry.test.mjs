import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { END_WORDS, PERIOD_WORDS, findExpiry, fold } from './expiry.mjs';

// The same cases as android/checks/PaperDrawerCheck.kt, which reads this file too.
const cases = readFileSync(new URL('./fixtures/expiry-cases.tsv', import.meta.url), 'utf8')
  .split(/\r?\n/).filter((line) => line.includes('\t') && !line.startsWith('#'))
  .map((line) => { const [expected, text] = line.split('\t'); return [expected, text.replace(/\\n/g, '\n')]; });

test('expiry dates found in scanned text, in many languages', () => {
  assert.ok(cases.length >= 60, `only ${cases.length} cases`);
  for (const [expected, text] of cases) assert.equal(findExpiry(text), expected, text);
});

test('every language has words, and words fold to plain letters', () => {
  assert.ok(Object.keys(END_WORDS).length >= 24);
  for (const words of [...Object.values(END_WORDS), ...Object.values(PERIOD_WORDS)]) for (const word of words) assert.equal(fold(word), fold(fold(word)));
  assert.equal(fold('Gültig bis Ø Łódź ß'), 'gultig bis o lodz ss');
});

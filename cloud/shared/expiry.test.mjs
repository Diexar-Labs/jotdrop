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

test('no lookbehind: Safari before iOS 16.4 cannot load a file with one, and the web app and the plugin load this one', () => {
  const source = readFileSync(new URL('./expiry.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\(\?<[!=]/);
});

test('what stands right before a date or a word still counts', () => {
  for (const [expected, text] of [
    ['2030-05-31', 'Valid until 2030-05-31'],
    ['', 'Valid until 12030-05-31'], // a digit before the year
    ['2030-01-31', 'Expiry jan 2030'],
    ['', 'Expiry xjan 2030'], // a letter before the month
    ['2030-05-31', 'Expiry 05/2030'],
    ['', 'Expiry .05/2030'], // a date sign before month/year
    ['2030-01-31', 'exp 2030-01-31'],
    ['', 'unexp 2030-01-31'], // a letter before the word
    ['2030-05-31', 'X有效期至2030年5月31日'], // Chinese words match after anything
    ['2031-02-28', 'Valid until 12030-01-01 or 2031-02-28'], // a skipped date does not hide the next one
  ]) assert.equal(findExpiry(text), expected, text);
});

test('every language has words, and words fold to plain letters', () => {
  assert.ok(Object.keys(END_WORDS).length >= 24);
  for (const words of [...Object.values(END_WORDS), ...Object.values(PERIOD_WORDS)]) for (const word of words) assert.equal(fold(word), fold(fold(word)));
  assert.equal(fold('Gültig bis Ø Łódź ß'), 'gultig bis o lodz ss');
});

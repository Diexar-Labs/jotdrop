import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { redact } from './redact.mjs';

const vectors = JSON.parse(readFileSync(new URL('./ai-vectors.json', import.meta.url), 'utf8'));

test('redact: key shapes and the key itself never show', () => {
  for (const vector of vectors.redact) assert.equal(redact(vector.input, vector.secrets), vector.expect, vector.input);
});

test('redact: an sk- key is hidden after anything but a letter or a digit', () => {
  for (const [input, expected] of [
    ['sk-abcdefgh12', '[hidden]'],
    ['key sk-abcdefgh12 end', 'key [hidden] end'],
    ['x=sk-abcdefgh12&y', 'x=[hidden]&y'],
    ['line\nsk-abcdefgh12', 'line\n[hidden]'],
    ['(sk-abcdefgh12)', '([hidden])'],
    ['sk-aaaaaaaa sk-bbbbbbbb', '[hidden] [hidden]'],
    ['task-abcdefgh12', 'task-abcdefgh12'], // a letter before sk-: a word, not a key
    ['9sk-abcdefgh12', '9sk-abcdefgh12'],
  ]) assert.equal(redact(input), expected, input);
});

test('redact: anything that is not text becomes text first', () => {
  assert.equal(redact(undefined), '');
  assert.equal(redact(new Error('Bearer abcdefghijkl')), 'Error: Bearer [hidden]');
  // A short or empty secret is no reason to hide every letter.
  assert.equal(redact('a b c', ['', 'a']), 'a b c');
});

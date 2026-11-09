import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { redact } from './redact.mjs';

const vectors = JSON.parse(readFileSync(new URL('./ai-vectors.json', import.meta.url), 'utf8'));

test('redact: key shapes and the key itself never show', () => {
  for (const vector of vectors.redact) assert.equal(redact(vector.input, vector.secrets), vector.expect, vector.input);
});

test('redact: anything that is not text becomes text first', () => {
  assert.equal(redact(undefined), '');
  assert.equal(redact(new Error('Bearer abcdefghijkl')), 'Error: Bearer [hidden]');
  // A short or empty secret is no reason to hide every letter.
  assert.equal(redact('a b c', ['', 'a']), 'a b c');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KEEP_YEARS, keepUntil, parseReceipt, receiptRequest } from './receipt.mjs';

const vectors = JSON.parse(readFileSync(new URL('./ai-vectors-v2.json', import.meta.url), 'utf8')).receipts;

test('the buttons of the receipt screen: keep for 1, 2, 3, 5 or 7 years', () => {
  assert.deepEqual(KEEP_YEARS, [1, 2, 3, 5, 7]);
});

for (const [i, vector] of vectors.requests.entries()) {
  test(`receipt request ${i + 1}`, () => {
    assert.deepEqual(receiptRequest(vector.language), vector.expect);
  });
}

for (const vector of vectors.parse) {
  test(`receipt answer: ${vector.name}`, () => {
    assert.deepEqual(parseReceipt(vector.answer), vector.expect);
  });
}

for (const vector of vectors.keepUntil) {
  test(`keep until: ${vector.bought} + ${vector.years}`, () => {
    assert.equal(keepUntil(vector.bought, vector.years), vector.expect);
  });
}

test('a receipt answer is only data: no field can carry a tool call or a line of its own', () => {
  const out = parseReceipt('{"title":"x\\n- [ ] new task","shop":"y\\r\\n# Heading","amount":"1\\n2"}');
  for (const value of Object.values(out)) assert.ok(!/[\r\n]/.test(value), value);
  assert.equal(parseReceipt(''), null);
  assert.equal(parseReceipt(undefined), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AiError } from './providers.mjs';
import { KINDS, LIMITS, capabilities, checkParts, explain } from './parts.mjs';

const vectors = JSON.parse(readFileSync(new URL('./ai-vectors-v2.json', import.meta.url), 'utf8'));

// A part with "size" gets that many zero bytes as base64.
const fakeData = (size) => 'A'.repeat(4 * Math.floor(size / 3)) + ['', 'AA==', 'AAA='][size % 3];
const withData = (part) => part.size === undefined ? part : (({ size, ...rest }) => ({ ...rest, data: fakeData(size) }))(part);

test('the limits from the design: 4 files, photo 4 MiB, PDF 12 MiB, recording 14 MiB, 14 MiB together', () => {
  assert.deepEqual(LIMITS, vectors.limits.constants);
  assert.deepEqual(KINDS, ['image', 'pdf', 'audio']);
  // Gemini takes 20 MB per request including everything; 14 MiB as base64 stays under it.
  assert.ok(Math.ceil(LIMITS.total / 3) * 4 < 20 * 1000 * 1000);
});

test('fakeData makes base64 of the right number of bytes', () => {
  for (const size of [0, 1, 2, 3, 4, 5, 10]) assert.equal(Buffer.from(fakeData(size), 'base64').length, size);
});

for (const vector of vectors.capabilities) {
  test(`capabilities: ${vector.provider} ${JSON.stringify(vector.model)}`, () => {
    assert.deepEqual(capabilities(vector.provider, vector.model), vector.expect);
  });
}

for (const vector of vectors.explain) {
  test(`explain: ${vector.provider} ${vector.kind} ${vector.use}`, () => {
    assert.equal(explain(vector.provider, vector.kind, vector.use), vector.expect);
  });
}

for (const vector of vectors.limits.checks) {
  test(`limits: ${vector.name}`, () => {
    const parts = vector.parts.map(withData);
    const caps = vector.caps ?? { image: true, pdf: true, audio: true };
    if (vector.error) {
      assert.throws(() => checkParts(parts, caps), (error) => error instanceof AiError && error.code === vector.error && error.message.length > 10);
    } else {
      assert.deepEqual(checkParts(parts, caps), vector.expect);
    }
  });
}

test('the reason names the file, never its contents', () => {
  const error = (() => { try { checkParts([{ kind: 'image', mime: 'image/jpeg', name: 'Passport.jpg', data: fakeData(LIMITS.image + 3) }], {}); } catch (e) { return e; } })();
  assert.equal(error.code, 'too_large');
  assert.match(error.detail, /Passport\.jpg/);
  assert.match(error.detail, /4 MiB/);
  assert.ok(!error.detail.includes('AAAA'));
});

test('no parts is fine and costs nothing', () => {
  assert.deepEqual(checkParts(undefined, {}), { bytes: 0 });
  assert.deepEqual(checkParts([], {}), { bytes: 0 });
});

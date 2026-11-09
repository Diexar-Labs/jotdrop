import test from 'node:test';
import assert from 'node:assert/strict';
import { CALLS_PER_MINUTE, WRITES_PER_MINUTE, createLimiter } from './limits.mjs';

test('at most 60 tool calls and 20 changes per minute, then a slow-down answer', () => {
  assert.equal(CALLS_PER_MINUTE, 60);
  assert.equal(WRITES_PER_MINUTE, 20);
  let now = 1_000_000;
  const limiter = createLimiter({ now: () => now });
  for (let i = 0; i < 20; i++) assert.equal(limiter.take(true), null);
  assert.match(limiter.take(true), /slow down/i);
  // Reads still go until the call limit.
  for (let i = 0; i < 40; i++) assert.equal(limiter.take(false), null);
  assert.match(limiter.take(false), /slow down/i);
  // A refused call does not count: after the window everything is free again.
  now += 60_000;
  assert.equal(limiter.take(true), null);
  assert.equal(limiter.take(false), null);
});

test('the window slides: old calls drop out one by one', () => {
  let now = 0;
  const limiter = createLimiter({ calls: 2, writes: 1, now: () => now });
  assert.equal(limiter.take(false), null);
  now = 30_000;
  assert.equal(limiter.take(false), null);
  assert.ok(limiter.take(false));
  now = 60_001;
  assert.equal(limiter.take(false), null);
  assert.ok(limiter.take(false));
});

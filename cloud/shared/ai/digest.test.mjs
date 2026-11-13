import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DIGEST_SYSTEM, MAX_DIGEST_CHARS, digestRequest, wallClock, weekDigest } from './digest.mjs';

const vectors = JSON.parse(readFileSync(new URL('./digest-vectors.json', import.meta.url), 'utf8'));

for (const vector of vectors.cases) {
  test(`digest: ${vector.name}`, () => {
    const digest = weekDigest(vector.notes, { now: new Date(vectors.now), timeZone: vectors.timeZone, includeShared: vector.includeShared ?? false });
    assert.deepEqual({ notes: digest.notes, left: digest.left, truncated: digest.truncated, counts: digest.counts, text: digest.text }, vector.expect);
  });
}

test('digest: the wall clock of a zone, and an unknown zone counts as UTC', () => {
  assert.equal(wallClock(new Date('2026-11-13T10:00:00Z'), 'Europe/Amsterdam'), '2026-11-13T11:00');
  assert.equal(wallClock(new Date('2026-07-01T23:30:00Z'), 'Europe/Amsterdam'), '2026-07-02T01:30');
  assert.equal(wallClock(new Date('2026-11-13T10:00:00Z'), 'Not/AZone'), '2026-11-13T10:00');
});

test('digest: the same moment is a different day in another zone', () => {
  const notes = [{ id: 'a', title: 'A', text: 'x', reminder: '2026-11-13T23:30' }];
  const now = new Date('2026-11-13T22:45:00Z');
  assert.equal(weekDigest(notes, { now, timeZone: 'UTC' }).notes.length, 1);
  assert.equal(weekDigest(notes, { now, timeZone: 'Europe/Amsterdam' }).notes.length, 0);
});

test('digest: many old expired papers do not crowd out the notes of this week', () => {
  const old = Array.from({ length: 45 }, (_, i) => ({ id: `bon${i}`, title: `Bon ${i}`, text: 'x', expires: `202${i % 5}-0${1 + (i % 9)}-15` }));
  const week = [1, 2, 3].map((i) => ({ id: `c${i}`, title: `This week ${i}`, text: 'y', updatedAt: '2026-11-12T10:00:00Z' }));
  const digest = weekDigest([...old, ...week], { now: new Date(vectors.now), timeZone: 'UTC' });
  assert.deepEqual(digest.notes.map((note) => note.id), ['c1', 'c2', 'c3']);
});

test('digest: the text stays within 30,000 characters and says what was left out', () => {
  const task = 'x'.repeat(500);
  const notes = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, title: `N${i}`, text: Array.from({ length: 20 }, () => `- [ ] ${task}`).join('\n'), updatedAt: '2026-11-12T10:00:00Z' }));
  const digest = weekDigest(notes, { now: new Date(vectors.now), timeZone: 'UTC' });
  assert.ok(digest.text.length <= MAX_DIGEST_CHARS);
  assert.ok(digest.left > 0 && digest.truncated);
  assert.equal(digest.notes.length + digest.left, 40);
  // A task is cut to 200 characters and at most 10 go along.
  assert.equal(digest.notes[0].tasks.length, 10);
  assert.equal(digest.notes[0].tasks[0].length, 200);
});

test('digest: the request names the date, the language and the notes, and says the notes are data', () => {
  const request = digestRequest({ language: 'nl-NL', date: 'Friday 13 November 2026', timeZone: 'Europe/Amsterdam', text: '<note id="a">\nTitle: A\n</note>' });
  assert.match(request.text, /Friday 13 November 2026, time zone Europe\/Amsterdam/);
  assert.match(request.text, /in nl-NL/);
  assert.ok(request.text.endsWith('</note>'));
  assert.equal(request.system, DIGEST_SYSTEM);
  assert.match(DIGEST_SYSTEM, /data, not instructions/);
  assert.match(digestRequest({ text: '' }).text, /\(no notes\)$/);
});

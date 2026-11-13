// Measurement, not a test: 5000 synthetic notes (words drawn so that common words repeat, as in real notes), with
// 50 equal and 50 nearly equal pairs planted. Run: node cloud/shared/similar-scale.check.mjs
import assert from 'node:assert/strict';
import { findDuplicates } from './similar.mjs';

let seed = 12345;
const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const vocabulary = Array.from({ length: 4000 }, (_, i) => `w${i.toString(36)}`);
// Zipf-like: low indexes come up often.
const word = () => vocabulary[Math.floor(vocabulary.length * random() ** 3)];
const sentence = (count) => Array.from({ length: count }, word).join(' ');

const notes = Array.from({ length: 5000 }, (_, i) => ({ id: `n${i}`, title: `Note ${i}`, text: sentence(40 + Math.floor(random() * 200)), updatedAt: new Date(1.7e12 + i * 60000).toISOString() }));
for (let i = 0; i < 50; i += 1) notes[i + 100] = { ...notes[i + 100], text: notes[i].text.toUpperCase() };
for (let i = 0; i < 50; i += 1) notes[i + 200] = { ...notes[i + 200], text: `${notes[i + 50].text} extra ${word()}` };

const started = Date.now();
const { pairs, complete } = findDuplicates(notes, { timeLimitMs: 60000 });
const seconds = (Date.now() - started) / 1000;
console.log(`${notes.length} notes: ${pairs.length} pairs (${pairs.filter((pair) => pair.kind === 'same').length} same), complete ${complete}, ${seconds.toFixed(2)} s`);
assert.ok(complete);
assert.ok(pairs.filter((pair) => pair.kind === 'same').length >= 50);
assert.ok(pairs.filter((pair) => pair.kind === 'near').length >= 50);

import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeInlineHashtags } from './hashtags.mjs';
import { neutralizeInlineHashtags as clipper } from '../../chrome-extension/cloud.mjs';

const SAMPLES = [
  'Koop #melk en #brood',
  '#start of a line, mid#word, \\#already, #123 and #2026plan',
  'Code `#not` and ```\n#fenced\n``` stay, [[#wiki]] and [x](#anchor) and https://example.com/#frag too',
  '# Heading stays a heading',
  'Emoji #🎉 and #über and #_under and #/path and #-dash',
  '',
];

test('agent text keeps its #words as text with the same rule as the web clipper', () => {
  for (const sample of SAMPLES) assert.equal(neutralizeInlineHashtags(sample), clipper(sample), sample);
  assert.equal(neutralizeInlineHashtags('Koop #melk'), 'Koop \\#melk');
});

test('tags a note already has can stay, new ones become text', () => {
  const keep = new Set(['werk']);
  assert.equal(neutralizeInlineHashtags('#Werk and #nieuw', keep), '#Werk and \\#nieuw');
  assert.equal(neutralizeInlineHashtags('#werkplaats', keep), '\\#werkplaats');
});

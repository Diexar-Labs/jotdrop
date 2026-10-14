import test from 'node:test';
import assert from 'node:assert/strict';
import { noteSummary } from './note.mjs';

test('browser reads canonical plugin/Android labels without treating tags or body hashtags as labels', () => {
  const markdown = '---\ntags: [not-a-label]\njotdrop_labels:\n  - Work\n  - "Work: notes"\n  - work\ncolor: teal\npinned: true\nunknown_key: preserve\n---\n\n# Heading\n\nText #not-a-label';
  const note = noteSummary(markdown, 'notes/test.md');
  assert.deepEqual(note.labels, ['work', 'Work: notes']);
  assert.equal(note.color, 'teal');
  assert.equal(note.pinned, true);
  assert.equal(note.title, 'Heading');
  assert.equal(note.preview, 'Text #not-a-label');
  assert.deepEqual(noteSummary('---\njotdrop_labels: ["Personal","Ideas"]\n---\nBody', 'notes/file.md').labels, ['Personal', 'Ideas']);
  assert.deepEqual(noteSummary('---\njotdrop_labels: {unexpected: object}\ncolor: evil\n---\nBody', 'notes/file.md').labels, []);
});

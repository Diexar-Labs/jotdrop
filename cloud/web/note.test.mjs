import test from 'node:test';
import assert from 'node:assert/strict';
import { noteSummary, updateMetadata, toggleTask, attachmentPath, plainPreviewText } from './note.mjs';

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

test('browser property edits preserve unknown nested YAML, tags, recurrence limits and exact body', () => {
  const body = '# Test\r\n\r\n---\r\nText\r\n---\r\n- [ ] Do it\r\n';
  const text = '---\r\ncustom:\r\n  color: untouched\r\ntags: [keep]\r\njotdrop_labels:\r\n  - Old\r\nreminder_until: "2028-12-31"\r\n---\r\n' + body;
  const changed = updateMetadata(text, { color: 'teal', pinned: true, jotdrop_labels: ['Work: notes', 'a, b'], reminder: '2028-10-16T14:30' });
  assert(changed.includes('custom:\r\n  color: untouched\r\ntags: [keep]\r\n'));
  assert(changed.includes('reminder_until: "2028-12-31"'));
  const result = noteSummary(changed, 'notes/test.md');
  assert.equal(result.body, body);
  assert.equal(result.color, 'teal');
  assert.equal(result.pinned, true);
  assert.equal(result.reminder, '2028-10-16T14:30');
  assert.deepEqual(result.labels, ['Work: notes', 'a, b']);
  assert.equal(noteSummary(updateMetadata(changed, { pinned: null }), 'notes/test.md').pinned, false);
  assert.throws(() => updateMetadata('---\nunfinished', { color: 'red' }), /Close the YAML/);
  assert.throws(() => updateMetadata(body, { unknown: true }), /Unsupported/);
  assert.equal(toggleTask('- [ ] one\r\n- [x] two', 0, true), '- [x] one\r\n- [x] two');
  assert.throws(() => toggleTask('No task', 0, true), /checklist changed/);
});

test('media resolves only unambiguous local files, including archived relative links', () => {
  const files = ['attachments/photo.png', 'attachments/sound.webm', 'attachments/other/photo.png'];
  assert.equal(attachmentPath('../attachments/sound.webm', 'notes/test.md', files), 'attachments/sound.webm');
  assert.equal(attachmentPath('../../attachments/photo.png', 'notes/Archive/test.md', files), 'attachments/photo.png');
  assert.equal(attachmentPath('sound.webm', 'notes/test.md', files), 'attachments/sound.webm');
  assert.equal(attachmentPath('photo.png', 'notes/test.md', files), undefined);
  for (const path of ['https://example.com/a.png', 'javascript:alert(1)', '/attachments/photo.png', '../../../attachments/photo.png', '%2e%2e/%2e%2e/%2e%2e/attachments/photo.png']) assert.equal(attachmentPath(path, 'notes/test.md', files), undefined);
});

test('cards show plain text without Markdown marks, like the plugin', () => {
  const marked = ['**Bold** and *italic* and _under_ and __strong__ and ~~gone~~ and ==mark==', '**Note:** use `npm run build` and ***both***',
    'snake_case_name and 2 * 3 * 4 and a == b stay', '\\# not a heading, \\*star\\*, \\<tag\\>, 1986\\.', '> quoted **text**', '> [!note] Callout title', '> - [ ] **quoted** task',
    '---', '* * *', '| Name | Qty |', '| --- | :-: |', '| Milk | 2 \\| 3 |', '```js', 'const x = **y**;', '```', '- [ ] **buy** milk', '* bullet *emph*', 'line<br>break',
    '[[Wiki|alias]] and [label](https://x.y)'].join('\n');
  const plain = ['Bold and italic and under and strong and gone and mark', 'Note: use npm run build and both', 'snake_case_name and 2 * 3 * 4 and a == b stay',
    '# not a heading, *star*, <tag>, 1986.', 'quoted text', 'Callout title', '> - [ ] quoted task', 'Name · Qty', 'Milk · 2 | 3', 'const x = **y**;', '- [ ] buy milk', '* bullet emph', 'line break',
    '[[Wiki|alias]] and [label](https://x.y)'].join('\n');
  assert.equal(plainPreviewText(marked), plain);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { noteSummary, updateMetadata, toggleTask, attachmentPath, plainPreviewText, splitNote, joinNote, noteFilename } from './note.mjs';

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

test('browser reads inline hashtags like Android, apart from frontmatter tags', () => {
  const markdown = '---\ntags: [Home]\n---\n# Heading #intitle\n\nBuy milk #errands #home #2024 \\#shared\n#Errands at start\n`#code` [[Note#anchor]] https://x.nl/#frag\n```\n#fenced\n```\n#émigré #a/b-c';
  const note = noteSummary(markdown, 'notes/test.md');
  assert.deepEqual(note.tags, ['Home']);
  assert.deepEqual(note.inlineTags, ['intitle', 'errands', 'émigré', 'a/b-c']);
  assert.deepEqual(noteSummary('No tags here', 'notes/plain.md').inlineTags, []);
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

test('editor reads frontmatter tags in every YAML form and writes them like labels', () => {
  assert.deepEqual(noteSummary('---\ntags: [a, "#b", a]\n---\nx', 'n.md').tags, ['a', 'b']);
  assert.deepEqual(noteSummary('---\ntags:\n  - x\n  - "y z"\n---\nx', 'n.md').tags, ['x', 'y z']);
  assert.deepEqual(noteSummary('---\ntags: one, two\n---\nx', 'n.md').tags, ['one', 'two']);
  assert.deepEqual(noteSummary('---\njotdrop_labels: [a, b]\n---\nx #inline', 'n.md').tags, []);
  const changed = updateMetadata('---\ncustom: 1\ntags:\n  - old\n---\nBody #inline', { tags: ['new', 'two'] });
  assert.equal(changed, '---\ncustom: 1\ntags: ["new","two"]\n---\nBody #inline');
  assert.deepEqual(noteSummary(changed, 'n.md').tags, ['new', 'two']);
  assert.equal(updateMetadata(changed, { tags: null }), '---\ncustom: 1\n---\nBody #inline');
});

test('editor splits a note into frontmatter, title and text and joins it back', () => {
  const note = '---\r\ncustom: x\r\n---\r\n# Shopping list\r\n\r\n- [ ] milk\r\n';
  assert.deepEqual(splitNote(note), { front: '---\r\ncustom: x\r\n---\r\n', title: 'Shopping list', body: '- [ ] milk\r\n' });
  assert.deepEqual(splitNote('Just text\n# Not a title'), { front: '', title: '', body: 'Just text\n# Not a title' });
  assert.deepEqual(splitNote('# Only'), { front: '', title: 'Only', body: '' });
  assert.equal(joinNote({ front: '', title: 'A\ntitle ', body: 'text' }), '# A title\n\ntext');
  assert.equal(joinNote({ front: '---\na: 1\n---\n', title: '', body: 'text' }), '---\na: 1\n---\ntext');
  for (const text of ['# T\n\nBody', '---\na: 1\n---\n# T\n\nBody', 'Body only']) assert.equal(joinNote(splitNote(text)), text);
});

test('new notes get the plugin and Android filename from their first words', () => {
  const date = new Date(2026, 9, 24, 9, 5, 7);
  assert.equal(noteFilename('---\npinned: true\n---\n# Shopping: list?\n\nmilk', date), '2026-10-24 090507 Shopping list.md');
  assert.equal(noteFilename('\n![[photo.png]]\n- [ ] Call *mum* about (dinner)', date), '2026-10-24 090507 Call mum about dinner.md');
  assert.equal(noteFilename('', date), '2026-10-24 090507.md');
});

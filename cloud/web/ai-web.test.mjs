import test from 'node:test';
import assert from 'node:assert/strict';
import { aiNotes, appendedText, aiSettings, describeChange, editorRequest, expiryChanges, labelChanges, newNoteText, reminderChanges, replacedText, WEB_PROVIDERS } from './ai-web.mjs';
import { noteSummary, updateMetadata } from './note.mjs';

const note = (path, text, extra = {}) => ({ id: `id-${path}`, path, text, modifiedAt: '2026-11-09T10:00:00Z', ...extra });

test('Ask JotDrop gets the notes in Notes and Archive, without trash, files, deleted notes or front matter', () => {
  const notes = aiNotes([
    note('notes/a.md', '---\njotdrop_labels: ["Home"]\ncolor: "red"\n---\n# Groceries\n\n- [ ] milk\n'),
    note('notes/Archive/old.md', '# Old\n\nkept'),
    note('notes/Trash/gone.md', '# Gone'),
    note('notes/b.md', '# Deleted', { deleted: true }),
    note('notes/photo.png', 'binary'),
    note('attachments/x.md', '# Not a note'),
    note('notes/plain.md', 'No heading here'),
  ]);
  assert.deepEqual(notes, [
    { id: 'id-notes/a.md', title: 'Groceries', text: '- [ ] milk\n', labels: ['Home'], updatedAt: '2026-11-09T10:00:00Z', shared: false },
    { id: 'id-notes/Archive/old.md', title: 'Old', text: 'kept', labels: [], updatedAt: '2026-11-09T10:00:00Z', shared: false },
    { id: 'id-notes/plain.md', title: 'plain', text: 'No heading here', labels: [], updatedAt: '2026-11-09T10:00:00Z', shared: false },
  ]);
});

test('notes in a shared group and notes with a live list link are marked shared', () => {
  const entries = [note('notes/a.md', '# A'), note('notes/b.md', '# B')];
  assert.deepEqual(aiNotes(entries, { sharedPaths: ['notes/b.md'] }).map((n) => n.shared), [false, true]);
  assert.deepEqual(aiNotes(entries, { inSpace: true }).map((n) => n.shared), [true, true]);
});

test('a new note from the AI is Markdown with a title, text, checklist, color and label', () => {
  const text = newNoteText({ title: 'Groceries', text: 'For the weekend', items: ['milk', 'bread'], color: 'green', label: 'Home' });
  assert.equal(text, '---\ncolor: "green"\njotdrop_labels: ["Home"]\n---\n# Groceries\n\nFor the weekend\n\n- [ ] milk\n- [ ] bread\n');
  const parts = noteSummary(text, 'notes/x.md');
  assert.equal(parts.title, 'Groceries');
  assert.deepEqual(parts.labels, ['Home']);
  assert.equal(parts.color, 'green');
  assert.equal(newNoteText({ title: 'Only a title' }), '# Only a title\n');
  assert.equal(newNoteText({ title: 'Plain', color: 'default', text: 'x' }), '# Plain\n\nx\n');
  // A title on more lines stays one line; checklist marks the AI added itself are not doubled.
  assert.equal(newNoteText({ title: 'Two\nlines', items: ['- [ ] eggs', '[x] done'] }), '# Two lines\n\n- [ ] eggs\n- [ ] done\n');
});

test('adding to a note keeps what is there and puts text and items at the end', () => {
  assert.equal(appendedText('# List\n\n- [ ] milk\n', { items: ['bread', 'eggs'] }), '# List\n\n- [ ] milk\n- [ ] bread\n- [ ] eggs\n');
  assert.equal(appendedText('# List\n\n- [ ] milk', { items: ['bread'] }), '# List\n\n- [ ] milk\n- [ ] bread\n');
  assert.equal(appendedText('# Note\n\nFirst part.\n', { text: 'Second part.' }), '# Note\n\nFirst part.\n\nSecond part.\n');
  assert.equal(appendedText('# Note\n\nText\n', { text: 'More', items: ['a'] }), '# Note\n\nText\n\nMore\n\n- [ ] a\n');
  assert.equal(appendedText('', { text: 'x' }), 'x\n');
  // Windows line ends stay Windows line ends.
  assert.equal(appendedText('# L\r\n\r\n- [ ] a\r\n', { items: ['b'] }), '# L\r\n\r\n- [ ] a\r\n- [ ] b\r\n');
});

test('replacing the text keeps the front matter and the title', () => {
  const before = '---\npinned: true\n---\n# Groceries\n\nbread\nmilk\n';
  assert.equal(replacedText(before, 'milk\nbread'), '---\npinned: true\n---\n# Groceries\n\nmilk\nbread\n');
  // The AI repeating the title as a heading does not give the note two titles.
  assert.equal(replacedText(before, '# Groceries\n\nmilk'), '---\npinned: true\n---\n# Groceries\n\nmilk\n');
  assert.equal(replacedText('no title', 'new'), 'new\n');
});

test('labels, reminders and expiry dates become the same properties the editor writes', () => {
  assert.deepEqual(labelChanges(['Work', 'work', ' Home ']), { jotdrop_labels: ['Work', 'Home'] });
  assert.deepEqual(labelChanges([]), { jotdrop_labels: null });
  assert.deepEqual(reminderChanges('2026-11-10T10:00'), { reminder: '2026-11-10T10:00', reminder_repeat: null, reminder_until: null, reminder_limit: null, reminder_done: null });
  const text = '---\njotdrop_labels: ["Home"]\n---\n# Receipt';
  const expiry = expiryChanges(text, '2028-11-09');
  assert.deepEqual(expiry.jotdrop_labels, ['Home', 'Paper drawer']);
  assert.equal(expiry.expires, '2028-11-09');
  // No reminder yet: the usual warning a week before, as the editor sets it.
  assert.equal(expiry.reminder, '2028-11-02T09:00');
  // A reminder the user already has stays.
  assert.equal(expiryChanges('---\nreminder: "2027-01-01T08:00"\n---\n# R', '2028-11-09').reminder, undefined);
  assert.deepEqual(expiryChanges('# R', '2028-11-09', 'Work').jotdrop_labels, ['Paper drawer/Work']);
  assert.throws(() => expiryChanges('# R', '2028-02-30'), /date/);
  // The properties are ones updateMetadata accepts.
  for (const changes of [labelChanges(['A']), reminderChanges('2026-11-10T10:00'), expiry]) assert.doesNotThrow(() => updateMetadata(text, changes));
});

test('a change the user confirms is shown in words and lines, not only in color', () => {
  const groceries = { id: 'n1', title: 'Groceries', text: '- [ ] milk\n', labels: ['Home'] };
  const append = describeChange({ tool: 'append_to_note', input: { id: 'n1', items: ['bread'] }, note: groceries });
  assert.equal(append.heading, 'Add to "Groceries"');
  assert.deepEqual(append.lines.filter((line) => line.type !== 'same').map((line) => `${line.sign} ${line.text}`), ['+ - [ ] bread']);
  const replace = describeChange({ tool: 'replace_note_text', input: { id: 'n1', text: 'milk' }, note: groceries });
  assert.equal(replace.heading, 'Replace the text of "Groceries"');
  assert.deepEqual(replace.lines.filter((line) => line.type !== 'same').map((line) => line.sign), ['-', '+']);
  const labels = describeChange({ tool: 'set_labels', input: { id: 'n1', labels: ['Home', 'Shop'] }, note: groceries, newLabels: ['Shop'] });
  assert.equal(labels.heading, 'Set the labels of "Groceries"');
  assert.deepEqual(labels.facts, [['Labels now', 'Home'], ['Labels after', 'Home, Shop'], ['New label', 'Shop']]);
  const reminder = describeChange({ tool: 'set_reminder', input: { id: 'n1', at: '2026-11-10T10:00' }, note: groceries });
  assert.deepEqual(reminder.facts, [['Reminder', '2026-11-10 10:00']]);
  const expiry = describeChange({ tool: 'set_expiry', input: { id: 'n1', date: '2028-11-09', drawer: 'Work' }, note: groceries });
  assert.deepEqual(expiry.facts, [['Expires', '2028-11-09'], ['Paper drawer', 'Work']]);
});

test('settings keep only what the web app can use; the key is never trimmed into another value', () => {
  assert.deepEqual(Object.keys(WEB_PROVIDERS), ['ollama', 'anthropic', 'openai', 'gemini', 'openrouter']);
  assert.deepEqual(aiSettings(undefined), { provider: '', key: '', model: '', includeShared: false });
  assert.deepEqual(aiSettings({ provider: 'anthropic', key: ' sk-ant-abc ', model: ' claude-haiku-5-5 ', includeShared: 1, other: 'x' }), { provider: 'anthropic', key: 'sk-ant-abc', model: 'claude-haiku-5-5', includeShared: true });
  // An own address is not allowed by the web app's CSP, so it does not come back from storage.
  assert.deepEqual(aiSettings({ provider: 'custom', key: 'k', baseUrl: 'https://x' }), { provider: '', key: '', model: '', includeShared: false });
  // Ollama needs no key; a key left from another provider is dropped.
  assert.deepEqual(aiSettings({ provider: 'ollama', key: 'old', model: 'qwen3.5:9b' }), { provider: 'ollama', key: '', model: 'qwen3.5:9b', includeShared: false });
});

test('the editor buttons ask for the new text only, so it can replace or follow the draft', () => {
  for (const kind of ['rewrite', 'checklist', 'summarize']) {
    const request = editorRequest(kind, 'Trip plan');
    assert.match(request, /"Trip plan"/);
    assert.match(request, /only/i);
  }
  assert.match(editorRequest('checklist', 'x'), /- \[ \]/);
  assert.throws(() => editorRequest('delete', 'x'));
});

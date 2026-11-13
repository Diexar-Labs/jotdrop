import test from 'node:test';
import assert from 'node:assert/strict';
import { aiFileKind, aiNotes, appendedText, modelGroups, aiSettings, describeChange, editorRequest, expiryChanges, fileRequest, labelChanges, newNoteText, plainBase64, receiptApplied, receiptLines, reminderChanges, replacedText, WEB_PROVIDERS } from './ai-web.mjs';
import { noteSummary, updateMetadata } from './note.mjs';

const note = (path, text, extra = {}) => ({ id: `id-${path}`, path, text, modifiedAt: '2026-11-09T10:00:00Z', ...extra });

test('Ask JotDrop gets the notes in Notes and Archive, without trash, files, deleted notes or front matter', () => {
  const notes = aiNotes([
    note('notes/a.md', '---\njotdrop_labels: ["Home"]\ncolor: "red"\nreminder: "2026-11-14T09:00"\nexpires: "2027-01-02"\n---\n# Groceries\n\n- [ ] milk\n'),
    note('notes/Archive/old.md', '# Old\n\nkept'),
    note('notes/Trash/gone.md', '# Gone'),
    note('notes/b.md', '# Deleted', { deleted: true }),
    note('notes/photo.png', 'binary'),
    note('attachments/x.md', '# Not a note'),
    note('notes/plain.md', 'No heading here'),
  ]);
  assert.deepEqual(notes, [
    { id: 'id-notes/a.md', title: 'Groceries', text: '- [ ] milk\n', labels: ['Home'], updatedAt: '2026-11-09T10:00:00Z', reminder: '2026-11-14T09:00', expires: '2027-01-02', shared: false },
    { id: 'id-notes/Archive/old.md', title: 'Old', text: 'kept', labels: [], updatedAt: '2026-11-09T10:00:00Z', reminder: '', expires: '', shared: false },
    { id: 'id-notes/plain.md', title: 'plain', text: 'No heading here', labels: [], updatedAt: '2026-11-09T10:00:00Z', reminder: '', expires: '', shared: false },
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

test('a long model list comes in groups: suggested first, then per company, models without tools last', () => {
  const models = [
    { id: 'qwen/qwen-x', name: 'Qwen X', tools: true },
    { id: 'mistralai/mistral-nemo', name: 'Mistral Nemo', tools: true },
    { id: 'anthropic/claude-haiku-5.5', name: 'Claude Haiku 5.5', tools: true },
    { id: 'openai/gpt-6-luna', name: 'GPT-6 Luna', tools: true },
    { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', tools: true },
    { id: 'old/model', name: 'Old', tools: false },
  ];
  const groups = modelGroups('openrouter', models, 'mistralai/mistral-nemo');
  assert.deepEqual(groups.map((group) => [group.label, group.models.map((model) => model.id)]), [
    ['Suggested', ['anthropic/claude-haiku-5.5', 'openai/gpt-6-luna', 'mistralai/mistral-nemo']],
    ['anthropic', ['anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5']],
    ['mistralai', ['mistralai/mistral-nemo']],
    ['openai', ['openai/gpt-6-luna']],
    ['qwen', ['qwen/qwen-x']],
    ['Cannot use tools', ['old/model']],
  ]);
  // A service with its own models only: one group, the default suggested.
  const own = modelGroups('anthropic', [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', tools: true }, { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', tools: true }], 'claude-haiku-5-5');
  assert.deepEqual(own.map((group) => [group.label, group.models.map((model) => model.id)]), [['Suggested', ['claude-haiku-5-5']], ['All models', ['claude-haiku-5-5', 'claude-sonnet-5-5']]]);
  assert.deepEqual(modelGroups('ollama', []), []);
});

test('version 2: photos, PDFs and recordings a note links to can go along; other files cannot', () => {
  assert.deepEqual(aiFileKind('attachments/IMG_0042.JPG'), { kind: 'image', mime: 'image/jpeg' });
  assert.deepEqual(aiFileKind('attachments/scan.png'), { kind: 'image', mime: 'image/png' });
  assert.deepEqual(aiFileKind('attachments/Pasted.webp'), { kind: 'image', mime: 'image/webp' });
  assert.deepEqual(aiFileKind('attachments/offer.PDF'), { kind: 'pdf', mime: 'application/pdf' });
  assert.deepEqual(aiFileKind('attachments/voice-1.webm'), { kind: 'audio', mime: 'audio/webm' });
  assert.deepEqual(aiFileKind('attachments/voice-2.ogg'), { kind: 'audio', mime: 'audio/ogg' });
  assert.deepEqual(aiFileKind('attachments/diexar-20261111.m4a'), { kind: 'audio', mime: 'audio/mp4' });
  assert.deepEqual(aiFileKind('attachments/song.mp3'), { kind: 'audio', mime: 'audio/mpeg' });
  // Handwriting from drawings waits (decision 4); a document, an SVG and odd sound formats stay home.
  for (const path of ['attachments/drawing-20261111-101500.png', 'attachments/budget.xlsx', 'attachments/logo.svg', 'attachments/memo.amr', 'attachments/x.flac', 'notes/a.md']) assert.equal(aiFileKind(path), null, path);
});

test('a file kept as base64url goes to the AI service as plain base64', () => {
  assert.equal(plainBase64('-_8'), '+/8=');
  assert.equal(plainBase64('AAEC'), 'AAEC');
  assert.equal(plainBase64('AA'), 'AA==');
  assert.equal(Buffer.from(plainBase64(Buffer.from([251, 255, 0, 1, 2]).toString('base64url')), 'base64').toString('hex'), 'fbff000102');
});

test('the fixed requests for a photo and a recording ask for the text only', () => {
  assert.match(fileRequest('photo'), /handwriting/);
  assert.match(fileRequest('photo'), /only the text/i);
  assert.match(fileRequest('transcribe'), /recording/i);
  assert.throws(() => fileRequest('delete'));
});

test('a receipt becomes lines under the note, only for what is on it', () => {
  assert.equal(receiptLines({ shop: 'MediaMarkt', amount: '499.00', currency: 'EUR', bought: '2026-11-03' }), 'Shop: MediaMarkt\nAmount: 499.00 EUR\nBought: 2026-11-03');
  assert.equal(receiptLines({ amount: '12,50' }), 'Amount: 12,50');
  assert.equal(receiptLines({}), '');
});

test('applying a receipt sets title, lines and expiry in one change; the note keeps its photo and labels', () => {
  const before = '---\njotdrop_labels: ["Home"]\n---\n# Untitled\n\n![[IMG_0042.jpg]]\n';
  const after = receiptApplied(before, { title: 'Washing machine', lines: 'Shop: MediaMarkt\nBought: 2026-11-03', expires: '2028-11-03', drawer: '' });
  const parts = noteSummary(after, 'notes/x.md');
  assert.equal(parts.title, 'Washing machine');
  assert.equal(parts.expires, '2028-11-03');
  assert.deepEqual(parts.labels, ['Home', 'Paper drawer']);
  assert.ok(after.endsWith('![[IMG_0042.jpg]]\n\nShop: MediaMarkt\nBought: 2026-11-03\n'), after);
  // Without a reminder of its own the note gets the usual warning before the date.
  assert.ok(parts.reminder);
  // A small drawer, a note without a title, and no lines.
  const plain = receiptApplied('![[r.pdf]]\n', { title: 'Bike', lines: '', expires: '2027-01-31', drawer: 'Work' });
  assert.equal(noteSummary(plain, 'notes/x.md').title, 'Bike');
  assert.deepEqual(noteSummary(plain, 'notes/x.md').labels, ['Paper drawer/Work']);
  assert.ok(plain.endsWith('# Bike\n\n![[r.pdf]]\n'), plain);
  // An empty title leaves the title as it is; a bad date changes nothing.
  assert.equal(noteSummary(receiptApplied(before, { title: ' ', lines: '', expires: '2028-11-03' }), 'notes/x.md').title, 'Untitled');
  assert.throws(() => receiptApplied(before, { title: 'X', lines: '', expires: '2028-02-30' }));
});

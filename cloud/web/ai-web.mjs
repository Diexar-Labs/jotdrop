// Ask JotDrop in the web app: the notes in the form the shared assistant reads them, and the changes it asks for
// as note text and note properties. Pure functions: app.js saves through its own queue, so a change from the AI is
// an ordinary local edit that syncs encrypted like any other. Nothing here talks to the network.
import { noteSummary, splitNote } from './note.mjs';
import { PROVIDERS } from '../shared/ai/providers.mjs';
import { DEFAULT_WARN, drawerLabel, isPaperDrawer, validExpires, warnReminder, withPaperDrawer } from '../shared/paper.mjs';
import { diffLines } from '../shared/diff.mjs';

// Where the browser keeps the settings: sealed with the workspace key like local labels, never synced.
export const AI_STORE_PATH = 'local/ai.json';

// The providers the page's CSP lets it reach. A free own address cannot be in a CSP, so it is not offered here;
// a local model through Ollama is, first, because nothing leaves the computer.
export const WEB_PROVIDERS = Object.fromEntries(['ollama', 'anthropic', 'openai', 'gemini', 'openrouter'].map((id) => [id, PROVIDERS[id]]));

/** What is stored, cleaned: only known fields, a provider the web app can use, no key for a local model. */
export function aiSettings(stored) {
  const value = stored && typeof stored === 'object' ? stored : {};
  const provider = Object.hasOwn(WEB_PROVIDERS, value.provider) ? value.provider : '';
  if (!provider) return { provider: '', key: '', model: '', includeShared: false };
  return {
    provider,
    key: WEB_PROVIDERS[provider].needsKey ? String(value.key ?? '').trim() : '',
    model: String(value.model ?? '').trim(),
    includeShared: Boolean(value.includeShared),
  };
}

const isNotePath = (path) => /\.md$/i.test(path) && path.startsWith('notes/') && !path.startsWith('notes/Trash/');

/**
 * The notes Ask JotDrop may look at, from [{ id, path, text, modifiedAt, deleted }]: Notes and Archive, as
 * { id, title, text, labels, updatedAt, shared }. text is the note without front matter and title. shared marks a
 * note in a shared group or with a live list link (sharedPaths), which stays home unless the user allows it.
 */
export function aiNotes(entries, { sharedPaths = [], inSpace = false } = {}) {
  const shared = new Set(sharedPaths);
  return entries.filter((entry) => !entry.deleted && isNotePath(entry.path)).map((entry) => {
    const parts = noteSummary(entry.text, entry.path);
    return { id: entry.id, title: parts.title, text: splitNote(entry.text).body, labels: parts.labels, updatedAt: entry.modifiedAt, shared: inSpace || shared.has(entry.path) };
  });
}

const oneLine = (text) => String(text ?? '').replace(/[\r\n]+/g, ' ').trim();
// The AI sometimes writes the checkbox itself; JotDrop writes it once.
const task = (item) => `- [ ] ${oneLine(item).replace(/^(?:[-*]\s*)?\[[ xX]?\]\s*/, '').replace(/^[-*]\s+/, '')}`;

/** A new note in the form the editor writes: front matter for color and label, a title, text, then the checklist. */
export function newNoteText({ title, text, items, color, label }) {
  const front = [];
  if (color && color !== 'default') front.push(`color: ${JSON.stringify(color)}`);
  if (label) front.push(`jotdrop_labels: ${JSON.stringify([label])}`);
  const blocks = [];
  if (String(text ?? '').trim()) blocks.push(String(text).trim());
  if (items?.length) blocks.push(items.map(task).join('\n'));
  return (front.length ? `---\n${front.join('\n')}\n---\n` : '') + `# ${oneLine(title)}\n` + (blocks.length ? `\n${blocks.join('\n\n')}\n` : '');
}

/** The note's file text with text and checklist items added at the end. Items follow a list directly. */
export function appendedText(fileText, { text, items }) {
  const newline = fileText.includes('\r\n') ? '\r\n' : '\n';
  let result = fileText.replace(/(?:\r?\n)+$/, '');
  const add = (block, tight) => {
    const lines = block.split(/\r?\n/).join(newline);
    result = result ? `${result}${tight ? newline : newline + newline}${lines}` : lines;
  };
  if (String(text ?? '').trim()) add(String(text).trim(), false);
  if (items?.length) add(items.map(task).join('\n'), !String(text ?? '').trim() && /(?:^|\n)\s*[-*] \[[ xX]\][^\n]*$/.test(result.replace(/\r/g, '')));
  return result + newline;
}

/** The note's file text with a new text: front matter and title stay. A repeated title heading is dropped. */
export function replacedText(fileText, newText) {
  const { front, title } = splitNote(fileText);
  let body = String(newText).replace(/\r\n/g, '\n').trim();
  const heading = /^#[ \t]+(.*?)[ \t]*(?:\n|$)/.exec(body);
  if (title && heading && heading[1].trim().toLowerCase() === title.trim().toLowerCase()) body = body.slice(heading[0].length).trim();
  return front + (title ? `# ${title}\n\n` : '') + (body ? `${body}\n` : '');
}

/** Labels as the note property, without doubles in another letter case. */
export function labelChanges(labels) {
  const unique = new Map();
  for (const label of labels) { const name = oneLine(label); if (name && !unique.has(name.toLowerCase())) unique.set(name.toLowerCase(), name); }
  return { jotdrop_labels: unique.size ? [...unique.values()] : null };
}

/** A one-time reminder, as the editor's reminder field writes it; a repeat the note had ends. */
export function reminderChanges(at) {
  return { reminder: at, reminder_repeat: null, reminder_until: null, reminder_limit: null, reminder_done: null };
}

/** An expiry date puts the note in the Paper drawer (or one of its drawers); without a reminder it gets the usual warning. */
export function expiryChanges(fileText, date, drawer) {
  const expires = validExpires(date);
  if (!expires) throw new Error('That is not a valid date.');
  const parts = noteSummary(fileText, 'notes/x.md');
  const labels = drawer ? [...parts.labels.filter((label) => !isPaperDrawer(label)), drawerLabel(drawer)] : withPaperDrawer(parts.labels);
  const changes = { expires, jotdrop_labels: labels };
  if (!parts.reminder) Object.assign(changes, reminderChanges(warnReminder(expires, DEFAULT_WARN)));
  return changes;
}

const SIGNS = { same: ' ', added: '+', removed: '-' };
const withSigns = (before, after) => (diffLines(before, after) ?? [...before.split('\n').map((text) => ({ type: 'removed', text })), ...after.split('\n').map((text) => ({ type: 'added', text }))]).map((line) => ({ ...line, sign: SIGNS[line.type] }));
const dateTime = (at) => at.replace('T', ' ');

/**
 * What the confirmation shows for a change: a heading in words, and either lines with + and − (never color alone)
 * or facts as [name, value]. The note is the assistant's { id, title, text, labels }.
 */
export function describeChange({ tool, input, note, newLabels = [] }) {
  const name = `"${note.title}"`;
  const text = note.text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (tool === 'append_to_note') return { heading: `Add to ${name}`, lines: withSigns(text, appendedText(text, input).replace(/\n$/, '')) };
  if (tool === 'replace_note_text') return { heading: `Replace the text of ${name}`, lines: withSigns(text, String(input.text).replace(/\r\n/g, '\n').trim()) };
  if (tool === 'set_labels') {
    const after = labelChanges(input.labels).jotdrop_labels ?? [];
    return { heading: `Set the labels of ${name}`, facts: [['Labels now', note.labels.join(', ') || 'none'], ['Labels after', after.join(', ') || 'none'], ...(newLabels.length ? [['New label', newLabels.join(', ')]] : [])] };
  }
  if (tool === 'set_reminder') return { heading: `Set a reminder on ${name}`, facts: [['Reminder', dateTime(input.at)]] };
  if (tool === 'set_expiry') return { heading: `Set an expiry date on ${name}`, facts: [['Expires', input.date], ['Paper drawer', input.drawer || 'Paper drawer']] };
  return { heading: `Change ${name}`, facts: [] };
}

const EDITOR_REQUESTS = {
  rewrite: (title) => `Rewrite the note "${title}" so it reads clearly: fix spelling and grammar, keep the meaning, the facts and the language. Answer with only the new text of the note, without a title or comments.`,
  checklist: (title) => `Turn the note "${title}" into a checklist of action points, one per line, each starting with "- [ ] ". Answer with only the checklist, without a title or comments.`,
  summarize: (title) => `Summarize the note "${title}" in a few short lines, in the language of the note. Answer with only the summary, without a title or comments.`,
};

/** The fixed request behind an editor or card button. */
export function editorRequest(kind, title) {
  if (!Object.hasOwn(EDITOR_REQUESTS, kind)) throw new Error('Unknown request.');
  return EDITOR_REQUESTS[kind](oneLine(title) || 'Untitled');
}

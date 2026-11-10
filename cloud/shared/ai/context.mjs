// Which notes go with a question, chosen on this device: words from the question (a word counts only from its
// start: "kopen" does not find "verkopen"), a title match counts three times a text match, newest first on a tie. At most 20 notes and 30,000 characters; a long note is cut with
// "[...]". Notes from shared spaces and list links (shared: true) stay home unless the user switches them on;
// notes the user picks go first.
//
// A note here is { id, title, text, labels?, updatedAt?, shared? }, in whatever form the app reads it.

export const MAX_NOTES = 20;
export const MAX_CHARS = 30000;
export const MAX_NOTE_CHARS = 6000;
const MIN_PIECE = 200;
const SNIPPET = 200;
const CUT = '\n[...]';

// Common words in the app's languages that say nothing about which note is meant.
const COMMON = new Set(('the and for what was were who how when where which with from that this have has are you your about did does '
  + 'wat was wie hoe waar wanneer welke met van voor bij het een die dat mijn heb heeft zijn '
  + 'als ook maar niet nog dan naar over wel toch zou zal alle deze dit mij jij wij zij hun onze werd wordt worden geen ' +
  'que qué los las una con por para del como cómo der die das und mit von für ist les des une pour avec est').split(' ').map((word) => fold(word)));

function fold(text) {
  return String(text ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

/** The words of a question that can pick a note: three letters or more, or a number, without common words. */
export function words(question) {
  const found = fold(question).split(/[^\p{L}\p{N}]+/u).filter((word) => (word.length >= 3 || /^\p{N}+$/u.test(word)) && !COMMON.has(word));
  return [...new Set(found)];
}

/**
 * True when the term begins a word of the text: "boodschap" finds "boodschappen", "kopen" does not find
 * "verkopen" (10 Nov 2026). A word begins at the start or after anything that is not a letter or a number.
 * Android's AiContext.kt does the same; ai-vectors.json holds the cases.
 */
function startsWord(haystack, term) {
  for (let at = haystack.indexOf(term); at >= 0; at = haystack.indexOf(term, at + 1)) {
    if (at === 0) return true;
    const before = [...haystack.slice(Math.max(0, at - 2), at)].pop();
    if (!/[\p{L}\p{N}]/u.test(before)) return true;
  }
  return false;
}

function score(note, terms) {
  const title = fold(note.title), text = fold(note.text);
  let total = 0;
  for (const term of terms) total += (startsWord(title, term) ? 3 : 0) + (startsWord(text, term) ? 1 : 0);
  return total;
}

const allowed = (note, includeShared) => includeShared || !note.shared;

function ranked(notes, question, includeShared) {
  const terms = words(question);
  if (!terms.length) return [];
  return notes
    .map((note, index) => ({ note, index, score: allowed(note, includeShared) ? score(note, terms) : 0 }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(b.note.updatedAt ?? '').localeCompare(String(a.note.updatedAt ?? '')) || a.index - b.index)
    .map((entry) => entry.note);
}

/** Cut a text to a length, with the mark that something was left out. */
export function cut(text, length) {
  const value = String(text ?? '');
  return value.length <= length ? { text: value, truncated: false } : { text: value.slice(0, Math.max(0, length - CUT.length)) + CUT, truncated: true };
}

/**
 * The notes to send with a question. Returns { notes: [{ id, title, text, truncated }], chars, left }, where
 * left counts matching notes that did not fit.
 */
export function selectNotes(notes, question, { maxNotes = MAX_NOTES, maxChars = MAX_CHARS, includeShared = false, pinned = [] } = {}) {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const picked = pinned.map((id) => byId.get(id)).filter(Boolean);
  const candidates = [...picked, ...ranked(notes, question, includeShared).filter((note) => !pinned.includes(note.id))];
  const chosen = [];
  let chars = 0;
  for (const note of candidates) {
    const room = Math.min(MAX_NOTE_CHARS, maxChars - chars) - String(note.title ?? '').length;
    if (chosen.length >= maxNotes || room < Math.min(MIN_PIECE, String(note.text ?? '').length)) break;
    const piece = cut(note.text, room);
    chosen.push({ id: note.id, title: String(note.title ?? ''), text: piece.text, truncated: piece.truncated });
    chars += String(note.title ?? '').length + piece.text.length;
  }
  return { notes: chosen, chars, left: candidates.length - chosen.length };
}

/** Search for the assistant's search_notes tool: id, title, the first characters, labels and date. */
export function searchNotes(notes, query, { limit = 10, includeShared = false } = {}) {
  return ranked(notes, query, includeShared).slice(0, limit).map((note) => ({
    id: note.id,
    title: String(note.title ?? ''),
    snippet: cut(String(note.text ?? '').replace(/\s+/g, ' ').trim(), SNIPPET).text,
    labels: note.labels ?? [],
    updatedAt: note.updatedAt ?? null,
  }));
}

const escapeAttribute = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// A note's text cannot open or close a note element of its own.
const escapeBody = (value) => String(value ?? '').replace(/<(\/?)(note)/gi, '&lt;$1$2');

/** Notes as data for the AI: one <note> element each. */
export function formatNotes(notes) {
  return notes.map((note) => `<note id="${escapeAttribute(note.id)}">\nTitle: ${escapeBody(note.title)}\n${escapeBody(note.text)}\n</note>`).join('\n');
}

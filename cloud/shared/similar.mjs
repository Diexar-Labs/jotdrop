// Duplicate notes, found on this device without AI and without a network (Ask JotDrop v2, part E).
//
// A note here is { id, title, text, updatedAt?, shared? }: text is the note without its front matter and title,
// as aiNotes() hands it over. Three kinds of pair:
//   same    the text is equal after folding case and accents and collapsing white space
//   near    at least 0.8 of the word triples of the two notes are shared (Jaccard)
//   inside  not near, but at least 0.9 of the shorter note's triples sit in the other note (a note that was pasted
//           into a longer one). Here the shorter note is the one to offer for the trash, never the longer one:
//           the longer one holds more (Opus check, 13 Nov 2026).
// Not looked at: notes from shared groups or with a live list link (shared: true), notes whose text is shorter
// than 40 characters. The trash is never handed in. Candidates come from an inverted index over the triples, so
// 5000 notes take seconds, and a time limit stops the search with complete: false instead of hanging.
//
// android/.../Similar.kt does the same; similar-vectors.json holds the cases both must pass.

export const MIN_CHARS = 40;
export const NEAR_JACCARD = 0.8;
export const NEAR_CONTAINED = 0.9;
export const TIME_LIMIT_MS = 4000;
const MAX_POSTING = 200; // a triple in more notes than this is too common to pick candidates with
const MAX_PAIRS = 500;
const CANDIDATE_SHARE = 0.5; // a pair must share this part of the shorter note's counted triples before it is measured

const fold = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
export const normalizeText = (text) => fold(text).replace(/\s+/g, ' ').trim();
const wordsOf = (text) => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** The word triples of a normalized text; fewer than three words make one piece of the whole. */
function triples(text) {
  const words = wordsOf(text);
  if (words.length < 3) return new Set([words.join(' ')]);
  const found = new Set();
  for (let i = 0; i + 2 < words.length; i += 1) found.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return found;
}

/** The key under which "Keep both" remembers a pair, the same for either order. */
export const pairKey = (first, second) => [String(first), String(second)].sort().join('\n');

const round2 = (value) => Math.floor(value * 100 + 0.5) / 100;
// Plain code-unit order, not the locale's: Kotlin's compareTo gives the same.
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const KIND_ORDER = { same: 0, near: 1, inside: 2 };

// The older note first, by updatedAt, then by id, so the order never depends on the order of the list.
function older(left, right) {
  const a = String(left.note.updatedAt ?? ''), b = String(right.note.updatedAt ?? '');
  if (a !== b) return a < b ? [left, right] : [right, left];
  return String(left.note.id) <= String(right.note.id) ? [left, right] : [right, left];
}

/**
 * The pairs: [{ a, b, kind: 'same' | 'near' | 'inside', score, drop }] with a the older note's id and b the newer
 * one's; score is 1 for same and otherwise the part of the shorter note's triples that the other note has (two
 * decimals). drop is the note to offer for the trash: the older one, or for inside the shorter one. Same pairs
 * first, then near, then inside, each the highest score first, then the newest. `dismissed` holds pairKey()s the
 * user said to keep.
 * Returns { pairs, complete }: complete is false when the time limit or the 500-pair limit stopped the search.
 */
export function findDuplicates(notes, { dismissed = [], timeLimitMs = TIME_LIMIT_MS, now = Date.now } = {}) {
  const skip = new Set(dismissed);
  const started = now();
  const items = [];
  for (const note of notes) {
    if (note.shared) continue;
    const text = normalizeText(note.text);
    if (text.length >= MIN_CHARS) items.push({ note, text });
  }
  const found = [];
  let complete = true;
  const add = (left, right, kind, score, shorter) => {
    if (skip.has(pairKey(left.note.id, right.note.id))) return;
    if (found.length >= MAX_PAIRS) { complete = false; return; }
    const [first, second] = older(left, right);
    found.push({ a: first.note.id, b: second.note.id, kind, score, drop: (shorter ?? first).note.id, first, second });
  };

  // Equal text: one group each.
  const groups = new Map();
  for (const item of items) groups.set(item.text, [...(groups.get(item.text) ?? []), item]);
  for (const group of groups.values()) for (let i = 0; i < group.length; i += 1) for (let j = i + 1; j < group.length; j += 1) add(group[i], group[j], 'same', 1);

  // Near: only different texts, found through the triples they have in common.
  for (const item of items) item.grams = triples(item.text);
  const postings = new Map();
  items.forEach((item, index) => { for (const gram of item.grams) postings.set(gram, [...(postings.get(gram) ?? []), index]); });
  for (let i = 0; i < items.length && complete; i += 1) {
    if (i % 25 === 0 && now() - started > timeLimitMs) { complete = false; break; }
    const counts = new Map();
    for (const gram of items[i].grams) {
      const list = postings.get(gram);
      if (list.length > MAX_POSTING) continue;
      for (const j of list) if (j > i) counts.set(j, (counts.get(j) ?? 0) + 1);
    }
    for (const [j, counted] of counts) {
      const left = items[i], right = items[j];
      if (left.text === right.text) continue;
      const small = Math.min(left.grams.size, right.grams.size);
      if (counted < small * CANDIDATE_SHARE) continue;
      const [few, many] = left.grams.size <= right.grams.size ? [left.grams, right.grams] : [right.grams, left.grams];
      let shared = 0;
      for (const gram of few) if (many.has(gram)) shared += 1;
      const jaccard = shared / (left.grams.size + right.grams.size - shared);
      const contained = shared / small;
      if (jaccard >= NEAR_JACCARD) add(left, right, 'near', round2(contained));
      else if (contained >= NEAR_CONTAINED) add(left, right, 'inside', round2(contained), left.grams.size <= right.grams.size ? left : right);
    }
  }
  found.sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind]
    || y.score - x.score
    || compare(String(y.second.note.updatedAt ?? ''), String(x.second.note.updatedAt ?? ''))
    || compare(String(x.a), String(y.a)) || compare(String(x.b), String(y.b)));
  return { pairs: found.map(({ a, b, kind, score, drop }) => ({ a, b, kind, score, drop })), complete };
}

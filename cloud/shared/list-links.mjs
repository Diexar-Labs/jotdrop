import { CloudError } from './client.mjs';
import { decryptEnvelope, encryptEnvelope, generateVaultKey, sha256Hex, validId } from './crypto.mjs';

// A list anyone with the link can read and tick, without an account: a copy link that lives. The key is only in
// the part of the address after #, which browsers never send. The server keeps one sealed version with a number;
// whoever writes names the number they read, and the server swaps only when it still holds (409 otherwise). Your
// own devices take over only ticks and new task lines from the link, and put them into your note.
//
// Your devices share one base: the last version an owner wrote, sealed under the vault key in the link's
// ownerEnvelope next to the link's key. Against that base, what the link holds now is what guests did. A device
// brings a link in line only when its note is clean (uploaded) and at least as new as the note the base came from,
// so an edit on one device is never mistaken for a guest's on another.

const listAad = (id) => `jotdrop:list-link:v1:${id}`;
const ownerAad = (vaultId, id) => `jotdrop:list-link-owner:v1:${vaultId}:${id}`;
const encoder = new TextEncoder();
export const LIST_LINK_DAYS = [1, 7, 30, 0];
export const MAX_ITEM_LENGTH = 500;
export const MAX_NAME_LENGTH = 40;
export const DEFAULT_NAME = 'Someone';
const ATTEMPTS = 5;
// A longer changed stretch (base lines times link lines) is not compared: the guest change is then refused as a whole.
const DIFF_CELLS = 4000000;

export const listLinkAddress = (origin, id, key) => `${origin}/l/${id}#${key}`;

/** The list ID and key from an address, or from the page's own location. */
export function readListLinkAddress(address) {
  const match = /\/l\/([0-9a-f-]{36})#([\w-]{43})$/.exec(address);
  if (!match || !validId(match[1])) throw new Error('This link is not complete.');
  return { id: match[1], key: match[2] };
}

/** Proof that a writer has the key. The server only keeps its hash, so the key itself never leaves the link. */
export const writeProof = (key) => sha256Hex(encoder.encode(`jotdrop:list-link-write:v1:${key}`));
const proofHash = async (key) => sha256Hex(encoder.encode(await writeProof(key)));

// Lines: a task line is what the web app, the plugin and Android show as a checkbox.
const TASK = /^(\s*[-*+] \[)([ xX])(\] .*)$/;
const normalize = (text) => String(text).replace(/\r\n?/g, '\n');
const control = /[\x00-\x1f\x7f]/;

/** `{ key, ticked }` for a task line (`key` is the line with the box empty, so a tick does not change it), else null. */
export function taskLine(line) {
  const match = TASK.exec(line);
  return match ? { key: `${match[1]} ${match[3]}`, ticked: match[2] !== ' ' } : null;
}
const setTick = (line, ticked) => line.replace(TASK, (_, before, __, after) => `${before}${ticked ? 'x' : ' '}${after}`);
export const hasChecklist = (text) => normalize(text).split('\n').some((line) => TASK.test(line));

/** A guest's name as it goes into the list: 1 to 40 characters without control characters; empty means "Someone". */
export function guestName(value = '') {
  if (typeof value !== 'string') throw new Error('Enter a name of 1 to 40 characters.');
  const name = value.trim();
  if (!name) return DEFAULT_NAME;
  if (name.length > MAX_NAME_LENGTH || control.test(name)) throw new Error('Enter a name of 1 to 40 characters.');
  return name;
}
const validName = (value) => { try { return guestName(value); } catch { return DEFAULT_NAME; } };

const validItemText = (text) => typeof text === 'string' && text.trim().length > 0 && text.length <= MAX_ITEM_LENGTH && !control.test(text);
/** The line a guest adds: one task line of at most 500 characters. */
export function newItemLine(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!validItemText(value)) throw new Error('An item is 1 to 500 characters on one line.');
  return `- [ ] ${value}`;
}
// A line a guest may have added: any task line whose text would pass as a new item.
const allowedNewLine = (line) => taskLine(line) !== null && validItemText(line.slice(line.indexOf('] ') + 2));

/** Every line with what the page needs: task lines get `key`, `n` (which one of equal lines), `ticked` and the last `mark`. */
export function listLines(text, marks = []) {
  const seen = new Map();
  return normalize(text).split('\n').map((line, index) => {
    const task = taskLine(line);
    if (!task) return { index, line, task: false, text: line };
    const n = seen.get(task.key) ?? 0;
    seen.set(task.key, n + 1);
    const mark = marks.find((item) => item.line === task.key && item.n === n) ?? null;
    return { index, line, task: true, text: line.slice(line.indexOf('] ') + 2), key: task.key, n, ticked: task.ticked, mark };
  });
}

/** The line a guest meant, in a list that may have changed: the same place, else the same one among equal lines, else the nearest. */
export function findLine(lines, { index, key, n }) {
  const same = lines.filter((line) => line.task && line.key === key);
  if (!same.length) return null;
  return same.find((line) => line.index === index) ?? same[n] ?? same.reduce((best, line) => (Math.abs(line.index - index) < Math.abs(best.index - index) ? line : best));
}

/** Marks as read from a link: anything malformed is dropped, an odd name becomes "Someone". */
export function readMarks(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((mark) => mark && typeof mark === 'object' && typeof mark.line === 'string' && mark.line.length <= 10000 && Number.isSafeInteger(mark.n) && mark.n >= 0 && Number.isSafeInteger(mark.at))
    .map((mark) => ({ line: mark.line, n: mark.n, by: validName(mark.by), at: mark.at, added: mark.added === true }));
}

/** Marks that still point at a line of `text`, with `changes` put in place of older marks on the same lines. */
export function updateMarks(marks, text, changes = []) {
  const lines = listLines(text);
  const exists = (mark) => lines.some((line) => line.task && line.key === mark.line && line.n === mark.n);
  const replaced = marks.filter((mark) => !changes.some((change) => change.line === mark.line && change.n === mark.n));
  return [...replaced, ...changes].filter(exists);
}

// The task lines of a text by line and place among equals, so the same item is found again after lines moved.
const same = (line) => `${line.n}\n${line.key}`;
const tasks = (text) => new Map(listLines(text).filter((line) => line.task).map((line) => [same(line), line]));

// Which line of `next` each line of `base` comes back as, by key, or -1. Null when too big to compare.
function align(base, next) {
  let start = 0, baseEnd = base.length, nextEnd = next.length;
  while (start < baseEnd && start < nextEnd && base[start] === next[start]) start++;
  while (baseEnd > start && nextEnd > start && base[baseEnd - 1] === next[nextEnd - 1]) { baseEnd--; nextEnd--; }
  const rows = baseEnd - start, columns = nextEnd - start, width = columns + 1;
  if ((rows + 1) * width > DIFF_CELLS) return null;
  const common = new Int32Array((rows + 1) * width);
  for (let r = rows - 1; r >= 0; r--) for (let c = columns - 1; c >= 0; c--) {
    common[r * width + c] = base[start + r] === next[start + c] ? common[(r + 1) * width + c + 1] + 1 : Math.max(common[(r + 1) * width + c], common[r * width + c + 1]);
  }
  const matchBase = base.map((_, i) => (i < start ? i : i >= baseEnd ? i - base.length + next.length : -1));
  for (let r = 0, c = 0; r < rows && c < columns;) {
    if (base[start + r] === next[start + c]) { matchBase[start + r] = start + c; r++; c++; }
    else if (common[(r + 1) * width + c] >= common[r * width + c + 1]) r++;
    else c++;
  }
  return matchBase;
}

/**
 * What of a guest's version counts: every base line comes back in order, with at most its tick changed, and new lines
 * are task lines a guest could have added. Anything else is put back as it was: changed text (a base line gone and
 * other lines in its place), a removed or moved line, a line that is not a task. The ticks and allowed new lines
 * elsewhere still count. Returns the accepted text.
 */
export function allowedGuestChange(base, next) {
  const baseLines = normalize(base).split('\n'), nextLines = normalize(next).split('\n');
  const key = (line) => taskLine(line)?.key ?? line;
  const matchBase = align(baseLines.map(key), nextLines.map(key));
  if (!matchBase) return baseLines.join('\n');
  const removed = new Map();
  baseLines.forEach((line, i) => { if (matchBase[i] < 0) removed.set(key(line), (removed.get(key(line)) ?? 0) + 1); });
  const result = [];
  let from = 0, fromNext = 0;
  for (let i = 0; i <= baseLines.length; i++) {
    const target = i < baseLines.length ? matchBase[i] : nextLines.length;
    if (target < 0) continue;
    // Between two lines that came back: base lines that did not go back in, and whatever stood in their place does not
    // count. Where nothing was lost, task lines are new, unless a lost line turned up here: that one was moved, not added.
    const lost = baseLines.slice(from, i);
    if (lost.length) result.push(...lost);
    else for (const line of nextLines.slice(fromNext, target)) {
      const moved = removed.get(key(line));
      if (moved) removed.set(key(line), moved - 1);
      else if (allowedNewLine(line)) result.push(line);
    }
    if (i < baseLines.length) result.push(taskLine(baseLines[i]) ? nextLines[target] : baseLines[i]);
    from = i + 1;
    fromNext = target + 1;
  }
  return result.join('\n');
}

/**
 * What guests did between `base` and `accepted`, done to your own text: a tick they changed goes on the same line of
 * yours (a line you removed or rewrote no longer takes it), and a line they added goes in after the task line above
 * it in theirs, or before your first task line, unless your text has it already. So the same change done twice
 * changes nothing the second time, and your own edits stay as they are.
 */
export function applyGuestChanges(base, accepted, mine) {
  const was = tasks(base), theirs = listLines(accepted);
  const lines = normalize(mine).split('\n');
  let own = tasks(lines.join('\n'));
  theirs.forEach((line, i) => {
    if (!line.task) return;
    const old = was.get(same(line)), have = own.get(same(line));
    if (old && have && old.ticked !== line.ticked) { lines[have.index] = setTick(have.line, line.ticked); return; }
    if (old || have) return;
    const above = theirs.slice(0, i).reverse().find((other) => other.task && own.has(same(other)));
    const first = [...own.values()][0];
    let at = above ? own.get(same(above)).index + 1 : first ? first.index : lines.length;
    if (!above && !first) while (at > 0 && lines[at - 1] === '') at--;
    lines.splice(at, 0, line.line);
    own = tasks(lines.join('\n'));
  });
  return lines.join('\n');
}

/**
 * Your note and the link brought together. `base` is the last version an owner wrote to the link (`{ text }`).
 * Guests' ticks and new lines go into your note; what you ticked or added yourself gets a mark under your name,
 * unless a guest already did the same. Text is always LF.
 */
export function reconcile(base, note, link, { ownerName = 'Owner', now = Date.now() } = {}) {
  const mine = normalize(note), old = normalize(base.text), theirs = normalize(link.text);
  const accepted = allowedGuestChange(old, theirs);
  const text = applyGuestChanges(old, accepted, mine);
  const was = tasks(old), guests = tasks(accepted), by = validName(ownerName);
  const own = [...tasks(mine).values()].filter((line) => was.get(same(line))?.ticked !== line.ticked && guests.get(same(line))?.ticked !== line.ticked)
    .map((line) => ({ line: line.key, n: line.n, by, at: now, added: !was.has(same(line)) }));
  const marks = updateMarks(readMarks(link.marks), text, own);
  return { text, marks, noteChanged: text !== mine, linkChanged: text !== theirs };
}

// Talking to the server; `fetcher` stands in for fetch in tests.
const publicCall = async (url, path, { fetcher = globalThis.fetch, minRevision, attempts, ...init } = {}) => {
  const response = await fetcher(`${url}/api/v1/public-lists/${path}`, init);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new CloudError(typeof result.error === 'string' ? result.error : 'This link does not open.', response.status, result.currentRevision), { code: result.code });
  return result;
};
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function fetchList(url, id, options) {
  const { envelope, revision, expiresAt } = await publicCall(url, id, options);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('This link does not open.');
  if (options.minRevision && revision < options.minRevision) throw new Error('The server returned an older version of this list.');
  return { envelope, revision, expiresAt };
}

/** The sealed list opened with the key. The number inside must be the number the server gave: an old version cannot pass as new. */
async function unseal(key, id, fetched) {
  const payload = await decryptEnvelope(key, JSON.parse(fetched.envelope), listAad(id));
  if (payload.v !== 1 || payload.revision !== fetched.revision || typeof payload.title !== 'string' || typeof payload.text !== 'string') throw new Error('This list does not match its version.');
  const text = normalize(payload.text), marks = updateMarks(readMarks(payload.marks), text);
  return { title: payload.title, text, marks, revision: fetched.revision, expiresAt: fetched.expiresAt, lines: listLines(text, marks) };
}

const sealList = (key, id, { revision, title, text, marks }) => encryptEnvelope(key, { v: 1, revision, title, text, marks }, listAad(id)).then(JSON.stringify);

async function putList(url, id, key, { revision, title, text, marks }, options) {
  const envelope = await sealList(key, id, { revision: revision + 1, title, text, marks });
  return publicCall(url, id, { ...options, ...json('PUT', { envelope, baseRevision: revision, writeProof: await writeProof(key) }) });
}

/** No account needed. Throws with status 404 or 410 when the link has ended; `minRevision` refuses a replayed older version. */
export async function openList(url, id, key, options = {}) {
  return unseal(key, id, await fetchList(url, id, options));
}

// A guest's change, tried again on the newest version when someone else wrote first (409).
async function changeList(url, id, key, list, change, options) {
  for (let attempt = 0; ; attempt++) {
    const next = change(list);
    if (!next) return list;
    try {
      const { revision } = await putList(url, id, key, { revision: list.revision, title: list.title, ...next }, options);
      return { ...list, revision, text: next.text, marks: next.marks, lines: listLines(next.text, next.marks) };
    } catch (error) {
      if (error.status !== 409 || attempt >= (options.attempts ?? ATTEMPTS) - 1) throw error;
      list = await openList(url, id, key, { ...options, minRevision: list.revision });
    }
  }
}

/** Tick or untick one line of an opened `list`; `item` is one of its `lines`. Returns the list as it is now. */
export async function tickItem(url, id, key, list, item, ticked, { name, now = Date.now(), ...options } = {}) {
  const by = guestName(name);
  return changeList(url, id, key, list, (current) => {
    const line = findLine(current.lines, item);
    if (!line) throw new Error('This item is no longer in the list.');
    if (line.ticked === ticked) return null;
    const lines = current.text.split('\n');
    lines[line.index] = setTick(line.line, ticked);
    const text = lines.join('\n');
    return { text, marks: updateMarks(current.marks, text, [{ line: line.key, n: line.n, by, at: now, added: false }]) };
  }, options);
}

/** Add one task line under the last one of an opened `list` (under the text when it has none). Returns the list as it is now. */
export async function addItem(url, id, key, list, itemText, { name, now = Date.now(), ...options } = {}) {
  const line = newItemLine(itemText), by = guestName(name);
  return changeList(url, id, key, list, (current) => {
    const lines = current.text.split('\n');
    let at = lines.findLastIndex((other) => TASK.test(other)) + 1;
    if (!at) { at = lines.length; while (at > 0 && lines[at - 1] === '') at--; }
    lines.splice(at, 0, line);
    const text = lines.join('\n'), added = listLines(text)[at];
    return { text, marks: updateMarks(current.marks, text, [{ line: added.key, n: added.n, by, at: now, added: true }]) };
  }, options);
}

export const reportList = (url, id, report, options = {}) => publicCall(url, `${id}/report`, { ...options, ...json('POST', report) });

// Your side, with an account. The base travels in the ownerEnvelope: `{ key, title, path, base: { revision, noteRevision, text } }`.

const ownerEnvelope = (client, id, mine) => encryptEnvelope(client.credentials.vaultKey, mine, ownerAad(client.credentials.vaultId, id)).then(JSON.stringify);
const validBase = (base) => base && Number.isSafeInteger(base.revision) && base.revision >= 1 && Number.isSafeInteger(base.noteRevision) && typeof base.text === 'string';

/**
 * `days` 0 means until it is removed. `path` is the note's path and `noteRevision` the number of its uploaded version,
 * so each of your devices knows which note the link belongs to and whether it has that version yet.
 */
export async function createListLink(client, note, { origin, days = 7, path, noteRevision }) {
  if (!hasChecklist(note.text)) throw new Error('This note has no checklist.');
  if (!Number.isSafeInteger(noteRevision)) throw new Error('Upload the note before sharing it.');
  const id = crypto.randomUUID(), key = generateVaultKey(), text = normalize(note.text), base = { revision: 1, noteRevision, text };
  const made = await client.call('/list-links', 'POST', {
    id, days,
    envelope: await sealList(key, id, { revision: 1, title: note.title, text, marks: [] }),
    ownerEnvelope: await ownerEnvelope(client, id, { key, title: note.title, path, base }),
    writeProofHash: await proofHash(key),
  });
  return { id, key, revision: 1, expiresAt: made.expiresAt, address: listLinkAddress(origin, id, key), title: note.title, path, base };
}

/** Your list links as the server has them now; `key`, `path` and `base` are null when the owner envelope does not open. */
export async function listListLinks(client, origin = client.credentials.url) {
  const { vaultId, vaultKey } = client.credentials;
  const { links } = await client.call('/list-links');
  return Promise.all(links.map(async (link) => {
    const mine = await decryptEnvelope(vaultKey, JSON.parse(link.ownerEnvelope), ownerAad(vaultId, link.id)).catch(() => null);
    const usable = mine && validBase(mine.base);
    return { id: link.id, revision: link.revision, updatedAt: link.updatedAt, expiresAt: link.expiresAt, title: mine?.title ?? '', path: usable ? mine.path : null, key: usable ? mine.key : null, base: usable ? mine.base : null, address: usable ? listLinkAddress(origin, link.id, mine.key) : null };
  }));
}

export const removeListLink = (client, id) => client.call(`/list-links/${id}`, 'DELETE');

/**
 * One check of one of your links (an item from `listListLinks`), with the note clean: `note` is its uploaded text and
 * `noteRevision` that version's number. A device whose note is older than the base's waits for its own sync first.
 * Guests' ticks and new lines come back as `text` with `noteChanged`: save and upload it, and the next check carries
 * it to the base. Once the note and the base agree, your own changes go into the link. A sealed version that does
 * not open, or does not match its number, counts as nothing new and is written over.
 */
export async function syncList(client, link, { note, noteRevision, title = link.title, ownerName, now, ...options }) {
  const { url } = client.credentials, mine = normalize(note), quiet = { text: mine, marks: null, noteChanged: false, linkChanged: false, revision: link.revision };
  if (!link.key) throw new Error('This link cannot be opened on this device.');
  if (!Number.isSafeInteger(noteRevision)) throw new Error('Upload the note before checking its link.');
  if (noteRevision < link.base.noteRevision) return { ...quiet, skipped: true };
  if (link.revision === link.base.revision && mine === normalize(link.base.text) && title === link.title) return quiet;
  for (let attempt = 0; ; attempt++) {
    const fetched = await fetchList(url, link.id, { ...options, minRevision: link.base.revision });
    const opened = await unseal(link.key, link.id, fetched).catch(() => null);
    const result = reconcile(link.base, mine, opened ?? { text: link.base.text, marks: [] }, { ownerName, now });
    if (result.noteChanged) return { ...result, linkChanged: false, revision: fetched.revision };
    const write = !opened || result.linkChanged || title !== opened.title;
    const base = { revision: fetched.revision + (write ? 1 : 0), noteRevision, text: mine };
    try {
      const { revision } = await client.call(`/list-links/${link.id}`, 'PUT', {
        baseRevision: fetched.revision,
        ...(write ? { envelope: await sealList(link.key, link.id, { revision: base.revision, title, text: mine, marks: result.marks }) } : {}),
        ownerEnvelope: await ownerEnvelope(client, link.id, { key: link.key, title, path: link.path, base }),
      });
      return { ...result, linkChanged: write, revision };
    } catch (error) {
      if (error.status !== 409 || attempt >= (options.attempts ?? ATTEMPTS) - 1) throw error;
    }
  }
}

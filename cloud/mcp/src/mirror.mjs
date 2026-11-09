// The user's notes, decrypted in memory only. Kept up to date from the cloud's changes feed, so each refresh reads
// only what changed. On disk there is one cache file, sealed whole under the vault key (paths too, because a file
// name holds the first words of a note): no plain text of a note ever lands on disk.
//
// Notes here are the Markdown files under notes/, without notes/Trash/ and without shared-space folders
// (notes/Shared/<uuid>/). Attachments and other files are known by path only, so a new note never takes their name.
import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { decryptEnvelope, encryptEnvelope, isSpacePath, MAX_FILE_BYTES } from '../../shared/crypto.mjs';
import { noteSummary, splitNote } from '../../web/note.mjs';
import { writePrivate } from './store.mjs';

const decoder = new TextDecoder('utf-8', { fatal: true });
const aad = (vaultId) => `jotdrop:mcp-cache:v1:${vaultId}`;

/** True for a path that is one of the user's own notes the agent may see. */
export const isMirrored = (path) => /^notes\/.+\.md$/i.test(path) && !/^notes\/Trash\//i.test(path) && !isSpacePath(path);

/** What the tools need of one note. `id` is its path in the vault. */
export function noteView(path, text, { revision, updatedAt }) {
  const summary = noteSummary(text, path), parts = splitNote(text);
  return { id: path, title: parts.title || summary.title, body: parts.body, text, labels: summary.labels, color: summary.color, archived: /^notes\/Archive\//i.test(path), updatedAt, revision };
}

export class Mirror {
  constructor({ client, cachePath }) {
    this.client = client;
    this.cachePath = cachePath;
    this.clear();
  }

  clear() {
    // objects: id -> { path, revision, deleted }; notes: id -> noteView.
    this.index = { cursor: 0, objects: {}, pending: {} };
    this.byId = new Map();
    this.lastSync = null;
  }

  /** Starts from the sealed cache; false when there is none or it does not open with this vault's key. */
  async load() {
    let sealed;
    try { sealed = JSON.parse(await readFile(this.cachePath, 'utf8')); } catch { return false; }
    try {
      const { vaultKey, vaultId } = this.client.credentials;
      const value = await decryptEnvelope(vaultKey, sealed?.envelope, aad(vaultId));
      if (value?.v !== 1 || !Number.isSafeInteger(value.cursor) || !value.objects || !Array.isArray(value.notes)) return false;
      this.index = { cursor: value.cursor, objects: value.objects, pending: value.pending ?? {} };
      this.byId = new Map(value.notes.map(([id, note]) => [id, note]));
      this.lastSync = value.lastSync ?? null;
      this.saved = true;
      return true;
    } catch {
      this.clear();
      return false;
    }
  }

  async save() {
    const { vaultKey, vaultId } = this.client.credentials;
    const value = { v: 1, ...this.index, notes: [...this.byId], lastSync: this.lastSync };
    await writePrivate(dirname(this.cachePath), this.cachePath, JSON.stringify({ v: 1, envelope: await encryptEnvelope(vaultKey, value, aad(vaultId)) }));
  }

  /** Reads what changed since the last refresh. Returns how many files changed. */
  async refresh() {
    const { index } = this;
    for (let more = true; more;) {
      const page = await this.client.listChanges(index.cursor);
      for (const change of page.changes) {
        if (index.objects[change.id]?.revision === change.revision) delete index.pending[change.id];
        else index.pending[change.id] = change.revision;
      }
      if (page.hasMore && page.cursor <= index.cursor) throw new Error('Invalid cloud changes cursor.');
      index.cursor = page.cursor;
      more = page.hasMore;
    }
    const waiting = Object.keys(index.pending);
    for (const id of waiting) await this.fetch(id);
    this.lastSync = new Date().toISOString();
    if (waiting.length || !this.saved) { await this.save(); this.saved = true; }
    return { changed: waiting.length };
  }

  async fetch(id) {
    const { index } = this;
    let entry;
    try { entry = await this.client.readManifest(id); }
    catch (error) {
      // Cleared from the cloud (a free plan's trash after 30 days): gone here too.
      if (error.status === 404) { delete index.objects[id]; this.byId.delete(id); delete index.pending[id]; return; }
      // A file that does not open (no cloud status, not the network) is left out; one bad file stops nothing.
      if (error.status === undefined && !(error instanceof TypeError) && !['AbortError', 'TimeoutError'].includes(error.name)) { delete index.pending[id]; return; }
      throw error;
    }
    const { manifest } = entry, path = manifest.path;
    index.objects[id] = { path, revision: entry.revision, deleted: Boolean(entry.deleted) };
    delete index.pending[id];
    if (entry.deleted || !isMirrored(path) || manifest.size > MAX_FILE_BYTES) { this.byId.delete(id); return; }
    let text;
    try { text = decoder.decode(await this.client.readPieces(id, manifest)); }
    catch (error) { if (error.status !== undefined || error instanceof TypeError) throw error; this.byId.delete(id); return; }
    this.byId.set(id, noteView(path, text, { revision: entry.revision, updatedAt: manifest.modifiedAt }));
  }

  /** After this device saved a note: the mirror has it at once, and the changes feed will not read it again. */
  async remember(objectId, path, text, saved, modifiedAt) {
    this.index.objects[objectId] = { path, revision: saved.revision, deleted: false };
    this.byId.set(objectId, noteView(path, text, { revision: saved.revision, updatedAt: modifiedAt }));
    await this.save();
  }

  notes() { return [...this.byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); }
  get(path) { return this.notes().find((note) => note.id === path); }
  objectIdOf(path) { for (const [id, note] of this.byId) if (note.id === path) return id; }
  /** Every path the vault knows, deleted ones and attachments too. */
  knownPaths() { return new Set(Object.values(this.index.objects).map((object) => object.path)); }

  /** Drops the notes from memory and the cache from disk, for a device the cloud no longer accepts. */
  async forget() {
    this.clear();
    this.saved = false;
    await rm(this.cachePath, { force: true });
  }
}

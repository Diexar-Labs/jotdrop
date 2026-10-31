import { bytesToBase64, isSpacePath, MAX_FILE_BYTES, normalizePath } from './crypto.mjs';
import { mergeNote } from './merge.mjs';

// Two-way sync of a local notes folder, the same rules as Android's CloudSyncEngine.
// No limit on the number of files or their total size: one file at a time is in memory; the cloud plan sets the storage.
// Cloud files read while listing stay in memory up to this much, so a first sync does not download them twice.
export const KEPT_BYTES = 16 * 1024 * 1024;
// Progress is saved at least this often; a sync cut off in between redoes no upload or download twice.
const SAVE_EVERY_MS = 1000;
// Notes up to this size merge when two devices changed different parts; bigger ones keep both versions.
export const MERGE_BYTES = 1024 * 1024;

export const hash = async (bytes) => bytesToBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
// A manifest's fingerprint is hex; saved baselines keep the base64 form.
export const fromHex = (value) => bytesToBase64(new Uint8Array(value.match(/../g).map((pair) => parseInt(pair, 16))));
export const isPreserved = (name) => name.includes('.cloud-conflict-') || name.includes('.cloud-recovery-');

export function syncPath(value, allowPreserved = false) {
  normalizePath(value);
  if (!value.startsWith('notes/') && !value.startsWith('attachments/')) throw new Error('File is outside the cloud note and attachment folders');
  if (value.split('/').some((part) => part.startsWith('.') || (!allowPreserved && isPreserved(part)))) throw new Error('Cloud sync does not accept hidden or preserved-copy paths');
  if (value.startsWith('notes/') && !/\.md$/i.test(value)) throw new Error('Cloud notes must be Markdown files');
  return value;
}

export function copyName(path, suffix) {
  const dot = path.lastIndexOf('.');
  return dot > path.lastIndexOf('/') ? `${path.slice(0, dot)}${suffix}${path.slice(dot)}` : `${path}${suffix}`;
}

/**
 * Reconcile only against acknowledged baselines, never timestamps or missing remote entries.
 * remote.list() gives `{ path, revision, deleted, hash, bytes() }`; write/delete give the acknowledged object;
 * the optional remote.base(path, revision) gives that older version's bytes, or null when the cloud no longer has it.
 * local.list() gives a Map of path to `{ size, modified }` without reading files; local.read(path) gives the bytes;
 * compareAndSet(path, expected, replacement) uses null for "no file".
 * `seen` keeps each local file's hash by size and modification time, so a sync reads only files that changed.
 * Baselines are saved at least every second and at the end: every step is safe to repeat after a cut-off sync.
 * Files over `maxFileBytes` (the plan's maximum per file) are left alone and come back in `skipped`.
 */
export async function syncFolder(remote, local, tracked, persist, { checkActive = () => {}, seen = {}, progress = (done, total) => {}, maxFileBytes = MAX_FILE_BYTES } = {}) {
  checkActive();
  const result = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, skipped: [] };
  const files = new Map([...await local.list()].filter(([name]) => !isSpacePath(name)));
  const entries = (await remote.list()).filter((entry) => !isSpacePath(entry.path));
  for (const name of Object.keys(tracked)) if (isSpacePath(name)) delete tracked[name];
  const clouds = new Map();
  for (const entry of entries) {
    if (clouds.has(syncPath(entry.path))) throw new Error('Duplicate encrypted cloud paths');
    if (!Number.isSafeInteger(entry.revision) || entry.revision < 1) throw new Error('Invalid cloud file or revision');
    clouds.set(entry.path, entry);
  }
  for (const [name, stat] of files) {
    syncPath(name);
    // Too big for one cloud file: it stays on this device as it is, nothing about it changes anywhere, the rest syncs.
    if (stat.size > maxFileBytes) result.skipped.push(name);
  }
  result.skipped.sort();
  for (const name of Object.keys(seen)) if (!files.has(name)) delete seen[name];
  // A full free cloud clears notes that sat in the trash for 30 days; then the name can start over at revision 1.
  const cleared = Object.entries(tracked).filter(([name, base]) => base.deleted && (clouds.get(name)?.revision ?? 0) < base.revision).map(([name]) => name);
  for (const [name, base] of Object.entries(tracked)) {
    syncPath(name);
    if (!Number.isSafeInteger(base.revision) || base.revision < 1 || typeof base.hash !== 'string') throw new Error('Invalid saved cloud baseline');
    if (cleared.includes(name)) continue;
    if (!clouds.has(name)) throw new Error('A tracked cloud object disappeared. Local files were kept');
    if (clouds.get(name).revision < base.revision) throw new Error('Cloud history moved backwards. Local files were kept');
  }
  // Decisions read `next`; `tracked` follows only once `next` is saved.
  const next = { ...tracked };
  let dirty = false, savedAt = Date.now();
  const flush = async () => {
    if (!dirty) return;
    const saved = { ...next };
    await persist(saved);
    dirty = false;
    savedAt = Date.now();
    for (const key of Object.keys(tracked)) delete tracked[key];
    Object.assign(tracked, saved);
  };
  const remember = async (entry) => {
    next[entry.path] = { revision: entry.revision, hash: entry.hash, deleted: entry.deleted };
    dirty = true;
    if (Date.now() - savedAt >= SAVE_EVERY_MS) await flush();
  };
  for (const name of cleared) { delete next[name]; dirty = true; }
  await flush();
  const conflict = async (entry, bytes) => {
    result.conflicts++;
    await local.conflict(entry.path, entry.revision, bytes ?? await entry.bytes());
  };
  const written = (saved, name, revision, bytesHash) => {
    if (saved.path !== name || saved.deleted || saved.hash !== bytesHash || saved.revision !== revision) throw new Error('Invalid cloud write acknowledgment');
    return saved;
  };
  const upload = async (name, bytes, baseRevision) => {
    bytes ??= await local.read(name);
    await remember(written(await remote.write(name, bytes, baseRevision), name, baseRevision + 1, await hash(bytes)));
    result.uploaded++;
  };
  // The hash of a local file, read only when its size or time changed (or is unknown); the bytes come along only when just read.
  const scan = async (name) => {
    const stat = files.get(name), known = seen[name];
    if (known && stat.size >= 0 && stat.modified > 0 && known.size === stat.size && known.modified === stat.modified) return { localHash: known.hash, bytes: null };
    const bytes = await local.read(name);
    const localHash = await hash(bytes);
    seen[name] = { size: stat.size, modified: stat.modified, hash: localHash };
    return { localHash, bytes };
  };
  // The file as the decision saw it, or null when it changed or went away since; then nothing local is replaced.
  const unchanged = async (name, localHash, bytes) => {
    if (bytes) return bytes;
    try { bytes = await local.read(name); } catch { return null; }
    return await hash(bytes) === localHash ? bytes : null;
  };
  const replace = async (entry, expected, replacement) => expected && await local.compareAndSet(entry.path, expected, replacement);
  // Both sides changed a note. When the changes do not overlap, measured against the version both last shared
  // (from the cloud's history, when it can still be read), one merged note goes both ways instead of a copy.
  const merge = async (entry, base, localHash, bytes, theirs) => {
    const mine = await unchanged(entry.path, localHash, bytes);
    if (!mine || mine.length > MERGE_BYTES || theirs.length > MERGE_BYTES) return false;
    let old = base && !base.deleted && remote.base ? await remote.base(entry.path, base.revision) : null;
    if (old && await hash(old) !== base.hash) old = null;
    const note = mergeNote(old, mine, theirs);
    if (!note) return false;
    const noteHash = await hash(note);
    if (noteHash === entry.hash) {
      if (!await local.compareAndSet(entry.path, mine, note)) return false;
      await remember(entry);
      result.downloaded++;
      return true;
    }
    if (noteHash !== localHash && !await local.compareAndSet(entry.path, mine, note)) return false;
    await upload(entry.path, note, entry.revision);
    return true;
  };
  const removals = [];
  // Upload/download destinations before removing sources of archive/trash moves.
  const names = [...new Set([...files.keys(), ...clouds.keys()])].filter((name) => !result.skipped.includes(name)).sort((a, b) => Number(!a.startsWith('attachments/')) - Number(!b.startsWith('attachments/')) || (a < b ? -1 : a > b ? 1 : 0));
  try {
    for (const [done, name] of names.entries()) {
      checkActive();
      progress(done, names.length);
      const entry = clouds.get(name), base = next[name];
      const { localHash, bytes } = files.has(name) ? await scan(name) : { localHash: null, bytes: null };
      if (!entry) {
        if (base) throw new Error('A tracked cloud object disappeared. Local files were kept');
        if (localHash) await upload(name, bytes, 0);
        continue;
      }
      if (entry.deleted) {
        if (!localHash) await remember(entry);
        else if (base?.deleted) await upload(name, bytes, entry.revision);
        else if (base && base.hash === localHash) removals.push(async () => {
          if (await replace(entry, await unchanged(name, localHash), null)) { await remember(entry); result.deleted++; }
          else await conflict(entry);
        });
        else await conflict(entry);
        continue;
      }
      if (!localHash) {
        if (!base || base.deleted) {
          if (await local.compareAndSet(name, null, await entry.bytes())) { await remember(entry); result.downloaded++; }
          else await conflict(entry);
        } else if (base.revision === entry.revision && base.hash === entry.hash) removals.push(async () => {
          if (!await local.compareAndSet(name, null, null)) { await conflict(entry); return; }
          const saved = await remote.delete(name, entry.revision);
          if (saved.path !== name || !saved.deleted || saved.revision !== entry.revision + 1) throw new Error('Invalid cloud delete acknowledgment');
          await remember(saved);
          result.deleted++;
        });
        else await conflict(entry);
        continue;
      }
      if (localHash === entry.hash) await remember(entry);
      else if (base && !base.deleted && base.hash === localHash && base.revision !== entry.revision) {
        if (await replace(entry, await unchanged(name, localHash, bytes), await entry.bytes())) { await remember(entry); result.downloaded++; }
        else await conflict(entry);
      } else if (base && !base.deleted && base.revision === entry.revision && base.hash === entry.hash) await upload(name, bytes, entry.revision);
      else {
        const theirs = name.startsWith('notes/') ? await entry.bytes() : null;
        if (!theirs || !await merge(entry, base, localHash, bytes, theirs)) await conflict(entry, theirs);
      }
    }
    for (const removal of removals) { checkActive(); await removal(); }
    progress(names.length, names.length);
  } catch (error) {
    // Keep what was done; the error that stopped the sync is the one to report.
    await flush().catch(() => {});
    throw error;
  }
  await flush();
  return result;
}

/**
 * The cloud side for syncFolder, kept up to date from the changes feed so a sync only reads what changed.
 * `index` is `{ cursor, objects: { [id]: { path, revision, deleted, hash } }, pending: { [id]: revision } }` and is
 * updated in place; `save` keeps it, so a first sync cut off halfway goes on from where it was.
 */
export async function remoteFiles(client, index, { checkActive = () => {}, save = async () => {}, progress = (done, total) => {} } = {}) {
  index.pending ??= {};
  for (let more = true; more;) {
    checkActive();
    const page = await client.listChanges(index.cursor);
    for (const change of page.changes) {
      if (index.objects[change.id]?.revision === change.revision) delete index.pending[change.id];
      else index.pending[change.id] = change.revision;
    }
    if (page.hasMore && page.cursor <= index.cursor) throw new Error('Invalid cloud changes cursor');
    index.cursor = page.cursor;
    more = page.hasMore;
  }
  await save();
  const loaded = new Map(), waiting = Object.keys(index.pending);
  let kept = 0, savedAt = Date.now();
  try {
    for (const [done, id] of waiting.entries()) {
      checkActive();
      progress(done, waiting.length);
      let entry;
      // The manifest is enough to compare; pieces are downloaded only for a file that is missing or different here.
      // A file cleared from a full free cloud after 30 days in the trash stays in the feed but reads as 404.
      try { entry = await client.readManifest(id); }
      catch (error) { if (error.status !== 404) throw error; delete index.objects[id]; delete index.pending[id]; continue; }
      const { manifest } = entry;
      index.objects[id] = { path: syncPath(manifest.path), revision: entry.revision, deleted: Boolean(entry.deleted), hash: fromHex(manifest.hash) };
      delete index.pending[id];
      if (manifest.bytes && kept + manifest.size <= KEPT_BYTES) { loaded.set(id, manifest.bytes); kept += manifest.size; }
      if (Date.now() - savedAt >= SAVE_EVERY_MS) { await save(); savedAt = Date.now(); }
    }
  } catch (error) {
    await save().catch(() => {});
    throw error;
  }
  if (waiting.length) await save();
  return Object.entries(index.objects).map(([id, object]) => ({ ...object, bytes: async () => {
    if (loaded.has(id)) { const bytes = loaded.get(id); loaded.delete(id); return bytes; }
    // The current version, not `?revision=`: the free plan locks older versions, never the newest.
    const entry = await client.readManifest(id);
    if (entry.revision !== object.revision || entry.manifest.path !== object.path || fromHex(entry.manifest.hash) !== object.hash) throw new Error('Cloud file changed during sync. Local files were kept');
    return client.readPieces(id, entry.manifest);
  } }));
}


/** The original of a ".cloud-conflict" copy made by copyName, or null for any other path. */
export function conflictOriginal(path) {
  const match = /^(.*)\.cloud-conflict-r\d+(?:-[0-9a-f-]{36})?(\.[^./]*)?$/.exec(path);
  return match ? `${match[1]}${match[2] ?? ''}` : null;
}

/**
 * The time machine, the same rules as Android's CloudTimeMachine: one walk over the changes feed gives
 * the steps (the last change time of each minute with a change, oldest first) and each file as it is now.
 */
export async function cloudTimeline(client, checkActive = () => {}) {
  const minutes = new Map(), current = new Map();
  for (let cursor = 0, more = true; more;) {
    checkActive();
    const page = await client.listChanges(cursor);
    for (const change of page.changes) {
      const minute = change.updatedAt.slice(0, 16);
      if (!(minutes.get(minute) > change.updatedAt)) minutes.set(minute, change.updatedAt);
      current.set(change.id, { id: change.id, revision: change.revision, deleted: Boolean(change.deleted) });
    }
    if (page.hasMore && page.cursor <= cursor) throw new Error('Invalid cloud changes cursor');
    cursor = page.cursor;
    more = page.hasMore;
  }
  return { steps: [...minutes.values()].sort(), current: [...current.values()] };
}

/** Files from then that the free plan cannot open or that were cleared; a moment comes back whole or not at all. */
export function unavailable(current, then) {
  const revisions = new Map(current.map((file) => [file.id, file.revision]));
  return then.filter((file) => (file.locked || file.cleared) && revisions.get(file.id) !== file.revision);
}

/** Files from then come back as new versions, files made later move to the trash; nothing is erased. */
export function restorePlan(current, then) {
  if (unavailable(current, then).length) throw new Error('JotDrop Plus restores this moment.');
  const old = new Map(then.map((file) => [file.id, file]));
  return current.flatMap((file) => {
    const version = old.get(file.id);
    if (version?.revision === file.revision) return [];
    if (!version || version.deleted) return file.deleted ? [] : [{ id: file.id, delete: true, baseRevision: file.revision }];
    return [{ id: file.id, revision: version.revision, baseRevision: file.revision }];
  });
}

import { base64ToBytes, bytesToBase64, MAX_FILE_BYTES, normalizePath } from './crypto.mjs';

// Two-way sync of a local notes folder, the same rules as Android's CloudSyncEngine.
export const MAX_SYNC_FILES = 500;
export const MAX_SYNC_BYTES = 64 * 1024 * 1024;

export const hash = async (bytes) => bytesToBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
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
 * remote.list() gives `{ path, revision, deleted, hash, bytes() }`; write/delete give the acknowledged object.
 * local.list() gives a Map of path to bytes; compareAndSet(path, expected, replacement) uses null for "no file".
 */
export async function syncFolder(remote, local, tracked, persist, checkActive = () => {}) {
  checkActive();
  const result = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0 };
  const files = await local.list();
  const entries = await remote.list();
  if (files.size > MAX_SYNC_FILES || entries.length > MAX_SYNC_FILES || Object.keys(tracked).length > MAX_SYNC_FILES) throw new Error(`Cloud sync supports at most ${MAX_SYNC_FILES} files`);
  const clouds = new Map();
  for (const entry of entries) {
    if (clouds.has(syncPath(entry.path))) throw new Error('Duplicate encrypted cloud paths');
    if (!Number.isSafeInteger(entry.revision) || entry.revision < 1) throw new Error('Invalid cloud file or revision');
    clouds.set(entry.path, entry);
  }
  if (new Set([...files.keys(), ...clouds.keys()]).size > MAX_SYNC_FILES) throw new Error(`Cloud sync supports at most ${MAX_SYNC_FILES} distinct files`);
  let total = 0;
  const hashes = new Map();
  for (const [name, bytes] of files) {
    syncPath(name);
    if (bytes.length > MAX_FILE_BYTES) throw new Error('Cloud files must be 4 MiB or smaller');
    total += bytes.length;
    hashes.set(name, await hash(bytes));
  }
  // ponytail: bounded snapshot sync; use a streaming indexed journal for larger vaults.
  if (total > MAX_SYNC_BYTES) throw new Error('Cloud sync working set exceeds 64 MiB');
  // A full free cloud clears notes that sat in the trash for 30 days; then the name can start over at revision 1.
  const cleared = Object.entries(tracked).filter(([name, base]) => base.deleted && (clouds.get(name)?.revision ?? 0) < base.revision).map(([name]) => name);
  for (const [name, base] of Object.entries(tracked)) {
    syncPath(name);
    if (!Number.isSafeInteger(base.revision) || base.revision < 1 || typeof base.hash !== 'string') throw new Error('Invalid saved cloud baseline');
    if (cleared.includes(name)) continue;
    if (!clouds.has(name)) throw new Error('A tracked cloud object disappeared. Local files were kept');
    if (clouds.get(name).revision < base.revision) throw new Error('Cloud history moved backwards. Local files were kept');
  }
  const save = async (next) => {
    await persist(next);
    for (const key of Object.keys(tracked)) delete tracked[key];
    Object.assign(tracked, next);
  };
  if (cleared.length) await save(Object.fromEntries(Object.entries(tracked).filter(([name]) => !cleared.includes(name))));
  const remember = (entry) => save({ ...tracked, [entry.path]: { revision: entry.revision, hash: entry.hash, deleted: entry.deleted } });
  const conflict = async (entry) => {
    result.conflicts++;
    await local.conflict(entry.path, entry.revision, await entry.bytes());
  };
  const written = (saved, name, revision, bytesHash) => {
    if (saved.path !== name || saved.deleted || saved.hash !== bytesHash || saved.revision !== revision) throw new Error('Invalid cloud write acknowledgment');
    return saved;
  };
  const removals = [];
  // Upload/download destinations before removing sources of archive/trash moves.
  const names = [...new Set([...files.keys(), ...clouds.keys()])].sort((a, b) => Number(!a.startsWith('attachments/')) - Number(!b.startsWith('attachments/')) || (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    checkActive();
    const bytes = files.get(name), localHash = hashes.get(name), entry = clouds.get(name), base = tracked[name];
    if (!entry) {
      if (base) throw new Error('A tracked cloud object disappeared. Local files were kept');
      if (bytes) {
        await remember(written(await remote.write(name, bytes, 0), name, 1, localHash));
        result.uploaded++;
      }
      continue;
    }
    if (entry.deleted) {
      if (!bytes) await remember(entry);
      else if (base?.deleted) {
        await remember(written(await remote.write(name, bytes, entry.revision), name, entry.revision + 1, localHash));
        result.uploaded++;
      } else if (base && base.hash === localHash) removals.push(async () => {
        if (await local.compareAndSet(name, bytes, null)) { await remember(entry); result.deleted++; }
        else await conflict(entry);
      });
      else await conflict(entry);
      continue;
    }
    if (!bytes) {
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
      if (await local.compareAndSet(name, bytes, await entry.bytes())) { await remember(entry); result.downloaded++; }
      else await conflict(entry);
    } else if (base && !base.deleted && base.revision === entry.revision && base.hash === entry.hash) {
      await remember(written(await remote.write(name, bytes, entry.revision), name, entry.revision + 1, localHash));
      result.uploaded++;
    } else await conflict(entry);
  }
  for (const removal of removals) { checkActive(); await removal(); }
  return result;
}

/**
 * The cloud side for syncFolder, kept up to date from the changes feed so a sync only reads what changed.
 * `index` is `{ cursor, objects: { [id]: { path, revision, deleted, hash } } }` and is updated in place.
 */
export async function remoteFiles(client, index, checkActive = () => {}) {
  const changed = new Map();
  for (let more = true; more;) {
    checkActive();
    const page = await client.listChanges(index.cursor);
    for (const change of page.changes) changed.set(change.id, change.revision);
    if (page.hasMore && page.cursor <= index.cursor) throw new Error('Invalid cloud changes cursor');
    index.cursor = page.cursor;
    more = page.hasMore;
    if (changed.size > MAX_SYNC_FILES) throw new Error(`Cloud sync supports at most ${MAX_SYNC_FILES} files`);
  }
  const loaded = new Map();
  for (const [id, revision] of changed) {
    if (index.objects[id]?.revision === revision) continue;
    checkActive();
    let entry;
    // A file cleared from a full free cloud after 30 days in the trash stays in the feed but reads as 404.
    try { entry = await client.read(id); }
    catch (error) { if (error.status !== 404) throw error; delete index.objects[id]; continue; }
    const bytes = base64ToBytes(entry.file.content);
    index.objects[id] = { path: syncPath(entry.file.path), revision: entry.revision, deleted: Boolean(entry.deleted), hash: await hash(bytes) };
    loaded.set(id, bytes);
  }
  if (Object.keys(index.objects).length > MAX_SYNC_FILES) throw new Error(`Cloud sync supports at most ${MAX_SYNC_FILES} files`);
  return Object.entries(index.objects).map(([id, object]) => ({ ...object, bytes: async () => {
    if (loaded.has(id)) return loaded.get(id);
    // The current version, not `?revision=`: the free plan locks older versions, never the newest.
    const entry = await client.read(id);
    const bytes = base64ToBytes(entry.file.content);
    if (entry.revision !== object.revision || entry.file.path !== object.path || await hash(bytes) !== object.hash) throw new Error('Cloud file changed during sync. Local files were kept');
    loaded.set(id, bytes);
    return bytes;
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

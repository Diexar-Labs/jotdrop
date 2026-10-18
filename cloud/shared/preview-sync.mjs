import { base64ToBytes, bytesToBase64, MAX_FILE_BYTES, normalizePath, objectId } from './crypto.mjs';

export const fingerprint = async (bytes) => bytesToBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

/** Manual, non-destructive sync for an isolated test folder. Never deletes local files. */
export async function syncPreview(client, adapter, tracked, persist, { write = (...args) => client.write(...args) } = {}) {
  const result = { uploaded: 0, downloaded: 0, conflicts: 0, remoteDeletions: 0 };
  const local = new Map();
  for (const file of await adapter.list()) {
    normalizePath(file.path);
    if (!/^(notes|attachments)\//.test(file.path) || !(file.bytes instanceof Uint8Array) || file.bytes.length > MAX_FILE_BYTES) throw new Error('Preview sync only accepts notes/ and attachments/ files up to 4 MiB.');
    local.set(file.path, file.bytes);
  }
  const remote = new Map();
  let cursor = 0, more = true;
  while (more) {
    const page = await client.listChanges(cursor);
    for (const change of page.changes) remote.set(change.id, change);
    if (page.hasMore && page.cursor <= cursor) throw new Error('The cloud changes cursor did not advance.');
    cursor = page.cursor;
    more = page.hasMore;
    // ponytail: preview caps the working set; add an indexed journal before large vaults.
    if (remote.size > 500 || local.size > 500) throw new Error('The isolated cloud preview supports at most 500 files.');
  }
  async function remember(id, revision, hash, deleted = false) {
    tracked[id] = { revision, hash, deleted };
    await persist(tracked);
  }
  async function conflictCopy(entry) {
    result.conflicts++;
    if (entry.deleted) { result.remoteDeletions++; return; }
    const path = entry.file.path;
    const suffix = `.cloud-conflict-r${entry.revision}`;
    const split = path.lastIndexOf('.');
    const conflictPath = split > path.lastIndexOf('/') ? `${path.slice(0, split)}${suffix}${path.slice(split)}` : `${path}${suffix}`;
    await adapter.writeConflict(conflictPath, base64ToBytes(entry.file.content));
  }
  for (const [id] of remote) {
    const entry = await client.read(id);
    const path = normalizePath(entry.file.path);
    if (!/^(notes|attachments)\//.test(path)) throw new Error('Remote path is outside the preview note and attachment folders.');
    const bytes = local.get(path), base = tracked[id];
    local.delete(path);
    if (entry.deleted) {
      if (bytes) await conflictCopy(entry);
      else await remember(id, entry.revision, '', true);
      continue;
    }
    const remoteBytes = base64ToBytes(entry.file.content), remoteHash = await fingerprint(remoteBytes);
    if (!bytes) {
      if (base && !base.deleted) { result.conflicts++; continue; }
      if (!await adapter.writeNew(path, remoteBytes)) { result.conflicts++; continue; }
      await remember(id, entry.revision, remoteHash);
      result.downloaded++;
      continue;
    }
    const localHash = await fingerprint(bytes);
    if (localHash === remoteHash) { await remember(id, entry.revision, localHash); continue; }
    if (base && !base.deleted && base.hash === localHash && base.revision !== entry.revision) {
      if (await adapter.replaceText(path, bytes, remoteBytes)) {
        await remember(id, entry.revision, remoteHash);
        result.downloaded++;
      } else await conflictCopy(entry);
    } else if (base && !base.deleted && base.revision === entry.revision && base.hash === remoteHash) {
      try {
        const saved = await write(path, bytes, entry.revision);
        await remember(id, saved.revision, localHash);
        result.uploaded++;
      } catch (error) { if (error.status !== 409) throw error; await conflictCopy(await client.read(id)); }
    } else await conflictCopy(entry);
  }
  for (const [path, bytes] of local) {
    const id = await objectId(client.credentials.vaultKey, path);
    if (tracked[id]) { result.conflicts++; continue; }
    try {
      const saved = await write(path, bytes, 0);
      await remember(id, saved.revision, await fingerprint(bytes));
      result.uploaded++;
    } catch (error) { if (error.status !== 409) throw error; await conflictCopy(await client.read(id)); }
  }
  return result;
}

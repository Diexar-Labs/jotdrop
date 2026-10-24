import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCloudServer } from '../server.mjs';
import { CloudClient } from './client.mjs';
import { objectId, randomToken } from './crypto.mjs';
import { cloudTimeline, conflictOriginal, copyName, hash, isPreserved, remoteFiles, restorePlan, syncFolder, syncPath, unavailable } from './sync.mjs';

const text = (value) => new TextEncoder().encode(value);
const decode = (value) => new TextDecoder().decode(value);

// One device: a folder in memory, its baselines and its view of the changes feed.
function device(client) {
  const files = new Map(), tracked = {}, index = { cursor: 0, objects: {} };
  const local = {
    editing: new Set(),
    // Like the vault adapters: conflict copies stay local.
    async list() { return new Map([...files].filter(([path]) => !isPreserved(path))); },
    async compareAndSet(path, expected, replacement) {
      const actual = files.get(path);
      if ((actual === undefined) !== (expected === null) || (actual && decode(actual) !== decode(expected)) || this.editing.has(path)) return false;
      if (replacement === null) files.delete(path); else files.set(path, replacement);
      return true;
    },
    async conflict(path, revision, bytes) { files.set(copyName(path, `.cloud-conflict-r${revision}`), bytes); },
  };
  const remote = {
    list: () => remoteFiles(client, index),
    async write(path, bytes, baseRevision) { const saved = await client.write(path, bytes, baseRevision); return { path, revision: saved.revision, deleted: false, hash: await hash(bytes) }; },
    async delete(path, baseRevision) { const saved = await client.remove(await objectId(client.credentials.vaultKey, path), baseRevision); return { path, revision: saved.revision, deleted: true, hash: '' }; },
  };
  return { files, tracked, index, local, sync: () => syncFolder(remote, { list: () => local.list(), compareAndSet: (...args) => local.compareAndSet(...args), conflict: (...args) => local.conflict(...args) }, tracked, async () => {}) };
}

test('two devices sync edits, moves and deletions, and keep both versions on conflict', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jotdrop-sync-test-'));
  const enrollmentToken = randomToken(), app = await createCloudServer({ dataDir: directory, enrollmentToken });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = (await CloudClient.create({ url: `http://127.0.0.1:${app.port}`, enrollmentToken, deviceName: 'Laptop' })).client;
  const other = await CloudClient.claim({ pairingCode: (await owner.makePairing('Desktop')).pairingCode });
  const a = device(owner), b = device(other);

  a.files.set('notes/Shopping.md', text('Milk'));
  a.files.set('attachments/photo.jpg', new Uint8Array([1, 2, 3]));
  assert.deepEqual(await a.sync(), { uploaded: 2, downloaded: 0, deleted: 0, conflicts: 0 });
  assert.deepEqual(await b.sync(), { uploaded: 0, downloaded: 2, deleted: 0, conflicts: 0 });
  assert.equal(decode(b.files.get('notes/Shopping.md')), 'Milk');

  // An edit on one device arrives on the other; a quiet sync reads nothing new.
  b.files.set('notes/Shopping.md', text('Milk, eggs'));
  assert.equal((await b.sync()).uploaded, 1);
  assert.equal((await a.sync()).downloaded, 1);
  assert.equal(decode(a.files.get('notes/Shopping.md')), 'Milk, eggs');
  const reads = t.mock.method(owner, 'read');
  assert.deepEqual(await a.sync(), { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0 });
  assert.equal(reads.mock.callCount(), 0, 'Unchanged files are not downloaded again');
  reads.mock.restore();

  // Archive = a move: the new place uploads before the old one is removed.
  a.files.set('notes/Archive/Shopping.md', a.files.get('notes/Shopping.md'));
  a.files.delete('notes/Shopping.md');
  assert.deepEqual(await a.sync(), { uploaded: 1, downloaded: 0, deleted: 1, conflicts: 0 });
  assert.deepEqual(await b.sync(), { uploaded: 0, downloaded: 1, deleted: 1, conflicts: 0 });
  assert.ok(!b.files.has('notes/Shopping.md') && b.files.has('notes/Archive/Shopping.md'));

  // Both change the same note: the local text stays, the cloud text comes next to it.
  a.files.set('notes/Archive/Shopping.md', text('From the laptop'));
  b.files.set('notes/Archive/Shopping.md', text('From the desktop'));
  await a.sync();
  assert.equal((await b.sync()).conflicts, 1);
  assert.equal(decode(b.files.get('notes/Archive/Shopping.md')), 'From the desktop');
  assert.equal(decode(b.files.get('notes/Archive/Shopping.cloud-conflict-r2.md')), 'From the laptop');
  assert.equal((await b.sync()).uploaded, 0, 'Conflict copies never upload');

  // A note open in an editor is never replaced underneath; it becomes a conflict copy instead.
  b.files.delete('notes/Archive/Shopping.cloud-conflict-r2.md');
  b.files.set('notes/Archive/Shopping.md', text('From the laptop'));
  await b.sync();
  a.files.set('notes/Archive/Shopping.md', text('Laptop again'));
  await a.sync();
  b.local.editing.add('notes/Archive/Shopping.md');
  assert.equal((await b.sync()).conflicts, 1);
  assert.equal(decode(b.files.get('notes/Archive/Shopping.md')), 'From the laptop');
  b.local.editing.clear();
  b.files.delete('notes/Archive/Shopping.cloud-conflict-r3.md');

  // A deletion of an unchanged note reaches the other device; a changed note is kept.
  await b.sync();
  a.files.delete('attachments/photo.jpg');
  assert.equal((await a.sync()).deleted, 1);
  assert.equal((await b.sync()).deleted, 1);
  assert.ok(!b.files.has('attachments/photo.jpg'));
  b.files.delete('notes/Archive/Shopping.md');
  a.files.set('notes/Archive/Shopping.md', text('Edited while deleted elsewhere'));
  await a.sync();
  assert.equal((await b.sync()).conflicts, 1, 'An edit wins over a deletion elsewhere');
  assert.equal(decode(b.files.get('notes/Archive/Shopping.cloud-conflict-r4.md')), 'Edited while deleted elsewhere');
  assert.equal(decode(a.files.get('notes/Archive/Shopping.md')), 'Edited while deleted elsewhere');
});

test('paths follow the Android rules', () => {
  assert.equal(syncPath('notes/Trash/a.md'), 'notes/Trash/a.md');
  assert.throws(() => syncPath('notes/a.txt'), /Markdown/);
  assert.throws(() => syncPath('notes/.hidden/a.md'), /hidden/);
  assert.throws(() => syncPath('notes/a.cloud-conflict-r2.md'), /preserved/);
  assert.throws(() => syncPath('other/a.md'), /outside/);
  assert.equal(copyName('notes/a.md', '.cloud-conflict-r2'), 'notes/a.cloud-conflict-r2.md');
});

test('a conflict copy names its original', () => {
  for (const path of ['notes/a.md', 'notes/Archive/x.y.md', 'attachments/photo.jpg', 'attachments/plain']) {
    assert.equal(conflictOriginal(copyName(path, '.cloud-conflict-r3')), path);
    assert.equal(conflictOriginal(copyName(path, `.cloud-conflict-r12-${crypto.randomUUID()}`)), path);
  }
  assert.equal(conflictOriginal('notes/a.md'), null);
  assert.equal(conflictOriginal(copyName('notes/a.md', '.cloud-recovery-abc')), null);
});

test('the time machine steps per minute and restores a moment as new versions', async () => {
  const feed = [
    { id: 'a', revision: 1, deleted: false, updatedAt: '2026-10-24T10:00:05.000Z' },
    { id: 'b', revision: 1, deleted: false, updatedAt: '2026-10-24T10:00:40.000Z' },
    { id: 'a', revision: 2, deleted: false, updatedAt: '2026-10-24T10:03:00.000Z' },
    { id: 'b', revision: 2, deleted: true, updatedAt: '2026-10-24T10:04:00.000Z' },
    { id: 'c', revision: 1, deleted: false, updatedAt: '2026-10-24T10:05:00.000Z' },
  ];
  // Two pages, like a long feed.
  const client = { listChanges: async (after) => after === 0 ? { changes: feed.slice(0, 3), cursor: 3, hasMore: true } : { changes: feed.slice(3), cursor: 5, hasMore: false } };
  const { steps, current } = await cloudTimeline(client);
  assert.deepEqual(steps, ['2026-10-24T10:00:40.000Z', '2026-10-24T10:03:00.000Z', '2026-10-24T10:04:00.000Z', '2026-10-24T10:05:00.000Z']);
  assert.deepEqual(current, [{ id: 'a', revision: 2, deleted: false }, { id: 'b', revision: 2, deleted: true }, { id: 'c', revision: 1, deleted: false }]);
  // Back to 10:00: a goes back, b comes out of the trash, c (made later) moves to the trash.
  const then = [{ id: 'a', revision: 1, deleted: false, locked: false, cleared: false }, { id: 'b', revision: 1, deleted: false, locked: false, cleared: false }];
  assert.deepEqual(restorePlan(current, then), [
    { id: 'a', revision: 1, baseRevision: 2 },
    { id: 'b', revision: 1, baseRevision: 2 },
    { id: 'c', delete: true, baseRevision: 1 },
  ]);
  // Unchanged since then: nothing to do. A deleted file stays deleted.
  assert.deepEqual(restorePlan(current, [{ id: 'a', revision: 2, deleted: false, locked: true, cleared: false }, { id: 'b', revision: 2, deleted: true, locked: false, cleared: false }, { id: 'c', revision: 1, deleted: false, locked: false, cleared: false }]), []);
  // A locked older version (free plan, older than 30 days) or a cleared one: the whole moment needs Plus.
  const locked = [{ id: 'a', revision: 1, deleted: false, locked: true, cleared: false }];
  assert.deepEqual(unavailable(current, locked), locked);
  assert.throws(() => restorePlan(current, locked), /Plus/);
  assert.equal(unavailable(current, [{ id: 'a', revision: null, deleted: false, locked: true, cleared: true }]).length, 1);
});

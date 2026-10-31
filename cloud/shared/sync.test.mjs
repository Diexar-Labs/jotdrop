import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCloudServer } from '../server.mjs';
import { CloudClient } from './client.mjs';
import { isSpacePath, objectId, randomToken } from './crypto.mjs';
import { cloudTimeline, conflictOriginal, copyName, hash, isPreserved, remoteFiles, restorePlan, syncFolder, syncPath, unavailable } from './sync.mjs';

const text = (value) => new TextEncoder().encode(value);
const decode = (value) => new TextDecoder().decode(value);

// One device: a folder in memory, its baselines and its view of the changes feed.
function device(client) {
  const files = new Map(), tracked = {}, index = { cursor: 0, objects: {} }, seen = {};
  // Each new content is a new array, so its identity stands in for a modification time.
  const times = new WeakMap();
  let clock = 0;
  const modified = (bytes) => { if (!times.has(bytes)) times.set(bytes, ++clock); return times.get(bytes); };
  const local = {
    editing: new Set(),
    reads: 0,
    // Like the vault adapters: conflict copies stay local.
    async list() { return new Map([...files].filter(([path]) => !isPreserved(path)).map(([path, bytes]) => [path, { size: bytes.length, modified: modified(bytes) }])); },
    async read(path) {
      this.reads++;
      if (!files.has(path)) throw new Error('Expected a local file');
      return files.get(path);
    },
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
    async base(path, revision) {
      try { return (await client.read(await objectId(client.credentials.vaultKey, path), revision)).file.bytes; }
      catch (error) { if (error.status >= 400 && error.status < 500) return null; throw error; }
    },
  };
  return { files, tracked, index, local, sync: () => syncFolder(remote, local, tracked, async () => {}, { seen }) };
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
  assert.deepEqual(await a.sync(), { uploaded: 2, downloaded: 0, deleted: 0, conflicts: 0, skipped: [] });
  assert.deepEqual(await b.sync(), { uploaded: 0, downloaded: 2, deleted: 0, conflicts: 0, skipped: [] });
  assert.equal(decode(b.files.get('notes/Shopping.md')), 'Milk');

  // An edit on one device arrives on the other; a quiet sync reads nothing new.
  b.files.set('notes/Shopping.md', text('Milk, eggs'));
  assert.equal((await b.sync()).uploaded, 1);
  assert.equal((await a.sync()).downloaded, 1);
  assert.equal(decode(a.files.get('notes/Shopping.md')), 'Milk, eggs');
  const reads = t.mock.method(owner, 'read');
  assert.deepEqual(await a.sync(), { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, skipped: [] });
  assert.equal(reads.mock.callCount(), 0, 'Unchanged files are not downloaded again');
  reads.mock.restore();
  a.local.reads = 0;
  await a.sync();
  assert.equal(a.local.reads, 0, 'Unchanged local files are not read again');

  // Archive = a move: the new place uploads before the old one is removed.
  a.files.set('notes/Archive/Shopping.md', a.files.get('notes/Shopping.md'));
  a.files.delete('notes/Shopping.md');
  assert.deepEqual(await a.sync(), { uploaded: 1, downloaded: 0, deleted: 1, conflicts: 0, skipped: [] });
  assert.deepEqual(await b.sync(), { uploaded: 0, downloaded: 1, deleted: 1, conflicts: 0, skipped: [] });
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

test('a note changed in different places on two devices merges without a copy', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jotdrop-sync-merge-'));
  const enrollmentToken = randomToken(), app = await createCloudServer({ dataDir: directory, enrollmentToken });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = (await CloudClient.create({ url: `http://127.0.0.1:${app.port}`, enrollmentToken, deviceName: 'Desktop' })).client;
  const other = await CloudClient.claim({ pairingCode: (await owner.makePairing('Phone')).pairingCode });
  const desktop = device(owner), phone = device(other);
  const note = 'notes/Daily.md', body = '# Daily\n\nStretch.\n';
  desktop.files.set(note, text(`---\ntags:\n  - health\nreminder: 2026-10-27T14:00\nreminder_repeat: daily\nreminder_done: 9\n---\n${body}`));
  await desktop.sync();
  await phone.sync();

  // 14:00: the reminder goes off on both, each writes the next one its own way; the desktop also sets the card order.
  desktop.files.set(note, text(`---\ntags:\n  - health\nreminder: 2026-10-28T14:00\nreminder_repeat: daily\nreminder_done: 10\norder: -5\n---\n${body}`));
  phone.files.set(note, text(`---\ntags: [health]\nreminder: "2026-10-28T14:00"\nreminder_repeat: daily\nreminder_done: 10\n---\n${body}`));
  assert.equal((await desktop.sync()).uploaded, 1);
  assert.deepEqual(await phone.sync(), { uploaded: 0, downloaded: 1, deleted: 0, conflicts: 0, skipped: [] });
  assert.equal(decode(phone.files.get(note)), decode(desktop.files.get(note)), 'The phone takes the cloud version: nothing of its own was lost');

  // The phone pins the card while the desktop edits the text: one merged note, both ways.
  const pinned = `---\ntags:\n  - health\nreminder: 2026-10-28T14:00\nreminder_repeat: daily\nreminder_done: 10\norder: -5\npinned: true\n---\n`;
  phone.files.set(note, text(`${pinned}${body}`));
  desktop.files.set(note, text(`---\ntags:\n  - health\nreminder: 2026-10-28T14:00\nreminder_repeat: daily\nreminder_done: 10\norder: -5\n---\n# Daily\n\nStretch and walk.\n`));
  await desktop.sync();
  assert.deepEqual(await phone.sync(), { uploaded: 1, downloaded: 0, deleted: 0, conflicts: 0, skipped: [] });
  const merged = `${pinned}# Daily\n\nStretch and walk.\n`;
  assert.equal(decode(phone.files.get(note)), merged);
  assert.equal((await desktop.sync()).downloaded, 1);
  assert.equal(decode(desktop.files.get(note)), merged);
  assert.ok(![...phone.files.keys(), ...desktop.files.keys()].some(isPreserved), 'No copies on either device');

  // Both change the text: still both versions, as before.
  phone.files.set(note, text(merged.replace('walk', 'run')));
  desktop.files.set(note, text(merged.replace('walk', 'swim')));
  await desktop.sync();
  assert.equal((await phone.sync()).conflicts, 1);
  assert.equal(decode(phone.files.get(note)), merged.replace('walk', 'run'));
  assert.equal(decode(phone.files.get('notes/Daily.cloud-conflict-r5.md')), merged.replace('walk', 'swim'));
});

test('a list ticked on two devices merges per line; without the shared version both versions stay', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jotdrop-sync-lines-'));
  const enrollmentToken = randomToken(), app = await createCloudServer({ dataDir: directory, enrollmentToken });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = (await CloudClient.create({ url: `http://127.0.0.1:${app.port}`, enrollmentToken, deviceName: 'Desktop' })).client;
  const other = await CloudClient.claim({ pairingCode: (await owner.makePairing('Phone')).pairingCode });
  const desktop = device(owner), phone = device(other);
  const note = 'notes/Shopping.md';
  desktop.files.set(note, text('- [ ] milk\n- [ ] eggs\n- [ ] milk\n'));
  await desktop.sync();
  await phone.sync();

  desktop.files.set(note, text('- [x] milk\n- [ ] eggs\n- [ ] milk\n'));
  phone.files.set(note, text('- [ ] milk\n- [x] eggs\n- [ ] milk\n'));
  await desktop.sync();
  assert.deepEqual(await phone.sync(), { uploaded: 1, downloaded: 0, deleted: 0, conflicts: 0, skipped: [] });
  assert.equal((await desktop.sync()).downloaded, 1);
  assert.equal(decode(desktop.files.get(note)), '- [x] milk\n- [x] eggs\n- [ ] milk\n');
  assert.equal(decode(phone.files.get(note)), decode(desktop.files.get(note)));
  assert.ok(![...phone.files.keys(), ...desktop.files.keys()].some(isPreserved), 'No copies on either device');

  // The free plan locks old versions after 30 days: then the shared version cannot be read and nothing merges.
  const locked = t.mock.method(other, 'read', async () => { throw Object.assign(new Error('Locked'), { status: 403 }); });
  desktop.files.set(note, text('- [x] milk\n- [x] eggs\n- [x] milk\n'));
  phone.files.set(note, text('- [ ] milk\n- [x] eggs\n- [x] milk\n'));
  await desktop.sync();
  assert.equal((await phone.sync()).conflicts, 1);
  locked.mock.restore();
  assert.equal(decode(phone.files.get(note)), '- [ ] milk\n- [x] eggs\n- [x] milk\n');
  assert.equal(decode(phone.files.get('notes/Shopping.cloud-conflict-r4.md')), '- [x] milk\n- [x] eggs\n- [x] milk\n');
});

test('a shared space stays out of the vault in both directions; an ordinary folder called Shared does not', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jotdrop-sync-space-'));
  const enrollmentToken = randomToken(), app = await createCloudServer({ dataDir: directory, enrollmentToken });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = (await CloudClient.create({ url: `http://127.0.0.1:${app.port}`, enrollmentToken, deviceName: 'Desktop' })).client;
  const other = await CloudClient.claim({ pairingCode: (await owner.makePairing('Phone')).pairingCode });
  const a = device(owner), b = device(other);
  const space = 'notes/Shared/3f2a1c9e-8b7d-4e6f-a5c4-1d2e3f4a5b6c/List.md', ordinary = 'notes/Shared/Holiday.md';

  a.files.set(space, text('From the space\n'));
  a.files.set(ordinary, text('My own note\n'));
  assert.equal((await a.sync()).uploaded, 1);
  assert.equal((await b.sync()).downloaded, 1);
  assert.ok(b.files.has(ordinary) && !b.files.has(space));

  // An old app put a space's note in the vault, and may have kept its baseline: it stays there, untouched.
  const old = 'notes/Shared/3F2A1C9E-8B7D-4E6F-A5C4-1D2E3F4A5B6C/Old.md';
  const saved = await owner.write(old, text('Old copy\n'), 0);
  b.tracked[old] = { revision: saved.revision, hash: await hash(text('Old copy\n')), deleted: false };
  assert.deepEqual(await b.sync(), { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, skipped: [] });
  assert.ok(!b.files.has(old) && !(old in b.tracked));
  const id = await objectId(owner.credentials.vaultKey, old);
  assert.equal((await owner.read(id)).deleted, false, 'Not removed from the cloud');
  a.files.delete(space);
  assert.equal((await a.sync()).deleted, 0, 'Removing the folder here removes nothing from the vault');

  for (const path of ['notes/Shared/not-an-id/List.md', 'notes/Shared/3f2a1c9e-8b7d-4e6f-a5c4-1d2e3f4a5b6c.md', 'notes/Other/3f2a1c9e-8b7d-4e6f-a5c4-1d2e3f4a5b6c/List.md']) assert.equal(isSpacePath(path), false, path);
});

test('more than 500 files sync through the real server, and a quiet sync reads nothing', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jotdrop-sync-many-'));
  const enrollmentToken = randomToken(), app = await createCloudServer({ dataDir: directory, enrollmentToken });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = (await CloudClient.create({ url: `http://127.0.0.1:${app.port}`, enrollmentToken, deviceName: 'Laptop' })).client;
  const other = await CloudClient.claim({ pairingCode: (await owner.makePairing('Desktop')).pairingCode });
  const a = device(owner), b = device(other);
  for (let n = 0; n < 600; n++) a.files.set(`notes/Note ${n}.md`, text(`Note ${n}`));
  assert.equal((await a.sync()).uploaded, 600);
  assert.equal((await b.sync()).downloaded, 600);
  assert.equal(decode(b.files.get('notes/Note 599.md')), 'Note 599');
  await b.sync();
  b.local.reads = 0;
  const reads = t.mock.method(other, 'read');
  assert.deepEqual(await b.sync(), { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, skipped: [] });
  assert.equal(b.local.reads + reads.mock.callCount(), 0);
});

test('a file over 4 MiB stays on its device and the rest syncs; it is never deleted elsewhere', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jotdrop-sync-big-'));
  const enrollmentToken = randomToken(), app = await createCloudServer({ dataDir: directory, enrollmentToken });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = (await CloudClient.create({ url: `http://127.0.0.1:${app.port}`, enrollmentToken, deviceName: 'Laptop' })).client;
  const other = await CloudClient.claim({ pairingCode: (await owner.makePairing('Desktop')).pairingCode });
  const a = device(owner), b = device(other);
  a.files.set('notes/Trip.md', text('![[photo.jpg]]'));
  a.files.set('attachments/photo.jpg', new Uint8Array(1000));
  a.files.set('attachments/big.jpg', new Uint8Array(5 * 1024 * 1024));
  assert.deepEqual(await a.sync(), { uploaded: 2, downloaded: 0, deleted: 0, conflicts: 0, skipped: ['attachments/big.jpg'] });
  assert.deepEqual(await b.sync(), { uploaded: 0, downloaded: 2, deleted: 0, conflicts: 0, skipped: [] });
  // A synced photo that is replaced by a bigger one: the cloud keeps the old one, nothing is removed anywhere.
  a.files.set('attachments/photo.jpg', new Uint8Array(5 * 1024 * 1024));
  assert.deepEqual(await a.sync(), { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, skipped: ['attachments/big.jpg', 'attachments/photo.jpg'] });
  assert.equal((await b.sync()).deleted, 0);
  assert.equal(b.files.get('attachments/photo.jpg').length, 1000);
});

test('5,000 files and 300 MB sync in bounded memory, and a cut-off sync goes on where it was', () => {
  const output = execFileSync(process.execPath, ['--expose-gc', fileURLToPath(new URL('./sync-scale.check.mjs', import.meta.url))], { encoding: 'utf8' });
  const result = JSON.parse(output.trim().split('\n').pop());
  assert.equal(result.files, 5000);
  assert.ok(result.mib >= 290);
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

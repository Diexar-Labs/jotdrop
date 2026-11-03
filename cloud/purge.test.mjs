import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCloudServer } from './server.mjs';
import { CloudClient } from './shared/client.mjs';
import { objectId, randomToken } from './shared/crypto.mjs';
import { cloudTimeline, restorePlan } from './shared/sync.mjs';

// "Delete forever" in the trash: every version and piece goes, a deleted version without content stays.
const MINUTE = 60 * 1000, DAY = 24 * 60 * MINUTE;
const text = (value) => new TextEncoder().encode(value);
const decode = (value) => new TextDecoder().decode(value);

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-purge-test-'));
  const enrollmentToken = randomToken();
  let now = Date.parse('2026-11-03T08:00:00Z');
  const app = await createCloudServer({ dataDir, enrollmentToken, freeDeviceLimit: 100, enrollmentLimit: 2, clock: () => now, ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  const { client } = await CloudClient.create({ url, enrollmentToken, deviceName: 'Browser' });
  const database = () => { const db = new DatabaseSync(app.dbPath, { readOnly: true }); t.after(() => { try { db.close(); } catch { /* closed */ } }); return db; };
  const rows = (table, vaultId, id) => { const db = database(); try { return db.prepare(`SELECT * FROM ${table} WHERE vaultId=? AND id=?`).all(vaultId, id); } finally { db.close(); } };
  return { app, url, enrollmentToken, client, database, rows, advance: (ms) => { now += ms; }, create: (name) => CloudClient.create({ url, enrollmentToken, deviceName: name }) };
}

test('delete forever removes every version, envelope and piece, lowers usage and keeps a tombstone', async (t) => {
  const { client, rows, database, advance } = await fixture(t);
  const { vaultId } = client.credentials;
  const keep = await client.write('notes/keep.md', text('# Keep\nThis one stays.'), 0);
  const id = await objectId(client.credentials.vaultKey, 'notes/gone.md');
  for (let revision = 0; revision < 3; revision++) { await client.write('notes/gone.md', text(`# Gone\nVersion ${revision}. ${'x'.repeat(2000)}`), revision); advance(MINUTE); }
  // Large enough for encrypted pieces: those have to go too.
  const big = new Uint8Array(randomBytes(3 * 1024 * 1024 + 7));
  const bigSaved = await client.write('attachments/gone.bin', big, 0);
  await client.write('attachments/gone.bin', new Uint8Array(randomBytes(2 * 1024 * 1024)), 1);
  advance(MINUTE);
  const deleted = await client.remove(id, 3);
  assert.equal(deleted.revision, 4);
  const before = (await client.status()).usedBytes;

  const purged = await client.purge('notes/gone.md', 4);
  assert.deepEqual([purged.id, purged.revision, purged.purged], [id, 5, true]);
  // One deleted version is left, without content: devices that were away read the note as deleted.
  const tombstone = await client.read(id);
  assert.deepEqual([tombstone.revision, tombstone.deleted, tombstone.purged, tombstone.file.path, tombstone.file.content], [5, true, true, 'notes/gone.md', '']);
  assert.deepEqual(rows('revisions', vaultId, id).map((row) => [row.revision, row.deleted]), [[5, 1]]);
  assert.equal(rows('envelopes', vaultId, id).length, 1);
  assert.equal(rows('envelope_chunks', vaultId, id).length, 0);
  assert.deepEqual(rows('changes', vaultId, id).map((row) => [row.revision, row.deleted]), [[5, 1]]);
  assert.deepEqual(rows('purges', vaultId, id).map((row) => row.revision), [5]);
  const changes = (await client.listChanges()).changes.filter((change) => change.id === id);
  assert.deepEqual(changes.map((change) => [change.revision, change.deleted]), [[5, true]]);
  // Older versions, the history and Restore are gone.
  for (const revision of [1, 3, 4]) await assert.rejects(client.read(id, revision), (error) => error.status === 404);
  await assert.rejects(client.history(id), (error) => error.status === 404);
  for (const revision of [4, 5]) await assert.rejects(client.restore(id, revision, 5), (error) => error.status === 404);
  const after = (await client.status()).usedBytes;
  assert.ok(after < before - 3 * 2000, `used ${before} then ${after}`);

  // An attachment with pieces, not deleted yet (like a note in notes/Trash/): deleted and purged in one go.
  const db = database();
  const piecesBefore = db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE vaultId=?').get(vaultId).count;
  db.close();
  assert.ok(piecesBefore >= 6);
  const gone = await client.purge('attachments/gone.bin', 2);
  assert.deepEqual([gone.revision, gone.purged], [3, true]);
  const read = await client.read(bigSaved.id);
  assert.deepEqual([read.deleted, read.purged, read.file.bytes.length], [true, true, 0]);
  const check = database();
  assert.equal(check.prepare('SELECT COUNT(*) AS count FROM chunks WHERE vaultId=?').get(vaultId).count, 0);
  assert.equal(check.prepare('SELECT COUNT(*) AS count FROM envelope_chunks WHERE vaultId=?').get(vaultId).count, 0);
  check.close();
  const last = (await client.status()).usedBytes;
  assert.ok(last < after - 5 * 1024 * 1024 && last < 4096, `used ${after} then ${last}`);
  // The other note is untouched.
  assert.equal(decode((await client.read(keep.id)).file.bytes), '# Keep\nThis one stays.');
  assert.equal((await client.history(keep.id)).versions.length, 1);
});

test('delete forever needs the version shown, is safe to repeat and refuses other clouds and revoked devices', async (t) => {
  const { client, create, rows } = await fixture(t);
  const saved = await client.write('notes/gone.md', text('# Gone'), 0);
  await client.write('notes/gone.md', text('# Gone, edited'), 1);
  await client.remove(saved.id, 2);
  // An older version than the newest: refused, nothing removed.
  await assert.rejects(client.purge('notes/gone.md', 2), (error) => error.status === 409 && error.currentRevision === 3);
  assert.equal(rows('revisions', client.credentials.vaultId, saved.id).length, 3);
  // A device of another cloud reaches only its own cloud.
  const other = (await create('Other cloud')).client;
  const forOther = await other.prepareWrite('notes/gone.md', new Uint8Array(0), 3);
  await assert.rejects(other.call(`/objects/${saved.id}/purge`, 'POST', { baseRevision: 3, envelope: forOther.envelope }), (error) => error.status === 404);
  const forged = new CloudClient({ ...other.credentials, vaultId: client.credentials.vaultId });
  await assert.rejects(forged.purge('notes/gone.md', 3), (error) => error.status === 401);
  // A revoked device cannot.
  const second = await CloudClient.claim({ pairingCode: (await client.makePairing('Phone')).pairingCode });
  await client.revokeDevice(second.credentials.deviceId);
  await assert.rejects(second.purge('notes/gone.md', 3), (error) => error.status === 401);
  assert.equal(rows('revisions', client.credentials.vaultId, saved.id).length, 3);
  // Invalid requests change nothing.
  await assert.rejects(client.call(`/objects/${saved.id}/purge`, 'POST', { baseRevision: 3 }), (error) => error.status === 400);
  await assert.rejects(client.call(`/objects/${saved.id}/purge`, 'POST', { baseRevision: 3, envelope: 'not an envelope' }), (error) => error.status === 400);
  await assert.rejects(client.call(`/objects/${'0'.repeat(64)}/purge`, 'POST', { baseRevision: 1, envelope: forOther.envelope }), (error) => error.status === 404);

  const purged = await client.purge('notes/gone.md', 3);
  assert.equal(purged.revision, 4);
  // A lost answer or a second device: the same answer, nothing new.
  const again = await client.purge('notes/gone.md', 3);
  assert.deepEqual([again.revision, again.sequence, again.purged], [4, purged.sequence, true]);
  assert.equal((await client.listChanges()).changes.length, 1);
  // Deleting the tombstone again is refused; it stays deleted forever.
  await assert.rejects(client.remove(saved.id, 4), (error) => error.status === 409);
});

test('after delete forever an old copy cannot come back unnoticed, and the name can be used again', async (t) => {
  const { client } = await fixture(t);
  const second = await CloudClient.claim({ pairingCode: (await client.makePairing('Phone')).pairingCode });
  const saved = await client.write('notes/gone.md', text('# Gone'), 0);
  assert.equal((await second.read(saved.id)).revision, 1);
  // Purged straight from a live note (one in notes/Trash/ on another device), while the phone was away.
  await client.purge('notes/gone.md', 1);
  // The phone's offline edit on top of revision 1 is a conflict, like with any deleted note.
  await assert.rejects(second.write('notes/gone.md', text('# Gone, edited offline'), 1), (error) => error.status === 409 && error.currentRevision === 2);
  // A device that never knew the note (a fresh install with a local copy) cannot create it as new either.
  await assert.rejects(second.write('notes/gone.md', text('# Gone'), 0), (error) => error.status === 409 && error.currentRevision === 2);
  assert.deepEqual([(await second.read(saved.id)).deleted, (await second.read(saved.id)).purged], [true, true]);
  // Choosing to save on top of the deleted note works as for any deleted note: a new note at the same name.
  const again = await second.write('notes/gone.md', text('# New note'), 2);
  assert.equal(again.revision, 3);
  const read = await client.read(saved.id);
  assert.deepEqual([read.deleted, read.purged, decode(read.file.bytes)], [false, undefined, '# New note']);
  // Its history starts at the tombstone, which cannot be restored.
  assert.deepEqual((await client.history(saved.id)).versions.map((version) => [version.revision, version.deleted]), [[3, false], [2, true]]);
  await assert.rejects(client.restore(saved.id, 2, 3), (error) => error.status === 404);
});

test('the time machine no longer shows a note deleted forever', async (t) => {
  const { client, advance } = await fixture(t);
  const keep = await client.write('notes/keep.md', text('# Keep'), 0);
  advance(MINUTE);
  const saved = await client.write('notes/gone.md', text('# Gone'), 0);
  advance(MINUTE);
  const moment = new Date(Date.parse('2026-11-03T08:01:30Z')).toISOString();
  assert.deepEqual((await client.snapshot(moment)).objects.map((object) => object.id).sort(), [keep.id, saved.id].sort());
  await client.write('notes/gone.md', text('# Gone, edited'), 1);
  advance(MINUTE);
  await client.remove(saved.id, 2);
  advance(MINUTE);
  const before = await cloudTimeline(client);
  assert.equal(before.steps.length, 4);
  await client.purge('notes/gone.md', 3);
  // Not in any moment, before or after; the steps of its changes are gone; only the purge itself is a step.
  for (const at of [moment, new Date(Date.parse('2026-11-03T08:02:30Z')).toISOString(), new Date(Date.parse('2026-11-03T08:10:00Z')).toISOString()]) {
    const { objects } = await client.snapshot(at);
    assert.deepEqual(objects.map((object) => object.id), [keep.id]);
    assert.ok(objects.every((object) => !object.cleared && !object.locked));
  }
  const after = await cloudTimeline(client);
  assert.equal(after.steps.length, 2);
  assert.equal(after.steps[0], before.steps[0]);
  assert.ok(after.steps[1] > before.steps[3]);
  // Restoring an earlier moment leaves the deleted note deleted and is not blocked by it.
  assert.deepEqual(restorePlan(after.current, (await client.snapshot(moment)).objects), []);
  // On a free cloud long after, the tombstone is still left out and still reads as deleted.
  advance(40 * DAY);
  assert.deepEqual((await client.snapshot(new Date(Date.parse('2026-11-03T08:10:00Z')).toISOString())).objects.map((object) => object.id), [keep.id]);
  assert.deepEqual([(await client.read(saved.id)).deleted, (await client.read(saved.id)).purged], [true, true]);
});

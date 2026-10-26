import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createCloudServer } from './server.mjs';
import { CloudClient } from './shared/client.mjs';
import { bytesToBase64, CHUNK_BYTES, decryptChunk, encryptChunk, encryptEnvelope, objectId, randomToken, sha256Hex } from './shared/crypto.mjs';

const MiB = 1024 * 1024;
const text = (value) => new TextEncoder().encode(value);

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-chunks-test-'));
  const enrollmentToken = randomToken();
  let now = Date.now();
  const app = await createCloudServer({ dataDir, enrollmentToken, clock: () => now, ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  // Every request passes `network`, so a test can count or break them.
  const requests = [];
  let network = (url, options) => fetch(url, options);
  const fetcher = (url, options) => { requests.push(`${options.method ?? 'GET'} ${new URL(url).pathname.replace(/^\/api\/v1/, '')}`); return network(url, options); };
  const { client } = await CloudClient.create({ url, enrollmentToken, deviceName: 'Test device', fetcher });
  return { app, client, requests, advance: (ms) => { now += ms; }, setNetwork: (value) => { network = value; } };
}
const pieceRequests = (requests, method) => requests.filter((entry) => entry.startsWith(`${method} /chunks/`) && !entry.endsWith('/missing'));

test('a large file goes up and down in encrypted pieces and counts its real size', async (t) => {
  const { client, requests } = await fixture(t);
  const bytes = new Uint8Array(randomBytes(10 * MiB + 123));
  const saved = await client.write('attachments/video.mp4', bytes, 0);
  assert.equal(saved.revision, 1);
  assert.equal(pieceRequests(requests, 'PUT').length, 11);
  const status = await client.status();
  // Pieces are stored as raw bytes: no base64, only a 28-byte IV and tag per piece plus a small manifest.
  assert.ok(status.usedBytes >= bytes.length && status.usedBytes < bytes.length + 64 * 1024, `used ${status.usedBytes}`);
  assert.deepEqual(status.pieces, { version: 1, pieceBytes: CHUNK_BYTES, maxFileBytes: 25 * MiB });
  assert.equal((await client.listChanges()).changes[0].size, status.usedBytes);

  // The manifest alone is enough to compare: no piece is downloaded.
  requests.length = 0;
  const { manifest } = await client.readManifest(saved.id);
  assert.deepEqual([manifest.path, manifest.size, manifest.hash, manifest.pieces.length], ['attachments/video.mp4', bytes.length, await sha256Hex(bytes), 11]);
  assert.equal(manifest.bytes, undefined);
  assert.equal(pieceRequests(requests, 'GET').length, 0);
  const read = await client.read(saved.id);
  assert.deepEqual(read.file.bytes, bytes);
  assert.equal(read.file.path, 'attachments/video.mp4');
  assert.equal(pieceRequests(requests, 'GET').length, 11);
});

test('a small file stays inside its manifest and needs no pieces', async (t) => {
  const { client, requests } = await fixture(t);
  const saved = await client.write('notes/short.md', text('# Short note'), 0);
  assert.equal(requests.filter((entry) => entry.includes('/chunks')).length, 0);
  const { manifest } = await client.readManifest(saved.id);
  assert.equal(new TextDecoder().decode(manifest.bytes), '# Short note');
  assert.equal((await client.read(saved.id)).file.content, bytesToBase64(text('# Short note')));
});

test('each plan has its own maximum per file', async (t) => {
  const { client } = await fixture(t, { maxFileBytes: 2 * MiB, plusMaxFileBytes: 4 * MiB });
  await client.write('attachments/fits.bin', new Uint8Array(randomBytes(2 * MiB)), 0);
  await assert.rejects(client.write('attachments/too-big.bin', new Uint8Array(randomBytes(2 * MiB + 1)), 0), (error) => error.status === 413 && error.code === 'plus-required' && /at most 2 MB/.test(error.message));
  assert.equal((await client.listChanges()).changes.length, 1);
  assert.equal((await client.status()).pieces.maxFileBytes, 2 * MiB);
});

test('an interrupted upload resumes with only the missing pieces', async (t) => {
  const { client, requests, setNetwork } = await fixture(t);
  const bytes = new Uint8Array(randomBytes(5 * MiB));
  const prepared = await client.prepareWrite('attachments/resume.bin', bytes, 0);
  let sent = 0;
  // The line drops after three pieces, also for the one retry.
  setNetwork((url, options) => {
    if (options.method === 'PUT' && /\/chunks\//.test(url) && ++sent > 3) return Promise.reject(new TypeError('Synthetic lost network'));
    return fetch(url, options);
  });
  await assert.rejects(client.commitWrite(prepared, { source: bytes }), /lost network/);
  assert.equal((await client.listChanges()).changes.length, 0);
  setNetwork((url, options) => fetch(url, options));
  requests.length = 0;
  // A restart prepares again: the same file gives the same pieces, so the three already sent are reused.
  const again = await client.prepareWrite('attachments/resume.bin', bytes, 0);
  assert.deepEqual(again.chunks, prepared.chunks);
  const progress = [];
  await client.commitWrite(again, { source: bytes, onProgress: (event) => progress.push(event.phase) });
  assert.equal(pieceRequests(requests, 'PUT').length, 2);
  assert.equal(progress.at(-1), 'committed');
  assert.deepEqual((await client.read(prepared.id)).file.bytes, bytes);
  // Without the file, a draft whose pieces are all in the cloud still finishes; one that misses pieces says so.
  const other = await client.prepareWrite('attachments/other.bin', new Uint8Array(randomBytes(2 * MiB)), 0);
  await assert.rejects(client.commitWrite(other), /file is needed/);
});

test('a save whose answer was lost is acknowledged by history, even after a newer version', async (t) => {
  const { client, setNetwork } = await fixture(t);
  const bytes = new Uint8Array(randomBytes(3 * MiB));
  const prepared = await client.prepareWrite('attachments/lost.bin', bytes, 0);
  setNetwork(async (url, options) => {
    const response = await fetch(url, options);
    if (options.method === 'PUT' && /\/objects\/[0-9a-f]{64}$/.test(url)) { await response.text(); throw new TypeError('Synthetic lost answer'); }
    return response;
  });
  await assert.rejects(client.commitWrite(prepared, { source: bytes }), /lost answer/);
  setNetwork((url, options) => fetch(url, options));
  await client.write('attachments/lost.bin', text('newer'), 1);
  assert.equal((await client.commitWrite(prepared, { source: bytes })).revision, 1);
  assert.equal((await client.history(prepared.id)).versions.length, 2);
  // A different draft on the old base is a real conflict.
  const stale = await client.prepareWrite('attachments/lost.bin', text('stale'), 0);
  await assert.rejects(client.commitWrite(stale, { source: text('stale') }), (error) => error.status === 409 && error.currentRevision === 2);
});

test('trash, restore and history reuse the pieces without counting them twice', async (t) => {
  const { client, requests } = await fixture(t);
  const first = new Uint8Array(randomBytes(3 * MiB));
  const saved = await client.write('attachments/photo.jpg', first, 0);
  const used = (await client.status()).usedBytes;
  // Only the last piece changes: the first two are the same bytes and are not stored again.
  const second = first.slice();
  second[second.length - 1] ^= 1;
  requests.length = 0;
  await client.write('attachments/photo.jpg', second, 1);
  assert.equal(pieceRequests(requests, 'PUT').length, 1);
  assert.ok((await client.status()).usedBytes < used + MiB + 4096);
  await client.remove(saved.id, 2);
  await client.restore(saved.id, 1, 3);
  assert.deepEqual((await client.read(saved.id)).file.bytes, first);
  assert.deepEqual((await client.read(saved.id, 2)).file.bytes, second);
  assert.ok((await client.status()).usedBytes < used + MiB + 4096);
});

test('pieces that no version uses are cleared after a day', async (t) => {
  const { client, advance } = await fixture(t);
  const bytes = new Uint8Array(randomBytes(2 * MiB));
  const prepared = await client.prepareWrite('attachments/abandoned.bin', bytes, 0);
  const id = prepared.id, { vaultKey, vaultId } = client.credentials;
  for (const [index, name] of prepared.chunks.entries()) await client.call(`/chunks/${name}`, 'PUT', await encryptChunk(vaultKey, vaultId, id, index, bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)), { binary: true });
  assert.ok((await client.status()).usedBytes >= 2 * MiB);
  advance(24 * 60 * 60 * 1000 + 1);
  await client.write('notes/later.md', text('A later save clears what was left behind'), 0);
  assert.ok((await client.status()).usedBytes < 4096);
  assert.deepEqual((await client.call('/chunks/missing', 'POST', { names: prepared.chunks })).missing, prepared.chunks);
});

test('a piece only opens for its own file and place, and the server checks its name', async (t) => {
  const { client } = await fixture(t);
  const { vaultKey, vaultId } = client.credentials;
  const id = await objectId(vaultKey, 'attachments/a.bin');
  const sealed = await encryptChunk(vaultKey, vaultId, id, 0, text('piece zero'));
  assert.deepEqual(await decryptChunk(vaultKey, vaultId, id, 0, sealed), text('piece zero'));
  await assert.rejects(decryptChunk(vaultKey, vaultId, id, 1, sealed));
  await assert.rejects(decryptChunk(vaultKey, vaultId, await objectId(vaultKey, 'attachments/b.bin'), 0, sealed));
  await assert.rejects(client.call(`/chunks/${'0'.repeat(64)}`, 'PUT', sealed, { binary: true }), (error) => error.status === 400);
  // A manifest naming a piece that was never uploaded is refused.
  const prepared = await client.prepareWrite('attachments/a.bin', new Uint8Array(randomBytes(MiB + 1)), 0);
  await assert.rejects(client.call(`/objects/${prepared.id}`, 'PUT', { baseRevision: 0, envelope: prepared.envelope, chunks: prepared.chunks }), (error) => error.status === 409);
});

test('files saved before pieces still read, with a fingerprint for comparing', async (t) => {
  const { client } = await fixture(t);
  const { vaultKey, vaultId } = client.credentials, path = 'notes/old.md', id = await objectId(vaultKey, path);
  const envelope = await encryptEnvelope(vaultKey, { path, content: bytesToBase64(text('# Old format')), modifiedAt: new Date().toISOString() }, `jotdrop:object:v1:${vaultId}:${id}`);
  await client.commitWrite({ id, baseRevision: 0, envelope: JSON.stringify(envelope) });
  const { manifest } = await client.readManifest(id);
  assert.deepEqual([manifest.size, manifest.hash], [12, await sha256Hex(text('# Old format'))]);
  assert.equal(new TextDecoder().decode((await client.read(id)).file.bytes), '# Old format');
});

test('a full free cloud makes room by clearing the pieces of old locked versions', async (t) => {
  const { client, advance } = await fixture(t, { quotaBytes: 5 * MiB });
  const first = new Uint8Array(randomBytes(2 * MiB)), second = new Uint8Array(randomBytes(2 * MiB));
  await client.write('attachments/big.bin', first, 0);
  await client.write('attachments/big.bin', second, 1);
  // Older than the free history: the first version is locked and may be cleared when room is needed.
  advance(31 * 24 * 60 * 60 * 1000);
  const third = new Uint8Array(randomBytes(2 * MiB));
  const saved = await client.write('attachments/big.bin', third, 2);
  assert.equal(saved.revision, 3);
  const status = await client.status();
  assert.ok(status.usedBytes <= 5 * MiB && status.usedBytes >= 4 * MiB, `used ${status.usedBytes}`);
  assert.deepEqual((await client.read(saved.id)).file.bytes, third);
  assert.deepEqual((await client.read(saved.id, 2)).file.bytes, second);
});

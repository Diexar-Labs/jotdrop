import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { request } from 'node:http';
import { createCloudServer } from './server.mjs';
import { backupCloudDatabase } from './backup.mjs';
import { CloudClient } from './shared/client.mjs';
import { base64ToBytes, bytesToBase64, encryptEnvelope, objectId, randomToken } from './shared/crypto.mjs';

// The v1 single-envelope draft that devices made before encrypted pieces; the server still accepts it.
async function legacyPrepare(client, path, bytes, baseRevision) {
  const { vaultKey, vaultId } = client.credentials, id = await objectId(vaultKey, path);
  const envelope = await encryptEnvelope(vaultKey, { path, content: bytesToBase64(bytes), modifiedAt: new Date().toISOString() }, `jotdrop:object:v1:${vaultId}:${id}`);
  return { id, baseRevision, envelope: JSON.stringify(envelope) };
}

function uploadRequest(client, prepared) {
  const envelope = JSON.parse(prepared.envelope);
  const wire = Buffer.concat([Buffer.from(base64ToBytes(envelope.iv)), Buffer.from(base64ToBytes(envelope.ciphertext))]);
  const digest = createHash('sha256').update(prepared.envelope).digest('hex');
  const route = `/objects/${prepared.id}/uploads/${prepared.baseRevision}/${digest}`;
  const headers = { Authorization: `Bearer ${client.credentials.token}`, 'X-JotDrop-Vault': client.credentials.vaultId, 'X-JotDrop-Device': client.credentials.deviceId, 'Content-Type': 'application/octet-stream' };
  return { wire, route, put: (bytes, offset = 0, extra = {}) => fetch(`${client.credentials.url}/api/v1${route}?offset=${offset}`, { method: 'PUT', headers: { ...headers, ...extra }, body: bytes }) };
}

test('opt-in binary upload resumes after interruption and restart without changing v1 ciphertext', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-transfer-'));
  const enrollmentToken = randomToken();
  let app = await createCloudServer({ dataDir, enrollmentToken });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { client } = await CloudClient.create({ url: `http://127.0.0.1:${app.port}`, enrollmentToken, deviceName: 'Synthetic transfer' });
  const bytes = randomBytes(4 * 1024 * 1024);
  const prepared = await legacyPrepare(client, 'attachments/synthetic.bin', bytes, 0);
  const controller = new AbortController(), progress = [];
  await assert.rejects(client.commitWrite(prepared, { resumable: true, signal: controller.signal, onProgress(event) {
    progress.push(event);
    if (event.transferredBytes > 0) controller.abort();
  } }));
  assert.equal(progress.at(-1).transferredBytes, 65536);
  assert.equal((await client.listChanges()).changes.length, 0);
  await app.close();
  app = await createCloudServer({ dataDir, enrollmentToken });
  const reopened = new CloudClient({ ...client.credentials, url: `http://127.0.0.1:${app.port}` });
  const resumed = [];
  const saved = await reopened.commitWrite(prepared, { resumable: true, onProgress: (event) => resumed.push(event) });
  assert.equal(resumed[0].transferredBytes, 65536);
  assert.equal(resumed.at(-1).phase, 'committed');
  assert.ok(resumed.at(-1).totalBytes < Buffer.byteLength(prepared.envelope) * 0.76);
  assert.equal((await reopened.read(saved.id)).envelope, prepared.envelope);
  assert.deepEqual(Buffer.from(base64ToBytes((await reopened.read(saved.id)).file.content)), bytes);
  assert.deepEqual(await reopened.commitWrite(prepared, { resumable: true }), saved);
  assert.equal((await reopened.history(saved.id)).versions.length, 1);
  assert.equal(app.server.requestTimeout, 30000);
});

test('hard process kill during an incomplete chunk preserves only acknowledged bytes for resume', { timeout: 20000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-transfer-kill-'));
  const enrollmentToken = randomToken();
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { createCloudServer } = await import(${JSON.stringify(new URL('./server.mjs', import.meta.url).href)});
    const app = await createCloudServer({ dataDir: process.env.JOTDROP_TEST_DATA_DIR, enrollmentToken: process.env.JOTDROP_TEST_ENROLLMENT });
    app.server.on('request', (req) => {
      if (req.method === 'PUT' && req.url.endsWith('?offset=65536')) req.once('data', (bytes) => process.send({ receivedBytes: bytes.length }));
    });
    process.send({ port: app.port });
  `], { env: { ...process.env, JOTDROP_TEST_DATA_DIR: dataDir, JOTDROP_TEST_ENROLLMENT: enrollmentToken }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  let app, pending;
  t.after(async () => {
    pending?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const [{ port }] = await once(child, 'message', { signal: t.signal });
  const url = `http://127.0.0.1:${port}`;
  const { client } = await CloudClient.create({ url, enrollmentToken, deviceName: 'Synthetic crash test' });
  const bytes = randomBytes(128 * 1024);
  const prepared = await legacyPrepare(client, 'attachments/process-kill.bin', bytes, 0);
  const { wire, route, put } = uploadRequest(client, prepared);
  await client.call(route, 'POST', { size: wire.length });
  assert.equal((await put(wire.subarray(0, 65536))).status, 200);
  const received = once(child, 'message', { signal: t.signal });
  let acknowledged = false;
  pending = request(`${url}/api/v1${route}?offset=65536`, { method: 'PUT', headers: {
    Authorization: `Bearer ${client.credentials.token}`, 'X-JotDrop-Vault': client.credentials.vaultId,
    'X-JotDrop-Device': client.credentials.deviceId, 'Content-Type': 'application/octet-stream', 'Content-Length': 65536,
  } }, (response) => { acknowledged = true; response.resume(); });
  pending.on('error', () => {}); // The unfinished socket is expected to break when the child is killed.
  pending.write(wire.subarray(65536, 65536 + 32768));
  const [{ receivedBytes }] = await received;
  assert.ok(receivedBytes > 0 && receivedBytes < 65536, 'Kill only after the server actually receives part of the next chunk');
  assert.equal(child.kill('SIGKILL'), true);
  await exited;
  assert.equal(acknowledged, false);
  pending.destroy();
  app = await createCloudServer({ dataDir, enrollmentToken });
  const reopened = new CloudClient({ ...client.credentials, url: `http://127.0.0.1:${app.port}` });
  assert.deepEqual(await reopened.call(route), { offset: 65536, size: wire.length });
  assert.equal((await reopened.listChanges()).changes.length, 0);
  assert.equal((await reopened.status()).transport.reservedBytes, Buffer.byteLength(prepared.envelope));
  const progress = [];
  const saved = await reopened.commitWrite(prepared, { resumable: true, onProgress: (event) => progress.push(event) });
  assert.equal(progress[0].transferredBytes, 65536);
  assert.equal((await reopened.read(saved.id)).envelope, prepared.envelope);
  assert.deepEqual(Buffer.from(base64ToBytes((await reopened.read(saved.id)).file.content)), bytes);
  assert.equal((await reopened.history(saved.id)).versions.length, 1);
  assert.equal((await reopened.status()).transport.reservedBytes, 0);
  const db = new DatabaseSync(app.dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('binary upload verifies complete ciphertext before publishing and isolates device-owned staging', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-transfer-boundary-'));
  const enrollmentToken = randomToken();
  const app = await createCloudServer({ dataDir, enrollmentToken, enrollmentLimit: 2 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  const { client } = await CloudClient.create({ url, enrollmentToken, deviceName: 'Owner' });
  const peer = await CloudClient.claim({ pairingCode: (await client.makePairing('Other device')).pairingCode });
  const prepared = await legacyPrepare(client, 'notes/test.md', new TextEncoder().encode('Synthetic private bytes'), 0);
  const { wire, route, put } = uploadRequest(client, prepared);
  assert.deepEqual(await client.call(route, 'POST', { size: wire.length }), { offset: 0, size: wire.length });
  await assert.rejects(peer.call(route), (error) => error.status === 404);
  await assert.rejects(client.call(`${route}/commit`, 'POST', {}), (error) => error.status === 409);
  const altered = Buffer.from(wire); altered[altered.length - 1] ^= 1;
  assert.equal((await put(altered)).status, 200);
  await assert.rejects(client.call(`${route}/commit`, 'POST', {}), (error) => error.status === 400);
  assert.equal((await client.listChanges()).changes.length, 0);
  assert.equal((await client.status()).usedBytes, 0);
  await peer.discardWrite(prepared);
  assert.equal((await client.call(route)).offset, wire.length, 'Another device cannot discard this staging upload');
  await client.discardWrite(prepared);
  await client.discardWrite(prepared);
  assert.equal((await client.status()).transport.reservedBytes, 0);
  assert.equal((await client.commitWrite(prepared, { resumable: true })).revision, 1);
  await client.discardWrite(prepared);
  assert.equal((await client.history(prepared.id)).versions.length, 1, 'Discard never deletes a committed version');
  assert.equal((await peer.read(prepared.id)).envelope, prepared.envelope);
});

test('binary staging enforces byte limits, offsets, retry identity, auth, expiry and reserved quota', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-transfer-limits-'));
  const enrollmentToken = randomToken();
  let time = Date.now();
  const app = await createCloudServer({ dataDir, enrollmentToken, quotaBytes: 1024, enrollmentLimit: 2, clock: () => time });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  const { client } = await CloudClient.create({ url, enrollmentToken, deviceName: 'Owner' });
  const { client: other } = await CloudClient.create({ url, enrollmentToken, deviceName: 'Other vault' });
  const prepared = await legacyPrepare(client, 'notes/quota.md', new TextEncoder().encode('x'.repeat(300)), 0);
  const { wire, route, put } = uploadRequest(client, prepared);
  for (const size of [0, 27, -1, 1.5, '100', 6 * 1024 * 1024, 6 * 1024 * 1024 + 1]) {
    await assert.rejects(client.call(route, 'POST', { size }), (error) => error.status === 400);
  }
  await client.call(route, 'POST', { size: wire.length });
  assert.equal((await client.status()).transport.reservedBytes, Buffer.byteLength(prepared.envelope));
  await assert.rejects(client.write('notes/also-full.md', new TextEncoder().encode('x'.repeat(300)), 0), (error) => error.status === 507);
  await assert.rejects(other.call(route), (error) => error.status === 404);
  assert.equal((await put(wire, 0, { Authorization: `Bearer ${randomToken()}` })).status, 401);
  assert.equal((await put(wire, 0, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await put(wire, 0, { 'Content-Type': 'application/json' })).status, 400);
  assert.equal((await put(Buffer.alloc(65537))).status, 413);
  assert.equal((await put(wire, 1)).status, 409);
  assert.equal((await put(wire, '01')).status, 400);
  assert.equal((await put(Buffer.concat([wire, Buffer.from([0])]))).status, 409);
  assert.equal((await put(wire.subarray(0, 10))).status, 200);
  assert.equal((await put(wire.subarray(0, 10))).status, 200);
  assert.equal((await put(Buffer.alloc(10))).status, 400);
  assert.deepEqual(await client.call(route), { offset: 10, size: wire.length });
  time += 24 * 60 * 60 * 1000;
  await assert.rejects(client.call(route), (error) => error.status === 410);
  assert.equal((await put(wire.subarray(10), 10)).status, 410);
  assert.deepEqual(await client.call(route, 'POST', { size: wire.length }), { offset: 0, size: wire.length });
  assert.equal((await put(wire)).status, 200);
  const result = await client.call(`${route}/commit`, 'POST', {});
  assert.equal(result.committed.revision, 1);
  assert.equal((await client.status()).transport.reservedBytes, 0);
  assert.equal((await client.status()).usedBytes, Buffer.byteLength(prepared.envelope));
});

test('pending upload slots are bounded and failed publication keeps resumable bytes without history', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-transfer-atomic-'));
  const enrollmentToken = randomToken();
  const app = await createCloudServer({ dataDir, enrollmentToken });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { client } = await CloudClient.create({ url: `http://127.0.0.1:${app.port}`, enrollmentToken, deviceName: 'Owner' });
  const uploads = [];
  for (let i = 0; i < 5; i++) {
    const prepared = await legacyPrepare(client, `notes/slot${i}.md`, new TextEncoder().encode('Synthetic draft'), 0);
    const request = uploadRequest(client, prepared);
    uploads.push({ ...request, prepared });
    if (i < 4) await client.call(request.route, 'POST', { size: request.wire.length });
    else await assert.rejects(client.call(request.route, 'POST', { size: request.wire.length }), (error) => error.status === 507);
  }
  const first = uploads[0];
  assert.equal((await first.put(first.wire)).status, 200);
  const db = new DatabaseSync(app.dbPath);
  try {
    db.exec("CREATE TRIGGER fail_transfer BEFORE INSERT ON changes BEGIN SELECT RAISE(ABORT, 'Synthetic commit failure'); END;");
    await assert.rejects(client.call(`${first.route}/commit`, 'POST', {}), (error) => error.status === 500);
    assert.deepEqual(await client.call(first.route), { offset: first.wire.length, size: first.wire.length });
    assert.equal((await client.listChanges()).changes.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM uploads').get().count, 4);
    db.exec('DROP TRIGGER fail_transfer');
    const saved = (await client.call(`${first.route}/commit`, 'POST', {})).committed;
    await client.write('notes/slot0.md', new TextEncoder().encode('Newer immutable version'), 1);
    assert.deepEqual((await client.call(`${first.route}/commit`, 'POST', {})).committed, saved);
    assert.equal((await client.history(first.prepared.id)).versions.length, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM uploads').get().count, 3);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    await client.call(uploads[4].route, 'POST', { size: uploads[4].wire.length });
  } finally { db.close(); }
});

test('lost start, chunk and commit responses retry identically and publish exactly one revision', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-transfer-acks-'));
  const enrollmentToken = randomToken();
  const app = await createCloudServer({ dataDir, enrollmentToken });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { client } = await CloudClient.create({ url: `http://127.0.0.1:${app.port}`, enrollmentToken, deviceName: 'Owner' });
  const lost = new Set(), sent = [], progress = [];
  const retrying = new CloudClient({ ...client.credentials, fetcher: async (url, options) => {
    const response = await fetch(url, options);
    if (!url.includes('/uploads/')) return response;
    const stage = options.method === 'PUT' ? 'chunk' : url.endsWith('/commit') ? 'commit' : 'start';
    if (stage === 'chunk') sent.push({ offset: Number(new URL(url).searchParams.get('offset')), bytes: Buffer.from(options.body) });
    if (!lost.has(stage)) { lost.add(stage); await response.arrayBuffer(); throw new TypeError('Synthetic lost response'); }
    return response;
  } });
  const prepared = await legacyPrepare(retrying, 'attachments/retry.bin', randomBytes(128 * 1024), 0);
  const result = await retrying.commitWrite(prepared, { resumable: true, onProgress: (event) => progress.push(event) });
  assert.deepEqual([...lost].sort(), ['chunk', 'commit', 'start']);
  assert.equal(sent[0].offset, 0);
  assert.equal(sent[1].offset, 0);
  assert.deepEqual(sent[0].bytes, sent[1].bytes);
  assert.ok(sent.every((entry) => entry.bytes.length <= 65536));
  assert.ok(progress.every((event, index) => !index || event.transferredBytes >= progress[index - 1].transferredBytes));
  assert.equal((await client.read(result.id)).envelope, prepared.envelope);
  assert.equal((await client.listChanges()).changes.length, 1);
});

test('WAL backup restores a partial upload into an independent database with its authorization', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-transfer-backup-'));
  const restoredDir = await mkdtemp(join(tmpdir(), 'jotdrop-transfer-restored-'));
  const enrollmentToken = randomToken();
  const app = await createCloudServer({ dataDir, enrollmentToken });
  let restored;
  t.after(async () => { await restored?.close(); await app.close(); await rm(dataDir, { recursive: true, force: true }); await rm(restoredDir, { recursive: true, force: true }); });
  const { client } = await CloudClient.create({ url: `http://127.0.0.1:${app.port}`, enrollmentToken, deviceName: 'Owner' });
  const prepared = await legacyPrepare(client, 'attachments/backup.bin', randomBytes(128 * 1024), 0);
  const { wire, route, put } = uploadRequest(client, prepared);
  await client.call(route, 'POST', { size: wire.length });
  assert.equal((await put(wire.subarray(0, 65536))).status, 200);
  await backupCloudDatabase(app.dbPath, join(restoredDir, 'cloud.db'));
  restored = await createCloudServer({ dataDir: restoredDir, enrollmentToken: randomToken() });
  const recovered = new CloudClient({ ...client.credentials, url: `http://127.0.0.1:${restored.port}` });
  assert.deepEqual(await recovered.call(route), { offset: 65536, size: wire.length });
  assert.equal((await recovered.commitWrite(prepared, { resumable: true })).revision, 1);
  assert.equal((await recovered.read(prepared.id)).envelope, prepared.envelope);
  assert.deepEqual(await client.call(route), { offset: 65536, size: wire.length });
  assert.equal((await client.listChanges()).changes.length, 0);
});

test('device revocation clears reservations atomically without deleting history or waiting for TTL', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-transfer-revoke-slots-'));
  const enrollmentToken = randomToken(), time = Date.now();
  const app = await createCloudServer({ dataDir, enrollmentToken, clock: () => time });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { client } = await CloudClient.create({ url: `http://127.0.0.1:${app.port}`, enrollmentToken, deviceName: 'Owner' });
  const peer = await CloudClient.claim({ pairingCode: (await client.makePairing('To revoke')).pairingCode });
  const committed = await legacyPrepare(peer, 'notes/committed.md', new TextEncoder().encode('Keep immutable history'), 0);
  await peer.commitWrite(committed, { resumable: true });
  const before = await client.status(), pending = [];
  for (let index = 0; index < 4; index++) {
    const prepared = await legacyPrepare(peer, `notes/pending-${index}.md`, new TextEncoder().encode('Unfinished draft'), 0);
    const upload = uploadRequest(peer, prepared);
    await peer.call(upload.route, 'POST', { size: upload.wire.length });
    pending.push(upload);
  }
  const next = await legacyPrepare(client, 'notes/owner.md', new TextEncoder().encode('Owner can continue'), 0);
  await assert.rejects(client.commitWrite(next, { resumable: true }), (error) => error.status === 507);
  const db = new DatabaseSync(app.dbPath);
  try {
    db.exec("CREATE TRIGGER fail_revoke_cleanup BEFORE DELETE ON uploads BEGIN SELECT RAISE(ABORT, 'Synthetic cleanup failure'); END;");
    await assert.rejects(client.revokeDevice(peer.credentials.deviceId), (error) => error.status === 500);
    assert.equal(db.prepare('SELECT revoked FROM devices WHERE id=?').get(peer.credentials.deviceId).revoked, 0, 'Cleanup failure must roll back revocation');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM uploads WHERE deviceId=?').get(peer.credentials.deviceId).count, 4);
    db.exec('DROP TRIGGER fail_revoke_cleanup');
    await client.revokeDevice(peer.credentials.deviceId);
    assert.equal((await client.status()).transport.reservedBytes, 0);
    assert.equal((await client.status()).usedBytes, before.usedBytes);
    assert.equal((await client.read(committed.id)).envelope, committed.envelope);
    assert.equal((await client.history(committed.id)).versions.length, 1);
    assert.equal((await client.commitWrite(next, { resumable: true })).revision, 1);
    for (const upload of pending) assert.equal((await upload.put(upload.wire)).status, 401);
    const active = uploadRequest(client, await legacyPrepare(client, 'notes/still-active.md', new Uint8Array(1), 0));
    await client.call(active.route, 'POST', { size: active.wire.length });
    await client.revokeDevice(peer.credentials.deviceId);
    assert.equal((await client.call(active.route)).offset, 0, 'Repeated revoke must preserve other devices staging');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { db.close(); }
});

test('device revocation while a chunk body is in flight prevents storing any new bytes', { timeout: 5000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-transfer-revoke-'));
  const enrollmentToken = randomToken();
  const app = await createCloudServer({ dataDir, enrollmentToken });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  const { client } = await CloudClient.create({ url, enrollmentToken, deviceName: 'Owner' });
  const peer = await CloudClient.claim({ pairingCode: (await client.makePairing('To revoke')).pairingCode });
  const prepared = await legacyPrepare(peer, 'notes/revoked.md', new TextEncoder().encode('Synthetic revoked draft'), 0);
  const { wire, route } = uploadRequest(peer, prepared);
  await peer.call(route, 'POST', { size: wire.length });
  const received = new Promise((done) => app.server.once('request', done));
  let pending;
  const response = new Promise((done, reject) => {
    pending = request(`${url}/api/v1${route}?offset=0`, { method: 'PUT', headers: { Authorization: `Bearer ${peer.credentials.token}`, 'X-JotDrop-Vault': peer.credentials.vaultId, 'X-JotDrop-Device': peer.credentials.deviceId, 'Content-Type': 'application/octet-stream', 'Content-Length': wire.length } }, (res) => { res.resume(); res.on('end', () => done(res.statusCode)); });
    pending.on('error', reject);
    pending.write(wire.subarray(0, 1));
  });
  t.after(() => pending.destroy());
  await received;
  await client.revokeDevice(peer.credentials.deviceId);
  pending.end(wire.subarray(1));
  assert.equal(await response, 401);
  const db = new DatabaseSync(app.dbPath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM uploads WHERE deviceId=?').get(peer.credentials.deviceId).count, 0); }
  finally { db.close(); }
});

test('reservations are atomic across connections and stale uploads never overwrite a legacy edit', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-transfer-races-'));
  const enrollmentToken = randomToken();
  const app = await createCloudServer({ dataDir, enrollmentToken, quotaBytes: 1024 });
  const peer = await createCloudServer({ dataDir, enrollmentToken, quotaBytes: 1024 });
  t.after(async () => { await peer.close(); await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { client } = await CloudClient.create({ url: `http://127.0.0.1:${app.port}`, enrollmentToken, deviceName: 'Owner' });
  const second = new CloudClient({ ...client.credentials, url: `http://127.0.0.1:${peer.port}` });
  const a = await legacyPrepare(client, 'notes/a.md', new TextEncoder().encode('x'.repeat(300)), 0);
  const b = await legacyPrepare(second, 'notes/b.md', new TextEncoder().encode('y'.repeat(300)), 0);
  const first = uploadRequest(client, a), next = uploadRequest(second, b);
  const results = await Promise.allSettled([client.call(first.route, 'POST', { size: first.wire.length }), second.call(next.route, 'POST', { size: next.wire.length })]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.status === 507).length, 1);
  await (results[0].status === 'fulfilled' ? client.call(first.route, 'DELETE') : second.call(next.route, 'DELETE'));
  const small = await legacyPrepare(client, 'notes/concurrent.md', new TextEncoder().encode('Old pending draft'), 0);
  const pending = uploadRequest(client, small);
  await client.call(pending.route, 'POST', { size: pending.wire.length });
  assert.equal((await pending.put(pending.wire)).status, 200);
  await second.write('notes/concurrent.md', new TextEncoder().encode('New legacy edit'), 0);
  await assert.rejects(client.call(`${pending.route}/commit`, 'POST', {}), (error) => error.status === 409 && error.currentRevision === 1);
  assert.deepEqual(await client.call(pending.route), { offset: pending.wire.length, size: pending.wire.length });
  assert.equal((await client.history(small.id)).versions.length, 1);
  assert.equal(new TextDecoder().decode(base64ToBytes((await client.read(small.id)).file.content)), 'New legacy edit');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCloudServer } from './server.mjs';
import { setPlusUntil } from './set-plus.mjs';
import { CloudClient } from './shared/client.mjs';
import { base64ToBytes, decodeRecovery, hashToken, randomToken } from './shared/crypto.mjs';

const DAY = 24 * 60 * 60 * 1000;
const text = (value) => new TextEncoder().encode(value);

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-plans-test-'));
  const enrollmentToken = randomToken();
  let now = Date.parse('2026-10-23T08:00:00Z'), app;
  const clock = () => now;
  const start = async (extra = {}) => { app = await createCloudServer({ dataDir, enrollmentToken, enrollmentLimit: 2, clock, ...options, ...extra }); return app; };
  await start();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = () => `http://127.0.0.1:${app.port}`;
  const post = async (path, body) => {
    const response = await fetch(`${url()}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const create = async () => CloudClient.create({ url: url(), enrollmentToken, deviceName: 'Phone' });
  const restart = async (extra) => { await app.close(); await start(extra); };
  const reconnect = (client) => new CloudClient({ ...client.credentials, url: url() });
  return { dataDir, url, post, create, restart, reconnect, app: () => app, advance: (ms) => { now += ms; } };
}

const trial = (client) => client.call('/account/trial', 'POST', {});

test('free plan allows two devices; a new device can replace a lost one; Plus allows more', async (t) => {
  const cloud = await fixture(t);
  const { client: phone, recoveryCode } = await cloud.create();
  const laptop = await CloudClient.claim({ pairingCode: (await phone.makePairing('Laptop')).pairingCode });
  await assert.rejects(phone.makePairing('Tablet'), (error) => error.status === 403);

  const recovery = decodeRecovery(recoveryCode), deviceToken = randomToken();
  const request = { vaultId: recovery.vaultId, recoveryToken: recovery.recoveryToken, deviceName: 'New phone', deviceTokenHash: await hashToken(deviceToken) };
  const blocked = await cloud.post('/recover', request);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'device-limit');
  assert.equal(blocked.body.deviceLimit, 2);
  assert.deepEqual(blocked.body.devices.map((device) => device.name).sort(), ['Laptop', 'Phone']);
  const replaced = await cloud.post('/recover', { ...request, replaceDeviceId: phone.credentials.deviceId });
  assert.equal(replaced.status, 201);
  await assert.rejects(phone.status(), (error) => error.status === 401);
  const devices = (await laptop.devices()).devices;
  assert.equal(devices.filter((device) => !device.revoked).length, 2);

  await trial(laptop);
  const tablet = await CloudClient.claim({ pairingCode: (await laptop.makePairing('Tablet')).pairingCode });
  assert.equal((await tablet.status()).plan.deviceLimit, null);
  // After Plus ends the extra device keeps working; only new devices are blocked.
  cloud.advance(15 * DAY);
  assert.equal((await tablet.status()).plan.name, 'free');
  await assert.rejects(laptop.makePairing('Work PC'), (error) => error.status === 403);
});

test('storage limit follows the plan', async (t) => {
  const cloud = await fixture(t);
  const { client } = await cloud.create();
  await client.write('notes/a.md', text('a'.repeat(400)), 0);
  const used = (await client.status()).usedBytes;
  await cloud.restart({ quotaBytes: used + 100, plusQuotaBytes: used * 10 });
  const reopened = cloud.reconnect(client);
  assert.equal((await reopened.status()).quotaBytes, used + 100);
  await assert.rejects(reopened.write('notes/b.md', text('b'.repeat(400)), 0), (error) => error.status === 507);
  await trial(reopened);
  assert.equal((await reopened.status()).quotaBytes, used * 10);
  await reopened.write('notes/b.md', text('b'.repeat(400)), 0);
  // Back on the free plan nothing is deleted; only new uploads stop.
  cloud.advance(15 * DAY);
  await assert.rejects(reopened.write('notes/c.md', text('c'.repeat(400)), 0), (error) => error.status === 507);
  assert.equal((await reopened.status()).usedBytes, used * 2);
});

test('free plan locks versions replaced more than 30 days ago; Plus and 90 days after Plus unlock them', async (t) => {
  const cloud = await fixture(t);
  const { client } = await cloud.create();
  const first = await client.write('notes/list.md', text('milk'), 0);
  cloud.advance(50 * DAY);
  await client.write('notes/list.md', text('milk, eggs'), 1);
  cloud.advance(10 * DAY);
  // Written 60 days ago but replaced only 10 days ago: still within the free 30 days.
  assert.equal((await client.read(first.id, 1)).revision, 1);
  await client.write('notes/list.md', text('milk, eggs, bread'), 2);
  cloud.advance(31 * DAY);
  const history = (await client.history(first.id)).versions;
  assert.deepEqual(history.map((version) => [version.revision, version.locked]), [[3, false], [2, true], [1, true]]);
  await assert.rejects(client.read(first.id, 2), (error) => error.status === 402);
  await assert.rejects(client.restore(first.id, 1, 3), (error) => error.status === 402);
  assert.equal((await client.read(first.id)).revision, 3);

  await trial(client);
  assert.equal((await client.read(first.id, 1)).revision, 1);
  cloud.advance(14 * DAY + 89 * DAY);
  assert.equal((await client.status()).plan.name, 'free');
  assert.equal((await client.history(first.id)).versions[2].locked, false);
  cloud.advance(2 * DAY);
  await assert.rejects(client.read(first.id, 1), (error) => error.status === 402);
});

test('a full free cloud deletes the oldest locked versions, never the current files', async (t) => {
  const cloud = await fixture(t);
  const { client } = await cloud.create();
  const saved = await client.write('notes/a.md', text('1'.repeat(400)), 0);
  await client.write('notes/a.md', text('2'.repeat(400)), 1);
  await client.write('notes/a.md', text('3'.repeat(400)), 2);
  const used = (await client.status()).usedBytes;
  await cloud.restart({ quotaBytes: used + 100 });
  const reopened = cloud.reconnect(client);
  await assert.rejects(reopened.write('notes/b.md', text('b'.repeat(400)), 0), (error) => error.status === 507);
  cloud.advance(31 * DAY);
  await reopened.write('notes/b.md', text('b'.repeat(400)), 0);
  // One old version was enough room: revision 1 went first, revision 2 stayed.
  assert.deepEqual((await reopened.history(saved.id)).versions.map((version) => version.revision), [3, 2]);
  assert.equal((await reopened.read(saved.id)).revision, 3);
  const status = await reopened.status();
  assert.ok(status.usedBytes <= status.quotaBytes);
});

test('eviction skips shared versions, deletes nothing when it cannot make room, and never runs for Plus', async (t) => {
  const cloud = await fixture(t);
  const { client } = await cloud.create();
  const saved = await client.write('notes/a.md', text('1'.repeat(400)), 0);
  await client.write('notes/a.md', text('2'.repeat(400)), 1);
  // Revision 3 restores revision 1 and shares its envelope, so deleting revision 1 frees nothing.
  await client.restore(saved.id, 1, 2);
  const used = (await client.status()).usedBytes;
  await cloud.restart({ quotaBytes: used + 100, plusQuotaBytes: used + 100 });
  const reopened = cloud.reconnect(client);
  cloud.advance(31 * DAY);
  const big = text('b'.repeat(2000));
  await assert.rejects(reopened.write('notes/big.md', big, 0), (error) => error.status === 507);
  assert.deepEqual((await reopened.history(saved.id)).versions.map((version) => version.revision), [3, 2, 1]);

  await trial(reopened);
  await assert.rejects(reopened.write('notes/b.md', text('b'.repeat(400)), 0), (error) => error.status === 507);
  assert.deepEqual((await reopened.history(saved.id)).versions.map((version) => version.revision), [3, 2, 1]);
  cloud.advance(15 * DAY + 91 * DAY);
  await reopened.write('notes/b.md', text('b'.repeat(400)), 0);
  assert.deepEqual((await reopened.history(saved.id)).versions.map((version) => version.revision), [3, 1]);
  assert.equal(new TextDecoder().decode(base64ToBytes((await reopened.read(saved.id)).file.content)), '1'.repeat(400));
});

test('at the device limit a wrong secret still fails as 401, and no pairing code is made', async (t) => {
  const cloud = await fixture(t);
  const { client: phone, recoveryCode } = await cloud.create();
  await CloudClient.claim({ pairingCode: (await phone.makePairing('Laptop')).pairingCode });
  await assert.rejects(phone.makePairing('Tablet'), (error) => error.status === 403 && error.code === 'device-limit');
  const recovery = decodeRecovery(recoveryCode);
  const wrong = await cloud.post('/recover', { vaultId: recovery.vaultId, recoveryToken: randomToken(), deviceName: 'Thief', deviceTokenHash: await hashToken(randomToken()) });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.devices, undefined);
});

test('the free trial runs 14 days once per cloud', async (t) => {
  const cloud = await fixture(t);
  const { client } = await cloud.create();
  const free = (await client.status()).plan;
  assert.deepEqual(free, { name: 'free', plusUntil: null, trialAvailable: true, deviceLimit: 2, historyDays: 30 });
  const started = await trial(client);
  assert.equal(started.plusUntil, '2026-11-06T08:00:00.000Z');
  assert.deepEqual((await client.status()).plan, { name: 'plus', plusUntil: '2026-11-06T08:00:00.000Z', trialAvailable: false, deviceLimit: null, historyDays: null });
  await assert.rejects(trial(client), (error) => error.status === 409);
  cloud.advance(15 * DAY);
  assert.equal((await client.status()).plan.trialAvailable, false);
  await assert.rejects(trial(client), (error) => error.status === 409);
});

test('set-plus gives a cloud Plus until a date, or ends it', async (t) => {
  const cloud = await fixture(t);
  const { client } = await cloud.create();
  const dbPath = cloud.app().dbPath;
  setPlusUntil(dbPath, client.credentials.vaultId, Date.parse('2027-10-23T00:00:00Z'));
  assert.equal((await client.status()).plan.plusUntil, '2027-10-23T00:00:00.000Z');
  setPlusUntil(dbPath, client.credentials.vaultId, 0);
  assert.equal((await client.status()).plan.name, 'free');
  assert.throws(() => setPlusUntil(dbPath, 'nobody@example.com', 0), /No cloud/);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT trialUsed FROM plans').get().trialUsed, 0); } finally { db.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCloudServer } from './server.mjs';
import { CloudClient, identifyClient } from './shared/client.mjs';
import { encryptEnvelope, generateVaultKey, hashToken, randomToken } from './shared/crypto.mjs';
import { decideKeySync, openKey, readSharedKey, removeSharedKey, saveSharedKey, sealKey } from './shared/ai/keysync.mjs';

// Ask JotDrop, "Use this key on all my devices": the AI key sealed with the vault key, kept in its own table.
// Every key in these tests is fake.
const DAY = 24 * 60 * 60 * 1000, MINUTE = 60 * 1000;
const KEY = 'sk-ant-test-NOT-A-REAL-KEY-0123456789';
const CONFIG = { provider: 'anthropic', key: KEY, model: 'claude-haiku-5-5', baseUrl: '' };
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-ai-key-test-'));
  const enrollmentToken = randomToken(), mails = [];
  let now = Date.parse('2026-11-13T08:00:00Z');
  const app = await createCloudServer({ dataDir, enrollmentToken, enrollmentLimit: 10, freeDeviceLimit: 100, signupTrial: 0, signupsPerAddress: 1000, sweepEvery: 60 * 60 * 1000, mailer: async (mail) => { mails.push(mail); }, serverKey: randomToken(), clock: () => now, ...options });
  t.after(async () => { identifyClient(); await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  const database = () => new DatabaseSync(app.dbPath, { timeout: 5000 });
  const query = (sql, ...args) => { const db = database(); try { return db.prepare(sql).all(...args); } finally { db.close(); } };
  const plus = (client, until = now + 30 * DAY) => { const db = database(); try { db.prepare('INSERT INTO plans(vaultId,plusUntil) VALUES(?,?) ON CONFLICT(vaultId) DO UPDATE SET plusUntil=excluded.plusUntil').run(client.credentials.vaultId, until); } finally { db.close(); } };
  const api = async (path, body, headers = {}, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${url}/api/v1${path}`, { method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { app, url, mails, api, query, plus, advance: (ms) => { now += ms; }, time: () => now, sweep: () => new Promise((done) => setTimeout(done, 60)),
    create: async (deviceName = 'Phone') => (await CloudClient.create({ url, enrollmentToken, deviceName })).client };
}
const pair = async (client, name = 'Laptop') => CloudClient.claim({ pairingCode: (await client.makePairing(name)).pairingCode });
const rows = (cloud, client) => cloud.query('SELECT sealed,updatedAt FROM ai_keys WHERE vaultId=?', client.credentials.vaultId);
const refused = (status, code) => (error) => error.status === status && error.code === code;

test('with Plus one device saves the sealed key and another opens it; the server holds nothing readable', async (t) => {
  const cloud = await fixture(t);
  identifyClient('web');
  const phone = await cloud.create(), laptop = await pair(phone);
  cloud.plus(phone);
  assert.deepEqual(await readSharedKey(laptop), { status: 'none' });
  const updatedAt = await saveSharedKey(phone, { ...CONFIG, includeShared: true });
  assert.equal(updatedAt, cloud.time());
  identifyClient('android', '0.28.61');
  assert.deepEqual(await readSharedKey(laptop), { status: 'found', updatedAt, config: CONFIG });
  identifyClient('obsidian', '0.30.0');
  assert.deepEqual(await readSharedKey(laptop), { status: 'found', updatedAt, config: CONFIG });
  const [row] = rows(cloud, phone);
  assert.equal(row.updatedAt, updatedAt);
  assert.deepEqual(Object.keys(JSON.parse(row.sealed)).sort(), ['ciphertext', 'iv', 'v']);
  const raw = Buffer.concat(await Promise.all(['', '-wal'].map((suffix) => readFile(cloud.app.dbPath + suffix).catch(() => Buffer.alloc(0)))));
  for (const secret of [KEY, 'anthropic', 'claude-haiku', phone.credentials.vaultKey]) assert.ok(!raw.includes(Buffer.from(secret)), secret === KEY ? 'the key' : secret);
  // Nothing about the key travels along with the status or the device list.
  assert.ok(!JSON.stringify([await phone.status(), await phone.devices()]).includes('sealed'));
});

test('every answer carries its own code: no key is "no-ai-key", and an address the server does not know has none', async (t) => {
  const cloud = await fixture(t);
  identifyClient('web');
  const phone = await cloud.create();
  cloud.plus(phone);
  await assert.rejects(phone.call('/ai-key'), refused(404, 'no-ai-key'));
  // What an older server answers to this address: a plain 404. A device must not take that for "removed".
  await assert.rejects(phone.call('/ai-key-of-a-later-version'), (error) => error.status === 404 && error.code === undefined);
  await assert.rejects(phone.call('/ai-key', 'POST', {}), (error) => error.status === 405);
  await assert.rejects(phone.call('/ai-key/extra'), (error) => error.status === 404 && error.code === undefined);
});

test('saving and reading need Plus; removing never does; when Plus ends the blob stays and comes back with Plus', async (t) => {
  const cloud = await fixture(t);
  identifyClient('web');
  const phone = await cloud.create(), laptop = await pair(phone);
  const hits = () => cloud.query("SELECT COALESCE(SUM(times),0) AS times FROM limit_hits WHERE kind='ai-key'")[0].times;
  await assert.rejects(saveSharedKey(phone, CONFIG), (error) => error.status === 402 && error.code === 'plus-required' && /Plus/.test(error.message) && !/€|\$|http/.test(error.message));
  assert.equal(hits(), 1, 'trying to turn it on counts as a limit that Plus lifts');
  assert.deepEqual(rows(cloud, phone), []);
  // A free cloud learns nothing about a blob, and looking is not counted: devices look once a day.
  assert.deepEqual(await readSharedKey(laptop), { status: 'plus' });
  assert.equal(hits(), 1);
  await removeSharedKey(phone);
  // The trial counts as Plus.
  await phone.call('/account/trial', 'POST', {});
  assert.equal((await phone.status()).plan.name, 'plus');
  const updatedAt = await saveSharedKey(phone, CONFIG);
  assert.equal((await readSharedKey(laptop)).status, 'found');
  cloud.advance(15 * DAY);
  assert.equal((await phone.status()).plan.name, 'free');
  assert.deepEqual(await readSharedKey(laptop), { status: 'plus' });
  await assert.rejects(saveSharedKey(phone, CONFIG), refused(402, 'plus-required'));
  // Nothing was taken away: the blob is still there.
  assert.equal(rows(cloud, phone)[0].updatedAt, updatedAt);
  assert.equal(decideKeySync({ hasKey: true, synced: updatedAt }, await readSharedKey(laptop)), 'waiting');
  cloud.plus(phone);
  assert.deepEqual(await readSharedKey(laptop), { status: 'found', updatedAt, config: CONFIG });
  // Without Plus the copy on our server can still be removed.
  cloud.plus(phone, 0);
  await removeSharedKey(laptop);
  assert.deepEqual(rows(cloud, phone), []);
  cloud.plus(phone);
  assert.deepEqual(await readSharedKey(phone), { status: 'none' });
});

test('a new key replaces the old one with a later time, also within the same millisecond; removing works through', async (t) => {
  const cloud = await fixture(t);
  identifyClient('web');
  const phone = await cloud.create(), laptop = await pair(phone);
  cloud.plus(phone);
  const first = await saveSharedKey(phone, CONFIG);
  // The clock stands still in this test: the time still moves forward.
  const second = await saveSharedKey(laptop, { ...CONFIG, key: 'sk-ant-test-NOT-A-REAL-KEY-second' });
  assert.equal(second, first + 1);
  const seen = await readSharedKey(phone);
  assert.equal(seen.config.key, 'sk-ant-test-NOT-A-REAL-KEY-second');
  assert.equal(decideKeySync({ hasKey: true, synced: first }, seen), 'update');
  assert.equal(decideKeySync({ hasKey: true, synced: second }, seen), 'none');
  assert.equal(rows(cloud, phone).length, 1, 'one blob per cloud, without history');
  // A clock that went back does not bring an earlier time.
  cloud.advance(-DAY);
  assert.equal(await saveSharedKey(phone, CONFIG), second + 1);
  await removeSharedKey(laptop);
  assert.equal(decideKeySync({ hasKey: true, synced: second + 1 }, await readSharedKey(phone)), 'remove');
  // Removing what is not there is fine.
  await removeSharedKey(laptop);
});

test('only the web app, Obsidian and Android are let in: jotdrop-mcp, Joplin, the clipper and an app that does not say are refused', async (t) => {
  const cloud = await fixture(t);
  identifyClient('web');
  const phone = await cloud.create();
  cloud.plus(phone);
  await saveSharedKey(phone, CONFIG);
  for (const [app, version] of [['mcp', '0.1.0'], ['joplin', '1.8.0'], ['clipper', '0.2.1'], [undefined], ['webby']]) {
    identifyClient(app, version);
    for (const [method, body] of [['GET'], ['PUT', { sealed: await sealKey(phone.credentials.vaultKey, phone.credentials.vaultId, CONFIG) }], ['DELETE']]) {
      await assert.rejects(phone.call('/ai-key', method, body), refused(403, 'client-not-allowed'), `${app} ${method}`);
    }
    assert.deepEqual(await readSharedKey(phone), { status: 'unavailable' });
  }
  // Refused before the plan is looked at, so an agent's device learns nothing and nothing is counted as a Plus limit.
  cloud.plus(phone, 0);
  identifyClient('mcp', '0.1.0');
  await assert.rejects(phone.call('/ai-key'), refused(403, 'client-not-allowed'));
  assert.equal(cloud.query("SELECT COUNT(*) AS count FROM limit_hits WHERE kind='ai-key'")[0].count, 0);
  cloud.plus(phone);
  assert.equal(rows(cloud, phone).length, 1, 'the blob was not touched');
  for (const app of ['web', 'obsidian', 'android']) { identifyClient(app, '1.0.0'); assert.equal((await readSharedKey(phone)).status, 'found', app); }
});

test('the server takes only a small, well-formed envelope, and limits how often', async (t) => {
  const cloud = await fixture(t);
  identifyClient('web');
  const phone = await cloud.create();
  cloud.plus(phone);
  const { vaultKey, vaultId } = phone.credentials;
  const big = JSON.stringify(await encryptEnvelope(vaultKey, { pad: 'x'.repeat(7000) }, `jotdrop:ai-key:v1:${vaultId}`));
  assert.ok(big.length > 8192 && big.length < 16 * 1024);
  for (const sealed of [undefined, 42, '', 'sk-test', '{"v":1}', JSON.stringify({ v: 1, iv: 'AAAA', ciphertext: 'AAAA' }), JSON.stringify({ v: 2, iv: 'A'.repeat(16), ciphertext: 'A'.repeat(32) }), big]) {
    await assert.rejects(phone.call('/ai-key', 'PUT', { sealed }), (error) => error.status === 400, String(sealed).slice(0, 20));
  }
  await assert.rejects(phone.call('/ai-key', 'PUT', { sealed: 'x'.repeat(20 * 1024) }), (error) => error.status === 413);
  assert.deepEqual(rows(cloud, phone), []);
  // A plain key sent by mistake is refused, never stored.
  await assert.rejects(phone.call('/ai-key', 'PUT', { sealed: KEY, key: KEY }), (error) => error.status === 400);
  assert.deepEqual(rows(cloud, phone), []);
  let saved = 0;
  await assert.rejects((async () => { for (let index = 0; index < 40; index++) { await saveSharedKey(phone, CONFIG); saved++; } })(), (error) => error.status === 429);
  assert.ok(saved >= 5 && saved <= 30, `saved ${saved} times in one minute`);
  cloud.advance(MINUTE + 1);
  await saveSharedKey(phone, CONFIG);
});

test('another cloud, a signed-out device and a wrong token get nothing', async (t) => {
  const cloud = await fixture(t);
  identifyClient('web');
  const phone = await cloud.create(), laptop = await pair(phone), stranger = await cloud.create('Stranger');
  cloud.plus(phone);
  cloud.plus(stranger);
  const updatedAt = await saveSharedKey(phone, CONFIG);
  // Each cloud has its own blob.
  assert.deepEqual(await readSharedKey(stranger), { status: 'none' });
  await saveSharedKey(stranger, { ...CONFIG, key: 'sk-ant-test-NOT-A-REAL-KEY-stranger' });
  assert.equal((await readSharedKey(phone)).config.key, KEY);
  // A device of one cloud that names the other cloud.
  const forged = new CloudClient({ ...stranger.credentials, vaultId: phone.credentials.vaultId });
  for (const [method, body] of [['GET'], ['PUT', { sealed: rows(cloud, stranger)[0].sealed }], ['DELETE']]) await assert.rejects(forged.call('/ai-key', method, body), (error) => error.status === 401);
  // The stranger's blob, put in place by someone with database access, does not open: the workspace is in the AAD.
  assert.equal(await openKey(phone.credentials.vaultKey, phone.credentials.vaultId, rows(cloud, stranger)[0].sealed), null);
  await phone.revokeDevice(laptop.credentials.deviceId);
  for (const [method, body] of [['GET'], ['PUT', { sealed: rows(cloud, phone)[0].sealed }], ['DELETE']]) await assert.rejects(laptop.call('/ai-key', method, body), (error) => error.status === 401);
  const anonymous = await cloud.api('/ai-key');
  assert.equal(anonymous.status, 401);
  assert.equal(rows(cloud, phone)[0].updatedAt, updatedAt);
});

// The sweep runs once an hour in these two tests, so it cannot do the deleting that the request itself must do.
test('deleting the cloud removes its blob at once and leaves the blob of another cloud', async (t) => {
  const cloud = await fixture(t);
  identifyClient('web');
  const phone = await cloud.create(), other = await cloud.create('Other');
  cloud.plus(phone);
  cloud.plus(other);
  await saveSharedKey(phone, CONFIG);
  await saveSharedKey(other, CONFIG);
  assert.equal((await phone.call('/account/delete', 'POST', { confirm: 'DELETE MY CLOUD' })).deleted, true);
  assert.deepEqual(rows(cloud, phone), []);
  assert.equal(rows(cloud, other).length, 1);
});

test('the sweep removes a blob that an older server left behind when it deleted a cloud', async (t) => {
  const cloud = await fixture(t, { sweepEvery: 10 });
  identifyClient('web');
  const other = await cloud.create('Other');
  cloud.plus(other);
  await saveSharedKey(other, CONFIG);
  const gone = '0b0f6f0e-3c56-4d0a-9d55-7a1c3a5e9f10';
  const db = new DatabaseSync(cloud.app.dbPath, { timeout: 5000 });
  db.prepare('INSERT INTO ai_keys VALUES(?,?,?)').run(gone, rows(cloud, other)[0].sealed, 1);
  // An older server deletes a cloud without knowing the table: no foreign key may stop that.
  assert.deepEqual(db.prepare('PRAGMA foreign_key_list(ai_keys)').all(), []);
  db.close();
  await cloud.sweep();
  assert.deepEqual(cloud.query('SELECT vaultId FROM ai_keys ORDER BY vaultId').map((row) => row.vaultId), [other.credentials.vaultId]);
});

test('starting over with a new workspace key leaves no blob of the old one behind', async (t) => {
  const cloud = await fixture(t);
  identifyClient('web');
  cloud.advance(MINUTE + 1);
  const email = 'starter@example.test', vaultKey = generateVaultKey(), deviceToken = randomToken(), kdf = () => ({ salt: b64(randomBytes(16)), memory: 65536, passes: 3, parallelism: 1 });
  const wrapped = async (key) => JSON.stringify(await encryptEnvelope(randomToken(), { vaultKey: key }, 'jotdrop:wrap:v1'));
  const started = await cloud.api('/accounts', { email, authKey: randomToken(), kdf: kdf(), wrappedVaultKey: await wrapped(vaultKey), recoveryTokenHash: await hashToken(randomToken()), deviceName: 'Phone', deviceTokenHash: await hashToken(deviceToken) });
  assert.equal(started.status, 202);
  const verified = await cloud.api('/accounts/verify', { signupId: started.body.signupId, code: cloud.mails.filter((mail) => mail.kind === 'verify').at(-1).code });
  assert.equal(verified.status, 201);
  const phone = new CloudClient({ url: cloud.url, vaultId: verified.body.vaultId, deviceId: verified.body.deviceId, token: deviceToken, vaultKey });
  cloud.plus(phone);
  await saveSharedKey(phone, CONFIG);
  assert.equal(rows(cloud, phone).length, 1);
  cloud.advance(MINUTE + 1);
  const { resetId } = (await cloud.api('/auth/reset/start', { email })).body;
  const restarted = await cloud.api('/auth/reset/restart', { resetId, code: cloud.mails.filter((mail) => mail.kind === 'reset').at(-1).code, confirm: 'DELETE CLOUD DATA', recoveryTokenHash: await hashToken(randomToken()), deviceName: 'New', deviceTokenHash: await hashToken(randomToken()), authKey: randomToken(), kdf: kdf(), wrappedVaultKey: await wrapped(generateVaultKey()) });
  assert.equal(restarted.status, 201);
  assert.deepEqual(cloud.query('SELECT vaultId FROM ai_keys'), []);
});

test('the web app is served the key sync module, and never its vectors or tests', async (t) => {
  const cloud = await fixture(t);
  const module = await fetch(`${cloud.url}/shared/ai/keysync.mjs`);
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /^text\/javascript/);
  for (const path of ['/shared/ai/ai-key-vectors.json', '/shared/ai/keysync.test.mjs']) assert.equal((await fetch(`${cloud.url}${path}`)).status, 404, path);
});

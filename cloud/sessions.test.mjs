import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCloudServer } from './server.mjs';
import { setPlusUntil } from './set-plus.mjs';
import { CloudClient } from './shared/client.mjs';
import { decodeRecovery, encryptEnvelope, generateVaultKey, hashToken, randomToken } from './shared/crypto.mjs';

// "Sign me out when I close this page" (Hand-off/ontwerp-afmelden-bij-sluiten-80.md, parts 5 and 8): the page keeps a
// sealed packet in its tab, the server keeps the packet's key, and the server's clock decides when the session is over.
const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const RETURN = 2 * MINUTE, AWAY = 30 * MINUTE, QUIET = 10 * MINUTE, SETTLE = 10 * SECOND;
const START = Date.parse('2027-01-04T08:00:00Z');
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const iso = (time) => new Date(time).toISOString();

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-sessions-test-'));
  const mails = [], enrollmentToken = randomToken();
  let now = START;
  const app = await createCloudServer({ dataDir, enrollmentToken, enrollmentLimit: 10, mailer: async (mail) => { mails.push(mail); }, serverKey: randomToken(), clock: () => now, signupTrial: 0, signupsPerAddress: 100, freeDeviceLimit: 100, sweepEvery: 10, ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  const api = async (path, body) => {
    const response = await fetch(`${url}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  // Reads and writes the database next to the running server, as the scripts in cloud/ do.
  const sql = (statement, ...args) => {
    const db = new DatabaseSync(join(dataDir, 'cloud.db'), { timeout: 5000 });
    try { const prepared = db.prepare(statement); return /^\s*SELECT/i.test(statement) ? prepared.all(...args) : prepared.run(...args); } finally { db.close(); }
  };
  const create = () => CloudClient.create({ url, enrollmentToken, deviceName: 'Phone' });
  const pair = async (owner, name = 'Web browser') => CloudClient.claim({ pairingCode: (await owner.makePairing(name)).pairingCode });
  return { url, api, sql, mails, create, pair, dbPath: join(dataDir, 'cloud.db'), now: () => now, advance: (ms) => { now += ms; },
    sweep: () => new Promise((done) => setTimeout(done, 80)) };
}

// An account as the sync pause tests make one: the server never checks the password's derivation, only the login key.
async function signUp(cloud, name) {
  const email = `${name}@example.test`, vaultKey = generateVaultKey(), token = randomToken(), authKey = randomToken();
  const started = await cloud.api('/accounts', { email, authKey, kdf: { salt: b64(randomBytes(16)), memory: 65536, passes: 3, parallelism: 1 }, wrappedVaultKey: JSON.stringify(await encryptEnvelope(randomToken(), { vaultKey }, 'jotdrop:wrap:v1')), recoveryTokenHash: await hashToken(randomToken()), deviceName: 'Phone', deviceTokenHash: await hashToken(token) });
  assert.equal(started.status, 202);
  const verified = await cloud.api('/accounts/verify', { signupId: started.body.signupId, code: cloud.mails.filter((mail) => mail.to === email && mail.kind === 'verify').at(-1).code });
  assert.equal(verified.status, 201);
  return { email, authKey, vaultId: verified.body.vaultId, client: new CloudClient({ url: cloud.url, vaultId: verified.body.vaultId, deviceId: verified.body.deviceId, token, vaultKey }) };
}

// What the web app does when it signs in without "Stay signed in": a resume code (the server keeps its hash) and a key.
async function startSession(client) {
  const resumeToken = randomToken(), key = randomToken();
  assert.deepEqual(await client.call('/devices/session', 'PUT', { resumeTokenHash: await hashToken(resumeToken), key }), { ok: true });
  return { resumeToken, key, deviceId: client.credentials.deviceId };
}
const leave = (client, away) => client.call('/devices/session/leave', 'POST', away ? { away: true } : {});
const resume = (cloud, session, resumeToken = session.resumeToken) => cloud.api('/sessions/resume', { deviceId: session.deviceId, resumeToken });
const ended = (answer) => { assert.equal(answer.status, 401); assert.equal(answer.body.code, 'session-ended'); };
const revoked = (cloud, deviceId) => cloud.sql('SELECT revoked FROM devices WHERE id=?', deviceId)[0]?.revoked === 1;
const sessionRow = (cloud, deviceId) => cloud.sql('SELECT * FROM page_sessions WHERE deviceId=?', deviceId)[0];
// A request as a given app, as X-JotDrop-Client tells the server.
const as = (cloud, client, app, path, method = 'GET') => fetch(`${cloud.url}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${client.credentials.token}`, 'X-JotDrop-Vault': client.credentials.vaultId, 'X-JotDrop-Device': client.credentials.deviceId, 'X-JotDrop-Client': app } });

test('a page session sits next to an ordinary device, and the device list says which is which', async (t) => {
  const cloud = await fixture(t);
  const { client: phone } = await cloud.create();
  const browser = await cloud.pair(phone);
  assert.deepEqual(await browser.call('/devices/session'), { session: false });
  await assert.rejects(browser.call('/devices/session', 'PUT', { resumeTokenHash: 'x', key: 'y' }), (error) => error.status === 400);
  const first = await startSession(browser);
  // Signing in again on the same page replaces the row and its resume code.
  const second = await startSession(browser);
  assert.equal(cloud.sql('SELECT COUNT(*) AS n FROM page_sessions')[0].n, 1);
  assert.deepEqual(await browser.call('/devices/session'), { session: true });
  ended(await resume(cloud, first));
  assert.equal(revoked(cloud, browser.credentials.deviceId), false);
  assert.deepEqual((await resume(cloud, second)).body, { key: second.key });
  // An ordinary device notices nothing: no row, a greeting does nothing.
  await phone.status();
  assert.deepEqual(await phone.call('/devices/session'), { session: false });
  assert.deepEqual(await leave(phone), { ok: true });
  assert.equal(sessionRow(cloud, phone.credentials.deviceId), undefined);
  const list = (await phone.devices()).devices;
  assert.equal(list.find((device) => device.id === browser.credentials.deviceId).session, true);
  assert.equal(list.find((device) => device.id === phone.credentials.deviceId).session, false);
});

test('back within two minutes of the greeting: the key comes back; a wrong code does not, and guessing is limited', async (t) => {
  const cloud = await fixture(t);
  const { client: phone } = await cloud.create();
  const browser = await cloud.pair(phone);
  const session = await startSession(browser);
  await leave(browser);
  assert.equal(sessionRow(cloud, session.deviceId).deadline, START + RETURN);
  cloud.advance(RETURN - 10 * SECOND);
  ended(await resume(cloud, session, randomToken()));
  // An ordinary device has no session to resume, and a guess at it signs nothing out.
  ended(await resume(cloud, { deviceId: phone.credentials.deviceId, resumeToken: randomToken() }));
  const back = await resume(cloud, session);
  assert.equal(back.status, 200);
  assert.deepEqual(back.body, { key: session.key });
  assert.equal(sessionRow(cloud, session.deviceId).deadline, null);
  await browser.status();
  let last;
  for (let attempt = 0; attempt < 12; attempt += 1) last = await resume(cloud, session, randomToken());
  assert.equal(last.status, 429);
  assert.equal(revoked(cloud, session.deviceId), false);
  assert.equal(revoked(cloud, phone.credentials.deviceId), false);
});

test('two minutes after the greeting the session is over: no key, the device is signed out, its token stops working', async (t) => {
  // The sweep waits an hour here, so the last part shows the check on every request, not the sweep.
  const cloud = await fixture(t, { sweepEvery: HOUR });
  const { client: phone } = await cloud.create();
  const browser = await cloud.pair(phone);
  const session = await startSession(browser);
  await leave(browser);
  cloud.advance(RETURN + SECOND);
  ended(await resume(cloud, session));
  assert.equal(revoked(cloud, session.deviceId), true);
  assert.equal(sessionRow(cloud, session.deviceId), undefined);
  await assert.rejects(browser.status(), (error) => error.status === 401);
  ended(await resume(cloud, session));
  // A page that was kept alive past its own deadline (its greeting came late) is signed out by its next request.
  const other = await cloud.pair(phone);
  await startSession(other);
  await leave(other);
  cloud.advance(RETURN + SECOND);
  await assert.rejects(other.status(), (error) => error.status === 401 && error.code === 'session-ended');
  assert.equal(revoked(cloud, other.credentials.deviceId), true);
  assert.equal(revoked(cloud, phone.credentials.deviceId), false);
});

test('a trip to the payment page may take thirty minutes', async (t) => {
  const cloud = await fixture(t);
  const { client: phone } = await cloud.create();
  const browser = await cloud.pair(phone);
  const session = await startSession(browser);
  await leave(browser, true);
  assert.equal(sessionRow(cloud, session.deviceId).deadline, START + AWAY);
  cloud.advance(AWAY - MINUTE);
  assert.equal((await resume(cloud, session)).status, 200);
  await leave(browser, true);
  cloud.advance(AWAY + MINUTE);
  ended(await resume(cloud, session));
  assert.equal(revoked(cloud, session.deviceId), true);
});

test('without a greeting (a crash): back within two minutes of the last request, later the device is gone', async (t) => {
  const cloud = await fixture(t);
  const { client: phone } = await cloud.create();
  const browser = await cloud.pair(phone);
  const session = await startSession(browser);
  await browser.status();
  cloud.advance(RETURN - 10 * SECOND);
  assert.equal((await resume(cloud, session)).status, 200);
  cloud.advance(RETURN + SECOND);
  ended(await resume(cloud, session));
  assert.equal(revoked(cloud, session.deviceId), true);
  assert.equal(sessionRow(cloud, session.deviceId), undefined);
});

test('an ordinary request clears a deadline, so a live page never runs out by being quiet', async (t) => {
  const cloud = await fixture(t);
  const { client: phone } = await cloud.create();
  const browser = await cloud.pair(phone);
  await startSession(browser);
  await leave(browser);
  cloud.advance(MINUTE);
  await browser.status();
  assert.equal(sessionRow(cloud, browser.credentials.deviceId).deadline, null);
  cloud.advance(3 * HOUR);
  await browser.status();
  assert.equal(revoked(cloud, browser.credentials.deviceId), false);
});

test('a request that was already on its way when the page said goodbye does not take the goodbye back', async (t) => {
  const cloud = await fixture(t);
  const { client: phone } = await cloud.create();
  const browser = await cloud.pair(phone);
  const session = await startSession(browser);
  await leave(browser, true);
  cloud.advance(SETTLE - SECOND);
  await browser.status();
  assert.equal(sessionRow(cloud, session.deviceId).deadline, START + AWAY);
  cloud.advance(2 * SECOND);
  await browser.status();
  assert.equal(sessionRow(cloud, session.deviceId).deadline, null);
  // A reload whose old page's goodbye arrives after the new page resumed: the new page keeps its session.
  await leave(browser);
  cloud.advance(SECOND);
  assert.equal((await resume(cloud, session)).status, 200);
  await leave(browser);
  await browser.status();
  cloud.advance(30 * SECOND);
  await browser.status();
  cloud.advance(RETURN + MINUTE);
  await browser.status();
  assert.equal(revoked(cloud, session.deviceId), false);
});

test('a page session the server has not heard from for a day is signed out by the hourly sweep', async (t) => {
  const cloud = await fixture(t);
  const { client: phone } = await cloud.create();
  const browser = await cloud.pair(phone);
  await startSession(browser);
  cloud.advance(23 * HOUR);
  await cloud.sweep();
  assert.equal(revoked(cloud, browser.credentials.deviceId), false);
  cloud.advance(2 * HOUR);
  await cloud.sweep();
  assert.equal(revoked(cloud, browser.credentials.deviceId), true);
  assert.equal(sessionRow(cloud, browser.credentials.deviceId), undefined);
  // An ordinary device stays, however long it is quiet.
  assert.equal(revoked(cloud, phone.credentials.deviceId), false);
});

test('a free cloud at its limit: a page that greeted or is quiet makes room, one that was alive a moment ago does not', async (t) => {
  const cloud = await fixture(t, { freeDeviceLimit: 2 });
  const { client: phone, recoveryCode } = await cloud.create();
  const browser = await cloud.pair(phone);
  await startSession(browser);
  await assert.rejects(phone.makePairing('Tablet'), (error) => error.status === 403 && error.code === 'device-limit');
  await leave(browser);
  const tablet = await cloud.pair(phone, 'Tablet');
  assert.equal(revoked(cloud, browser.credentials.deviceId), true);
  await phone.revokeDevice(tablet.credentials.deviceId);

  const quiet = await cloud.pair(phone);
  await startSession(quiet);
  cloud.advance(QUIET - MINUTE);
  await assert.rejects(phone.makePairing('Tablet'), (error) => error.status === 403 && error.code === 'device-limit');
  cloud.advance(2 * MINUTE);
  const laptop = await cloud.pair(phone, 'Laptop');
  assert.equal(revoked(cloud, quiet.credentials.deviceId), true);
  await phone.revokeDevice(laptop.credentials.deviceId);

  // Who names a device to replace gets that, as before; the page session stays.
  const greeted = await cloud.pair(phone);
  await startSession(greeted);
  await leave(greeted);
  const recovery = decodeRecovery(recoveryCode);
  const replaced = await cloud.api('/recover', { vaultId: recovery.vaultId, recoveryToken: recovery.recoveryToken, deviceName: 'New phone', deviceTokenHash: await hashToken(randomToken()), replaceDeviceId: phone.credentials.deviceId });
  assert.equal(replaced.status, 201);
  assert.equal(revoked(cloud, phone.credentials.deviceId), true);
  assert.equal(revoked(cloud, greeted.credentials.deviceId), false);
});

test('signing yourself out as the only device: a page session and a web browser with an account may, the rest may not', async (t) => {
  const cloud = await fixture(t);
  const { client: phone } = await cloud.create();
  const browser = await cloud.pair(phone);
  await startSession(browser);
  await browser.revokeDevice(phone.credentials.deviceId);
  assert.deepEqual(await browser.revokeDevice(browser.credentials.deviceId), { ok: true });
  assert.equal(revoked(cloud, browser.credentials.deviceId), true);
  assert.equal(sessionRow(cloud, browser.credentials.deviceId), undefined);

  const web = await signUp(cloud, 'wendy');
  assert.equal((await as(cloud, web.client, 'web', `/devices/${web.client.credentials.deviceId}`, 'DELETE')).status, 200);
  const android = await signUp(cloud, 'andy');
  assert.equal((await as(cloud, android.client, 'android', `/devices/${android.client.credentials.deviceId}`, 'DELETE')).status, 409);
  const { client: alone } = await cloud.create();
  assert.equal((await as(cloud, alone, 'web', `/devices/${alone.credentials.deviceId}`, 'DELETE')).status, 409);
});

test('a page session that ends gives its sync place to the next device, as signing it out does', async (t) => {
  const cloud = await fixture(t, { freeDeviceLimit: 2, syncPauseFrom: Date.parse('2026-10-01T00:00:00Z') });
  const owner = await signUp(cloud, 'kim');
  setPlusUntil(cloud.dbPath, owner.vaultId, cloud.now() + 365 * DAY);
  const clients = { A: owner.client };
  for (const name of ['B', 'C', 'D']) clients[name] = await cloud.pair(owner.client, name);
  const seen = { A: ['web', 1], B: ['obsidian', 2], C: ['android', 3], D: ['joplin', 4] };
  for (const [name, [app, hours]] of Object.entries(seen)) cloud.sql('UPDATE devices SET app=?,lastSeenAt=? WHERE id=?', app, iso(cloud.now() - hours * HOUR), clients[name].credentials.deviceId);
  setPlusUntil(cloud.dbPath, owner.vaultId, 0);
  await cloud.sweep();
  cloud.advance(7 * DAY + MINUTE);
  const onHold = (client) => assert.rejects(client.listChanges(), (error) => error.status === 403 && error.code === 'device-paused');
  await onHold(clients.C);
  const session = await startSession(clients.A);
  await leave(clients.A);
  cloud.advance(RETURN + SECOND);
  ended(await resume(cloud, session));
  await clients.C.listChanges();
  await clients.B.listChanges();
  await onHold(clients.D);
});

test('a new password that signs out the other devices, deleting the cloud and an older server leave no session behind', async (t) => {
  const cloud = await fixture(t);
  const owner = await signUp(cloud, 'pat');
  const browser = await cloud.pair(owner.client);
  await startSession(browser);
  const next = { kdf: { salt: b64(randomBytes(16)), memory: 65536, passes: 3, parallelism: 1 }, authKey: randomToken(), wrappedVaultKey: JSON.stringify(await encryptEnvelope(randomToken(), { vaultKey: generateVaultKey() }, 'jotdrop:wrap:v1')) };
  await owner.client.call('/account/password', 'POST', { ...next, currentAuthKey: owner.authKey, signOutOtherDevices: true });
  assert.equal(revoked(cloud, browser.credentials.deviceId), true);
  assert.equal(sessionRow(cloud, browser.credentials.deviceId), undefined);

  // An older server after a rollback revokes or deletes devices without knowing the table: the sweep removes what it leaves.
  const left = await cloud.pair(owner.client), gone = await cloud.pair(owner.client);
  await startSession(left);
  await startSession(gone);
  cloud.sql('UPDATE devices SET revoked=1 WHERE id=?', left.credentials.deviceId);
  cloud.sql('DELETE FROM devices WHERE id=?', gone.credentials.deviceId);
  await cloud.sweep();
  assert.equal(sessionRow(cloud, left.credentials.deviceId), undefined);
  assert.equal(sessionRow(cloud, gone.credentials.deviceId), undefined);

  const last = await cloud.pair(owner.client);
  await startSession(last);
  await owner.client.call('/account/delete', 'POST', { confirm: 'DELETE MY CLOUD', currentAuthKey: next.authKey });
  assert.equal(cloud.sql('SELECT COUNT(*) AS n FROM page_sessions WHERE vaultId=?', owner.vaultId)[0].n, 0);
});

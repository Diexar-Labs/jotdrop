import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCloudServer } from './server.mjs';
import { mailHtml, mailText } from './mailer.mjs';
import { setPlusUntil } from './set-plus.mjs';
import { setDevicePromise } from './set-device-promise.mjs';
import { CloudClient } from './shared/client.mjs';
import { encodeRecovery, encryptEnvelope, generateVaultKey, hashToken, objectId, randomToken } from './shared/crypto.mjs';
import { copyName, hash, isPreserved, remoteFiles, syncFolder } from './shared/sync.mjs';

// Sync on hold above the free plan's devices (Hand-off/ontwerp-sync-pauzeren-boven-free.md, deel 12).
const DAY = 24 * 60 * 60 * 1000, HOUR = 60 * 60 * 1000, MINUTE = 60 * 1000;
const START = Date.parse('2027-01-04T08:00:00Z');
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const iso = (time) => new Date(time).toISOString();
const id64 = '0'.repeat(64);

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-sync-pause-test-'));
  const mails = [];
  let now = START, app, port = 0;
  const serverKey = randomToken(), enrollmentToken = randomToken();
  // A restart keeps the port, so the clients made before it reach the server again.
  const start = async (extra = {}) => { app = await createCloudServer({ dataDir, mailer: async (mail) => { mails.push(mail); }, serverKey, enrollmentToken, clock: () => now, signupsPerAddress: 1000, sweepEvery: 10, signupTrial: 0, syncPauseFrom: START - DAY, port, ...options, ...extra }); port = app.port; };
  await start();
  let stopped = false;
  t.after(async () => { if (!stopped) await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = () => `http://127.0.0.1:${app.port}`;
  const api = async (path, body) => {
    const response = await fetch(`${url()}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const answer = await response.text();
    return { status: response.status, body: answer ? JSON.parse(answer) : undefined };
  };
  const dbPath = join(dataDir, 'cloud.db');
  // Reads and writes the database next to the running server, as the scripts in cloud/ do.
  const sql = (statement, ...args) => {
    const db = new DatabaseSync(dbPath, { timeout: 5000 });
    try { const prepared = db.prepare(statement); return /^\s*SELECT/i.test(statement) ? prepared.all(...args) : prepared.run(...args); } finally { db.close(); }
  };
  return { mails, url, api, sql, dbPath, now: () => now, advance: (ms) => { now += ms; },
    stop: async () => { await app.close(); stopped = true; }, start: async (extra) => { await start(extra); stopped = false; },
    sweep: () => new Promise((done) => setTimeout(done, 80)) };
}

async function signUp(cloud, name, deviceName = 'Phone', code) {
  const email = `${name}@example.test`, vaultKey = generateVaultKey(), token = randomToken(), authKey = randomToken(), recoveryToken = randomToken();
  const started = await cloud.api('/accounts', { email, authKey, kdf: { salt: b64(randomBytes(16)), memory: 65536, passes: 3, parallelism: 1 }, wrappedVaultKey: JSON.stringify(await encryptEnvelope(randomToken(), { vaultKey }, 'jotdrop:wrap:v1')), recoveryTokenHash: await hashToken(recoveryToken), deviceName, deviceTokenHash: await hashToken(token) });
  assert.equal(started.status, 202);
  const verified = await cloud.api('/accounts/verify', { signupId: started.body.signupId, code: code ?? cloud.mails.filter((mail) => mail.to === email && mail.kind === 'verify').at(-1).code });
  assert.equal(verified.status, 201);
  return { email, authKey, recoveryToken, vaultKey, vaultId: verified.body.vaultId, client: new CloudClient({ url: cloud.url(), vaultId: verified.body.vaultId, deviceId: verified.body.deviceId, token, vaultKey }) };
}

// An account with these devices, added while it has Plus; Free afterwards unless `plus`. `seen` is hours ago, `app` what it runs.
async function account(cloud, name, devices, { plus = false, code } = {}) {
  const owner = await signUp(cloud, name, devices[0].name, code);
  setPlusUntil(cloud.dbPath, owner.vaultId, cloud.now() + 365 * DAY);
  const clients = { [devices[0].name]: owner.client };
  for (const device of devices.slice(1)) clients[device.name] = await CloudClient.claim({ pairingCode: (await owner.client.makePairing(device.name)).pairingCode });
  for (const device of devices) cloud.sql('UPDATE devices SET app=?,lastSeenAt=? WHERE id=?', device.app ?? null, iso(cloud.now() - (device.seen ?? 0) * HOUR), clients[device.name].credentials.deviceId);
  if (!plus) { setPlusUntil(cloud.dbPath, owner.vaultId, 0); await cloud.sweep(); }
  return { ...owner, clients, id: (deviceName) => clients[deviceName].credentials.deviceId };
}

const FOUR = [{ name: 'A', app: 'android', seen: 1 }, { name: 'B', app: 'obsidian', seen: 2 }, { name: 'C', app: 'web', seen: 3 }, { name: 'D', app: 'joplin', seen: 4 }];
const syncs = async (client) => { await client.listChanges(); };
const onHold = (client) => assert.rejects(client.listChanges(), (error) => error.status === 403 && error.code === 'device-paused');
const syncMails = (cloud, email) => cloud.mails.filter((mail) => mail.to === email && /^(sync|trial)-/.test(mail.kind)).map((mail) => mail.kind);
const choose = (client, ids) => client.call('/devices/syncing', 'PUT', { deviceIds: ids });
const syncingNames = async (client) => (await client.devices()).devices.filter((device) => device.syncing).map((device) => device.name).sort();

test('nobody is on hold: Plus with 5 devices, Free with 2, and Free with 4 while the switch is off', async (t) => {
  const cloud = await fixture(t);
  const plus = await account(cloud, 'paula', [...FOUR, { name: 'E', app: 'web' }], { plus: true });
  const two = await account(cloud, 'tom', FOUR.slice(0, 2));
  cloud.advance(8 * DAY);
  await cloud.sweep();
  for (const client of [...Object.values(plus.clients), ...Object.values(two.clients)]) await syncs(client);
  assert.deepEqual((await plus.client.status()).plan.sync, { limit: null, state: 'all', pauseAt: null, thisDevice: 'syncing', changeAt: null });
  assert.deepEqual((await two.client.status()).plan.sync, { limit: 2, state: 'all', pauseAt: null, thisDevice: 'syncing', changeAt: null });
  assert.equal(cloud.sql('SELECT COUNT(*) AS count FROM sync_pauses')[0].count, 0);

  const off = await fixture(t, { syncPauseFrom: undefined });
  const four = await account(off, 'otto', FOUR);
  off.advance(30 * DAY);
  await off.sweep();
  for (const client of Object.values(four.clients)) await syncs(client);
  assert.equal(off.sql('SELECT COUNT(*) AS count FROM sync_pauses')[0].count, 0);
  assert.deepEqual(syncMails(off, four.email), []);
  assert.equal((await four.clients.D.status()).plan.sync.state, 'all');
  // The old servers' answer stays as it was for apps that know nothing of the pause.
  assert.equal((await four.client.status()).plan.deviceLimit, 2);
});

test('a trial that ends with 4 devices: 7 days of grace, then 2 sync and 2 are on hold for everything notes go through', async (t) => {
  const cloud = await fixture(t, { signupTrial: 14 * DAY });
  const owner = await signUp(cloud, 'cas');
  const clients = { Phone: owner.client };
  for (const name of ['Laptop', 'Tablet', 'Desk']) clients[name] = await CloudClient.claim({ pairingCode: (await owner.client.makePairing(name)).pairingCode });
  const seen = { Phone: ['android', 2], Laptop: ['obsidian', 1], Tablet: ['android', 30], Desk: ['web', 50] };
  for (const [name, [app, hours]] of Object.entries(seen)) cloud.sql('UPDATE devices SET app=?,lastSeenAt=? WHERE id=?', app, iso(cloud.now() - hours * HOUR), clients[name].credentials.deviceId);
  cloud.advance(14 * DAY + HOUR);
  await cloud.sweep();
  const pauseAt = cloud.now() + 7 * DAY;
  // One mail: the last trial mail names the date and the devices, and no second mail follows.
  assert.deepEqual(syncMails(cloud, owner.email), ['trial-ended']);
  const ended = cloud.mails.find((mail) => mail.kind === 'trial-ended');
  assert.deepEqual(ended.trial.sync, { pauseAt: iso(pauseAt), limit: 2, devices: 4, syncing: [{ name: 'Laptop', app: 'obsidian' }, { name: 'Phone', app: 'android' }], onHold: [{ name: 'Tablet', app: 'android' }, { name: 'Desk', app: 'web' }] });
  const { body } = mailText(ended);
  assert.match(body, /4 devices are signed in, and Free includes 2\. From 25 January 2027, sync goes on hold on Tablet \(Android app\) and Desk \(web app\)\. Your notes stay on them/);
  assert.match(body, /Laptop \(Obsidian\) and Phone \(Android app\) keep syncing\. You can choose other devices in JotDrop under Devices\./);
  assert.doesNotMatch(body, /—|keep working/);

  // The grace: everything syncs, every device knows what comes, and using a device does not move the choice.
  for (const client of Object.values(clients)) await syncs(client);
  await cloud.sweep();
  assert.deepEqual((await clients.Desk.status()).plan.sync, { limit: 2, state: 'ending', pauseAt: iso(pauseAt), thisDevice: 'paused', changeAt: null });
  assert.equal((await clients.Phone.status()).plan.sync.thisDevice, 'syncing');
  assert.deepEqual(await syncingNames(clients.Desk), ['Laptop', 'Phone']);
  const listed = (await clients.Desk.devices()).devices;
  assert.deepEqual(listed.map((device) => [device.name, device.app]), [['Phone', 'android'], ['Laptop', 'obsidian'], ['Tablet', 'android'], ['Desk', 'web']]);

  cloud.advance(7 * DAY + MINUTE);
  for (const name of ['Phone', 'Laptop']) await syncs(clients[name]);
  await assert.rejects(clients.Tablet.listChanges(), (error) => error.status === 403 && error.code === 'device-paused' && /^Sync is on hold on this device\. The free plan syncs 2 devices, and this is not one of them\. Your notes on this device stay here\. Choose your 2 devices in JotDrop under Devices\.$/.test(error.message));
  const refused = [['GET', '/changes'], ['GET', '/snapshot?at=2027-01-01T00:00:00.000Z'], ['GET', `/objects/${id64}`], ['PUT', `/objects/${id64}`, { baseRevision: 0 }], ['DELETE', `/objects/${id64}`, { baseRevision: 1 }],
    ['POST', '/chunks/missing', { names: [] }], ['GET', '/pieces/legacy'], ['GET', '/spaces'], ['POST', '/spaces', {}], ['GET', '/links'], ['GET', '/list-links'], ['GET', '/mail'], ['GET', '/ai-key'], ['POST', '/pairings', {}]];
  for (const [method, path, value] of refused) await assert.rejects(clients.Desk.call(path, method, value), (error) => error.status === 403 && error.code === 'device-paused', `${method} ${path}`);
  for (const path of ['/status', '/devices', '/account', '/account/approvals', '/family']) await clients.Desk.call(path);
  assert.deepEqual((await clients.Desk.status()).plan.sync, { limit: 2, state: 'limited', pauseAt: iso(pauseAt), thisDevice: 'paused', changeAt: null });
  // Counted with the limits that sell Plus, never with who.
  assert.ok(cloud.sql("SELECT times FROM limit_hits WHERE kind='device-paused'")[0].times >= refused.length);
});

test('the server gives a place to the apps used last, the clipper and an AI agent after them', async (t) => {
  const cloud = await fixture(t);
  const owner = await account(cloud, 'ida', [{ name: 'Phone', app: 'android', seen: 72 }, { name: 'Laptop', app: 'obsidian', seen: 48 }, { name: 'Agent', app: 'mcp', seen: 0 }, { name: 'Clipper', app: 'clipper', seen: 1 }]);
  assert.deepEqual(await syncingNames(owner.client), ['Laptop', 'Phone']);
  assert.deepEqual(syncMails(cloud, owner.email), ['sync-pausing']);
  const { sync } = cloud.mails.find((mail) => mail.kind === 'sync-pausing');
  assert.deepEqual(sync.onHold, [{ name: 'Agent', app: 'mcp' }, { name: 'Clipper', app: 'clipper' }]);
});

test('choosing: as often as you like in the grace, once a day after the pause starts, never more devices than the limit', async (t) => {
  const cloud = await fixture(t);
  const owner = await account(cloud, 'jan', FOUR), { A, B, C, D } = owner.clients, id = owner.id;
  for (const pick of [['C', 'D'], ['A', 'C'], ['A', 'B']]) {
    const answer = await choose(C, pick.map(id));
    assert.deepEqual(answer.devices.filter((device) => device.syncing).map((device) => device.name).sort(), pick);
  }
  for (const wrong of [[id('A')], [id('A'), id('B'), id('C')], [id('A'), id('A')], [id('A'), randomUUID()], ['phone', id('A')]]) await assert.rejects(choose(C, wrong), (error) => error.status === 400);

  cloud.advance(7 * DAY + MINUTE);
  await onHold(C);
  // "Sync here instead": the first change after the start is always allowed, also from a device on hold.
  await choose(C, [id('A'), id('C')]);
  await syncs(C);
  await onHold(B);
  assert.equal((await C.status()).plan.sync.changeAt, iso(cloud.now() + DAY));
  await assert.rejects(choose(D, [id('A'), id('D')]), (error) => error.status === 409 && error.code === 'choice-wait' && /from 2027-01-12 08:01 UTC/.test(error.message));
  // The same choice again is no change.
  await choose(D, [id('C'), id('A')]);
  cloud.advance(DAY);
  await choose(D, [id('A'), id('D')]);
  await syncs(D);
  await onHold(C);
});

test('signing out a chosen device from a device on hold gives the device on hold its place', async (t) => {
  const cloud = await fixture(t);
  const owner = await account(cloud, 'kim', FOUR), { A, B, C, D } = owner.clients;
  cloud.advance(7 * DAY + MINUTE);
  await onHold(C);
  await C.revokeDevice(owner.id('A'));
  await assert.rejects(A.status(), (error) => error.status === 401);
  await syncs(C);
  await syncs(B);
  await onHold(D);
  // Signing out a device on hold changes nothing for the others.
  await B.revokeDevice(owner.id('D'));
  for (const client of [B, C]) await syncs(client);
  assert.equal((await B.status()).plan.sync.state, 'all');
});

test('Plus during the pause lets every device sync at once; when Plus ends again a new grace of 7 days starts', async (t) => {
  const cloud = await fixture(t);
  const owner = await account(cloud, 'lea', FOUR), { D } = owner.clients;
  cloud.advance(7 * DAY + MINUTE);
  await onHold(D);
  setPlusUntil(cloud.dbPath, owner.vaultId, cloud.now() + 30 * DAY);
  await syncs(D);
  assert.deepEqual((await D.status()).plan.sync, { limit: null, state: 'all', pauseAt: null, thisDevice: 'syncing', changeAt: null });
  await cloud.sweep();
  assert.equal(cloud.sql('SELECT COUNT(*) AS count FROM sync_pauses')[0].count, 0);
  setPlusUntil(cloud.dbPath, owner.vaultId, 0);
  await cloud.sweep();
  const again = cloud.sql('SELECT pauseAt FROM sync_pauses WHERE vaultId=?', owner.vaultId)[0];
  assert.equal(again.pauseAt, cloud.now() + 7 * DAY);
  await syncs(D);
  // The old choice is the proposal for the new grace.
  assert.deepEqual(await syncingNames(D), ['A', 'B']);
  assert.deepEqual(syncMails(cloud, owner.email), ['sync-pausing', 'sync-pausing']);
  cloud.advance(7 * DAY + MINUTE);
  await cloud.sweep();
  await onHold(D);
  // A notice of 7 days gets no reminder.
  assert.deepEqual(syncMails(cloud, owner.email), ['sync-pausing', 'sync-pausing']);
});

test('someone taken out of a family gets the grace first, also when their own Plus ended long ago', async (t) => {
  const cloud = await fixture(t);
  const payer = await signUp(cloud, 'olga');
  const member = await account(cloud, 'max', FOUR, { plus: true });
  const accountId = (vaultId) => cloud.sql('SELECT id FROM accounts WHERE vaultId=?', vaultId)[0].id;
  cloud.sql("INSERT INTO subscriptions VALUES('sub_family',?,'active',?)", payer.vaultId, cloud.now() + 30 * DAY);
  cloud.sql("INSERT INTO family_subscriptions VALUES('sub_family')");
  cloud.sql('INSERT INTO family_members VALUES(?,?,?)', accountId(member.vaultId), accountId(payer.vaultId), cloud.now());
  setPlusUntil(cloud.dbPath, member.vaultId, cloud.now() - 60 * DAY);
  await cloud.sweep();
  assert.equal((await member.client.status()).plan.name, 'plus');
  assert.equal(cloud.sql('SELECT COUNT(*) AS count FROM sync_pauses')[0].count, 0);
  cloud.sql('DELETE FROM family_members');
  await cloud.sweep();
  assert.equal(cloud.sql('SELECT pauseAt FROM sync_pauses WHERE vaultId=?', member.vaultId)[0].pauseAt, cloud.now() + 7 * DAY);
  for (const client of Object.values(member.clients)) await syncs(client);
  assert.equal((await member.clients.D.status()).plan.sync.state, 'ending');
});

test('signing in on a full account always gives the new device a place, and says which device went on hold for it', async (t) => {
  const cloud = await fixture(t);
  const owner = await account(cloud, 'nina', FOUR), { B, C, D } = owner.clients;
  cloud.advance(7 * DAY + MINUTE);
  const recover = async (replaceDeviceId, deviceName) => {
    const token = randomToken();
    const answer = await cloud.api('/recover', { vaultId: owner.vaultId, recoveryToken: owner.recoveryToken, deviceName, deviceTokenHash: await hashToken(token), replaceDeviceId });
    assert.equal(answer.status, 201, JSON.stringify(answer.body));
    return { answer: answer.body, client: new CloudClient({ url: cloud.url(), vaultId: owner.vaultId, deviceId: answer.body.deviceId, token, vaultKey: owner.vaultKey }) };
  };
  // In place of a device that went on syncing: nobody else changes.
  const first = await recover(owner.id('A'), 'New phone');
  assert.equal(first.answer.onHold, undefined);
  await syncs(first.client);
  await syncs(B);
  await onHold(C);
  // In place of a device on hold: the device that comes last among the chosen ones goes on hold.
  cloud.advance(MINUTE);
  await syncs(first.client);
  const second = await recover(owner.id('C'), 'New laptop');
  assert.deepEqual(second.answer.onHold, { id: owner.id('B'), name: 'B' });
  for (const client of [first.client, second.client]) await syncs(client);
  await onHold(B);
  await onHold(D);
  // Not a change of devices: the first change after the start is still free.
  assert.equal((await B.status()).plan.sync.changeAt, null);
  await choose(B, [owner.id('B'), second.answer.deviceId]);
});

test('signing in while the account has Plus again, before the hourly sweep removed its pause: nobody goes on hold', async (t) => {
  // Found in the Obsidian test of 20 Nov 2026: the sign-in said "<name> is on hold" and moved the choice, although Plus syncs every device.
  const cloud = await fixture(t, { sweepEvery: HOUR });
  const owner = await account(cloud, 'pia', FOUR, { plus: true });
  // The pause from before Plus came back; the sweep removes it within the hour. Its choice: A and B.
  cloud.sql('INSERT INTO sync_pauses(vaultId,createdAt,pauseAt,mailed) VALUES(?,?,?,1)', owner.vaultId, cloud.now() - 8 * DAY, cloud.now() - DAY);
  cloud.sql('UPDATE devices SET keepSync=CASE WHEN id IN (?,?) THEN 1 ELSE 0 END WHERE vaultId=?', owner.id('A'), owner.id('B'), owner.vaultId);
  const recovered = await CloudClient.recover({ url: cloud.url(), recoveryCode: encodeRecovery({ vaultId: owner.vaultId, vaultKey: owner.vaultKey, recoveryToken: owner.recoveryToken }), deviceName: 'New tablet' });
  assert.equal(recovered.onHold, undefined);
  assert.deepEqual(cloud.sql('SELECT name FROM devices WHERE vaultId=? AND keepSync=1 ORDER BY name', owner.vaultId).map((row) => row.name), ['A', 'B']);
  for (const client of [...Object.values(owner.clients), recovered]) await syncs(client);
  assert.equal((await recovered.status()).plan.sync.state, 'all');
});

test('the shared client chooses the devices that go on syncing, and says which device went on hold when it signs in in place of one', async (t) => {
  const cloud = await fixture(t);
  const owner = await account(cloud, 'rob', FOUR), { A, C } = owner.clients, id = owner.id;
  const chosen = await C.setSyncDevices([id('C'), id('D')]);
  assert.deepEqual(chosen.devices.filter((device) => device.syncing).map((device) => device.name).sort(), ['C', 'D']);
  assert.throws(() => C.setSyncDevices(['phone']), /Invalid device ID/);
  cloud.advance(7 * DAY + MINUTE);
  await onHold(A);
  const recover = (replaceDeviceId, deviceName) => CloudClient.recover({ url: cloud.url(), recoveryCode: encodeRecovery({ vaultId: owner.vaultId, vaultKey: owner.vaultKey, recoveryToken: owner.recoveryToken }), deviceName, replaceDeviceId });
  // In place of a device that went on syncing: nobody else goes on hold.
  const first = await recover(id('C'), 'New phone');
  assert.equal(first.onHold, undefined);
  await syncs(first);
  // In place of a device on hold: the chosen device used longest ago makes room, and the client says which.
  const second = await recover(id('A'), 'New laptop');
  assert.deepEqual(second.onHold, { id: id('D'), name: 'D' });
  await syncs(second);
  await onHold(owner.clients.D);
});

test('the promise of the old trial mail: recorded once from the trial mails before the new text, its own limit, no mail', async (t) => {
  const T = START - 10 * DAY;
  const cloud = await fixture(t, { trialPromiseEnded: T });
  const three = FOUR.slice(0, 3);
  const pia = await account(cloud, 'pia', three, { plus: true });
  const paul = await account(cloud, 'paul', three, { plus: true });
  const pim = await account(cloud, 'pim', FOUR.slice(0, 2), { plus: true });
  const pat = await account(cloud, 'pat', three, { plus: true });
  // The first trial mail goes 3 days before the end: Pia's went exactly at T, Paul's an hour and a minute after it.
  const trial = (who, trialUntil, mail) => cloud.sql('INSERT INTO trials(vaultId,trialUntil,mail) VALUES(?,?,?)', who.vaultId, trialUntil, mail);
  trial(pia, T + 3 * DAY, 2); trial(paul, T + 3 * DAY + HOUR + MINUTE, 1); trial(pim, T - 5 * DAY, 2); trial(pat, T - 5 * DAY, 0);
  await cloud.stop();
  // A database from before this version: no promises table yet.
  cloud.sql('DROP TABLE device_promises');
  for (const who of [pia, paul, pim, pat]) setPlusUntil(cloud.dbPath, who.vaultId, 0);
  await cloud.start();
  await cloud.sweep();
  assert.deepEqual(cloud.sql('SELECT vaultId,devices FROM device_promises').map((row) => ({ ...row })), [{ vaultId: pia.vaultId, devices: 3 }]);
  assert.deepEqual((await pia.client.status()).plan.sync, { limit: 3, state: 'all', pauseAt: null, thisDevice: 'syncing', changeAt: null });
  assert.deepEqual(syncMails(cloud, pia.email), []);
  assert.deepEqual(syncMails(cloud, paul.email), ['sync-pausing']);
  // Recorded once: a restart with the table in place changes nothing.
  await cloud.stop();
  cloud.sql('DELETE FROM device_promises');
  await cloud.start();
  assert.equal(cloud.sql('SELECT COUNT(*) AS count FROM device_promises')[0].count, 0);
  setDevicePromise(cloud.dbPath, pia.email, 3, () => cloud.now());

  // After a later Plus period with more devices, only what goes beyond the promise goes on hold.
  setPlusUntil(cloud.dbPath, pia.vaultId, cloud.now() + 30 * DAY);
  pia.clients.D = await CloudClient.claim({ pairingCode: (await pia.client.makePairing('D')).pairingCode });
  pia.clients.E = await CloudClient.claim({ pairingCode: (await pia.client.makePairing('E')).pairingCode });
  cloud.advance(MINUTE);
  for (const name of ['A', 'B', 'C']) await syncs(pia.clients[name]);
  setPlusUntil(cloud.dbPath, pia.vaultId, 0);
  await cloud.sweep();
  cloud.advance(7 * DAY + MINUTE);
  for (const name of ['A', 'B', 'C']) await syncs(pia.clients[name]);
  await assert.rejects(pia.clients.E.listChanges(), (error) => error.code === 'device-paused' && /Your plan syncs 3 devices/.test(error.message));
  await onHold(pia.clients.D);

  // The script for someone who shows the old mail but was missed.
  setDevicePromise(cloud.dbPath, paul.email, 4);
  await syncs(paul.clients.C);
  setDevicePromise(cloud.dbPath, paul.email, 0);
  assert.equal(cloud.sql('SELECT COUNT(*) AS count FROM device_promises WHERE vaultId=?', paul.vaultId)[0].count, 0);
  const empty = join(await mkdtemp(join(tmpdir(), 'jotdrop-promise-')), 'cloud.db');
  assert.throws(() => setDevicePromise(empty, 'x@example.test', 3), /Start the server with sync on hold once first/);
});

test('a switch date ahead: the grace lasts until that date, with a reminder 3 days before', async (t) => {
  const cloud = await fixture(t, { syncPauseFrom: START + 40 * DAY });
  const owner = await account(cloud, 'quinn', FOUR), { D } = owner.clients;
  assert.equal(cloud.sql('SELECT pauseAt FROM sync_pauses')[0].pauseAt, START + 40 * DAY);
  assert.deepEqual(syncMails(cloud, owner.email), ['sync-pausing']);
  assert.equal(cloud.mails.at(-1).sync.pauseAt, iso(START + 40 * DAY));
  assert.equal((await D.status()).plan.sync.pauseAt, iso(START + 40 * DAY));
  cloud.advance(36 * DAY);
  await cloud.sweep();
  assert.deepEqual(syncMails(cloud, owner.email), ['sync-pausing']);
  cloud.advance(DAY + HOUR);
  await cloud.sweep();
  await cloud.sweep();
  assert.deepEqual(syncMails(cloud, owner.email), ['sync-pausing', 'sync-pause-reminder']);
  await syncs(D);
  cloud.advance(3 * DAY);
  await onHold(D);
  // Moving the date later after the rows exist: nobody is on hold before it.
  await cloud.stop();
  await cloud.start({ syncPauseFrom: START + 60 * DAY });
  await cloud.sweep();
  await syncs(D);
  assert.equal((await D.status()).plan.sync.pauseAt, iso(START + 60 * DAY));
});

test('deleting the account removes its pause and promise; starting over takes the promise along', async (t) => {
  const cloud = await fixture(t);
  const dan = await account(cloud, 'dan', FOUR);
  setDevicePromise(cloud.dbPath, dan.email, 3);
  assert.equal(cloud.sql('SELECT COUNT(*) AS count FROM sync_pauses WHERE vaultId=?', dan.vaultId)[0].count, 1);
  await dan.client.call('/account/delete', 'POST', { confirm: 'DELETE MY CLOUD', currentAuthKey: dan.authKey });
  for (const table of ['sync_pauses', 'device_promises']) assert.equal(cloud.sql(`SELECT COUNT(*) AS count FROM ${table} WHERE vaultId=?`, dan.vaultId)[0].count, 0, table);

  const eve = await account(cloud, 'eve', FOUR);
  setDevicePromise(cloud.dbPath, eve.email, 3);
  const started = await cloud.api('/auth/reset/start', { email: eve.email });
  const code = cloud.mails.filter((mail) => mail.to === eve.email && mail.kind === 'reset').at(-1).code;
  const restarted = await cloud.api('/auth/reset/restart', { resetId: started.body.resetId, code, confirm: 'DELETE CLOUD DATA', recoveryTokenHash: await hashToken(randomToken()), authKey: randomToken(), kdf: { salt: b64(randomBytes(16)), memory: 65536, passes: 3, parallelism: 1 },
    wrappedVaultKey: JSON.stringify(await encryptEnvelope(randomToken(), { vaultKey: generateVaultKey() }, 'jotdrop:wrap:v1')), deviceName: 'Fresh', deviceTokenHash: await hashToken(randomToken()) });
  assert.equal(restarted.status, 201, JSON.stringify(restarted.body));
  assert.equal(cloud.sql('SELECT COUNT(*) AS count FROM sync_pauses WHERE vaultId=?', eve.vaultId)[0].count, 0);
  assert.deepEqual(cloud.sql('SELECT vaultId,devices FROM device_promises WHERE devices=3').map((row) => ({ ...row })), [{ vaultId: restarted.body.vaultId, devices: 3 }]);
});

// One device: a folder in memory and its baselines, as in shared/sync.test.mjs.
function folder(client) {
  const files = new Map(), tracked = {}, index = { cursor: 0, objects: {} }, seen = {}, times = new WeakMap(), text = (value) => new TextDecoder().decode(value);
  let clock = 0;
  const modified = (bytes) => { if (!times.has(bytes)) times.set(bytes, ++clock); return times.get(bytes); };
  const local = {
    editing: new Set(),
    async list() { return new Map([...files].filter(([path]) => !isPreserved(path)).map(([path, bytes]) => [path, { size: bytes.length, modified: modified(bytes) }])); },
    async read(path) { return files.get(path); },
    async compareAndSet(path, expected, replacement) {
      const actual = files.get(path);
      if ((actual === undefined) !== (expected === null) || (actual && text(actual) !== text(expected))) return false;
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
  return { files, texts: () => [...files.values()].map(text), sync: () => syncFolder(remote, local, tracked, async () => {}, { seen }) };
}

test('a device on hold for 60 days with its own edits comes back without losing either side', async (t) => {
  const cloud = await fixture(t);
  const owner = await account(cloud, 'rosa', FOUR), { A, D } = owner.clients;
  const a = folder(A), d = folder(D), bytes = (value) => new TextEncoder().encode(value);
  a.files.set('notes/Shared.md', bytes('First line\n'));
  await a.sync();
  await d.sync();
  cloud.advance(7 * DAY + MINUTE);
  a.files.set('notes/Shared.md', bytes('First line\nFrom the phone\n'));
  await a.sync();
  d.files.set('notes/Shared.md', bytes('First line\nFrom the desk\n'));
  d.files.set('notes/Desk only.md', bytes('Written while on hold\n'));
  await assert.rejects(d.sync(), (error) => error.code === 'device-paused');
  cloud.advance(60 * DAY);
  await assert.rejects(d.sync(), (error) => error.code === 'device-paused');
  // "Sync here instead", then the sync treats it as a device that was offline for a long time.
  await choose(D, [owner.id('A'), owner.id('D')]);
  // Its base is older than the free plan's 30 days of history, so no merge: a conflict copy, as after 60 days offline.
  assert.equal((await d.sync()).conflicts, 1);
  await a.sync();
  const kept = (side, lines) => { const all = side.texts().join('\n'); for (const line of lines) assert.ok(all.includes(line), `${line} is kept`); };
  kept(d, ['From the phone', 'From the desk', 'Written while on hold']);
  kept(a, ['From the phone', 'Written while on hold']);
  assert.ok(d.files.has('notes/Shared.cloud-conflict-r2.md'));
});

test('the Play review account never goes on hold', async (t) => {
  const cloud = await fixture(t, { reviewLogin: { email: 'review@example.test', code: '424242' } });
  const review = await account(cloud, 'review', FOUR, { code: '424242' });
  cloud.advance(30 * DAY);
  await cloud.sweep();
  for (const client of Object.values(review.clients)) await syncs(client);
  assert.equal(cloud.sql('SELECT COUNT(*) AS count FROM sync_pauses')[0].count, 0);
  assert.equal((await review.clients.D.status()).plan.sync.state, 'all');
});

test('the mails about sync on hold say the date, the devices and what stays, in plain words', () => {
  const sync = { pauseAt: '2027-02-14T08:00:00.000Z', limit: 2, devices: 3, syncing: [{ name: 'Phone', app: 'android' }, { name: 'Obsidian on Windows', app: 'obsidian' }], onHold: [{ name: '<Old> laptop', app: 'web' }] };
  const pausing = mailText({ kind: 'sync-pausing', sync });
  assert.equal(pausing.subject, 'Sync goes on hold on some of your JotDrop devices');
  assert.match(pausing.body, /^Your JotDrop plan syncs 2 devices, and 3 are signed in\.\n\nFrom 14 February 2027, sync goes on hold on <Old> laptop \(web app\)\. Your notes stay on it, but changes made there no longer reach your other devices\. Phone \(Android app\) and Obsidian on Windows keep syncing\./);
  assert.match(pausing.body, /With JotDrop Plus every device syncs: https:\/\/app\.jotdrop\.net\/\?plan=plus/);
  const reminder = mailText({ kind: 'sync-pause-reminder', sync });
  assert.equal(reminder.subject, 'On 14 February 2027 sync goes on hold on some of your JotDrop devices');
  assert.match(reminder.body, /This is the last email about it\./);
  assert.match(mailHtml({ kind: 'sync-pausing', sync }), /&#60;Old&#62; laptop/);
  // A cloud with the promise of the old trial mail still reads that its devices keep working.
  const promised = mailText({ kind: 'trial-ended', trial: { usedMb: 0, quotaMb: 250, devices: 3, deviceLimit: 2, groups: 0, links: 0, promised: true } });
  assert.match(promised.body, /3 devices are signed in, and Free has 2\. They all keep working\. To add a new one, sign out one of these first\./);
  for (const mail of [pausing, reminder, promised]) assert.doesNotMatch(mail.subject + mail.body, /—/);
});

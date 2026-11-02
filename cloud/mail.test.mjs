import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudServer } from './server.mjs';
import { CloudClient } from './shared/client.mjs';
import { decryptEnvelope, encryptEnvelope, generateVaultKey, hashToken, randomToken } from './shared/crypto.mjs';
import { MAILS_PER_HOUR, addressHash, mailAddress, mailKeyPair, mailToNote, openMailBody, openMailKey, openMailPart, sealMail, senderHash } from './shared/mail.mjs';

const DAY = 24 * 60 * 60 * 1000, HOUR = 60 * 60 * 1000, MINUTE = 60 * 1000;
const DOMAIN = 'in.test.jotdrop.net';
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-mail-test-'));
  const mails = [];
  let now = Date.parse('2026-11-03T08:00:00Z');
  const mailinToken = randomToken();
  const app = await createCloudServer({ dataDir, mailer: async (mail) => { mails.push(mail); }, serverKey: randomToken(), enrollmentToken: randomToken(),
    clock: () => now, signupsPerAddress: 1000, mailDomain: DOMAIN, mailinToken, ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  const api = async (path, body, headers = {}) => {
    const response = await fetch(`${url}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: JSON.parse(await response.text() || 'null') };
  };
  const mailin = (path, body, token = mailinToken) => api(path, body, { Authorization: `Bearer ${token}` });
  return { mails, url, api, mailin, mailinToken, advance: (ms) => { now += ms; }, now: () => now };
}

async function signUp(cloud, name) {
  const email = `${name}@example.test`, vaultKey = generateVaultKey(), token = randomToken(), authKey = randomToken();
  const started = await cloud.api('/accounts', { email, authKey, kdf: { salt: b64(randomBytes(16)), memory: 65536, passes: 3, parallelism: 1 }, wrappedVaultKey: JSON.stringify(await encryptEnvelope(randomToken(), { vaultKey }, 'jotdrop:wrap:v1')), recoveryTokenHash: await hashToken(randomToken()), deviceName: 'Phone', deviceTokenHash: await hashToken(token) });
  assert.equal(started.status, 202);
  const code = cloud.mails.filter((mail) => mail.to === email && mail.kind === 'verify').at(-1).code;
  const verified = await cloud.api('/accounts/verify', { signupId: started.body.signupId, code });
  assert.equal(verified.status, 201);
  return { email, vaultKey, authKey, client: new CloudClient({ url: cloud.url, vaultId: verified.body.vaultId, deviceId: verified.body.deviceId, token, vaultKey }) };
}

/** What a client does to turn the feature on: derive the pair, invent the address, register only hash + sealed copy. */
async function enableMail(client, vaultKey, mode) {
  const pair = await mailKeyPair(vaultKey);
  const address = mailAddress(DOMAIN);
  const envelope = JSON.stringify(await encryptEnvelope(vaultKey, { address }, 'jotdrop:mail-address:v1'));
  await client.call('/mail', 'POST', { action: 'enable', publicKey: pair.publicKey, addressHash: await addressHash(address), addressEnvelope: envelope, ...mode ? { mode } : {} });
  return { pair, address };
}

/** What mailin does after parsing: seal in memory, deliver only sealed blobs. */
async function deliver(cloud, address, payload, parts = [], { sender = 'sender@example.test', id = crypto.randomUUID() } = {}) {
  const hashes = { addressHash: await addressHash(address), senderHash: await senderHash(sender) };
  const rcpt = await cloud.mailin('/mailin/rcpt', hashes);
  assert.equal(rcpt.status, 200);
  if (!rcpt.body.accept) return { rcpt: rcpt.body };
  const sealed = await sealMail(rcpt.body.publicKey, rcpt.body.vaultId, id, payload, parts);
  const outcome = await cloud.mailin('/mailin/deliver', { ...hashes, id, ephemeralKey: sealed.ephemeralKey, body: sealed.body, parts: sealed.parts });
  assert.equal(outcome.status, 200);
  return { rcpt: rcpt.body, outcome: outcome.body, id };
}

test('a mail travels sealed from delivery to a finished note', async (t) => {
  const cloud = await fixture(t);
  const { client, vaultKey } = await signUp(cloud, 'ana');
  const before = (await client.status()).mail;
  assert.deepEqual(before, { domain: DOMAIN, enabled: false, publicKey: null, address: null, mode: null, pending: 0, pendingBytes: 0 });
  const { pair, address } = await enableMail(client, vaultKey);
  const status = (await client.status()).mail;
  assert.equal(status.enabled, true);
  assert.equal(status.publicKey, pair.publicKey);
  assert.deepEqual(await decryptEnvelope(vaultKey, JSON.parse(status.address), 'jotdrop:mail-address:v1'), { address });
  const payload = { v: 1, from: 'Anna <anna@example.test>', to: address, subject: 'Receipt', date: 'Tue, 3 Nov 2026 09:00:00 +0100', text: 'See attachment.', attachments: [{ name: 'bon.pdf', type: 'application/pdf', size: 3 }] };
  const { outcome, id } = await deliver(cloud, address, payload, [Uint8Array.of(1, 2, 3)]);
  assert.deepEqual(outcome, { accept: true });
  const after = (await client.status()).mail;
  assert.equal(after.pending, 1);
  assert.ok(after.pendingBytes > 0);
  // The other side: list, fetch, open on the device, convert, delete.
  const list = await client.call('/mail', 'GET');
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].id, id);
  const item = await client.call(`/mail/${id}`, 'GET');
  const key = await openMailKey(pair.privateKey, pair.publicKey, item.ephemeralKey, id);
  const vaultId = client.credentials.vaultId;
  assert.deepEqual(await openMailBody(key, vaultId, id, item.body), payload);
  assert.deepEqual(item.parts, [{ n: 0, size: 3 + 28 }]);
  const part = await client.call(`/mail/${id}/parts/0`, 'GET');
  assert.deepEqual(await openMailPart(key, vaultId, id, 0, part.sealed), Uint8Array.of(1, 2, 3));
  const note = mailToNote(await openMailBody(key, vaultId, id, item.body), id, item.receivedAt);
  assert.ok(note.path.startsWith('notes/Mail/2026-11-03 Receipt '));
  assert.ok(note.content.includes('See attachment.'));
  await client.call(`/mail/${id}`, 'DELETE', {});
  assert.equal((await client.status()).mail.pending, 0);
  await assert.rejects(client.call(`/mail/${id}`, 'GET'), (error) => error.status === 404);
  // Delivering the same mail twice stores it once.
  const again = await deliver(cloud, address, payload, [], {});
  const copy = await cloud.mailin('/mailin/deliver', { addressHash: await addressHash(address), id: again.id, ephemeralKey: randomToken(), body: b64(randomBytes(40)), parts: [] });
  assert.deepEqual(copy.body, { accept: true });
  assert.equal((await client.status()).mail.pending, 1);
});

test('RCPT refuses unknown addresses, rotated-away addresses and clouds without Plus', async (t) => {
  const cloud = await fixture(t);
  const { client, vaultKey } = await signUp(cloud, 'ben');
  const first = await enableMail(client, vaultKey);
  const unknown = await cloud.mailin('/mailin/rcpt', { addressHash: await addressHash(mailAddress(DOMAIN)) });
  assert.deepEqual(unknown.body, { accept: false, code: 'unknown' });
  // Rotating turns the old address off at once and keeps the same key pair.
  const second = await enableMail(client, vaultKey);
  assert.equal(second.pair.publicKey, first.pair.publicKey);
  assert.notEqual(second.address, first.address);
  assert.deepEqual((await cloud.mailin('/mailin/rcpt', { addressHash: await addressHash(first.address) })).body, { accept: false, code: 'unknown' });
  assert.equal((await cloud.mailin('/mailin/rcpt', { addressHash: await addressHash(second.address) })).body.accept, true);
  // After Plus ends the address answers 550 and nothing is stored, but what lies there stays fetchable.
  await deliver(cloud, second.address, { v: 1, subject: 'kept' });
  cloud.advance(15 * DAY);
  assert.deepEqual((await cloud.mailin('/mailin/rcpt', { addressHash: await addressHash(second.address) })).body, { accept: false, code: 'no-plus' });
  assert.equal((await client.call('/mail', 'GET')).items.length, 1);
  // Turning the feature off keeps the sealed items too.
  await client.call('/mail', 'DELETE', {});
  assert.equal((await client.status()).mail.enabled, false);
  assert.equal((await client.status()).mail.pending, 1);
  assert.deepEqual((await cloud.mailin('/mailin/rcpt', { addressHash: await addressHash(second.address) })).body, { accept: false, code: 'unknown' });
});

test('the senders mode is a filter at RCPT; enabling needs Plus and a mail server', async (t) => {
  const cloud = await fixture(t);
  const { client, vaultKey } = await signUp(cloud, 'cas');
  const { address } = await enableMail(client, vaultKey, 'senders');
  await client.call('/mail/senders', 'POST', { senders: [await senderHash('mother@example.test')] });
  const refused = await deliver(cloud, address, { v: 1 }, [], { sender: 'stranger@example.test' });
  assert.deepEqual(refused.rcpt, { accept: false, code: 'sender' });
  const accepted = await deliver(cloud, address, { v: 1, subject: 'hi' }, [], { sender: 'Mother@Example.test' });
  assert.equal(accepted.outcome.accept, true);
  await client.call('/mail', 'POST', { action: 'mode', mode: 'open' });
  assert.equal((await deliver(cloud, address, { v: 1 }, [], { sender: 'stranger@example.test' })).outcome.accept, true);
  await assert.rejects(client.call('/mail/senders', 'POST', { senders: ['nohash'] }), (error) => error.status === 400);
  // Without Plus the feature cannot be turned on.
  const free = await signUp(cloud, 'dirk');
  cloud.advance(15 * DAY);
  await assert.rejects(enableMail(free.client, free.vaultKey), (error) => error.status === 402 && error.code === 'plus-required');
});

test('the hourly limit holds, deleting the cloud wipes every mail trace, and mailin needs its token', async (t) => {
  const cloud = await fixture(t);
  const { client, vaultKey, authKey } = await signUp(cloud, 'eva');
  const { address } = await enableMail(client, vaultKey);
  for (let index = 0; index < MAILS_PER_HOUR; index++) assert.equal((await deliver(cloud, address, { v: 1 })).outcome.accept, true, `mail ${index}`);
  assert.deepEqual((await deliver(cloud, address, { v: 1 })).rcpt, { accept: false, code: 'rate' });
  cloud.advance(HOUR + MINUTE);
  assert.equal((await deliver(cloud, address, { v: 1 })).outcome.accept, true);
  // Wrong or missing token: nothing answers.
  assert.equal((await cloud.mailin('/mailin/rcpt', { addressHash: await addressHash(address) }, randomToken())).status, 401);
  assert.equal((await cloud.api('/mailin/rcpt', { addressHash: await addressHash(address) })).status, 401);
  // Deleting the cloud deletes the address, the items and the log with it.
  await client.call('/account/delete', 'POST', { confirm: 'DELETE MY CLOUD', currentAuthKey: authKey });
  assert.deepEqual((await cloud.mailin('/mailin/rcpt', { addressHash: await addressHash(address) })).body, { accept: false, code: 'unknown' });
});

test('a server without mail settings says so and serves no mailin routes', async (t) => {
  const cloud = await fixture(t, { mailDomain: undefined, mailinToken: undefined });
  const { client, vaultKey } = await signUp(cloud, 'fem');
  assert.equal((await client.status()).mail.domain, null);
  await assert.rejects(enableMail(client, vaultKey), (error) => error.status === 503);
  assert.equal((await cloud.api('/mailin/rcpt', { addressHash: await addressHash(mailAddress(DOMAIN)) })).status, 401);
});

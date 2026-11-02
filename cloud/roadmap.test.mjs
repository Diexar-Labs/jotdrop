import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCloudServer } from './server.mjs';
import { ROADMAP, MAX_VOTES } from './roadmap.mjs';
import { setPlusUntil } from './set-plus.mjs';
import { CloudClient } from './shared/client.mjs';
import { encryptEnvelope, generateVaultKey, hashToken, randomToken } from './shared/crypto.mjs';

// "Plus gets it first" (Eric, 2 Nov 2026): Plus votes on what comes next, gets new features early, and paying
// accounts carry a supporter label.
const DAY = 24 * 60 * 60 * 1000;
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const ITEMS = [{ id: 'a', title: 'Idea A', text: 'First idea.' }, { id: 'b', title: 'Idea B', text: 'Second idea.' },
  { id: 'c', title: 'Idea C', text: 'Third idea.' }, { id: 'd', title: 'Idea D', text: 'Fourth idea.' }];

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-roadmap-test-'));
  const mails = [];
  let now = Date.parse('2026-11-02T08:00:00Z'), app;
  const settings = { dataDir, mailer: async (mail) => { mails.push(mail); }, serverKey: randomToken(), enrollmentToken: randomToken(), clock: () => now, signupsPerAddress: 1000, freeDeviceLimit: 100, roadmap: ITEMS, ...options };
  app = await createCloudServer(settings);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = () => `http://127.0.0.1:${app.port}`;
  const api = async (path, body) => {
    const response = await fetch(`${url()}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const answer = await response.text();
    return { status: response.status, body: answer ? JSON.parse(answer) : undefined };
  };
  const restart = async (extra) => { await app.close(); app = await createCloudServer({ ...settings, ...extra }); };
  return { mails, url, api, restart, app: () => app, advance: (ms) => { now += ms; } };
}

async function signUp(cloud, name) {
  const email = `${name}@example.test`, vaultKey = generateVaultKey(), token = randomToken(), authKey = randomToken();
  const started = await cloud.api('/accounts', { email, authKey, kdf: { salt: b64(randomBytes(16)), memory: 65536, passes: 3, parallelism: 1 }, wrappedVaultKey: JSON.stringify(await encryptEnvelope(randomToken(), { vaultKey }, 'jotdrop:wrap:v1')), recoveryTokenHash: await hashToken(randomToken()), deviceName: 'Phone', deviceTokenHash: await hashToken(token) });
  assert.equal(started.status, 202);
  const code = cloud.mails.filter((mail) => mail.to === email && mail.kind === 'verify').at(-1).code;
  const verified = await cloud.api('/accounts/verify', { signupId: started.body.signupId, code });
  assert.equal(verified.status, 201);
  const client = new CloudClient({ url: cloud.url(), vaultId: verified.body.vaultId, deviceId: verified.body.deviceId, token, vaultKey });
  client.authKey = authKey;
  return client;
}

const roadmap = (client) => client.call('/account/roadmap');
const vote = (client, itemId, on = true) => client.call('/account/roadmap', 'POST', { itemId, vote: on });
const refused = (promise, status, code) => assert.rejects(promise, (error) => { assert.equal(error.status, status); if (code) assert.equal(error.code, code); return true; });

test('the shipped roadmap has unique ids, a title and a short text, and no em dashes', () => {
  assert.equal(new Set(ROADMAP.map((item) => item.id)).size, ROADMAP.length);
  for (const item of ROADMAP) {
    assert.match(item.id, /^[a-z0-9-]+$/);
    assert.ok(item.title.length > 0 && item.title.length <= 40, item.title);
    assert.ok(item.text.length > 0 && item.text.length <= 140, item.text);
    assert.doesNotMatch(item.title + item.text, /—/);
  }
  assert.equal(MAX_VOTES, 3);
});

test('Plus votes for up to 3 ideas, can take a vote back, and everyone sees the counts', async (t) => {
  const cloud = await fixture(t);
  const ana = await signUp(cloud, 'ana'), ben = await signUp(cloud, 'ben');
  const list = await roadmap(ana);
  assert.deepEqual(list.items.map((item) => [item.id, item.votes, item.mine]), [['a', 0, false], ['b', 0, false], ['c', 0, false], ['d', 0, false]]);
  assert.equal(list.canVote, true);
  assert.equal(list.votesLeft, 3);
  for (const id of ['a', 'b', 'c']) await vote(ana, id);
  await vote(ana, 'a');
  await refused(vote(ana, 'd'), 409, 'too-many-votes');
  const after = await vote(ana, 'b', false);
  assert.equal(after.votesLeft, 1);
  await vote(ana, 'd');
  await vote(ben, 'a');
  const seen = await roadmap(ben);
  assert.deepEqual(seen.items.map((item) => [item.id, item.votes, item.mine]), [['a', 2, true], ['b', 0, false], ['c', 1, false], ['d', 1, false]]);
  await refused(vote(ana, 'zzz'), 404);
  await refused(ana.call('/account/roadmap', 'POST', { itemId: 'a' }), 400);
});

test('Free sees the list but cannot vote; taking a vote back still works after Plus ends', async (t) => {
  const cloud = await fixture(t);
  const ana = await signUp(cloud, 'ana');
  await vote(ana, 'a');
  cloud.advance(15 * DAY);
  const list = await roadmap(ana);
  assert.equal(list.canVote, false);
  assert.equal(list.items[0].votes, 1);
  await refused(vote(ana, 'b'), 402, 'plus-required');
  assert.equal((await vote(ana, 'a', false)).items[0].votes, 0);
});

test('an idea taken off the list frees its votes; deleting the account removes its votes', async (t) => {
  const cloud = await fixture(t);
  const ana = await signUp(cloud, 'ana');
  for (const id of ['a', 'b', 'c']) await vote(ana, id);
  await cloud.restart({ roadmap: ITEMS.filter((item) => item.id !== 'c') });
  const shorter = await roadmap(new CloudClient({ ...ana.credentials, url: cloud.url() }));
  assert.equal(shorter.votesLeft, 1);
  assert.deepEqual(shorter.items.map((item) => item.id), ['a', 'b', 'd']);
  const db = new DatabaseSync(cloud.app().dbPath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM roadmap_votes').get().count, 2, 'votes for an idea off the list are deleted'); } finally { db.close(); }
  const again = new CloudClient({ ...ana.credentials, url: cloud.url() });
  await again.call('/account/delete', 'POST', { confirm: 'DELETE MY CLOUD', currentAuthKey: ana.authKey });
  const after = new DatabaseSync(cloud.app().dbPath, { readOnly: true });
  try { assert.equal(after.prepare('SELECT COUNT(*) AS count FROM roadmap_votes').get().count, 0); } finally { after.close(); }
});

test('status: early access with any Plus, a supporter label only for paying accounts, early features open for everyone on their date', async (t) => {
  const cloud = await fixture(t, { earlyFeatures: [{ id: 'smooth-lines', everyoneFrom: '2026-12-01T00:00:00Z' }] });
  const ana = await signUp(cloud, 'ana');
  let status = await ana.status();
  assert.equal(status.plan.early, true);
  assert.equal(status.plan.supporter, false, 'a trial is no support');
  assert.deepEqual(status.features, { 'smooth-lines': true });
  setPlusUntil(cloud.app().dbPath, ana.credentials.vaultId, Date.parse('2027-11-02T00:00:00Z'));
  assert.equal((await ana.status()).plan.supporter, false, 'a grant is no support');
  setPlusUntil(cloud.app().dbPath, ana.credentials.vaultId, 0);
  cloud.advance(15 * DAY);
  status = await ana.status();
  assert.equal(status.plan.early, false);
  assert.deepEqual(status.features, { 'smooth-lines': false });
  cloud.advance(20 * DAY);
  assert.deepEqual((await ana.status()).features, { 'smooth-lines': true });
  const db = new DatabaseSync(cloud.app().dbPath);
  try { db.prepare("INSERT INTO subscriptions VALUES('sub_test',?,'active',?)").run(ana.credentials.vaultId, Date.parse('2027-12-01T00:00:00Z')); } finally { db.close(); }
  status = await ana.status();
  assert.equal(status.plan.name, 'plus');
  assert.equal(status.plan.supporter, true);
});

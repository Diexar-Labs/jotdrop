import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudServer } from './server.mjs';
import { mailHtml, mailText } from './mailer.mjs';
import { setPlusUntil } from './set-plus.mjs';
import { createLink } from './shared/links.mjs';
import { CloudClient } from './shared/client.mjs';
import { encryptEnvelope, generateVaultKey, hashToken, randomToken } from './shared/crypto.mjs';

// Every new account starts with 14 days of Plus (Eric, 2 Nov 2026), with a mail 3 days before the end and one on the day.
const DAY = 24 * 60 * 60 * 1000, HOUR = 60 * 60 * 1000, MINUTE = 60 * 1000;
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-trial-test-'));
  const mails = [];
  let now = Date.parse('2026-11-02T08:00:00Z'), app;
  const serverKey = randomToken(), enrollmentToken = randomToken();
  const start = async (extra = {}) => { app = await createCloudServer({ dataDir, mailer: async (mail) => { mails.push(mail); }, serverKey, enrollmentToken, clock: () => now, signupsPerAddress: 1000, sweepEvery: 10, ...options, ...extra }); };
  await start();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = () => `http://127.0.0.1:${app.port}`;
  const api = async (path, body) => {
    const response = await fetch(`${url()}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const answer = await response.text();
    return { status: response.status, body: answer ? JSON.parse(answer) : undefined };
  };
  const restart = async (extra) => { await app.close(); await start(extra); };
  return { mails, url, api, restart, app: () => app, now: () => now, advance: (ms) => { now += ms; }, sweep: () => new Promise((done) => setTimeout(done, 80)) };
}

async function signUp(cloud, name) {
  const email = `${name}@example.test`, vaultKey = generateVaultKey(), token = randomToken();
  const started = await cloud.api('/accounts', { email, authKey: randomToken(), kdf: { salt: b64(randomBytes(16)), memory: 65536, passes: 3, parallelism: 1 }, wrappedVaultKey: JSON.stringify(await encryptEnvelope(randomToken(), { vaultKey }, 'jotdrop:wrap:v1')), recoveryTokenHash: await hashToken(randomToken()), deviceName: 'Phone', deviceTokenHash: await hashToken(token) });
  assert.equal(started.status, 202);
  const code = cloud.mails.filter((mail) => mail.to === email && mail.kind === 'verify').at(-1).code;
  const verified = await cloud.api('/accounts/verify', { signupId: started.body.signupId, code });
  assert.equal(verified.status, 201);
  return { email, client: new CloudClient({ url: cloud.url(), vaultId: verified.body.vaultId, deviceId: verified.body.deviceId, token, vaultKey }) };
}

const trialMails = (cloud, email) => cloud.mails.filter((mail) => mail.to === email && mail.kind.startsWith('trial-')).map((mail) => mail.kind);

test('a new account starts with 14 days of Plus and cannot start a second trial', async (t) => {
  const cloud = await fixture(t);
  const { client } = await signUp(cloud, 'ana');
  const plan = (await client.status()).plan;
  const ends = new Date(cloud.now() + 14 * DAY).toISOString();
  assert.equal(plan.name, 'plus');
  assert.equal(plan.plusUntil, ends);
  assert.equal(plan.trialEnds, ends);
  assert.equal(plan.trialAvailable, false);
  assert.equal(plan.deviceLimit, null);
  await assert.rejects(client.call('/account/trial', 'POST', {}), (error) => error.status === 409);
  cloud.advance(14 * DAY + MINUTE);
  const after = (await client.status()).plan;
  assert.equal(after.name, 'free');
  assert.equal(after.trialEnds, null);
  assert.equal(after.trialAvailable, false);
});

test('a trial sends one mail 3 days before the end and one on the day, never twice', async (t) => {
  const cloud = await fixture(t);
  const { email } = await signUp(cloud, 'ben');
  cloud.advance(10 * DAY);
  await cloud.sweep();
  assert.deepEqual(trialMails(cloud, email), []);
  cloud.advance(DAY + HOUR);
  await cloud.sweep();
  await cloud.sweep();
  assert.deepEqual(trialMails(cloud, email), ['trial-ending']);
  const ending = cloud.mails.find((mail) => mail.kind === 'trial-ending');
  assert.equal(ending.trial.endsAt, new Date(Date.parse('2026-11-02T08:00:00Z') + 14 * DAY).toISOString());
  assert.match(mailText(ending).subject, /ends in 3 days/);
  assert.match(mailText(ending).body, /16 November/);
  assert.match(mailText(ending).body, /also fits in Free/);
  cloud.advance(3 * DAY);
  await cloud.sweep();
  await cloud.sweep();
  assert.deepEqual(trialMails(cloud, email), ['trial-ending', 'trial-ended']);
  assert.match(mailText(cloud.mails.at(-1)).body, /nothing changes for you/);
});

test('when the trial ends nothing is lost: extra devices keep working, a new one is refused, and the mail says so', async (t) => {
  const cloud = await fixture(t);
  const { email, client } = await signUp(cloud, 'cas');
  const laptop = await CloudClient.claim({ pairingCode: (await client.makePairing('Laptop')).pairingCode });
  const tablet = await CloudClient.claim({ pairingCode: (await client.makePairing('Tablet')).pairingCode });
  await createLink(client, { title: 'Trip', text: 'Plan' }, { origin: cloud.url(), days: 0 });
  await createLink(client, { title: 'Recipe', text: 'Soup' }, { origin: cloud.url(), days: 0 });
  cloud.advance(14 * DAY + HOUR);
  await cloud.sweep();
  await cloud.sweep();
  assert.deepEqual(trialMails(cloud, email), ['trial-ended']);
  for (const device of [client, laptop, tablet]) assert.equal((await device.status()).plan.name, 'free');
  await assert.rejects(client.makePairing('Watch'), (error) => error.status === 403);
  const ended = cloud.mails.at(-1);
  assert.equal(ended.trial.devices, 3);
  assert.equal(ended.trial.links, 2);
  const { body } = mailText(ended);
  assert.match(body, /3 devices are signed in, and Free has 2\. They all keep working/);
  assert.match(body, /2 note links are older than 7 days/);
  assert.doesNotMatch(body, /—/);
});

test('a running trial that is extended by a grant or a subscription sends no trial mails', async (t) => {
  const cloud = await fixture(t);
  const { email, client } = await signUp(cloud, 'dirk');
  setPlusUntil(cloud.app().dbPath, client.credentials.vaultId, Date.parse('2027-11-02T00:00:00Z'));
  assert.equal((await client.status()).plan.trialEnds, null);
  cloud.advance(12 * DAY);
  await cloud.sweep();
  cloud.advance(5 * DAY);
  await cloud.sweep();
  assert.deepEqual(trialMails(cloud, email), []);
  assert.equal((await client.status()).plan.name, 'plus');
});

test('a trial that ended long ago (server down) gets no late mail', async (t) => {
  const cloud = await fixture(t, { sweepEvery: 60 * 60 * 1000 });
  const { email } = await signUp(cloud, 'eva');
  cloud.advance(30 * DAY);
  await cloud.restart({ sweepEvery: 10 });
  await cloud.sweep();
  await cloud.sweep();
  assert.deepEqual(trialMails(cloud, email), []);
});

test('signupTrial 0 keeps new accounts on Free, as before', async (t) => {
  const cloud = await fixture(t, { signupTrial: 0 });
  const { client } = await signUp(cloud, 'fem');
  const plan = (await client.status()).plan;
  assert.equal(plan.name, 'free');
  assert.equal(plan.trialAvailable, true);
  assert.equal(plan.trialEnds, null);
});

test('trial mails name what goes beyond Free in plain words, also as HTML', () => {
  const trial = { usedMb: 312, quotaMb: 250, devices: 0, deviceLimit: 2, groups: 4, links: 1 };
  const { body } = mailText({ kind: 'trial-ended', trial });
  assert.match(body, /You use 312 MB, and Free has 250 MB\. Everything stays/);
  assert.match(body, /You share 4 notes or lists, and Free shares one/);
  assert.match(body, /1 note link is older than 7 days\. On Free a link lasts 7 days, so it is paused\. With Plus it works again\./);
  assert.doesNotMatch(body, /devices are signed in/);
  assert.match(body, /https:\/\/app\.jotdrop\.net\/\?plan=plus/);
  assert.match(mailHtml({ kind: 'trial-ended', trial }), /312 MB/);
  assert.doesNotMatch(body, /—/);
});

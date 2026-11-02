import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCloudServer } from './server.mjs';
import { createLink, listLinks, openLink, readLinkAddress, removeLink, reportLink } from './shared/links.mjs';
import { CloudClient } from './shared/client.mjs';
import { encryptEnvelope, generateVaultKey, hashToken, randomToken } from './shared/crypto.mjs';

const DAY = 24 * 60 * 60 * 1000, MINUTE = 60 * 1000;
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-links-test-'));
  const mails = [];
  let now = Date.parse('2026-11-02T08:00:00Z');
  const app = await createCloudServer({ dataDir, signupTrial: 0, mailer: async (mail) => { mails.push(mail); }, serverKey: randomToken(), enrollmentToken: randomToken(), clock: () => now, freeDeviceLimit: 100, signupsPerAddress: 1000, sweepEvery: 10 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = () => `http://127.0.0.1:${app.port}`;
  const api = async (path, body, headers = {}, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${url()}/api/v1${path}`, { method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const answer = await response.text();
    return { status: response.status, body: answer ? JSON.parse(answer) : undefined };
  };
  return { dataDir, mails, url, api, advance: (ms) => { now += ms; }, sweep: () => new Promise((done) => setTimeout(done, 60)) };
}

async function signUp(app, name) {
  app.advance(MINUTE + 1);
  const email = `${name}@example.test`, vaultKey = generateVaultKey(), token = randomToken();
  const started = await app.api('/accounts', { email, authKey: randomToken(), kdf: { salt: b64(randomBytes(16)), memory: 65536, passes: 3, parallelism: 1 }, wrappedVaultKey: JSON.stringify(await encryptEnvelope(randomToken(), { vaultKey }, 'jotdrop:wrap:v1')), recoveryTokenHash: await hashToken(randomToken()), deviceName: 'Phone', deviceTokenHash: await hashToken(token) });
  assert.equal(started.status, 202);
  const code = app.mails.filter((mail) => mail.to === email && mail.kind === 'verify').at(-1).code;
  const verified = await app.api('/accounts/verify', { signupId: started.body.signupId, code });
  assert.equal(verified.status, 201);
  return { email, client: new CloudClient({ url: app.url(), vaultId: verified.body.vaultId, deviceId: verified.body.deviceId, token, vaultKey }) };
}

const note = { title: 'Groceries', text: '- [ ] milk\n- [x] bread' };
const refused = async (promise, status, code) => {
  await assert.rejects(promise, (error) => { assert.equal(error.status, status); if (code) assert.equal(error.code, code); return true; });
};

test('anyone with the link reads the note; the server only has sealed text', async (t) => {
  const app = await fixture(t);
  const me = await signUp(app, 'ana');
  const link = await createLink(me.client, note, { origin: app.url() });
  assert.match(link.address, new RegExp(`^${app.url()}/n/[0-9a-f-]{36}#[\\w-]{43}$`));
  const { id, key } = readLinkAddress(link.address);
  const opened = await openLink(app.url(), id, key);
  assert.deepEqual({ title: opened.title, text: opened.text }, note);
  const raw = await app.api(`/public-links/${id}`);
  assert.equal(raw.status, 200);
  assert.ok(!JSON.stringify(raw.body).includes('milk') && !JSON.stringify(raw.body).includes('ana@'));
  assert.deepEqual(Object.keys(raw.body).sort(), ['envelope', 'expiresAt']);
  await assert.rejects(openLink(app.url(), id, generateVaultKey()));
});

test('the page holds no note, and search engines stay out', async (t) => {
  const app = await fixture(t);
  const me = await signUp(app, 'ana');
  const { id } = await createLink(me.client, note, { origin: app.url() });
  const page = await fetch(`${app.url()}/n/${id}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const html = await page.text();
  assert.ok(html.includes('note-link.js') && !html.includes('milk'));
  assert.equal((await fetch(`${app.url()}/n/not-a-link`)).status, 404);
});

test('the free plan has one link for 7 days; Plus has more and chooses how long', async (t) => {
  const app = await fixture(t);
  const me = await signUp(app, 'ana');
  await refused(createLink(me.client, note, { origin: app.url(), days: 30 }), 402, 'plus-required');
  await refused(createLink(me.client, note, { origin: app.url(), days: 0 }), 402, 'plus-required');
  const first = await createLink(me.client, note, { origin: app.url() });
  await refused(createLink(me.client, note, { origin: app.url() }), 402, 'plus-required');
  // Free again as soon as the old link is gone.
  await removeLink(me.client, first.id);
  const second = await createLink(me.client, note, { origin: app.url() });
  await me.client.call('/account/trial', 'POST', {});
  const forever = await createLink(me.client, note, { origin: app.url(), days: 0 });
  assert.equal(forever.expiresAt, null);
  const week = await createLink(me.client, note, { origin: app.url(), days: 30 });
  assert.equal(Date.parse(week.expiresAt) - Date.parse(new Date(Date.now()).toISOString()) > 0, true);
  assert.equal((await listLinks(me.client)).length, 3);
  assert.ok((await listLinks(me.client)).some((entry) => entry.id === second.id && entry.title === 'Groceries' && entry.address.includes('#')));
  await refused(createLink(me.client, note, { origin: app.url(), days: 2 }), 400);
});

test('a link ends on time, and without Plus a longer link falls back to 7 days', async (t) => {
  const app = await fixture(t);
  const me = await signUp(app, 'ana');
  const free = await createLink(me.client, note, { origin: app.url() });
  app.advance(7 * DAY + 1);
  // Ended (410), or already swept away (404) on a slow machine: either way it no longer opens.
  assert.ok([404, 410].includes((await app.api(`/public-links/${free.id}`)).status));
  await app.sweep();
  assert.equal((await app.api(`/public-links/${free.id}`)).status, 404);

  await me.client.call('/account/trial', 'POST', {});
  const forever = await createLink(me.client, note, { origin: app.url(), days: 0 });
  app.advance(10 * DAY);
  assert.equal((await app.api(`/public-links/${forever.id}`)).status, 200);
  // The 14-day trial ends: the link is older than 7 days, so it stops. Plus again brings it back.
  app.advance(5 * DAY);
  assert.equal((await app.api(`/public-links/${forever.id}`)).status, 410);
});

test('only the owner removes a link', async (t) => {
  const app = await fixture(t);
  const ana = await signUp(app, 'ana'), ben = await signUp(app, 'ben');
  const link = await createLink(ana.client, note, { origin: app.url() });
  await refused(removeLink(ben.client, link.id), 404);
  assert.equal((await app.api(`/public-links/${link.id}`)).status, 200);
  assert.deepEqual(await listLinks(ben.client), []);
  await removeLink(ana.client, link.id);
  assert.equal((await app.api(`/public-links/${link.id}`)).status, 404);
});

test('anyone can report a link; the mail names the link and its owner, not the note', async (t) => {
  const app = await fixture(t);
  const ana = await signUp(app, 'ana');
  const link = await createLink(ana.client, note, { origin: app.url() });
  await reportLink(app.url(), link.id, { reason: 'abuse', details: 'This is not ok' });
  const mail = app.mails.find((entry) => entry.kind === 'link-report');
  assert.equal(mail.to, 'hello@jotdrop.net');
  assert.equal(mail.report.linkId, link.id);
  assert.equal(mail.report.owner, 'ana@example.test');
  assert.ok(!JSON.stringify(mail).includes('milk'));
  await refused(reportLink(app.url(), link.id, { reason: 'nonsense' }), 400);
  await refused(reportLink(app.url(), randomUUID(), { reason: 'spam' }), 404);
});

test('too much for a link is refused, and bad requests do not reach the database', async (t) => {
  const app = await fixture(t);
  const me = await signUp(app, 'ana');
  await refused(createLink(me.client, { title: 'Big', text: 'x'.repeat(70 * 1024) }, { origin: app.url() }), 413);
  assert.equal((await app.api('/public-links/not-an-id')).status, 400);
});

test('closing an account ends its links', async (t) => {
  const app = await fixture(t);
  const me = await signUp(app, 'ana');
  const link = await createLink(me.client, note, { origin: app.url() });
  const db = new DatabaseSync(join(app.dataDir, 'cloud.db'));
  db.prepare('DELETE FROM accounts WHERE email=?').run(me.email);
  db.close();
  await app.sweep();
  assert.equal((await app.api(`/public-links/${link.id}`)).status, 404);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCloudServer } from './server.mjs';
import { createBrevoList } from './mailer.mjs';
import { confirmSignup, providerSignUp, providerTicket, signUp, startProviderSignIn } from './shared/account.mjs';
import { randomToken } from './shared/crypto.mjs';

const PASSWORD = 'correct horse battery staple';
const wait = () => new Promise((resolve) => setTimeout(resolve, 50));

async function google(url, init = {}) {
  const json = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'token' });
  if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return json({ sub: 'g-ann', email: 'ann@example.com', email_verified: true });
  throw new Error(`Unexpected request ${url}`);
}

async function fixture(t, newsletter, dataDir) {
  dataDir ??= await mkdtemp(join(tmpdir(), 'jotdrop-newsletter-test-'));
  const mails = [];
  const app = await createCloudServer({ dataDir, mailer: async (mail) => { mails.push(mail); }, newsletter, serverKey: randomToken(), freeDeviceLimit: 100, fetcher: google,
    oauth: { google: { clientId: 'google-id', clientSecret: 'google-secret' } } });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  const create = async (email, newsletter) => {
    const pending = await signUp({ url, email, password: PASSWORD, deviceName: 'Laptop', newsletter });
    return confirmSignup(pending, mails.filter((mail) => mail.to === email && mail.kind === 'verify').at(-1).code);
  };
  const consents = () => { const db = new DatabaseSync(join(dataDir, 'cloud.db')); try { return db.prepare('SELECT a.email, n.consentedAt, n.addedAt FROM newsletter n JOIN accounts a ON a.id=n.accountId ORDER BY a.email').all(); } finally { db.close(); } };
  return { app, url, dataDir, create, consents };
}

test('only people who tick the box go to the mailing list, after their account exists', async (t) => {
  const added = [];
  const cloud = await fixture(t, async (email) => { added.push(email); });

  const pending = await signUp({ url: cloud.url, email: 'early@example.com', password: PASSWORD, deviceName: 'Laptop', newsletter: true });
  await wait();
  assert.deepEqual(added, [], 'Nothing goes to the list before the address is confirmed');
  assert.ok(pending.signupId);

  await cloud.create('yes@example.com', true);
  await cloud.create('no@example.com', false);
  await wait();
  assert.deepEqual(added, ['yes@example.com']);

  // Google or GitHub: the same tick on "Create my JotDrop cloud".
  const { verifier, href } = await startProviderSignIn({ url: cloud.url, provider: 'google', client: 'web' });
  const authorize = new URL((await fetch(href, { redirect: 'manual' })).headers.get('location'));
  const callback = new URL(authorize.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'ann' }).toString();
  const back = new URL((await fetch(callback, { redirect: 'manual' })).headers.get('location'));
  const signIn = await providerTicket({ url: cloud.url, ticket: new URLSearchParams(back.hash.slice(1)).get('oauth'), verifier });
  await providerSignUp(signIn, { deviceName: 'Laptop', newsletter: true });
  await wait();
  assert.deepEqual(added, ['yes@example.com', 'ann@example.com']);

  const rows = cloud.consents();
  assert.deepEqual(rows.map((row) => row.email), ['ann@example.com', 'yes@example.com'], 'The consent is recorded only for those who ticked');
  assert.ok(rows.every((row) => row.consentedAt && row.addedAt));
});

test('a mailing-list failure never blocks signing up, and the consent waits to be sent again', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const cloud = await fixture(t, async () => { throw new Error('Brevo refused the contact (502).'); });
  const { client } = await cloud.create('yes@example.com', true);
  assert.ok(client, 'The account works');
  await wait();
  assert.equal(warn.mock.callCount(), 1);
  assert.doesNotMatch(String(warn.mock.calls[0].arguments[0]), /yes@example\.com/, 'The log does not repeat the address');
  assert.deepEqual(cloud.consents().map((row) => [row.email, row.addedAt]), [['yes@example.com', null]]);
});

test('a database from before the newsletter tick keeps working', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-newsletter-test-'));
  const old = await createCloudServer({ dataDir, mailer: async () => {}, serverKey: randomToken() });
  await old.close();
  const db = new DatabaseSync(join(dataDir, 'cloud.db'));
  db.exec('ALTER TABLE signups DROP COLUMN newsletter; DROP TABLE newsletter;');
  db.close();
  const added = [];
  const cloud = await fixture(t, async (email) => { added.push(email); }, dataDir);
  await cloud.create('yes@example.com', true);
  await wait();
  assert.deepEqual(added, ['yes@example.com']);
});

test('Brevo gets the address for the list, and a refusal is an error without the address', async () => {
  const calls = [];
  const add = createBrevoList({ apiKey: 'brevo-key', listId: 7, fetcher: async (url, init) => { calls.push({ url, init }); return new Response(null, { status: calls.length === 1 ? 201 : 400 }); } });
  await add('ann@example.com');
  assert.equal(calls[0].url, 'https://api.brevo.com/v3/contacts');
  assert.equal(calls[0].init.headers['api-key'], 'brevo-key');
  assert.deepEqual(JSON.parse(calls[0].init.body), { email: 'ann@example.com', listIds: [7], updateEnabled: true });
  await assert.rejects(add('ann@example.com'), (error) => /400/.test(error.message) && !error.message.includes('ann@'));
  assert.throws(() => createBrevoList({ apiKey: 'brevo-key', listId: Number(undefined) }), /list ID/);
});

test('Brevo forgets a deleted account; an address it never knew is fine', async () => {
  const calls = [];
  const list = createBrevoList({ apiKey: 'brevo-key', listId: 7, fetcher: async (url, init) => { calls.push({ url, init }); return new Response(null, { status: [204, 404, 500][calls.length - 1] }); } });
  await list.remove('ann+x@example.com');
  assert.equal(calls[0].url, 'https://api.brevo.com/v3/contacts/ann%2Bx%40example.com');
  assert.equal(calls[0].init.method, 'DELETE');
  await list.remove('never@example.com');
  await assert.rejects(list.remove('ann@example.com'), (error) => /500/.test(error.message) && !error.message.includes('ann@'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudServer } from './server.mjs';
import { approveDevice, availableProviders, checkApproval, completeApproval, confirmLogin, confirmSignup, logIn, providerApproval, providerRecover, providerSignUp, providerTicket, resetWithRecoveryCode, signUp, startProviderSignIn, startReset, listApprovals, accountInfo, changePassword } from './shared/account.mjs';
import { randomToken } from './shared/crypto.mjs';

const text = (value) => new TextEncoder().encode(value);
const decode = (value) => new TextDecoder().decode(Buffer.from(value, 'base64url'));
const PASSWORD = 'correct horse battery staple';

// Google and GitHub as the server sees them: a token endpoint and the API that says who signed in.
// The code the provider hands the browser names the person here.
const people = {
  ann: { google: { sub: 'g-ann', email: 'ann@example.com', email_verified: true }, github: { id: 7, emails: [{ email: 'old@example.com', primary: false, verified: true }, { email: 'ann@example.com', primary: true, verified: true }] } },
  bob: { google: { sub: 'g-bob', email: 'bob@example.com', email_verified: false }, github: { id: 8, emails: [{ email: 'bob@example.com', primary: true, verified: false }] } },
  eve: { google: { sub: 'g-eve', email: 'eve@example.com', email_verified: true } },
};
async function providers(url, init = {}) {
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  if (url === 'https://oauth2.googleapis.com/token' || url === 'https://github.com/login/oauth/access_token') {
    const form = new URLSearchParams(init.body);
    assert.equal(form.get('client_secret'), url.includes('google') ? 'google-secret' : 'github-secret');
    return people[form.get('code')] ? json({ access_token: `token-${form.get('code')}` }) : json({ error: 'bad_verification_code' }, 400);
  }
  const who = /token-(\w+)/.exec(init.headers?.Authorization ?? '')?.[1];
  if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return json(people[who].google);
  if (url === 'https://api.github.com/user') return json({ id: people[who].github.id });
  if (url === 'https://api.github.com/user/emails') return json(people[who].github.emails);
  throw new Error(`Unexpected request ${url}`);
}

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-oauth-test-'));
  const mails = [];
  let now = Date.parse('2026-10-24T08:00:00Z');
  const app = await createCloudServer({ dataDir, mailer: async (mail) => { mails.push(mail); }, serverKey: randomToken(), clock: () => now, freeDeviceLimit: 100, fetcher: providers,
    oauth: { google: { clientId: 'google-id', clientSecret: 'google-secret' }, github: { clientId: 'github-id', clientSecret: 'github-secret' } } });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  // What the browser does: start, sign in at the provider (who), and come back with a ticket.
  const signIn = async (provider, who, client = 'web') => {
    const { verifier, href } = await startProviderSignIn({ url, provider, client });
    const started = await fetch(href, { redirect: 'manual' });
    assert.equal(started.status, 302);
    const authorize = new URL(started.headers.get('location'));
    assert.equal(authorize.searchParams.get('client_id'), `${provider}-id`);
    const callback = new URL(authorize.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({ state: authorize.searchParams.get('state'), code: who }).toString();
    const back = await fetch(callback, { redirect: 'manual' });
    assert.equal(back.status, 302);
    const location = back.headers.get('location');
    const params = new URLSearchParams(location.startsWith('obsidian:') ? new URL(location).search : new URL(location).hash.slice(1));
    return { verifier, location, ticket: params.get('oauth'), error: params.get('oauth-error'), callback };
  };
  return { url, mails, signIn, advance: (ms) => { now += ms; } };
}

test('a new person signs up with Google, a second device gets the key by approval, and GitHub links to the same account', async (t) => {
  const cloud = await fixture(t);
  assert.deepEqual(await availableProviders(cloud.url), ['google', 'github']);

  // First device: no account yet, so a new cloud without a password, and a recovery code.
  const first = await cloud.signIn('google', 'ann');
  const info = await providerTicket({ url: cloud.url, ticket: first.ticket, verifier: first.verifier });
  assert.deepEqual([info.email, info.account, info.password], ['ann@example.com', false, false]);
  const { client: laptop, recoveryCode } = await providerSignUp(info, { deviceName: 'Laptop' });
  assert.ok(recoveryCode);
  await laptop.write('notes/Hello.md', text('From the laptop'), 0);
  assert.deepEqual(await accountInfo(laptop), { email: 'ann@example.com', totp: false, password: false, providers: ['google'] });
  // A ticket is used once.
  await assert.rejects(providerSignUp(info, { deviceName: 'Again' }), (error) => error.status === 401);

  // Second device: Google again, then approval with the four words on the laptop. No password involved.
  const second = await cloud.signIn('google', 'ann');
  const again = await providerTicket({ url: cloud.url, ticket: second.ticket, verifier: second.verifier });
  assert.deepEqual([again.account, again.password], [true, false]);
  await assert.rejects(providerSignUp(again, { deviceName: 'Phone' }), (error) => error.code === 'account-exists');
  const pending = await providerApproval(again);
  const [request] = await listApprovals(laptop);
  assert.deepEqual(request.words, pending.words);
  await approveDevice(laptop, request);
  const phone = await completeApproval(await checkApproval(pending), { deviceName: 'Phone' });
  const note = (await phone.listChanges()).changes[0];
  assert.equal(decode((await phone.read(note.id)).file.content), 'From the laptop');

  // GitHub with the same verified primary address: same account, the recovery code brings the key, and a mail says so.
  const github = await cloud.signIn('github', 'ann');
  const viaGithub = await providerTicket({ url: cloud.url, ticket: github.ticket, verifier: github.verifier });
  assert.deepEqual([viaGithub.email, viaGithub.account], ['ann@example.com', true]);
  await assert.rejects(providerRecover(viaGithub, { recoveryCode: recoveryCode.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), deviceName: 'Desktop' }));
  const desktop = await providerRecover(viaGithub, { recoveryCode, deviceName: 'Desktop' });
  assert.equal((await desktop.listChanges()).changes.length, 1);
  assert.deepEqual((await accountInfo(desktop)).providers, ['github', 'google']);
  assert.deepEqual(cloud.mails.filter((mail) => mail.kind === 'provider-linked').map((mail) => [mail.to, mail.provider]), [['ann@example.com', 'GitHub']]);
});

test('without a password, password screens explain how to add one, and "Forgot password" adds it', async (t) => {
  const cloud = await fixture(t);
  const signIn = await cloud.signIn('google', 'ann');
  const { client, recoveryCode } = await providerSignUp(await providerTicket({ url: cloud.url, ...signIn }), { deviceName: 'Laptop' });
  // A password login never matches an account without one.
  await assert.rejects(logIn({ url: cloud.url, email: 'ann@example.com', password: PASSWORD, deviceName: 'Other' }), (error) => error.status === 401);
  await assert.rejects(changePassword(client, { currentPassword: PASSWORD, newPassword: 'another long password' }), (error) => error.status === 401 || error.code === 'no-password');
  const response = await fetch(`${cloud.url}/api/v1/account/password`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${client.credentials.token}`, 'X-JotDrop-Vault': client.credentials.vaultId, 'X-JotDrop-Device': client.credentials.deviceId }, body: JSON.stringify({ currentAuthKey: randomToken(), kdf: { salt: 'AAAAAAAAAAAAAAAAAAAAAA', memory: 65536, passes: 3, parallelism: 1 }, authKey: randomToken(), wrappedVaultKey: JSON.stringify({ v: 1, iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA' }) }) });
  assert.equal((await response.json()).code, 'no-password');
  // Forgot password with the recovery code: now the account has a password too.
  const reset = await startReset({ url: cloud.url, email: 'ann@example.com' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const code = cloud.mails.filter((mail) => mail.kind === 'reset').at(-1).code;
  await resetWithRecoveryCode(reset, { code, recoveryCode, newPassword: PASSWORD, deviceName: 'Reset device' });
  const pending = await logIn({ url: cloud.url, email: 'ann@example.com', password: PASSWORD, deviceName: 'Other' });
  const other = await confirmLogin(pending, cloud.mails.filter((mail) => mail.kind === 'login').at(-1).code);
  assert.deepEqual(await accountInfo(other), { email: 'ann@example.com', totp: false, password: true, providers: ['google'] });
});

test('an account made with a password can also be opened with Google, but never replaced', async (t) => {
  const cloud = await fixture(t);
  const pending = await signUp({ url: cloud.url, email: 'eve@example.com', password: PASSWORD, deviceName: 'Laptop' });
  const { recoveryCode } = await confirmSignup(pending, cloud.mails.find((mail) => mail.kind === 'verify').code);
  const signIn = await cloud.signIn('google', 'eve');
  const info = await providerTicket({ url: cloud.url, ...signIn });
  assert.deepEqual([info.account, info.password], [true, true]);
  await assert.rejects(providerSignUp(info, { deviceName: 'Phone' }), (error) => error.code === 'account-exists');
  const phone = await providerRecover(info, { recoveryCode, deviceName: 'Phone' });
  assert.deepEqual(await accountInfo(phone), { email: 'eve@example.com', totp: false, password: true, providers: ['google'] });
});

test('provider sign-in refuses unverified addresses, stolen tickets, old tickets and replayed states', async (t) => {
  const cloud = await fixture(t);
  // No verified address at Google or GitHub: no ticket, a clear message back on the page.
  for (const provider of ['google', 'github']) {
    const result = await cloud.signIn(provider, 'bob');
    assert.equal(result.ticket, null);
    assert.match(result.error, /no verified email/);
  }
  // Coming back to Obsidian: the ticket is in an obsidian:// link, useless without this device's verifier.
  const obsidian = await cloud.signIn('google', 'ann', 'obsidian');
  assert.match(obsidian.location, /^obsidian:\/\/jotdrop-cloud\?oauth=/);
  await assert.rejects(providerTicket({ url: cloud.url, ticket: obsidian.ticket, verifier: randomToken() }), (error) => error.status === 401);
  assert.equal((await providerTicket({ url: cloud.url, ticket: obsidian.ticket, verifier: obsidian.verifier })).email, 'ann@example.com');
  // A state works once.
  const replay = await fetch(obsidian.callback, { redirect: 'manual' });
  assert.equal(replay.status, 400);
  // Tickets last ten minutes.
  const late = await cloud.signIn('google', 'ann');
  cloud.advance(11 * 60 * 1000);
  await assert.rejects(providerTicket({ url: cloud.url, ticket: late.ticket, verifier: late.verifier }), (error) => error.status === 401);
  // Cancelled at the provider: back to the page with a message.
  const { href } = await startProviderSignIn({ url: cloud.url, provider: 'github', client: 'web' });
  const authorize = new URL((await fetch(href, { redirect: 'manual' })).headers.get('location'));
  const cancelled = await fetch(`${authorize.searchParams.get('redirect_uri')}?state=${authorize.searchParams.get('state')}&error=access_denied`, { redirect: 'manual' });
  assert.match(decodeURIComponent(cancelled.headers.get('location')), /cancelled/);
  // Unknown provider or a server without provider settings.
  assert.equal((await fetch(`${cloud.url}/api/v1/auth/oauth/apple/start?client=web`)).status, 404);
});

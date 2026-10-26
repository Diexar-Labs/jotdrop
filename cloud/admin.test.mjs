import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { base32, createCloudServer, hashAdminPassword } from './server.mjs';

const DAY = 24 * 60 * 60 * 1000, MINUTE = 60 * 1000;
const PASSWORD = 'owner password for tests';
const SECRET = base32(randomBytes(20));
// Cheaper than the setup default (64 MiB), still within what the server accepts.
const PASSWORD_HASH = await hashAdminPassword(PASSWORD, { memory: 19456, passes: 2 });
const ADMIN = 'https://admin.example.test', APP = 'https://app.example.test';
const GENERIC = 'Invalid password or code.';

/** RFC 6238 as an authenticator app computes it. */
function totp(secret, time) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', bytes = [];
  let bits = 0, value = 0;
  for (const character of secret) {
    value = ((value << 5) | alphabet.indexOf(character)) & 0xfff; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30000)));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest(), offset = mac[19] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-admin-test-'));
  let now = Date.parse('2026-10-26T12:00:00Z'), app;
  const start = async () => { app = await createCloudServer({ dataDir, clock: () => now, publicOrigin: APP, adminOrigin: ADMIN, adminPasswordHash: PASSWORD_HASH, adminTotpSecret: SECRET, ...options }); };
  await start();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  // State-changing requests carry the dashboard's Origin unless a test says otherwise.
  const call = (method, path, { host = 'admin.example.test', origin = method === 'GET' ? undefined : ADMIN, cookie, body, ip } = {}) => new Promise((done, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { Host: host, ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(ip ? { 'X-JotDrop-Client-IP': ip } : {}), ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) };
    request({ host: '127.0.0.1', port: app.port, method, path, headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => { let json; try { json = JSON.parse(text); } catch { json = undefined; } done({ status: response.statusCode, headers: response.headers, text, body: json }); });
    }).on('error', reject).end(payload);
  });
  const code = (time = now) => totp(SECRET, time);
  const login = (extra = {}) => call('POST', '/api/admin/login', { body: { password: PASSWORD, code: code() }, ...extra });
  const cookieOf = (response) => response.headers['set-cookie'][0].split(';')[0];
  const restart = async () => { await app.close(); await start(); };
  return { app: () => app, dataDir, call, code, login, cookieOf, restart, advance: (ms) => { now += ms; }, time: () => now };
}

test('the admin dashboard is off unless its origin, password hash and authenticator secret are all set', async (t) => {
  const off = await fixture(t, { adminOrigin: undefined, adminPasswordHash: undefined, adminTotpSecret: undefined });
  assert.equal((await off.call('GET', '/')).status, 403);
  assert.equal((await off.call('GET', '/api/admin/summary', { host: 'app.example.test' })).status, 404);
  assert.equal((await off.call('POST', '/api/admin/login', { host: 'app.example.test', origin: APP, body: { password: PASSWORD, code: off.code() } })).status, 404);
  for (const partial of [{ adminTotpSecret: undefined }, { adminPasswordHash: undefined }]) {
    const half = await fixture(t, partial);
    assert.equal((await half.call('GET', '/')).status, 404);
    assert.equal((await half.call('GET', '/admin.js')).status, 404);
    assert.equal((await half.login()).status, 404);
  }
  const { dataDir } = off;
  const settings = { publicOrigin: APP, adminOrigin: ADMIN, adminPasswordHash: PASSWORD_HASH, adminTotpSecret: SECRET };
  for (const [wrong, message] of [
    [{ adminOrigin: 'http://admin.example.test' }, /HTTPS origin for the admin/], [{ adminOrigin: 'https://admin.example.test/' }, /HTTPS origin for the admin/], [{ adminOrigin: APP }, /its own host/],
    [{ adminPasswordHash: PASSWORD_HASH.replaceAll(':', '$') }, /password hash/], [{ adminPasswordHash: PASSWORD_HASH.replace('m=19456', 'm=1024') }, /password hash/], [{ adminPasswordHash: 'secret' }, /password hash/],
    [{ adminTotpSecret: SECRET.toLowerCase() }, /authenticator secret/], [{ adminTotpSecret: SECRET.slice(0, 20) }, /authenticator secret/], [{ adminTotpSecret: `${SECRET}1` }, /authenticator secret/],
  ]) await assert.rejects(createCloudServer({ dataDir, ...settings, ...wrong }), message);
});

test('only the dashboard answers on the admin host, and never on the app host or loopback', async (t) => {
  const admin = await fixture(t);
  const page = await admin.call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>JotDrop Admin<\/title>/);
  assert.match(page.headers['content-security-policy'], /default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self';/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal((await admin.call('GET', '/admin.js')).status, 200);
  assert.equal((await admin.call('GET', '/admin.css')).status, 200);
  for (const path of ['/app.js', '/style.css', '/privacy', '/shared/client.mjs', '/api/v1/status', '/api/v1/auth/providers', '/cloud.db']) assert.equal((await admin.call('GET', path)).status, 404, path);
  for (const path of ['/api/v1/vaults', '/api/v1/auth/login', '/api/v1/stripe/webhook']) assert.equal((await admin.call('POST', path, { body: {} })).status, 404, path);
  for (const host of ['app.example.test', `127.0.0.1:${admin.app().port}`]) {
    const origin = host === 'app.example.test' ? APP : `http://${host}`;
    for (const path of ['/admin.js', '/admin.css', '/api/admin/summary', '/api/admin/accounts']) assert.equal((await admin.call('GET', path, { host })).status, 404, `${host}${path}`);
    assert.equal((await admin.call('POST', '/api/admin/login', { host, origin, body: { password: PASSWORD, code: admin.code() } })).status, 404);
    assert.doesNotMatch((await admin.call('GET', '/', { host })).text, /JotDrop Admin/);
  }
  assert.equal((await admin.call('GET', '/api/v1/auth/providers', { host: 'app.example.test' })).status, 200);
  // The dashboard's Origin is the only one it accepts, and changes must carry it.
  assert.equal((await admin.call('GET', '/', { origin: APP })).status, 403);
  assert.equal((await admin.login({ origin: APP })).status, 403);
  assert.equal((await admin.login({ origin: null })).status, 403);
  assert.equal((await admin.call('GET', '/api/v1/auth/providers', { host: 'app.example.test', origin: ADMIN })).status, 403);
});

test('wrong password, wrong code and a used code all get the same answer', async (t) => {
  const admin = await fixture(t);
  const right = admin.code(), wrong = String((Number(right) + 1) % 1000000).padStart(6, '0');
  for (const body of [{ password: 'not the password', code: right }, { password: PASSWORD, code: wrong }, { password: PASSWORD, code: 'abcdef' }, { password: PASSWORD }, { code: right }]) {
    const response = await admin.call('POST', '/api/admin/login', { body, ip: '198.51.100.7' });
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: GENERIC });
    assert.equal(response.headers['set-cookie'], undefined);
  }
  // A wrong password does not use up the code.
  const first = await admin.login();
  assert.equal(first.status, 200);
  assert.match(first.headers['set-cookie'][0], /^__Host-jotdrop_admin=[A-Za-z0-9_-]{43}; Max-Age=28800; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
  for (const time of [admin.time(), admin.time() - 30000]) assert.deepEqual((await admin.call('POST', '/api/admin/login', { body: { password: PASSWORD, code: admin.code(time) } })).body, { error: GENERIC });
  // Still used after a restart.
  await admin.restart();
  assert.deepEqual((await admin.login()).body, { error: GENERIC });
  admin.advance(30000);
  assert.equal((await admin.login()).status, 200);
});

test('sign-in is limited per address and locks for everyone after repeated failures', async (t) => {
  const admin = await fixture(t);
  const wrong = (ip) => admin.call('POST', '/api/admin/login', { body: { password: 'guess', code: admin.code() }, ip });
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await wrong('203.0.113.1')).status, 401);
  const limited = await wrong('203.0.113.1');
  assert.equal(limited.status, 429);
  assert.equal((await admin.login({ ip: '203.0.113.1' })).status, 429);
  // The address comes from the proxy header, so another visitor is counted apart, until the lock after 10 failures.
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await wrong('203.0.113.2')).status, 401);
  const locked = await admin.login({ ip: '203.0.113.3' });
  assert.equal(locked.status, 429);
  assert.equal(locked.headers['set-cookie'], undefined);
  admin.advance(14 * MINUTE);
  assert.equal((await admin.login({ ip: '203.0.113.4' })).status, 429);
  admin.advance(MINUTE + 1000);
  assert.equal((await admin.login({ ip: '203.0.113.4' })).status, 200);
});

test('a session ends after 30 idle minutes, after 8 hours, and on log out', async (t) => {
  const admin = await fixture(t);
  assert.equal((await admin.call('GET', '/api/admin/summary')).status, 401);
  assert.equal((await admin.call('GET', '/api/admin/accounts', { cookie: `__Host-jotdrop_admin=${'A'.repeat(43)}` })).status, 401);
  let cookie = admin.cookieOf(await admin.login());
  assert.equal((await admin.call('GET', '/api/admin/summary', { cookie })).status, 200);
  admin.advance(29 * MINUTE);
  assert.equal((await admin.call('GET', '/api/admin/accounts', { cookie })).status, 200);
  admin.advance(30 * MINUTE);
  assert.deepEqual((await admin.call('GET', '/api/admin/summary', { cookie })).body, { error: 'Sign in again.' });
  admin.advance(30000);
  cookie = admin.cookieOf(await admin.login());
  for (let used = 25; used < 8 * 60; used += 25) {
    admin.advance(25 * MINUTE);
    assert.equal((await admin.call('GET', '/api/admin/summary', { cookie })).status, 200);
  }
  admin.advance(25 * MINUTE);
  assert.equal((await admin.call('GET', '/api/admin/summary', { cookie })).status, 401);
  admin.advance(30000);
  cookie = admin.cookieOf(await admin.login());
  assert.equal((await admin.call('POST', '/api/admin/logout', { cookie, origin: APP })).status, 403);
  assert.equal((await admin.call('POST', '/api/admin/logout', { cookie, origin: null })).status, 403);
  assert.equal((await admin.call('GET', '/api/admin/summary', { cookie })).status, 200);
  const out = await admin.call('POST', '/api/admin/logout', { cookie, body: {} });
  assert.equal(out.status, 200);
  assert.match(out.headers['set-cookie'][0], /^__Host-jotdrop_admin=; Max-Age=0; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
  assert.equal((await admin.call('GET', '/api/admin/summary', { cookie })).status, 401);
});

test('totals and the account list match the database and never include secrets', async (t) => {
  const stripe = { secretKey: 'sk_test_admin', webhookSecret: 'whsec_admin', monthPrice: 'price_month', yearPrice: 'price_year', founderYearPrice: 'price_founder', founderLimit: 3 };
  const admin = await fixture(t, { stripe, quotaBytes: 1000000, plusQuotaBytes: 5000000 });
  const now = admin.time(), iso = (time) => new Date(time).toISOString();
  const db = new DatabaseSync(join(admin.dataDir, 'cloud.db'), { timeout: 5000 });
  const envelopes = (vaultId, sizes) => { for (const size of sizes) db.prepare('INSERT INTO envelopes(vaultId,id,envelopeHash,envelope,size) VALUES(?,?,?,?,?)').run(vaultId, randomUUID(), `ENVELOPE-HASH-${randomUUID()}`, 'SECRET-ENVELOPE-CONTENT', size); };
  const cloud = (vaultId, sizes) => { db.prepare("INSERT INTO vaults VALUES(?,?,'account')").run(vaultId, 'RECOVERY-HASH'.padEnd(64, '0')); envelopes(vaultId, sizes); };
  const account = (email, createdAt, { password = true, totp = false } = {}) => {
    const id = randomUUID(), vaultId = randomUUID();
    cloud(vaultId, []);
    db.prepare('INSERT INTO accounts(id,email,vaultId,kdf,authHash,wrappedVaultKey,createdAt,passwordChangedAt,totpSecret) VALUES(?,?,?,?,?,?,?,?,?)').run(id, email, vaultId, password ? '{"salt":"KDF-SALT"}' : '', password ? 'AUTH-HASH$0' : '', password ? 'WRAPPED-VAULT-KEY' : '', createdAt, createdAt, totp ? 'SEALED-TOTP-SECRET' : null);
    return { id, vaultId };
  };
  const device = (vaultId, lastSeenAt, revoked = 0) => db.prepare('INSERT INTO devices VALUES(?,?,?,?,?,?,?)').run(randomUUID(), vaultId, 'Phone', 'DEVICE-TOKEN-HASH', lastSeenAt, lastSeenAt, revoked);
  const identity = (provider, accountId) => db.prepare('INSERT INTO identities VALUES(?,?,?,?)').run(provider, randomUUID(), accountId, iso(now));
  // Alice: new this week, trial Plus, authenticator, Google, newsletter, two active devices and one signed out.
  const alice = account('alice@example.test', '2026-10-24T09:00:00.000Z', { totp: true });
  identity('google', alice.id);
  db.prepare('INSERT INTO newsletter VALUES(?,?,NULL)').run(alice.id, iso(now));
  db.prepare('INSERT INTO plans VALUES(?,?,1)').run(alice.vaultId, now + 10 * DAY);
  device(alice.vaultId, '2026-10-25T10:00:00.000Z'); device(alice.vaultId, '2026-10-26T08:00:00.000Z'); device(alice.vaultId, '2026-10-26T11:00:00.000Z', 1);
  envelopes(alice.vaultId, [3000, 2000]);
  // Bob: new this month, no password (GitHub and Google), paying for Plus.
  const bob = account('bob@example.test', '2026-10-01T09:00:00.000Z', { password: false });
  identity('google', bob.id); identity('github', bob.id);
  db.prepare('INSERT INTO newsletter VALUES(?,?,?)').run(bob.id, iso(now), iso(now));
  db.prepare("INSERT INTO subscriptions VALUES('sub_bob',?,'active',?)").run(bob.vaultId, now + 30 * DAY);
  device(bob.vaultId, '2026-10-20T07:30:00.000Z');
  envelopes(bob.vaultId, [7000]);
  // A large file is stored in encrypted pieces; they count as storage too.
  db.prepare('INSERT INTO chunks VALUES(?,?,?,?,?,1)').run(bob.vaultId, 'piece-1', 4000, Buffer.from('SECRET-PIECE-CONTENT'), now);
  // Carol: older, Plus ended (a cancelled subscription still holds a founder place), no devices.
  const carol = account('carol@example.test', '2026-08-01T09:00:00.000Z');
  db.prepare('INSERT INTO plans VALUES(?,?,1)').run(carol.vaultId, now - 6 * DAY);
  db.prepare("INSERT INTO subscriptions VALUES('sub_carol',?,'canceled',?)").run(carol.vaultId, now - 5 * DAY);
  // A cloud from before accounts: its storage counts, it is not an account.
  cloud(randomUUID(), [500]);
  db.close();

  const cookie = admin.cookieOf(await admin.login());
  const get = async (path) => { const response = await admin.call('GET', path, { cookie }); assert.equal(response.status, 200, response.text); return response; };
  const summary = await get('/api/admin/summary');
  const { storage, ...rest } = summary.body;
  assert.deepEqual(rest, { generatedAt: iso(now), accounts: { total: 3, newLast7Days: 1, newLast30Days: 2, plus: 2, paying: 1, free: 1 }, founder: { taken: 2, limit: 3 } });
  assert.equal(storage.storedBytes, 16500);
  assert.ok(storage.databaseBytes > 0 && storage.diskTotalBytes >= storage.diskFreeBytes && storage.diskFreeBytes > 0);

  const list = await get('/api/admin/accounts');
  assert.deepEqual(list.body, { total: 3, page: 1, pageSize: 500, accounts: [
    { email: 'alice@example.test', createdAt: '2026-10-24T09:00:00.000Z', hasPassword: true, hasAuthenticator: true, providers: ['google'], plan: 'plus', plusUntil: iso(now + 10 * DAY), subscribed: false, usedBytes: 5000, quotaBytes: 5000000, activeDevices: 2, lastActiveAt: '2026-10-26T11:00:00.000Z', newsletter: true },
    { email: 'bob@example.test', createdAt: '2026-10-01T09:00:00.000Z', hasPassword: false, hasAuthenticator: false, providers: ['github', 'google'], plan: 'plus', plusUntil: iso(now + 30 * DAY), subscribed: true, usedBytes: 11000, quotaBytes: 5000000, activeDevices: 1, lastActiveAt: '2026-10-20T07:30:00.000Z', newsletter: true },
    { email: 'carol@example.test', createdAt: '2026-08-01T09:00:00.000Z', hasPassword: true, hasAuthenticator: false, providers: [], plan: 'free', plusUntil: iso(now - 5 * DAY), subscribed: false, usedBytes: 0, quotaBytes: 1000000, activeDevices: 0, lastActiveAt: null, newsletter: false },
  ] });
  const emails = async (query) => (await get(`/api/admin/accounts?${query}`)).body.accounts.map((entry) => entry.email.split('@')[0]);
  assert.deepEqual(await emails('q=BO'), ['bob']);
  assert.deepEqual(await emails('q=%25'), []);
  assert.deepEqual(await emails('sort=email&order=desc'), ['carol', 'bob', 'alice']);
  assert.deepEqual(await emails('sort=storage'), ['bob', 'alice', 'carol']);
  assert.deepEqual(await emails('sort=active'), ['alice', 'bob', 'carol']);
  assert.deepEqual(await emails('sort=active&order=asc'), ['bob', 'alice', 'carol']);
  const second = (await get('/api/admin/accounts?sort=email&limit=2&page=2')).body;
  assert.deepEqual([second.accounts.map((entry) => entry.email), second.total, second.page, second.pageSize], [['carol@example.test'], 3, 2, 2]);
  for (const query of ['sort=password', 'order=up', 'limit=501', 'limit=0', 'page=0', 'page=1.5', `q=${'a'.repeat(255)}`]) assert.equal((await admin.call('GET', `/api/admin/accounts?${query}`, { cookie })).status, 400, query);

  // Metadata only: no secret field names and none of the stored secret values.
  const forbidden = ['authHash', 'wrappedVaultKey', 'totpSecret', 'totpPending', 'tokenHash', 'kdf', 'envelope', 'envelopeHash', 'recoveryHash', 'codeHash', 'vaultId', 'id', 'secret'];
  const keys = (value) => value && typeof value === 'object' ? Object.entries(value).flatMap(([key, entry]) => [key, ...keys(entry)]) : [];
  for (const response of [summary, list]) {
    for (const key of keys(response.body)) assert.ok(!forbidden.includes(key), key);
    for (const value of ['KDF-SALT', 'AUTH-HASH', 'WRAPPED-VAULT-KEY', 'SEALED-TOTP-SECRET', 'DEVICE-TOKEN-HASH', 'RECOVERY-HASH', 'ENVELOPE-HASH', 'SECRET-ENVELOPE-CONTENT', 'SECRET-PIECE-CONTENT', alice.vaultId, alice.id, SECRET, PASSWORD_HASH]) assert.ok(!response.text.includes(value), value);
  }
});

test('the setup script prints settings the server accepts, without the password', async (t) => {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'admin-setup.mjs'), password = 'a long owner password';
  const mismatch = spawnSync(process.execPath, [script, ADMIN], { input: `${password}\nanother password\n`, encoding: 'utf8' });
  assert.equal(mismatch.status, 1);
  assert.equal(mismatch.stdout, '');
  assert.equal(spawnSync(process.execPath, [script, ADMIN], { input: 'too short\ntoo short\n', encoding: 'utf8' }).status, 1);
  const made = spawnSync(process.execPath, [script, ADMIN], { input: `${password}\n${password}\n`, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const env = Object.fromEntries(made.stdout.trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.deepEqual(Object.keys(env), ['JOTDROP_CLOUD_ADMIN_ORIGIN', 'JOTDROP_CLOUD_ADMIN_PASSWORD_HASH', 'JOTDROP_CLOUD_ADMIN_TOTP_SECRET']);
  assert.equal(env.JOTDROP_CLOUD_ADMIN_ORIGIN, ADMIN);
  assert.match(env.JOTDROP_CLOUD_ADMIN_PASSWORD_HASH, /^argon2id:m=65536,t=3,p=1:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{43}$/);
  assert.match(env.JOTDROP_CLOUD_ADMIN_TOTP_SECRET, /^[A-Z2-7]{32}$/);
  assert.ok(made.stderr.includes(`otpauth://totp/JotDrop%20Admin?secret=${env.JOTDROP_CLOUD_ADMIN_TOTP_SECRET}&issuer=JotDrop`));
  assert.ok(!`${made.stdout}${made.stderr}`.includes(password));
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-admin-setup-test-'));
  const app = await createCloudServer({ dataDir, adminOrigin: env.JOTDROP_CLOUD_ADMIN_ORIGIN, adminPasswordHash: env.JOTDROP_CLOUD_ADMIN_PASSWORD_HASH, adminTotpSecret: env.JOTDROP_CLOUD_ADMIN_TOTP_SECRET });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const payload = JSON.stringify({ password, code: totp(env.JOTDROP_CLOUD_ADMIN_TOTP_SECRET, Date.now()) });
  const status = await new Promise((done, reject) => request({ host: '127.0.0.1', port: app.port, method: 'POST', path: '/api/admin/login', headers: { Host: 'admin.example.test', Origin: ADMIN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
    (response) => { response.resume(); done(response.statusCode); }).on('error', reject).end(payload));
  assert.equal(status, 200);
});

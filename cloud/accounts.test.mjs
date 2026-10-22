import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { argon2Sync, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCloudServer } from './server.mjs';
import { CloudClient } from './shared/client.mjs';
import { decryptEnvelope, encryptEnvelope, generateVaultKey, hashToken, randomToken } from './shared/crypto.mjs';

const KDF = { memory: 65536, passes: 3, parallelism: 1 };
const PASSWORD = 'correct horse battery staple';
const text = (value) => new TextEncoder().encode(value);
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-accounts-test-'));
  const mails = [];
  let now = Date.parse('2026-10-22T08:00:00Z');
  const app = await createCloudServer({ dataDir, mailer: async (mail) => { mails.push(mail); }, serverKey: randomToken(), clock: () => now, ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  const api = async (path, body, headers = {}) => {
    const response = await fetch(`${url}/api/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const lastCode = (to, kind) => mails.filter((mail) => mail.to === to && mail.kind === kind).at(-1)?.code;
  return { ...app, dataDir, url, api, mails, lastCode, time: () => now, advance: (ms) => { now += ms; } };
}

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

/** What a real client does on the device: the password and unlock key never leave it. */
function derive(password, kdf) {
  const master = argon2Sync('argon2id', { message: password, nonce: Buffer.from(kdf.salt, 'base64url'), parallelism: kdf.parallelism, tagLength: 32, memory: kdf.memory, passes: kdf.passes });
  return { authKey: b64(hkdfSync('sha256', master, Buffer.alloc(0), 'jotdrop:auth:v1', 32)), unlockKey: b64(hkdfSync('sha256', master, Buffer.alloc(0), 'jotdrop:unlock:v1', 32)) };
}

async function credentials(password, vaultKey) {
  const kdf = { salt: b64(randomBytes(16)), ...KDF };
  const { authKey, unlockKey } = derive(password, kdf);
  return { kdf, authKey, wrappedVaultKey: JSON.stringify(await encryptEnvelope(unlockKey, { vaultKey }, 'jotdrop:wrap:v1')) };
}

async function signUp(app, email, password = PASSWORD) {
  const vaultKey = generateVaultKey(), deviceToken = randomToken(), recoveryToken = randomToken();
  const started = await app.api('/accounts', { email, ...await credentials(password, vaultKey), recoveryTokenHash: await hashToken(recoveryToken), deviceName: 'Phone', deviceTokenHash: await hashToken(deviceToken) });
  assert.equal(started.status, 202);
  const verified = await app.api('/accounts/verify', { signupId: started.body.signupId, code: app.lastCode(email.toLowerCase(), 'verify') });
  assert.equal(verified.status, 201);
  return Object.assign(new CloudClient({ url: app.url, vaultId: verified.body.vaultId, deviceId: verified.body.deviceId, token: deviceToken, vaultKey }), { recoveryToken });
}

/** Asks for a reset code and returns what a new device sends along with the new password. */
async function startReset(app, email, password, vaultKey) {
  const { resetId } = (await app.api('/auth/reset/start', { email })).body;
  const deviceToken = randomToken();
  return { resetId, code: app.lastCode(email, 'reset'), deviceToken, deviceName: 'New laptop', deviceTokenHash: await hashToken(deviceToken), ...await credentials(password, vaultKey) };
}

async function logIn(app, email, password = PASSWORD, deviceName = 'Laptop') {
  const { kdf } = (await app.api('/auth/prelogin', { email })).body;
  const { authKey, unlockKey } = derive(password, kdf);
  const deviceToken = randomToken();
  const started = await app.api('/auth/login', { email, authKey, deviceName, deviceTokenHash: await hashToken(deviceToken) });
  if (started.status !== 202) return started;
  assert.equal(started.body.secondFactor, 'email');
  const done = await app.api('/auth/login/verify', { challengeId: started.body.challengeId, code: app.lastCode(email.toLowerCase(), 'login') });
  if (done.status !== 201) return done;
  const { vaultKey } = await decryptEnvelope(unlockKey, JSON.parse(done.body.wrappedVaultKey), 'jotdrop:wrap:v1');
  return new CloudClient({ url: app.url, vaultId: done.body.vaultId, deviceId: done.body.deviceId, token: deviceToken, vaultKey });
}

const deviceHeaders = (client) => ({ Authorization: `Bearer ${client.credentials.token}`, 'X-JotDrop-Vault': client.credentials.vaultId, 'X-JotDrop-Device': client.credentials.deviceId });

test('sign up, confirm by email, log in on a new device and read the same encrypted notes', async (t) => {
  const app = await fixture(t);
  const phone = await signUp(app, 'Eric@Example.com');
  const saved = await phone.write('notes/secret.md', text('Account secret body'), 0);
  const laptop = await logIn(app, 'eric@example.com');
  assert.ok(laptop instanceof CloudClient);
  assert.equal(laptop.credentials.vaultId, phone.credentials.vaultId);
  assert.equal(laptop.credentials.vaultKey, phone.credentials.vaultKey);
  assert.equal((await laptop.read(saved.id)).file.path, 'notes/secret.md');
  assert.equal((await laptop.devices()).devices.length, 2);
  assert.deepEqual((await app.api('/account', undefined, deviceHeaders(laptop))).body, { email: 'eric@example.com', totp: false });
  const raw = await readFile(app.dbPath);
  for (const secret of [PASSWORD, phone.credentials.vaultKey, 'Account secret body']) assert.ok(!raw.includes(Buffer.from(secret)));
});

test('codes expire, allow five attempts and are single use', async (t) => {
  const app = await fixture(t);
  await signUp(app, 'a@example.com');
  const { kdf } = (await app.api('/auth/prelogin', { email: 'a@example.com' })).body;
  const { authKey } = derive(PASSWORD, kdf);
  const login = async () => (await app.api('/auth/login', { email: 'a@example.com', authKey, deviceName: 'X', deviceTokenHash: await hashToken(randomToken()) })).body.challengeId;
  let challengeId = await login();
  const code = app.lastCode('a@example.com', 'login'), wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await app.api('/auth/login/verify', { challengeId, code: wrong })).status, 401);
  assert.equal((await app.api('/auth/login/verify', { challengeId, code })).status, 401);
  challengeId = await login();
  app.advance(15 * 60 * 1000 + 1);
  assert.equal((await app.api('/auth/login/verify', { challengeId, code: app.lastCode('a@example.com', 'login') })).status, 401);
  challengeId = await login();
  assert.equal((await app.api('/auth/login/verify', { challengeId, code: app.lastCode('a@example.com', 'login') })).status, 201);
  assert.equal((await app.api('/auth/login/verify', { challengeId, code: app.lastCode('a@example.com', 'login') })).status, 401);
});

test('responses never reveal whether an email address has an account', async (t) => {
  const app = await fixture(t);
  const owner = await signUp(app, 'owner@example.com');
  const known = await app.api('/auth/prelogin', { email: 'owner@example.com' });
  const unknown = await app.api('/auth/prelogin', { email: 'nobody@example.com' });
  assert.deepEqual(Object.keys(unknown.body.kdf).sort(), Object.keys(known.body.kdf).sort());
  assert.deepEqual((await app.api('/auth/prelogin', { email: 'nobody@example.com' })).body, unknown.body);
  const wrongPassword = await logIn(app, 'owner@example.com', 'not the right password');
  const noAccount = await logIn(app, 'nobody@example.com');
  assert.deepEqual([wrongPassword.status, wrongPassword.body], [401, { error: 'Invalid email or password' }]);
  assert.deepEqual([noAccount.status, noAccount.body], [wrongPassword.status, wrongPassword.body]);
  // Signing up again with a taken address looks the same, warns the owner and changes nothing.
  const again = await app.api('/accounts', { email: 'owner@example.com', ...await credentials('attacker password', generateVaultKey()), recoveryTokenHash: await hashToken(randomToken()), deviceName: 'Attacker', deviceTokenHash: await hashToken(randomToken()) });
  assert.equal(again.status, 202);
  assert.equal(app.mails.at(-1).kind, 'signup-exists');
  assert.equal(app.mails.at(-1).code, undefined);
  assert.equal((await logIn(app, 'owner@example.com', 'attacker password')).status, 401);
  assert.ok((await logIn(app, 'owner@example.com')) instanceof CloudClient);
  assert.equal((await owner.devices()).devices.length, 2);
});

test('ten wrong passwords lock the account for fifteen minutes', async (t) => {
  const app = await fixture(t);
  await signUp(app, 'lock@example.com');
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await logIn(app, 'lock@example.com', `wrong password ${attempt}`)).status, 401);
    app.advance(61 * 1000);
  }
  assert.equal((await logIn(app, 'lock@example.com')).status, 429);
  app.advance(15 * 60 * 1000);
  assert.ok((await logIn(app, 'lock@example.com')) instanceof CloudClient);
});

test('changing the password keeps the vault key and can sign out other devices', async (t) => {
  const app = await fixture(t);
  const phone = await signUp(app, 'change@example.com');
  const laptop = await logIn(app, 'change@example.com');
  const { kdf } = (await app.api('/auth/prelogin', { email: 'change@example.com' })).body;
  const next = await credentials('a brand new passphrase', phone.credentials.vaultKey);
  assert.equal((await app.api('/account/password', { currentAuthKey: derive('wrong old password', kdf).authKey, ...next, signOutOtherDevices: true }, deviceHeaders(phone))).status, 401);
  assert.equal((await app.api('/account/password', { currentAuthKey: derive(PASSWORD, kdf).authKey, ...next, signOutOtherDevices: true }, deviceHeaders(phone))).status, 200);
  await assert.rejects(laptop.status(), (error) => error.status === 401);
  assert.equal((await logIn(app, 'change@example.com')).status, 401);
  const tablet = await logIn(app, 'change@example.com', 'a brand new passphrase', 'Tablet');
  assert.equal(tablet.credentials.vaultKey, phone.credentials.vaultKey);
});

test('an existing paired vault gets an account without uploading again', async (t) => {
  const enrollmentToken = randomToken();
  const app = await fixture(t, { enrollmentToken });
  const { client: phone } = await CloudClient.create({ url: app.url, enrollmentToken, deviceName: 'Phone' });
  const saved = await phone.write('notes/old.md', text('Existing note'), 0);
  assert.equal((await app.api('/account', undefined, deviceHeaders(phone))).status, 404);
  const attach = await app.api('/account', { email: 'old@example.com', ...await credentials(PASSWORD, phone.credentials.vaultKey) }, deviceHeaders(phone));
  assert.equal(attach.status, 202);
  const verified = await app.api('/accounts/verify', { signupId: attach.body.signupId, code: app.lastCode('old@example.com', 'verify') });
  assert.deepEqual(verified, { status: 201, body: { vaultId: phone.credentials.vaultId } });
  assert.equal((await app.api('/account', { email: 'second@example.com', ...await credentials(PASSWORD, phone.credentials.vaultKey) }, deviceHeaders(phone))).status, 409);
  const laptop = await logIn(app, 'old@example.com');
  assert.equal((await laptop.read(saved.id)).file.path, 'notes/old.md');
});

test('open registration validates input, and enrollment is off without a configured token', async (t) => {
  const app = await fixture(t);
  const valid = { email: 'v@example.com', ...await credentials(PASSWORD, generateVaultKey()), recoveryTokenHash: await hashToken(randomToken()), deviceName: 'Phone', deviceTokenHash: await hashToken(randomToken()) };
  for (const invalid of [{ email: 'not an email' }, { kdf: { ...valid.kdf, memory: 1024 } }, { kdf: { ...valid.kdf, salt: 'short' } }, { authKey: 'short' }, { wrappedVaultKey: '{}' }]) {
    assert.equal((await app.api('/accounts', { ...valid, ...invalid })).status, 400);
  }
  assert.equal(app.mails.length, 0);
  const enroll = await fetch(`${app.url}/api/v1/vaults`, { method: 'POST', headers: { Authorization: 'Bearer undefined', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(enroll.status, 401);
});

test('account routes fail closed when no mailer is configured', async (t) => {
  const app = await fixture(t, { mailer: undefined });
  const result = await app.api('/accounts', { email: 'm@example.com', ...await credentials(PASSWORD, generateVaultKey()), recoveryTokenHash: await hashToken(randomToken()), deviceName: 'Phone', deviceTokenHash: await hashToken(randomToken()) });
  assert.equal(result.status, 503);
});

test('an authenticator app replaces the email code at login and cannot be replayed', async (t) => {
  const app = await fixture(t);
  const phone = await signUp(app, 'totp@example.com');
  const { kdf } = (await app.api('/auth/prelogin', { email: 'totp@example.com' })).body;
  const currentAuthKey = derive(PASSWORD, kdf).authKey;
  const setup = await app.api('/account/totp', {}, deviceHeaders(phone));
  assert.equal(setup.status, 200);
  assert.match(setup.body.uri, /^otpauth:\/\/totp\/JotDrop%3Atotp%40example\.com\?secret=[A-Z2-7]+&issuer=JotDrop$/);
  const wrong = String((Number(totp(setup.body.secret, app.time())) + 1) % 1000000).padStart(6, '0');
  assert.equal((await app.api('/account/totp/enable', { code: wrong, currentAuthKey }, deviceHeaders(phone))).status, 401);
  // A stolen device token alone cannot swap in an attacker's authenticator.
  assert.equal((await app.api('/account/totp/enable', { code: totp(setup.body.secret, app.time()), currentAuthKey: derive('wrong old password', kdf).authKey }, deviceHeaders(phone))).status, 401);
  assert.equal((await app.api('/account/totp/enable', { code: totp(setup.body.secret, app.time()), currentAuthKey }, deviceHeaders(phone))).status, 200);
  assert.equal((await app.api('/account', undefined, deviceHeaders(phone))).body.totp, true);
  const raw = await readFile(app.dbPath);
  assert.ok(!raw.includes(Buffer.from(setup.body.secret)));
  const start = async () => (await app.api('/auth/login', { email: 'totp@example.com', authKey: derive(PASSWORD, kdf).authKey, deviceName: 'Laptop', deviceTokenHash: await hashToken(randomToken()) })).body;
  const mailsBefore = app.mails.length;
  app.advance(30000);
  let login = await start();
  assert.equal(login.secondFactor, 'totp');
  assert.equal(app.mails.length, mailsBefore);
  const code = totp(setup.body.secret, app.time());
  assert.equal((await app.api('/auth/login/verify', { challengeId: login.challengeId, code })).status, 201);
  login = await start();
  assert.equal((await app.api('/auth/login/verify', { challengeId: login.challengeId, code })).status, 401);
  app.advance(30000);
  assert.equal((await app.api('/auth/login/verify', { challengeId: login.challengeId, code: totp(setup.body.secret, app.time()) })).status, 201);
  assert.equal((await app.api('/account/totp/disable', { currentAuthKey: derive('wrong old password', kdf).authKey }, deviceHeaders(phone))).status, 401);
  assert.equal((await app.api('/account/totp/disable', { currentAuthKey: derive(PASSWORD, kdf).authKey }, deviceHeaders(phone))).status, 200);
  assert.ok((await logIn(app, 'totp@example.com')) instanceof CloudClient);
});

test('forgot password with the recovery code keeps the notes and the vault key', async (t) => {
  const app = await fixture(t);
  const phone = await signUp(app, 'rc@example.com');
  const saved = await phone.write('notes/kept.md', text('Kept'), 0);
  const reset = await startReset(app, 'rc@example.com', 'my new long password', phone.credentials.vaultKey);
  assert.equal((await app.api('/auth/reset/recover', { ...reset, recoveryToken: randomToken() })).status, 401);
  const done = await app.api('/auth/reset/recover', { ...reset, recoveryToken: phone.recoveryToken });
  assert.equal(done.status, 201);
  const laptop = new CloudClient({ url: app.url, vaultId: done.body.vaultId, deviceId: done.body.deviceId, token: reset.deviceToken, vaultKey: phone.credentials.vaultKey });
  assert.equal((await laptop.read(saved.id)).file.path, 'notes/kept.md');
  assert.equal((await app.api('/auth/reset/recover', { ...reset, recoveryToken: phone.recoveryToken })).status, 401);
  assert.equal((await logIn(app, 'rc@example.com')).status, 401);
  assert.ok((await logIn(app, 'rc@example.com', 'my new long password')) instanceof CloudClient);
  assert.ok((await phone.status()).quotaBytes > 0);
});

test('forgot password approved on the phone hands the sealed vault key to the new device', async (t) => {
  const app = await fixture(t);
  const phone = await signUp(app, 'ok@example.com');
  const reset = await startReset(app, 'ok@example.com', 'approved new password', phone.credentials.vaultKey);
  const claimToken = randomToken(), publicKey = b64(randomBytes(65));
  const request = await app.api('/auth/reset/approval', { resetId: reset.resetId, code: reset.code, publicKey, claimTokenHash: await hashToken(claimToken) });
  assert.equal(request.status, 201);
  const { approvalId } = request.body;
  assert.deepEqual((await app.api(`/auth/reset/approval/${approvalId}`, { claimToken })).body, { envelope: null });
  assert.equal((await app.api(`/auth/reset/approval/${approvalId}/complete`, { ...reset, claimToken })).status, 409);
  assert.equal((await app.api(`/auth/reset/approval/${approvalId}`, { claimToken: randomToken() })).status, 401);
  const pending = (await app.api('/account/approvals', undefined, deviceHeaders(phone))).body.approvals;
  assert.deepEqual(pending.map((entry) => [entry.id, entry.publicKey]), [[approvalId, publicKey]]);
  const envelope = JSON.stringify({ v: 1, publicKey: b64(randomBytes(65)), iv: b64(randomBytes(12)), ciphertext: b64(randomBytes(64)) });
  assert.equal((await app.api(`/account/approvals/${approvalId}`, { envelope }, deviceHeaders(phone))).status, 200);
  assert.equal((await app.api(`/account/approvals/${approvalId}`, { envelope }, deviceHeaders(phone))).status, 404);
  assert.deepEqual((await app.api(`/auth/reset/approval/${approvalId}`, { claimToken })).body, { envelope });
  const done = await app.api(`/auth/reset/approval/${approvalId}/complete`, { ...reset, claimToken });
  assert.equal(done.status, 201);
  assert.equal(done.body.vaultId, phone.credentials.vaultId);
  assert.equal((await app.api(`/auth/reset/approval/${approvalId}/complete`, { ...reset, claimToken })).status, 401);
  assert.ok((await logIn(app, 'ok@example.com', 'approved new password')) instanceof CloudClient);
});

test('an approval request expires after ten minutes and another account cannot approve it', async (t) => {
  const app = await fixture(t);
  await signUp(app, 'one@example.com');
  const other = await signUp(app, 'two@example.com');
  const reset = await startReset(app, 'one@example.com', 'whatever new password', generateVaultKey());
  const claimToken = randomToken();
  const { approvalId } = (await app.api('/auth/reset/approval', { resetId: reset.resetId, code: reset.code, publicKey: b64(randomBytes(65)), claimTokenHash: await hashToken(claimToken) })).body;
  assert.deepEqual((await app.api('/account/approvals', undefined, deviceHeaders(other))).body, { approvals: [] });
  assert.equal((await app.api(`/account/approvals/${approvalId}`, { envelope: '{}' }, deviceHeaders(other))).status, 404);
  app.advance(10 * 60 * 1000 + 1);
  assert.equal((await app.api(`/auth/reset/approval/${approvalId}`, { claimToken })).status, 401);
});

test('starting over deletes the unreadable old cloud and signs out every old device', async (t) => {
  const app = await fixture(t);
  const phone = await signUp(app, 'over@example.com');
  await phone.write('notes/lost.md', text('Encrypted with a lost key'), 0);
  const vaultKey = generateVaultKey(), reset = await startReset(app, 'over@example.com', 'fresh start password', vaultKey);
  const restart = { ...reset, recoveryTokenHash: await hashToken(randomToken()) };
  assert.equal((await app.api('/auth/reset/restart', restart)).status, 400);
  const done = await app.api('/auth/reset/restart', { ...restart, confirm: 'DELETE CLOUD DATA' });
  assert.equal(done.status, 201);
  assert.notEqual(done.body.vaultId, phone.credentials.vaultId);
  await assert.rejects(phone.status(), (error) => error.status === 401);
  const laptop = new CloudClient({ url: app.url, vaultId: done.body.vaultId, deviceId: done.body.deviceId, token: reset.deviceToken, vaultKey });
  assert.deepEqual((await laptop.listChanges()).changes, []);
  const relogged = await logIn(app, 'over@example.com', 'fresh start password');
  assert.equal(relogged.credentials.vaultKey, vaultKey);
  const db = new DatabaseSync(app.dbPath, { readOnly: true });
  try {
    for (const table of ['devices', 'envelopes', 'revisions', 'changes', 'vaults']) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${table === 'vaults' ? 'id' : 'vaultId'}=?`).get(phone.credentials.vaultId).count, 0);
  } finally { db.close(); }
});

test('a reset for an unknown address looks the same and sends nothing', async (t) => {
  const app = await fixture(t);
  const started = await app.api('/auth/reset/start', { email: 'ghost@example.com' });
  assert.equal(started.status, 202);
  assert.match(started.body.resetId, /^[0-9a-f-]{36}$/);
  assert.equal(app.mails.length, 0);
  const reset = { ...await startReset(app, 'ghost@example.com', 'some new password', generateVaultKey()), code: '123456' };
  assert.equal((await app.api('/auth/reset/recover', { ...reset, recoveryToken: randomToken() })).status, 401);
});

test('ten wrong reset codes lock resets for a day, even spread over many reset requests', async (t) => {
  const app = await fixture(t);
  const phone = await signUp(app, 'brute@example.com');
  const wrongFor = (code) => String((Number(code) + 1) % 1000000).padStart(6, '0');
  const guess = async (reset, times) => { for (let i = 0; i < times; i++) assert.equal((await app.api('/auth/reset/recover', { ...reset, code: wrongFor(reset.code), recoveryToken: phone.recoveryToken })).status, 401); };
  const first = await startReset(app, 'brute@example.com', 'new password one', phone.credentials.vaultKey);
  await guess(first, 4);
  app.advance(61 * 1000);
  const second = await startReset(app, 'brute@example.com', 'new password one', phone.credentials.vaultKey);
  // A new reset replaces the old one.
  assert.equal((await app.api('/auth/reset/recover', { ...first, recoveryToken: phone.recoveryToken })).status, 401);
  await guess(second, 4);
  app.advance(61 * 1000);
  const third = await startReset(app, 'brute@example.com', 'new password one', phone.credentials.vaultKey);
  await guess(third, 2);
  assert.equal((await app.api('/auth/reset/recover', { ...third, recoveryToken: phone.recoveryToken })).status, 401);
  app.advance(61 * 1000);
  const before = app.mails.length;
  assert.equal((await app.api('/auth/reset/start', { email: 'brute@example.com' })).status, 202);
  assert.equal(app.mails.length, before);
  app.advance(24 * 60 * 60 * 1000);
  const later = await startReset(app, 'brute@example.com', 'new password one', phone.credentials.vaultKey);
  assert.equal((await app.api('/auth/reset/recover', { ...later, recoveryToken: phone.recoveryToken })).status, 201);
});

test('a reset request does not wait for or reveal a failing mail delivery', async (t) => {
  const app = await fixture(t, { mailer: async (mail) => { if (mail.kind === 'reset') throw new Error('provider down'); app.mails.push(mail); } });
  await signUp(app, 'slow@example.com');
  const errors = [], original = console.error;
  console.error = (message) => errors.push(message);
  try {
    assert.equal((await app.api('/auth/reset/start', { email: 'slow@example.com' })).status, 202);
    assert.equal((await app.api('/auth/reset/start', { email: 'none@example.com' })).status, 202);
    await new Promise((done) => setTimeout(done, 20));
  } finally { console.error = original; }
  assert.deepEqual(errors, ['Mail delivery failed: provider down']);
});

test('a second signup for the same address cannot take over the first one', async (t) => {
  const app = await fixture(t);
  const signup = async (password) => (await app.api('/accounts', { email: 'race@example.com', ...await credentials(password, generateVaultKey()), recoveryTokenHash: await hashToken(randomToken()), deviceName: 'Phone', deviceTokenHash: await hashToken(randomToken()) })).body;
  const victim = await signup(PASSWORD);
  const victimCode = app.lastCode('race@example.com', 'verify');
  const attacker = await signup('attacker password');
  const attackerCode = app.lastCode('race@example.com', 'verify');
  assert.equal((await app.api('/accounts/verify', { signupId: victim.signupId, code: attackerCode })).status, 401);
  assert.equal((await app.api('/accounts/verify', { signupId: victim.signupId, code: victimCode })).status, 201);
  assert.equal((await app.api('/accounts/verify', { signupId: attacker.signupId, code: attackerCode })).status, 401);
  assert.ok((await logIn(app, 'race@example.com')) instanceof CloudClient);
  assert.equal((await logIn(app, 'race@example.com', 'attacker password')).status, 401);
});

test('codes in a copied database are keyed hashes that need the server key', async (t) => {
  const app = await fixture(t);
  await signUp(app, 'copy@example.com');
  const { resetId } = (await app.api('/auth/reset/start', { email: 'copy@example.com' })).body;
  const code = app.lastCode('copy@example.com', 'reset');
  const db = new DatabaseSync(app.dbPath, { readOnly: true });
  try {
    const stored = db.prepare('SELECT codeHash FROM resets WHERE id=?').get(resetId).codeHash;
    assert.match(stored, /^[0-9a-f]{64}$/);
    for (const guess of [`jotdrop:code:v1:reset:${resetId}:${code}`, `reset:${resetId}:${code}`, code]) assert.notEqual(createHash('sha256').update(guess).digest('hex'), stored);
  } finally { db.close(); }
});

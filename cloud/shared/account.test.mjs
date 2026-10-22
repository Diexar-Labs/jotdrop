import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { argon2Sync, createHash, createHmac, hkdfSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudServer } from '../server.mjs';
import { CloudClient } from './client.mjs';
import { randomToken } from './crypto.mjs';
import { WORDS } from './words.mjs';
import { accountInfo, approveDevice, attachAccount, changePassword, checkApproval, completeApproval, confirmLogin, confirmSignup, deriveKeys, disableTotp, enableTotp, listApprovals, logIn, rejectDevice, requestApproval, resetWithRecoveryCode, setupTotp, signUp, startOver, startReset, verificationWords } from './account.mjs';

const PASSWORD = 'correct horse battery staple';
const text = (value) => new TextEncoder().encode(value);

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-account-client-'));
  const mails = [];
  const app = await createCloudServer({ dataDir, mailer: async (mail) => { mails.push(mail); }, serverKey: randomToken(), ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  return { ...app, url, mails, code: (to, kind) => mails.filter((mail) => mail.to === to && mail.kind === kind).at(-1)?.code };
}

async function register(app, email, password = PASSWORD) {
  const pending = await signUp({ url: app.url, email, password, deviceName: 'Phone' });
  return confirmSignup(pending, app.code(email, 'verify'));
}

async function login(app, email, password = PASSWORD, deviceName = 'Laptop') {
  const pending = await logIn({ url: app.url, email, password, deviceName });
  assert.equal(pending.secondFactor, 'email');
  return confirmLogin(pending, app.code(email, 'login'));
}

function totp(secret, time = Date.now()) {
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

test('the word list is the unmodified BIP39 English list', () => {
  assert.equal(WORDS.length, 2048);
  assert.equal(new Set(WORDS).size, 2048);
  assert.equal(createHash('sha256').update(`${WORDS.join('\n')}\n`).digest('hex'), '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda');
});

test('browser key derivation matches Node Argon2id and HKDF, with Unicode normalized', async () => {
  const kdf = { salt: 'AAECAwQFBgcICQoLDA0ODw', memory: 65536, passes: 3, parallelism: 1 };
  const master = argon2Sync('argon2id', { message: 'Wachtwoord met é', nonce: Buffer.from(kdf.salt, 'base64url'), parallelism: 1, tagLength: 32, memory: 65536, passes: 3 });
  const expected = { authKey: Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'jotdrop:auth:v1', 32)).toString('base64url'), unlockKey: Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'jotdrop:unlock:v1', 32)).toString('base64url') };
  assert.deepEqual(await deriveKeys('Wachtwoord met é', kdf), expected);
  assert.deepEqual(await deriveKeys('Wachtwoord met é', kdf), expected);
});

test('a malicious server cannot weaken or blow up the key derivation', async () => {
  const salt = 'AAECAwQFBgcICQoLDA0ODw';
  for (const kdf of [{ salt, memory: 1024, passes: 3, parallelism: 1 }, { salt, memory: 65536, passes: 1, parallelism: 1 }, { salt, memory: 4194304, passes: 3, parallelism: 1 }, { salt: 'short', memory: 65536, passes: 3, parallelism: 1 }]) {
    await assert.rejects(deriveKeys(PASSWORD, kdf), /key derivation settings/);
  }
});

test('sign up, log in elsewhere, change the password and read the same notes', async (t) => {
  const app = await fixture(t);
  await assert.rejects(signUp({ url: app.url, email: 'short@example.com', password: 'too short', deviceName: 'Phone' }), /12 to 1024/);
  const { client: phone, recoveryCode } = await register(app, 'eric@example.com');
  assert.ok(recoveryCode.length > 40);
  const saved = await phone.write('notes/a.md', text('Body'), 0);
  const laptop = await login(app, 'eric@example.com');
  assert.equal((await laptop.read(saved.id)).file.path, 'notes/a.md');
  assert.deepEqual(await accountInfo(laptop), { email: 'eric@example.com', totp: false });
  await assert.rejects(changePassword(phone, { currentPassword: 'not my password!', newPassword: 'a whole new password' }), (error) => error.status === 401);
  await changePassword(phone, { currentPassword: PASSWORD, newPassword: 'a whole new password', signOutOtherDevices: true });
  await assert.rejects(laptop.status(), (error) => error.status === 401);
  await assert.rejects(logIn({ url: app.url, email: 'eric@example.com', password: PASSWORD, deviceName: 'X' }), (error) => error.status === 401);
  const tablet = await login(app, 'eric@example.com', 'a whole new password', 'Tablet');
  assert.equal((await tablet.read(saved.id)).file.path, 'notes/a.md');
});

test('an existing paired vault gets an account', async (t) => {
  const enrollmentToken = randomToken();
  const app = await fixture(t, { enrollmentToken });
  const { client: phone } = await CloudClient.create({ url: app.url, enrollmentToken, deviceName: 'Phone' });
  const saved = await phone.write('notes/old.md', text('Old'), 0);
  const pending = await attachAccount(phone, { email: 'old@example.com', password: PASSWORD });
  assert.deepEqual(await confirmSignup(pending, app.code('old@example.com', 'verify')), { vaultId: phone.credentials.vaultId });
  assert.equal((await (await login(app, 'old@example.com')).read(saved.id)).file.path, 'notes/old.md');
});

test('authenticator app login', async (t) => {
  const app = await fixture(t);
  const { client: phone } = await register(app, 'totp@example.com');
  const { secret } = await setupTotp(phone);
  await enableTotp(phone, { password: PASSWORD, code: totp(secret) });
  const pending = await logIn({ url: app.url, email: 'totp@example.com', password: PASSWORD, deviceName: 'Laptop' });
  assert.equal(pending.secondFactor, 'totp');
  // The enable step used the current time step; the next step's code is still within the drift window.
  assert.ok(await confirmLogin(pending, totp(secret, Date.now() + 30000)) instanceof CloudClient);
  await disableTotp(phone, { password: PASSWORD });
  assert.equal((await accountInfo(phone)).totp, false);
});

test('forgot password with the recovery code', async (t) => {
  const app = await fixture(t);
  const { client: phone, recoveryCode } = await register(app, 'rc@example.com');
  const saved = await phone.write('notes/kept.md', text('Kept'), 0);
  const reset = await startReset({ url: app.url, email: 'rc@example.com' });
  const laptop = await resetWithRecoveryCode(reset, { code: app.code('rc@example.com', 'reset'), recoveryCode, newPassword: 'recovered password', deviceName: 'Laptop' });
  assert.equal((await laptop.read(saved.id)).file.path, 'notes/kept.md');
  assert.ok(await login(app, 'rc@example.com', 'recovered password') instanceof CloudClient);
});

test('forgot password approved on the phone after comparing the same four words', async (t) => {
  const app = await fixture(t);
  const { client: phone } = await register(app, 'ok@example.com');
  const saved = await phone.write('notes/approved.md', text('Approved'), 0);
  const reset = await startReset({ url: app.url, email: 'ok@example.com' });
  const pending = await requestApproval(reset, app.code('ok@example.com', 'reset'));
  assert.equal(pending.words.length, 4);
  assert.ok(pending.words.every((word) => WORDS.includes(word)));
  assert.equal(await checkApproval(pending), null);
  await assert.rejects(completeApproval(pending, { newPassword: 'approved password', deviceName: 'Laptop' }), /approves/);
  const [request] = await listApprovals(phone);
  assert.deepEqual(request.words, pending.words);
  await approveDevice(phone, request);
  const approved = await checkApproval(pending);
  assert.equal(approved.vaultKey, phone.credentials.vaultKey);
  const laptop = await completeApproval(approved, { newPassword: 'approved password', deviceName: 'Laptop' });
  assert.equal((await laptop.read(saved.id)).file.path, 'notes/approved.md');
  assert.ok(await login(app, 'ok@example.com', 'approved password') instanceof CloudClient);
});

test('a rejected approval never reaches the new device, and words differ per key', async (t) => {
  const app = await fixture(t);
  const { client: phone } = await register(app, 'no@example.com');
  const pending = await requestApproval(await startReset({ url: app.url, email: 'no@example.com' }), app.code('no@example.com', 'reset'));
  const [request] = await listApprovals(phone);
  await rejectDevice(phone, request.id);
  assert.deepEqual(await listApprovals(phone), []);
  await assert.rejects(checkApproval(pending), (error) => error.status === 401);
  assert.notDeepEqual(await verificationWords('A'.repeat(87)), await verificationWords('B'.repeat(87)));
});

test('starting over gives an empty cloud and a new recovery code', async (t) => {
  const app = await fixture(t);
  const { client: phone, recoveryCode } = await register(app, 'over@example.com');
  await phone.write('notes/gone.md', text('Gone'), 0);
  const reset = await startReset({ url: app.url, email: 'over@example.com' });
  const result = await startOver(reset, { code: app.code('over@example.com', 'reset'), newPassword: 'fresh start password', deviceName: 'Laptop' });
  assert.notEqual(result.recoveryCode, recoveryCode);
  assert.deepEqual((await result.client.listChanges()).changes, []);
  await assert.rejects(phone.status(), (error) => error.status === 401);
});

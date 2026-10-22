import { argon2id } from 'hash-wasm';
import { CloudClient, request } from './client.mjs';
import { base64ToBytes, bytesToBase64, decodeRecovery, decryptEnvelope, encodeRecovery, encryptEnvelope, generateVaultKey, hashToken, randomToken } from './crypto.mjs';
import { WORDS } from './words.mjs';

// Email and password accounts, see docs/cloud-accounts-design.md. The password and the unlock key never leave this device.
const encoder = new TextEncoder();
export const DEFAULT_KDF = Object.freeze({ memory: 65536, passes: 3, parallelism: 1 });
const WRAP_AAD = 'jotdrop:wrap:v1';
const post = (url, path, body, fetcher) => request(url, path, { method: 'POST', body, fetcher });

function password(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 1024) throw new Error('Use a password of 12 to 1024 characters.');
  return value;
}

// Settings come from the server at login, so a malicious server must not be able to make them weak or huge.
function kdfSettings(kdf) {
  const range = (number, low, high) => Number.isSafeInteger(number) && number >= low && number <= high;
  let salt;
  try { salt = base64ToBytes(kdf.salt); } catch { salt = undefined; }
  if (!kdf || salt?.length !== 16 || !range(kdf.memory, 65536, 1048576) || !range(kdf.passes, 3, 10) || !range(kdf.parallelism, 1, 4)) throw new Error('The server sent invalid key derivation settings.');
  return { ...kdf, salt };
}

async function hkdf(secret, info) {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return bytesToBase64(new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(info) }, key, 256)));
}

/** Argon2id, then HKDF into a login key (sent to the server) and an unlock key (stays here). */
export async function deriveKeys(value, kdf) {
  if (typeof value !== 'string' || value.length > 1024) throw new Error('Use a password of at most 1024 characters.');
  const settings = kdfSettings(kdf);
  const master = await argon2id({ password: value.normalize('NFC'), salt: settings.salt, parallelism: settings.parallelism, iterations: settings.passes, memorySize: settings.memory, hashLength: 32, outputType: 'binary' });
  return { authKey: await hkdf(master, 'jotdrop:auth:v1'), unlockKey: await hkdf(master, 'jotdrop:unlock:v1') };
}

async function newCredentials(value, vaultKey) {
  const kdf = { salt: bytesToBase64(crypto.getRandomValues(new Uint8Array(16))), ...DEFAULT_KDF };
  const { authKey, unlockKey } = await deriveKeys(password(value), kdf);
  return { kdf, authKey, wrappedVaultKey: JSON.stringify(await encryptEnvelope(unlockKey, { vaultKey }, WRAP_AAD)) };
}

async function newDevice(deviceName) {
  const deviceToken = randomToken();
  return { deviceToken, fields: { deviceName, deviceTokenHash: await hashToken(deviceToken) } };
}

const connect = (url, result, deviceToken, vaultKey, fetcher) => new CloudClient({ url, vaultId: result.vaultId, deviceId: result.deviceId, token: deviceToken, vaultKey, fetcher });

/** Starts a new account and cloud; the server mails a code to confirm the address. */
export async function signUp({ url, email, password: value, deviceName, fetcher }) {
  const vaultKey = generateVaultKey(), recoveryToken = randomToken(), device = await newDevice(deviceName);
  const { signupId } = await post(url, '/accounts', { email, ...await newCredentials(value, vaultKey), recoveryTokenHash: await hashToken(recoveryToken), ...device.fields }, fetcher);
  return { url, signupId, vaultKey, recoveryToken, deviceToken: device.deviceToken };
}

/** Gives the cloud this device is already connected to an account. Confirm with confirmSignup. */
export async function attachAccount(client, { email, password: value }) {
  const { signupId } = await client.call('/account', 'POST', { email, ...await newCredentials(value, client.credentials.vaultKey) });
  return { url: client.credentials.url, signupId, vaultId: client.credentials.vaultId };
}

export async function confirmSignup(pending, code, { fetcher } = {}) {
  const result = await post(pending.url, '/accounts/verify', { signupId: pending.signupId, code }, fetcher);
  if (!pending.deviceToken) {
    if (result.vaultId !== pending.vaultId) throw new Error('The server linked the account to another cloud.');
    return { vaultId: result.vaultId };
  }
  return { client: connect(pending.url, result, pending.deviceToken, pending.vaultKey, fetcher), recoveryCode: encodeRecovery({ vaultId: result.vaultId, vaultKey: pending.vaultKey, recoveryToken: pending.recoveryToken }) };
}

/** First step of logging in; then confirmLogin with the code from the email or the authenticator app. */
export async function logIn({ url, email, password: value, deviceName, fetcher }) {
  const { kdf } = await post(url, '/auth/prelogin', { email }, fetcher);
  const { authKey, unlockKey } = await deriveKeys(value, kdf), device = await newDevice(deviceName);
  const started = await post(url, '/auth/login', { email, authKey, ...device.fields }, fetcher);
  return { url, challengeId: started.challengeId, secondFactor: started.secondFactor, unlockKey, deviceToken: device.deviceToken };
}

export async function confirmLogin(pending, code, { fetcher } = {}) {
  const result = await post(pending.url, '/auth/login/verify', { challengeId: pending.challengeId, code }, fetcher);
  const { vaultKey } = await decryptEnvelope(pending.unlockKey, JSON.parse(result.wrappedVaultKey), WRAP_AAD);
  return connect(pending.url, result, pending.deviceToken, vaultKey, fetcher);
}

export const accountInfo = (client) => client.call('/account');

async function currentAuthKey(client, value) {
  const { email } = await accountInfo(client);
  const { kdf } = await post(client.credentials.url, '/auth/prelogin', { email }, client.fetcher);
  return (await deriveKeys(value, kdf)).authKey;
}

/** The vault key stays the same, so nothing has to be encrypted again. */
export async function changePassword(client, { currentPassword, newPassword, signOutOtherDevices = false }) {
  return client.call('/account/password', 'POST', { currentAuthKey: await currentAuthKey(client, currentPassword), ...await newCredentials(newPassword, client.credentials.vaultKey), signOutOtherDevices });
}

export const setupTotp = (client) => client.call('/account/totp', 'POST', {});
export async function enableTotp(client, { password: value, code }) { return client.call('/account/totp/enable', 'POST', { code, currentAuthKey: await currentAuthKey(client, value) }); }
export async function disableTotp(client, { password: value }) { return client.call('/account/totp/disable', 'POST', { currentAuthKey: await currentAuthKey(client, value) }); }

/** Forgot password: the server mails a code that one of the three routes below needs. */
export async function startReset({ url, email, fetcher }) {
  return { url, resetId: (await post(url, '/auth/reset/start', { email }, fetcher)).resetId };
}

export async function resetWithRecoveryCode(reset, { code, recoveryCode, newPassword, deviceName }, { fetcher } = {}) {
  const recovery = decodeRecovery(recoveryCode), device = await newDevice(deviceName);
  const result = await post(reset.url, '/auth/reset/recover', { resetId: reset.resetId, code, recoveryToken: recovery.recoveryToken, ...await newCredentials(newPassword, recovery.vaultKey), ...device.fields }, fetcher);
  if (result.vaultId !== recovery.vaultId) throw new Error('The recovery code belongs to another cloud.');
  return connect(reset.url, result, device.deviceToken, recovery.vaultKey, fetcher);
}

/** Four words from the public key; both screens must show the same words, so the server cannot swap in its own key. */
export async function verificationWords(publicKey) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`jotdrop:approval-words:v1:${publicKey}`)));
  const bits = digest.subarray(0, 6).reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
  // 4 x 11 bits: too many combinations to search for a matching key within the 10-minute approval window.
  return [37n, 26n, 15n, 4n].map((shift) => WORDS[Number((bits >> shift) & 2047n)]);
}

const ecdh = { name: 'ECDH', namedCurve: 'P-256' };
const approvalAad = (approvalId) => `jotdrop:approval:v1:${approvalId}`;
const exportPublic = async (keys) => bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));

async function approvalKey(privateKey, publicKey, approvalId) {
  const peer = await crypto.subtle.importKey('raw', base64ToBytes(publicKey), ecdh, false, []);
  return hkdf(new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256)), approvalAad(approvalId));
}

/** New device: asks a connected device for the vault key. Show `words` and keep polling checkApproval. */
export async function requestApproval(reset, code, { fetcher } = {}) {
  const keys = await crypto.subtle.generateKey(ecdh, false, ['deriveBits']), publicKey = await exportPublic(keys), claimToken = randomToken();
  const { approvalId, expiresAt } = await post(reset.url, '/auth/reset/approval', { resetId: reset.resetId, code, publicKey, claimTokenHash: await hashToken(claimToken) }, fetcher);
  return { url: reset.url, approvalId, expiresAt, claimToken, privateKey: keys.privateKey, words: await verificationWords(publicKey) };
}

/** Returns null while waiting, or the pending request with the vault key once approved. */
export async function checkApproval(pending, { fetcher } = {}) {
  const { envelope } = await post(pending.url, `/auth/reset/approval/${pending.approvalId}`, { claimToken: pending.claimToken }, fetcher);
  if (!envelope) return null;
  const sealed = JSON.parse(envelope);
  const { vaultId, vaultKey } = await decryptEnvelope(await approvalKey(pending.privateKey, sealed.publicKey, pending.approvalId), sealed, approvalAad(pending.approvalId));
  return { ...pending, vaultId, vaultKey };
}

export async function completeApproval(approved, { newPassword, deviceName }, { fetcher } = {}) {
  if (!approved?.vaultKey) throw new Error('Wait until your other device approves this request.');
  const device = await newDevice(deviceName);
  const result = await post(approved.url, `/auth/reset/approval/${approved.approvalId}/complete`, { claimToken: approved.claimToken, ...await newCredentials(newPassword, approved.vaultKey), ...device.fields }, fetcher);
  if (result.vaultId !== approved.vaultId) throw new Error('The server linked the account to another cloud.');
  return connect(approved.url, result, device.deviceToken, approved.vaultKey, fetcher);
}

/** Connected device: requests waiting for approval, each with the words to compare. */
export async function listApprovals(client) {
  const { approvals } = await client.call('/account/approvals');
  return Promise.all(approvals.map(async (entry) => ({ ...entry, words: await verificationWords(entry.publicKey) })));
}

/** Seals the vault key to the new device's public key; only that device can open it. */
export async function approveDevice(client, approval) {
  const keys = await crypto.subtle.generateKey(ecdh, false, ['deriveBits']);
  const { vaultId, vaultKey } = client.credentials;
  const sealed = await encryptEnvelope(await approvalKey(keys.privateKey, approval.publicKey, approval.id), { vaultId, vaultKey }, approvalAad(approval.id));
  return client.call(`/account/approvals/${approval.id}`, 'POST', { envelope: JSON.stringify({ ...sealed, publicKey: await exportPublic(keys) }) });
}

export const rejectDevice = (client, id) => client.call(`/account/approvals/${id}`, 'DELETE', {});

/** Last resort: deletes the unreadable cloud and starts an empty one; notes on devices are not touched. */
export async function startOver(reset, { code, newPassword, deviceName }, { fetcher } = {}) {
  const vaultKey = generateVaultKey(), recoveryToken = randomToken(), device = await newDevice(deviceName);
  const result = await post(reset.url, '/auth/reset/restart', { resetId: reset.resetId, code, confirm: 'DELETE CLOUD DATA', recoveryTokenHash: await hashToken(recoveryToken), ...await newCredentials(newPassword, vaultKey), ...device.fields }, fetcher);
  return { client: connect(reset.url, result, device.deviceToken, vaultKey, fetcher), recoveryCode: encodeRecovery({ vaultId: result.vaultId, vaultKey, recoveryToken }) };
}

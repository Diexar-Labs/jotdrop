const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const iterations = 600000;
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

export function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64ToBytes(value) {
  if (typeof value !== 'string' || value.length > 16 * 1024 * 1024 || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) throw new Error('Invalid encoded data.');
  const result = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0));
  if (bytesToBase64(result) !== value) throw new Error('Invalid encoded data.');
  return result;
}

function keyBytes(value) {
  const bytes = base64ToBytes(value);
  if (bytes.length !== 32) throw new Error('Invalid key.');
  return bytes;
}

export const randomToken = () => bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
export const generateVaultKey = randomToken;
export async function hashToken(token) {
  keyBytes(token);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function normalizePath(path) {
  if (typeof path !== 'string' || !path || path.length > 512 || /[\\:\x00-\x1f\x7f]/.test(path)) throw new Error('Use a safe relative filename.');
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || ['.obsidian', '.git', '.stversions', '.stfolder'].includes(part.toLowerCase()))) throw new Error('This path cannot be synced.');
  return path;
}

export async function objectId(vaultKey, path) {
  const key = await crypto.subtle.importKey('raw', keyBytes(vaultKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`jotdrop:path:v1:${normalizePath(path)}`)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function encryptEnvelope(vaultKey, payload, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', keyBytes(vaultKey), 'AES-GCM', false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad), tagLength: 128 }, key, encoder.encode(JSON.stringify(payload)));
  return { v: 1, iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

export async function decryptEnvelope(vaultKey, envelope, aad) {
  if (!envelope || envelope.v !== 1) throw new Error('Unsupported encrypted format.');
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  if (iv.length !== 12 || ciphertext.length < 16) throw new Error('Invalid encrypted data.');
  const key = await crypto.subtle.importKey('raw', keyBytes(vaultKey), 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad), tagLength: 128 }, key, ciphertext);
  return JSON.parse(decoder.decode(plaintext));
}

async function localKey(password, salt) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new Error('Use an unlock passphrase of 12 to 1024 characters.');
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return bytesToBase64(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material, 256)));
}

export async function sealLocal(value, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { v: 1, salt: bytesToBase64(salt), iterations, envelope: await encryptEnvelope(await localKey(password, salt), value, 'jotdrop:local:v1') };
}

export async function unsealLocal(sealed, password) {
  if (!sealed || sealed.v !== 1 || sealed.iterations !== iterations) throw new Error('Unsupported device key format.');
  const salt = base64ToBytes(sealed.salt);
  if (salt.length !== 16) throw new Error('Invalid device key salt.');
  return decryptEnvelope(await localKey(password, salt), sealed.envelope, 'jotdrop:local:v1');
}

export function validId(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
export function encodeRecovery({ vaultId, vaultKey, recoveryToken }) {
  if (!validId(vaultId)) throw new Error('Invalid workspace ID.');
  keyBytes(vaultKey);
  keyBytes(recoveryToken);
  return bytesToBase64(encoder.encode(JSON.stringify({ v: 1, vaultId, vaultKey, recoveryToken })));
}
export function decodeRecovery(code) {
  if (typeof code !== 'string' || code.length > 2048) throw new Error('Invalid recovery code.');
  const value = JSON.parse(decoder.decode(base64ToBytes(code)));
  if (value.v !== 1) throw new Error('Unsupported recovery code.');
  encodeRecovery(value);
  return value;
}

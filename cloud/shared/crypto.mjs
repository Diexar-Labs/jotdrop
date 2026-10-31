const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const iterations = 600000;
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

// Native base64 when available: the fallbacks take most of a second per 4 MiB file and freeze the page.
export function bytesToBase64(bytes) {
  if (bytes.toBase64) return bytes.toBase64({ alphabet: 'base64url', omitPadding: true });
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64ToBytes(value) {
  // Up to the largest file in pieces (200 MB), which the website keeps as base64.
  if (typeof value !== 'string' || value.length > 280 * 1024 * 1024 || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) throw new Error('Invalid encoded data.');
  let result;
  if (Uint8Array.fromBase64) result = Uint8Array.fromBase64(value, { alphabet: 'base64url' });
  else {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    result = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) result[index] = binary.charCodeAt(index);
  }
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

// A shared space's folder, notes/Shared/<id>/, syncs with its own key and is never part of this vault. An ordinary folder called Shared stays ordinary.
export const isSpacePath = (path) => /^notes\/shared\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i.test(path);

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

// v2 objects: a file goes in encrypted pieces of 1 MiB; a slow line still sends one within the server's 30 s limit.
export const CHUNK_BYTES = 1024 * 1024;
// Small files stay inside the manifest, so a note needs one request.
export const INLINE_BYTES = 64 * 1024;
// The largest plan maximum (JotDrop Plus); the server enforces each plan's own maximum.
export const MAX_CHUNKED_BYTES = 200 * 1024 * 1024;

export async function sha256Hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const chunkAad = (vaultId, id, index) => encoder.encode(`jotdrop:chunk:v1:${vaultId}:${id}:${index}`);

/** `iv || ciphertext+tag`. The IV follows from the piece itself, so the same piece gives the same bytes and an interrupted upload resumes. */
export async function encryptChunk(vaultKey, vaultId, id, index, plain) {
  const mac = await crypto.subtle.importKey('raw', keyBytes(vaultKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const iv = new Uint8Array(await crypto.subtle.sign('HMAC', mac, encoder.encode(`jotdrop:chunk-iv:v1:${id}:${index}:${await sha256Hex(plain)}`))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', keyBytes(vaultKey), 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: chunkAad(vaultId, id, index), tagLength: 128 }, key, plain));
  const sealed = new Uint8Array(12 + ciphertext.length);
  sealed.set(iv); sealed.set(ciphertext, 12);
  return sealed;
}

export async function decryptChunk(vaultKey, vaultId, id, index, sealed) {
  if (!(sealed instanceof Uint8Array) || sealed.length < 28 || sealed.length > CHUNK_BYTES + 28) throw new Error('Invalid encrypted piece.');
  const key = await crypto.subtle.importKey('raw', keyBytes(vaultKey), 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12), additionalData: chunkAad(vaultId, id, index), tagLength: 128 }, key, sealed.subarray(12)));
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

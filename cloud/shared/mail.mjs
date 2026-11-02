import { base64ToBytes, bytesToBase64 } from './crypto.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

// Server-enforced limits; mailin.mjs and the clients read the same numbers.
export const MAX_MAIL_BYTES = 20 * 1024 * 1024;
export const MAX_PENDING_ITEMS = 200;
export const MAX_PENDING_BYTES = 100 * 1024 * 1024;
export const MAILS_PER_HOUR = 30;
export const MAILS_PER_DAY = 200;

// Lowercase and digits without 0/o/1/l: 32 characters, so 12 give 60 bits and every byte maps evenly.
export const ADDRESS_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function mailAddress(domain) {
  if (typeof domain !== 'string' || !/^[a-z0-9.-]{4,128}$/.test(domain)) throw new Error('Invalid mail domain.');
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${[...bytes].map((byte) => ADDRESS_ALPHABET[byte % 32]).join('')}@${domain}`;
}

const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
async function taggedHash(tag, value) {
  if (typeof value !== 'string' || !value || value.length > 320 || !value.includes('@')) throw new Error('Invalid mail address.');
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`${tag}${value.trim().toLowerCase()}`))));
}
/** The server only ever stores and compares these hashes, never an address itself. */
export const addressHash = (address) => taggedHash('jotdrop:mail-address:v1:', address);
export const senderHash = (sender) => taggedHash('jotdrop:mail-sender:v1:', sender);

// RFC 8410 PKCS8 header for a raw X25519 scalar; the only form WebCrypto imports.
const PKCS8_PREFIX = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20);

export async function importMailPrivate(scalar) {
  if (!(scalar instanceof Uint8Array) || scalar.length !== 32) throw new Error('Invalid mail key.');
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(PKCS8_PREFIX);
  pkcs8.set(scalar, 16);
  return crypto.subtle.importKey('pkcs8', pkcs8, 'X25519', true, ['deriveBits']);
}

async function hkdf(ikm, salt, info) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) }, key, 256));
}

/**
 * The account's X25519 pair follows from the vault key alone: nothing is stored, synced or lost,
 * and HKDF is one-way, so this key never leads back to the vault key.
 */
export async function mailKeyPair(vaultKey) {
  const ikm = base64ToBytes(vaultKey);
  if (ikm.length !== 32) throw new Error('Invalid key.');
  const scalar = await hkdf(ikm, new Uint8Array(0), 'jotdrop:mail-x25519:v1');
  scalar[0] &= 248; scalar[31] &= 127; scalar[31] |= 64;
  const privateKey = await importMailPrivate(scalar);
  const { x } = await crypto.subtle.exportKey('jwk', privateKey);
  return { privateKey, publicKey: x };
}

async function sharedSecret(privateKey, publicKeyBytes) {
  const publicKey = await crypto.subtle.importKey('raw', publicKeyBytes, 'X25519', false, []);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: publicKey }, privateKey, 256));
}

/** One AES-256-GCM key per mail; the AAD then separates the body from each attachment. */
export async function mailAesKey(secret, ephemeralPublic, accountPublic, mailId) {
  const salt = new Uint8Array(64);
  salt.set(ephemeralPublic); salt.set(accountPublic, 32);
  return crypto.subtle.importKey('raw', await hkdf(secret, salt, `jotdrop:mail-seal:v1:${mailId}`), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const bodyAad = (vaultId, mailId) => encoder.encode(`jotdrop:mail:v1:${vaultId}:${mailId}`);
const partAad = (vaultId, mailId, n) => encoder.encode(`jotdrop:mail-part:v1:${vaultId}:${mailId}:${n}`);

async function sealBytes(key, aad, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plain));
  const sealed = new Uint8Array(12 + ciphertext.length);
  sealed.set(iv); sealed.set(ciphertext, 12);
  return sealed;
}

async function openBytes(key, aad, sealed) {
  if (!(sealed instanceof Uint8Array) || sealed.length < 28 || sealed.length > MAX_MAIL_BYTES + 28) throw new Error('Invalid sealed mail.');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12), additionalData: aad, tagLength: 128 }, key, sealed.subarray(12)));
}

/**
 * Seals one parsed mail for an account so only that account's devices can ever read it again.
 * The ephemeral private key and the readable mail go out of scope right here.
 */
export async function sealMail(accountPublic, vaultId, mailId, payload, parts = []) {
  const accountBytes = base64ToBytes(accountPublic);
  if (accountBytes.length !== 32) throw new Error('Invalid mail key.');
  const ephemeral = await crypto.subtle.generateKey('X25519', true, ['deriveBits']);
  const ephemeralBytes = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const key = await mailAesKey(await sharedSecret(ephemeral.privateKey, accountBytes), ephemeralBytes, accountBytes, mailId);
  return {
    ephemeralKey: bytesToBase64(ephemeralBytes),
    body: bytesToBase64(await sealBytes(key, bodyAad(vaultId, mailId), encoder.encode(JSON.stringify(payload)))),
    parts: await Promise.all(parts.map((part, n) => sealBytes(key, partAad(vaultId, mailId, n), part).then(bytesToBase64))),
  };
}

/** The client's side of the same key: its derived private key against the mail's ephemeral public key. */
export async function openMailKey(privateKey, accountPublic, ephemeralKey, mailId) {
  const ephemeralBytes = base64ToBytes(ephemeralKey);
  const accountBytes = base64ToBytes(accountPublic);
  if (ephemeralBytes.length !== 32 || accountBytes.length !== 32) throw new Error('Invalid mail key.');
  return mailAesKey(await sharedSecret(privateKey, ephemeralBytes), ephemeralBytes, accountBytes, mailId);
}

export async function openMailBody(key, vaultId, mailId, sealed) {
  const payload = JSON.parse(decoder.decode(await openBytes(key, bodyAad(vaultId, mailId), base64ToBytes(sealed))));
  if (payload.v !== 1) throw new Error('Unsupported mail format.');
  return payload;
}

export const openMailPart = (key, vaultId, mailId, n, sealed) => openBytes(key, partAad(vaultId, mailId, n), base64ToBytes(sealed));

const safeText = (value, fallback, length) => {
  const text = typeof value === 'string' ? value.replace(/[\\/:\x00-\x1f\x7f#[\]|^]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length).trim() : '';
  return text.replace(/^[.\s]+|[.\s]+$/g, '') || fallback;
};

// For lines inside the note, where only control characters are a problem.
const lineText = (value, fallback, length) => {
  const text = typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length).trim() : '';
  return text || fallback;
};

/**
 * Builds the note for one opened mail. Everything is derived from the mail and its id,
 * so two devices converting the same mail write byte-identical files and sync merges them silently.
 */
export function mailToNote(payload, mailId, receivedAt) {
  const id6 = mailId.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase();
  const received = new Date(receivedAt);
  if (!id6 || Number.isNaN(received.getTime())) throw new Error('Invalid mail item.');
  const day = received.toISOString().slice(0, 10);
  const subject = safeText(payload.subject, 'Mail', 60);
  const attachments = (Array.isArray(payload.attachments) ? payload.attachments : []).map((part, n) => ({
    part: n,
    type: typeof part.type === 'string' ? part.type : 'application/octet-stream',
    name: `mail-${id6}-${n + 1} ${safeText(part.name, 'attachment', 80)}`,
  }));
  const from = lineText(payload.from, 'unknown sender', 160);
  const date = lineText(payload.date, received.toISOString().slice(0, 16).replace('T', ' '), 80);
  const text = typeof payload.text === 'string' ? payload.text.replace(/\r\n/g, '\n').trim() : '';
  const lines = [`# ${subject}`, '', `From ${from} on ${date}`, ''];
  if (text) lines.push(text, '');
  for (const attachment of attachments) lines.push(`![[${attachment.name}]]`);
  if (attachments.length) lines.push('');
  lines.push('#mail', '');
  return { path: `notes/Mail/${day} ${subject} ${id6}.md`, content: lines.join('\n'), attachments };
}

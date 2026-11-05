import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { argon2, createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, hkdfSync, randomBytes, randomInt, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, statfsSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import qrcode from 'qrcode-generator';
import { createBrevoList, createSesMailer } from './mailer.mjs';
import { EARLY_FEATURES, MAX_VOTES, ROADMAP } from './roadmap.mjs';
import { MAILS_PER_DAY, MAILS_PER_HOUR, MAX_MAIL_BYTES, MAX_PENDING_BYTES, MAX_PENDING_ITEMS } from './shared/mail.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 12 * 1024 * 1024;
const MAX_METADATA_BODY = 16 * 1024;
// A sealed 20 MB mail arrives from the mailin process as base64 with some envelope overhead.
const MAX_MAILIN_BODY = 32 * 1024 * 1024;
const MAX_MAIL_PARTS = 20, MAX_MAIL_SENDERS = 200;
const REPORT_ADDRESS = 'hello@jotdrop.net';
const REPORT_REASONS = ['abuse', 'illegal', 'spam', 'other'];
// A note anyone with its link can read. Text only: the key stays in the link, so nobody here can read or moderate it.
const LINK_DAYS = [1, 7, 30, 0], LINK_FREE_DAYS = 7, MAX_LINK_BYTES = 64 * 1024, MAX_LINKS = 100;
// A list anyone with its link can tick, without an account: sealed like a note link, with a version number a writer
// names (409 when it moved on) and a proof of the key, of which only the hash is kept. The owner's envelope also holds
// the last version an owner wrote, so it may be a note longer than a note link's.
const MAX_LIST_OWNER_BYTES = MAX_LINK_BYTES + 4096, LIST_WRITES_A_MINUTE = 60, LIST_WRITES_EACH_A_MINUTE = 600;
const MAX_REPORTS_A_DAY = 10;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const TRANSFER_CHUNK_BYTES = 64 * 1024;
// v2 objects: encrypted pieces of up to 1 MiB of file plus a 28-byte IV and tag.
const PIECE_BYTES = 1024 * 1024;
const MAX_PIECES = 200;
// A v1 envelope (base64 inside base64, about 16/9 of the file) above this size holds more than 64 KiB, which
// pieces store at its real size; smaller files stay inside a manifest either way.
const LEGACY_ENVELOPE_BYTES = 116508;
// A version moved into pieces keeps its old envelope aside this long, so a mistake can be undone by hand.
const RETIRED_LIFETIME = 7 * 24 * 60 * 60 * 1000;
const TRANSFER_LIFETIME = 24 * 60 * 60 * 1000;
const CODE_LIFETIME = 15 * 60 * 1000;
const LOCK_TIME = 15 * 60 * 1000;
const CODE_LOCK_TIME = 24 * 60 * 60 * 1000;
const APPROVAL_LIFETIME = 10 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
// JotDrop Plus: the free plan keeps 30 days of open history; after Plus ends, 90 more days stay open.
const FREE_HISTORY = 30 * DAY;
const PLUS_GRACE = 90 * DAY;
const TRIAL_TIME = 14 * DAY;
// The family plan: the person who pays and five others, invited with a link that works once, for a week.
const FAMILY_SEATS = 6, FAMILY_INVITE_TIME = 7 * DAY;
// Managed Payments needs this API version or later.
const STRIPE_VERSION = '2025-03-31.basil';
// A past-due renewal is not paid yet; it still counts as a running subscription.
const PAID = ['active', 'trialing'], RUNNING = ['active', 'trialing', 'past_due'], FINAL = ['canceled', 'incomplete_expired'];
// Clients derive their login and unlock keys with Argon2id; the server only stores these settings.
const DEFAULT_KDF = { memory: 65536, passes: 3, parallelism: 1 };
// Sign in with Google or GitHub: the provider only proves who someone is; the vault key never goes there.
const OAUTH_PROVIDERS = {
  google: { name: 'Google', authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', api: 'https://openidconnect.googleapis.com/v1/userinfo', scope: 'openid email', extra: { prompt: 'select_account' },
    certs: 'https://www.googleapis.com/oauth2/v3/certs', issuers: ['accounts.google.com', 'https://accounts.google.com'] },
  github: { name: 'GitHub', authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', api: 'https://api.github.com', scope: 'user:email', extra: {} },
};
// Where the browser goes back to after the provider; the ticket only works with the secret the app made before.
const OAUTH_RETURN = { web: (origin, query) => `${origin}/#${query}`, obsidian: (origin, query) => `obsidian://jotdrop-cloud?${query}`,
  android: (origin, query) => `jotdrop-cloud://oauth?${query}` };
const OAUTH_LIFETIME = 10 * 60 * 1000;
// Second hash of the client's login key, so a copied database cannot be replayed as a login.
const SERVER_KDF = { memory: 7168, passes: 5, parallelism: 1, tagLength: 32 };
const argon2Async = promisify(argon2);
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (status, error, extra = {}) => { throw Object.assign(new Error(error), { status, extra }); };
const requireValue = (condition, error) => { if (!condition) fail(400, error); };
const validHash = (value) => typeof value === 'string' && hashPattern.test(value);
const validId = (value) => typeof value === 'string' && idPattern.test(value);
const validToken = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
const sqliteCode = (error) => error.code === 'ERR_SQLITE_ERROR' ? error.errcode & 0xff : undefined;
const deviceName = (value) => requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= 80 && !/[\x00-\x1f]/.test(value), 'Invalid device name');
const newCode = () => String(randomInt(1000000)).padStart(6, '0');
const validCode = (code) => typeof code === 'string' && /^[0-9]{6}$/.test(code);
// The owner's dashboard: a session lasts 8 hours at most and ends after 30 idle minutes.
const ADMIN_SESSION_TIME = 8 * 60 * 60 * 1000;
const ADMIN_IDLE_TIME = 30 * 60 * 1000;
const ADMIN_COOKIE = '__Host-jotdrop_admin';
const ADMIN_PAGE = 500;
// "argon2id:m=<KiB>,t=<passes>,p=<lanes>:<salt>:<hash>", base64url; no "$", so env files and shells keep it as is.
const adminHashPattern = /^argon2id:m=(\d{1,7}),t=(\d{1,2}),p=(\d{1,2}):([A-Za-z0-9_-]{22,86}):([A-Za-z0-9_-]{43})$/;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// Shared spaces: with a space in X-JotDrop-Vault a member reaches its files through these routes and nothing else.
const SPACE_ROUTES = [['GET', /^\/changes$/], ['GET', /^\/status$/], ['POST', /^\/chunks\/missing$/], ['GET', /^\/chunks\/[0-9a-f]{64}$/], ['PUT', /^\/chunks\/[0-9a-f]{64}$/],
  ['GET', /^\/objects\/[0-9a-f]{64}$/], ['PUT', /^\/objects\/[0-9a-f]{64}$/], ['DELETE', /^\/objects\/[0-9a-f]{64}$/], ['GET', /^\/objects\/[0-9a-f]{64}\/history$/], ['POST', /^\/objects\/[0-9a-f]{64}\/restore$/]];
const MAX_SPACE_MEMBERS = 20, MAX_OPEN_INVITES = 20, MAX_MEMBERSHIPS = 100, MAX_OWN_SPACES = 100, MAX_SPACE_PREFS = 64 * 1024;
const INVITE_LIFETIME = 7 * DAY, TAKEOVER_WAIT = 7 * DAY, FROZEN_SPACE_LIFETIME = 30 * DAY, UNFINISHED_SPACE_LIFETIME = 2 * DAY;

/** QR code as rows of "1" (dark) and "0", so every client can draw it without a QR library of its own. */
function qrRows(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => (qr.isDark(row, column) ? '1' : '0')).join(''));
}

export function base32(bytes) {
  let bits = 0, value = 0, output = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xfff; bits += 8;
    while (bits >= 5) { output += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return bits ? output + BASE32[(value << (5 - bits)) & 31] : output;
}

function fromBase32(text) {
  let bits = 0, value = 0;
  const bytes = [];
  for (const character of text) {
    value = ((value << 5) | BASE32.indexOf(character)) & 0xfff; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

/** RFC 6238 with the defaults every authenticator app uses: SHA-1, 30 seconds, 6 digits. */
function totpCode(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest(), offset = mac[19] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

// Throwaway mailboxes (the public-domain list of github.com/disposable-email-domains): an account needs an address
// that lasts, since sign-in codes and a lost password go there. Signing in with an existing account is not affected.
const DISPOSABLE_DOMAINS = new Set(readFileSync(join(directory, 'disposable-email-domains.txt'), 'utf8').split('\n').map((line) => line.trim().toLowerCase()).filter(Boolean));
function requirePermanentEmail(email) {
  const parts = email.slice(email.lastIndexOf('@') + 1).split('.');
  for (let index = 0; index < parts.length - 1; index++) {
    if (DISPOSABLE_DOMAINS.has(parts.slice(index).join('.'))) fail(400, 'Use an email address you keep: JotDrop sends your sign-in codes there, and throwaway addresses are not accepted.', { code: 'disposable-email' });
  }
}

function emailValue(value) {
  requireValue(typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()), 'Invalid email address');
  return value.trim().toLowerCase();
}

function kdfValue(value) {
  const range = (number, low, high) => Number.isSafeInteger(number) && number >= low && number <= high;
  requireValue(value && typeof value === 'object' && range(value.memory, 65536, 1048576) && range(value.passes, 3, 10) && range(value.parallelism, 1, 4) && typeof value.salt === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value.salt) && Buffer.from(value.salt, 'base64url').toString('base64url') === value.salt, 'Invalid key derivation settings');
  return JSON.stringify({ salt: value.salt, memory: value.memory, passes: value.passes, parallelism: value.parallelism });
}

async function hashAuthKey(authKey, salt = randomBytes(16)) {
  const digest = await argon2Async('argon2id', { message: Buffer.from(authKey, 'base64url'), nonce: salt, ...SERVER_KDF });
  return `${salt.toString('base64url')}$${digest.toString('hex')}`;
}

// Unknown accounts still pay for one hash, so timing does not reveal which addresses exist.
async function checkAuthKey(authKey, stored = `${'A'.repeat(22)}$${'0'.repeat(64)}`) {
  const [salt, digest] = stored.split('$');
  return equal((await hashAuthKey(authKey, Buffer.from(salt, 'base64url'))).split('$')[1], digest);
}

/** The admin password as JOTDROP_CLOUD_ADMIN_PASSWORD_HASH stores it (see cloud/admin-setup.mjs). */
export async function hashAdminPassword(password, { memory = 65536, passes = 3, parallelism = 1 } = {}, salt = randomBytes(16)) {
  const digest = await argon2Async('argon2id', { message: Buffer.from(password.normalize('NFC')), nonce: salt, memory, passes, parallelism, tagLength: 32 });
  return `argon2id:m=${memory},t=${passes},p=${parallelism}:${salt.toString('base64url')}:${digest.toString('base64url')}`;
}

function adminHashSettings(stored) {
  const match = typeof stored === 'string' && adminHashPattern.exec(stored);
  const [memory, passes, parallelism] = match ? match.slice(1, 4).map(Number) : [];
  const salt = match && Buffer.from(match[4], 'base64url');
  if (!match || memory < 19456 || memory > 1048576 || passes < 2 || passes > 10 || parallelism < 1 || parallelism > 4 || salt.length < 16 || salt.toString('base64url') !== match[4]) return undefined;
  return { settings: { memory, passes, parallelism }, salt, digest: match[5] };
}

async function credentialValue(value) {
  const kdf = kdfValue(value.kdf);
  requireValue(validToken(value.authKey), 'Invalid login key');
  envelopeSize(value.wrappedVaultKey, 1024);
  return { kdf, authHash: await hashAuthKey(value.authKey), wrappedVaultKey: value.wrappedVaultKey };
}

function envelopeSize(value, limit = 8 * 1024 * 1024) {
  requireValue(typeof value === 'string' && Buffer.byteLength(value) <= limit, 'Invalid envelope size');
  let envelope;
  try { envelope = JSON.parse(value); } catch { fail(400, 'Invalid envelope'); }
  requireValue(envelope && envelope.v === 1 && typeof envelope.iv === 'string' && typeof envelope.ciphertext === 'string', 'Invalid envelope');
  for (const encoded of [envelope.iv, envelope.ciphertext]) requireValue(/^[A-Za-z0-9_-]+$/.test(encoded) && Buffer.from(encoded, 'base64url').toString('base64url') === encoded, 'Invalid envelope encoding');
  requireValue(Buffer.from(envelope.iv, 'base64url').length === 12 && Buffer.from(envelope.ciphertext, 'base64url').length >= 16, 'Invalid envelope');
  return Buffer.byteLength(value);
}

async function bodyBytes(req, maximum) {
  if (Number(req.headers['content-length'] || 0) > maximum) fail(413, 'Request exceeds size limit');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) fail(413, 'Request exceeds size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function body(req, maximum = MAX_BODY) {
  requireValue(/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''), 'Expected JSON content type');
  const bytes = await bodyBytes(req, maximum);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail(400, 'Invalid JSON'); }
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object');
  return value;
}

/** Loopback-only server behind a trusted HTTPS proxy. Accounts need a mailer; no billing or provider credentials. `quotaBytes` and `freeDeviceLimit` are the free plan's limits. */
export async function createCloudServer({ dataDir, enrollmentToken, mailer, newsletter, serverKey, stripe, reviewLogin, oauth = {}, fetcher = globalThis.fetch, quotaBytes = 250 * 1024 * 1024, plusQuotaBytes = 10 * 1024 * 1024 * 1024, maxFileBytes = 25 * 1024 * 1024, plusMaxFileBytes = 200 * 1024 * 1024, freeDeviceLimit = 2, maxHistoryEntries = 100000, maxDeviceEntries = 1000, maxPairingEntries = 128, maxConcurrentRequests = 16, signupsPerAddress = 5, signupTrial = TRIAL_TIME, roadmap = ROADMAP, earlyFeatures = EARLY_FEATURES, turnstile, webRoot = join(directory, 'web'), corsOrigins = [], publicOrigin, adminOrigin, adminPasswordHash, adminTotpSecret, adminRoot = join(directory, 'admin'), port = 0, enrollmentLimit = 1, sweepEvery = 60 * 60 * 1000, clock = Date.now, mailDomain, mailinToken }) {
  if (!dataDir || (enrollmentToken !== undefined && !validToken(enrollmentToken)) || [quotaBytes, plusQuotaBytes, freeDeviceLimit].some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error('Provide a data directory, random 32-byte enrollment token and positive quota.');
  if (mailer !== undefined && typeof mailer !== 'function') throw new Error('Provide the mailer as a function.');
  // Google Play reviewers cannot receive email codes: this one address confirms with a fixed code and gets no mail. The password stays required.
  if (!Number.isSafeInteger(signupTrial) || signupTrial < 0) throw new Error('Provide the sign-up trial as whole days, 0 or more.');
  if (reviewLogin && !(typeof reviewLogin.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reviewLogin.email) && reviewLogin.email === reviewLogin.email.toLowerCase() && validCode(reviewLogin.code))) throw new Error('Provide the review login as a lowercase email address and a six-digit code.');
  // `newsletter(email)` adds someone who ticked "Email me news about JotDrop" to the mailing list (Brevo).
  if (newsletter !== undefined && typeof newsletter !== 'function') throw new Error('Provide the newsletter as a function.');
  if (serverKey !== undefined && !validToken(serverKey)) throw new Error('Provide the server key as 32 random bytes.');
  // Mail to JotDrop: `mailDomain` is the domain of the secret addresses; `mailinToken` lets only the local mailin process deliver.
  if (mailDomain !== undefined && !/^[a-z0-9][a-z0-9.-]{2,126}[a-z0-9]$/.test(mailDomain)) throw new Error('Provide the mail domain as a lowercase hostname.');
  if (mailinToken !== undefined && !validToken(mailinToken)) throw new Error('Provide the mailin token as 32 random bytes.');
  // JotDrop Plus is sold through Stripe Managed Payments (Stripe is the seller and handles VAT); without settings there is no checkout.
  if (stripe !== undefined && !['secretKey', 'webhookSecret', 'monthPrice', 'yearPrice'].every((name) => typeof stripe[name] === 'string' && stripe[name].length > 0)) throw new Error('Provide the Stripe secret key, webhook secret and both prices.');
  // `oauth.google` / `oauth.github`: { clientId, clientSecret }, plus endpoint overrides for tests.
  const providers = Object.fromEntries(Object.entries(oauth).filter(([, settings]) => settings).map(([name, settings]) => {
    if (!OAUTH_PROVIDERS[name] || typeof settings.clientId !== 'string' || !settings.clientId || typeof settings.clientSecret !== 'string' || !settings.clientSecret) throw new Error('Provide the client ID and secret for each sign-in provider (google, github).');
    return [name, { ...OAUTH_PROVIDERS[name], ...settings }];
  }));
  // Kept outside the database: a copied database alone cannot verify codes or produce authenticator codes.
  const serverSubkey = (purpose) => Buffer.from(hkdfSync('sha256', Buffer.from(serverKey, 'base64url'), Buffer.alloc(0), `jotdrop:server:${purpose}:v1`, 32));
  const codeKey = serverKey && serverSubkey('code'), totpKey = serverKey && serverSubkey('totp');
  const codeHash = (scope, code) => createHmac('sha256', codeKey).update(`${scope}:${code}`).digest('hex');
  const emailCode = (scope, code) => (row) => validCode(code) && equal(codeHash(scope, code), row.codeHash);
  if (!Number.isSafeInteger(maxHistoryEntries) || maxHistoryEntries < 1) throw new Error('Provide a positive safe-integer history entry limit.');
  if ([maxDeviceEntries, maxPairingEntries].some((limit) => !Number.isSafeInteger(limit) || limit < 1)) throw new Error('Provide positive safe-integer metadata entry limits.');
  if (!Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests < 1) throw new Error('Provide a positive safe-integer concurrent request limit.');
  if (!Number.isSafeInteger(enrollmentLimit) || enrollmentLimit < 1 || corsOrigins.some((origin) => !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) && origin !== 'app://obsidian.md' && origin !== 'file://')) throw new Error('Invalid enrollment limit or explicit client origin.');
  function proxyHost(origin, error) {
    if (origin === undefined) return undefined;
    let parsed;
    try { parsed = new URL(origin); } catch { throw new Error(error); }
    if (typeof origin !== 'string' || parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.hostname.includes('*')) throw new Error(error);
    return parsed.host;
  }
  const publicHost = proxyHost(publicOrigin, 'Provide one canonical HTTPS origin for the trusted reverse proxy.');
  // The owner's dashboard has its own host behind the same proxy (which also locks it to the owner's IP address).
  const adminHost = proxyHost(adminOrigin, 'Provide one canonical HTTPS origin for the admin dashboard.');
  if (adminHost && adminHost === publicHost) throw new Error('The admin dashboard needs its own host, not the public one.');
  const adminHashed = adminPasswordHash === undefined ? undefined : adminHashSettings(adminPasswordHash);
  if (adminPasswordHash !== undefined && !adminHashed) throw new Error('Provide the admin password hash that cloud/admin-setup.mjs prints.');
  if (adminTotpSecret !== undefined && (typeof adminTotpSecret !== 'string' || !/^[A-Z2-7]{26,128}$/.test(adminTotpSecret))) throw new Error('Provide the admin authenticator secret in base32 (at least 128 bits), as cloud/admin-setup.mjs prints it.');
  // Without all three the dashboard does not exist: every request on its host is 404.
  const adminEnabled = Boolean(adminHost && adminHashed && adminTotpSecret);
  const adminSecret = adminEnabled && fromBase32(adminTotpSecret);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'cloud.db'), { timeout: 5000 });
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  function transaction(action) {
    // Upload publication composes with append in the same atomic transaction.
    if (db.isTransaction) return action();
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  try {
    if (![0, 1].includes(one('PRAGMA user_version').user_version)) throw new Error('Unsupported cloud database version.');
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS vaults(id TEXT PRIMARY KEY, recoveryHash TEXT NOT NULL, enrollmentHash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, vaultId TEXT NOT NULL REFERENCES vaults(id), name TEXT NOT NULL, tokenHash TEXT NOT NULL, createdAt TEXT NOT NULL, lastSeenAt TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS devices_by_vault ON devices(vaultId);
        CREATE TABLE IF NOT EXISTS changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT, vaultId TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, deleted INTEGER NOT NULL, size INTEGER NOT NULL, updatedAt TEXT NOT NULL, deviceId TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS changes_by_vault ON changes(vaultId,sequence);
        CREATE TABLE IF NOT EXISTS pairings(id TEXT PRIMARY KEY, vaultId TEXT NOT NULL REFERENCES vaults(id), deviceName TEXT NOT NULL, deviceTokenHash TEXT NOT NULL, claimTokenHash TEXT NOT NULL, envelope TEXT NOT NULL, expiresAt INTEGER NOT NULL, creatorId TEXT NOT NULL REFERENCES devices(id), claimed INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS pairings_by_vault ON pairings(vaultId,expiresAt);
        CREATE TABLE IF NOT EXISTS envelopes(vaultId TEXT NOT NULL REFERENCES vaults(id), id TEXT NOT NULL, envelopeHash TEXT NOT NULL, envelope TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(vaultId,id,envelopeHash));
        CREATE TABLE IF NOT EXISTS uploads(vaultId TEXT NOT NULL REFERENCES vaults(id), deviceId TEXT NOT NULL REFERENCES devices(id), id TEXT NOT NULL, baseRevision INTEGER NOT NULL, envelopeHash TEXT NOT NULL, size INTEGER NOT NULL, reservedBytes INTEGER NOT NULL, expiresAt INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(vaultId,deviceId,id,baseRevision,envelopeHash));
        CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, vaultId TEXT NOT NULL UNIQUE REFERENCES vaults(id), kdf TEXT NOT NULL, authHash TEXT NOT NULL, wrappedVaultKey TEXT NOT NULL, failedLogins INTEGER NOT NULL DEFAULT 0, lockedUntil INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, passwordChangedAt TEXT NOT NULL, totpSecret TEXT, totpPending TEXT, totpLastStep INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS code_failures(scope TEXT PRIMARY KEY, count INTEGER NOT NULL, lockedUntil INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS signups(id TEXT PRIMARY KEY, email TEXT NOT NULL, vaultId TEXT REFERENCES vaults(id), kdf TEXT NOT NULL, authHash TEXT NOT NULL, wrappedVaultKey TEXT NOT NULL, recoveryHash TEXT, deviceName TEXT, deviceTokenHash TEXT, codeHash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expiresAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS login_challenges(id TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES accounts(id), deviceName TEXT NOT NULL, deviceTokenHash TEXT NOT NULL, factor TEXT NOT NULL, codeHash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expiresAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS resets(id TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES accounts(id), codeHash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expiresAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS device_approvals(id TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES accounts(id), publicKey TEXT NOT NULL, claimTokenHash TEXT NOT NULL, envelope TEXT, expiresAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS secrets(name TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS signup_addresses(addressHash TEXT NOT NULL, createdAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS plans(vaultId TEXT PRIMARY KEY, plusUntil INTEGER NOT NULL DEFAULT 0, trialUsed INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS subscriptions(subscriptionId TEXT PRIMARY KEY, vaultId TEXT NOT NULL, status TEXT NOT NULL, paidUntil INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS subscriptions_by_vault ON subscriptions(vaultId);
        CREATE INDEX IF NOT EXISTS envelopes_size ON envelopes(vaultId,size);
        CREATE TABLE IF NOT EXISTS identities(provider TEXT NOT NULL, subject TEXT NOT NULL, accountId TEXT NOT NULL REFERENCES accounts(id), createdAt TEXT NOT NULL, PRIMARY KEY(provider,subject));
        CREATE TABLE IF NOT EXISTS oauth_states(id TEXT PRIMARY KEY, provider TEXT NOT NULL, client TEXT NOT NULL, challenge TEXT NOT NULL, expiresAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS oauth_tickets(id TEXT PRIMARY KEY, provider TEXT NOT NULL, subject TEXT NOT NULL, email TEXT NOT NULL, challenge TEXT NOT NULL, expiresAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS newsletter(accountId TEXT PRIMARY KEY REFERENCES accounts(id), consentedAt TEXT NOT NULL, addedAt TEXT);
        CREATE TABLE IF NOT EXISTS chunks(vaultId TEXT NOT NULL REFERENCES vaults(id), name TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, createdAt INTEGER NOT NULL, claimed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(vaultId,name));
        CREATE TABLE IF NOT EXISTS envelope_chunks(vaultId TEXT NOT NULL, id TEXT NOT NULL, envelopeHash TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(vaultId,id,envelopeHash,name));
        CREATE INDEX IF NOT EXISTS envelope_chunks_by_name ON envelope_chunks(vaultId,name);
        CREATE TABLE IF NOT EXISTS retired_envelopes(vaultId TEXT NOT NULL, id TEXT NOT NULL, envelopeHash TEXT NOT NULL, envelope TEXT NOT NULL, size INTEGER NOT NULL, retiredAt INTEGER NOT NULL, replacedBy TEXT NOT NULL, PRIMARY KEY(vaultId,id,envelopeHash));`);
      // `pieces`: saved as a v2 manifest, or checked by a device and left as it is. Older versions are moved by devices.
      if (!all('PRAGMA table_info(envelopes)').some((column) => column.name === 'pieces')) db.exec('ALTER TABLE envelopes ADD COLUMN pieces INTEGER NOT NULL DEFAULT 0; UPDATE envelopes SET pieces=1 WHERE EXISTS (SELECT 1 FROM envelope_chunks ec WHERE ec.vaultId=envelopes.vaultId AND ec.id=envelopes.id AND ec.envelopeHash=envelopes.envelopeHash);');
      // The newsletter tick waits with the signup until the email address is confirmed.
      if (!all('PRAGMA table_info(signups)').some((column) => column.name === 'newsletter')) db.exec('ALTER TABLE signups ADD COLUMN newsletter INTEGER NOT NULL DEFAULT 0;');
      // A trial that runs: when its 14 days end, and `mail` 1 = "ends in 3 days" sent, 2 = "ended" sent or not needed.
      // Its own table, so `plans` keeps three columns for an older server after a rollback.
      db.exec('CREATE TABLE IF NOT EXISTS trials(vaultId TEXT PRIMARY KEY, trialUntil INTEGER NOT NULL, mail INTEGER NOT NULL DEFAULT 0);');
      // Which ideas on the roadmap (roadmap.mjs) an account voted for.
      db.exec('CREATE TABLE IF NOT EXISTS roadmap_votes(accountId TEXT NOT NULL, itemId TEXT NOT NULL, votedAt INTEGER NOT NULL, PRIMARY KEY(accountId,itemId));');
      // Mail to JotDrop: the server knows an address only as a hash, and a mail only as sealed blobs it can never open.
      db.exec(`CREATE TABLE IF NOT EXISTS mail_accounts(vaultId TEXT PRIMARY KEY REFERENCES vaults(id), addressHash TEXT NOT NULL UNIQUE, publicKey TEXT NOT NULL, addressEnvelope TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'open', createdAt INTEGER NOT NULL, rotatedAt INTEGER);
        CREATE TABLE IF NOT EXISTS mail_senders(vaultId TEXT NOT NULL, senderHash TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(vaultId,senderHash));
        CREATE TABLE IF NOT EXISTS mail_items(vaultId TEXT NOT NULL, id TEXT NOT NULL, receivedAt INTEGER NOT NULL, size INTEGER NOT NULL, ephemeralKey TEXT NOT NULL, sealed BLOB NOT NULL, PRIMARY KEY(vaultId,id));
        CREATE TABLE IF NOT EXISTS mail_parts(vaultId TEXT NOT NULL, itemId TEXT NOT NULL, n INTEGER NOT NULL, sealed BLOB NOT NULL, PRIMARY KEY(vaultId,itemId,n));
        CREATE TABLE IF NOT EXISTS mail_log(vaultId TEXT NOT NULL, receivedAt INTEGER NOT NULL);`);
      // Shared spaces. No foreign key to accounts and no higher user_version: an older server must keep starting and deleting accounts.
      db.exec(`CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY REFERENCES vaults(id), ownerAccountId TEXT NOT NULL, nameEnvelope TEXT NOT NULL, createdAt INTEGER NOT NULL, frozenAt INTEGER, replaces TEXT UNIQUE, replacedBy TEXT, ownerGoneAt INTEGER);
        CREATE INDEX IF NOT EXISTS spaces_by_owner ON spaces(ownerAccountId);
        CREATE TABLE IF NOT EXISTS space_members(spaceId TEXT NOT NULL, accountId TEXT NOT NULL, nameEnvelope TEXT, joinedAt INTEGER NOT NULL, PRIMARY KEY(spaceId,accountId));
        CREATE INDEX IF NOT EXISTS space_members_by_account ON space_members(accountId);
        CREATE TABLE IF NOT EXISTS space_keys(accountId TEXT NOT NULL, spaceId TEXT NOT NULL, wrapped TEXT NOT NULL, prefs TEXT, PRIMARY KEY(accountId,spaceId));
        CREATE TABLE IF NOT EXISTS space_invites(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, claimTokenHash TEXT NOT NULL, envelope TEXT, expiresAt INTEGER NOT NULL, claimedBy TEXT, claimedAt INTEGER);
        CREATE INDEX IF NOT EXISTS space_invites_by_space ON space_invites(spaceId);
        CREATE TABLE IF NOT EXISTS space_blocks(accountId TEXT NOT NULL, blockedAccountId TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(accountId,blockedAccountId));
        CREATE INDEX IF NOT EXISTS space_blocks_by_blocked ON space_blocks(blockedAccountId);
        CREATE TABLE IF NOT EXISTS space_reports(accountId TEXT NOT NULL, createdAt INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS space_reports_by_account ON space_reports(accountId);
        CREATE TABLE IF NOT EXISTS note_links(id TEXT PRIMARY KEY, accountId TEXT NOT NULL, envelope TEXT NOT NULL, ownerEnvelope TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER);
        CREATE INDEX IF NOT EXISTS note_links_by_account ON note_links(accountId);
        CREATE TABLE IF NOT EXISTS list_links(id TEXT PRIMARY KEY, accountId TEXT NOT NULL, revision INTEGER NOT NULL, envelope TEXT NOT NULL, ownerEnvelope TEXT NOT NULL, writeProofHash TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, expiresAt INTEGER);
        CREATE INDEX IF NOT EXISTS list_links_by_account ON list_links(accountId);
        CREATE TABLE IF NOT EXISTS family_subscriptions(subscriptionId TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS family_members(accountId TEXT PRIMARY KEY, ownerAccountId TEXT NOT NULL, joinedAt INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS family_members_by_owner ON family_members(ownerAccountId);
        CREATE TABLE IF NOT EXISTS family_invites(tokenHash TEXT PRIMARY KEY, ownerAccountId TEXT NOT NULL, expiresAt INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS family_invites_by_owner ON family_invites(ownerAccountId);`);
      // "Delete forever": the revision of the content-free tombstone that replaced a note and all its history.
      // Plan limits that free accounts ran into, per week: only how often and by how many accounts, never which.
      db.exec('CREATE TABLE IF NOT EXISTS limit_hits(kind TEXT NOT NULL, weekStart INTEGER NOT NULL, times INTEGER NOT NULL, accounts INTEGER NOT NULL, PRIMARY KEY(kind,weekStart));');
      // How a subscription is billed, from Stripe: 'month' or 'year', and the currency.
      db.exec('CREATE TABLE IF NOT EXISTS subscription_details(subscriptionId TEXT PRIMARY KEY, interval TEXT, currency TEXT);');
      db.exec('CREATE TABLE IF NOT EXISTS purges(vaultId TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, purgedAt INTEGER NOT NULL, PRIMARY KEY(vaultId,id));');
      // Who uploaded a piece that no version uses yet; only set in a space, so one member cannot block the others.
      if (!all('PRAGMA table_info(chunks)').some((column) => column.name === 'deviceId')) db.exec('ALTER TABLE chunks ADD COLUMN deviceId TEXT;');
      db.exec('CREATE INDEX IF NOT EXISTS chunks_by_device ON chunks(deviceId) WHERE deviceId IS NOT NULL;');
      run("INSERT INTO secrets VALUES('fake-salt',?) ON CONFLICT(name) DO NOTHING", randomBytes(32).toString('base64url'));
      const legacy = all('PRAGMA table_info(revisions)').some((column) => column.name === 'envelope');
      db.exec(`CREATE TABLE IF NOT EXISTS ${legacy ? 'revisions_migrated' : 'revisions'}(vaultId TEXT NOT NULL REFERENCES vaults(id), id TEXT NOT NULL, revision INTEGER NOT NULL, envelopeHash TEXT NOT NULL, deleted INTEGER NOT NULL, size INTEGER NOT NULL, updatedAt TEXT NOT NULL, deviceId TEXT NOT NULL, PRIMARY KEY(vaultId,id,revision), FOREIGN KEY(vaultId,id,envelopeHash) REFERENCES envelopes(vaultId,id,envelopeHash));`);
      if (legacy) {
        // Persisted previews used inline envelopes; migrate history and its references atomically.
        for (const row of db.prepare('SELECT * FROM revisions').iterate()) {
          const envelopeHash = hash(row.envelope);
          if (envelopeSize(row.envelope) !== row.size) throw new Error('Cloud revision size mismatch.');
          run('INSERT INTO envelopes(vaultId,id,envelopeHash,envelope,size) VALUES(?,?,?,?,?) ON CONFLICT(vaultId,id,envelopeHash) DO NOTHING', row.vaultId, row.id, envelopeHash, row.envelope, row.size);
          run('INSERT INTO revisions_migrated VALUES(?,?,?,?,?,?,?,?)', row.vaultId, row.id, row.revision, envelopeHash, row.deleted, row.size, row.updatedAt, row.deviceId);
        }
        db.exec('DROP TABLE revisions; ALTER TABLE revisions_migrated RENAME TO revisions;');
      }
      // Serves eviction's reference count and the envelope foreign-key check on delete.
      db.exec('CREATE INDEX IF NOT EXISTS revisions_by_envelope ON revisions(vaultId,id,envelopeHash);');
      if (all('PRAGMA foreign_key_check').length) throw new Error('Cloud database references are inconsistent.');
      db.exec('PRAGMA user_version=1;');
    });
  } catch (error) { db.close(); throw error; }
  const fakeSaltKey = one("SELECT value FROM secrets WHERE name='fake-salt'").value;
  const rate = new Map();
  // Behind the reverse proxy every request arrives from loopback, so limits would be shared by all visitors.
  // Caddy sets X-JotDrop-Client-IP to the visitor's address, replacing anything the visitor sent.
  function clientAddress(req) {
    const socket = req.socket.remoteAddress;
    const proxied = (publicHost && req.headers.host === publicHost || adminEnabled && req.headers.host === adminHost) && LOOPBACK_ADDRESSES.has(socket);
    const forwarded = proxied ? req.headers['x-jotdrop-client-ip'] : undefined;
    return typeof forwarded === 'string' && isIP(forwarded) ? forwarded : socket;
  }
  function limit(key, maximum) {
    const now = clock();
    if (rate.size > 2048) for (const [entry, state] of rate) if (state.until <= now) rate.delete(entry);
    const state = rate.get(key);
    if (!state || state.until <= now) { rate.set(key, { count: 1, until: now + 60000 }); return; }
    if (++state.count > maximum) fail(429, 'Too many attempts. Try again later.');
  }
  // A few new accounts per network a day. Only a keyed hash of the address is kept, and only for that day.
  const addressHash = (ip) => createHmac('sha256', fakeSaltKey).update(`signup-address:${ip}`).digest('base64url');
  function requireSignupRoom(ip) {
    run('DELETE FROM signup_addresses WHERE createdAt<=?', clock() - DAY);
    if (one('SELECT COUNT(*) AS count FROM signup_addresses WHERE addressHash=?', addressHash(ip)).count >= signupsPerAddress) fail(429, 'Too many new accounts from this network today. Try again tomorrow.', { code: 'signup-limit' });
  }
  const countSignup = (ip) => run('INSERT INTO signup_addresses VALUES(?,?)', addressHash(ip), clock());
  // Cloudflare Turnstile checks that a person, not a script, creates an email account. Off when not configured.
  async function requireHuman(token, ip) {
    if (!turnstile) return;
    requireValue(typeof token === 'string' && token.length > 0 && token.length <= 2048, 'Confirm that you are a person first.');
    let outcome;
    try {
      const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: turnstile.secret, response: token, remoteip: ip }), signal: AbortSignal.timeout(10000) });
      outcome = await response.json();
    } catch { fail(503, 'The person check is not reachable right now. Try again in a moment.'); }
    if (outcome?.success !== true) fail(400, 'The person check did not pass. Try again.', { code: 'human-check' });
  }
  const spaceRow = (id) => one('SELECT * FROM spaces WHERE id=?', id);
  // Plus runs until the latest of the trial or a manual grant (plans) and every paid subscription period.
  // A space has its owner's plan; without an owner, the free plan.
  function planRow(vaultId) {
    const space = spaceRow(vaultId);
    if (space) {
      const owner = !space.ownerGoneAt && one('SELECT vaultId FROM accounts WHERE id=?', space.ownerAccountId);
      if (!owner) return { plusUntil: 0, trialUsed: 0, trialUntil: 0 };
      vaultId = owner.vaultId;
    }
    const plan = { ...(one('SELECT plusUntil,trialUsed FROM plans WHERE vaultId=?', vaultId) ?? { plusUntil: 0, trialUsed: 0 }), trialUntil: one('SELECT trialUntil FROM trials WHERE vaultId=?', vaultId)?.trialUntil ?? 0 };
    // A family member has Plus as long as the family plan they are in.
    const payer = one('SELECT o.vaultId FROM family_members m JOIN accounts a ON a.id=m.accountId JOIN accounts o ON o.id=m.ownerAccountId WHERE a.vaultId=?', vaultId);
    return { ...plan, plusUntil: Math.max(plan.plusUntil, one('SELECT COALESCE(MAX(paidUntil),0) AS until FROM subscriptions WHERE vaultId=?', vaultId).until, payer ? familyUntil(payer.vaultId) : 0) };
  }
  const familyPrices = stripe?.familyMonthPrice && stripe?.familyYearPrice ? [stripe.familyMonthPrice, stripe.familyYearPrice, stripe.familyFounderYearPrice].filter(Boolean) : [];
  const familyUntil = (vaultId) => one('SELECT COALESCE(MAX(s.paidUntil),0) AS until FROM subscriptions s JOIN family_subscriptions f ON f.subscriptionId=s.subscriptionId WHERE s.vaultId=?', vaultId).until;
  const ownsFamily = (account) => familyUntil(account.vaultId) > clock();
  const familyMember = (account) => one('SELECT m.joinedAt,o.id,o.email,o.vaultId FROM family_members m JOIN accounts o ON o.id=m.ownerAccountId WHERE m.accountId=?', account.id);
  // A family whose plan ended is no family any more: someone in it can pay for their own.
  const activeMember = (account) => { const payer = familyMember(account); return payer && ownsFamily(payer) ? payer : null; };
  // Someone who pays for a family is its owner, whatever family they were in before.
  const familyRole = (account) => !account ? null : ownsFamily(account) ? 'owner' : activeMember(account) ? 'member' : null;
  const isPlus = (vaultId) => planRow(vaultId).plusUntil > clock();
  // Every new account starts with the trial (Eric, 2 Nov): someone who had Plus for two weeks knows what Free lacks.
  // A cloud that already used its trial or has Plus for longer keeps what it has.
  function startTrial(vaultId, length = TRIAL_TIME) {
    const until = clock() + length, plan = one('SELECT plusUntil,trialUsed FROM plans WHERE vaultId=?', vaultId);
    if (plan?.trialUsed) return plan.plusUntil;
    run('INSERT INTO plans(vaultId,plusUntil,trialUsed) VALUES(?,?,1) ON CONFLICT(vaultId) DO UPDATE SET plusUntil=MAX(plusUntil,excluded.plusUntil),trialUsed=1', vaultId, until);
    // Plus that already lasts longer (a manual grant) is no trial: no countdown, no mails.
    if ((plan?.plusUntil ?? 0) < until) run('INSERT INTO trials(vaultId,trialUntil) VALUES(?,?) ON CONFLICT(vaultId) DO UPDATE SET trialUntil=excluded.trialUntil,mail=0', vaultId, until);
    return Math.max(until, plan?.plusUntil ?? 0);
  }
  // The trial is what keeps Plus going only while nothing else lasts longer (a subscription, a family, a manual grant).
  const trialEnds = (plan) => plan.trialUntil > clock() && plan.plusUntil === plan.trialUntil ? plan.trialUntil : 0;
  // A supporter pays: a running subscription of their own, or a place in a family someone pays for. A trial or a grant is no support.
  const supporter = (vaultId, account) => subscribed(vaultId) || familyRole(account) !== null;
  // Early access: Plus has a new feature at once, everyone else from its `everyoneFrom` date.
  const featuresFor = (plus) => Object.fromEntries(earlyFeatures.map((feature) => [feature.id, plus || clock() >= Date.parse(feature.everyoneFrom)]));
  // Votes only count for ideas still on the list, so taking an idea off the list frees those votes.
  const roadmapIds = new Set(roadmap.map((item) => item.id));
  const myVotes = (accountId) => all('SELECT itemId FROM roadmap_votes WHERE accountId=? ORDER BY votedAt', accountId).map((row) => row.itemId).filter((id) => roadmapIds.has(id));
  function roadmapView(account, vaultId) {
    const counts = new Map(all('SELECT itemId,COUNT(*) AS votes FROM roadmap_votes GROUP BY itemId').map((row) => [row.itemId, row.votes]));
    const mine = new Set(myVotes(account.id));
    return { items: roadmap.map((item) => ({ ...item, votes: counts.get(item.id) ?? 0, mine: mine.has(item.id) })), canVote: isPlus(vaultId), maxVotes: MAX_VOTES, votesLeft: MAX_VOTES - mine.size };
  }
  const subscribed = (vaultId) => Boolean(one(`SELECT 1 FROM subscriptions WHERE vaultId=? AND status IN (${RUNNING.map(() => '?').join(',')})`, vaultId, ...RUNNING));
  const mailPending = (vaultId) => one('SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM mail_items WHERE vaultId=?', vaultId);
  /** Refusals happen at RCPT, so the sending server reports them and nothing is ever stored. */
  function mailRefusal(vaultId) {
    const pending = mailPending(vaultId);
    if (pending.count >= MAX_PENDING_ITEMS || pending.bytes >= MAX_PENDING_BYTES) return 'full';
    run('DELETE FROM mail_log WHERE receivedAt<=?', clock() - DAY);
    const recent = one('SELECT COUNT(*) AS day,COALESCE(SUM(receivedAt>?),0) AS hour FROM mail_log WHERE vaultId=?', clock() - 60 * 60 * 1000, vaultId);
    return recent.day >= MAILS_PER_DAY || recent.hour >= MAILS_PER_HOUR ? 'rate' : null;
  }
  function mailLookup({ addressHash, senderHash }) {
    const row = one('SELECT vaultId,publicKey,mode FROM mail_accounts WHERE addressHash=?', addressHash);
    if (!row) return { accept: false, code: 'unknown' };
    if (!isPlus(row.vaultId)) return { accept: false, code: 'no-plus' };
    if (row.mode === 'senders' && (!senderHash || !one('SELECT 1 FROM mail_senders WHERE vaultId=? AND senderHash=?', row.vaultId, senderHash))) return { accept: false, code: 'sender' };
    const refusal = mailRefusal(row.vaultId);
    return refusal ? { accept: false, code: refusal } : { accept: true, vaultId: row.vaultId, publicKey: row.publicKey };
  }
  function mailStatus(vaultId) {
    const row = one('SELECT publicKey,addressEnvelope,mode FROM mail_accounts WHERE vaultId=?', vaultId);
    const pending = mailPending(vaultId);
    return { domain: mailDomain ?? null, enabled: Boolean(row), publicKey: row?.publicKey ?? null, address: row?.addressEnvelope ?? null, mode: row?.mode ?? null, pending: pending.count, pendingBytes: pending.bytes };
  }
  // Abandoned payments do not use a founder place.
  const founderPrice = () => Boolean(stripe?.founderYearPrice) && one('SELECT COUNT(DISTINCT vaultId) AS count FROM subscriptions WHERE paidUntil>0').count < (stripe.founderLimit ?? 500);
  const stripeCall = (path, init = {}, timeout = 15000) => fetcher(`https://api.stripe.com/v1${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${stripe.secretKey}`, 'Stripe-Version': STRIPE_VERSION }, signal: AbortSignal.timeout(timeout) });
  // Stripe signs "<timestamp>.<body>" with the webhook secret; older events are refused, so a copied one cannot be replayed.
  function stripeEvent(raw, header) {
    const at = Number(/(?:^|,)t=(\d{1,12})(?:,|$)/.exec(header)?.[1]);
    const expected = createHmac('sha256', stripe.webhookSecret).update(`${at}.`).update(raw).digest('hex');
    if (!at || Math.abs(clock() / 1000 - at) > 300 || ![...header.matchAll(/(?:^|,)v1=([0-9a-f]{64})/g)].some((match) => equal(match[1], expected))) fail(400, 'Invalid Stripe signature');
    try { return JSON.parse(raw.toString('utf8')); } catch { fail(400, 'Invalid Stripe event'); }
  }
  function saveBilling(id, subscription) {
    const interval = subscription.items?.data?.[0]?.price?.recurring?.interval, currency = subscription.currency;
    run('INSERT INTO subscription_details VALUES(?,?,?) ON CONFLICT(subscriptionId) DO UPDATE SET interval=excluded.interval,currency=excluded.currency', id,
      ['month', 'year'].includes(interval) ? interval : null, typeof currency === 'string' && /^[a-z]{3}$/.test(currency) ? currency : null);
  }
  // Subscriptions from before the server kept billing details: ask Stripe once, a few per sweep.
  async function fillBilling() {
    if (!stripe) return;
    const missing = all(`SELECT subscriptionId FROM subscriptions s WHERE status IN (${RUNNING.map(() => '?').join(',')}) AND NOT EXISTS (SELECT 1 FROM subscription_details d WHERE d.subscriptionId=s.subscriptionId) LIMIT 20`, ...RUNNING);
    for (const { subscriptionId } of missing) {
      try {
        const response = await stripeCall(`/subscriptions/${subscriptionId}`, {}, 8000), subscription = response.ok ? await response.json() : undefined;
        if (closing) return;
        if (subscription?.id === subscriptionId && one('SELECT 1 FROM subscriptions WHERE subscriptionId=?', subscriptionId)) saveBilling(subscriptionId, subscription);
      } catch { /* Stays missing; the next sweep or event tries again. */ }
    }
  }
  // Events only say which subscription changed; its current state comes from Stripe, so delivery order does not matter.
  async function applySubscription(event) {
    const id = event?.data?.object?.id;
    if (!/^customer\.subscription\./.test(event?.type) || typeof id !== 'string' || !/^sub_\w{1,250}$/.test(id)) return;
    let subscription;
    try {
      // Within Stripe's wait for the webhook reply.
      const response = await stripeCall(`/subscriptions/${id}`, {}, 8000);
      // For example a test-mode key receiving a live event.
      if (response.status === 404) { console.error(`Stripe event ${event.id} ignored: subscription ${id} not found with this key.`); return; }
      subscription = await response.json();
      if (!response.ok || subscription?.id !== id) throw new Error('Stripe returned another subscription');
    } catch { fail(502, 'Could not read the subscription from Stripe. Stripe retries the event.'); }
    transaction(() => {
      const row = one('SELECT * FROM subscriptions WHERE subscriptionId=?', id), metadata = subscription.metadata ?? {};
      // The account follows the person: after starting over the cloud has a new id, while Stripe keeps the old one.
      const vaultId = row?.vaultId ?? ((validId(metadata.accountId) && one('SELECT vaultId FROM accounts WHERE id=?', metadata.accountId)?.vaultId) || metadata.vaultId);
      if (!validId(vaultId) || !one('SELECT 1 FROM vaults WHERE id=?', vaultId)) { console.error(`Stripe event ${event.id} ignored: no cloud for subscription ${id}.`); return; }
      // Stripe never reopens these; a slower, older read must not bring Plus back.
      if (FINAL.includes(row?.status)) return;
      const status = String(subscription.status), previous = row?.paidUntil ?? 0;
      const periodEnd = Number(subscription.items?.data?.[0]?.current_period_end ?? subscription.current_period_end) * 1000;
      const endedAt = Number.isSafeInteger(subscription.ended_at) ? subscription.ended_at * 1000 : clock();
      // Paid: until the period ends plus a day of grace for the renewal. Past due: no further. Ended: no later than the end.
      const paidUntil = PAID.includes(status) && Number.isSafeInteger(periodEnd) ? Math.max(previous, periodEnd + DAY) : status === 'past_due' ? previous : Math.min(previous, endedAt);
      run('INSERT INTO subscriptions VALUES(?,?,?,?) ON CONFLICT(subscriptionId) DO UPDATE SET status=excluded.status,paidUntil=excluded.paidUntil', id, vaultId, status, paidUntil);
      saveBilling(id, subscription);
      // The price says which plan was bought.
      if (familyPrices.includes(subscription.items?.data?.[0]?.price?.id)) {
        run('INSERT INTO family_subscriptions VALUES(?) ON CONFLICT DO NOTHING', id);
        // Paying for a family of your own ends a place in someone else's.
        if (PAID.includes(status)) run('DELETE FROM family_members WHERE accountId IN (SELECT id FROM accounts WHERE vaultId=?)', vaultId);
      }
      // Without family prices configured nothing is known: keep what was marked before.
      else if (familyPrices.length) run('DELETE FROM family_subscriptions WHERE subscriptionId=?', id);
    });
  }
  // The active devices of a free cloud at its device limit; empty when another device fits.
  function devicesAtLimit(vaultId) {
    const active = isPlus(vaultId) ? [] : all('SELECT id,name,lastSeenAt FROM devices WHERE vaultId=? AND revoked=0 ORDER BY lastSeenAt', vaultId);
    return active.length >= freeDeviceLimit ? active : [];
  }
  // A refusal that JotDrop Plus or the family plan lifts. The kind is counted for the dashboard and never sent.
  const planLimit = (kind, vaultId, status, message, extra = { code: 'plus-required' }) => { throw Object.assign(new Error(message), { status, extra, limit: { kind, vaultId } }); };
  const storageFull = (vaultId) => isPlus(vaultId) ? fail(507, 'Cloud storage is full. Your local files remain available.', { code: 'storage-full' }) : planLimit('storage', vaultId, 507, 'Cloud storage is full. Your local files remain available.', { code: 'storage-full' });
  const deviceLimitReached = (vaultId, devices) => planLimit('devices', vaultId, 403, `The free plan includes ${freeDeviceLimit} devices. Sign out one of them, or try JotDrop Plus.`, { code: 'device-limit', deviceLimit: freeDeviceLimit, devices });
  // Who already counted this week stays in memory only, so the database never links a limit to an account.
  let limitWeek = { start: 0, seen: new Set() };
  const weekStart = (time) => { const days = Math.floor(time / DAY); return (days - (days + 3) % 7) * DAY; };
  function noteLimit({ kind, vaultId }) {
    try {
      const start = weekStart(clock());
      if (limitWeek.start !== start) limitWeek = { start, seen: new Set() };
      const key = `${kind}:${vaultId}`, first = !limitWeek.seen.has(key) && limitWeek.seen.size < 100000;
      if (first) limitWeek.seen.add(key);
      run('INSERT INTO limit_hits VALUES(?,?,1,?) ON CONFLICT(kind,weekStart) DO UPDATE SET times=times+1,accounts=accounts+excluded.accounts', kind, start, first ? 1 : 0);
    } catch { /* A count must never turn a refusal into a server error. */ }
  }
  const dropDevicePieces = (deviceId) => run('DELETE FROM chunks WHERE deviceId=? AND claimed=0', deviceId);
  // A free cloud at its device limit can only swap a device, so someone who lost their phone can still sign in.
  function addDevice(vaultId, name, tokenHash, replaceDeviceId) {
    // Count revoked rows too: revocation must not bypass the local metadata ceiling.
    if (one('SELECT COUNT(*) AS count FROM devices WHERE vaultId=?', vaultId).count >= maxDeviceEntries) fail(507, 'Cloud device metadata safety limit reached. Existing devices and history were kept.');
    const active = devicesAtLimit(vaultId);
    if (active.length) {
      const replaced = active.find((device) => device.id === replaceDeviceId);
      if (!replaced) deviceLimitReached(vaultId, active);
      run('UPDATE devices SET revoked=1 WHERE id=?', replaced.id);
      run('DELETE FROM uploads WHERE vaultId=? AND deviceId=?', vaultId, replaced.id);
      dropDevicePieces(replaced.id);
    }
    const id = randomUUID(), now = new Date(clock()).toISOString();
    run('INSERT INTO devices(id,vaultId,name,tokenHash,createdAt,lastSeenAt) VALUES(?,?,?,?,?,?)', id, vaultId, name.trim(), tokenHash, now, now);
    return { vaultId, deviceId: id };
  }
  const requireAccounts = () => { if (!mailer || !serverKey) fail(503, 'Email sign-in is not available on this server'); };
  const codeFor = (email) => email === reviewLogin?.email ? reviewLogin.code : newCode();
  async function sendMail(mail) {
    if (mail.to === reviewLogin?.email) return;
    try { await mailer(mail); } catch { fail(503, 'Could not send the email. Try again later.'); }
  }
  // Used where waiting for the mail provider would reveal whether an address has an account.
  const sendMailLater = (mail) => { if (mail.to === reviewLogin?.email) return; Promise.resolve().then(() => mailer(mail)).catch((error) => console.error(`Mail delivery failed: ${error.message}`)); };
  // Persistent per account or address, so new codes, many IPs or a restart do not reset the guessing budget.
  const codesLocked = (scope) => (one('SELECT lockedUntil FROM code_failures WHERE scope=?', scope)?.lockedUntil ?? 0) > clock();
  // A wrong code commits its attempt before failing; a right code is consumed together with its action.
  function redeem(table, column, key, lockScope, matches, action) {
    const result = transaction(() => {
      const row = one(`SELECT * FROM ${table} WHERE ${column}=?`, key);
      if (!row || row.expiresAt <= clock() || row.attempts >= 5) return undefined;
      const scope = lockScope(row);
      if (codesLocked(scope)) return undefined;
      if (!matches(row)) {
        run(`UPDATE ${table} SET attempts=attempts+1 WHERE ${column}=?`, key);
        run('INSERT INTO code_failures VALUES(?,1,0) ON CONFLICT(scope) DO UPDATE SET count=count+1', scope);
        run('UPDATE code_failures SET count=0,lockedUntil=? WHERE scope=? AND count>=10', clock() + CODE_LOCK_TIME, scope);
        return undefined;
      }
      run(`DELETE FROM ${table} WHERE ${column}=?`, key);
      run('DELETE FROM code_failures WHERE scope=?', scope);
      return action(row);
    });
    if (result === undefined) fail(401, 'Invalid or expired code');
    return result;
  }
  const accountFor = (vaultId) => one('SELECT * FROM accounts WHERE vaultId=?', vaultId) ?? fail(404, 'No account for this cloud');
  // An account made with Google or GitHub has no password until "Forgot password" adds one.
  async function requirePassword(account, authKey) {
    if (!account.authHash) fail(409, 'This account signs in with Google or GitHub and has no password yet. Add one with "Forgot password" first.', { code: 'no-password' });
    requireValue(validToken(authKey), 'Invalid login key');
    if (!await checkAuthKey(authKey, account.authHash)) fail(401, 'Current password is incorrect');
  }
  const requireProvider = (name) => (Object.hasOwn(providers, name) ? providers[name] : fail(404, 'This sign-in method is not available on this server'));
  // Who the provider says signed in: a stable ID and an email address the provider has verified.
  async function providerIdentity(provider, code, redirectUri) {
    const call = async (url, init = {}) => {
      const response = await fetcher(url, { ...init, headers: { Accept: 'application/json', 'User-Agent': 'JotDrop Cloud', ...init.headers }, signal: AbortSignal.timeout(10000) });
      const result = await response.json().catch(() => undefined);
      if (!response.ok || !result) throw new Error(`${provider.name} did not answer`);
      return result;
    };
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: provider.clientId, client_secret: provider.clientSecret });
    const { access_token: accessToken } = await call(provider.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    if (typeof accessToken !== 'string' || !accessToken) throw new Error(`${provider.name} did not sign you in`);
    const auth = { headers: { Authorization: `Bearer ${accessToken}` } };
    if (provider === providers.google) {
      const user = await call(provider.api, auth);
      if (user.email_verified !== true) return { subject: String(user.sub), email: null };
      return { subject: String(user.sub), email: user.email };
    }
    const user = await call(`${provider.api}/user`, auth), emails = await call(`${provider.api}/user/emails`, auth);
    const primary = Array.isArray(emails) ? emails.find((entry) => entry.primary && entry.verified) : undefined;
    return { subject: String(user.id), email: primary?.email ?? null };
  }
  // Android's own account picker hands the app a token Google signed for this server, with the device's challenge as nonce.
  let googleCerts = { keys: [], fetchedAt: -Infinity };
  async function googleIdentity(idToken, challenge) {
    const provider = requireProvider('google'), refused = () => fail(401, 'Could not sign in with Google. Try again.');
    const parts = typeof idToken === 'string' && idToken.length <= 8192 ? idToken.split('.') : [];
    if (parts.length !== 3) refused();
    let header, claims;
    try { [header, claims] = parts.slice(0, 2).map((part) => JSON.parse(Buffer.from(part, 'base64url'))); } catch { refused(); }
    if (header?.alg !== 'RS256') refused();
    // Google rotates its keys: fetch them again for an unknown key, at most every five minutes.
    if (!googleCerts.keys.some((key) => key.kid === header.kid) && googleCerts.fetchedAt + 5 * 60 * 1000 <= clock()) {
      const response = await fetcher(provider.certs, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }).catch(() => undefined);
      const certs = await response?.json().catch(() => undefined);
      if (!response?.ok || !Array.isArray(certs?.keys)) fail(503, 'Google did not answer. Try again.');
      googleCerts = { keys: certs.keys, fetchedAt: clock() };
    }
    const key = googleCerts.keys.find((entry) => entry.kid === header.kid);
    let valid = false;
    try { valid = Boolean(key) && verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url')); } catch { valid = false; }
    if (!valid || !provider.issuers.includes(claims?.iss) || claims.aud !== provider.clientId || !(claims.exp * 1000 > clock()) || claims.nonce !== challenge) refused();
    return { subject: String(claims.sub ?? ''), email: claims.email_verified === true ? claims.email : null };
  }
  // The provider's verified address as JotDrop stores it, or null.
  function verifiedEmail(identity) {
    let email = null;
    try { email = identity.email && emailValue(identity.email); } catch { email = null; }
    return email && identity.subject && identity.subject.length <= 200 ? email : null;
  }
  // Ten minutes to finish signing in, only with the verifier behind `challenge`.
  function newTicket(provider, subject, email, challenge) {
    const ticket = randomBytes(32).toString('base64url');
    transaction(() => {
      run('DELETE FROM oauth_tickets WHERE expiresAt<=?', clock());
      run('INSERT INTO oauth_tickets VALUES(?,?,?,?,?,?)', hash(ticket), provider, subject, email, challenge, clock() + OAUTH_LIFETIME);
    });
    return ticket;
  }
  function oauthTicket(value) {
    requireValue(validToken(value.ticket) && validToken(value.verifier), 'Invalid sign-in');
    const ticket = one('SELECT * FROM oauth_tickets WHERE id=?', hash(value.ticket));
    if (!ticket || ticket.expiresAt <= clock() || !equal(hash(value.verifier), ticket.challenge)) fail(401, 'This sign-in has expired. Start again.');
    return ticket;
  }
  // The account a provider sign-in belongs to: the linked one, or the account with the same verified address.
  const oauthAccount = (ticket) => one('SELECT a.* FROM identities i JOIN accounts a ON a.id=i.accountId WHERE i.provider=? AND i.subject=?', ticket.provider, ticket.subject) ?? one('SELECT * FROM accounts WHERE email=?', ticket.email);
  function linkIdentity(ticket, account) {
    if (one('SELECT 1 FROM identities WHERE provider=? AND subject=?', ticket.provider, ticket.subject)) return;
    run('INSERT INTO identities VALUES(?,?,?,?)', ticket.provider, ticket.subject, account.id, new Date(clock()).toISOString());
    sendMailLater({ to: account.email, kind: 'provider-linked', provider: providers[ticket.provider].name });
  }
  const totpAad = (accountId) => Buffer.from(`jotdrop:totp:v1:${accountId}`);
  function sealTotp(secret, accountId) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', totpKey, iv).setAAD(totpAad(accountId));
    return Buffer.concat([iv, cipher.update(secret), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  }
  function openTotp(sealed, accountId) {
    const bytes = Buffer.from(sealed, 'base64url'), decipher = createDecipheriv('aes-256-gcm', totpKey, bytes.subarray(0, 12)).setAAD(totpAad(accountId));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
  }
  // Accepts one step of clock drift either way; a step is never accepted twice.
  function totpStep(account, sealed, code) {
    if (!sealed || !validCode(code)) return 0;
    const secret = openTotp(sealed, account.id), now = Math.floor(clock() / 30000);
    return [now - 1, now, now + 1].find((step) => step > account.totpLastStep && equal(totpCode(secret, step), code)) ?? 0;
  }
  async function newDeviceCredentials(value) {
    deviceName(value.deviceName);
    requireValue(validHash(value.deviceTokenHash), 'Invalid token hash');
    return credentialValue(value);
  }
  function setCredentials(accountId, next) {
    run('UPDATE accounts SET kdf=?,authHash=?,wrappedVaultKey=?,passwordChangedAt=?,failedLogins=0,lockedUntil=0 WHERE id=?', next.kdf, next.authHash, next.wrappedVaultKey, new Date(clock()).toISOString(), accountId);
    run('DELETE FROM login_challenges WHERE accountId=?', accountId);
  }
  // A taken address gets a warning mail instead of a code; the caller sees the same answer either way.
  // Each signup has its own ID, so a later signup for the same address cannot replace a pending one.
  // The tick and its time stay here as the record of consent; the address goes to the list only after the account exists.
  function joinNewsletter(accountId, email, now) {
    run('INSERT INTO newsletter VALUES(?,?,NULL)', accountId, now);
    return { accountId, email };
  }
  // A mailing-list failure never blocks signing up; `addedAt` stays empty, so it can be sent again later.
  function subscribe(joined) {
    if (!joined || !newsletter) return;
    void Promise.resolve().then(() => newsletter(joined.email))
      .then(() => { run('UPDATE newsletter SET addedAt=? WHERE accountId=?', new Date(clock()).toISOString(), joined.accountId); })
      .catch((error) => console.warn(`Could not add a new account to the mailing list: ${error.message}`));
  }
  async function startSignup(email, signup) {
    const code = codeFor(email), now = clock(), signupId = randomUUID();
    const taken = transaction(() => {
      run('DELETE FROM signups WHERE expiresAt<=?', now);
      if (signup.vaultId && one('SELECT id FROM accounts WHERE vaultId=?', signup.vaultId)) fail(409, 'This cloud already has an account');
      if (one('SELECT id FROM accounts WHERE email=?', email)) return true;
      run('INSERT INTO signups VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?)', signupId, email, signup.vaultId, signup.kdf, signup.authHash, signup.wrappedVaultKey, signup.recoveryHash, signup.deviceName, signup.deviceTokenHash, codeHash(`signup:${signupId}`, code), now + CODE_LIFETIME, signup.newsletter ? 1 : 0);
      return false;
    });
    await sendMail(taken ? { to: email, kind: 'signup-exists' } : { to: email, kind: 'verify', code });
    return signupId;
  }
  const revisionQuery = 'SELECT r.*,e.envelope FROM revisions r JOIN envelopes e USING(vaultId,id,envelopeHash)';
  const latest = (vaultId, id) => one(`${revisionQuery} WHERE vaultId=? AND id=? ORDER BY revision DESC LIMIT 1`, vaultId, id);
  // Set when `revision` is the content-free tombstone that "Delete forever" left of a note.
  const purgedRevision = (vaultId, id, revision) => one('SELECT revision FROM purges WHERE vaultId=? AND id=? AND revision=?', vaultId, id, revision)?.revision;
  // ponytail: indexed row counts per mutation; use persisted counters if throughput requires it.
  const historyUsage = (vaultId) => ({ ...one('SELECT (SELECT COUNT(*) FROM revisions WHERE vaultId=?) AS revisionCount, (SELECT COUNT(*) FROM changes WHERE vaultId=?) AS changeCount', vaultId, vaultId), maxEntries: maxHistoryEntries });
  const memberOf = (spaceId, deviceVaultId) => one('SELECT 1 FROM space_members m JOIN accounts a ON a.id=m.accountId WHERE m.spaceId=? AND a.vaultId=?', spaceId, deviceVaultId);
  // Inside each write's transaction, so a device revoked or a member removed a moment ago cannot finish an upload.
  function requireAccess(vaultId, deviceId) {
    const device = one('SELECT vaultId,revoked FROM devices WHERE id=?', deviceId);
    if (device?.revoked !== 0 || device.vaultId !== vaultId && !memberOf(vaultId, device.vaultId)) fail(401, 'Device access denied');
  }
  // A piece that no saved version uses after a day was an upload that never finished.
  const pruneUploads = (vaultId) => {
    run('DELETE FROM uploads WHERE vaultId=? AND expiresAt<=?', vaultId, clock());
    run('DELETE FROM chunks WHERE vaultId=? AND claimed=0 AND createdAt<=?', vaultId, clock() - TRANSFER_LIFETIME);
    run('DELETE FROM retired_envelopes WHERE vaultId=? AND retiredAt<=?', vaultId, clock() - RETIRED_LIFETIME);
  };
  // Pieces of versions that were cleared: nothing reads them any more.
  const dropUnusedPieces = (vaultId) => run('DELETE FROM chunks WHERE vaultId=? AND claimed=1 AND NOT EXISTS (SELECT 1 FROM envelope_chunks ec WHERE ec.vaultId=chunks.vaultId AND ec.name=chunks.name)', vaultId);
  // Each piece counts once, however many versions use it.
  const storageUsage = (vaultId) => one('SELECT (SELECT COALESCE(SUM(size),0) FROM envelopes WHERE vaultId=?) + (SELECT COALESCE(SUM(size),0) FROM chunks WHERE vaultId=?) + (SELECT COALESCE(SUM(reservedBytes),0) FROM uploads WHERE vaultId=?) AS used', vaultId, vaultId, vaultId).used;
  const quotaFor = (vaultId) => isPlus(vaultId) ? plusQuotaBytes : quotaBytes;
  const maxFileFor = (vaultId) => isPlus(vaultId) ? plusMaxFileBytes : maxFileBytes;
  // ponytail: sums each owned space per write (100 at most); keep per-account counters if this shows up.
  const spaceBytes = (accountId, except) => all('SELECT id FROM spaces WHERE ownerAccountId=? AND ownerGoneAt IS NULL', accountId).reduce((sum, space) => space.id === except ? sum : sum + storageUsage(space.id), 0);
  // A replaced space holds the same notes as its replacement and goes within 30 days: it does not hold up the owner's own notes.
  // It does count between spaces (roomForSpaces), and only the direct predecessor is left out there, so chains gain no room.
  const liveSpaceBytes = (accountId) => all('SELECT id FROM spaces WHERE ownerAccountId=? AND ownerGoneAt IS NULL AND replacedBy IS NULL', accountId).reduce((sum, space) => sum + storageUsage(space.id), 0);
  // An owner's quota covers their own cloud and their spaces together, and the spaces get half of it at most, so members
  // can never fill up the owner's own notes. A new space does not compete with the one it replaces.
  const roomForSpaces = (owner, except) => {
    const quota = quotaFor(owner.vaultId), inSpaces = spaceBytes(owner.id, except);
    return Math.min(quota - storageUsage(owner.vaultId) - inSpaces, Math.floor(quota / 2) - inSpaces);
  };
  function roomIn(vaultId) {
    const space = spaceRow(vaultId);
    if (space) {
      const owner = !space.ownerGoneAt && one('SELECT id,vaultId FROM accounts WHERE id=?', space.ownerAccountId);
      return owner ? roomForSpaces(owner, space.replaces) : quotaFor(vaultId) - storageUsage(vaultId);
    }
    const owner = one('SELECT id FROM accounts WHERE vaultId=?', vaultId);
    return quotaFor(vaultId) - storageUsage(vaultId) - (owner ? liveSpaceBytes(owner.id) : 0);
  }
  const pieceBytes = (vaultId, id, envelopeHash) => one('SELECT COALESCE(SUM(c.size),0) AS size FROM envelope_chunks ec JOIN chunks c ON c.vaultId=ec.vaultId AND c.name=ec.name WHERE ec.vaultId=? AND ec.id=? AND ec.envelopeHash=?', vaultId, id, envelopeHash).size;
  // Free clouds keep older versions, but only Plus opens one that was replaced before this moment.
  function lockedBefore(vaultId) {
    const now = clock();
    return planRow(vaultId).plusUntil + PLUS_GRACE > now ? undefined : new Date(now - FREE_HISTORY).toISOString();
  }
  // A version is replaced when the next one is saved. After eviction the next remaining version still predates
  // the cutoff, because the cutoff only moves forward.
  const lockedVersions = 'FROM revisions r WHERE r.vaultId=? AND (SELECT n.updatedAt FROM revisions n WHERE n.vaultId=r.vaultId AND n.id=r.id AND n.revision>r.revision ORDER BY n.revision LIMIT 1)<?';
  // A note deleted before the cutoff and still in the trash is locked as a whole. The tombstone of a note deleted
  // forever holds nothing and stays, so devices that were away still see the note as deleted.
  const trashedNotes = 'FROM revisions r WHERE r.vaultId=? AND r.deleted=1 AND r.updatedAt<? AND r.revision=(SELECT MAX(m.revision) FROM revisions m WHERE m.vaultId=r.vaultId AND m.id=r.id) AND NOT EXISTS (SELECT 1 FROM purges p WHERE p.vaultId=r.vaultId AND p.id=r.id AND p.revision=r.revision)';
  function requireOpenVersion(vaultId, id, revision) {
    const cutoff = lockedBefore(vaultId);
    if (!cutoff) return;
    if (one(`SELECT 1 ${trashedNotes} AND r.id=?`, vaultId, cutoff, id)) planLimit('old-trash', vaultId, 402, 'This note was deleted more than 30 days ago. JotDrop Plus restores it.');
    if (one(`SELECT 1 ${lockedVersions} AND r.id=? AND r.revision=?`, vaultId, cutoff, id, revision)) planLimit('old-version', vaultId, 402, 'This version is older than 30 days. JotDrop Plus restores it.');
  }
  // A full free cloud makes room by deleting, oldest first, notes locked in the trash and then locked versions;
  // the current version of a file always stays. A cleared note is announced in the change feed and then reads as 404.
  // One scan for candidates; nothing is deleted when even all of them would not make enough room.
  // ponytail: scans the vault's revision rows per full upload; keep a per-vault locked-bytes counter if large vaults make this slow.
  // `id` is the file being written; it is never cleared to make room for itself.
  function fits(vaultId, extra, deviceId, id) {
    let shortfall = extra - roomIn(vaultId);
    if (shortfall <= 0) return true;
    const cutoff = lockedBefore(vaultId);
    if (!cutoff) return false;
    const trashed = all(`SELECT r.id,r.revision,(SELECT COALESCE(SUM(e.size),0) FROM envelopes e WHERE e.vaultId=r.vaultId AND e.id=r.id) + (SELECT COALESCE(SUM(c.size),0) FROM chunks c WHERE c.vaultId=r.vaultId AND c.name IN (SELECT ec.name FROM envelope_chunks ec WHERE ec.vaultId=r.vaultId AND ec.id=r.id)) AS size ${trashedNotes} AND r.id<>? ORDER BY r.updatedAt`, vaultId, cutoff, id);
    const cleared = new Set(trashed.map((note) => note.id));
    // Group by envelope, oldest first; an envelope a newer open version still uses (a restore) is never freed.
    const groups = new Map();
    for (const entry of all(`SELECT r.id,r.revision,r.envelopeHash,r.size ${lockedVersions} ORDER BY r.updatedAt,r.revision`, vaultId, cutoff)) {
      // A tombstone of a note deleted forever frees nothing worth having and keeps the note reading as deleted.
      if (cleared.has(entry.id) || purgedRevision(vaultId, entry.id, entry.revision)) continue;
      const key = `${entry.id}:${entry.envelopeHash}`;
      if (!groups.has(key)) groups.set(key, { ...entry, revisions: [] });
      groups.get(key).revisions.push(entry.revision);
    }
    const freeable = [...groups.values()].filter((group) => one('SELECT COUNT(*) AS count FROM revisions WHERE vaultId=? AND id=? AND envelopeHash=?', vaultId, group.id, group.envelopeHash).count === group.revisions.length);
    if ([...trashed, ...freeable].reduce((sum, entry) => sum + entry.size, 0) < shortfall) return false;
    const now = new Date(clock()).toISOString();
    // A piece shared with a version that stays is not freed, so the real usage decides when there is room.
    const roomMade = () => { dropUnusedPieces(vaultId); return extra <= roomIn(vaultId); };
    for (const note of trashed) {
      run('DELETE FROM revisions WHERE vaultId=? AND id=?', vaultId, note.id);
      run('DELETE FROM envelopes WHERE vaultId=? AND id=?', vaultId, note.id);
      run('DELETE FROM envelope_chunks WHERE vaultId=? AND id=?', vaultId, note.id);
      run('INSERT INTO changes(vaultId,id,revision,deleted,size,updatedAt,deviceId) VALUES(?,?,?,1,0,?,?)', vaultId, note.id, note.revision, now, deviceId);
      if (roomMade()) return true;
    }
    for (const group of freeable) {
      for (const revision of group.revisions) run('DELETE FROM revisions WHERE vaultId=? AND id=? AND revision=?', vaultId, group.id, revision);
      run('DELETE FROM envelopes WHERE vaultId=? AND id=? AND envelopeHash=?', vaultId, group.id, group.envelopeHash);
      run('DELETE FROM envelope_chunks WHERE vaultId=? AND id=? AND envelopeHash=?', vaultId, group.id, group.envelopeHash);
      if (roomMade()) return true;
    }
    return roomMade();
  }
  // Members write only while a space is alive and fits the owner's storage; a space that no longer fits is read-only for everyone.
  function requireWritable(vaultId, deviceId, id) {
    const space = spaceRow(vaultId);
    if (!space) return;
    if (space.frozenAt) fail(403, 'This shared space is read-only.', { code: 'space-frozen' });
    if (!fits(vaultId, 0, deviceId, id)) storageFull(vaultId);
  }
  /** `pieces`: for a v2 save, the names of its encrypted pieces, already uploaded (none for a small file); a stored envelope keeps its own. */
  function append(vaultId, deviceId, id, baseRevision, envelope, deleted, pieces = null) {
    return transaction(() => {
      requireAccess(vaultId, deviceId);
      pruneUploads(vaultId);
      const current = latest(vaultId, id);
      // A v2 save is idempotent like a resumable upload: immutable history is the receipt when the answer was lost,
      // even when newer versions exist.
      const receipt = pieces && one('SELECT r.revision,c.sequence FROM revisions r JOIN changes c USING(vaultId,id,revision) WHERE r.vaultId=? AND r.deviceId=? AND r.id=? AND r.revision=? AND r.envelopeHash=? ORDER BY c.sequence LIMIT 1', vaultId, deviceId, id, baseRevision + 1, hash(envelope));
      if (receipt) return { id, ...receipt };
      requireWritable(vaultId, deviceId, id);
      if ((current?.revision || 0) !== baseRevision) fail(409, 'Another version was saved. Review both versions.', { currentRevision: current?.revision || 0 });
      if (deleted) { if (!current) fail(404, 'File not found'); envelope = current.envelope; }
      let size = envelopeSize(envelope);
      const envelopeHash = hash(envelope);
      const stored = one('SELECT envelope FROM envelopes WHERE vaultId=? AND id=? AND envelopeHash=?', vaultId, id, envelopeHash);
      if (stored && stored.envelope !== envelope) throw new Error('Cloud envelope hash mismatch.');
      const history = historyUsage(vaultId);
      if (history.revisionCount >= maxHistoryEntries || history.changeCount >= maxHistoryEntries) fail(507, 'Cloud history safety limit reached. Existing versions remain readable; no history was deleted.');
      if (!stored) {
        let total = 0;
        for (const name of pieces ?? []) {
          const piece = one('SELECT size FROM chunks WHERE vaultId=? AND name=?', vaultId, name);
          if (!piece) fail(409, 'An encrypted piece is missing. Upload it again.');
          total += piece.size;
        }
        if (pieces && total - 28 * pieces.length > maxFileFor(vaultId)) {
          const message = `Files can be at most ${Math.round(maxFileFor(vaultId) / 1048576)} MB on your plan.`;
          if (isPlus(vaultId)) fail(413, message, { code: 'file-too-large' });
          planLimit('file-size', vaultId, 413, message);
        }
        if (!fits(vaultId, size, deviceId, id)) storageFull(vaultId);
        run('INSERT INTO envelopes(vaultId,id,envelopeHash,envelope,size,pieces) VALUES(?,?,?,?,?,?)', vaultId, id, envelopeHash, envelope, size, pieces ? 1 : 0);
        for (const name of new Set(pieces ?? [])) {
          run('INSERT INTO envelope_chunks VALUES(?,?,?,?)', vaultId, id, envelopeHash, name);
          run('UPDATE chunks SET claimed=1,deviceId=NULL WHERE vaultId=? AND name=?', vaultId, name);
        }
      }
      // A version's size is its real size: the manifest plus its pieces.
      size += pieceBytes(vaultId, id, envelopeHash);
      const revision = baseRevision + 1, now = new Date(clock()).toISOString();
      // The local history ceiling bounds rows, not physical SQLite/WAL bytes or other metadata.
      run('INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?)', vaultId, id, revision, envelopeHash, deleted ? 1 : 0, size, now, deviceId);
      const sequence = Number(run('INSERT INTO changes(vaultId,id,revision,deleted,size,updatedAt,deviceId) VALUES(?,?,?,?,?,?,?)', vaultId, id, revision, deleted ? 1 : 0, size, now, deviceId).lastInsertRowid);
      return { id, revision, sequence };
    });
  }
  /**
   * "Delete forever" from the trash, in your own cloud only. Every version, envelope, piece and change of the note
   * goes; what stays is one deleted version whose envelope the device made without content (path only) and one change
   * that says so. An upload another device has not finished stays until it expires: it can only end as a conflict. Devices that were away therefore read the note as deleted, like any trashed note,
   * instead of finding it gone, and an old copy cannot come back unnoticed: an edit from before is a conflict.
   * A note not deleted yet (one in notes/Trash/) is deleted and purged in the same step. The server cannot read
   * the envelope, so `baseRevision` must be the version the device showed.
   */
  function purge(vaultId, deviceId, id, baseRevision, envelope) {
    return transaction(() => {
      requireAccess(vaultId, deviceId);
      // Shared spaces never reach this (SPACE_ROUTES); their notes belong to everyone in them.
      if (spaceRow(vaultId)) fail(403, 'This is not available in a shared space.');
      const current = latest(vaultId, id);
      if (!current) fail(404, 'File not found');
      // Already gone (an answer that was lost, or another device was first): nothing is left to remove.
      if (purgedRevision(vaultId, id, current.revision)) return { id, revision: current.revision, sequence: one('SELECT MAX(sequence) AS sequence FROM changes WHERE vaultId=? AND id=?', vaultId, id).sequence, purged: true };
      if (current.revision !== baseRevision) fail(409, 'Another version was saved. Review it before deleting the note forever.', { currentRevision: current.revision });
      const size = envelopeSize(envelope, 8192), envelopeHash = hash(envelope);
      if (one('SELECT 1 FROM envelopes WHERE vaultId=? AND id=? AND envelopeHash=?', vaultId, id, envelopeHash)) fail(400, 'Invalid tombstone');
      for (const table of ['revisions', 'envelope_chunks', 'retired_envelopes', 'envelopes', 'changes']) run(`DELETE FROM ${table} WHERE vaultId=? AND id=?`, vaultId, id);
      dropUnusedPieces(vaultId);
      const revision = baseRevision + 1, now = new Date(clock()).toISOString();
      run('INSERT INTO envelopes(vaultId,id,envelopeHash,envelope,size,pieces) VALUES(?,?,?,?,?,1)', vaultId, id, envelopeHash, envelope, size);
      run('INSERT INTO revisions VALUES(?,?,?,?,1,?,?,?)', vaultId, id, revision, envelopeHash, size, now, deviceId);
      run('INSERT INTO purges VALUES(?,?,?,?) ON CONFLICT(vaultId,id) DO UPDATE SET revision=excluded.revision,purgedAt=excluded.purgedAt', vaultId, id, revision, clock());
      const sequence = Number(run('INSERT INTO changes(vaultId,id,revision,deleted,size,updatedAt,deviceId) VALUES(?,?,?,1,?,?,?)', vaultId, id, revision, size, now, deviceId).lastInsertRowid);
      return { id, revision, sequence, purged: true };
    });
  }
  // The owner's dashboard. Sessions live only in memory, keyed by the token's hash; a restart signs the owner out.
  const adminSessions = new Map();
  let adminFailures = 0, adminLockedUntil = 0;
  const adminCookie = (req) => (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${ADMIN_COOKIE}=`))?.slice(ADMIN_COOKIE.length + 1);
  const adminExpired = (session, now) => session.createdAt + ADMIN_SESSION_TIME <= now || session.seenAt + ADMIN_IDLE_TIME <= now;
  function adminSession(req) {
    const token = adminCookie(req), key = validToken(token) ? hash(token) : undefined, session = key && adminSessions.get(key), now = clock();
    if (!session || adminExpired(session, now)) { if (key) adminSessions.delete(key); fail(401, 'Sign in again.'); }
    session.seenAt = now;
  }
  // Password and code are both always checked and every wrong answer is the same. After 10 wrong answers nobody gets in for 15 minutes.
  async function adminLogin(value) {
    if (adminLockedUntil > clock()) fail(429, 'Too many attempts. Try again later.');
    const password = typeof value.password === 'string' && value.password.length <= 1024 ? value.password : '';
    const digest = (await hashAdminPassword(password, adminHashed.settings, adminHashed.salt)).split(':')[3];
    // No await from here on, so two requests with the same code cannot both pass.
    const now = clock(), current = Math.floor(now / 30000), lastStep = Number(one("SELECT value FROM secrets WHERE name='admin-totp-step'")?.value ?? 0);
    if (adminLockedUntil > now) fail(429, 'Too many attempts. Try again later.');
    const step = validCode(value.code) ? [current - 1, current, current + 1].find((candidate) => candidate > lastStep && equal(totpCode(adminSecret, candidate), value.code)) ?? 0 : 0;
    if (!equal(digest, adminHashed.digest) || !step) {
      if (++adminFailures >= 10) { adminFailures = 0; adminLockedUntil = now + LOCK_TIME; }
      fail(401, 'Invalid password or code.');
    }
    // Kept in the database, so a used code stays used after a restart.
    run("INSERT INTO secrets VALUES('admin-totp-step',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value", String(step));
    adminFailures = 0;
    for (const [key, session] of adminSessions) if (adminExpired(session, now)) adminSessions.delete(key);
    if (adminSessions.size >= 16) adminSessions.delete(adminSessions.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    adminSessions.set(hash(token), { createdAt: now, seenAt: now });
    return token;
  }
  // Plus as planRow works it out, for each account in one query.
  const plusUntilSql = '(MAX(COALESCE((SELECT plusUntil FROM plans WHERE vaultId=a.vaultId),0),(SELECT COALESCE(MAX(paidUntil),0) FROM subscriptions WHERE vaultId=a.vaultId),' +
    '(SELECT COALESCE(MAX(s.paidUntil),0) FROM family_members m JOIN accounts o ON o.id=m.ownerAccountId JOIN subscriptions s ON s.vaultId=o.vaultId JOIN family_subscriptions f ON f.subscriptionId=s.subscriptionId WHERE m.accountId=a.id)))';
  const runningSql = `(SELECT 1 FROM subscriptions WHERE vaultId=a.vaultId AND status IN (${RUNNING.map(() => '?').join(',')}))`;
  // An account's own cloud and the spaces it owns.
  const usedBytesSql = '((SELECT COALESCE(SUM(size),0) FROM envelopes WHERE vaultId IN (SELECT a.vaultId UNION ALL SELECT id FROM spaces WHERE ownerAccountId=a.id AND ownerGoneAt IS NULL))+(SELECT COALESCE(SUM(size),0) FROM chunks WHERE vaultId IN (SELECT a.vaultId UNION ALL SELECT id FROM spaces WHERE ownerAccountId=a.id AND ownerGoneAt IS NULL)))';
  // Counts and sizes only: never note content, envelopes, keys, hashes, tokens or authenticator secrets.
  function adminSummary() {
    const now = clock(), since = (days) => new Date(now - days * DAY).toISOString();
    const accounts = one(`SELECT COUNT(*) AS total,COALESCE(SUM(createdAt>=?),0) AS newLast7Days,COALESCE(SUM(createdAt>=?),0) AS newLast30Days,COALESCE(SUM(${plusUntilSql}>?),0) AS plus,COALESCE(SUM(EXISTS${runningSql}),0) AS paying FROM accounts a`, since(7), since(30), now, ...RUNNING);
    const disk = statfsSync(dataDir), file = (name) => statSync(join(dataDir, name), { throwIfNoEntry: false })?.size ?? 0;
    // The sign-up trial: how many run now, and how many clouds that had one pay now or paid before.
    const trials = one('SELECT COUNT(*) AS total,COALESCE(SUM(trialUntil>?),0) AS running,COALESCE(SUM(EXISTS(SELECT 1 FROM subscriptions s WHERE s.vaultId=t.vaultId AND s.paidUntil>0)),0) AS paidAfter FROM trials t', now);
    const votes = new Map(all('SELECT itemId,COUNT(*) AS votes FROM roadmap_votes GROUP BY itemId').map((row) => [row.itemId, row.votes]));
    // Trials that end within a week, with what the cloud holds and does, to see who is likely to pay.
    const trialsEnding = all(`SELECT a.email,t.trialUntil,${usedBytesSql} AS usedBytes,(SELECT COUNT(*) FROM devices WHERE vaultId=a.vaultId AND revoked=0) AS activeDevices,
      (SELECT MAX(lastSeenAt) FROM devices WHERE vaultId=a.vaultId) AS lastActiveAt,EXISTS${runningSql} AS subscribed
      FROM trials t JOIN accounts a ON a.vaultId=t.vaultId WHERE t.trialUntil>? AND t.trialUntil<=? ORDER BY t.trialUntil,a.email LIMIT ?`, ...RUNNING, now, now + 7 * DAY, ADMIN_PAGE)
      .map((row) => ({ email: row.email, trialUntil: new Date(row.trialUntil).toISOString(), usedBytes: row.usedBytes, activeDevices: row.activeDevices, lastActiveAt: row.lastActiveAt ?? null, subscribed: Boolean(row.subscribed) }));
    // The plan limits free accounts ran into, this week and the three before, newest first.
    const weeks = [0, 1, 2, 3].map((back) => weekStart(now) - back * 7 * DAY), hits = all('SELECT kind,weekStart,times,accounts FROM limit_hits WHERE weekStart>=?', weeks[3]);
    const limits = { weeks: weeks.map((start) => new Date(start).toISOString()), kinds: [...new Set(hits.map((hit) => hit.kind))].sort().map((kind) => ({ kind,
      perWeek: weeks.map((start) => { const hit = hits.find((row) => row.kind === kind && row.weekStart === start); return { times: hit?.times ?? 0, accounts: hit?.accounts ?? 0 }; }) })) };
    // Running subscriptions by plan, billing interval and currency; null where Stripe has not told the server yet.
    const running = RUNNING.map(() => '?').join(',');
    const subscriptions = all(`SELECT EXISTS(SELECT 1 FROM family_subscriptions f WHERE f.subscriptionId=s.subscriptionId) AS family,d.interval,d.currency,COUNT(*) AS count,COALESCE(SUM(s.status='past_due'),0) AS pastDue
      FROM subscriptions s LEFT JOIN subscription_details d ON d.subscriptionId=s.subscriptionId WHERE s.status IN (${running}) GROUP BY 1,2,3 ORDER BY 1,2,3`, ...RUNNING)
      .map((row) => ({ plan: row.family ? 'family' : 'plus', interval: row.interval ?? null, currency: row.currency ?? null, count: row.count, pastDue: row.pastDue }));
    const family = one(`SELECT COUNT(DISTINCT s.vaultId) AS plans,(SELECT COUNT(*) FROM family_members m JOIN accounts o ON o.id=m.ownerAccountId WHERE o.vaultId IN
      (SELECT s2.vaultId FROM subscriptions s2 JOIN family_subscriptions f2 ON f2.subscriptionId=s2.subscriptionId WHERE s2.status IN (${running}))) AS members
      FROM subscriptions s JOIN family_subscriptions f ON f.subscriptionId=s.subscriptionId WHERE s.status IN (${running})`, ...RUNNING, ...RUNNING);
    return { generatedAt: new Date(now).toISOString(), accounts: { ...accounts, free: accounts.total - accounts.plus }, trials, trialsEnding, limits, subscriptions, family,
      roadmap: roadmap.map((item) => ({ title: item.title, votes: votes.get(item.id) ?? 0 })),
      storage: { storedBytes: one('SELECT (SELECT COALESCE(SUM(size),0) FROM envelopes) + (SELECT COALESCE(SUM(size),0) FROM chunks) AS size').size, databaseBytes: file('cloud.db') + file('cloud.db-wal'), diskFreeBytes: disk.bavail * disk.bsize, diskTotalBytes: disk.blocks * disk.bsize } };
  }
  const ADMIN_SORT = { created: 'a.createdAt', email: 'a.email', storage: 'usedBytes', active: 'lastActiveAt' };
  function adminAccounts(params) {
    const search = (params.get('q') ?? '').trim().toLowerCase(), sort = params.get('sort') ?? 'created', order = params.get('order') ?? (sort === 'email' ? 'asc' : 'desc');
    const page = Number(params.get('page') ?? 1), pageSize = Number(params.get('limit') ?? ADMIN_PAGE);
    requireValue(search.length <= 254 && Object.hasOwn(ADMIN_SORT, sort) && ['asc', 'desc'].includes(order) && Number.isSafeInteger(page) && page >= 1 && Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= ADMIN_PAGE, 'Invalid account list request');
    const now = clock();
    // ponytail: sums the storage of every matching account per page; keep per-vault counters if the account list grows large.
    const rows = all(`SELECT a.email,a.createdAt,a.authHash<>'' AS hasPassword,a.totpSecret IS NOT NULL AS hasAuthenticator,(SELECT group_concat(provider,',') FROM (SELECT provider FROM identities WHERE accountId=a.id ORDER BY provider)) AS providers,
      ${plusUntilSql} AS plusUntil,EXISTS${runningSql} AS subscribed,${usedBytesSql} AS usedBytes,(SELECT COUNT(*) FROM spaces WHERE ownerAccountId=a.id AND ownerGoneAt IS NULL) AS spaces,(SELECT COUNT(*) FROM devices WHERE vaultId=a.vaultId AND revoked=0) AS activeDevices,
      (SELECT MAX(lastSeenAt) FROM devices WHERE vaultId=a.vaultId) AS lastActiveAt,EXISTS(SELECT 1 FROM newsletter WHERE accountId=a.id) AS newsletter
      FROM accounts a WHERE instr(a.email,?)>0 ORDER BY ${ADMIN_SORT[sort]} ${order} NULLS LAST,a.email LIMIT ? OFFSET ?`, ...RUNNING, search, pageSize, (page - 1) * pageSize);
    return { accounts: rows.map((row) => {
      const plus = row.plusUntil > now;
      return { email: row.email, createdAt: row.createdAt, hasPassword: Boolean(row.hasPassword), hasAuthenticator: Boolean(row.hasAuthenticator), providers: row.providers ? row.providers.split(',') : [], plan: plus ? 'plus' : 'free',
        plusUntil: row.plusUntil ? new Date(row.plusUntil).toISOString() : null, subscribed: Boolean(row.subscribed), usedBytes: row.usedBytes, quotaBytes: plus ? plusQuotaBytes : quotaBytes, spaces: row.spaces, activeDevices: row.activeDevices, lastActiveAt: row.lastActiveAt ?? null, newsletter: Boolean(row.newsletter) };
    }), total: one('SELECT COUNT(*) AS count FROM accounts WHERE instr(email,?)>0', search).count, page, pageSize };
  }
  const adminAssets = new Map([['/', [join(adminRoot, 'index.html'), 'text/html']], ['/admin.js', [join(adminRoot, 'admin.js'), 'text/javascript']], ['/admin.css', [join(adminRoot, 'admin.css'), 'text/css']]]);
  // Only the dashboard answers on its host, and it answers nowhere else.
  async function adminRequest(req, res, reply, url, ip) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if (!adminEnabled) fail(404, 'Not found');
    const method = req.method, pathname = url.pathname;
    if (method === 'GET' && adminAssets.has(pathname)) {
      const [filename, type] = adminAssets.get(pathname);
      res.setHeader('Content-Type', type); res.end(readFileSync(filename)); return;
    }
    // The browser sends the cookie along with any request; a change must come from the dashboard page itself.
    if (method !== 'GET' && req.headers.origin !== adminOrigin) fail(403, 'Origin not allowed');
    const cookie = (value, age) => res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${value}; Max-Age=${age}; Path=/; Secure; HttpOnly; SameSite=Strict`);
    if (method === 'POST' && pathname === '/api/admin/login') {
      limit(`admin:${ip}`, 5);
      cookie(await adminLogin(await body(req, MAX_METADATA_BODY)), ADMIN_SESSION_TIME / 1000);
      reply(200, { ok: true }); return;
    }
    if (method === 'POST' && pathname === '/api/admin/logout') {
      const token = adminCookie(req);
      if (validToken(token)) adminSessions.delete(hash(token));
      cookie('', 0); reply(200, { ok: true }); return;
    }
    if (method === 'GET' && pathname === '/api/admin/summary') { adminSession(req); reply(200, adminSummary()); return; }
    if (method === 'GET' && pathname === '/api/admin/accounts') { adminSession(req); reply(200, adminAccounts(url.searchParams)); return; }
    // What the terms promise after a report. The notes stay sealed: these act on what a report names, a group ID or an address.
    if (method === 'POST' && pathname === '/api/admin/delete-group') {
      adminSession(req);
      const value = await body(req, MAX_METADATA_BODY);
      requireValue(value.confirm === 'DELETE GROUP' && validId(value.spaceId), 'Confirm deleting the group');
      const emails = transaction(() => {
        const space = spaceRow(value.spaceId) ?? fail(404, 'Group not found');
        const people = all('SELECT a.email FROM space_members m JOIN accounts a ON a.id=m.accountId WHERE m.spaceId=?', space.id).map((person) => person.email);
        const old = space.replaces ? spaceRow(space.replaces) : undefined;
        if (old?.replacedBy === space.id) deleteSpace(old.id);
        deleteSpace(space.id);
        return people;
      });
      for (const to of emails) sendMailLater({ to, kind: 'group-removed' });
      reply(200, { deleted: true, told: emails.length }); return;
    }
    if (method === 'POST' && pathname === '/api/admin/delete-link') {
      adminSession(req);
      const value = await body(req, MAX_METADATA_BODY);
      requireValue(value.confirm === 'DELETE LINK' && validId(value.linkId), 'Confirm deleting the link');
      const email = transaction(() => {
        const link = one('SELECT l.id,a.email FROM note_links l LEFT JOIN accounts a ON a.id=l.accountId WHERE l.id=?', value.linkId) ?? fail(404, 'Link not found');
        run('DELETE FROM note_links WHERE id=?', link.id);
        return link.email;
      });
      if (email) sendMailLater({ to: email, kind: 'link-removed' });
      reply(200, { deleted: true }); return;
    }
    if (method === 'POST' && pathname === '/api/admin/delete-list') {
      adminSession(req);
      const value = await body(req, MAX_METADATA_BODY);
      requireValue(value.confirm === 'DELETE LIST' && validId(value.listId), 'Confirm deleting the list');
      const email = transaction(() => {
        const link = one('SELECT l.id,a.email FROM list_links l LEFT JOIN accounts a ON a.id=l.accountId WHERE l.id=?', value.listId) ?? fail(404, 'List not found');
        run('DELETE FROM list_links WHERE id=?', link.id);
        return link.email;
      });
      if (email) sendMailLater({ to: email, kind: 'link-removed' });
      reply(200, { deleted: true }); return;
    }
    if (method === 'POST' && pathname === '/api/admin/close-account') {
      adminSession(req);
      const value = await body(req, MAX_METADATA_BODY);
      requireValue(value.confirm === 'CLOSE ACCOUNT' && typeof value.email === 'string', 'Confirm closing the account');
      const account = one('SELECT * FROM accounts WHERE email=?', value.email.trim().toLowerCase()) ?? fail(404, 'Account not found');
      await cancelPlus(account.vaultId);
      transaction(() => wipeCloud(account.vaultId, account));
      forgetAddress(account, 'account-closed');
      reply(200, { deleted: true }); return;
    }
    fail(404, 'Not found');
  }
  // A space being replaced until the old one is frozen: only its owner is in it and nobody can join yet.
  const unfinished = (space) => { const old = space.replaces && spaceRow(space.replaces); return Boolean(old) && old.replacedBy !== space.id; };
  const unfinishedSql = 'EXISTS (SELECT 1 FROM spaces o WHERE o.id=s.replaces AND o.replacedBy IS NOT s.id)';
  const liveSpaces = (accountId) => one(`SELECT COUNT(*) AS count FROM spaces s WHERE s.ownerAccountId=? AND s.frozenAt IS NULL AND NOT ${unfinishedSql}`, accountId).count;
  const memberCount = (spaceId) => one('SELECT COUNT(*) AS count FROM space_members WHERE spaceId=?', spaceId).count;
  const memberships = (accountId) => one('SELECT COUNT(*) AS count FROM space_members WHERE accountId=?', accountId).count;
  function deleteSpace(spaceId) {
    const next = one('SELECT * FROM spaces WHERE replaces=?', spaceId);
    if (next && unfinished(next)) deleteSpace(next.id);
    for (const table of ['revisions', 'envelope_chunks', 'chunks', 'retired_envelopes', 'envelopes', 'changes', 'purges']) run(`DELETE FROM ${table} WHERE vaultId=?`, spaceId);
    for (const table of ['space_members', 'space_keys', 'space_invites']) run(`DELETE FROM ${table} WHERE spaceId=?`, spaceId);
    run('UPDATE spaces SET replacedBy=NULL WHERE replacedBy=?', spaceId);
    run('DELETE FROM spaces WHERE id=?', spaceId);
    run('DELETE FROM vaults WHERE id=?', spaceId);
  }
  function removeMember(spaceId, accountId) {
    run('DELETE FROM space_members WHERE spaceId=? AND accountId=?', spaceId, accountId);
    run('DELETE FROM space_keys WHERE spaceId=? AND accountId=?', spaceId, accountId);
    run('DELETE FROM space_invites WHERE spaceId=? AND claimedBy=?', spaceId, accountId);
    run('DELETE FROM chunks WHERE vaultId=? AND claimed=0 AND deviceId IN (SELECT d.id FROM devices d JOIN accounts a ON a.vaultId=d.vaultId WHERE a.id=?)', spaceId, accountId);
  }
  // The owner left, deleted their account or started over: frozen until a member takes over, or removed when nobody is left.
  function ownerGone(space) {
    removeMember(space.id, space.ownerAccountId);
    const next = one('SELECT * FROM spaces WHERE replaces=?', space.id);
    if (next && unfinished(next)) deleteSpace(next.id);
    if (!memberCount(space.id)) { deleteSpace(space.id); return; }
    run('UPDATE spaces SET ownerGoneAt=?,frozenAt=COALESCE(frozenAt,?) WHERE id=?', clock(), clock(), space.id);
    run('DELETE FROM space_invites WHERE spaceId=? AND claimedBy IS NULL', space.id);
  }
  // Before the account's devices go: what they wrote stays with the others, without pointing at a device that no longer exists.
  // Before anything is gone: a subscription that cannot be cancelled stops the whole deletion.
  async function cancelPlus(vaultId) {
    for (const { subscriptionId } of all(`SELECT subscriptionId FROM subscriptions WHERE vaultId=? AND status IN (${RUNNING.map(() => '?').join(',')})`, vaultId, ...RUNNING)) {
      let cancelled = false;
      try {
        const response = await stripeCall(`/subscriptions/${subscriptionId}`, { method: 'DELETE' });
        cancelled = response.ok || response.status === 404;
        await response.body?.cancel();
      } catch { cancelled = false; }
      if (!cancelled) fail(502, 'Could not cancel JotDrop Plus. Try again later, or cancel it at link.com first.');
    }
  }
  /** Everything of one cloud and its account, inside the caller's transaction. */
  function wipeCloud(vaultId, account) {
    if (account) {
      leaveAllSpaces(account);
      run('DELETE FROM family_members WHERE accountId=? OR ownerAccountId=?', account.id, account.id);
      run('DELETE FROM family_invites WHERE ownerAccountId=?', account.id);
      for (const table of ['identities', 'newsletter', 'login_challenges', 'resets', 'device_approvals', 'roadmap_votes']) run(`DELETE FROM ${table} WHERE accountId=?`, account.id);
      run('DELETE FROM code_failures WHERE scope IN (?,?,?)', `login:${account.id}`, `reset:${account.id}`, `signup:${account.email}`);
      run('DELETE FROM accounts WHERE id=?', account.id);
    }
    for (const table of ['uploads', 'pairings', 'revisions', 'envelope_chunks', 'chunks', 'retired_envelopes', 'envelopes', 'changes', 'purges', 'signups', 'devices', 'plans', 'trials', 'subscriptions', 'mail_accounts', 'mail_senders', 'mail_items', 'mail_parts', 'mail_log']) run(`DELETE FROM ${table} WHERE vaultId=?`, vaultId);
    run('DELETE FROM vaults WHERE id=?', vaultId);
  }
  function forgetAddress(account, kind) {
    sendMailLater({ to: account.email, kind });
    if (newsletter?.remove) void Promise.resolve().then(() => newsletter.remove(account.email))
      .catch((error) => console.warn(`Could not remove a deleted account from the mailing list: ${error.message}`));
  }
  function leaveAllSpaces(account) {
    for (const table of ['note_links', 'list_links']) run(`DELETE FROM ${table} WHERE accountId=?`, account.id);
    run('DELETE FROM space_blocks WHERE accountId=? OR blockedAccountId=?', account.id, account.id);
    for (const table of ['revisions', 'changes']) run(`UPDATE ${table} SET deviceId='removed' WHERE vaultId IN (SELECT id FROM spaces) AND deviceId IN (SELECT id FROM devices WHERE vaultId=?)`, account.vaultId);
    for (const space of all('SELECT * FROM spaces WHERE ownerAccountId=? AND ownerGoneAt IS NULL', account.id)) ownerGone(space);
    for (const { spaceId } of all('SELECT spaceId FROM space_members WHERE accountId=?', account.id)) {
      removeMember(spaceId, account.id);
      if (!memberCount(spaceId)) deleteSpace(spaceId);
    }
  }
  // What a cloud has above the free plan, for the mail when the trial ends. Nothing is deleted: it only stops growing.
  function aboveFree(account) {
    const now = clock();
    const used = storageUsage(account.vaultId) + liveSpaceBytes(account.id);
    const devices = one('SELECT COUNT(*) AS count FROM devices WHERE vaultId=? AND revoked=0', account.vaultId).count;
    const groups = liveSpaces(account.id);
    const links = allLinks(account).filter((link) => (link.expiresAt === null || link.expiresAt > now) && link.createdAt + LINK_FREE_DAYS * DAY <= now).length;
    return { usedMb: used > quotaBytes ? Math.ceil(used / 1048576) : 0, quotaMb: Math.round(quotaBytes / 1048576), devices: devices > freeDeviceLimit ? devices : 0, deviceLimit: freeDeviceLimit, groups: groups > 1 ? groups : 0, links };
  }
  // Two mails per trial: three days before the end, and on the day itself. A cloud that pays or has a family gets neither;
  // a trial that ended more than a week ago (a server that was down) is marked without a late mail.
  function sweepTrials() {
    const now = clock();
    for (const row of all('SELECT t.vaultId,t.mail,t.trialUntil,a.id,a.email FROM trials t JOIN accounts a ON a.vaultId=t.vaultId WHERE t.mail<2')) {
      const account = { id: row.id, vaultId: row.vaultId, email: row.email };
      const extended = planRow(row.vaultId).plusUntil !== row.trialUntil || subscribed(row.vaultId);
      if (extended || row.trialUntil <= now - 7 * DAY) { run('UPDATE trials SET mail=2 WHERE vaultId=?', row.vaultId); continue; }
      if (row.trialUntil <= now) {
        run('UPDATE trials SET mail=2 WHERE vaultId=?', row.vaultId);
        sendMailLater({ to: row.email, kind: 'trial-ended', trial: aboveFree(account) });
      } else if (row.mail < 1 && row.trialUntil - now <= 3 * DAY) {
        run('UPDATE trials SET mail=1 WHERE vaultId=?', row.vaultId);
        sendMailLater({ to: row.email, kind: 'trial-ending', trial: { ...aboveFree(account), endsAt: new Date(row.trialUntil).toISOString() } });
      }
    }
  }
  function sweepSpaces() {
    transaction(() => {
      const now = clock();
      run('DELETE FROM space_invites WHERE expiresAt<=?', now);
      for (const table of ['note_links', 'list_links']) run(`DELETE FROM ${table} WHERE expiresAt<=? OR accountId NOT IN (SELECT id FROM accounts)`, now);
      // An older server may have run for a while and deleted accounts without knowing about spaces.
      for (const table of ['space_members', 'space_keys', 'space_blocks']) run(`DELETE FROM ${table} WHERE accountId NOT IN (SELECT id FROM accounts)`);
      run('DELETE FROM space_blocks WHERE blockedAccountId NOT IN (SELECT id FROM accounts)');
      run('DELETE FROM family_invites WHERE expiresAt<=? OR ownerAccountId NOT IN (SELECT id FROM accounts)', now);
      run('DELETE FROM family_members WHERE accountId NOT IN (SELECT id FROM accounts) OR ownerAccountId NOT IN (SELECT id FROM accounts)');
      run('DELETE FROM family_subscriptions WHERE subscriptionId NOT IN (SELECT subscriptionId FROM subscriptions)');
      run('DELETE FROM subscription_details WHERE subscriptionId NOT IN (SELECT subscriptionId FROM subscriptions)');
      run('DELETE FROM limit_hits WHERE weekStart<?', now - 26 * 7 * DAY);
      run('DELETE FROM space_reports WHERE createdAt<=? OR accountId NOT IN (SELECT id FROM accounts)', now - 24 * 60 * 60 * 1000);
      run('UPDATE spaces SET ownerGoneAt=?,frozenAt=COALESCE(frozenAt,?) WHERE ownerGoneAt IS NULL AND ownerAccountId NOT IN (SELECT id FROM accounts)', now, now);
      const finished = all(`SELECT s.id FROM spaces s WHERE s.frozenAt<=? OR (s.createdAt<=? AND ${unfinishedSql}) OR NOT EXISTS (SELECT 1 FROM space_members m WHERE m.spaceId=s.id)`, now - FROZEN_SPACE_LIFETIME, now - UNFINISHED_SPACE_LIFETIME);
      for (const { id } of finished) deleteSpace(id);
    });
  }
  // The same answer for a space that does not exist and one the asker is not in.
  const memberSpace = (spaceId, accountId) => one('SELECT s.* FROM spaces s JOIN space_members m ON m.spaceId=s.id WHERE s.id=? AND m.accountId=?', spaceId, accountId) ?? fail(404, 'Shared space not found');
  function ownedSpace(spaceId, accountId) {
    const space = memberSpace(spaceId, accountId);
    if (space.ownerAccountId !== accountId) fail(403, 'Only the owner of this space can do that.', { code: 'not-owner' });
    return space;
  }
  function requireJoinable(space) {
    if (space.frozenAt) fail(409, 'This shared space is read-only.', { code: 'space-frozen' });
    if (unfinished(space)) fail(409, 'This shared space is still being replaced.', { code: 'space-unfinished' });
  }
  // The longest-standing member may take over at once, any member after a week.
  const mayTakeOver = (space, accountId) => one('SELECT accountId FROM space_members WHERE spaceId=? ORDER BY joinedAt,accountId LIMIT 1', space.id)?.accountId === accountId || space.ownerGoneAt + TAKEOVER_WAIT <= clock();
  const isoTime = (time) => time ? new Date(time).toISOString() : null;
  function spaceView(space, account) {
    const owner = space.ownerAccountId === account.id, key = one('SELECT wrapped,prefs FROM space_keys WHERE accountId=? AND spaceId=?', account.id, space.id);
    const members = all('SELECT m.accountId,m.nameEnvelope,m.joinedAt,a.email FROM space_members m LEFT JOIN accounts a ON a.id=m.accountId WHERE m.spaceId=? ORDER BY m.joinedAt,m.accountId', space.id);
    return { id: space.id, role: owner ? 'owner' : 'member', nameEnvelope: space.nameEnvelope, frozen: Boolean(space.frozenAt), replacedBy: space.replacedBy, replaces: space.replaces, unfinished: unfinished(space), ownerGoneAt: isoTime(space.ownerGoneAt), canTakeOver: Boolean(space.ownerGoneAt) && !space.replacedBy && mayTakeOver(space, account.id), usedBytes: storageUsage(space.id),
      // Display names are for everyone in the space; only the owner sees email addresses and open invitations.
      members: members.map((member) => ({ accountId: member.accountId, nameEnvelope: member.nameEnvelope, joinedAt: isoTime(member.joinedAt), role: member.accountId === space.ownerAccountId ? 'owner' : 'member', ...(owner ? { email: member.email } : {}) })),
      // The key is only ever handed to the account it is wrapped for.
      me: { accountId: account.id, wrapped: key?.wrapped ?? null, prefs: key?.prefs ?? null, nameEnvelope: members.find((member) => member.accountId === account.id)?.nameEnvelope ?? null },
      ...(owner ? { invites: all('SELECT id,expiresAt,claimedBy FROM space_invites WHERE spaceId=? ORDER BY expiresAt', space.id).map((invite) => ({ id: invite.id, expiresAt: isoTime(invite.expiresAt), claimed: Boolean(invite.claimedBy) })) } : {}) };
  }
  // Plus can keep a link longer; when Plus ends, a link older than the free period stops, and comes back with Plus.
  function linkEnd(link, vaultId) {
    if (isPlus(vaultId)) return link.expiresAt;
    const free = link.createdAt + LINK_FREE_DAYS * DAY;
    return link.expiresAt === null ? free : Math.min(link.expiresAt, free);
  }
  // Note links and list links count together, on every plan.
  const allLinks = (account) => ['note_links', 'list_links'].flatMap((table) => all(`SELECT createdAt,expiresAt FROM ${table} WHERE accountId=?`, account.id));
  function linkRoom(account, vaultId, days) {
    const now = clock(), plus = isPlus(vaultId), live = allLinks(account).filter((link) => { const end = linkEnd(link, vaultId); return end === null || end > now; }).length;
    if (!plus && days !== LINK_FREE_DAYS) planLimit('link-days', vaultId, 402, 'On the free plan a link lasts 7 days. JotDrop Plus chooses how long.');
    if (!plus && live >= 1) planLimit('links', vaultId, 402, 'The free plan has one link at a time. JotDrop Plus has more.');
    if (live >= MAX_LINKS) fail(409, `You can have ${MAX_LINKS} links at most.`, { code: 'too-many-links' });
  }
  async function linkRequest(req, reply, method, route, account, vaultId, deviceId) {
    const change = (action) => transaction(() => { requireAccess(vaultId, deviceId); return action(); });
    if (route === '/links' && method === 'GET') {
      reply(200, { links: change(() => all('SELECT * FROM note_links WHERE accountId=? ORDER BY createdAt DESC', account.id)).map((link) => ({ id: link.id, ownerEnvelope: link.ownerEnvelope, createdAt: isoTime(link.createdAt), expiresAt: isoTime(linkEnd(link, vaultId)) })) });
      return;
    }
    if (route === '/links' && method === 'POST') {
      limit(`link:${vaultId}`, 30);
      const value = await body(req, 4 * MAX_LINK_BYTES);
      requireValue(validId(value.id) && LINK_DAYS.includes(value.days), 'Invalid link');
      if (typeof value.envelope === 'string' && Buffer.byteLength(value.envelope) > MAX_LINK_BYTES) fail(413, 'This note is too long for a link.');
      envelopeSize(value.envelope, MAX_LINK_BYTES);
      envelopeSize(value.ownerEnvelope, 4096);
      const expiresAt = change(() => {
        const now = clock();
        linkRoom(account, vaultId, value.days);
        if (one('SELECT 1 FROM note_links WHERE id=?', value.id)) fail(409, 'Choose another ID for this link.');
        const end = value.days === 0 ? null : now + value.days * DAY;
        run('INSERT INTO note_links(id,accountId,envelope,ownerEnvelope,createdAt,expiresAt) VALUES(?,?,?,?,?,?)', value.id, account.id, value.envelope, value.ownerEnvelope, now, end);
        return end;
      });
      reply(201, { id: value.id, expiresAt: isoTime(expiresAt) });
      return;
    }
    const target = /^\/links\/([0-9a-f-]+)$/.exec(route);
    if (target && method === 'DELETE') {
      requireValue(validId(target[1]), 'Invalid link');
      change(() => {
        if (!one('SELECT 1 FROM note_links WHERE id=? AND accountId=?', target[1], account.id)) fail(404, 'Link not found');
        run('DELETE FROM note_links WHERE id=?', target[1]);
      });
      reply(200, { ok: true });
      return;
    }
    fail(404, 'Not found');
  }
  // The sealed list is at most a note link's size; the owner's envelope carries the last version an owner wrote as well.
  function listEnvelope(value) {
    if (typeof value === 'string' && Buffer.byteLength(value) > MAX_LINK_BYTES) fail(413, 'This list is too long for a link.');
    envelopeSize(value, MAX_LINK_BYTES);
  }
  function listOwnerEnvelope(value) {
    if (typeof value === 'string' && Buffer.byteLength(value) > MAX_LIST_OWNER_BYTES) fail(413, 'This list is too long for a link.');
    envelopeSize(value, MAX_LIST_OWNER_BYTES);
  }
  async function listLinkRequest(req, reply, method, route, account, vaultId, deviceId) {
    const change = (action) => transaction(() => { requireAccess(vaultId, deviceId); return action(); });
    if (route === '/list-links' && method === 'GET') {
      reply(200, { links: change(() => all('SELECT * FROM list_links WHERE accountId=? ORDER BY createdAt DESC', account.id)).map((link) => ({ id: link.id, revision: link.revision, ownerEnvelope: link.ownerEnvelope, createdAt: isoTime(link.createdAt), updatedAt: isoTime(link.updatedAt), expiresAt: isoTime(linkEnd(link, vaultId)) })) });
      return;
    }
    if (route === '/list-links' && method === 'POST') {
      limit(`link:${vaultId}`, 30);
      const value = await body(req, 3 * MAX_LINK_BYTES);
      requireValue(validId(value.id) && LINK_DAYS.includes(value.days) && validHash(value.writeProofHash), 'Invalid list link');
      listEnvelope(value.envelope);
      listOwnerEnvelope(value.ownerEnvelope);
      const expiresAt = change(() => {
        const now = clock();
        linkRoom(account, vaultId, value.days);
        if (one('SELECT 1 FROM list_links WHERE id=?', value.id)) fail(409, 'Choose another ID for this link.');
        const end = value.days === 0 ? null : now + value.days * DAY;
        run('INSERT INTO list_links(id,accountId,revision,envelope,ownerEnvelope,writeProofHash,createdAt,updatedAt,expiresAt) VALUES(?,?,1,?,?,?,?,?,?)', value.id, account.id, value.envelope, value.ownerEnvelope, value.writeProofHash, now, now, end);
        return end;
      });
      reply(201, { id: value.id, expiresAt: isoTime(expiresAt) });
      return;
    }
    const target = /^\/list-links\/([0-9a-f-]+)$/.exec(route);
    if (target && method === 'DELETE') {
      requireValue(validId(target[1]), 'Invalid list link');
      change(() => {
        if (!one('SELECT 1 FROM list_links WHERE id=? AND accountId=?', target[1], account.id)) fail(404, 'Link not found');
        run('DELETE FROM list_links WHERE id=?', target[1]);
      });
      reply(200, { ok: true });
      return;
    }
    // The owner moves the base it keeps in its envelope, and with `envelope` writes a new version for everyone: both
    // only when the number it read still holds. Without `envelope` the number stays, so guests fetch nothing new.
    if (target && method === 'PUT') {
      requireValue(validId(target[1]), 'Invalid list link');
      const value = await body(req, 3 * MAX_LINK_BYTES);
      requireValue(Number.isSafeInteger(value.baseRevision) && value.baseRevision >= 1, 'Invalid list link');
      const writes = value.envelope !== undefined;
      if (writes) listEnvelope(value.envelope);
      listOwnerEnvelope(value.ownerEnvelope);
      const revision = change(() => {
        const link = one('SELECT id,revision FROM list_links WHERE id=? AND accountId=?', target[1], account.id) ?? fail(404, 'Link not found');
        if (link.revision !== value.baseRevision) fail(409, 'Someone else changed the list.', { currentRevision: link.revision });
        if (writes) run('UPDATE list_links SET revision=revision+1,envelope=?,ownerEnvelope=?,updatedAt=? WHERE id=?', value.envelope, value.ownerEnvelope, clock(), link.id);
        else run('UPDATE list_links SET ownerEnvelope=? WHERE id=?', value.ownerEnvelope, link.id);
        return link.revision + (writes ? 1 : 0);
      });
      reply(200, { revision });
      return;
    }
    fail(404, 'Not found');
  }
  // The owner sees who is in the family; a member only sees who pays. Nobody sees anyone's notes.
  function familyView(account) {
    if (!ownsFamily(account)) {
      const payer = activeMember(account);
      return payer ? { role: 'member', seats: FAMILY_SEATS, accountId: account.id, owner: payer.email, until: isoTime(familyUntil(payer.vaultId)), joinedAt: isoTime(payer.joinedAt) } : { role: null, seats: FAMILY_SEATS };
    }
    return { role: 'owner', seats: FAMILY_SEATS, until: isoTime(familyUntil(account.vaultId)),
      members: all('SELECT m.accountId,a.email,m.joinedAt FROM family_members m JOIN accounts a ON a.id=m.accountId WHERE m.ownerAccountId=? ORDER BY m.joinedAt,m.accountId', account.id).map((member) => ({ accountId: member.accountId, email: member.email, joinedAt: isoTime(member.joinedAt) })),
      openInvites: one('SELECT COUNT(*) AS count FROM family_invites WHERE ownerAccountId=? AND expiresAt>?', account.id, clock()).count };
  }
  async function familyRequest(req, reply, method, route, account, vaultId, deviceId) {
    const change = (action) => transaction(() => { requireAccess(vaultId, deviceId); return action(); });
    if (route === '/family' && method === 'GET') { reply(200, change(() => familyView(account))); return; }
    if (route === '/family/invites' && method === 'POST') {
      limit(`family:${vaultId}`, 20);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = change(() => {
        if (!ownsFamily(account)) planLimit('family-invite', vaultId, 402, 'Inviting people needs the JotDrop family plan.', { code: 'family-required' });
        run('DELETE FROM family_invites WHERE ownerAccountId=? AND expiresAt<=?', account.id, clock());
        // Open invitations hold a seat, so six links cannot bring in seven people.
        const taken = one('SELECT (SELECT COUNT(*) FROM family_members WHERE ownerAccountId=?)+(SELECT COUNT(*) FROM family_invites WHERE ownerAccountId=?) AS count', account.id, account.id).count;
        if (taken >= FAMILY_SEATS - 1) fail(409, `The family plan has room for ${FAMILY_SEATS} people, you included.`, { code: 'family-full' });
        run('INSERT INTO family_invites VALUES(?,?,?)', hash(token), account.id, clock() + FAMILY_INVITE_TIME);
        return clock() + FAMILY_INVITE_TIME;
      });
      reply(201, { token, expiresAt: isoTime(expiresAt) }); return;
    }
    if (route === '/family/join' && method === 'POST') {
      limit(`family-join:${vaultId}`, 10);
      const value = await body(req, MAX_METADATA_BODY);
      requireValue(validToken(value.token), 'Invalid invitation');
      const owner = change(() => {
        const gone = () => fail(404, 'This invitation does not work any more. Ask for a new one.');
        const invite = one('SELECT * FROM family_invites WHERE tokenHash=? AND expiresAt>?', hash(value.token), clock()) ?? gone();
        if (invite.ownerAccountId === account.id) fail(409, 'This is your own family.', { code: 'own-family' });
        const current = familyMember(account);
        // A family whose plan ended does not hold anyone back.
        if (ownsFamily(account) || (current && ownsFamily(current))) fail(409, 'You are already in a JotDrop family. Leave it first.', { code: 'in-family' });
        const payer = one('SELECT * FROM accounts WHERE id=?', invite.ownerAccountId);
        if (!payer || !ownsFamily(payer)) gone();
        run('DELETE FROM family_invites WHERE tokenHash=?', invite.tokenHash);
        run('INSERT INTO family_members VALUES(?,?,?) ON CONFLICT(accountId) DO UPDATE SET ownerAccountId=excluded.ownerAccountId,joinedAt=excluded.joinedAt', account.id, payer.id, clock());
        return payer.email;
      });
      reply(200, { owner }); return;
    }
    const target = /^\/family\/members\/([0-9a-f-]+)$/.exec(route);
    if (target && method === 'DELETE') {
      requireValue(validId(target[1]), 'Invalid family member');
      // A member leaves; the owner removes anyone. Plus ends at once.
      change(() => { if (!run('DELETE FROM family_members WHERE accountId=? AND (accountId=? OR ownerAccountId=?)', target[1], account.id, account.id).changes) fail(404, 'Family member not found'); });
      reply(200, { ok: true }); return;
    }
    fail(404, 'Not found');
  }
  // No account: the link is all someone has. What comes back is sealed.
  async function publicLinkRequest(req, reply, method, route, ip) {
    const match = /^\/public-links\/([^/]+)(\/report)?$/.exec(route);
    if (!match) fail(404, 'Not found');
    requireValue(validId(match[1]), 'Invalid link');
    const link = one('SELECT l.*,a.vaultId,a.email FROM note_links l JOIN accounts a ON a.id=l.accountId WHERE l.id=?', match[1]) ?? fail(404, 'This link has ended.');
    if (method === 'GET' && !match[2]) {
      limit(`open-link:${ip}`, 120);
      const end = linkEnd(link, link.vaultId);
      if (end !== null && end <= clock()) fail(410, 'This link has ended.');
      reply(200, { envelope: link.envelope, expiresAt: isoTime(end) });
      return;
    }
    if (method === 'POST' && match[2]) {
      limit(`link-report:${ip}`, 5);
      const value = await body(req, MAX_METADATA_BODY);
      requireValue(REPORT_REASONS.includes(value.reason) && (value.details === undefined || (typeof value.details === 'string' && value.details.length <= 2000)), 'Invalid report');
      await sendMail({ to: REPORT_ADDRESS, kind: 'link-report', report: { reason: value.reason, owner: link.email, linkId: link.id, details: value.details ?? '' } });
      reply(200, { ok: true });
      return;
    }
    fail(404, 'Not found');
  }
  // No account: the link is all someone has. The list comes back sealed with its number; a write names the number it
  // read and proves the key. The server swaps only when the number still holds, so two writers never lose each other's.
  async function publicListRequest(req, reply, method, route, ip) {
    const match = /^\/public-lists\/([^/]+)(\/report)?$/.exec(route);
    if (!match) fail(404, 'Not found');
    requireValue(validId(match[1]), 'Invalid link');
    const link = one('SELECT l.*,a.vaultId,a.email FROM list_links l JOIN accounts a ON a.id=l.accountId WHERE l.id=?', match[1]) ?? fail(404, 'This link has ended.');
    const end = linkEnd(link, link.vaultId);
    const stillOpen = () => { if (end !== null && end <= clock()) fail(410, 'This link has ended.'); };
    if (method === 'GET' && !match[2]) {
      limit(`open-list:${ip}`, 120);
      stillOpen();
      reply(200, { envelope: link.envelope, revision: link.revision, expiresAt: isoTime(end) });
      return;
    }
    if (method === 'PUT' && !match[2]) {
      limit(`write-list:${ip}`, LIST_WRITES_A_MINUTE);
      limit(`write-list:${link.id}`, LIST_WRITES_EACH_A_MINUTE);
      const value = await body(req, 2 * MAX_LINK_BYTES);
      requireValue(Number.isSafeInteger(value.baseRevision) && value.baseRevision >= 1 && typeof value.writeProof === 'string' && value.writeProof.length <= 256, 'Invalid list write');
      stillOpen();
      if (!equal(hash(value.writeProof), link.writeProofHash)) fail(403, 'This link cannot be written to.');
      listEnvelope(value.envelope);
      const revision = transaction(() => {
        const current = one('SELECT revision FROM list_links WHERE id=?', link.id) ?? fail(410, 'This link has ended.');
        if (current.revision !== value.baseRevision) fail(409, 'Someone else changed the list.', { currentRevision: current.revision });
        run('UPDATE list_links SET revision=revision+1,envelope=?,updatedAt=? WHERE id=?', value.envelope, clock(), link.id);
        return current.revision + 1;
      });
      reply(200, { revision });
      return;
    }
    if (method === 'POST' && match[2]) {
      limit(`link-report:${ip}`, 5);
      const value = await body(req, MAX_METADATA_BODY);
      requireValue(REPORT_REASONS.includes(value.reason) && (value.details === undefined || (typeof value.details === 'string' && value.details.length <= 2000)), 'Invalid report');
      await sendMail({ to: REPORT_ADDRESS, kind: 'list-report', report: { reason: value.reason, owner: link.email, linkId: link.id, details: value.details ?? '' } });
      reply(200, { ok: true });
      return;
    }
    fail(404, 'Not found');
  }
  // Managing who is in a space, with the asker's own cloud in X-JotDrop-Vault. The files of a space use the ordinary routes.
  async function spaceRequest(req, reply, method, route, vaultId, deviceId, ip) {
    const account = one('SELECT id,email,vaultId FROM accounts WHERE vaultId=?', vaultId) ?? fail(403, 'Sharing needs an account. Add one to this cloud first.', { code: 'account-required' });
    const change = (action) => transaction(() => { requireAccess(vaultId, deviceId); return action(); });
    const claim = /^\/invites\/([0-9a-f-]+)\/claim$/.exec(route);
    if (method === 'POST' && claim) {
      limit(`invite:${ip}`, 10);
      requireValue(validId(claim[1]), 'Invalid invitation');
      const value = await body(req, MAX_METADATA_BODY);
      reply(200, change(() => {
        const invite = one('SELECT * FROM space_invites WHERE id=?', claim[1]);
        if (!validToken(value.claimToken) || !invite || !equal(hash(value.claimToken), invite.claimTokenHash)) fail(404, 'This invitation is not valid.');
        if (invite.expiresAt <= clock()) fail(410, 'This invitation has expired.');
        if (invite.claimedBy) {
          // A crash between claiming and saving the key must not lose the key: the same account may ask again until then.
          if (invite.claimedBy === account.id && invite.envelope) return { spaceId: invite.spaceId, envelope: invite.envelope };
          if (invite.claimedBy === account.id) fail(409, 'You are already in this shared space.', { code: 'already-member' });
          fail(409, 'This invitation was already used.', { code: 'invite-used' });
        }
        requireJoinable(spaceRow(invite.spaceId));
        // Before anything is used up: the link can still go to someone else.
        if (one('SELECT 1 FROM space_members m JOIN space_blocks b ON (b.accountId=m.accountId AND b.blockedAccountId=?) OR (b.accountId=? AND b.blockedAccountId=m.accountId) WHERE m.spaceId=? LIMIT 1', account.id, account.id, invite.spaceId)) fail(403, 'You cannot join this group.', { code: 'blocked' });
        if (one('SELECT 1 FROM space_members WHERE spaceId=? AND accountId=?', invite.spaceId, account.id)) fail(409, 'You are already in this shared space.', { code: 'already-member' });
        if (memberCount(invite.spaceId) >= MAX_SPACE_MEMBERS) fail(409, `A shared space can have ${MAX_SPACE_MEMBERS} people at most.`, { code: 'space-full' });
        if (memberships(account.id) >= MAX_MEMBERSHIPS) fail(409, `You can be in ${MAX_MEMBERSHIPS} shared spaces at most.`, { code: 'too-many-spaces' });
        run('INSERT INTO space_members(spaceId,accountId,joinedAt) VALUES(?,?,?)', invite.spaceId, account.id, clock());
        run('UPDATE space_invites SET claimedBy=?,claimedAt=? WHERE id=?', account.id, clock(), invite.id);
        return { spaceId: invite.spaceId, envelope: invite.envelope };
      })); return;
    }
    if (route === '/spaces' && method === 'GET') {
      reply(200, { spaces: all('SELECT s.id,s.frozenAt,s.replacedBy,(SELECT COALESCE(MAX(c.sequence),0) FROM changes c WHERE c.vaultId=s.id) AS sequence FROM space_members m JOIN spaces s ON s.id=m.spaceId WHERE m.accountId=? ORDER BY s.createdAt,s.id', account.id).map((space) => ({ id: space.id, sequence: space.sequence, frozen: Boolean(space.frozenAt), replacedBy: space.replacedBy })) }); return;
    }
    if (route === '/spaces' && method === 'POST') {
      limit(`space:${vaultId}`, 30);
      const value = await body(req, MAX_METADATA_BODY);
      requireValue(validId(value.id) && (value.replaces === undefined || validId(value.replaces)), 'Invalid shared space');
      envelopeSize(value.nameEnvelope, 4096);
      envelopeSize(value.wrapped, 1024);
      const result = change(() => {
        if (one('SELECT 1 FROM spaces WHERE id=? AND ownerAccountId=?', value.id, account.id)) return { id: value.id, created: false };
        if (value.replaces) {
          // A replacement must stay possible on any plan, or nobody could be removed from a group after Plus ended.
          // It is limited instead: one per space, of a live space of your own, and never of an unfinished replacement.
          const old = spaceRow(value.replaces);
          if (!old || old.ownerAccountId !== account.id || old.ownerGoneAt) fail(404, 'Shared space not found');
          if (old.frozenAt) fail(409, 'This shared space is read-only.', { code: 'space-frozen' });
          const running = one('SELECT id FROM spaces WHERE replaces=?', old.id);
          if (running) return { id: running.id, created: false };
          if (unfinished(old)) fail(409, 'This shared space is still being replaced.', { code: 'space-unfinished' });
        } else {
          const live = liveSpaces(account.id);
          if (!isPlus(vaultId) && live >= 1) planLimit('shared-spaces', vaultId, 402, 'The free plan shares one note. JotDrop Plus shares more.');
          if (live >= MAX_OWN_SPACES) fail(409, `You can own ${MAX_OWN_SPACES} shared spaces at most.`, { code: 'too-many-spaces' });
          if (memberships(account.id) >= MAX_MEMBERSHIPS) fail(409, `You can be in ${MAX_MEMBERSHIPS} shared spaces at most.`, { code: 'too-many-spaces' });
        }
        if (one('SELECT 1 FROM vaults WHERE id=?', value.id)) fail(409, 'Choose another ID for this shared space.');
        run('INSERT INTO vaults VALUES(?,?,?)', value.id, hash(randomBytes(32)), 'space');
        run('INSERT INTO spaces(id,ownerAccountId,nameEnvelope,createdAt,replaces) VALUES(?,?,?,?,?)', value.id, account.id, value.nameEnvelope, clock(), value.replaces ?? null);
        run('INSERT INTO space_members(spaceId,accountId,joinedAt) VALUES(?,?,?)', value.id, account.id, clock());
        run('INSERT INTO space_keys(accountId,spaceId,wrapped) VALUES(?,?,?)', account.id, value.id, value.wrapped);
        return { id: value.id, created: true };
      });
      reply(result.created ? 201 : 200, result); return;
    }
    const match = /^\/spaces\/([0-9a-f-]+)(?:\/(key|invites|members|leave|takeover|replace|report|block)(?:\/([0-9a-f-]+))?)?$/.exec(route);
    if (!match) fail(404, 'Not found');
    const [, spaceId, action, target] = match;
    requireValue(validId(spaceId) && (target === undefined || validId(target)), 'Invalid shared space');
    if (!action && !target && method === 'GET') { reply(200, spaceView(memberSpace(spaceId, account.id), account)); return; }
    if (!action && !target && method === 'DELETE') {
      change(() => {
        const space = ownedSpace(spaceId, account.id), old = space.replaces ? spaceRow(space.replaces) : undefined;
        // The frozen copy it replaced holds the same notes: whoever deletes the group expects those gone too.
        if (old?.replacedBy === space.id && old.ownerAccountId === account.id) deleteSpace(old.id);
        deleteSpace(space.id);
      });
      reply(200, { deleted: true }); return;
    }
    if (action === 'key' && !target && method === 'PUT') {
      const value = await body(req, 2 * MAX_SPACE_PREFS);
      requireValue(value.wrapped !== undefined || value.prefs !== undefined || value.nameEnvelope !== undefined, 'Nothing to save');
      if (value.wrapped !== undefined) envelopeSize(value.wrapped, 1024);
      if (value.prefs !== undefined) envelopeSize(value.prefs, MAX_SPACE_PREFS);
      if (value.nameEnvelope !== undefined) envelopeSize(value.nameEnvelope, 4096);
      change(() => {
        memberSpace(spaceId, account.id);
        if (value.wrapped !== undefined) run('INSERT INTO space_keys(accountId,spaceId,wrapped) VALUES(?,?,?) ON CONFLICT(accountId,spaceId) DO UPDATE SET wrapped=excluded.wrapped', account.id, spaceId, value.wrapped);
        if (value.prefs !== undefined && run('UPDATE space_keys SET prefs=? WHERE accountId=? AND spaceId=?', value.prefs, account.id, spaceId).changes !== 1) fail(409, 'Save the key first.');
        if (value.nameEnvelope !== undefined) run('UPDATE space_members SET nameEnvelope=? WHERE spaceId=? AND accountId=?', value.nameEnvelope, spaceId, account.id);
        // The key is safe under the member's own cloud now: the sealed copy can go.
        if (value.wrapped !== undefined) run('UPDATE space_invites SET envelope=NULL WHERE spaceId=? AND claimedBy=?', spaceId, account.id);
      });
      reply(200, { ok: true }); return;
    }
    if (action === 'invites' && !target && method === 'POST') {
      limit(`space:${vaultId}`, 30);
      const value = await body(req, MAX_METADATA_BODY);
      requireValue(validId(value.id) && validHash(value.claimTokenHash), 'Invalid invitation');
      envelopeSize(value.envelope, 4096);
      const expiresAt = clock() + INVITE_LIFETIME;
      change(() => {
        const space = ownedSpace(spaceId, account.id);
        requireJoinable(space);
        if (memberCount(space.id) >= MAX_SPACE_MEMBERS) fail(409, `A shared space can have ${MAX_SPACE_MEMBERS} people at most.`, { code: 'space-full' });
        run('DELETE FROM space_invites WHERE spaceId=? AND expiresAt<=?', space.id, clock());
        if (one('SELECT COUNT(*) AS count FROM space_invites WHERE spaceId=? AND claimedBy IS NULL', space.id).count >= MAX_OPEN_INVITES) fail(409, 'Too many open invitations. Withdraw one first.', { code: 'too-many-invites' });
        if (one('SELECT 1 FROM space_invites WHERE id=?', value.id)) fail(409, 'Choose another ID for this invitation.');
        run('INSERT INTO space_invites(id,spaceId,claimTokenHash,envelope,expiresAt) VALUES(?,?,?,?,?)', value.id, space.id, value.claimTokenHash, value.envelope, expiresAt);
      });
      reply(201, { id: value.id, expiresAt: isoTime(expiresAt) }); return;
    }
    if (action === 'invites' && target && method === 'DELETE') {
      change(() => {
        const space = ownedSpace(spaceId, account.id);
        if (run('DELETE FROM space_invites WHERE id=? AND spaceId=? AND claimedBy IS NULL', target, space.id).changes !== 1) fail(404, 'Invitation not found');
      });
      reply(200, { ok: true }); return;
    }
    if (action === 'members' && target && method === 'DELETE') {
      const members = change(() => {
        const space = ownedSpace(spaceId, account.id);
        if (target === account.id) fail(400, 'Leave the space to remove yourself.');
        if (!one('SELECT 1 FROM space_members WHERE spaceId=? AND accountId=?', space.id, target)) fail(404, 'Member not found');
        removeMember(space.id, target);
        return memberCount(space.id);
      });
      reply(200, { ok: true, members }); return;
    }
    // The notes are sealed, so a report holds only what its writer chooses to say.
    if (action === 'report' && !target && method === 'POST') {
      limit(`report:${account.id}`, 5);
      const value = await body(req, MAX_METADATA_BODY);
      requireValue(REPORT_REASONS.includes(value.reason) && (value.details === undefined || (typeof value.details === 'string' && value.details.length <= 2000)) && (value.about === undefined || validId(value.about)), 'Invalid report');
      const about = change(() => {
        memberSpace(spaceId, account.id);
        const named = value.about === undefined ? null : one('SELECT a.email FROM space_members m LEFT JOIN accounts a ON a.id=m.accountId WHERE m.spaceId=? AND m.accountId=?', spaceId, value.about) ?? fail(404, 'Member not found');
        // Each report is a mail to a person. Survives a restart, unlike the limit per minute.
        if (one('SELECT COUNT(*) AS count FROM space_reports WHERE accountId=? AND createdAt>?', account.id, clock() - DAY).count >= MAX_REPORTS_A_DAY) fail(429, 'You sent many reports today. Write to hello@jotdrop.net if there is more.');
        run('INSERT INTO space_reports(accountId,createdAt) VALUES(?,?)', account.id, clock());
        return named;
      });
      await sendMail({ to: REPORT_ADDRESS, kind: 'space-report', report: { reason: value.reason, from: account.email, about: about?.email ?? null, spaceId, details: value.details ?? '' } });
      reply(200, { ok: true }); return;
    }
    // Only the mark: the device then leaves or removes as usual, because removing takes a new key that only a device can make.
    if (action === 'block' && !target && method === 'POST') {
      const value = await body(req, MAX_METADATA_BODY);
      requireValue(validId(value.accountId), 'Invalid person');
      change(() => {
        memberSpace(spaceId, account.id);
        if (value.accountId === account.id) fail(400, 'You cannot block yourself.');
        if (!one('SELECT 1 FROM space_members WHERE spaceId=? AND accountId=?', spaceId, value.accountId)) fail(404, 'Member not found');
        run('INSERT OR IGNORE INTO space_blocks(accountId,blockedAccountId,createdAt) VALUES(?,?,?)', account.id, value.accountId, clock());
      });
      reply(200, { ok: true }); return;
    }
    if (action === 'leave' && !target && method === 'POST') {
      change(() => {
        const space = memberSpace(spaceId, account.id);
        if (space.ownerAccountId === account.id) { ownerGone(space); return; }
        removeMember(space.id, account.id);
        if (!memberCount(space.id)) deleteSpace(space.id);
      });
      reply(200, { ok: true }); return;
    }
    if (action === 'takeover' && !target && method === 'POST') {
      change(() => {
        const space = memberSpace(spaceId, account.id);
        if (!space.ownerGoneAt || space.replacedBy) fail(409, 'This shared space cannot be taken over.', { code: 'not-available' });
        if (!mayTakeOver(space, account.id)) fail(403, 'Another member can take over first. You can after a week.', { code: 'not-yet' });
        const live = liveSpaces(account.id);
        if (!isPlus(vaultId) && live >= 1) planLimit('shared-spaces', vaultId, 402, 'The free plan shares one note. JotDrop Plus shares more.');
        if (live >= MAX_OWN_SPACES) fail(409, `You can own ${MAX_OWN_SPACES} shared spaces at most.`, { code: 'too-many-spaces' });
        if (storageUsage(space.id) > roomForSpaces(account)) fail(507, 'This shared space does not fit in your storage.', { code: 'storage-full' });
        run('UPDATE spaces SET ownerAccountId=?,ownerGoneAt=NULL,frozenAt=NULL WHERE id=?', account.id, space.id);
        run('DELETE FROM space_invites WHERE spaceId=? AND claimedBy IS NULL', space.id);
      });
      reply(200, { ok: true }); return;
    }
    if (action === 'replace' && !target && method === 'POST') {
      const value = await body(req, MAX_METADATA_BODY);
      requireValue(validId(value.newSpaceId) && Number.isSafeInteger(value.expectedSequence) && value.expectedSequence >= 0, 'Invalid replacement');
      change(() => {
        const space = ownedSpace(spaceId, account.id), next = spaceRow(value.newSpaceId);
        if (!next || next.replaces !== space.id || next.ownerAccountId !== account.id) fail(404, 'Shared space not found');
        if (space.replacedBy === next.id) return;
        if (space.frozenAt) fail(409, 'This shared space is read-only.', { code: 'space-frozen' });
        const { sequence } = one('SELECT COALESCE(MAX(sequence),0) AS sequence FROM changes WHERE vaultId=?', space.id);
        if (sequence !== value.expectedSequence) fail(409, 'The space changed while it was being copied.', { code: 'space-changed', sequence });
        run('UPDATE spaces SET frozenAt=?,replacedBy=? WHERE id=?', clock(), next.id, space.id);
        run('DELETE FROM space_invites WHERE spaceId=? AND claimedBy IS NULL', space.id);
      });
      reply(200, { ok: true }); return;
    }
    fail(405, 'Method not allowed');
  }
  const assets = new Map([['/',[join(webRoot, 'index.html'), 'text/html']], ['/app.js', [join(webRoot, 'app.js'), 'text/javascript']], ['/style.css', [join(webRoot, 'style.css'), 'text/css']], ['/export.mjs', [join(webRoot, 'export.mjs'), 'text/javascript']], ['/note.mjs', [join(webRoot, 'note.mjs'), 'text/javascript']], ['/shared/crypto.mjs', [join(directory, 'shared/crypto.mjs'), 'text/javascript']], ['/shared/client.mjs', [join(directory, 'shared/client.mjs'), 'text/javascript']]]);
  assets.set('/ocr-worker.js', [join(webRoot, 'ocr-worker.js'), 'text/javascript']);
  assets.set('/privacy', [join(webRoot, 'privacy.html'), 'text/html']);
  assets.set('/terms', [join(webRoot, 'terms.html'), 'text/html']);
  assets.set('/.well-known/assetlinks.json', [join(webRoot, 'assetlinks.json'), 'application/json']);
  assets.set('/human', [join(webRoot, 'human.html'), 'text/html']);
  assets.set('/human.js', [join(webRoot, 'human.js'), 'text/javascript']);
  assets.set('/note-link.js', [join(webRoot, 'note-link.js'), 'text/javascript']);
  assets.set('/list-link.js', [join(webRoot, 'list-link.js'), 'text/javascript']);
  assets.set('/logo.svg', [join(webRoot, 'logo.svg'), 'image/svg+xml']);
  // The house fonts (SIL Open Font License), served from here like everything else the page loads.
  for (const name of ['instrument-sans.woff2', 'bricolage-grotesque.woff2', 'caveat.woff2']) assets.set(`/fonts/${name}`, [join(webRoot, 'fonts', name), 'font/woff2']);
  assets.set('/import.mjs', [join(webRoot, 'import.mjs'), 'text/javascript']);
  // An invitation link opens the app on its own path: /# is for the way back from Google or GitHub.
  assets.set('/join', [join(webRoot, 'index.html'), 'text/html']);
  assets.set('/family', [join(webRoot, 'index.html'), 'text/html']);
  for (const name of ['account.mjs', 'words.mjs', 'merge.mjs', 'diff.mjs', 'spaces.mjs', 'links.mjs', 'drawing.mjs', 'drawing-editor.mjs', 'mail.mjs', 'paper.mjs', 'expiry.mjs', 'list-links.mjs']) assets.set(`/shared/${name}`, [join(directory, 'shared', name), 'text/javascript']);
  assets.set('/vendor/hash-wasm.mjs', [join(directory, '../node_modules/hash-wasm/dist/index.esm.min.js'), 'text/javascript']);
  // The page's only inline script is its import map; allow exactly that content.
  const importMap = /<script type="importmap">([^<]*)<\/script>/.exec(readFileSync(join(webRoot, 'index.html'), 'utf8'))?.[1];
  const importMapSource = importMap === undefined ? '' : ` 'sha256-${createHash('sha256').update(importMap).digest('base64')}'`;
  for (const name of ['tesseract.esm.min.js', 'worker.min.js']) assets.set(`/ocr/${name}`, [join(directory, '../node_modules/tesseract.js/dist', name), 'text/javascript']);
  for (const variant of ['', 'simd-', 'relaxedsimd-']) {
    const name = `tesseract-core-${variant}lstm.wasm.js`;
    assets.set(`/ocr/${name}`, [join(directory, '../node_modules/tesseract.js-core', name), 'text/javascript']);
  }
  for (const lang of ['eng', 'nld']) assets.set(`/ocr/${lang}.traineddata.gz`, [join(directory, `../node_modules/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`), 'application/gzip']);
  // Turnstile's widget is the one script and frame from elsewhere, and only when the person check is on.
  const challenges = turnstile ? ' https://challenges.cloudflare.com' : '';
  let server, activeRequests = 0;
  server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'${importMapSource}${challenges}; worker-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:;${challenges ? ` frame-src${challenges};` : ''} base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      const actualPort = server.address().port;
      const hosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      const loopback = hosts.includes(req.headers.host), admin = Boolean(adminHost) && req.headers.host === adminHost;
      if (!loopback && !admin && (!publicHost || req.headers.host !== publicHost)) fail(403, 'Host not allowed');
      const origin = req.headers.origin;
      if (origin && (admin ? origin !== adminOrigin : origin !== (loopback ? `http://${req.headers.host}` : publicOrigin) && !corsOrigins.includes(origin))) fail(403, 'Origin not allowed');
      if (origin && !admin && corsOrigins.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      const url = new URL(req.url, `http://${req.headers.host}`), method = req.method, pathname = url.pathname;
      if (activeRequests >= maxConcurrentRequests) {
        res.setHeader('Retry-After', '1');
        res.setHeader('Connection', 'close');
        reply(503, { error: 'Cloud is busy. Retry later; your local draft was not uploaded.' }); return;
      }
      activeRequests++;
      // Hold capacity through response delivery, including slow readers and aborted uploads.
      res.once('close', () => { activeRequests--; });
      if (admin) { await adminRequest(req, res, reply, url, clientAddress(req)); return; }
      if (method === 'OPTIONS') {
        if (!origin || !corsOrigins.includes(origin)) fail(403, 'Origin not allowed');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-JotDrop-Vault,X-JotDrop-Device');
        res.writeHead(204); res.end(); return;
      }
      // HEAD too: link checkers such as Google Play's test a page with HEAD before they open it.
      if ((method === 'GET' || method === 'HEAD') && assets.has(pathname)) {
        const [filename, type] = assets.get(pathname);
        res.setHeader('Content-Type', type); res.end(readFileSync(filename)); return;
      }
      // The page for a link is the same for every link: the note arrives sealed and opens with the key after the #.
      if ((method === 'GET' || method === 'HEAD') && /^\/n\/[0-9a-f-]{36}$/.test(pathname)) {
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('X-Robots-Tag', 'noindex');
        res.end(readFileSync(join(webRoot, 'note.html')));
        return;
      }
      // The same for a list link: the page ticks and adds items with the key after the #, and never holds the list itself.
      if ((method === 'GET' || method === 'HEAD') && /^\/l\/[0-9a-f-]{36}$/.test(pathname)) {
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('X-Robots-Tag', 'noindex');
        res.end(readFileSync(join(webRoot, 'list.html')));
        return;
      }
      if (!pathname.startsWith('/api/v1/')) fail(404, 'Not found');
      const route = pathname.slice('/api/v1'.length);
      if (route.startsWith('/public-links/')) { await publicLinkRequest(req, reply, method, route, clientAddress(req)); return; }
      if (route.startsWith('/public-lists/')) { await publicListRequest(req, reply, method, route, clientAddress(req)); return; }
      if (method === 'POST' && route === '/vaults') {
        limit(`enroll:${clientAddress(req)}`, 10);
        if (!enrollmentToken || !equal(req.headers.authorization || '', `Bearer ${enrollmentToken}`)) fail(401, 'Invalid enrollment token');
        const value = await body(req, MAX_METADATA_BODY);
        deviceName(value.deviceName);
        requireValue(validHash(value.deviceTokenHash) && validHash(value.recoveryTokenHash), 'Invalid token hash');
        const created = transaction(() => {
          if (one('SELECT COUNT(*) AS count FROM vaults WHERE enrollmentHash=?', hash(enrollmentToken)).count >= enrollmentLimit) fail(409, 'This enrollment token has already been used');
          const vaultId = randomUUID();
          run('INSERT INTO vaults VALUES(?,?,?)', vaultId, value.recoveryTokenHash, hash(enrollmentToken));
          return addDevice(vaultId, value.deviceName, value.deviceTokenHash);
        });
        reply(201, created); return;
      }
      if (method === 'POST' && route === '/recover') {
        limit(`recover:${clientAddress(req)}`, 5);
        const value = await body(req, MAX_METADATA_BODY);
        deviceName(value.deviceName);
        requireValue(validId(value.vaultId) && validHash(value.deviceTokenHash), 'Invalid recovery request');
        // A space is only reachable through membership, never with a recovery code.
        const vault = one("SELECT recoveryHash FROM vaults WHERE id=? AND enrollmentHash<>'space'", value.vaultId);
        if (!validToken(value.recoveryToken) || !vault || !equal(hash(value.recoveryToken), vault.recoveryHash)) fail(401, 'Invalid recovery code');
        reply(201, transaction(() => addDevice(value.vaultId, value.deviceName, value.deviceTokenHash, value.replaceDeviceId))); return;
      }
      const claim = /^\/pairings\/([0-9a-f-]+)\/claim$/.exec(route);
      if (method === 'POST' && claim) {
        limit(`claim:${clientAddress(req)}`, 10);
        requireValue(validId(claim[1]), 'Invalid pairing ID');
        const value = await body(req, MAX_METADATA_BODY);
        const result = transaction(() => {
          const pairing = one('SELECT * FROM pairings WHERE id=?', claim[1]);
          if (!validToken(value.claimToken) || !pairing || !equal(hash(value.claimToken), pairing.claimTokenHash)) fail(401, 'Invalid pairing code');
          if (pairing.claimed) fail(409, 'Pairing code already used');
          if (pairing.expiresAt <= clock()) fail(410, 'Pairing code expired');
          if (one('SELECT revoked FROM devices WHERE id=?', pairing.creatorId)?.revoked !== 0) fail(401, 'Pairing device no longer has access');
          const created = addDevice(pairing.vaultId, pairing.deviceName, pairing.deviceTokenHash);
          run('UPDATE pairings SET claimed=1 WHERE id=?', pairing.id);
          return { ...created, envelope: pairing.envelope };
        });
        reply(201, result); return;
      }
      const ip = clientAddress(req);
      if (method === 'POST' && route === '/accounts') {
        requireAccounts();
        limit(`signup:${ip}`, 10);
        const value = await body(req, MAX_METADATA_BODY);
        const email = emailValue(value.email);
        deviceName(value.deviceName);
        requireValue(validHash(value.deviceTokenHash) && validHash(value.recoveryTokenHash), 'Invalid token hash');
        requirePermanentEmail(email);
        requireSignupRoom(ip);
        await requireHuman(value.human, ip);
        const credentials = await credentialValue(value);
        limit(`signup-email:${email}`, 3);
        const signupId = await startSignup(email, { ...credentials, vaultId: null, recoveryHash: value.recoveryTokenHash, deviceName: value.deviceName.trim(), deviceTokenHash: value.deviceTokenHash, newsletter: value.newsletter === true });
        reply(202, { status: 'verify-email', signupId }); return;
      }
      if (method === 'POST' && route === '/accounts/verify') {
        requireAccounts();
        limit(`code:${ip}`, 20);
        const value = await body(req, MAX_METADATA_BODY);
        requireValue(validId(value.signupId), 'Invalid signup request');
        let joined;
        reply(201, redeem('signups', 'id', value.signupId, (signup) => `signup:${signup.email}`, emailCode(`signup:${value.signupId}`, value.code), (signup) => {
          const email = signup.email;
          if (one('SELECT id FROM accounts WHERE email=?', email)) fail(409, 'This email address already has an account');
          run('DELETE FROM signups WHERE email=?', email);
          let vaultId = signup.vaultId, deviceId;
          if (vaultId) {
            if (one('SELECT id FROM accounts WHERE vaultId=?', vaultId)) fail(409, 'This cloud already has an account');
            if (one("SELECT 1 FROM vaults WHERE id=? AND enrollmentHash='space'", vaultId)) fail(403, 'A shared space cannot have an account.');
          }
          else {
            vaultId = randomUUID();
            run('INSERT INTO vaults VALUES(?,?,?)', vaultId, signup.recoveryHash, 'account');
            deviceId = addDevice(vaultId, signup.deviceName, signup.deviceTokenHash).deviceId;
          }
          const now = new Date(clock()).toISOString(), accountId = randomUUID();
          run('INSERT INTO accounts(id,email,vaultId,kdf,authHash,wrappedVaultKey,createdAt,passwordChangedAt) VALUES(?,?,?,?,?,?,?,?)', accountId, email, vaultId, signup.kdf, signup.authHash, signup.wrappedVaultKey, now, now);
          if (signupTrial > 0 && email !== reviewLogin?.email) startTrial(vaultId, signupTrial);
          if (!signup.vaultId) countSignup(ip);
          if (signup.newsletter) joined = joinNewsletter(accountId, email, now);
          return deviceId ? { vaultId, deviceId } : { vaultId };
        }));
        subscribe(joined); return;
      }
      if (method === 'POST' && route === '/auth/prelogin') {
        requireAccounts();
        limit(`prelogin:${ip}`, 30);
        const email = emailValue((await body(req, MAX_METADATA_BODY)).email);
        const account = one("SELECT kdf FROM accounts WHERE email=? AND kdf<>''", email);
        reply(200, { kdf: account ? JSON.parse(account.kdf) : { salt: createHmac('sha256', fakeSaltKey).update(email).digest().subarray(0, 16).toString('base64url'), ...DEFAULT_KDF } }); return;
      }
      if (method === 'POST' && route === '/auth/login') {
        requireAccounts();
        limit(`login:${ip}`, 10);
        const value = await body(req, MAX_METADATA_BODY);
        const email = emailValue(value.email);
        requireValue(validToken(value.authKey), 'Invalid login key');
        deviceName(value.deviceName);
        requireValue(validHash(value.deviceTokenHash), 'Invalid token hash');
        limit(`login-email:${email}`, 10);
        const account = one("SELECT * FROM accounts WHERE email=? AND authHash<>''", email);
        if (account && account.lockedUntil > clock()) fail(429, 'Too many attempts. Try again later.');
        if (!await checkAuthKey(value.authKey, account?.authHash)) {
          if (account) transaction(() => {
            run('UPDATE accounts SET failedLogins=failedLogins+1 WHERE id=?', account.id);
            run('UPDATE accounts SET failedLogins=0,lockedUntil=? WHERE id=? AND failedLogins>=10', clock() + LOCK_TIME, account.id);
          });
          fail(401, 'Invalid email or password');
        }
        const challengeId = randomUUID(), code = codeFor(email), factor = account.totpSecret ? 'totp' : 'email';
        transaction(() => {
          run('UPDATE accounts SET failedLogins=0 WHERE id=?', account.id);
          run('DELETE FROM login_challenges WHERE expiresAt<=?', clock());
          run('INSERT INTO login_challenges VALUES(?,?,?,?,?,?,0,?)', challengeId, account.id, value.deviceName.trim(), value.deviceTokenHash, factor, factor === 'email' ? codeHash(`login:${challengeId}`, code) : '', clock() + CODE_LIFETIME);
        });
        if (factor === 'email') await sendMail({ to: email, kind: 'login', code });
        reply(202, { challengeId, secondFactor: factor }); return;
      }
      if (method === 'POST' && route === '/auth/login/verify') {
        requireAccounts();
        limit(`code:${ip}`, 20);
        const value = await body(req, MAX_METADATA_BODY);
        requireValue(validId(value.challengeId), 'Invalid login request');
        let step = 0;
        reply(201, redeem('login_challenges', 'id', value.challengeId, (challenge) => `login:${challenge.accountId}`, (challenge) => {
          if (challenge.factor === 'email') return emailCode(`login:${challenge.id}`, value.code)(challenge);
          const account = one('SELECT * FROM accounts WHERE id=?', challenge.accountId);
          return (step = totpStep(account, account.totpSecret, value.code)) > 0;
        }, (challenge) => {
          const account = one('SELECT vaultId,wrappedVaultKey FROM accounts WHERE id=?', challenge.accountId);
          if (step) run('UPDATE accounts SET totpLastStep=? WHERE id=?', step, challenge.accountId);
          return { ...addDevice(account.vaultId, challenge.deviceName, challenge.deviceTokenHash, value.replaceDeviceId), wrappedVaultKey: account.wrappedVaultKey };
        })); return;
      }
      if (method === 'POST' && route === '/auth/reset/start') {
        requireAccounts();
        limit(`reset:${ip}`, 10);
        const email = emailValue((await body(req, MAX_METADATA_BODY)).email);
        limit(`reset-email:${email}`, 3);
        const account = one('SELECT id FROM accounts WHERE email=?', email), resetId = randomUUID(), code = newCode();
        // Same answer and timing for unknown, locked and known addresses; only a known, unlocked one gets mail.
        if (account && !codesLocked(`reset:${account.id}`)) {
          transaction(() => {
            run('DELETE FROM resets WHERE expiresAt<=? OR accountId=?', clock(), account.id);
            run('INSERT INTO resets VALUES(?,?,?,0,?)', resetId, account.id, codeHash(`reset:${resetId}`, code), clock() + CODE_LIFETIME);
          });
          sendMailLater({ to: email, kind: 'reset', code });
        }
        reply(202, { resetId }); return;
      }
      if (method === 'POST' && route === '/auth/reset/recover') {
        requireAccounts();
        limit(`code:${ip}`, 20);
        const value = await body(req, MAX_METADATA_BODY);
        requireValue(validId(value.resetId) && validToken(value.recoveryToken), 'Invalid reset request');
        const next = await newDeviceCredentials(value);
        reply(201, redeem('resets', 'id', value.resetId, (reset) => `reset:${reset.accountId}`, emailCode(`reset:${value.resetId}`, value.code), (reset) => {
          const account = one('SELECT a.id,a.vaultId,v.recoveryHash FROM accounts a JOIN vaults v ON v.id=a.vaultId WHERE a.id=?', reset.accountId);
          if (!equal(hash(value.recoveryToken), account.recoveryHash)) fail(401, 'Invalid recovery code');
          setCredentials(account.id, next);
          return addDevice(account.vaultId, value.deviceName, value.deviceTokenHash, value.replaceDeviceId);
        })); return;
      }
      if (method === 'POST' && route === '/auth/reset/approval') {
        requireAccounts();
        limit(`code:${ip}`, 20);
        const value = await body(req, MAX_METADATA_BODY);
        requireValue(validId(value.resetId) && validHash(value.claimTokenHash) && typeof value.publicKey === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value.publicKey), 'Invalid approval request');
        reply(201, redeem('resets', 'id', value.resetId, (reset) => `reset:${reset.accountId}`, emailCode(`reset:${value.resetId}`, value.code), (reset) => {
          const approvalId = randomUUID(), expiresAt = clock() + APPROVAL_LIFETIME;
          run('DELETE FROM device_approvals WHERE expiresAt<=?', clock());
          run('INSERT INTO device_approvals VALUES(?,?,?,?,NULL,?)', approvalId, reset.accountId, value.publicKey, value.claimTokenHash, expiresAt);
          return { approvalId, expiresAt: new Date(expiresAt).toISOString() };
        })); return;
      }
      const approval = /^\/auth\/reset\/approval\/([0-9a-f-]+)(\/complete)?$/.exec(route);
      if (method === 'POST' && approval) {
        // The new device polls here until the phone approves.
        limit(`approval:${ip}`, 60);
        requireValue(validId(approval[1]), 'Invalid approval ID');
        const value = await body(req, MAX_METADATA_BODY);
        const request = one('SELECT * FROM device_approvals WHERE id=?', approval[1]);
        if (!validToken(value.claimToken) || !request || !equal(hash(value.claimToken), request.claimTokenHash) || request.expiresAt <= clock()) fail(401, 'Invalid or expired approval');
        if (!approval[2]) { reply(200, { envelope: request.envelope }); return; }
        if (!request.envelope) fail(409, 'Not approved yet');
        // Without new password fields (sign-in with Google or GitHub) the password stays as it is.
        const next = value.authKey === undefined ? null : await newDeviceCredentials(value);
        if (!next) { deviceName(value.deviceName); requireValue(validHash(value.deviceTokenHash), 'Invalid token hash'); }
        reply(201, transaction(() => {
          if (run('DELETE FROM device_approvals WHERE id=? AND envelope IS NOT NULL', request.id).changes !== 1) fail(401, 'Invalid or expired approval');
          const account = one('SELECT id,vaultId FROM accounts WHERE id=?', request.accountId);
          if (next) setCredentials(account.id, next);
          return addDevice(account.vaultId, value.deviceName, value.deviceTokenHash, value.replaceDeviceId);
        })); return;
      }
      if (method === 'POST' && route === '/auth/reset/restart') {
        requireAccounts();
        limit(`code:${ip}`, 20);
        const value = await body(req, MAX_METADATA_BODY);
        requireValue(validId(value.resetId) && validHash(value.recoveryTokenHash) && value.confirm === 'DELETE CLOUD DATA', 'Confirm deleting the cloud data');
        const next = await newDeviceCredentials(value);
        reply(201, redeem('resets', 'id', value.resetId, (reset) => `reset:${reset.accountId}`, emailCode(`reset:${value.resetId}`, value.code), (reset) => {
          const account = one('SELECT id,vaultId FROM accounts WHERE id=?', reset.accountId), vaultId = randomUUID();
          // The vault key changes, so the wrapped space keys can no longer be opened.
          leaveAllSpaces(account);
          run('INSERT INTO vaults VALUES(?,?,?)', vaultId, value.recoveryTokenHash, 'account');
          run('UPDATE accounts SET vaultId=? WHERE id=?', vaultId, account.id);
          // The subscription belongs to the person, not to the deleted ciphertext.
          run('UPDATE plans SET vaultId=? WHERE vaultId=?', vaultId, account.vaultId);
          run('UPDATE trials SET vaultId=? WHERE vaultId=?', vaultId, account.vaultId);
          run('UPDATE subscriptions SET vaultId=? WHERE vaultId=?', vaultId, account.vaultId);
          setCredentials(account.id, next);
          run('DELETE FROM device_approvals WHERE accountId=?', account.id);
          // Nobody can read the old ciphertext any more; deleting it is what the user confirmed.
          for (const table of ['uploads', 'pairings', 'revisions', 'envelope_chunks', 'chunks', 'retired_envelopes', 'envelopes', 'changes', 'purges', 'signups', 'devices']) run(`DELETE FROM ${table} WHERE vaultId=?`, account.vaultId);
          run('DELETE FROM vaults WHERE id=?', account.vaultId);
          return addDevice(vaultId, value.deviceName, value.deviceTokenHash);
        })); return;
      }
      if (method === 'GET' && route === '/auth/providers') { reply(200, { providers: Object.keys(providers), googleClientId: providers.google?.clientId ?? null, turnstileSiteKey: turnstile?.siteKey ?? null }); return; }
      const oauthRoute = /^\/auth\/oauth\/([a-z]{1,20})\/(start|callback)$/.exec(route);
      if (method === 'GET' && oauthRoute) {
        requireAccounts();
        const provider = requireProvider(oauthRoute[1]), origin = publicOrigin ?? `http://${req.headers.host}`;
        const redirectUri = `${origin}/api/v1/auth/oauth/${oauthRoute[1]}/callback`;
        const go = (location) => { res.writeHead(302, { Location: location }); res.end(); };
        if (oauthRoute[2] === 'start') {
          limit(`oauth:${ip}`, 20);
          const client = url.searchParams.get('client'), challenge = url.searchParams.get('challenge');
          requireValue(Object.hasOwn(OAUTH_RETURN, client) && validHash(challenge), 'Invalid sign-in request');
          const state = randomBytes(32).toString('base64url');
          transaction(() => {
            run('DELETE FROM oauth_states WHERE expiresAt<=?', clock());
            run('INSERT INTO oauth_states VALUES(?,?,?,?,?)', hash(state), oauthRoute[1], client, challenge, clock() + OAUTH_LIFETIME);
          });
          go(`${provider.authorize}?${new URLSearchParams({ client_id: provider.clientId, redirect_uri: redirectUri, response_type: 'code', scope: provider.scope, state, ...provider.extra })}`); return;
        }
        const stateValue = url.searchParams.get('state');
        const state = validToken(stateValue) && transaction(() => {
          const row = one('SELECT * FROM oauth_states WHERE id=? AND provider=?', hash(stateValue), oauthRoute[1]);
          if (row) run('DELETE FROM oauth_states WHERE id=?', row.id);
          return row && row.expiresAt > clock() ? row : undefined;
        });
        if (!state) fail(400, 'This sign-in has expired. Start again.');
        const back = (query) => go(OAUTH_RETURN[state.client](origin, query.toString()));
        const code = url.searchParams.get('code');
        if (!code) { back(new URLSearchParams({ 'oauth-error': `${provider.name} sign-in was cancelled.` })); return; }
        let identity;
        try { identity = await providerIdentity(provider, code, redirectUri); }
        catch { back(new URLSearchParams({ 'oauth-error': `Could not sign in with ${provider.name}. Try again.` })); return; }
        const email = verifiedEmail(identity);
        if (!email) { back(new URLSearchParams({ 'oauth-error': `Your ${provider.name} account has no verified email address. Add one there, or use email and password.` })); return; }
        back(new URLSearchParams({ oauth: newTicket(oauthRoute[1], identity.subject, email, state.challenge) })); return;
      }
      if (method === 'POST' && route === '/auth/oauth/google/idtoken') {
        requireAccounts();
        limit(`oauth:${ip}`, 20);
        const value = await body(req, MAX_METADATA_BODY);
        requireValue(validHash(value.challenge), 'Invalid sign-in request');
        const identity = await googleIdentity(value.idToken, value.challenge), email = verifiedEmail(identity);
        if (!email) fail(401, 'Your Google account has no verified email address. Add one there, or use email and password.');
        reply(201, { ticket: newTicket('google', identity.subject, email, value.challenge) }); return;
      }
      if (method === 'POST' && route === '/auth/oauth/ticket') {
        requireAccounts();
        limit(`oauth:${ip}`, 20);
        const ticket = oauthTicket(await body(req, MAX_METADATA_BODY)), account = oauthAccount(ticket);
        reply(200, { provider: ticket.provider, email: ticket.email, account: Boolean(account), password: Boolean(account?.authHash) }); return;
      }
      if (method === 'POST' && route === '/auth/oauth/signup') {
        requireAccounts();
        limit(`signup:${ip}`, 10);
        const value = await body(req, MAX_METADATA_BODY);
        deviceName(value.deviceName);
        requireValue(validHash(value.deviceTokenHash) && validHash(value.recoveryTokenHash), 'Invalid token hash');
        let joined;
        reply(201, transaction(() => {
          requireSignupRoom(ip);
          const ticket = oauthTicket(value);
          if (oauthAccount(ticket)) fail(409, 'This email address already has an account. Sign in to it instead.', { code: 'account-exists' });
          run('DELETE FROM oauth_tickets WHERE id=?', ticket.id);
          const vaultId = randomUUID(), accountId = randomUUID(), now = new Date(clock()).toISOString();
          run('INSERT INTO vaults VALUES(?,?,?)', vaultId, value.recoveryTokenHash, 'account');
          // No password: '' never matches a login key, and "Forgot password" can add one later.
          run("INSERT INTO accounts(id,email,vaultId,kdf,authHash,wrappedVaultKey,createdAt,passwordChangedAt) VALUES(?,?,?,'','','',?,?)", accountId, ticket.email, vaultId, now, now);
          run('INSERT INTO identities VALUES(?,?,?,?)', ticket.provider, ticket.subject, accountId, now);
          if (signupTrial > 0) startTrial(vaultId, signupTrial);
          countSignup(ip);
          if (value.newsletter === true) joined = joinNewsletter(accountId, ticket.email, now);
          return addDevice(vaultId, value.deviceName, value.deviceTokenHash);
        }));
        subscribe(joined); return;
      }
      if (method === 'POST' && route === '/auth/oauth/approval') {
        requireAccounts();
        limit(`oauth:${ip}`, 20);
        const value = await body(req, MAX_METADATA_BODY);
        requireValue(validHash(value.claimTokenHash) && typeof value.publicKey === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value.publicKey), 'Invalid approval request');
        reply(201, transaction(() => {
          const ticket = oauthTicket(value), account = oauthAccount(ticket) ?? fail(404, 'No account for this sign-in. Create one first.');
          run('DELETE FROM oauth_tickets WHERE id=?', ticket.id);
          linkIdentity(ticket, account);
          const approvalId = randomUUID(), expiresAt = clock() + APPROVAL_LIFETIME;
          run('DELETE FROM device_approvals WHERE expiresAt<=?', clock());
          run('INSERT INTO device_approvals VALUES(?,?,?,?,NULL,?)', approvalId, account.id, value.publicKey, value.claimTokenHash, expiresAt);
          return { approvalId, expiresAt: new Date(expiresAt).toISOString() };
        })); return;
      }
      if (method === 'POST' && route === '/auth/oauth/recover') {
        requireAccounts();
        limit(`recover:${ip}`, 5);
        const value = await body(req, MAX_METADATA_BODY);
        deviceName(value.deviceName);
        requireValue(validHash(value.deviceTokenHash), 'Invalid token hash');
        reply(201, transaction(() => {
          const ticket = oauthTicket(value), account = oauthAccount(ticket) ?? fail(404, 'No account for this sign-in. Create one first.');
          const vault = one('SELECT recoveryHash FROM vaults WHERE id=?', account.vaultId);
          if (!validToken(value.recoveryToken) || !equal(hash(value.recoveryToken), vault.recoveryHash)) fail(401, 'Invalid recovery code');
          const created = addDevice(account.vaultId, value.deviceName, value.deviceTokenHash, value.replaceDeviceId);
          run('DELETE FROM oauth_tickets WHERE id=?', ticket.id);
          linkIdentity(ticket, account);
          return created;
        })); return;
      }
      if (method === 'POST' && route === '/stripe/webhook') {
        if (!stripe) fail(503, 'Payments are not available on this server.');
        // Unknown clouds and other event types are acknowledged too, so Stripe does not retry them.
        await applySubscription(stripeEvent(await bodyBytes(req, 256 * 1024), String(req.headers['stripe-signature'] || '')));
        reply(200, { received: true }); return;
      }
      // The mailin process next door: it alone sees a mail readable, for a moment, and hands over only sealed blobs.
      if (route === '/mailin/rcpt' || route === '/mailin/deliver') {
        if (!mailinToken || !loopback || method !== 'POST' || !equal(req.headers.authorization || '', `Bearer ${mailinToken}`)) fail(401, 'Mail delivery authorization required');
        if (route === '/mailin/rcpt') {
          const value = await body(req, MAX_METADATA_BODY);
          requireValue(validHash(value.addressHash) && (value.senderHash === undefined || validHash(value.senderHash)), 'Invalid mail lookup');
          const found = mailLookup(value);
          reply(200, found.accept ? { accept: true, publicKey: found.publicKey, vaultId: found.vaultId } : { accept: false, code: found.code }); return;
        }
        const value = await body(req, MAX_MAILIN_BODY);
        requireValue(validHash(value.addressHash) && (value.senderHash === undefined || validHash(value.senderHash)) && validId(value.id) && validToken(value.ephemeralKey)
          && typeof value.body === 'string' && Array.isArray(value.parts) && value.parts.length <= MAX_MAIL_PARTS && value.parts.every((part) => typeof part === 'string' && /^[A-Za-z0-9_-]*$/.test(part)), 'Invalid mail delivery');
        requireValue(/^[A-Za-z0-9_-]*$/.test(value.body), 'Invalid mail delivery');
        const sealedBody = Buffer.from(value.body, 'base64url'), sealedParts = value.parts.map((part) => Buffer.from(part, 'base64url'));
        const size = sealedBody.length + sealedParts.reduce((total, part) => total + part.length, 0);
        requireValue(sealedBody.length >= 28 && sealedParts.every((part) => part.length >= 28) && size <= MAX_MAIL_BYTES + 1024 * 1024, 'Invalid mail delivery');
        let outcome;
        try {
          outcome = transaction(() => {
            const found = mailLookup(value);
            if (!found.accept) return found;
            run('INSERT INTO mail_items(vaultId,id,receivedAt,size,ephemeralKey,sealed) VALUES(?,?,?,?,?,?)', found.vaultId, value.id, clock(), size, value.ephemeralKey, sealedBody);
            sealedParts.forEach((part, n) => run('INSERT INTO mail_parts(vaultId,itemId,n,sealed) VALUES(?,?,?,?)', found.vaultId, value.id, n, part));
            run('INSERT INTO mail_log(vaultId,receivedAt) VALUES(?,?)', found.vaultId, clock());
            return { accept: true };
          });
        } catch (error) {
          // A repeated delivery of the same mail already succeeded.
          if (sqliteCode(error) !== 19) throw error;
          outcome = { accept: true };
        }
        reply(200, outcome); return;
      }
      const vaultId = req.headers['x-jotdrop-vault'], deviceId = req.headers['x-jotdrop-device'];
      const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
      if (!validId(vaultId) || !validId(deviceId) || !validToken(token)) fail(401, 'Device authorization required');
      const device = one('SELECT * FROM devices WHERE id=?', deviceId);
      if (!device || device.revoked || !equal(hash(token), device.tokenHash)) fail(401, 'Device access denied');
      // A device belongs to its own cloud, and reaches a space when its account is a member.
      const inSpace = device.vaultId !== vaultId;
      if (inSpace && !memberOf(vaultId, device.vaultId)) fail(401, 'Device access denied');
      try { run('UPDATE devices SET lastSeenAt=? WHERE id=?', new Date(clock()).toISOString(), deviceId); }
      catch (error) {
        // Optional activity metadata must not deny access when storage cannot be written.
        if (![5, 6, 8, 10, 13].includes(sqliteCode(error))) throw error; // BUSY, LOCKED, READONLY, IOERR, FULL.
      }
      // Without this list a member could delete the space with /account/delete, add a device with /pairings or set /recovery.
      if (inSpace && !SPACE_ROUTES.some(([verb, pattern]) => verb === method && pattern.test(route))) fail(403, 'This is not available in a shared space.');
      // Members do not see each other's devices.
      const withoutDevice = (entry) => { if (!inSpace) return entry; const { deviceId: _hidden, ...rest } = entry; return rest; };
      if (route === '/account' && method === 'GET') {
        const account = accountFor(vaultId);
        reply(200, { email: account.email, totp: Boolean(account.totpSecret), password: Boolean(account.authHash), providers: all('SELECT provider FROM identities WHERE accountId=? ORDER BY provider', account.id).map((row) => row.provider) }); return;
      }
      if (route === '/account/totp' && method === 'POST') {
        requireAccounts();
        const account = accountFor(vaultId), secret = randomBytes(20);
        run('UPDATE accounts SET totpPending=? WHERE id=?', sealTotp(secret, account.id), account.id);
        const uri = `otpauth://totp/${encodeURIComponent(`JotDrop:${account.email}`)}?secret=${base32(secret)}&issuer=JotDrop`;
        reply(200, { secret: base32(secret), uri, qr: qrRows(uri) }); return;
      }
      if (route === '/account/totp/enable' && method === 'POST') {
        requireAccounts();
        limit(`totp:${vaultId}`, 10);
        const value = await body(req, MAX_METADATA_BODY);
        // The password is required, so a stolen device token cannot swap in another authenticator.
        const account = accountFor(vaultId);
        await requirePassword(account, value.currentAuthKey);
        const step = totpStep(account, account.totpPending, value.code);
        if (!step) fail(401, 'Invalid code');
        run('UPDATE accounts SET totpSecret=totpPending,totpPending=NULL,totpLastStep=? WHERE id=?', step, account.id);
        reply(200, { ok: true }); return;
      }
      if (route === '/account/totp/disable' && method === 'POST') {
        limit(`totp:${vaultId}`, 10);
        const value = await body(req, MAX_METADATA_BODY);
        const account = accountFor(vaultId);
        await requirePassword(account, value.currentAuthKey);
        run('UPDATE accounts SET totpSecret=NULL,totpPending=NULL WHERE id=?', account.id);
        reply(200, { ok: true }); return;
      }
      if (route === '/account/approvals' && method === 'GET') {
        const account = accountFor(vaultId);
        reply(200, { approvals: all('SELECT id,publicKey,expiresAt FROM device_approvals WHERE accountId=? AND envelope IS NULL AND expiresAt>? ORDER BY expiresAt', account.id, clock()).map((entry) => ({ ...entry, expiresAt: new Date(entry.expiresAt).toISOString() })) }); return;
      }
      const approve = /^\/account\/approvals\/([0-9a-f-]+)$/.exec(route);
      if (approve && (method === 'POST' || method === 'DELETE')) {
        const value = await body(req, MAX_METADATA_BODY);
        // The envelope is the vault key sealed to the new device's public key; the server cannot open it.
        if (method === 'POST') requireValue(typeof value.envelope === 'string' && value.envelope.length <= 2048, 'Invalid approval envelope');
        const account = accountFor(vaultId);
        transaction(() => {
          requireAccess(vaultId, deviceId);
          const where = 'id=? AND accountId=? AND envelope IS NULL AND expiresAt>?';
          const changed = method === 'POST' ? run(`UPDATE device_approvals SET envelope=? WHERE ${where}`, value.envelope, approve[1], account.id, clock()) : run(`DELETE FROM device_approvals WHERE ${where}`, approve[1], account.id, clock());
          if (changed.changes !== 1) fail(404, 'Approval request not found');
        });
        reply(200, { ok: true }); return;
      }
      if (route === '/account' && method === 'POST') {
        requireAccounts();
        limit(`signup:${ip}`, 10);
        const value = await body(req, MAX_METADATA_BODY);
        const email = emailValue(value.email);
        requirePermanentEmail(email);
        const credentials = await credentialValue(value);
        limit(`signup-email:${email}`, 3);
        const signupId = await startSignup(email, { ...credentials, vaultId, recoveryHash: null, deviceName: null, deviceTokenHash: null, newsletter: value.newsletter === true });
        reply(202, { status: 'verify-email', signupId }); return;
      }
      if (route === '/account/password' && method === 'POST') {
        limit(`password:${vaultId}`, 10);
        const value = await body(req, MAX_METADATA_BODY);
        const account = one('SELECT * FROM accounts WHERE vaultId=?', vaultId);
        if (!account) fail(404, 'No account for this cloud');
        const next = await credentialValue(value);
        await requirePassword(account, value.currentAuthKey);
        transaction(() => {
          requireAccess(vaultId, deviceId);
          if (run('UPDATE accounts SET kdf=?,authHash=?,wrappedVaultKey=?,passwordChangedAt=? WHERE id=? AND authHash=?', next.kdf, next.authHash, next.wrappedVaultKey, new Date(clock()).toISOString(), account.id, account.authHash).changes !== 1) fail(409, 'The password was changed elsewhere. Try again.');
          run('DELETE FROM login_challenges WHERE accountId=?', account.id);
          if (value.signOutOtherDevices === true) {
            run('UPDATE devices SET revoked=1 WHERE vaultId=? AND id<>?', vaultId, deviceId);
            run('DELETE FROM uploads WHERE vaultId=? AND deviceId<>?', vaultId, deviceId);
            run('DELETE FROM chunks WHERE claimed=0 AND deviceId IN (SELECT id FROM devices WHERE vaultId=? AND id<>?)', vaultId, deviceId);
          }
        });
        reply(200, { ok: true }); return;
      }
      // Deletes the whole cloud and its account; the notes on the person's own devices stay. A running subscription is
      // cancelled first, so nobody keeps paying for a deleted cloud; if Stripe cannot cancel it, nothing is deleted.
      if (route === '/account/delete' && method === 'POST') {
        limit(`delete:${vaultId}`, 5);
        const value = await body(req, MAX_METADATA_BODY);
        requireValue(value.confirm === 'DELETE MY CLOUD', 'Confirm deleting the cloud');
        const account = one('SELECT * FROM accounts WHERE vaultId=?', vaultId);
        // With a password, a stolen device token cannot delete the owner's cloud.
        if (account?.authHash) await requirePassword(account, value.currentAuthKey);
        await cancelPlus(vaultId);
        transaction(() => {
          requireAccess(vaultId, deviceId);
          wipeCloud(vaultId, account);
        });
        if (account) forgetAddress(account, 'account-deleted');
        reply(200, { deleted: true }); return;
      }
      if (route === '/recovery' && method === 'POST') {
        limit(`recovery:${vaultId}`, 5);
        const value = await body(req, MAX_METADATA_BODY);
        requireValue(validHash(value.recoveryTokenHash), 'Invalid token hash');
        // With an account the password is required, so a stolen device token cannot replace the owner's recovery code.
        const account = one('SELECT * FROM accounts WHERE vaultId=?', vaultId);
        if (account) await requirePassword(account, value.currentAuthKey);
        transaction(() => {
          requireAccess(vaultId, deviceId);
          run('UPDATE vaults SET recoveryHash=? WHERE id=?', value.recoveryTokenHash, vaultId);
        });
        if (account) sendMailLater({ to: account.email, kind: 'recovery-changed' });
        reply(200, { ok: true }); return;
      }
      if (route === '/account/roadmap' && method === 'GET') {
        reply(200, roadmapView(accountFor(vaultId), vaultId)); return;
      }
      if (route === '/account/roadmap' && method === 'POST') {
        const account = accountFor(vaultId), value = await body(req, MAX_METADATA_BODY);
        requireValue(typeof value.itemId === 'string' && typeof value.vote === 'boolean', 'Invalid vote');
        if (!roadmapIds.has(value.itemId)) fail(404, 'This idea is not on the list any more.');
        transaction(() => {
          requireAccess(vaultId, deviceId);
          if (!value.vote) { run('DELETE FROM roadmap_votes WHERE accountId=? AND itemId=?', account.id, value.itemId); return; }
          if (!isPlus(vaultId)) planLimit('voting', vaultId, 402, 'Voting is part of JotDrop Plus.');
          const mine = myVotes(account.id);
          if (mine.includes(value.itemId)) return;
          if (mine.length >= MAX_VOTES) fail(409, `You can vote for ${MAX_VOTES} ideas at a time. Take back a vote first.`, { code: 'too-many-votes' });
          run('INSERT INTO roadmap_votes(accountId,itemId,votedAt) VALUES(?,?,?) ON CONFLICT DO NOTHING', account.id, value.itemId, clock());
        });
        reply(200, roadmapView(account, vaultId)); return;
      }
      if (route === '/mail' && method === 'GET') {
        reply(200, { items: all('SELECT id,receivedAt,size FROM mail_items WHERE vaultId=? ORDER BY receivedAt,id', vaultId).map((item) => ({ ...item, receivedAt: new Date(item.receivedAt).toISOString() })) }); return;
      }
      if (route === '/mail' && method === 'POST') {
        limit(`mail:${vaultId}`, 10);
        const value = await body(req, MAX_METADATA_BODY);
        if (value.action === 'mode') {
          requireValue(['open', 'senders'].includes(value.mode), 'Invalid mail mode');
          transaction(() => {
            requireAccess(vaultId, deviceId);
            if (run('UPDATE mail_accounts SET mode=? WHERE vaultId=?', value.mode, vaultId).changes !== 1) fail(404, 'Mail to JotDrop is not on for this cloud.');
          });
          reply(200, { mail: mailStatus(vaultId) }); return;
        }
        requireValue(value.action === 'enable' && validToken(value.publicKey) && validHash(value.addressHash), 'Invalid mail settings');
        envelopeSize(value.addressEnvelope, 4096);
        const mode = value.mode ?? 'open';
        requireValue(['open', 'senders'].includes(mode), 'Invalid mail mode');
        if (!mailDomain) fail(503, 'Mail to JotDrop is not available on this server.');
        transaction(() => {
          requireAccess(vaultId, deviceId);
          if (!isPlus(vaultId)) planLimit('mail', vaultId, 402, 'Mail to JotDrop is part of JotDrop Plus.');
          try {
            run('INSERT INTO mail_accounts(vaultId,addressHash,publicKey,addressEnvelope,mode,createdAt) VALUES(?,?,?,?,?,?) ON CONFLICT(vaultId) DO UPDATE SET addressHash=excluded.addressHash,publicKey=excluded.publicKey,addressEnvelope=excluded.addressEnvelope,mode=excluded.mode,rotatedAt=excluded.createdAt', vaultId, value.addressHash, value.publicKey, value.addressEnvelope, mode, clock());
          } catch (error) {
            if (sqliteCode(error) === 19) fail(409, 'That address is taken. Try another one.');
            throw error;
          }
        });
        reply(200, { mail: mailStatus(vaultId) }); return;
      }
      if (route === '/mail' && method === 'DELETE') {
        // Turning it off keeps the sealed items: they are the person's mail, still there to convert.
        transaction(() => {
          requireAccess(vaultId, deviceId);
          run('DELETE FROM mail_accounts WHERE vaultId=?', vaultId);
          run('DELETE FROM mail_senders WHERE vaultId=?', vaultId);
        });
        reply(200, { mail: mailStatus(vaultId) }); return;
      }
      if (route === '/mail/senders' && method === 'POST') {
        const value = await body(req, MAX_METADATA_BODY);
        requireValue(Array.isArray(value.senders) && value.senders.length <= MAX_MAIL_SENDERS && value.senders.every(validHash), 'Invalid sender list');
        transaction(() => {
          requireAccess(vaultId, deviceId);
          if (!one('SELECT 1 FROM mail_accounts WHERE vaultId=?', vaultId)) fail(404, 'Mail to JotDrop is not on for this cloud.');
          run('DELETE FROM mail_senders WHERE vaultId=?', vaultId);
          for (const senderHash of new Set(value.senders)) run('INSERT INTO mail_senders(vaultId,senderHash,createdAt) VALUES(?,?,?)', vaultId, senderHash, clock());
        });
        reply(200, { ok: true }); return;
      }
      const mailTarget = /^\/mail\/([0-9a-f-]{36})(?:\/parts\/([0-9]{1,2}))?$/.exec(route);
      if (mailTarget && method === 'GET') {
        const item = one('SELECT id,receivedAt,size,ephemeralKey,sealed FROM mail_items WHERE vaultId=? AND id=?', vaultId, mailTarget[1]) ?? fail(404, 'Mail not found');
        if (mailTarget[2] !== undefined) {
          const part = one('SELECT sealed FROM mail_parts WHERE vaultId=? AND itemId=? AND n=?', vaultId, item.id, Number(mailTarget[2])) ?? fail(404, 'Mail part not found');
          reply(200, { sealed: Buffer.from(part.sealed).toString('base64url') }); return;
        }
        reply(200, { id: item.id, receivedAt: new Date(item.receivedAt).toISOString(), size: item.size, ephemeralKey: item.ephemeralKey, body: Buffer.from(item.sealed).toString('base64url'),
          parts: all('SELECT n,LENGTH(sealed) AS size FROM mail_parts WHERE vaultId=? AND itemId=? ORDER BY n', vaultId, item.id) }); return;
      }
      if (mailTarget && !mailTarget[2] && method === 'DELETE') {
        transaction(() => {
          requireAccess(vaultId, deviceId);
          run('DELETE FROM mail_parts WHERE vaultId=? AND itemId=?', vaultId, mailTarget[1]);
          if (run('DELETE FROM mail_items WHERE vaultId=? AND id=?', vaultId, mailTarget[1]).changes !== 1) fail(404, 'Mail not found');
        });
        reply(200, { ok: true }); return;
      }
      if (route === '/account/trial' && method === 'POST') {
        const plusUntil = transaction(() => {
          requireAccess(vaultId, deviceId);
          const plan = planRow(vaultId);
          if (plan.trialUsed) fail(409, 'The free trial was already used.');
          if (plan.plusUntil > clock()) fail(409, 'This cloud already has JotDrop Plus.');
          return startTrial(vaultId);
        });
        reply(200, { plusUntil: new Date(plusUntil).toISOString() }); return;
      }
      if (route === '/account/checkout' && method === 'POST') {
        if (!stripe) fail(503, 'Payments are not available on this server.');
        limit(`checkout:${vaultId}`, 10);
        const value = await body(req, MAX_METADATA_BODY);
        requireValue(['month', 'year'].includes(value.interval) && [undefined, 'plus', 'family'].includes(value.plan) && [undefined, 'eur', 'usd'].includes(value.currency), 'Choose a monthly or yearly plan');
        const family = value.plan === 'family';
        if (family && !familyPrices.length) fail(503, 'The family plan is not available on this server.');
        if (subscribed(vaultId)) fail(409, 'This cloud already has a JotDrop Plus subscription. Manage it at link.com.');
        const origin = publicOrigin ?? `http://${req.headers.host}`, account = one('SELECT id,email FROM accounts WHERE vaultId=?', vaultId);
        if (family && !account) fail(403, 'The family plan needs an account. Add one to this cloud first.', { code: 'account-required' });
        const price = family ? (value.interval === 'month' ? stripe.familyMonthPrice : founderPrice() && stripe.familyFounderYearPrice ? stripe.familyFounderYearPrice : stripe.familyYearPrice)
          : value.interval === 'month' ? stripe.monthPrice : founderPrice() ? stripe.founderYearPrice : stripe.yearPrice;
        // The session expires after 30 minutes (Stripe's minimum), so an old open one is not paid next to a newer one.
        const form = new URLSearchParams({ mode: 'subscription', 'managed_payments[enabled]': 'true', 'line_items[0][price]': price,
          'line_items[0][quantity]': '1', client_reference_id: vaultId, 'subscription_data[metadata][vaultId]': vaultId, success_url: `${origin}/?plus=welcome`, cancel_url: `${origin}/`, expires_at: String(Math.floor(clock() / 1000) + 30 * 60) });
        if (account) { form.set('subscription_data[metadata][accountId]', account.id); form.set('customer_email', account.email); }
        // The prices carry a fixed dollar amount next to the euro one. Without a currency Stripe shows euros or converts to the local currency.
        // A founder price has no dollar amount, so it stays in euros.
        if (value.currency === 'usd' && price !== stripe.founderYearPrice && price !== stripe.familyFounderYearPrice) form.set('currency', 'usd');
        let session;
        try {
          const response = await stripeCall('/checkout/sessions', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
          session = await response.json();
          if (!response.ok || typeof session.url !== 'string' || !session.url.startsWith('https://checkout.stripe.com/')) throw new Error('Stripe refused the checkout');
        } catch { fail(502, 'Could not start the payment. Try again later.'); }
        reply(200, { url: session.url }); return;
      }
      if (route === '/spaces' || route.startsWith('/spaces/') || route.startsWith('/invites/')) { await spaceRequest(req, reply, method, route, vaultId, deviceId, ip); return; }
      if (route === '/links' || route.startsWith('/links/')) {
        const account = one('SELECT id,email,vaultId FROM accounts WHERE vaultId=?', vaultId) ?? fail(403, 'Links need an account. Add one to this cloud first.', { code: 'account-required' });
        await linkRequest(req, reply, method, route, account, vaultId, deviceId);
        return;
      }
      if (route === '/list-links' || route.startsWith('/list-links/')) {
        const account = one('SELECT id,email,vaultId FROM accounts WHERE vaultId=?', vaultId) ?? fail(403, 'Links need an account. Add one to this cloud first.', { code: 'account-required' });
        await listLinkRequest(req, reply, method, route, account, vaultId, deviceId);
        return;
      }
      if (route === '/family' || route.startsWith('/family/')) {
        const account = one('SELECT id,email,vaultId FROM accounts WHERE vaultId=?', vaultId) ?? fail(403, 'The family plan needs an account. Add one to this cloud first.', { code: 'account-required' });
        await familyRequest(req, reply, method, route, account, vaultId, deviceId);
        return;
      }
      if (method === 'GET' && route === '/status' && inSpace) {
        // What a member needs to read and write; the owner's billing and own usage stay private.
        const plus = isPlus(vaultId);
        reply(200, { usedBytes: storageUsage(vaultId), quotaBytes: Math.floor(quotaFor(vaultId) / 2), plan: { name: plus ? 'plus' : 'free', historyDays: plus ? null : FREE_HISTORY / DAY }, sequence: one('SELECT COALESCE(MAX(sequence),0) AS sequence FROM changes WHERE vaultId=?', vaultId).sequence, pieces: { version: 1, pieceBytes: PIECE_BYTES, maxFileBytes: maxFileFor(vaultId), legacy: 0 } }); return;
      }
      if (method === 'GET' && route === '/status') {
        const plan = planRow(vaultId), plus = plan.plusUntil > clock(), owner = one('SELECT id,vaultId FROM accounts WHERE vaultId=?', vaultId);
        reply(200, { usedBytes: one('SELECT (SELECT COALESCE(SUM(size),0) FROM envelopes WHERE vaultId=?) + (SELECT COALESCE(SUM(size),0) FROM chunks WHERE vaultId=?) AS size', vaultId, vaultId).size + (owner ? liveSpaceBytes(owner.id) : 0), quotaBytes: quotaFor(vaultId), plan: { name: plus ? 'plus' : 'free', plusUntil: plan.plusUntil ? new Date(plan.plusUntil).toISOString() : null, trialAvailable: !plan.trialUsed && !plus, trialEnds: trialEnds(plan) ? new Date(plan.trialUntil).toISOString() : null, deviceLimit: plus ? null : freeDeviceLimit, historyDays: plus ? null : FREE_HISTORY / DAY, subscribed: subscribed(vaultId), checkout: Boolean(stripe), founderPrice: founderPrice(), familyCheckout: familyPrices.length > 0, family: familyRole(owner), supporter: owner ? supporter(vaultId, owner) : subscribed(vaultId), early: plus }, mail: mailStatus(vaultId), features: featuresFor(plus), sequence: one('SELECT COALESCE(MAX(sequence),0) AS sequence FROM changes WHERE vaultId=?', vaultId).sequence, history: historyUsage(vaultId), transport: { version: 1, chunkBytes: TRANSFER_CHUNK_BYTES, reservedBytes: one('SELECT COALESCE(SUM(reservedBytes),0) AS size FROM uploads WHERE vaultId=?', vaultId).size }, pieces: { version: 1, pieceBytes: PIECE_BYTES, maxFileBytes: maxFileFor(vaultId), legacy: one('SELECT COUNT(*) AS count FROM envelopes WHERE vaultId=? AND pieces=0 AND size>?', vaultId, LEGACY_ENVELOPE_BYTES).count } }); return;
      }
      if (method === 'GET' && route === '/changes') {
        const after = Number(url.searchParams.get('after') || 0);
        requireValue(Number.isSafeInteger(after) && after >= 0, 'Invalid changes cursor');
        const changes = all('SELECT sequence,id,revision,deleted,size,updatedAt,deviceId FROM changes WHERE vaultId=? AND sequence>? ORDER BY sequence LIMIT 501', vaultId, after);
        const hasMore = changes.length > 500;
        if (hasMore) changes.pop();
        reply(200, { changes: changes.map((entry) => withoutDevice({ ...entry, deleted: Boolean(entry.deleted) })), cursor: changes.at(-1)?.sequence ?? after, hasMore }); return;
      }
      if (method === 'GET' && route === '/snapshot') {
        // Each file as it was at a moment: its last version saved at or before it, deleted ones included.
        const at = url.searchParams.get('at'), after = url.searchParams.get('after') || '', pageSize = Number(url.searchParams.get('limit') || 500);
        requireValue(Number.isFinite(Date.parse(at)) && (!after || validHash(after)) && Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= 500, 'Invalid snapshot request');
        const cutoff = lockedBefore(vaultId);
        // A full free cloud may have cleared the version from then: a gap in revision numbers, or a file whose
        // first remaining version is newer. That file is reported as cleared, never left out or replaced by an older version.
        // ponytail: scans the vault's revision rows per page; index revisions by time if large vaults make this slow.
        const objects = all('SELECT o.id,o.first,r.revision,r.deleted,r.size,r.updatedAt,(SELECT n.revision FROM revisions n WHERE n.vaultId=o.vaultId AND n.id=o.id AND n.revision>r.revision ORDER BY n.revision LIMIT 1) AS nextRevision,(SELECT n.updatedAt FROM revisions n WHERE n.vaultId=o.vaultId AND n.id=o.id AND n.revision>r.revision ORDER BY n.revision LIMIT 1) AS replacedAt,(SELECT p.revision FROM purges p WHERE p.vaultId=o.vaultId AND p.id=o.id) AS purgedRevision FROM (SELECT vaultId,id,MIN(revision) AS first FROM revisions WHERE vaultId=? AND id>? GROUP BY id) o LEFT JOIN revisions r ON r.vaultId=o.vaultId AND r.id=o.id AND r.revision=(SELECT MAX(m.revision) FROM revisions m WHERE m.vaultId=o.vaultId AND m.id=o.id AND m.updatedAt<=?) WHERE r.revision IS NOT NULL OR o.first>1 ORDER BY o.id LIMIT ?', vaultId, after, new Date(at).toISOString(), pageSize + 1);
        const hasMore = objects.length > pageSize;
        if (hasMore) objects.pop();
        // A note deleted forever is left out of every moment until it was saved again: its tombstone is all that is
        // left, and before it there is nothing (its first remaining version is the tombstone).
        const forgotten = (entry) => entry.purgedRevision !== null && (entry.revision === entry.purgedRevision || entry.revision === null && entry.first === entry.purgedRevision);
        reply(200, { objects: objects.filter((entry) => !forgotten(entry)).map(({ first, nextRevision, replacedAt, purgedRevision, ...entry }) => {
          if (entry.revision === null) return { id: entry.id, revision: null, deleted: false, size: 0, updatedAt: null, locked: true, cleared: true };
          const cleared = nextRevision !== null && nextRevision !== entry.revision + 1;
          return { ...entry, deleted: Boolean(entry.deleted), locked: cleared || Boolean(cutoff) && (replacedAt ? replacedAt < cutoff : Boolean(entry.deleted) && entry.updatedAt < cutoff), cleared };
        }), cursor: objects.at(-1)?.id ?? after, hasMore }); return;
      }
      if (method === 'GET' && route === '/devices') { reply(200, { devices: all('SELECT id,name,createdAt,lastSeenAt,revoked FROM devices WHERE vaultId=? ORDER BY createdAt', vaultId).map((entry) => ({ ...entry, revoked: Boolean(entry.revoked) })) }); return; }
      const revoke = /^\/devices\/([0-9a-f-]+)$/.exec(route);
      if (method === 'DELETE' && revoke) {
        transaction(() => {
          requireAccess(vaultId, deviceId);
          const target = one('SELECT * FROM devices WHERE vaultId=? AND id=?', vaultId, revoke[1]);
          if (!target) fail(404, 'Device not found');
          if (!target.revoked && one('SELECT COUNT(*) AS count FROM devices WHERE vaultId=? AND revoked=0', vaultId).count <= 1) fail(409, 'Cannot revoke the only active device');
          run('UPDATE devices SET revoked=1 WHERE id=? AND vaultId=?', target.id, vaultId);
          run('DELETE FROM uploads WHERE vaultId=? AND deviceId=?', vaultId, target.id);
          dropDevicePieces(target.id);
        });
        reply(200, { ok: true }); return;
      }
      if (method === 'POST' && route === '/pairings') {
        limit(`pairing:${vaultId}`, 10);
        const value = await body(req, MAX_METADATA_BODY);
        deviceName(value.deviceName);
        requireValue(validHash(value.deviceTokenHash) && validHash(value.claimTokenHash), 'Invalid pairing token hashes');
        envelopeSize(value.envelope, 8192);
        const result = transaction(() => {
          requireAccess(vaultId, deviceId);
          // Say so before the code is scanned, not after.
          const active = devicesAtLimit(vaultId);
          if (active.length) deviceLimitReached(vaultId, active);
          const now = clock(), pairingId = randomUUID(), expiresAt = now + 600000;
          run('DELETE FROM pairings WHERE vaultId=? AND expiresAt<=?', vaultId, now);
          if (one('SELECT COUNT(*) AS count FROM pairings WHERE vaultId=?', vaultId).count >= maxPairingEntries) fail(507, 'Cloud pairing metadata safety limit reached. Wait for existing codes to expire.');
          run('INSERT INTO pairings(id,vaultId,deviceName,deviceTokenHash,claimTokenHash,envelope,expiresAt,creatorId) VALUES(?,?,?,?,?,?,?,?)', pairingId, vaultId, value.deviceName, value.deviceTokenHash, value.claimTokenHash, value.envelope, expiresAt, deviceId);
          return { pairingId, expiresAt: new Date(expiresAt).toISOString() };
        });
        reply(201, result); return;
      }
      if (method === 'GET' && route === '/pieces/legacy') {
        // Versions a device can move into pieces: each with the newest revision that uses it, for reading it.
        const after = url.searchParams.get('after') || '';
        requireValue(after === '' || /^[0-9a-f]{64}\.[0-9a-f]{64}$/.test(after), 'Invalid cursor');
        const [afterId = '', afterHash = ''] = after.split('.');
        const rows = all('SELECT e.id,e.envelopeHash,(SELECT MAX(r.revision) FROM revisions r WHERE r.vaultId=e.vaultId AND r.id=e.id AND r.envelopeHash=e.envelopeHash) AS revision FROM envelopes e WHERE e.vaultId=? AND e.pieces=0 AND e.size>? AND (e.id,e.envelopeHash)>(?,?) ORDER BY e.id,e.envelopeHash LIMIT 101', vaultId, LEGACY_ENVELOPE_BYTES, afterId, afterHash);
        const hasMore = rows.length > 100;
        if (hasMore) rows.pop();
        // A version the free plan locked cannot be read, so it is not offered; the cloud may clear it when full.
        const open = (row) => { try { requireOpenVersion(vaultId, row.id, row.revision); return true; } catch (error) { if (error.status === 402) return false; throw error; } };
        reply(200, { objects: rows.filter((row) => row.revision !== null && open(row)), cursor: rows.length ? `${rows.at(-1).id}.${rows.at(-1).envelopeHash}` : after, hasMore }); return;
      }
      if (method === 'POST' && route === '/chunks/missing') {
        const value = await body(req, MAX_METADATA_BODY);
        requireValue(Array.isArray(value.names) && value.names.length <= MAX_PIECES && value.names.every(validHash), 'Invalid piece names');
        reply(200, { missing: value.names.filter((name) => !one('SELECT 1 FROM chunks WHERE vaultId=? AND name=?', vaultId, name)) }); return;
      }
      const piece = /^\/chunks\/([0-9a-f]{64})$/.exec(route);
      if (piece && method === 'PUT') {
        requireValue(req.headers['content-type'] === 'application/octet-stream', 'Expected binary content type');
        const bytes = await bodyBytes(req, PIECE_BYTES + 28);
        requireValue(bytes.length >= 28 && hash(bytes) === piece[1], 'Encrypted piece hash mismatch');
        transaction(() => {
          requireAccess(vaultId, deviceId);
          pruneUploads(vaultId);
          if (one('SELECT 1 FROM chunks WHERE vaultId=? AND name=?', vaultId, piece[1])) return;
          requireWritable(vaultId, deviceId, '');
          // Enough for the largest file twice over; a piece no version uses is cleared after a day.
          // In a space the limit is per device, so one member's unfinished uploads cannot block the others.
          const pending = inSpace ? one('SELECT COUNT(*) AS count FROM chunks WHERE vaultId=? AND claimed=0 AND deviceId=?', vaultId, deviceId).count : one('SELECT COUNT(*) AS count FROM chunks WHERE vaultId=? AND claimed=0', vaultId).count;
          if (pending >= (inSpace ? MAX_PIECES : 2 * MAX_PIECES)) fail(507, 'Cloud pending upload limit reached');
          if (!fits(vaultId, bytes.length, deviceId, '')) storageFull(vaultId);
          run('INSERT INTO chunks(vaultId,name,size,data,createdAt,deviceId) VALUES(?,?,?,?,?,?)', vaultId, piece[1], bytes.length, bytes, clock(), inSpace ? deviceId : null);
        });
        reply(200, { ok: true }); return;
      }
      if (piece && method === 'GET') {
        const row = one('SELECT data FROM chunks WHERE vaultId=? AND name=?', vaultId, piece[1]);
        if (!row) fail(404, 'Encrypted piece not found');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': row.data.length });
        res.end(Buffer.from(row.data)); return;
      }
      if (piece) fail(405, 'Method not allowed');
      const upload = /^\/objects\/([0-9a-f]{64})\/uploads\/(0|[1-9][0-9]*)\/([0-9a-f]{64})(\/commit)?$/.exec(route);
      if (upload) {
        const [, id, base, envelopeHash, commit] = upload, baseRevision = Number(base);
        requireValue(Number.isSafeInteger(baseRevision) && baseRevision < Number.MAX_SAFE_INTEGER, 'Invalid base revision');
        const key = [vaultId, deviceId, id, baseRevision, envelopeHash];
        const where = 'vaultId=? AND deviceId=? AND id=? AND baseRevision=? AND envelopeHash=?';
        // Immutable history is the receipt, even when the commit response was lost or newer edits exist.
        const receipt = () => {
          const saved = one('SELECT r.revision,c.sequence FROM revisions r JOIN changes c USING(vaultId,id,revision) WHERE r.vaultId=? AND r.deviceId=? AND r.id=? AND r.revision=? AND r.envelopeHash=? ORDER BY c.sequence LIMIT 1', vaultId, deviceId, id, baseRevision + 1, envelopeHash);
          return saved ? { committed: { id, ...saved } } : undefined;
        };
        const pending = () => {
          const row = one(`SELECT * FROM uploads WHERE ${where}`, ...key);
          if (!row) fail(404, 'Upload not found');
          if (row.expiresAt <= clock()) fail(410, 'Upload expired; prepare a new upload');
          return row;
        };
        if (method === 'GET' && !commit) {
          const saved = receipt();
          if (saved) { reply(200, saved); return; }
          const row = pending();
          reply(200, { offset: row.data.length, size: row.size }); return;
        }
        if (method === 'POST' && !commit) {
          const value = await body(req, MAX_METADATA_BODY);
          requireValue(Number.isSafeInteger(value.size) && value.size >= 28 && value.size <= 6 * 1024 * 1024, 'Invalid binary envelope size');
          const reservedBytes = Buffer.byteLength(JSON.stringify({ v: 1, iv: 'A'.repeat(16), ciphertext: '' })) + Math.ceil((value.size - 12) * 4 / 3);
          requireValue(reservedBytes <= 8 * 1024 * 1024, 'Invalid envelope size');
          const result = transaction(() => {
            requireAccess(vaultId, deviceId);
            const saved = receipt();
            if (saved) return saved;
            pruneUploads(vaultId);
            const existing = one(`SELECT size,length(data) AS offset FROM uploads WHERE ${where}`, ...key);
            if (existing) { requireValue(existing.size === value.size, 'Upload size changed'); return { offset: existing.offset, size: existing.size }; }
            const revision = latest(vaultId, id)?.revision || 0;
            if (revision !== baseRevision) fail(409, 'Another version was saved. Review both versions.', { currentRevision: revision });
            if (one('SELECT COUNT(*) AS count FROM uploads WHERE vaultId=?', vaultId).count >= 4) fail(507, 'Cloud pending upload limit reached');
            if (!fits(vaultId, reservedBytes, deviceId, id)) storageFull(vaultId);
            run('INSERT INTO uploads VALUES(?,?,?,?,?,?,?,?,?)', ...key, value.size, reservedBytes, clock() + TRANSFER_LIFETIME, Buffer.alloc(0));
            return { offset: 0, size: value.size };
          });
          reply(200, result); return;
        }
        if (method === 'PUT' && !commit) {
          requireValue(req.headers['content-type'] === 'application/octet-stream', 'Expected binary content type');
          const offsetText = url.searchParams.get('offset');
          requireValue(/^(0|[1-9][0-9]*)$/.test(offsetText || ''), 'Invalid upload offset');
          const offset = Number(offsetText), bytes = await bodyBytes(req, TRANSFER_CHUNK_BYTES);
          requireValue(Number.isSafeInteger(offset) && bytes.length > 0, 'Invalid upload chunk');
          const result = transaction(() => {
            requireAccess(vaultId, deviceId);
            const saved = receipt();
            if (saved) return saved;
            const row = pending();
            if (offset < row.data.length && offset + bytes.length <= row.data.length) {
              requireValue(Buffer.from(row.data).subarray(offset, offset + bytes.length).equals(bytes), 'Upload retry bytes changed');
            } else {
              if (offset !== row.data.length || offset + bytes.length > row.size) fail(409, 'Upload offset mismatch');
              // ponytail: BLOB concatenation is bounded to 6 MiB; use chunk rows if write amplification matters.
              run(`UPDATE uploads SET data=CAST(data || ? AS BLOB) WHERE ${where}`, bytes, ...key);
            }
            return { offset: offset < row.data.length ? row.data.length : offset + bytes.length, size: row.size };
          });
          reply(200, result); return;
        }
        if (method === 'POST' && commit) {
          await body(req, MAX_METADATA_BODY);
          const result = transaction(() => {
            requireAccess(vaultId, deviceId);
            const saved = receipt();
            if (saved) return saved;
            const row = pending(), bytes = Buffer.from(row.data);
            if (bytes.length !== row.size) fail(409, 'Upload is incomplete');
            const envelope = JSON.stringify({ v: 1, iv: bytes.subarray(0, 12).toString('base64url'), ciphertext: bytes.subarray(12).toString('base64url') });
            requireValue(hash(envelope) === envelopeHash, 'Upload ciphertext hash mismatch');
            run(`DELETE FROM uploads WHERE ${where}`, ...key);
            return { committed: append(vaultId, deviceId, id, baseRevision, envelope, false) };
          });
          reply(200, result); return;
        }
        if (method === 'DELETE' && !commit) {
          transaction(() => { requireAccess(vaultId, deviceId); pending(); run(`DELETE FROM uploads WHERE ${where}`, ...key); });
          reply(200, { ok: true }); return;
        }
        fail(405, 'Method not allowed');
      }
      const object = /^\/objects\/([0-9a-f]{64})(?:\/(history|restore|convert|purge))?$/.exec(route);
      if (!object) fail(404, 'Not found');
      const id = object[1], action = object[2];
      const current = latest(vaultId, id);
      // A note deleted forever has no history left to show.
      const purged = Boolean(current) && Boolean(purgedRevision(vaultId, id, current.revision));
      if (method === 'POST' && action === 'purge') {
        const value = await body(req, MAX_METADATA_BODY);
        requireValue(Number.isSafeInteger(value.baseRevision) && value.baseRevision >= 1 && value.baseRevision < Number.MAX_SAFE_INTEGER && typeof value.envelope === 'string', 'Invalid delete');
        reply(200, purge(vaultId, deviceId, id, value.baseRevision, value.envelope)); return;
      }
      if (method === 'GET' && action === 'history') {
        if (!current || purged) fail(404, 'File not found');
        // Newest first: once a newer version is older than the cutoff, every older version is locked.
        const cutoff = lockedBefore(vaultId);
        // A note in the trash since before the cutoff is locked as a whole.
        let replacedEarlier = Boolean(cutoff) && Boolean(current.deleted) && current.updatedAt < cutoff;
        reply(200, { versions: all('SELECT revision,deleted,size,updatedAt,deviceId FROM revisions WHERE vaultId=? AND id=? ORDER BY revision DESC LIMIT 100', vaultId, id).map((entry) => {
          const locked = replacedEarlier;
          replacedEarlier ||= Boolean(cutoff) && entry.updatedAt < cutoff;
          return withoutDevice({ ...entry, deleted: Boolean(entry.deleted), locked });
        }) }); return;
      }
      if (method === 'POST' && action === 'convert') {
        // Swaps a version saved before pieces for the same file in pieces: same revisions, same history, nothing new
        // for other devices. The device read the pieces back first; the server cannot compare encrypted content.
        // Without `envelope` the device only marks a version it leaves as it is.
        const value = await body(req, MAX_BODY);
        requireValue(validHash(value.from) && (value.envelope === undefined || Array.isArray(value.chunks) && value.chunks.length > 0 && value.chunks.length <= MAX_PIECES && value.chunks.every(validHash)), 'Invalid conversion');
        const result = transaction(() => {
          requireAccess(vaultId, deviceId);
          pruneUploads(vaultId);
          const old = one('SELECT envelope,size,pieces FROM envelopes WHERE vaultId=? AND id=? AND envelopeHash=?', vaultId, id, value.from);
          if (!old) {
            // The answer was lost: the swap already happened.
            if (value.envelope !== undefined && one('SELECT 1 FROM retired_envelopes WHERE vaultId=? AND id=? AND envelopeHash=? AND replacedBy=?', vaultId, id, value.from, hash(value.envelope))) return { converted: true };
            fail(404, 'Version not found');
          }
          if (old.pieces) fail(409, 'This version already uses pieces.');
          if (value.envelope === undefined) { run('UPDATE envelopes SET pieces=1 WHERE vaultId=? AND id=? AND envelopeHash=?', vaultId, id, value.from); return { converted: false }; }
          const size = envelopeSize(value.envelope), envelopeHash = hash(value.envelope);
          requireValue(!one('SELECT 1 FROM envelopes WHERE vaultId=? AND id=? AND envelopeHash=?', vaultId, id, envelopeHash), 'Invalid conversion');
          for (const name of value.chunks) if (!one('SELECT 1 FROM chunks WHERE vaultId=? AND name=?', vaultId, name)) fail(409, 'An encrypted piece is missing. Upload it again.');
          run('INSERT INTO envelopes(vaultId,id,envelopeHash,envelope,size,pieces) VALUES(?,?,?,?,?,1)', vaultId, id, envelopeHash, value.envelope, size);
          for (const name of new Set(value.chunks)) {
            run('INSERT INTO envelope_chunks VALUES(?,?,?,?)', vaultId, id, envelopeHash, name);
            run('UPDATE chunks SET claimed=1 WHERE vaultId=? AND name=?', vaultId, name);
          }
          const total = size + pieceBytes(vaultId, id, envelopeHash);
          // Cleared notes keep size 0 in the change feed.
          run('UPDATE changes SET size=? WHERE vaultId=? AND id=? AND size>0 AND revision IN (SELECT revision FROM revisions WHERE vaultId=? AND id=? AND envelopeHash=?)', total, vaultId, id, vaultId, id, value.from);
          run('UPDATE revisions SET envelopeHash=?,size=? WHERE vaultId=? AND id=? AND envelopeHash=?', envelopeHash, total, vaultId, id, value.from);
          run('INSERT INTO retired_envelopes VALUES(?,?,?,?,?,?,?)', vaultId, id, value.from, old.envelope, old.size, clock(), envelopeHash);
          run('DELETE FROM envelopes WHERE vaultId=? AND id=? AND envelopeHash=?', vaultId, id, value.from);
          return { converted: true };
        });
        reply(200, result); return;
      }
      if (method === 'GET' && !action) {
        const revision = url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined;
        if (revision !== undefined) {
          requireValue(Number.isSafeInteger(revision) && revision >= 1, 'Invalid revision');
          requireOpenVersion(vaultId, id, revision);
        }
        const entry = revision === undefined ? current : one(`${revisionQuery} WHERE vaultId=? AND id=? AND revision=?`, vaultId, id, revision);
        if (!entry) fail(404, 'File not found');
        reply(200, withoutDevice({ id, revision: entry.revision, deleted: Boolean(entry.deleted), envelope: entry.envelope, updatedAt: entry.updatedAt, deviceId: entry.deviceId, ...(purgedRevision(vaultId, id, entry.revision) ? { purged: true } : {}) })); return;
      }
      if ((method === 'PUT' || method === 'DELETE') && !action || method === 'POST' && action === 'restore') {
        const value = await body(req, method === 'PUT' ? MAX_BODY : MAX_METADATA_BODY);
        requireValue(Number.isSafeInteger(value.baseRevision) && value.baseRevision >= 0 && value.baseRevision < Number.MAX_SAFE_INTEGER, 'Invalid base revision');
        let envelope = value.envelope;
        if (method === 'DELETE') { if (!current) fail(404, 'File not found'); if (purged) fail(409, 'This note was deleted forever.', { currentRevision: current.revision }); envelope = current.envelope; }
        if (action === 'restore') {
          requireValue(Number.isSafeInteger(value.revision) && value.revision >= 1, 'Invalid restore revision');
          requireOpenVersion(vaultId, id, value.revision);
          const old = one(`${revisionQuery} WHERE vaultId=? AND id=? AND revision=?`, vaultId, id, value.revision);
          // The tombstone of a note deleted forever holds no content to bring back.
          if (!old || purgedRevision(vaultId, id, value.revision)) fail(404, 'Version not found');
          envelope = old.envelope;
        }
        let pieces = null;
        if (method === 'PUT' && value.chunks !== undefined) {
          requireValue(Array.isArray(value.chunks) && value.chunks.length <= MAX_PIECES && value.chunks.every(validHash), 'Invalid piece names');
          pieces = value.chunks;
        }
        reply(method === 'DELETE' ? 200 : 201, append(vaultId, deviceId, id, value.baseRevision, envelope, method === 'DELETE', pieces)); return;
      }
      fail(405, 'Method not allowed');
    } catch (error) {
      if (error.limit) noteLimit(error.limit);
      if (sqliteCode(error) === 13) { error.status = 507; error.message = 'Cloud storage is full. Your local files remain available.'; }
      if (!res.headersSent && !res.destroyed) reply(error.status || 500, { error: error.status ? error.message : 'Internal server error', ...(error.extra || {}) });
      else if (!res.destroyed) res.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  sweepSpaces();
  sweepTrials();
  // The privacy policy promises votes go when their idea leaves the list (roadmap.mjs changes need a restart anyway).
  run(`DELETE FROM roadmap_votes WHERE itemId NOT IN (${roadmap.map(() => '?').join(',')})`, ...roadmapIds);
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  // The privacy policy promises these are gone on time, so do not wait for the next sign-up to remove them.
  const sweep = setInterval(() => {
    run('DELETE FROM signup_addresses WHERE createdAt<=?', clock() - DAY);
    run('DELETE FROM signups WHERE expiresAt<=?', clock());
    sweepSpaces();
    sweepTrials();
    void fillBilling();
  }, sweepEvery);
  sweep.unref();
  let closing;
  return { server, port: server.address().port, dbPath: join(dataDir, 'cloud.db'), close() {
    clearInterval(sweep);
    if (!closing) closing = new Promise((done, reject) => { server.close((error) => { db.close(); error ? reject(error) : done(); }); server.closeAllConnections(); });
    return closing;
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.JOTDROP_CLOUD_DATA_DIR) throw new Error('Set JOTDROP_CLOUD_DATA_DIR to a dedicated test-data directory. Never point it at an Obsidian vault.');
  const enrollmentToken = process.env.JOTDROP_CLOUD_ENROLLMENT_TOKEN || randomBytes(32).toString('base64url');
  // With SES settings mail goes through Amazon SES; without them the development mailer writes codes to the console.
  const mailer = process.env.JOTDROP_CLOUD_SES_REGION
    ? createSesMailer({ region: process.env.JOTDROP_CLOUD_SES_REGION, accessKeyId: process.env.JOTDROP_CLOUD_SES_ACCESS_KEY_ID, secretAccessKey: process.env.JOTDROP_CLOUD_SES_SECRET_ACCESS_KEY, from: process.env.JOTDROP_CLOUD_MAIL_FROM })
    : async ({ to, kind, code }) => console.log(`[mail] ${kind} to ${to}${code ? `: ${code}` : ''}`);
  if (!process.env.JOTDROP_CLOUD_SES_REGION && process.env.JOTDROP_CLOUD_PUBLIC_ORIGIN) console.warn('No SES settings: email codes are written to this log. Set JOTDROP_CLOUD_SES_* before real users sign up.');
  // Without a fixed key, pending codes and authenticator setups stop working after a restart.
  const serverKey = process.env.JOTDROP_CLOUD_SERVER_KEY || randomBytes(32).toString('base64url');
  const env = (name) => process.env[`JOTDROP_CLOUD_STRIPE_${name}`];
  const stripe = env('SECRET_KEY') ? { secretKey: env('SECRET_KEY'), webhookSecret: env('WEBHOOK_SECRET'), monthPrice: env('PRICE_MONTH'), yearPrice: env('PRICE_YEAR'), founderYearPrice: env('PRICE_FOUNDER_YEAR') || undefined,
    familyMonthPrice: env('PRICE_FAMILY_MONTH') || undefined, familyYearPrice: env('PRICE_FAMILY_YEAR') || undefined, familyFounderYearPrice: env('PRICE_FAMILY_FOUNDER_YEAR') || undefined } : undefined;
  const provider = (name) => process.env[`JOTDROP_CLOUD_${name}_CLIENT_ID`] ? { clientId: process.env[`JOTDROP_CLOUD_${name}_CLIENT_ID`], clientSecret: process.env[`JOTDROP_CLOUD_${name}_CLIENT_SECRET`] } : undefined;
  // Without Brevo settings the tick is still recorded, and nobody is added to a list.
  const newsletter = process.env.JOTDROP_CLOUD_BREVO_API_KEY ? createBrevoList({ apiKey: process.env.JOTDROP_CLOUD_BREVO_API_KEY, listId: Number(process.env.JOTDROP_CLOUD_BREVO_LIST_ID) }) : undefined;
  // With a Turnstile key pair, new email accounts need the person check; without one there is none.
  const turnstile = process.env.JOTDROP_CLOUD_TURNSTILE_SECRET ? { siteKey: process.env.JOTDROP_CLOUD_TURNSTILE_SITE_KEY, secret: process.env.JOTDROP_CLOUD_TURNSTILE_SECRET } : undefined;
  // The owner's dashboard needs all three; cloud/admin-setup.mjs prints the hash and the authenticator secret.
  const [adminOrigin, adminPasswordHash, adminTotpSecret] = ['ORIGIN', 'PASSWORD_HASH', 'TOTP_SECRET'].map((name) => process.env[`JOTDROP_CLOUD_ADMIN_${name}`] || undefined);
  if ((adminOrigin || adminPasswordHash || adminTotpSecret) && !(adminOrigin && adminPasswordHash && adminTotpSecret)) console.warn('Admin dashboard off: set JOTDROP_CLOUD_ADMIN_ORIGIN, JOTDROP_CLOUD_ADMIN_PASSWORD_HASH and JOTDROP_CLOUD_ADMIN_TOTP_SECRET together.');
  const reviewLogin = process.env.JOTDROP_CLOUD_REVIEW_EMAIL || process.env.JOTDROP_CLOUD_REVIEW_CODE ? { email: process.env.JOTDROP_CLOUD_REVIEW_EMAIL, code: process.env.JOTDROP_CLOUD_REVIEW_CODE } : undefined;
  const app = await createCloudServer({ dataDir: process.env.JOTDROP_CLOUD_DATA_DIR, reviewLogin, adminOrigin, adminPasswordHash, adminTotpSecret, enrollmentToken, mailer, newsletter, serverKey, stripe, oauth: { google: provider('GOOGLE'), github: provider('GITHUB') }, maxHistoryEntries: Number(process.env.JOTDROP_CLOUD_MAX_HISTORY_ENTRIES ?? 100000), maxDeviceEntries: Number(process.env.JOTDROP_CLOUD_MAX_DEVICE_ENTRIES ?? 1000), maxPairingEntries: Number(process.env.JOTDROP_CLOUD_MAX_PAIRING_ENTRIES ?? 128), maxConcurrentRequests: Number(process.env.JOTDROP_CLOUD_MAX_CONCURRENT_REQUESTS ?? 16), signupsPerAddress: Number(process.env.JOTDROP_CLOUD_SIGNUPS_PER_ADDRESS ?? 5), signupTrial: Number(process.env.JOTDROP_CLOUD_SIGNUP_TRIAL_DAYS ?? 14) * DAY, turnstile, publicOrigin: process.env.JOTDROP_CLOUD_PUBLIC_ORIGIN, port: Number(process.env.JOTDROP_CLOUD_PORT || 8787), corsOrigins: (process.env.JOTDROP_CLOUD_CORS_ORIGINS || '').split(',').map((entry) => entry.trim()).filter(Boolean),
    mailDomain: process.env.JOTDROP_CLOUD_MAIL_DOMAIN || undefined, mailinToken: process.env.JOTDROP_CLOUD_MAILIN_TOKEN || undefined });
  console.log(`JotDrop Cloud listening on http://127.0.0.1:${app.port}.`);
  if (!process.env.JOTDROP_CLOUD_ENROLLMENT_TOKEN) console.log(`Single-use local enrollment token: ${enrollmentToken}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
}

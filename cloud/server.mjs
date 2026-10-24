import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { argon2, createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createSesMailer } from './mailer.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 12 * 1024 * 1024;
const MAX_METADATA_BODY = 16 * 1024;
const TRANSFER_CHUNK_BYTES = 64 * 1024;
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
// Managed Payments needs this API version or later.
const STRIPE_VERSION = '2025-03-31.basil';
// A past-due renewal is not paid yet; it still counts as a running subscription.
const PAID = ['active', 'trialing'], RUNNING = ['active', 'trialing', 'past_due'], FINAL = ['canceled', 'incomplete_expired'];
// Clients derive their login and unlock keys with Argon2id; the server only stores these settings.
const DEFAULT_KDF = { memory: 65536, passes: 3, parallelism: 1 };
// Sign in with Google or GitHub: the provider only proves who someone is; the vault key never goes there.
const OAUTH_PROVIDERS = {
  google: { name: 'Google', authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', api: 'https://openidconnect.googleapis.com/v1/userinfo', scope: 'openid email', extra: { prompt: 'select_account' } },
  github: { name: 'GitHub', authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', api: 'https://api.github.com', scope: 'user:email', extra: {} },
};
// Where the browser goes back to after the provider; the ticket only works with the secret the app made before.
const OAUTH_RETURN = { web: (origin, query) => `${origin}/#${query}`, obsidian: (origin, query) => `obsidian://jotdrop-cloud?${query}` };
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

function base32(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, output = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xfff; bits += 8;
    while (bits >= 5) { output += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return bits ? output + alphabet[(value << (5 - bits)) & 31] : output;
}

/** RFC 6238 with the defaults every authenticator app uses: SHA-1, 30 seconds, 6 digits. */
function totpCode(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest(), offset = mac[19] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
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
export async function createCloudServer({ dataDir, enrollmentToken, mailer, serverKey, stripe, oauth = {}, fetcher = globalThis.fetch, quotaBytes = 250 * 1024 * 1024, plusQuotaBytes = 10 * 1024 * 1024 * 1024, freeDeviceLimit = 2, maxHistoryEntries = 100000, maxDeviceEntries = 1000, maxPairingEntries = 128, maxConcurrentRequests = 16, webRoot = join(directory, 'web'), corsOrigins = [], publicOrigin, port = 0, enrollmentLimit = 1, clock = Date.now }) {
  if (!dataDir || (enrollmentToken !== undefined && !validToken(enrollmentToken)) || [quotaBytes, plusQuotaBytes, freeDeviceLimit].some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error('Provide a data directory, random 32-byte enrollment token and positive quota.');
  if (mailer !== undefined && typeof mailer !== 'function') throw new Error('Provide the mailer as a function.');
  if (serverKey !== undefined && !validToken(serverKey)) throw new Error('Provide the server key as 32 random bytes.');
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
  if (!Number.isSafeInteger(enrollmentLimit) || enrollmentLimit < 1 || corsOrigins.some((origin) => !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) && origin !== 'app://obsidian.md')) throw new Error('Invalid enrollment limit or explicit client origin.');
  let publicHost;
  if (publicOrigin !== undefined) {
    let parsed;
    try { parsed = new URL(publicOrigin); } catch { throw new Error('Provide one canonical HTTPS origin for the trusted reverse proxy.'); }
    if (typeof publicOrigin !== 'string' || parsed.protocol !== 'https:' || parsed.origin !== publicOrigin || parsed.hostname.includes('*')) throw new Error('Provide one canonical HTTPS origin for the trusted reverse proxy.');
    publicHost = parsed.host;
  }
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
        CREATE TABLE IF NOT EXISTS plans(vaultId TEXT PRIMARY KEY, plusUntil INTEGER NOT NULL DEFAULT 0, trialUsed INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS subscriptions(subscriptionId TEXT PRIMARY KEY, vaultId TEXT NOT NULL, status TEXT NOT NULL, paidUntil INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS subscriptions_by_vault ON subscriptions(vaultId);
        CREATE INDEX IF NOT EXISTS envelopes_size ON envelopes(vaultId,size);
        CREATE TABLE IF NOT EXISTS identities(provider TEXT NOT NULL, subject TEXT NOT NULL, accountId TEXT NOT NULL REFERENCES accounts(id), createdAt TEXT NOT NULL, PRIMARY KEY(provider,subject));
        CREATE TABLE IF NOT EXISTS oauth_states(id TEXT PRIMARY KEY, provider TEXT NOT NULL, client TEXT NOT NULL, challenge TEXT NOT NULL, expiresAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS oauth_tickets(id TEXT PRIMARY KEY, provider TEXT NOT NULL, subject TEXT NOT NULL, email TEXT NOT NULL, challenge TEXT NOT NULL, expiresAt INTEGER NOT NULL);`);
      run("INSERT INTO secrets VALUES('fake-salt',?) ON CONFLICT(name) DO NOTHING", randomBytes(32).toString('base64url'));
      const legacy = all('PRAGMA table_info(revisions)').some((column) => column.name === 'envelope');
      db.exec(`CREATE TABLE IF NOT EXISTS ${legacy ? 'revisions_migrated' : 'revisions'}(vaultId TEXT NOT NULL REFERENCES vaults(id), id TEXT NOT NULL, revision INTEGER NOT NULL, envelopeHash TEXT NOT NULL, deleted INTEGER NOT NULL, size INTEGER NOT NULL, updatedAt TEXT NOT NULL, deviceId TEXT NOT NULL, PRIMARY KEY(vaultId,id,revision), FOREIGN KEY(vaultId,id,envelopeHash) REFERENCES envelopes(vaultId,id,envelopeHash));`);
      if (legacy) {
        // Persisted previews used inline envelopes; migrate history and its references atomically.
        for (const row of db.prepare('SELECT * FROM revisions').iterate()) {
          const envelopeHash = hash(row.envelope);
          if (envelopeSize(row.envelope) !== row.size) throw new Error('Cloud revision size mismatch.');
          run('INSERT INTO envelopes VALUES(?,?,?,?,?) ON CONFLICT(vaultId,id,envelopeHash) DO NOTHING', row.vaultId, row.id, envelopeHash, row.envelope, row.size);
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
  function limit(key, maximum) {
    const now = clock();
    if (rate.size > 2048) for (const [entry, state] of rate) if (state.until <= now) rate.delete(entry);
    const state = rate.get(key);
    if (!state || state.until <= now) { rate.set(key, { count: 1, until: now + 60000 }); return; }
    if (++state.count > maximum) fail(429, 'Too many attempts. Try again later.');
  }
  // Plus runs until the latest of the trial or a manual grant (plans) and every paid subscription period.
  function planRow(vaultId) {
    const plan = one('SELECT plusUntil,trialUsed FROM plans WHERE vaultId=?', vaultId) ?? { plusUntil: 0, trialUsed: 0 };
    return { ...plan, plusUntil: Math.max(plan.plusUntil, one('SELECT COALESCE(MAX(paidUntil),0) AS until FROM subscriptions WHERE vaultId=?', vaultId).until) };
  }
  const isPlus = (vaultId) => planRow(vaultId).plusUntil > clock();
  const subscribed = (vaultId) => Boolean(one(`SELECT 1 FROM subscriptions WHERE vaultId=? AND status IN (${RUNNING.map(() => '?').join(',')})`, vaultId, ...RUNNING));
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
    });
  }
  // The active devices of a free cloud at its device limit; empty when another device fits.
  function devicesAtLimit(vaultId) {
    const active = isPlus(vaultId) ? [] : all('SELECT id,name,lastSeenAt FROM devices WHERE vaultId=? AND revoked=0 ORDER BY lastSeenAt', vaultId);
    return active.length >= freeDeviceLimit ? active : [];
  }
  const deviceLimitReached = (devices) => fail(403, `The free plan includes ${freeDeviceLimit} devices. Sign out one of them, or try JotDrop Plus.`, { code: 'device-limit', deviceLimit: freeDeviceLimit, devices });
  // A free cloud at its device limit can only swap a device, so someone who lost their phone can still sign in.
  function addDevice(vaultId, name, tokenHash, replaceDeviceId) {
    // Count revoked rows too: revocation must not bypass the local metadata ceiling.
    if (one('SELECT COUNT(*) AS count FROM devices WHERE vaultId=?', vaultId).count >= maxDeviceEntries) fail(507, 'Cloud device metadata safety limit reached. Existing devices and history were kept.');
    const active = devicesAtLimit(vaultId);
    if (active.length) {
      const replaced = active.find((device) => device.id === replaceDeviceId);
      if (!replaced) deviceLimitReached(active);
      run('UPDATE devices SET revoked=1 WHERE id=?', replaced.id);
      run('DELETE FROM uploads WHERE vaultId=? AND deviceId=?', vaultId, replaced.id);
    }
    const id = randomUUID(), now = new Date(clock()).toISOString();
    run('INSERT INTO devices(id,vaultId,name,tokenHash,createdAt,lastSeenAt) VALUES(?,?,?,?,?,?)', id, vaultId, name.trim(), tokenHash, now, now);
    return { vaultId, deviceId: id };
  }
  const requireAccounts = () => { if (!mailer || !serverKey) fail(503, 'Email sign-in is not available on this server'); };
  async function sendMail(mail) {
    try { await mailer(mail); } catch { fail(503, 'Could not send the email. Try again later.'); }
  }
  // Used where waiting for the mail provider would reveal whether an address has an account.
  const sendMailLater = (mail) => { Promise.resolve().then(() => mailer(mail)).catch((error) => console.error(`Mail delivery failed: ${error.message}`)); };
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
  async function startSignup(email, signup) {
    const code = newCode(), now = clock(), signupId = randomUUID();
    const taken = transaction(() => {
      run('DELETE FROM signups WHERE expiresAt<=?', now);
      if (signup.vaultId && one('SELECT id FROM accounts WHERE vaultId=?', signup.vaultId)) fail(409, 'This cloud already has an account');
      if (one('SELECT id FROM accounts WHERE email=?', email)) return true;
      run('INSERT INTO signups VALUES(?,?,?,?,?,?,?,?,?,?,0,?)', signupId, email, signup.vaultId, signup.kdf, signup.authHash, signup.wrappedVaultKey, signup.recoveryHash, signup.deviceName, signup.deviceTokenHash, codeHash(`signup:${signupId}`, code), now + CODE_LIFETIME);
      return false;
    });
    await sendMail(taken ? { to: email, kind: 'signup-exists' } : { to: email, kind: 'verify', code });
    return signupId;
  }
  const revisionQuery = 'SELECT r.*,e.envelope FROM revisions r JOIN envelopes e USING(vaultId,id,envelopeHash)';
  const latest = (vaultId, id) => one(`${revisionQuery} WHERE vaultId=? AND id=? ORDER BY revision DESC LIMIT 1`, vaultId, id);
  // ponytail: indexed row counts per mutation; use persisted counters if throughput requires it.
  const historyUsage = (vaultId) => ({ ...one('SELECT (SELECT COUNT(*) FROM revisions WHERE vaultId=?) AS revisionCount, (SELECT COUNT(*) FROM changes WHERE vaultId=?) AS changeCount', vaultId, vaultId), maxEntries: maxHistoryEntries });
  function requireActiveDevice(vaultId, deviceId) {
    if (one('SELECT revoked FROM devices WHERE vaultId=? AND id=?', vaultId, deviceId)?.revoked !== 0) fail(401, 'Device access denied');
  }
  const pruneUploads = (vaultId) => run('DELETE FROM uploads WHERE vaultId=? AND expiresAt<=?', vaultId, clock());
  const storageUsage = (vaultId) => one('SELECT (SELECT COALESCE(SUM(size),0) FROM envelopes WHERE vaultId=?) + (SELECT COALESCE(SUM(reservedBytes),0) FROM uploads WHERE vaultId=?) AS used', vaultId, vaultId).used;
  const quotaFor = (vaultId) => isPlus(vaultId) ? plusQuotaBytes : quotaBytes;
  // Free clouds keep older versions, but only Plus opens one that was replaced before this moment.
  function lockedBefore(vaultId) {
    const now = clock();
    return planRow(vaultId).plusUntil + PLUS_GRACE > now ? undefined : new Date(now - FREE_HISTORY).toISOString();
  }
  // A version is replaced when the next one is saved. After eviction the next remaining version still predates
  // the cutoff, because the cutoff only moves forward.
  const lockedVersions = 'FROM revisions r WHERE r.vaultId=? AND (SELECT n.updatedAt FROM revisions n WHERE n.vaultId=r.vaultId AND n.id=r.id AND n.revision>r.revision ORDER BY n.revision LIMIT 1)<?';
  // A note deleted before the cutoff and still in the trash is locked as a whole.
  const trashedNotes = 'FROM revisions r WHERE r.vaultId=? AND r.deleted=1 AND r.updatedAt<? AND r.revision=(SELECT MAX(m.revision) FROM revisions m WHERE m.vaultId=r.vaultId AND m.id=r.id)';
  function requireOpenVersion(vaultId, id, revision) {
    const cutoff = lockedBefore(vaultId);
    if (!cutoff) return;
    if (one(`SELECT 1 ${trashedNotes} AND r.id=?`, vaultId, cutoff, id)) fail(402, 'This note was deleted more than 30 days ago. JotDrop Plus restores it.', { code: 'plus-required' });
    if (one(`SELECT 1 ${lockedVersions} AND r.id=? AND r.revision=?`, vaultId, cutoff, id, revision)) fail(402, 'This version is older than 30 days. JotDrop Plus restores it.', { code: 'plus-required' });
  }
  // A full free cloud makes room by deleting, oldest first, notes locked in the trash and then locked versions;
  // the current version of a file always stays. A cleared note is announced in the change feed and then reads as 404.
  // One scan for candidates; nothing is deleted when even all of them would not make enough room.
  // ponytail: scans the vault's revision rows per full upload; keep a per-vault locked-bytes counter if large vaults make this slow.
  // `id` is the file being written; it is never cleared to make room for itself.
  function fits(vaultId, extra, deviceId, id) {
    let shortfall = storageUsage(vaultId) + extra - quotaFor(vaultId);
    if (shortfall <= 0) return true;
    const cutoff = lockedBefore(vaultId);
    if (!cutoff) return false;
    const trashed = all(`SELECT r.id,r.revision,(SELECT COALESCE(SUM(e.size),0) FROM envelopes e WHERE e.vaultId=r.vaultId AND e.id=r.id) AS size ${trashedNotes} AND r.id<>? ORDER BY r.updatedAt`, vaultId, cutoff, id);
    const cleared = new Set(trashed.map((note) => note.id));
    // Group by envelope, oldest first; an envelope a newer open version still uses (a restore) is never freed.
    const groups = new Map();
    for (const entry of all(`SELECT r.id,r.revision,r.envelopeHash,r.size ${lockedVersions} ORDER BY r.updatedAt,r.revision`, vaultId, cutoff)) {
      if (cleared.has(entry.id)) continue;
      const key = `${entry.id}:${entry.envelopeHash}`;
      if (!groups.has(key)) groups.set(key, { ...entry, revisions: [] });
      groups.get(key).revisions.push(entry.revision);
    }
    const freeable = [...groups.values()].filter((group) => one('SELECT COUNT(*) AS count FROM revisions WHERE vaultId=? AND id=? AND envelopeHash=?', vaultId, group.id, group.envelopeHash).count === group.revisions.length);
    if ([...trashed, ...freeable].reduce((sum, entry) => sum + entry.size, 0) < shortfall) return false;
    const now = new Date(clock()).toISOString();
    for (const note of trashed) {
      run('DELETE FROM revisions WHERE vaultId=? AND id=?', vaultId, note.id);
      run('DELETE FROM envelopes WHERE vaultId=? AND id=?', vaultId, note.id);
      run('INSERT INTO changes(vaultId,id,revision,deleted,size,updatedAt,deviceId) VALUES(?,?,?,1,0,?,?)', vaultId, note.id, note.revision, now, deviceId);
      if ((shortfall -= note.size) <= 0) return true;
    }
    for (const group of freeable) {
      for (const revision of group.revisions) run('DELETE FROM revisions WHERE vaultId=? AND id=? AND revision=?', vaultId, group.id, revision);
      run('DELETE FROM envelopes WHERE vaultId=? AND id=? AND envelopeHash=?', vaultId, group.id, group.envelopeHash);
      if ((shortfall -= group.size) <= 0) break;
    }
    return true;
  }
  function append(vaultId, deviceId, id, baseRevision, envelope, deleted) {
    return transaction(() => {
      requireActiveDevice(vaultId, deviceId);
      pruneUploads(vaultId);
      const current = latest(vaultId, id);
      if ((current?.revision || 0) !== baseRevision) fail(409, 'Another version was saved. Review both versions.', { currentRevision: current?.revision || 0 });
      if (deleted) { if (!current) fail(404, 'File not found'); envelope = current.envelope; }
      const size = envelopeSize(envelope);
      const envelopeHash = hash(envelope);
      const stored = one('SELECT envelope FROM envelopes WHERE vaultId=? AND id=? AND envelopeHash=?', vaultId, id, envelopeHash);
      if (stored && stored.envelope !== envelope) throw new Error('Cloud envelope hash mismatch.');
      const history = historyUsage(vaultId);
      if (history.revisionCount >= maxHistoryEntries || history.changeCount >= maxHistoryEntries) fail(507, 'Cloud history safety limit reached. Existing versions remain readable; no history was deleted.');
      if (!stored) {
        if (!fits(vaultId, size, deviceId, id)) fail(507, 'Cloud storage is full. Your local files remain available.');
        run('INSERT INTO envelopes VALUES(?,?,?,?,?)', vaultId, id, envelopeHash, envelope, size);
      }
      const revision = baseRevision + 1, now = new Date(clock()).toISOString();
      // The local history ceiling bounds rows, not physical SQLite/WAL bytes or other metadata.
      run('INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?)', vaultId, id, revision, envelopeHash, deleted ? 1 : 0, size, now, deviceId);
      const sequence = Number(run('INSERT INTO changes(vaultId,id,revision,deleted,size,updatedAt,deviceId) VALUES(?,?,?,?,?,?,?)', vaultId, id, revision, deleted ? 1 : 0, size, now, deviceId).lastInsertRowid);
      return { id, revision, sequence };
    });
  }
  const assets = new Map([['/', [join(webRoot, 'index.html'), 'text/html']], ['/app.js', [join(webRoot, 'app.js'), 'text/javascript']], ['/style.css', [join(webRoot, 'style.css'), 'text/css']], ['/export.mjs', [join(webRoot, 'export.mjs'), 'text/javascript']], ['/note.mjs', [join(webRoot, 'note.mjs'), 'text/javascript']], ['/shared/crypto.mjs', [join(directory, 'shared/crypto.mjs'), 'text/javascript']], ['/shared/client.mjs', [join(directory, 'shared/client.mjs'), 'text/javascript']]]);
  assets.set('/ocr-worker.js', [join(webRoot, 'ocr-worker.js'), 'text/javascript']);
  assets.set('/import.mjs', [join(webRoot, 'import.mjs'), 'text/javascript']);
  for (const name of ['account.mjs', 'words.mjs']) assets.set(`/shared/${name}`, [join(directory, 'shared', name), 'text/javascript']);
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
  let server, activeRequests = 0;
  server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'${importMapSource}; worker-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      const actualPort = server.address().port;
      const hosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      const loopback = hosts.includes(req.headers.host);
      if (!loopback && (!publicHost || req.headers.host !== publicHost)) fail(403, 'Host not allowed');
      const origin = req.headers.origin;
      if (origin && origin !== (loopback ? `http://${req.headers.host}` : publicOrigin) && !corsOrigins.includes(origin)) fail(403, 'Origin not allowed');
      if (origin && corsOrigins.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      const url = new URL(req.url, `http://${req.headers.host}`), method = req.method, pathname = url.pathname;
      if (activeRequests >= maxConcurrentRequests) {
        res.setHeader('Retry-After', '1');
        res.setHeader('Connection', 'close');
        reply(503, { error: 'Cloud is busy. Retry later; your local draft was not uploaded.' }); return;
      }
      activeRequests++;
      // Hold capacity through response delivery, including slow readers and aborted uploads.
      res.once('close', () => { activeRequests--; });
      if (method === 'OPTIONS') {
        if (!origin || !corsOrigins.includes(origin)) fail(403, 'Origin not allowed');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-JotDrop-Vault,X-JotDrop-Device');
        res.writeHead(204); res.end(); return;
      }
      if (method === 'GET' && assets.has(pathname)) {
        const [filename, type] = assets.get(pathname);
        res.setHeader('Content-Type', type); res.end(readFileSync(filename)); return;
      }
      if (!pathname.startsWith('/api/v1/')) fail(404, 'Not found');
      const route = pathname.slice('/api/v1'.length);
      if (method === 'POST' && route === '/vaults') {
        limit(`enroll:${req.socket.remoteAddress}`, 10);
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
        limit(`recover:${req.socket.remoteAddress}`, 5);
        const value = await body(req, MAX_METADATA_BODY);
        deviceName(value.deviceName);
        requireValue(validId(value.vaultId) && validHash(value.deviceTokenHash), 'Invalid recovery request');
        const vault = one('SELECT recoveryHash FROM vaults WHERE id=?', value.vaultId);
        if (!validToken(value.recoveryToken) || !vault || !equal(hash(value.recoveryToken), vault.recoveryHash)) fail(401, 'Invalid recovery code');
        reply(201, transaction(() => addDevice(value.vaultId, value.deviceName, value.deviceTokenHash, value.replaceDeviceId))); return;
      }
      const claim = /^\/pairings\/([0-9a-f-]+)\/claim$/.exec(route);
      if (method === 'POST' && claim) {
        limit(`claim:${req.socket.remoteAddress}`, 10);
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
      const ip = req.socket.remoteAddress;
      if (method === 'POST' && route === '/accounts') {
        requireAccounts();
        limit(`signup:${ip}`, 10);
        const value = await body(req, MAX_METADATA_BODY);
        const email = emailValue(value.email);
        deviceName(value.deviceName);
        requireValue(validHash(value.deviceTokenHash) && validHash(value.recoveryTokenHash), 'Invalid token hash');
        const credentials = await credentialValue(value);
        limit(`signup-email:${email}`, 3);
        const signupId = await startSignup(email, { ...credentials, vaultId: null, recoveryHash: value.recoveryTokenHash, deviceName: value.deviceName.trim(), deviceTokenHash: value.deviceTokenHash });
        reply(202, { status: 'verify-email', signupId }); return;
      }
      if (method === 'POST' && route === '/accounts/verify') {
        requireAccounts();
        limit(`code:${ip}`, 20);
        const value = await body(req, MAX_METADATA_BODY);
        requireValue(validId(value.signupId), 'Invalid signup request');
        reply(201, redeem('signups', 'id', value.signupId, (signup) => `signup:${signup.email}`, emailCode(`signup:${value.signupId}`, value.code), (signup) => {
          const email = signup.email;
          if (one('SELECT id FROM accounts WHERE email=?', email)) fail(409, 'This email address already has an account');
          run('DELETE FROM signups WHERE email=?', email);
          let vaultId = signup.vaultId, deviceId;
          if (vaultId) { if (one('SELECT id FROM accounts WHERE vaultId=?', vaultId)) fail(409, 'This cloud already has an account'); }
          else {
            vaultId = randomUUID();
            run('INSERT INTO vaults VALUES(?,?,?)', vaultId, signup.recoveryHash, 'account');
            deviceId = addDevice(vaultId, signup.deviceName, signup.deviceTokenHash).deviceId;
          }
          const now = new Date(clock()).toISOString();
          run('INSERT INTO accounts(id,email,vaultId,kdf,authHash,wrappedVaultKey,createdAt,passwordChangedAt) VALUES(?,?,?,?,?,?,?,?)', randomUUID(), email, vaultId, signup.kdf, signup.authHash, signup.wrappedVaultKey, now, now);
          return deviceId ? { vaultId, deviceId } : { vaultId };
        })); return;
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
        const challengeId = randomUUID(), code = newCode(), factor = account.totpSecret ? 'totp' : 'email';
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
          run('INSERT INTO vaults VALUES(?,?,?)', vaultId, value.recoveryTokenHash, 'account');
          run('UPDATE accounts SET vaultId=? WHERE id=?', vaultId, account.id);
          // The subscription belongs to the person, not to the deleted ciphertext.
          run('UPDATE plans SET vaultId=? WHERE vaultId=?', vaultId, account.vaultId);
          run('UPDATE subscriptions SET vaultId=? WHERE vaultId=?', vaultId, account.vaultId);
          setCredentials(account.id, next);
          run('DELETE FROM device_approvals WHERE accountId=?', account.id);
          // Nobody can read the old ciphertext any more; deleting it is what the user confirmed.
          for (const table of ['uploads', 'pairings', 'revisions', 'envelopes', 'changes', 'signups', 'devices']) run(`DELETE FROM ${table} WHERE vaultId=?`, account.vaultId);
          run('DELETE FROM vaults WHERE id=?', account.vaultId);
          return addDevice(vaultId, value.deviceName, value.deviceTokenHash);
        })); return;
      }
      if (method === 'GET' && route === '/auth/providers') { reply(200, { providers: Object.keys(providers) }); return; }
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
        let email = null;
        try { email = identity.email && emailValue(identity.email); } catch { email = null; }
        if (!email || !identity.subject || identity.subject.length > 200) { back(new URLSearchParams({ 'oauth-error': `Your ${provider.name} account has no verified email address. Add one there, or use email and password.` })); return; }
        const ticket = randomBytes(32).toString('base64url');
        transaction(() => {
          run('DELETE FROM oauth_tickets WHERE expiresAt<=?', clock());
          run('INSERT INTO oauth_tickets VALUES(?,?,?,?,?,?)', hash(ticket), oauthRoute[1], identity.subject, email, state.challenge, clock() + OAUTH_LIFETIME);
        });
        back(new URLSearchParams({ oauth: ticket })); return;
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
        reply(201, transaction(() => {
          const ticket = oauthTicket(value);
          if (oauthAccount(ticket)) fail(409, 'This email address already has an account. Sign in to it instead.', { code: 'account-exists' });
          run('DELETE FROM oauth_tickets WHERE id=?', ticket.id);
          const vaultId = randomUUID(), accountId = randomUUID(), now = new Date(clock()).toISOString();
          run('INSERT INTO vaults VALUES(?,?,?)', vaultId, value.recoveryTokenHash, 'account');
          // No password: '' never matches a login key, and "Forgot password" can add one later.
          run("INSERT INTO accounts(id,email,vaultId,kdf,authHash,wrappedVaultKey,createdAt,passwordChangedAt) VALUES(?,?,?,'','','',?,?)", accountId, ticket.email, vaultId, now, now);
          run('INSERT INTO identities VALUES(?,?,?,?)', ticket.provider, ticket.subject, accountId, now);
          return addDevice(vaultId, value.deviceName, value.deviceTokenHash);
        })); return;
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
      const vaultId = req.headers['x-jotdrop-vault'], deviceId = req.headers['x-jotdrop-device'];
      const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
      if (!validId(vaultId) || !validId(deviceId) || !validToken(token)) fail(401, 'Device authorization required');
      const device = one('SELECT * FROM devices WHERE id=? AND vaultId=?', deviceId, vaultId);
      if (!device || device.revoked || !equal(hash(token), device.tokenHash)) fail(401, 'Device access denied');
      try { run('UPDATE devices SET lastSeenAt=? WHERE id=?', new Date(clock()).toISOString(), deviceId); }
      catch (error) {
        // Optional activity metadata must not deny access when storage cannot be written.
        if (![5, 6, 8, 10, 13].includes(sqliteCode(error))) throw error; // BUSY, LOCKED, READONLY, IOERR, FULL.
      }
      if (route === '/account' && method === 'GET') {
        const account = accountFor(vaultId);
        reply(200, { email: account.email, totp: Boolean(account.totpSecret), password: Boolean(account.authHash), providers: all('SELECT provider FROM identities WHERE accountId=? ORDER BY provider', account.id).map((row) => row.provider) }); return;
      }
      if (route === '/account/totp' && method === 'POST') {
        requireAccounts();
        const account = accountFor(vaultId), secret = randomBytes(20);
        run('UPDATE accounts SET totpPending=? WHERE id=?', sealTotp(secret, account.id), account.id);
        reply(200, { secret: base32(secret), uri: `otpauth://totp/${encodeURIComponent(`JotDrop:${account.email}`)}?secret=${base32(secret)}&issuer=JotDrop` }); return;
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
          requireActiveDevice(vaultId, deviceId);
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
        const credentials = await credentialValue(value);
        limit(`signup-email:${email}`, 3);
        const signupId = await startSignup(email, { ...credentials, vaultId, recoveryHash: null, deviceName: null, deviceTokenHash: null });
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
          requireActiveDevice(vaultId, deviceId);
          if (run('UPDATE accounts SET kdf=?,authHash=?,wrappedVaultKey=?,passwordChangedAt=? WHERE id=? AND authHash=?', next.kdf, next.authHash, next.wrappedVaultKey, new Date(clock()).toISOString(), account.id, account.authHash).changes !== 1) fail(409, 'The password was changed elsewhere. Try again.');
          run('DELETE FROM login_challenges WHERE accountId=?', account.id);
          if (value.signOutOtherDevices === true) {
            run('UPDATE devices SET revoked=1 WHERE vaultId=? AND id<>?', vaultId, deviceId);
            run('DELETE FROM uploads WHERE vaultId=? AND deviceId<>?', vaultId, deviceId);
          }
        });
        reply(200, { ok: true }); return;
      }
      if (route === '/recovery' && method === 'POST') {
        limit(`recovery:${vaultId}`, 5);
        const value = await body(req, MAX_METADATA_BODY);
        requireValue(validHash(value.recoveryTokenHash), 'Invalid token hash');
        // With an account the password is required, so a stolen device token cannot replace the owner's recovery code.
        const account = one('SELECT * FROM accounts WHERE vaultId=?', vaultId);
        if (account) await requirePassword(account, value.currentAuthKey);
        transaction(() => {
          requireActiveDevice(vaultId, deviceId);
          run('UPDATE vaults SET recoveryHash=? WHERE id=?', value.recoveryTokenHash, vaultId);
        });
        if (account) sendMailLater({ to: account.email, kind: 'recovery-changed' });
        reply(200, { ok: true }); return;
      }
      if (route === '/account/trial' && method === 'POST') {
        const plusUntil = transaction(() => {
          requireActiveDevice(vaultId, deviceId);
          const plan = planRow(vaultId);
          if (plan.trialUsed) fail(409, 'The free trial was already used.');
          if (plan.plusUntil > clock()) fail(409, 'This cloud already has JotDrop Plus.');
          const until = clock() + TRIAL_TIME;
          run('INSERT INTO plans VALUES(?,?,1) ON CONFLICT(vaultId) DO UPDATE SET plusUntil=excluded.plusUntil,trialUsed=1', vaultId, until);
          return until;
        });
        reply(200, { plusUntil: new Date(plusUntil).toISOString() }); return;
      }
      if (route === '/account/checkout' && method === 'POST') {
        if (!stripe) fail(503, 'Payments are not available on this server.');
        limit(`checkout:${vaultId}`, 10);
        const value = await body(req, MAX_METADATA_BODY);
        requireValue(['month', 'year'].includes(value.interval), 'Choose a monthly or yearly plan');
        if (subscribed(vaultId)) fail(409, 'This cloud already has a JotDrop Plus subscription. Manage it at link.com.');
        const origin = publicOrigin ?? `http://${req.headers.host}`, account = one('SELECT id,email FROM accounts WHERE vaultId=?', vaultId);
        // The session expires after 30 minutes (Stripe's minimum), so an old open one is not paid next to a newer one.
        const form = new URLSearchParams({ mode: 'subscription', 'managed_payments[enabled]': 'true', 'line_items[0][price]': value.interval === 'month' ? stripe.monthPrice : founderPrice() ? stripe.founderYearPrice : stripe.yearPrice,
          'line_items[0][quantity]': '1', client_reference_id: vaultId, 'subscription_data[metadata][vaultId]': vaultId, success_url: `${origin}/?plus=welcome`, cancel_url: `${origin}/`, expires_at: String(Math.floor(clock() / 1000) + 30 * 60) });
        if (account) { form.set('subscription_data[metadata][accountId]', account.id); form.set('customer_email', account.email); }
        let session;
        try {
          const response = await stripeCall('/checkout/sessions', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
          session = await response.json();
          if (!response.ok || typeof session.url !== 'string' || !session.url.startsWith('https://checkout.stripe.com/')) throw new Error('Stripe refused the checkout');
        } catch { fail(502, 'Could not start the payment. Try again later.'); }
        reply(200, { url: session.url }); return;
      }
      if (method === 'GET' && route === '/status') {
        const plan = planRow(vaultId), plus = plan.plusUntil > clock();
        reply(200, { usedBytes: one('SELECT COALESCE(SUM(size),0) AS size FROM envelopes WHERE vaultId=?', vaultId).size, quotaBytes: quotaFor(vaultId), plan: { name: plus ? 'plus' : 'free', plusUntil: plan.plusUntil ? new Date(plan.plusUntil).toISOString() : null, trialAvailable: !plan.trialUsed && !plus, deviceLimit: plus ? null : freeDeviceLimit, historyDays: plus ? null : FREE_HISTORY / DAY, subscribed: subscribed(vaultId), checkout: Boolean(stripe), founderPrice: founderPrice() }, sequence: one('SELECT COALESCE(MAX(sequence),0) AS sequence FROM changes WHERE vaultId=?', vaultId).sequence, history: historyUsage(vaultId), transport: { version: 1, chunkBytes: TRANSFER_CHUNK_BYTES, reservedBytes: one('SELECT COALESCE(SUM(reservedBytes),0) AS size FROM uploads WHERE vaultId=?', vaultId).size } }); return;
      }
      if (method === 'GET' && route === '/changes') {
        const after = Number(url.searchParams.get('after') || 0);
        requireValue(Number.isSafeInteger(after) && after >= 0, 'Invalid changes cursor');
        const changes = all('SELECT sequence,id,revision,deleted,size,updatedAt,deviceId FROM changes WHERE vaultId=? AND sequence>? ORDER BY sequence LIMIT 501', vaultId, after);
        const hasMore = changes.length > 500;
        if (hasMore) changes.pop();
        reply(200, { changes: changes.map((entry) => ({ ...entry, deleted: Boolean(entry.deleted) })), cursor: changes.at(-1)?.sequence ?? after, hasMore }); return;
      }
      if (method === 'GET' && route === '/snapshot') {
        // Each file as it was at a moment: its last version saved at or before it, deleted ones included.
        const at = url.searchParams.get('at'), after = url.searchParams.get('after') || '', pageSize = Number(url.searchParams.get('limit') || 500);
        requireValue(Number.isFinite(Date.parse(at)) && (!after || validHash(after)) && Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= 500, 'Invalid snapshot request');
        const cutoff = lockedBefore(vaultId);
        // A full free cloud may have cleared the version from then: a gap in revision numbers, or a file whose
        // first remaining version is newer. That file is reported as cleared, never left out or replaced by an older version.
        // ponytail: scans the vault's revision rows per page; index revisions by time if large vaults make this slow.
        const objects = all('SELECT o.id,o.first,r.revision,r.deleted,r.size,r.updatedAt,(SELECT n.revision FROM revisions n WHERE n.vaultId=o.vaultId AND n.id=o.id AND n.revision>r.revision ORDER BY n.revision LIMIT 1) AS nextRevision,(SELECT n.updatedAt FROM revisions n WHERE n.vaultId=o.vaultId AND n.id=o.id AND n.revision>r.revision ORDER BY n.revision LIMIT 1) AS replacedAt FROM (SELECT vaultId,id,MIN(revision) AS first FROM revisions WHERE vaultId=? AND id>? GROUP BY id) o LEFT JOIN revisions r ON r.vaultId=o.vaultId AND r.id=o.id AND r.revision=(SELECT MAX(m.revision) FROM revisions m WHERE m.vaultId=o.vaultId AND m.id=o.id AND m.updatedAt<=?) WHERE r.revision IS NOT NULL OR o.first>1 ORDER BY o.id LIMIT ?', vaultId, after, new Date(at).toISOString(), pageSize + 1);
        const hasMore = objects.length > pageSize;
        if (hasMore) objects.pop();
        reply(200, { objects: objects.map(({ first, nextRevision, replacedAt, ...entry }) => {
          if (entry.revision === null) return { id: entry.id, revision: null, deleted: false, size: 0, updatedAt: null, locked: true, cleared: true };
          const cleared = nextRevision !== null && nextRevision !== entry.revision + 1;
          return { ...entry, deleted: Boolean(entry.deleted), locked: cleared || Boolean(cutoff) && (replacedAt ? replacedAt < cutoff : Boolean(entry.deleted) && entry.updatedAt < cutoff), cleared };
        }), cursor: objects.at(-1)?.id ?? after, hasMore }); return;
      }
      if (method === 'GET' && route === '/devices') { reply(200, { devices: all('SELECT id,name,createdAt,lastSeenAt,revoked FROM devices WHERE vaultId=? ORDER BY createdAt', vaultId).map((entry) => ({ ...entry, revoked: Boolean(entry.revoked) })) }); return; }
      const revoke = /^\/devices\/([0-9a-f-]+)$/.exec(route);
      if (method === 'DELETE' && revoke) {
        transaction(() => {
          requireActiveDevice(vaultId, deviceId);
          const target = one('SELECT * FROM devices WHERE vaultId=? AND id=?', vaultId, revoke[1]);
          if (!target) fail(404, 'Device not found');
          if (!target.revoked && one('SELECT COUNT(*) AS count FROM devices WHERE vaultId=? AND revoked=0', vaultId).count <= 1) fail(409, 'Cannot revoke the only active device');
          run('UPDATE devices SET revoked=1 WHERE id=? AND vaultId=?', target.id, vaultId);
          run('DELETE FROM uploads WHERE vaultId=? AND deviceId=?', vaultId, target.id);
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
          requireActiveDevice(vaultId, deviceId);
          // Say so before the code is scanned, not after.
          const active = devicesAtLimit(vaultId);
          if (active.length) deviceLimitReached(active);
          const now = clock(), pairingId = randomUUID(), expiresAt = now + 600000;
          run('DELETE FROM pairings WHERE vaultId=? AND expiresAt<=?', vaultId, now);
          if (one('SELECT COUNT(*) AS count FROM pairings WHERE vaultId=?', vaultId).count >= maxPairingEntries) fail(507, 'Cloud pairing metadata safety limit reached. Wait for existing codes to expire.');
          run('INSERT INTO pairings(id,vaultId,deviceName,deviceTokenHash,claimTokenHash,envelope,expiresAt,creatorId) VALUES(?,?,?,?,?,?,?,?)', pairingId, vaultId, value.deviceName, value.deviceTokenHash, value.claimTokenHash, value.envelope, expiresAt, deviceId);
          return { pairingId, expiresAt: new Date(expiresAt).toISOString() };
        });
        reply(201, result); return;
      }
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
            requireActiveDevice(vaultId, deviceId);
            const saved = receipt();
            if (saved) return saved;
            pruneUploads(vaultId);
            const existing = one(`SELECT size,length(data) AS offset FROM uploads WHERE ${where}`, ...key);
            if (existing) { requireValue(existing.size === value.size, 'Upload size changed'); return { offset: existing.offset, size: existing.size }; }
            const revision = latest(vaultId, id)?.revision || 0;
            if (revision !== baseRevision) fail(409, 'Another version was saved. Review both versions.', { currentRevision: revision });
            if (one('SELECT COUNT(*) AS count FROM uploads WHERE vaultId=?', vaultId).count >= 4) fail(507, 'Cloud pending upload limit reached');
            if (!fits(vaultId, reservedBytes, deviceId, id)) fail(507, 'Cloud storage is full. Your local files remain available.');
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
            requireActiveDevice(vaultId, deviceId);
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
            requireActiveDevice(vaultId, deviceId);
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
          transaction(() => { requireActiveDevice(vaultId, deviceId); pending(); run(`DELETE FROM uploads WHERE ${where}`, ...key); });
          reply(200, { ok: true }); return;
        }
        fail(405, 'Method not allowed');
      }
      const object = /^\/objects\/([0-9a-f]{64})(?:\/(history|restore))?$/.exec(route);
      if (!object) fail(404, 'Not found');
      const id = object[1], action = object[2];
      const current = latest(vaultId, id);
      if (method === 'GET' && action === 'history') {
        if (!current) fail(404, 'File not found');
        // Newest first: once a newer version is older than the cutoff, every older version is locked.
        const cutoff = lockedBefore(vaultId);
        // A note in the trash since before the cutoff is locked as a whole.
        let replacedEarlier = Boolean(cutoff) && Boolean(current.deleted) && current.updatedAt < cutoff;
        reply(200, { versions: all('SELECT revision,deleted,size,updatedAt,deviceId FROM revisions WHERE vaultId=? AND id=? ORDER BY revision DESC LIMIT 100', vaultId, id).map((entry) => {
          const locked = replacedEarlier;
          replacedEarlier ||= Boolean(cutoff) && entry.updatedAt < cutoff;
          return { ...entry, deleted: Boolean(entry.deleted), locked };
        }) }); return;
      }
      if (method === 'GET' && !action) {
        const revision = url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined;
        if (revision !== undefined) {
          requireValue(Number.isSafeInteger(revision) && revision >= 1, 'Invalid revision');
          requireOpenVersion(vaultId, id, revision);
        }
        const entry = revision === undefined ? current : one(`${revisionQuery} WHERE vaultId=? AND id=? AND revision=?`, vaultId, id, revision);
        if (!entry) fail(404, 'File not found');
        reply(200, { id, revision: entry.revision, deleted: Boolean(entry.deleted), envelope: entry.envelope, updatedAt: entry.updatedAt, deviceId: entry.deviceId }); return;
      }
      if ((method === 'PUT' || method === 'DELETE') && !action || method === 'POST' && action === 'restore') {
        const value = await body(req, method === 'PUT' ? MAX_BODY : MAX_METADATA_BODY);
        requireValue(Number.isSafeInteger(value.baseRevision) && value.baseRevision >= 0 && value.baseRevision < Number.MAX_SAFE_INTEGER, 'Invalid base revision');
        let envelope = value.envelope;
        if (method === 'DELETE') { if (!current) fail(404, 'File not found'); envelope = current.envelope; }
        if (action === 'restore') {
          requireValue(Number.isSafeInteger(value.revision) && value.revision >= 1, 'Invalid restore revision');
          requireOpenVersion(vaultId, id, value.revision);
          const old = one(`${revisionQuery} WHERE vaultId=? AND id=? AND revision=?`, vaultId, id, value.revision);
          if (!old) fail(404, 'Version not found');
          envelope = old.envelope;
        }
        reply(method === 'DELETE' ? 200 : 201, append(vaultId, deviceId, id, value.baseRevision, envelope, method === 'DELETE')); return;
      }
      fail(405, 'Method not allowed');
    } catch (error) {
      if (sqliteCode(error) === 13) { error.status = 507; error.message = 'Cloud storage is full. Your local files remain available.'; }
      if (!res.headersSent && !res.destroyed) reply(error.status || 500, { error: error.status ? error.message : 'Internal server error', ...(error.extra || {}) });
      else if (!res.destroyed) res.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  let closing;
  return { server, port: server.address().port, dbPath: join(dataDir, 'cloud.db'), close() {
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
  const stripe = env('SECRET_KEY') ? { secretKey: env('SECRET_KEY'), webhookSecret: env('WEBHOOK_SECRET'), monthPrice: env('PRICE_MONTH'), yearPrice: env('PRICE_YEAR'), founderYearPrice: env('PRICE_FOUNDER_YEAR') || undefined } : undefined;
  const provider = (name) => process.env[`JOTDROP_CLOUD_${name}_CLIENT_ID`] ? { clientId: process.env[`JOTDROP_CLOUD_${name}_CLIENT_ID`], clientSecret: process.env[`JOTDROP_CLOUD_${name}_CLIENT_SECRET`] } : undefined;
  const app = await createCloudServer({ dataDir: process.env.JOTDROP_CLOUD_DATA_DIR, enrollmentToken, mailer, serverKey, stripe, oauth: { google: provider('GOOGLE'), github: provider('GITHUB') }, maxHistoryEntries: Number(process.env.JOTDROP_CLOUD_MAX_HISTORY_ENTRIES ?? 100000), maxDeviceEntries: Number(process.env.JOTDROP_CLOUD_MAX_DEVICE_ENTRIES ?? 1000), maxPairingEntries: Number(process.env.JOTDROP_CLOUD_MAX_PAIRING_ENTRIES ?? 128), maxConcurrentRequests: Number(process.env.JOTDROP_CLOUD_MAX_CONCURRENT_REQUESTS ?? 16), publicOrigin: process.env.JOTDROP_CLOUD_PUBLIC_ORIGIN, port: Number(process.env.JOTDROP_CLOUD_PORT || 8787), corsOrigins: (process.env.JOTDROP_CLOUD_CORS_ORIGINS || '').split(',').map((entry) => entry.trim()).filter(Boolean) });
  console.log(`Local cloud preview: http://127.0.0.1:${app.port}. Test data only, not production.`);
  if (!process.env.JOTDROP_CLOUD_ENROLLMENT_TOKEN) console.log(`Single-use local enrollment token: ${enrollmentToken}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
}

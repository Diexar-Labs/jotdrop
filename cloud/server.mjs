import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { argon2, createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const directory = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 12 * 1024 * 1024;
const MAX_METADATA_BODY = 16 * 1024;
const TRANSFER_CHUNK_BYTES = 64 * 1024;
const TRANSFER_LIFETIME = 24 * 60 * 60 * 1000;
const CODE_LIFETIME = 15 * 60 * 1000;
const LOCK_TIME = 15 * 60 * 1000;
const CODE_LOCK_TIME = 24 * 60 * 60 * 1000;
const APPROVAL_LIFETIME = 10 * 60 * 1000;
// Clients derive their login and unlock keys with Argon2id; the server only stores these settings.
const DEFAULT_KDF = { memory: 65536, passes: 3, parallelism: 1 };
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

/** Loopback-only server behind a trusted HTTPS proxy. Accounts need a mailer; no billing or provider credentials. */
export async function createCloudServer({ dataDir, enrollmentToken, mailer, serverKey, quotaBytes = 100 * 1024 * 1024, maxHistoryEntries = 100000, maxDeviceEntries = 1000, maxPairingEntries = 128, maxConcurrentRequests = 16, webRoot = join(directory, 'web'), corsOrigins = [], publicOrigin, port = 0, enrollmentLimit = 1, clock = Date.now }) {
  if (!dataDir || (enrollmentToken !== undefined && !validToken(enrollmentToken)) || !Number.isSafeInteger(quotaBytes) || quotaBytes < 1) throw new Error('Provide a data directory, random 32-byte enrollment token and positive quota.');
  if (mailer !== undefined && typeof mailer !== 'function') throw new Error('Provide the mailer as a function.');
  if (serverKey !== undefined && !validToken(serverKey)) throw new Error('Provide the server key as 32 random bytes.');
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
        CREATE TABLE IF NOT EXISTS secrets(name TEXT PRIMARY KEY, value TEXT NOT NULL);`);
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
  function addDevice(vaultId, name, tokenHash) {
    // Count revoked rows too: revocation must not bypass the local metadata ceiling.
    if (one('SELECT COUNT(*) AS count FROM devices WHERE vaultId=?', vaultId).count >= maxDeviceEntries) fail(507, 'Cloud device metadata safety limit reached. Existing devices and history were kept.');
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
        const used = storageUsage(vaultId);
        if (used + size > quotaBytes) fail(507, 'Cloud storage is full. Your local files remain available.');
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
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
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
        reply(201, transaction(() => addDevice(value.vaultId, value.deviceName, value.deviceTokenHash))); return;
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
        const account = one('SELECT kdf FROM accounts WHERE email=?', email);
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
        const account = one('SELECT * FROM accounts WHERE email=?', email);
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
          return { ...addDevice(account.vaultId, challenge.deviceName, challenge.deviceTokenHash), wrappedVaultKey: account.wrappedVaultKey };
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
          return addDevice(account.vaultId, value.deviceName, value.deviceTokenHash);
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
        const next = await newDeviceCredentials(value);
        reply(201, transaction(() => {
          if (run('DELETE FROM device_approvals WHERE id=? AND envelope IS NOT NULL', request.id).changes !== 1) fail(401, 'Invalid or expired approval');
          const account = one('SELECT id,vaultId FROM accounts WHERE id=?', request.accountId);
          setCredentials(account.id, next);
          return addDevice(account.vaultId, value.deviceName, value.deviceTokenHash);
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
          setCredentials(account.id, next);
          run('DELETE FROM device_approvals WHERE accountId=?', account.id);
          // Nobody can read the old ciphertext any more; deleting it is what the user confirmed.
          for (const table of ['uploads', 'pairings', 'revisions', 'envelopes', 'changes', 'signups', 'devices']) run(`DELETE FROM ${table} WHERE vaultId=?`, account.vaultId);
          run('DELETE FROM vaults WHERE id=?', account.vaultId);
          return addDevice(vaultId, value.deviceName, value.deviceTokenHash);
        })); return;
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
        reply(200, { email: account.email, totp: Boolean(account.totpSecret) }); return;
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
        requireValue(validToken(value.currentAuthKey), 'Invalid login key');
        // The password is required, so a stolen device token cannot swap in another authenticator.
        const account = accountFor(vaultId);
        if (!await checkAuthKey(value.currentAuthKey, account.authHash)) fail(401, 'Current password is incorrect');
        const step = totpStep(account, account.totpPending, value.code);
        if (!step) fail(401, 'Invalid code');
        run('UPDATE accounts SET totpSecret=totpPending,totpPending=NULL,totpLastStep=? WHERE id=?', step, account.id);
        reply(200, { ok: true }); return;
      }
      if (route === '/account/totp/disable' && method === 'POST') {
        limit(`totp:${vaultId}`, 10);
        const value = await body(req, MAX_METADATA_BODY);
        requireValue(validToken(value.currentAuthKey), 'Invalid login key');
        const account = accountFor(vaultId);
        if (!await checkAuthKey(value.currentAuthKey, account.authHash)) fail(401, 'Current password is incorrect');
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
        requireValue(validToken(value.currentAuthKey), 'Invalid login key');
        const account = one('SELECT * FROM accounts WHERE vaultId=?', vaultId);
        if (!account) fail(404, 'No account for this cloud');
        const next = await credentialValue(value);
        if (!await checkAuthKey(value.currentAuthKey, account.authHash)) fail(401, 'Current password is incorrect');
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
      if (method === 'GET' && route === '/status') {
        reply(200, { usedBytes: one('SELECT COALESCE(SUM(size),0) AS size FROM envelopes WHERE vaultId=?', vaultId).size, quotaBytes, sequence: one('SELECT COALESCE(MAX(sequence),0) AS sequence FROM changes WHERE vaultId=?', vaultId).sequence, history: historyUsage(vaultId), transport: { version: 1, chunkBytes: TRANSFER_CHUNK_BYTES, reservedBytes: one('SELECT COALESCE(SUM(reservedBytes),0) AS size FROM uploads WHERE vaultId=?', vaultId).size } }); return;
      }
      if (method === 'GET' && route === '/changes') {
        const after = Number(url.searchParams.get('after') || 0);
        requireValue(Number.isSafeInteger(after) && after >= 0, 'Invalid changes cursor');
        const changes = all('SELECT sequence,id,revision,deleted,size,updatedAt,deviceId FROM changes WHERE vaultId=? AND sequence>? ORDER BY sequence LIMIT 501', vaultId, after);
        const hasMore = changes.length > 500;
        if (hasMore) changes.pop();
        reply(200, { changes: changes.map((entry) => ({ ...entry, deleted: Boolean(entry.deleted) })), cursor: changes.at(-1)?.sequence ?? after, hasMore }); return;
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
            if (storageUsage(vaultId) + reservedBytes > quotaBytes) fail(507, 'Cloud storage is full. Your local files remain available.');
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
        reply(200, { versions: all('SELECT revision,deleted,size,updatedAt,deviceId FROM revisions WHERE vaultId=? AND id=? ORDER BY revision DESC LIMIT 100', vaultId, id).map((entry) => ({ ...entry, deleted: Boolean(entry.deleted) })) }); return;
      }
      if (method === 'GET' && !action) {
        const revision = url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined;
        if (revision !== undefined) requireValue(Number.isSafeInteger(revision) && revision >= 1, 'Invalid revision');
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
  // ponytail: development mailer writes codes to the console; production needs a real email provider.
  const mailer = async ({ to, kind, code }) => console.log(`[mail] ${kind} to ${to}${code ? `: ${code}` : ''}`);
  // Without a fixed key, pending codes and authenticator setups stop working after a restart.
  const serverKey = process.env.JOTDROP_CLOUD_SERVER_KEY || randomBytes(32).toString('base64url');
  const app = await createCloudServer({ dataDir: process.env.JOTDROP_CLOUD_DATA_DIR, enrollmentToken, mailer, serverKey, maxHistoryEntries: Number(process.env.JOTDROP_CLOUD_MAX_HISTORY_ENTRIES ?? 100000), maxDeviceEntries: Number(process.env.JOTDROP_CLOUD_MAX_DEVICE_ENTRIES ?? 1000), maxPairingEntries: Number(process.env.JOTDROP_CLOUD_MAX_PAIRING_ENTRIES ?? 128), maxConcurrentRequests: Number(process.env.JOTDROP_CLOUD_MAX_CONCURRENT_REQUESTS ?? 16), publicOrigin: process.env.JOTDROP_CLOUD_PUBLIC_ORIGIN, port: Number(process.env.JOTDROP_CLOUD_PORT || 8787), corsOrigins: (process.env.JOTDROP_CLOUD_CORS_ORIGINS || '').split(',').map((entry) => entry.trim()).filter(Boolean) });
  console.log(`Local cloud preview: http://127.0.0.1:${app.port}. Test data only, not production.`);
  if (!process.env.JOTDROP_CLOUD_ENROLLMENT_TOKEN) console.log(`Single-use local enrollment token: ${enrollmentToken}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
}

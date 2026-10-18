import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 12 * 1024 * 1024;
const MAX_METADATA_BODY = 16 * 1024;
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

function envelopeSize(value, limit = 8 * 1024 * 1024) {
  requireValue(typeof value === 'string' && Buffer.byteLength(value) <= limit, 'Invalid envelope size');
  let envelope;
  try { envelope = JSON.parse(value); } catch { fail(400, 'Invalid envelope'); }
  requireValue(envelope && envelope.v === 1 && typeof envelope.iv === 'string' && typeof envelope.ciphertext === 'string', 'Invalid envelope');
  for (const encoded of [envelope.iv, envelope.ciphertext]) requireValue(/^[A-Za-z0-9_-]+$/.test(encoded) && Buffer.from(encoded, 'base64url').toString('base64url') === encoded, 'Invalid envelope encoding');
  requireValue(Buffer.from(envelope.iv, 'base64url').length === 12 && Buffer.from(envelope.ciphertext, 'base64url').length >= 16, 'Invalid envelope');
  return Buffer.byteLength(value);
}

async function body(req, maximum = MAX_BODY) {
  requireValue(/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''), 'Expected JSON content type');
  if (Number(req.headers['content-length'] || 0) > maximum) fail(413, 'Request exceeds size limit');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) fail(413, 'Request exceeds size limit');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'Invalid JSON'); }
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object');
  return value;
}

/** Loopback-only development server. No production signup, billing or provider credentials. */
export async function createCloudServer({ dataDir, enrollmentToken, quotaBytes = 100 * 1024 * 1024, maxHistoryEntries = 100000, maxDeviceEntries = 1000, maxPairingEntries = 128, maxConcurrentRequests = 16, webRoot = join(directory, 'web'), corsOrigins = [], publicOrigin, port = 0, enrollmentLimit = 1, clock = Date.now }) {
  if (!dataDir || !validToken(enrollmentToken) || !Number.isSafeInteger(quotaBytes) || quotaBytes < 1) throw new Error('Provide a data directory, random 32-byte enrollment token and positive quota.');
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
        CREATE TABLE IF NOT EXISTS envelopes(vaultId TEXT NOT NULL REFERENCES vaults(id), id TEXT NOT NULL, envelopeHash TEXT NOT NULL, envelope TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(vaultId,id,envelopeHash));`);
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
  const revisionQuery = 'SELECT r.*,e.envelope FROM revisions r JOIN envelopes e USING(vaultId,id,envelopeHash)';
  const latest = (vaultId, id) => one(`${revisionQuery} WHERE vaultId=? AND id=? ORDER BY revision DESC LIMIT 1`, vaultId, id);
  // ponytail: indexed row counts per mutation; use persisted counters if throughput requires it.
  const historyUsage = (vaultId) => ({ ...one('SELECT (SELECT COUNT(*) FROM revisions WHERE vaultId=?) AS revisionCount, (SELECT COUNT(*) FROM changes WHERE vaultId=?) AS changeCount', vaultId, vaultId), maxEntries: maxHistoryEntries });
  function requireActiveDevice(vaultId, deviceId) {
    if (one('SELECT revoked FROM devices WHERE vaultId=? AND id=?', vaultId, deviceId)?.revoked !== 0) fail(401, 'Device access denied');
  }
  function append(vaultId, deviceId, id, baseRevision, envelope, deleted) {
    return transaction(() => {
      requireActiveDevice(vaultId, deviceId);
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
        const used = one('SELECT COALESCE(SUM(size),0) AS used FROM envelopes WHERE vaultId=?', vaultId).used;
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
        if (!equal(req.headers.authorization || '', `Bearer ${enrollmentToken}`)) fail(401, 'Invalid enrollment token');
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
      if (method === 'GET' && route === '/status') {
        reply(200, { usedBytes: one('SELECT COALESCE(SUM(size),0) AS size FROM envelopes WHERE vaultId=?', vaultId).size, quotaBytes, sequence: one('SELECT COALESCE(MAX(sequence),0) AS sequence FROM changes WHERE vaultId=?', vaultId).sequence, history: historyUsage(vaultId) }); return;
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
        const target = one('SELECT * FROM devices WHERE vaultId=? AND id=?', vaultId, revoke[1]);
        if (!target) fail(404, 'Device not found');
        if (!target.revoked && one('SELECT COUNT(*) AS count FROM devices WHERE vaultId=? AND revoked=0', vaultId).count <= 1) fail(409, 'Cannot revoke the only active device');
        run('UPDATE devices SET revoked=1 WHERE id=? AND vaultId=?', target.id, vaultId);
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
  const app = await createCloudServer({ dataDir: process.env.JOTDROP_CLOUD_DATA_DIR, enrollmentToken, maxHistoryEntries: Number(process.env.JOTDROP_CLOUD_MAX_HISTORY_ENTRIES ?? 100000), maxDeviceEntries: Number(process.env.JOTDROP_CLOUD_MAX_DEVICE_ENTRIES ?? 1000), maxPairingEntries: Number(process.env.JOTDROP_CLOUD_MAX_PAIRING_ENTRIES ?? 128), maxConcurrentRequests: Number(process.env.JOTDROP_CLOUD_MAX_CONCURRENT_REQUESTS ?? 16), publicOrigin: process.env.JOTDROP_CLOUD_PUBLIC_ORIGIN, port: Number(process.env.JOTDROP_CLOUD_PORT || 8787), corsOrigins: (process.env.JOTDROP_CLOUD_CORS_ORIGINS || '').split(',').map((entry) => entry.trim()).filter(Boolean) });
  console.log(`Local cloud preview: http://127.0.0.1:${app.port}. Test data only, not production.`);
  if (!process.env.JOTDROP_CLOUD_ENROLLMENT_TOKEN) console.log(`Single-use local enrollment token: ${enrollmentToken}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
}

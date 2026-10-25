import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get, request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createCloudServer } from './server.mjs';
import { CloudClient } from './shared/client.mjs';
import { base64ToBytes, decodeRecovery, randomToken } from './shared/crypto.mjs';
import { backupCloudDatabase } from './backup.mjs';

// These tests cover metadata ceilings with many devices; plans.test.mjs covers the free device limit.
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-cloud-test-'));
  const enrollmentToken = randomToken();
  const app = await createCloudServer({ freeDeviceLimit: 100, dataDir, enrollmentToken, ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  return { ...app, dataDir, url, enrollmentToken, create: (deviceName = 'Test browser') => CloudClient.create({ url, enrollmentToken, deviceName }) };
}
const text = (value) => new TextEncoder().encode(value);

test('real clients pair, sync, reject stale edits, preserve immutable versions, trash, restore and revoke', async (t) => {
  const app = await fixture(t);
  const { client, recoveryCode } = await app.create();
  const pairing = await client.makePairing('Second device');
  const second = await CloudClient.claim({ pairingCode: pairing.pairingCode });
  await assert.rejects(CloudClient.claim({ pairingCode: pairing.pairingCode }), (error) => error.status === 409);
  const saved = await client.write('notes/private.md', text('# Private\nSecret test body.'), 0);
  assert.equal(saved.revision, 1);
  assert.equal((await second.read(saved.id)).file.path, 'notes/private.md');
  const changes = await second.listChanges();
  assert.equal(changes.changes[0].id, saved.id);
  assert.equal(changes.cursor, saved.sequence);
  const newer = await second.write('notes/private.md', text('# Newer'), 1);
  await assert.rejects(client.write('notes/private.md', text('# Stale'), 1), (error) => error.status === 409 && error.currentRevision === 2);
  const deleted = await client.remove(saved.id, newer.revision);
  assert.equal(deleted.revision, 3);
  assert.equal((await client.read(saved.id)).deleted, true);
  assert.equal((await client.read(saved.id, 1)).deleted, false);
  const restored = await second.restore(saved.id, 1, 3);
  assert.equal(restored.revision, 4);
  assert.equal((await client.history(saved.id)).versions.length, 4);
  assert.equal(new TextDecoder().decode(base64ToBytes((await second.read(saved.id)).file.content)), '# Private\nSecret test body.');
  await client.revokeDevice(second.credentials.deviceId);
  await assert.rejects(second.status(), (error) => error.status === 401);
  const recovered = await CloudClient.recover({ url: app.url, recoveryCode, deviceName: 'Recovered device' });
  assert.equal((await recovered.read(saved.id)).revision, 4);
  await assert.rejects(app.create(), (error) => error.status === 409);
  const raw = await readFile(app.dbPath);
  assert.ok(!raw.includes(Buffer.from('Secret test body.')));
  assert.ok(!raw.includes(Buffer.from('private.md')));
  assert.ok(!raw.includes(Buffer.from(client.credentials.vaultKey)));
});

test('the website links to a privacy policy that names every processor', async (t) => {
  const app = await fixture(t);
  assert.match(await (await fetch(`${app.url}/`)).text(), /href="\/privacy"/);
  const page = await fetch(`${app.url}/privacy`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  const body = await page.text();
  for (const name of ['Amazon SES', 'Brevo', 'Stripe', 'Google', 'GitHub', 'Cloudflare', 'hello@jotdrop.net']) assert.ok(body.includes(name), name);
});

test('authorization, tenant isolation, origin and host checks fail closed', async (t) => {
  const extension = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const app = await fixture(t, { enrollmentLimit: 2, corsOrigins: [extension] });
  const a = (await app.create('A')).client, b = (await app.create('B')).client;
  const saved = await a.write('notes/a.md', text('A only'), 0);
  await assert.rejects(b.read(saved.id), (error) => error.status === 404);
  const forged = new CloudClient({ ...b.credentials, vaultId: a.credentials.vaultId });
  await assert.rejects(forged.status(), (error) => error.status === 401);
  const anonymous = await fetch(`${app.url}/api/v1/status`);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${app.url}/api/v1/status`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  const spoofedHost = await new Promise((done, reject) => get(`${app.url}/`, { headers: { Host: `evil.example:${app.port}` } }, (response) => { response.resume(); done(response.statusCode); }).on('error', reject));
  assert.equal(spoofedHost, 403);
  const preflight = await fetch(`${app.url}/api/v1/status`, { method: 'OPTIONS', headers: { Origin: extension } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), extension);
  assert.equal((await fetch(`${app.url}/shared/client.test.mjs`)).status, 404);
  assert.equal((await fetch(`${app.url}/cloud.db`)).status, 404);
});

test('explicit HTTPS proxy origin preserves loopback binding and exact host and origin checks', async (t) => {
  const publicOrigin = 'https://api.example.test';
  const app = await fixture(t, { publicOrigin });
  const status = (host, origin, extra = {}) => new Promise((done, reject) => get(`${app.url}/api/v1/status`, {
    headers: { Host: host, ...(origin === undefined ? {} : { Origin: origin }), ...extra }
  }, (response) => { response.resume(); done(response.statusCode); }).on('error', reject));
  assert.equal(await status('api.example.test', publicOrigin), 401);
  assert.equal(await status('api.example.test'), 401);
  assert.equal(app.server.address().address, '127.0.0.1');
  assert.equal(app.server.requestTimeout, 30000);
  assert.equal(await status(`127.0.0.1:${app.port}`, app.url), 401);
  for (const origin of ['http://api.example.test', 'https://evil.example', 'null', `${publicOrigin}/`, app.url]) {
    assert.equal(await status('api.example.test', origin), 403);
  }
  for (const host of ['evil.example', 'api.example.test:443', 'api.example.test:8443', 'api.example.test.evil.example']) {
    assert.equal(await status(host, publicOrigin, { 'X-Forwarded-Host': 'api.example.test', 'X-Forwarded-Proto': 'https' }), 403);
  }
  assert.equal(await status(`127.0.0.1:${app.port}`, publicOrigin), 403);
  const local = await fixture(t);
  const denied = await new Promise((done, reject) => get(`${local.url}/`, { headers: { Host: 'api.example.test', Origin: publicOrigin } },
    (response) => { response.resume(); done(response.statusCode); }).on('error', reject));
  assert.equal(denied, 403);
});

test('public proxy configuration requires one canonical HTTPS origin, not a URL or wildcard', async (t) => {
  const app = await fixture(t);
  for (const publicOrigin of ['', null, 1, 'http://api.example.test', 'https://*.example.test', 'https://api.example.test/', 'https://api.example.test/path', 'https://user:password@api.example.test', 'https://api.example.test?query', 'https://api.example.test#fragment', 'https://api.example.test:443', 'https://API.example.test', 'https://api.example.test,https://evil.example']) {
    await assert.rejects(async () => {
      const started = await createCloudServer({ freeDeviceLimit: 100, dataDir: app.dataDir, enrollmentToken: app.enrollmentToken, publicOrigin });
      await started.close();
    }, /HTTPS origin/);
  }
});

test('quota and validation are atomic, including restore and concurrent uploads', async (t) => {
  const app = await fixture(t, { quotaBytes: 2500 });
  const { client } = await app.create();
  const prepared = await client.prepareWrite('notes/concurrent.md', text('same revision'), 0);
  const results = await Promise.allSettled([client.commitWrite(prepared), client.commitWrite(prepared)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.status === 409).length, 1);
  assert.equal((await client.history(prepared.id)).versions.length, 1);
  await assert.rejects(client.write('notes/too-large.md', text('x'.repeat(2000)), 0), (error) => error.status === 507);
  const bad = { ...prepared, id: 'a'.repeat(64), envelope: JSON.stringify({ v: 1, iv: 'x', ciphertext: 'x' }) };
  await assert.rejects(client.commitWrite(bad), (error) => error.status === 400);
  const nonzero = await client.prepareWrite('notes/missing.md', text('no base exists'), 9);
  await assert.rejects(client.commitWrite(nonzero), (error) => error.status === 409);
  assert.equal((await client.listChanges()).changes.length, 1);
});

test('nearly full storage can trash and restore immutable versions without copying ciphertext', async (t) => {
  const app = await fixture(t, { quotaBytes: 1024 });
  const { client } = await app.create();
  const prepared = await client.prepareWrite('notes/full.md', text('x'.repeat(300)), 0);
  const saved = await client.commitWrite(prepared);
  const used = Buffer.byteLength(prepared.envelope);
  assert.ok(used <= 1024 && used * 2 > 1024);
  assert.equal((await client.status()).usedBytes, used);
  const deleted = await client.remove(saved.id, 1);
  assert.equal(deleted.revision, 2);
  assert.equal((await client.read(saved.id)).deleted, true);
  assert.equal((await client.read(saved.id, 1)).envelope, prepared.envelope);
  const restored = await client.restore(saved.id, 1, 2);
  assert.equal(restored.revision, 3);
  assert.equal((await client.read(saved.id)).envelope, prepared.envelope);
  assert.equal((await client.read(saved.id, 2)).deleted, true);
  assert.equal((await client.history(saved.id)).versions.length, 3);
  assert.equal((await client.listChanges()).changes.length, 3);
  assert.equal((await client.status()).usedBytes, used);
  const db = new DatabaseSync(app.dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM envelopes').get().count, 1);
    assert.ok(!db.prepare('PRAGMA table_info(revisions)').all().some((column) => column.name === 'envelope'));
  } finally { db.close(); }
  await app.close();
  const restarted = await createCloudServer({ freeDeviceLimit: 100, dataDir: app.dataDir, enrollmentToken: app.enrollmentToken, quotaBytes: used });
  try {
    const reopened = new CloudClient({ ...client.credentials, url: `http://127.0.0.1:${restarted.port}` });
    await reopened.remove(saved.id, 3);
    await assert.rejects(reopened.remove(saved.id, 3), (error) => error.status === 409);
    await reopened.restore(saved.id, 1, 4);
    await assert.rejects(reopened.restore(saved.id, 1, 4), (error) => error.status === 409);
    await assert.rejects(reopened.commitWrite(prepared), (error) => error.status === 409);
    await assert.rejects(reopened.write('notes/full.md', text('new ciphertext'), 5), (error) => error.status === 507);
    assert.equal((await reopened.read(saved.id)).revision, 5);
    assert.equal((await reopened.status()).usedBytes, used);
    assert.equal((await reopened.listChanges()).changes.length, 5);
  } finally { await restarted.close(); }
});

test('concurrent distinct uploads respect quota and failed change writes roll back payloads and revisions', async (t) => {
  const app = await fixture(t, { quotaBytes: 1024 });
  const { client } = await app.create();
  const a = await client.prepareWrite('notes/a.md', text('x'.repeat(300)), 0);
  const b = await client.prepareWrite('notes/b.md', text('y'.repeat(300)), 0);
  const db = new DatabaseSync(app.dbPath);
  try {
    db.exec(`CREATE TRIGGER fail_change BEFORE INSERT ON changes BEGIN SELECT RAISE(ABORT, 'Synthetic write failure'); END;`);
    await assert.rejects(client.commitWrite(a), (error) => error.status === 500);
    for (const table of ['envelopes', 'revisions', 'changes']) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    assert.equal((await client.status()).usedBytes, 0);
    db.exec('DROP TRIGGER fail_change');
    const results = await Promise.allSettled([client.commitWrite(a), client.commitWrite(b)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.status === 507).length, 1);
    const saved = results[0].status === 'fulfilled' ? a : b;
    const status = await client.status();
    assert.equal(status.usedBytes, Buffer.byteLength(saved.envelope));
    assert.equal((await client.listChanges()).changes.length, 1);
    db.exec(`CREATE TRIGGER fail_change BEFORE INSERT ON changes BEGIN SELECT RAISE(ABORT, 'Synthetic write failure'); END;`);
    await assert.rejects(client.remove(saved.id, 1), (error) => error.status === 500);
    assert.equal((await client.read(saved.id)).deleted, false);
    assert.deepEqual(await client.status(), status);
    for (const table of ['envelopes', 'revisions', 'changes']) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 1);
    db.exec('DROP TRIGGER fail_change');
    assert.equal((await client.remove(saved.id, 1)).revision, 2);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('SQLite storage failures preserve readable history, atomic writes and retryable credentials', async (t) => {
  let connection;
  const prepare = DatabaseSync.prototype.prepare;
  const capture = t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) { connection = this; return prepare.call(this, sql); });
  const app = await fixture(t, { enrollmentLimit: 2 });
  capture.mock.restore();
  const { client, recoveryCode } = await app.create();
  const second = await CloudClient.recover({ url: app.url, recoveryCode, deviceName: 'Second device' });
  const pairing = await client.makePairing('Pending device');
  const saved = await client.write('notes/storage.md', text('Existing encrypted history'), 0);
  const prepared = await client.prepareWrite('notes/storage.md', text('x'.repeat(65536)), 1);
  const db = new DatabaseSync(app.dbPath, { readOnly: true });
  const snapshot = () => ['vaults', 'pairings', 'envelopes', 'revisions', 'changes'].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  try {
    await t.test('native SQLITE_FULL in WAL mode retains its cause after automatic rollback', async (t) => {
      assert.equal(connection.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      const maximum = connection.prepare('PRAGMA max_page_count').get().max_page_count;
      const pages = connection.prepare('PRAGMA page_count').get().page_count;
      const before = snapshot();
      let nativeError;
      const observe = t.mock.method(connection, 'prepare', function (sql) {
        const statement = prepare.call(this, sql);
        if (sql.startsWith('INSERT INTO envelopes')) {
          const run = statement.run;
          t.mock.method(statement, 'run', function (...args) {
            try { return run.apply(this, args); } catch (error) { nativeError = error; throw error; }
          });
        }
        return statement;
      });
      connection.exec(`PRAGMA max_page_count=${pages}`);
      try {
        await assert.rejects(client.commitWrite(prepared), (error) => error.status === 507 && /storage.*full/i.test(error.message));
        assert.equal(nativeError.code, 'ERR_SQLITE_ERROR');
        assert.equal(nativeError.errcode, 13);
        assert.equal(connection.isTransaction, false);
        assert.deepEqual(snapshot(), before);
        assert.equal((await client.read(saved.id)).revision, 1);
        assert.equal((await client.history(saved.id)).versions.length, 1);
        const restoredDir = await mkdtemp(join(tmpdir(), 'jotdrop-full-restore-'));
        try {
          await backupCloudDatabase(app.dbPath, join(restoredDir, 'cloud.db'));
          const restored = await createCloudServer({ freeDeviceLimit: 100, dataDir: restoredDir, enrollmentToken: randomToken() });
          try {
            const reopened = new CloudClient({ ...client.credentials, url: `http://127.0.0.1:${restored.port}` });
            assert.equal((await reopened.read(saved.id)).revision, 1);
            assert.equal((await reopened.listChanges()).changes.length, 1);
          } finally { await restored.close(); }
        } finally { await rm(restoredDir, { recursive: true, force: true }); }
      } finally { observe.mock.restore(); connection.exec(`PRAGMA max_page_count=${maximum}`); }
      assert.equal((await client.commitWrite(prepared)).revision, 2);
      await assert.rejects(client.commitWrite(prepared), (error) => error.status === 409 && error.currentRevision === 2);
    });

    await t.test('failed lastSeenAt writes do not deny authorized reads or hide unrelated errors', async (t) => {
      await client.revokeDevice(second.credentials.deviceId);
      connection.exec('PRAGMA query_only=ON');
      try {
        assert.ok((await client.status()).usedBytes > 0);
        assert.equal((await client.read(saved.id)).file.path, 'notes/storage.md');
        await assert.rejects(client.write('notes/readonly.md', text('Kept locally'), 0), (error) => error.status === 500);
      } finally { connection.exec('PRAGMA query_only=OFF'); }
      const seen = db.prepare('SELECT lastSeenAt FROM devices WHERE id=?').get(client.credentials.deviceId).lastSeenAt;
      let errcode = 13, rejectRevocation = false;
      const inject = t.mock.method(connection, 'prepare', function (sql) {
        const statement = prepare.call(this, sql);
        if (sql.startsWith('UPDATE devices SET lastSeenAt=') || rejectRevocation && sql.startsWith('UPDATE devices SET revoked=')) t.mock.method(statement, 'run', () => {
          throw Object.assign(new Error('Synthetic private storage failure'), { code: 'ERR_SQLITE_ERROR', errcode });
        });
        return statement;
      });
      try {
        for (errcode of [13, 778, 8, 5, 6]) {
          assert.ok((await client.status()).usedBytes > 0);
          assert.equal((await client.devices()).devices.length, 2);
          assert.ok((await client.listChanges()).changes.length > 0);
          assert.equal((await client.read(saved.id)).file.path, 'notes/storage.md');
          assert.equal((await client.read(saved.id, 1)).revision, 1);
          assert.ok((await client.history(saved.id)).versions.length > 0);
          await assert.rejects(second.status(), (error) => error.status === 401);
          await assert.rejects(new CloudClient({ ...client.credentials, token: randomToken() }).status(), (error) => error.status === 401);
        }
        assert.equal(db.prepare('SELECT lastSeenAt FROM devices WHERE id=?').get(client.credentials.deviceId).lastSeenAt, seen);
        errcode = 778;
        const before = snapshot();
        const failWrite = t.mock.method(connection, 'exec', () => {
          throw Object.assign(new Error('Synthetic private mutation failure'), { code: 'ERR_SQLITE_ERROR', errcode });
        });
        await assert.rejects(client.write('notes/failed.md', text('Kept locally'), 0), (error) => error.status === 500 && error.message === 'Internal server error');
        failWrite.mock.restore();
        rejectRevocation = true;
        await assert.rejects(client.revokeDevice(second.credentials.deviceId), (error) => error.status === 500);
        rejectRevocation = false;
        assert.deepEqual(snapshot(), before);
        errcode = 19;
        await assert.rejects(client.status(), (error) => error.status === 500 && error.message === 'Internal server error');
      } finally { inject.mock.restore(); }
      assert.ok((await client.status()).usedBytes > 0);
    });

    await t.test('WAL commit and begin failures never consume credentials or leave partial mutations', async (t) => {
      const next = await client.prepareWrite('notes/storage.md', text('Next draft'), (await client.read(saved.id)).revision);
      const attempts = [
        () => app.create('Failed enrollment'),
        () => CloudClient.recover({ url: app.url, recoveryCode, deviceName: 'Failed recovery' }),
        () => CloudClient.claim({ pairingCode: pairing.pairingCode }),
        () => client.makePairing('Failed pairing'),
        () => client.commitWrite(next),
        () => client.remove(saved.id, next.baseRevision),
        () => client.restore(saved.id, 1, next.baseRevision),
      ];
      const before = snapshot(), devices = db.prepare('SELECT COUNT(*) AS count FROM devices').get().count;
      const exec = connection.exec;
      let rollbackAttempts = 0, mode = 'COMMIT', automaticRollback = true;
      const inject = t.mock.method(connection, 'exec', function (sql) {
        if (sql === 'ROLLBACK') rollbackAttempts++;
        if (sql === mode) {
          // Model SQLite's automatic transaction rollback after a WAL write failure.
          if (automaticRollback && this.isTransaction) exec.call(this, 'ROLLBACK');
          throw Object.assign(new Error('Synthetic private WAL path'), { code: 'ERR_SQLITE_ERROR', errcode: 778 });
        }
        return exec.call(this, sql);
      });
      try {
        for (const attempt of attempts) {
          await assert.rejects(attempt, (error) => error.status === 500 && error.message === 'Internal server error');
          assert.equal(connection.isTransaction, false);
          assert.deepEqual(snapshot(), before);
          assert.equal(db.prepare('SELECT COUNT(*) AS count FROM devices').get().count, devices);
        }
        assert.equal(rollbackAttempts, 0);
        automaticRollback = false;
        await assert.rejects(client.commitWrite(next), (error) => error.status === 500);
        assert.equal(rollbackAttempts, 1);
        assert.equal(connection.isTransaction, false);
        assert.deepEqual(snapshot(), before);
        mode = 'BEGIN IMMEDIATE';
        await assert.rejects(client.commitWrite(next), (error) => error.status === 500);
        assert.deepEqual(snapshot(), before);
      } finally { inject.mock.restore(); }
      assert.equal((await client.commitWrite(next)).revision, next.baseRevision + 1);
      const claimed = await CloudClient.claim({ pairingCode: pairing.pairingCode });
      assert.equal((await claimed.read(saved.id)).revision, next.baseRevision + 1);
      await app.create('Retried enrollment');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    });
  } finally { db.close(); }
});

test('history entries are bounded independently of payload reuse without deleting existing versions', async (t) => {
  const app = await fixture(t, { maxHistoryEntries: 3, quotaBytes: 1024, enrollmentLimit: 2 });
  const { client } = await app.create();
  const prepared = await client.prepareWrite('notes/bounded.md', text('x'.repeat(300)), 0);
  await client.commitWrite(prepared);
  await client.remove(prepared.id, 1);
  await client.restore(prepared.id, 1, 2);
  const db = new DatabaseSync(app.dbPath, { readOnly: true });
  try {
    const before = ['envelopes', 'revisions', 'changes'].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    for (const attempt of [
      () => client.commitWrite({ ...prepared, baseRevision: 3 }),
      () => client.write('notes/bounded.md', text('new payload'), 3),
      () => client.write('notes/new.md', text('new object'), 0),
      () => client.remove(prepared.id, 3),
      () => client.restore(prepared.id, 1, 3),
    ]) await assert.rejects(attempt, (error) => error.status === 507 && /history.*limit/i.test(error.message));
    assert.deepEqual(['envelopes', 'revisions', 'changes'].map((table) => db.prepare(`SELECT * FROM ${table}`).all()), before);
    assert.equal((await client.read(prepared.id)).revision, 3);
    assert.equal((await client.read(prepared.id, 1)).envelope, prepared.envelope);
    assert.equal((await client.read(prepared.id, 2)).deleted, true);
    assert.equal((await client.history(prepared.id)).versions.length, 3);
    assert.equal((await client.listChanges()).changes.length, 3);
    assert.deepEqual((await client.status()).history, { revisionCount: 3, changeCount: 3, maxEntries: 3 });
    assert.equal((await client.status()).usedBytes, Buffer.byteLength(prepared.envelope));
    await assert.rejects(client.commitWrite(prepared), (error) => error.status === 409 && error.currentRevision === 3);
    const other = (await app.create('Separate vault')).client;
    await other.write('notes/separate.md', text('separate capacity'), 0);
    assert.deepEqual((await other.status()).history, { revisionCount: 1, changeCount: 1, maxEntries: 3 });
    assert.equal((await client.devices()).devices.length, 1);
  } finally { db.close(); }
});

test('history capacity is atomic across connections, failed inserts and stale retries', async (t) => {
  const app = await fixture(t, { maxHistoryEntries: 2 });
  const { client } = await app.create();
  const first = await client.prepareWrite('notes/first.md', text('first'), 0);
  await client.commitWrite(first);
  const a = await client.prepareWrite('notes/a.md', text('A'), 0);
  const b = await client.prepareWrite('notes/b.md', text('B'), 0);
  const peer = await createCloudServer({ freeDeviceLimit: 100, dataDir: app.dataDir, enrollmentToken: app.enrollmentToken, maxHistoryEntries: 2 });
  const second = new CloudClient({ ...client.credentials, url: `http://127.0.0.1:${peer.port}` });
  const db = new DatabaseSync(app.dbPath);
  try {
    db.exec(`CREATE TRIGGER fail_history_change BEFORE INSERT ON changes BEGIN SELECT RAISE(ABORT, 'Synthetic history failure'); END;`);
    await assert.rejects(second.commitWrite(a), (error) => error.status === 500);
    assert.deepEqual((await client.status()).history, { revisionCount: 1, changeCount: 1, maxEntries: 2 });
    for (const table of ['envelopes', 'revisions', 'changes']) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 1);
    db.exec('DROP TRIGGER fail_history_change');
    const results = await Promise.allSettled([client.commitWrite(a), second.commitWrite(b)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.status === 507).length, 1);
    const saved = results[0].status === 'fulfilled' ? a : b;
    const rejected = saved === a ? b : a;
    await assert.rejects(second.commitWrite(saved), (error) => error.status === 409 && error.currentRevision === 1);
    await assert.rejects(client.commitWrite(rejected), (error) => error.status === 507);
    assert.deepEqual((await second.status()).history, { revisionCount: 2, changeCount: 2, maxEntries: 2 });
    assert.equal((await client.listChanges()).changes.length, 2);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); await peer.close(); }
});

test('history limits validate configuration and independently bound revision and changefeed rows', async (t) => {
  const app = await fixture(t, { maxHistoryEntries: 2 });
  for (const maxHistoryEntries of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    await assert.rejects(createCloudServer({ freeDeviceLimit: 100, dataDir: app.dataDir, enrollmentToken: app.enrollmentToken, maxHistoryEntries }), /history entry limit/);
  }
  const { client } = await app.create();
  const prepared = await client.prepareWrite('notes/independent.md', text('independent counts'), 0);
  await client.commitWrite(prepared);
  const db = new DatabaseSync(app.dbPath);
  try {
    // Synthetic older data need not have matching row counts; neither count can be skipped.
    db.exec('INSERT INTO changes(vaultId,id,revision,deleted,size,updatedAt,deviceId) SELECT vaultId,id,revision,deleted,size,updatedAt,deviceId FROM changes');
    assert.deepEqual((await client.status()).history, { revisionCount: 1, changeCount: 2, maxEntries: 2 });
    await assert.rejects(client.remove(prepared.id, 1), (error) => error.status === 507);
    db.exec('DELETE FROM changes WHERE sequence=(SELECT MAX(sequence) FROM changes)');
    db.exec('INSERT INTO revisions SELECT vaultId,id,revision+1,envelopeHash,deleted,size,updatedAt,deviceId FROM revisions');
    assert.deepEqual((await client.status()).history, { revisionCount: 2, changeCount: 1, maxEntries: 2 });
    await assert.rejects(client.restore(prepared.id, 1, 2), (error) => error.status === 507);
    assert.equal((await client.read(prepared.id)).revision, 2);
    assert.equal((await client.listChanges()).changes.length, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('history counts survive lower restart limits and live WAL backup without purging data', async (t) => {
  const app = await fixture(t, { maxHistoryEntries: 4 });
  const { client } = await app.create();
  const saved = await client.write('notes/history-backup.md', text('history preserved'), 0);
  await client.remove(saved.id, 1);
  await client.restore(saved.id, 1, 2);
  const changes = await client.listChanges();
  const restoredDir = await mkdtemp(join(tmpdir(), 'jotdrop-history-restore-'));
  t.after(() => rm(restoredDir, { recursive: true, force: true }));
  await backupCloudDatabase(app.dbPath, join(restoredDir, 'cloud.db'));
  await client.remove(saved.id, 3);
  await app.close();
  const restarted = await createCloudServer({ freeDeviceLimit: 100, dataDir: app.dataDir, enrollmentToken: app.enrollmentToken, maxHistoryEntries: 2 });
  const restored = await createCloudServer({ freeDeviceLimit: 100, dataDir: restoredDir, enrollmentToken: randomToken(), maxHistoryEntries: 4 });
  try {
    const reopened = new CloudClient({ ...client.credentials, url: `http://127.0.0.1:${restarted.port}` });
    assert.deepEqual((await reopened.status()).history, { revisionCount: 4, changeCount: 4, maxEntries: 2 });
    assert.equal((await reopened.history(saved.id)).versions.length, 4);
    assert.equal((await reopened.read(saved.id, 1)).file.path, 'notes/history-backup.md');
    await assert.rejects(reopened.restore(saved.id, 1, 4), (error) => error.status === 507);
    const recovered = new CloudClient({ ...client.credentials, url: `http://127.0.0.1:${restored.port}` });
    assert.deepEqual(await recovered.listChanges(), changes);
    assert.deepEqual((await recovered.status()).history, { revisionCount: 3, changeCount: 3, maxEntries: 4 });
    assert.equal((await recovered.remove(saved.id, 3)).revision, 4);
    await assert.rejects(recovered.restore(saved.id, 1, 4), (error) => error.status === 507);
    assert.equal((await recovered.read(saved.id, 1)).deleted, false);
  } finally { await restarted.close(); await restored.close(); }
});

test('payload reuse is scoped to each vault and object and never makes historical storage free', async (t) => {
  const app = await fixture(t, { enrollmentLimit: 2 });
  const a = (await app.create('A')).client, b = (await app.create('B')).client;
  const prepared = await a.prepareWrite('notes/a.md', text('one encrypted payload'), 0);
  const size = Buffer.byteLength(prepared.envelope);
  await a.commitWrite(prepared);
  await a.commitWrite({ ...prepared, baseRevision: 1 });
  assert.equal((await a.status()).usedBytes, size);
  const separateId = 'b'.repeat(64);
  await a.commitWrite({ ...prepared, id: separateId });
  await b.commitWrite(prepared);
  assert.equal((await a.status()).usedBytes, size * 2);
  assert.equal((await b.status()).usedBytes, size);
  await assert.rejects(b.call(`/objects/${separateId}`), (error) => error.status === 404);
  const changed = await a.prepareWrite('notes/a.md', text('different encrypted payload'), 2);
  await a.commitWrite(changed);
  await a.remove(prepared.id, 3);
  await a.restore(prepared.id, 1, 4);
  assert.equal((await a.status()).usedBytes, size * 2 + Buffer.byteLength(changed.envelope));
  assert.equal((await a.read(prepared.id, 3)).envelope, changed.envelope);
  assert.equal((await a.read(prepared.id)).envelope, prepared.envelope);
});

test('legacy inline history migrates atomically and survives restart and WAL backup restore', async (t) => {
  const app = await fixture(t);
  const { client } = await app.create();
  const saved = await client.write('notes/migration.md', text('Synthetic legacy data'), 0);
  await client.write('notes/migration.md', text('Synthetic newer data'), 1);
  await client.remove(saved.id, 2);
  await client.restore(saved.id, 1, 3);
  const versions = await Promise.all([1, 2, 3, 4].map((revision) => client.read(saved.id, revision)));
  const changes = await client.listChanges();
  const used = (await client.status()).usedBytes;
  await app.close();
  const legacy = new DatabaseSync(app.dbPath);
  try {
    // Recreate the shipped preview schema, including its duplicate tombstone/restore payloads.
    legacy.exec(`PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
      CREATE TABLE revisions_legacy(vaultId TEXT NOT NULL REFERENCES vaults(id), id TEXT NOT NULL, revision INTEGER NOT NULL, envelope TEXT NOT NULL, deleted INTEGER NOT NULL, size INTEGER NOT NULL, updatedAt TEXT NOT NULL, deviceId TEXT NOT NULL, PRIMARY KEY(vaultId,id,revision));
      INSERT INTO revisions_legacy SELECT r.vaultId,r.id,r.revision,e.envelope,r.deleted,r.size,r.updatedAt,r.deviceId FROM revisions r JOIN envelopes e USING(vaultId,id,envelopeHash);
      DROP TABLE revisions; DROP TABLE envelopes; ALTER TABLE revisions_legacy RENAME TO revisions;
      PRAGMA user_version=0; COMMIT;`);
    legacy.exec('UPDATE revisions SET size=size+1 WHERE revision=4');
    await assert.rejects(createCloudServer({ freeDeviceLimit: 100, dataDir: app.dataDir, enrollmentToken: app.enrollmentToken }), /size mismatch/);
    assert.equal(legacy.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(legacy.prepare('SELECT COUNT(*) AS count FROM revisions').get().count, 4);
    assert.ok(legacy.prepare('PRAGMA table_info(revisions)').all().some((column) => column.name === 'envelope'));
    assert.equal(legacy.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('envelopes','revisions_migrated')").get().count, 0);
    legacy.exec('UPDATE revisions SET size=size-1 WHERE revision=4');
  } finally { legacy.close(); }
  const capped = await createCloudServer({ freeDeviceLimit: 100, dataDir: app.dataDir, enrollmentToken: app.enrollmentToken, maxHistoryEntries: 3 });
  try {
    const existing = new CloudClient({ ...client.credentials, url: `http://127.0.0.1:${capped.port}` });
    assert.deepEqual((await existing.status()).history, { revisionCount: 4, changeCount: 4, maxEntries: 3 });
    assert.deepEqual(await Promise.all([1, 2, 3, 4].map((revision) => existing.read(saved.id, revision))), versions);
    assert.deepEqual(await existing.listChanges(), changes);
    await assert.rejects(existing.remove(saved.id, 4), (error) => error.status === 507);
  } finally { await capped.close(); }
  const migrated = await createCloudServer({ freeDeviceLimit: 100, dataDir: app.dataDir, enrollmentToken: app.enrollmentToken, quotaBytes: used });
  const restoredDir = await mkdtemp(join(tmpdir(), 'jotdrop-migrated-restore-'));
  try {
    const reopened = new CloudClient({ ...client.credentials, url: `http://127.0.0.1:${migrated.port}` });
    assert.deepEqual(await Promise.all([1, 2, 3, 4].map((revision) => reopened.read(saved.id, revision))), versions);
    assert.deepEqual(await reopened.listChanges(), changes);
    assert.equal((await reopened.status()).usedBytes, used);
    const db = new DatabaseSync(app.dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM envelopes').get().count, 2);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { db.close(); }
    await reopened.remove(saved.id, 4);
    await backupCloudDatabase(migrated.dbPath, join(restoredDir, 'cloud.db'));
    await reopened.restore(saved.id, 1, 5);
    const restored = await createCloudServer({ freeDeviceLimit: 100, dataDir: restoredDir, enrollmentToken: randomToken(), quotaBytes: used });
    try {
      const recovered = new CloudClient({ ...client.credentials, url: `http://127.0.0.1:${restored.port}` });
      assert.equal((await recovered.read(saved.id)).revision, 5);
      assert.equal((await recovered.read(saved.id)).deleted, true);
      assert.equal((await recovered.restore(saved.id, 1, 5)).revision, 6);
      assert.equal((await recovered.status()).usedBytes, used);
      assert.equal((await recovered.listChanges()).changes.at(-1).sequence, 6);
    } finally { await restored.close(); }
  } finally { await migrated.close(); await rm(restoredDir, { recursive: true, force: true }); }
});

test('device entries bound recovery and pairing claims including revoked devices without losing history', async (t) => {
  const app = await fixture(t, { maxDeviceEntries: 2, enrollmentLimit: 2 });
  const { client, recoveryCode } = await app.create();
  const saved = await client.write('notes/device-cap.md', text('still available'), 0);
  const paired = await CloudClient.claim({ pairingCode: (await client.makePairing('Second device')).pairingCode });
  const waiting = await client.makePairing('Waiting device');
  const recover = () => CloudClient.recover({ url: app.url, recoveryCode, deviceName: 'Recovery device' });
  await assert.rejects(recover, (error) => error.status === 507 && /device.*limit/i.test(error.message));
  await assert.rejects(CloudClient.claim({ pairingCode: waiting.pairingCode }), (error) => error.status === 507);
  await client.revokeDevice(paired.credentials.deviceId);
  await assert.rejects(paired.status(), (error) => error.status === 401);
  await assert.rejects(recover, (error) => error.status === 507);
  await assert.rejects(CloudClient.claim({ pairingCode: waiting.pairingCode }), (error) => error.status === 507);
  await assert.rejects(client.revokeDevice(client.credentials.deviceId), (error) => error.status === 409);
  const devices = (await client.devices()).devices;
  assert.equal(devices.length, 2);
  assert.equal(devices.filter((device) => device.revoked).length, 1);
  assert.equal((await client.read(saved.id, 1)).file.path, 'notes/device-cap.md');
  assert.equal((await client.history(saved.id)).versions.length, 1);
  const db = new DatabaseSync(app.dbPath, { readOnly: true });
  try {
    const code = JSON.parse(new TextDecoder().decode(base64ToBytes(waiting.pairingCode)));
    assert.equal(db.prepare('SELECT claimed FROM pairings WHERE id=?').get(code.pairingId).claimed, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
  const other = await app.create('Other vault');
  await CloudClient.recover({ url: app.url, recoveryCode: other.recoveryCode, deviceName: 'Other recovered' });
  assert.equal((await other.client.devices()).devices.length, 2);
});

test('device admission is atomic across recovery and pairing connections and claim failures roll back', async (t) => {
  const app = await fixture(t, { maxDeviceEntries: 2 });
  const { client, recoveryCode } = await app.create();
  const pairing = await client.makePairing('Pairing contender');
  const peer = await createCloudServer({ freeDeviceLimit: 100, dataDir: app.dataDir, enrollmentToken: app.enrollmentToken, maxDeviceEntries: 2 });
  const db = new DatabaseSync(app.dbPath);
  try {
    db.exec(`CREATE TRIGGER fail_claim BEFORE UPDATE OF claimed ON pairings WHEN NEW.claimed=1 BEGIN SELECT RAISE(ABORT, 'Synthetic claim failure'); END;`);
    await assert.rejects(CloudClient.claim({ pairingCode: pairing.pairingCode }), (error) => error.status === 500);
    assert.equal((await client.devices()).devices.length, 1);
    assert.equal(db.prepare('SELECT claimed FROM pairings').get().claimed, 0);
    db.exec('DROP TRIGGER fail_claim');
    const results = await Promise.allSettled([
      CloudClient.claim({ pairingCode: pairing.pairingCode }),
      CloudClient.recover({ url: `http://127.0.0.1:${peer.port}`, recoveryCode, deviceName: 'Recovery contender' }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.status === 507).length, 1);
    assert.equal((await client.devices()).devices.length, 2);
    assert.equal(db.prepare('SELECT claimed FROM pairings').get().claimed, results[0].status === 'fulfilled' ? 1 : 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); await peer.close(); }
});

test('pairing entries retain used codes until expiry and reclaim exactly expired entries atomically', async (t) => {
  let time = Date.now();
  const app = await fixture(t, { maxPairingEntries: 2, enrollmentLimit: 2, clock: () => time });
  const { client } = await app.create();
  const a = await client.makePairing('A');
  const b = await client.makePairing('B');
  await assert.rejects(client.makePairing('Over capacity'), (error) => error.status === 507 && /pairing.*limit/i.test(error.message));
  await CloudClient.claim({ pairingCode: a.pairingCode });
  await assert.rejects(CloudClient.claim({ pairingCode: a.pairingCode }), (error) => error.status === 409);
  await assert.rejects(client.makePairing('Still full'), (error) => error.status === 507);
  const other = (await app.create('Other vault')).client;
  await other.makePairing('Separate capacity');
  time += 600000;
  await assert.rejects(CloudClient.claim({ pairingCode: b.pairingCode }), (error) => error.status === 410);
  const db = new DatabaseSync(app.dbPath);
  try {
    const before = db.prepare('SELECT * FROM pairings ORDER BY id').all();
    db.exec(`CREATE TRIGGER fail_pairing BEFORE INSERT ON pairings BEGIN SELECT RAISE(ABORT, 'Synthetic pairing failure'); END;`);
    await assert.rejects(client.makePairing('Failed replacement'), (error) => error.status === 500);
    assert.deepEqual(db.prepare('SELECT * FROM pairings ORDER BY id').all(), before);
    db.exec('DROP TRIGGER fail_pairing');
    await client.makePairing('Replacement');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pairings WHERE vaultId=?').get(client.credentials.vaultId).count, 1);
    assert.equal((await client.devices()).devices.length, 2);
  } finally { db.close(); }
});

test('device and pairing ceilings survive lower-limit restart and WAL restore without purging metadata', async (t) => {
  const app = await fixture(t, { maxDeviceEntries: 3, maxPairingEntries: 3 });
  for (const option of ['maxDeviceEntries', 'maxPairingEntries']) for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    await assert.rejects(createCloudServer({ freeDeviceLimit: 100, dataDir: app.dataDir, enrollmentToken: app.enrollmentToken, [option]: value }), /metadata entry limits/);
  }
  const db = new DatabaseSync(app.dbPath);
  try {
    db.exec(`CREATE TRIGGER fail_first_device BEFORE INSERT ON devices BEGIN SELECT RAISE(ABORT, 'Synthetic enrollment failure'); END;`);
    await assert.rejects(app.create(), (error) => error.status === 500);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM vaults').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM devices').get().count, 0);
    db.exec('DROP TRIGGER fail_first_device');
  } finally { db.close(); }
  const { client, recoveryCode } = await app.create();
  const saved = await client.write('notes/metadata-backup.md', text('metadata backup'), 0);
  const revoked = await CloudClient.recover({ url: app.url, recoveryCode, deviceName: 'Revoked device' });
  await client.revokeDevice(revoked.credentials.deviceId);
  const pending = await client.makePairing('Pending device');
  const restoredDir = await mkdtemp(join(tmpdir(), 'jotdrop-device-restore-'));
  t.after(() => rm(restoredDir, { recursive: true, force: true }));
  await backupCloudDatabase(app.dbPath, join(restoredDir, 'cloud.db'));
  await CloudClient.recover({ url: app.url, recoveryCode, deviceName: 'Third device' });
  await client.makePairing('Second code');
  await client.makePairing('Third code');
  await app.close();
  const restarted = await createCloudServer({ freeDeviceLimit: 100, dataDir: app.dataDir, enrollmentToken: app.enrollmentToken, maxDeviceEntries: 1, maxPairingEntries: 1 });
  const restored = await createCloudServer({ freeDeviceLimit: 100, dataDir: restoredDir, enrollmentToken: randomToken(), maxDeviceEntries: 3, maxPairingEntries: 1 });
  try {
    const reopened = new CloudClient({ ...client.credentials, url: `http://127.0.0.1:${restarted.port}` });
    assert.equal((await reopened.devices()).devices.length, 3);
    await assert.rejects(CloudClient.recover({ url: reopened.credentials.url, recoveryCode, deviceName: 'No room' }), (error) => error.status === 507);
    await assert.rejects(reopened.makePairing('No room'), (error) => error.status === 507);
    assert.equal((await reopened.read(saved.id)).revision, 1);
    const recovered = new CloudClient({ ...client.credentials, url: `http://127.0.0.1:${restored.port}` });
    assert.equal((await recovered.devices()).devices.length, 2);
    const originalCode = JSON.parse(new TextDecoder().decode(base64ToBytes(pending.pairingCode)));
    const pairingCode = Buffer.from(JSON.stringify({ ...originalCode, url: recovered.credentials.url })).toString('base64url');
    const claimed = await CloudClient.claim({ pairingCode });
    assert.equal((await claimed.read(saved.id)).file.path, 'notes/metadata-backup.md');
    await assert.rejects(CloudClient.recover({ url: recovered.credentials.url, recoveryCode, deviceName: 'Full again' }), (error) => error.status === 507);
    await assert.rejects(recovered.makePairing('Still one used code'), (error) => error.status === 507);
    await assert.rejects(new CloudClient({ ...revoked.credentials, url: recovered.credentials.url }).status(), (error) => error.status === 401);
  } finally { await restarted.close(); await restored.close(); }
});

test('pairing admission respects the last persisted slot across separate server connections', async (t) => {
  const app = await fixture(t, { maxPairingEntries: 1 });
  const { client } = await app.create();
  const peer = await createCloudServer({ freeDeviceLimit: 100, dataDir: app.dataDir, enrollmentToken: app.enrollmentToken, maxPairingEntries: 1 });
  try {
    const second = new CloudClient({ ...client.credentials, url: `http://127.0.0.1:${peer.port}` });
    const results = await Promise.allSettled([client.makePairing('A'), second.makePairing('B')]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.status === 507).length, 1);
    const saved = results.find((result) => result.status === 'fulfilled').value;
    await CloudClient.claim({ pairingCode: saved.pairingCode });
    await assert.rejects(second.makePairing('Used code still counts'), (error) => error.status === 507);
    assert.equal((await client.devices()).devices.length, 2);
  } finally { await peer.close(); }
});

test('pairing expires, recovery rejects wrong keys and repeated attempts are bounded', async (t) => {
  let time = Date.now();
  const app = await fixture(t, { clock: () => time });
  const { client, recoveryCode } = await app.create();
  const pairing = await client.makePairing('Expired device');
  time += 600001;
  await assert.rejects(CloudClient.claim({ pairingCode: pairing.pairingCode }), (error) => error.status === 410);
  const recovery = decodeRecovery(recoveryCode);
  for (let i = 0; i < 5; i++) assert.equal((await fetch(`${app.url}/api/v1/recover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vaultId: recovery.vaultId, recoveryToken: randomToken(), deviceName: 'Invalid', deviceTokenHash: 'a'.repeat(64) }) })).status, 401);
  await assert.rejects(CloudClient.recover({ url: app.url, recoveryCode, deviceName: 'Too many' }), (error) => error.status === 429);
});

test('revoking a device denies pairing creation even when its request body is already in flight', { timeout: 5000 }, async (t) => {
  let observe;
  const app = await fixture(t, { clock: () => { observe?.(); return Date.now(); } });
  const { client } = await app.create();
  const second = await CloudClient.claim({ pairingCode: (await client.makePairing('Second device')).pairingCode });
  const prepared = await second.prepareWrite('notes/test.md', text('Synthetic test data'), 0);
  const payload = JSON.stringify({ deviceName: 'Revoked pairing', deviceTokenHash: 'a'.repeat(64), claimTokenHash: 'b'.repeat(64), envelope: prepared.envelope });
  const authorized = new Promise((done) => { observe = done; });
  let pending;
  const response = new Promise((done, reject) => {
    pending = request(`${app.url}/api/v1/pairings`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${second.credentials.token}`, 'X-JotDrop-Vault': second.credentials.vaultId, 'X-JotDrop-Device': second.credentials.deviceId } }, (res) => { res.resume(); done(res.statusCode); });
    pending.on('error', reject);
    pending.write(payload.slice(0, 1));
  });
  t.after(() => pending.destroy());
  await authorized;
  observe = undefined;
  await client.revokeDevice(second.credentials.deviceId);
  pending.end(payload.slice(1));
  assert.equal(await response, 401);
  assert.equal((await client.devices()).devices.length, 2);
});

test('auth and metadata routes bound request bodies separately from encrypted file uploads', async (t) => {
  const app = await fixture(t);
  const { client } = await app.create();
  const pairing = JSON.parse(new TextDecoder().decode(base64ToBytes((await client.makePairing('Test device')).pairingCode)));
  const saved = await client.write('notes/large-enough.md', text('x'.repeat(20000)), 0);
  const oversized = { padding: 'x'.repeat(16 * 1024) };
  for (const route of ['/vaults', '/recover', `/pairings/${pairing.pairingId}/claim`]) {
    const response = await fetch(`${app.url}/api/v1${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${app.enrollmentToken}` }, body: JSON.stringify(oversized) });
    assert.equal(response.status, 413, route);
    await response.arrayBuffer();
  }
  const chunked = JSON.stringify(oversized);
  const chunkedStatus = await new Promise((done, reject) => {
    const pending = request(`${app.url}/api/v1/recover`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (response) => { response.resume(); done(response.statusCode); });
    pending.on('error', reject);
    pending.write(chunked.slice(0, 8192));
    pending.end(chunked.slice(8192));
  });
  assert.equal(chunkedStatus, 413);
  for (const [route, method] of [['/pairings', 'POST'], [`/objects/${saved.id}`, 'DELETE'], [`/objects/${saved.id}/restore`, 'POST']]) {
    await assert.rejects(client.call(route, method, oversized), (error) => error.status === 413);
  }
  assert.equal((await client.history(saved.id)).versions.length, 1);
  assert.equal((await client.read(saved.id)).deleted, false);
});

test('concurrent request admission bounds slow uploads across vaults and never commits rejected writes', { timeout: 5000 }, async (t) => {
  let observe;
  const app = await fixture(t, { maxConcurrentRequests: 2, enrollmentLimit: 2, clock: () => { observe?.(); return Date.now(); } });
  const a = (await app.create('A')).client, b = (await app.create('B')).client;
  const preparedA = await a.prepareWrite('notes/a.md', text('A retained locally'), 0);
  const preparedB = await b.prepareWrite('notes/b.md', text('B retained locally'), 0);
  async function hold(client, prepared) {
    const payload = JSON.stringify({ baseRevision: prepared.baseRevision, envelope: prepared.envelope });
    const authorized = new Promise((done) => { observe = done; });
    let pending;
    const response = new Promise((done, reject) => {
      pending = request(`${app.url}/api/v1/objects/${prepared.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${client.credentials.token}`, 'X-JotDrop-Vault': client.credentials.vaultId, 'X-JotDrop-Device': client.credentials.deviceId } }, (res) => {
        res.resume(); res.on('end', () => done(res.statusCode));
      });
      pending.on('error', reject);
      pending.write(payload.slice(0, 1));
    });
    response.catch(() => {});
    t.after(() => pending.destroy());
    await authorized;
    observe = undefined;
    return { pending, response, finish: () => pending.end(payload.slice(1)) };
  }
  const first = await hold(a, preparedA), second = await hold(b, preparedB);
  await assert.rejects(a.commitWrite(preparedA), (error) => error.status === 503);
  const overloaded = await fetch(`${app.url}/api/v1/recover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(overloaded.status, 503);
  assert.equal(overloaded.headers.get('retry-after'), '1');
  assert.equal(overloaded.headers.get('connection'), 'close');
  await overloaded.arrayBuffer();
  const db = new DatabaseSync(app.dbPath, { readOnly: true });
  try {
    for (const table of ['envelopes', 'revisions', 'changes']) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
  } finally { db.close(); }
  first.finish();
  assert.equal(await first.response, 201);
  assert.equal((await a.status()).history.revisionCount, 1);
  await assert.rejects(a.commitWrite(preparedA), (error) => error.status === 409);
  second.finish();
  assert.equal(await second.response, 201);
  assert.equal((await a.listChanges()).changes.length, 1);
  assert.equal((await b.listChanges()).changes.length, 1);
  assert.equal((await a.read(preparedA.id)).file.path, 'notes/a.md');
  assert.equal((await b.read(preparedB.id)).file.path, 'notes/b.md');
});

test('request capacity is released after aborts, validation errors and failed transactions', { timeout: 5000 }, async (t) => {
  const app = await fixture(t, { maxConcurrentRequests: 1 });
  for (const maxConcurrentRequests of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    await assert.rejects(createCloudServer({ freeDeviceLimit: 100, dataDir: app.dataDir, enrollmentToken: app.enrollmentToken, maxConcurrentRequests }), /concurrent request limit/);
  }
  const { client } = await app.create();
  const prepared = await client.prepareWrite('notes/aborted.md', text('aborted draft'), 0);
  let started, pending;
  const received = new Promise((done) => { started = done; });
  const closed = new Promise((done) => { app.server.once('request', (req, res) => { res.once('close', done); started(); }); });
  pending = request(`${app.url}/api/v1/objects/${prepared.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': 1000, Authorization: `Bearer ${client.credentials.token}`, 'X-JotDrop-Vault': client.credentials.vaultId, 'X-JotDrop-Device': client.credentials.deviceId } });
  pending.on('error', () => {});
  t.after(() => pending.destroy());
  pending.write('{');
  await received;
  pending.destroy();
  await closed;
  assert.equal((await client.status()).history.revisionCount, 0);
  for (let i = 0; i < 3; i++) {
    await assert.rejects(client.call(`/objects/${prepared.id}`, 'PUT', { baseRevision: -1 }), (error) => error.status === 400);
    assert.equal((await client.status()).history.revisionCount, 0);
  }
  const db = new DatabaseSync(app.dbPath);
  try {
    db.exec(`CREATE TRIGGER fail_busy_write BEFORE INSERT ON changes BEGIN SELECT RAISE(ABORT, 'Synthetic busy write failure'); END;`);
    await assert.rejects(client.commitWrite(prepared), (error) => error.status === 500);
    assert.equal((await client.status()).history.revisionCount, 0);
    db.exec('DROP TRIGGER fail_busy_write');
    assert.equal((await client.commitWrite(prepared)).revision, 1);
    assert.equal((await client.history(prepared.id)).versions.length, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('blocked WAL checkpoints preserve live history and backups until readers release their snapshot', async (t) => {
  const app = await fixture(t);
  const { client } = await app.create();
  const first = await client.prepareWrite('notes/checkpoint.md', text('First version'), 0);
  await client.commitWrite(first);
  const reader = new DatabaseSync(app.dbPath, { readOnly: true });
  const checkpoint = new DatabaseSync(app.dbPath);
  const restoredDir = await mkdtemp(join(tmpdir(), 'jotdrop-checkpoint-restore-'));
  try {
    checkpoint.exec('PRAGMA busy_timeout=0');
    reader.exec('BEGIN');
    assert.equal(reader.prepare('SELECT MAX(revision) AS revision FROM revisions').get().revision, 1);
    await client.write('notes/checkpoint.md', text('Second version'), 1);
    await client.remove(first.id, 2);
    await client.restore(first.id, 1, 3);
    const blocked = checkpoint.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    assert.equal(blocked.busy, 1);
    assert.ok(blocked.log > blocked.checkpointed);
    assert.ok((await stat(`${app.dbPath}-wal`)).size > 32);
    assert.equal(reader.prepare('SELECT MAX(revision) AS revision FROM revisions').get().revision, 1);
    assert.equal((await client.read(first.id)).revision, 4);
    assert.equal((await client.read(first.id)).envelope, first.envelope);
    assert.equal((await client.history(first.id)).versions.length, 4);
    assert.equal((await client.listChanges()).changes.length, 4);
    await backupCloudDatabase(app.dbPath, join(restoredDir, 'cloud.db'));
    const restored = await createCloudServer({ freeDeviceLimit: 100, dataDir: restoredDir, enrollmentToken: randomToken() });
    try {
      const reopened = new CloudClient({ ...client.credentials, url: `http://127.0.0.1:${restored.port}` });
      assert.equal((await reopened.read(first.id)).revision, 4);
      assert.equal((await reopened.read(first.id, 3)).deleted, true);
      assert.equal((await reopened.listChanges()).changes.length, 4);
    } finally { await restored.close(); }
    reader.exec('ROLLBACK');
    assert.equal(checkpoint.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy, 0);
    assert.equal((await stat(`${app.dbPath}-wal`)).size, 0);
    assert.deepEqual(checkpoint.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(checkpoint.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { reader.close(); checkpoint.close(); await rm(restoredDir, { recursive: true, force: true }); }
  await app.close();
  const restarted = await createCloudServer({ freeDeviceLimit: 100, dataDir: app.dataDir, enrollmentToken: app.enrollmentToken });
  try {
    const reopened = new CloudClient({ ...client.credentials, url: `http://127.0.0.1:${restarted.port}` });
    assert.equal((await reopened.read(first.id)).revision, 4);
    assert.equal((await reopened.history(first.id)).versions.length, 4);
  } finally { await restarted.close(); }
});

test('restart retains committed WAL writes and discards a process-interrupted transaction before COMMIT', async (t) => {
  const app = await fixture(t);
  const { client } = await app.create();
  const first = await client.prepareWrite('notes/restart.md', text('First durable version'), 0);
  await client.commitWrite(first);
  const committed = await client.prepareWrite('notes/restart.md', text('Committed without checkpoint'), 1);
  const pending = await client.prepareWrite('notes/interrupted.md', text('x'.repeat(65536)), 0);
  await app.close();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    import { readFileSync, statSync, writeSync } from 'node:fs';
    import { createCloudServer } from './cloud/server.mjs';
    import { CloudClient } from './cloud/shared/client.mjs';
    const input = JSON.parse(readFileSync(0, 'utf8'));
    let connection;
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql) { connection = this; return prepare.call(this, sql); };
    const app = await createCloudServer({ freeDeviceLimit: 100, dataDir: input.dataDir, enrollmentToken: input.enrollmentToken });
    DatabaseSync.prototype.prepare = prepare;
    connection.exec('PRAGMA wal_autocheckpoint=0; PRAGMA cache_size=2');
    const client = new CloudClient({ ...input.credentials, url: 'http://127.0.0.1:' + app.port });
    assert.equal((await client.commitWrite(input.committed)).revision, 2);
    const committedWalBytes = statSync(app.dbPath + '-wal').size;
    const exec = connection.exec;
    connection.exec = function(sql) {
      if (sql === 'COMMIT') {
        assert.equal(this.isTransaction, true);
        assert.equal(this.prepare('SELECT COUNT(*) AS count FROM revisions').get().count, 3);
        writeSync(1, JSON.stringify({ transactionOpen: true, committedWalBytes, walBytes: statSync(app.dbPath + '-wal').size }));
        process.exit(0); // Test process only: intentionally skip COMMIT and graceful database close.
      }
      return exec.call(this, sql);
    };
    await client.commitWrite(input.pending);
    throw new Error('The test did not interrupt COMMIT');
  `], { cwd: new URL('..', import.meta.url), input: JSON.stringify({ dataDir: app.dataDir, enrollmentToken: app.enrollmentToken, credentials: client.credentials, committed, pending }), encoding: 'utf8', timeout: 10000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const evidence = JSON.parse(child.stdout);
  assert.equal(evidence.transactionOpen, true);
  assert.ok(evidence.committedWalBytes > 32);
  assert.ok(evidence.walBytes > evidence.committedWalBytes);
  const restarted = await createCloudServer({ freeDeviceLimit: 100, dataDir: app.dataDir, enrollmentToken: app.enrollmentToken });
  try {
    const reopened = new CloudClient({ ...client.credentials, url: `http://127.0.0.1:${restarted.port}` });
    assert.equal((await reopened.read(first.id)).envelope, committed.envelope);
    assert.equal((await reopened.read(first.id, 1)).envelope, first.envelope);
    await assert.rejects(reopened.read(pending.id), (error) => error.status === 404);
    assert.deepEqual((await reopened.status()).history, { revisionCount: 2, changeCount: 2, maxEntries: 100000 });
    assert.equal((await reopened.status()).usedBytes, Buffer.byteLength(first.envelope) + Buffer.byteLength(committed.envelope));
    await assert.rejects(reopened.commitWrite(committed), (error) => error.status === 409 && error.currentRevision === 2);
    assert.equal((await reopened.commitWrite(pending)).sequence, 3);
    assert.equal((await reopened.listChanges()).changes.length, 3);
    const db = new DatabaseSync(app.dbPath, { readOnly: true });
    try {
      for (const table of ['envelopes', 'revisions', 'changes']) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 3);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { db.close(); }
  } finally { await restarted.close(); }
});

test('encrypted files, authorization and history survive verified backup and server restart', async (t) => {
  const app = await fixture(t);
  const { client } = await app.create();
  const saved = await client.write('notes/persist.md', text('Restore me'), 0);
  const restoredDir = await mkdtemp(join(tmpdir(), 'jotdrop-restored-test-'));
  await backupCloudDatabase(app.dbPath, join(restoredDir, 'cloud.db'));
  await app.close();
  const restored = await createCloudServer({ freeDeviceLimit: 100, dataDir: restoredDir, enrollmentToken: randomToken() });
  t.after(async () => { await restored.close(); await rm(restoredDir, { recursive: true, force: true }); });
  const reopened = new CloudClient({ ...client.credentials, url: `http://127.0.0.1:${restored.port}` });
  assert.equal((await reopened.read(saved.id)).file.path, 'notes/persist.md');
  assert.equal((await reopened.history(saved.id)).versions.length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupCloudDatabase } from './backup.mjs';

test('online backup includes WAL transactions and restores into a new database without overwriting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jotdrop-backup-test-'));
  const source = join(directory, 'live.sqlite'), snapshot = join(directory, 'snapshot.sqlite'), restored = join(directory, 'restored.sqlite');
  const live = new DatabaseSync(source);
  try {
    live.exec('PRAGMA journal_mode=WAL; CREATE TABLE objects (revision INTEGER, ciphertext TEXT)');
    live.prepare('INSERT INTO objects VALUES (?, ?)').run(1, 'encrypted-version-one');
    await backupCloudDatabase(source, snapshot);
    live.prepare('INSERT INTO objects VALUES (?, ?)').run(2, 'encrypted-version-two');
    await backupCloudDatabase(snapshot, restored);
    const recovered = new DatabaseSync(restored, { readOnly: true });
    try { assert.deepEqual(recovered.prepare('SELECT * FROM objects').all().map((row) => ({ ...row })), [{ revision: 1, ciphertext: 'encrypted-version-one' }]); }
    finally { recovered.close(); }
    await assert.rejects(backupCloudDatabase(source, snapshot), /exist/i);
    await assert.rejects(backupCloudDatabase(source, source));
    const unchanged = new DatabaseSync(snapshot, { readOnly: true });
    try { assert.equal(unchanged.prepare('SELECT COUNT(*) AS count FROM objects').get().count, 1); }
    finally { unchanged.close(); }
  } finally { live.close(); await rm(directory, { recursive: true, force: true }); }
});

test('failed SQLite backup removes only its partial destination and leaves WAL data retryable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jotdrop-backup-failure-'));
  const source = join(directory, 'live.sqlite'), destination = join(directory, 'snapshot.sqlite');
  const live = new DatabaseSync(source);
  try {
    live.exec('PRAGMA journal_mode=WAL; CREATE TABLE objects (revision INTEGER, ciphertext TEXT)');
    live.prepare('INSERT INTO objects VALUES (?, ?)').run(1, 'synthetic-encrypted-history');
    const before = live.prepare('SELECT * FROM objects').all();
    for (const errcode of [13, 778]) {
      const failure = Object.assign(new Error('Synthetic backup storage failure'), { code: 'ERR_SQLITE_ERROR', errcode });
      const prepare = DatabaseSync.prototype.prepare;
      const inject = t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
        const statement = prepare.call(this, sql);
        if (sql === 'VACUUM INTO ?') t.mock.method(statement, 'run', (path) => {
          const partial = new DatabaseSync(path);
          try { partial.exec('CREATE TABLE incomplete (value TEXT)'); } finally { partial.close(); }
          throw failure;
        });
        return statement;
      });
      try {
        await assert.rejects(backupCloudDatabase(source, destination), (error) => error === failure);
        await assert.rejects(stat(destination), (error) => error.code === 'ENOENT');
        assert.deepEqual(live.prepare('SELECT * FROM objects').all(), before);
        assert.equal(live.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      } finally { inject.mock.restore(); }
    }
    await backupCloudDatabase(source, destination);
    const recovered = new DatabaseSync(destination, { readOnly: true });
    try { assert.deepEqual(recovered.prepare('SELECT * FROM objects').all(), before); }
    finally { recovered.close(); }
  } finally { live.close(); await rm(directory, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { clipMarkdown, createClipperCloud } from '../chrome-extension/cloud.mjs';
import { createCloudServer } from './server.mjs';
import { CloudClient } from './shared/client.mjs';
import { randomToken, sealLocal } from './shared/crypto.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

test('cloud clipper creates portable Markdown and escapes metadata and links', () => {
  const markdown = clipMarkdown({ url: 'https://example.com/a(b)', title: 'A [test]\nnew line', selection: 'one\ntwo', tags: ['work', 'bad: "value"', '#links'], color: 'not-a-color', pinned: true });
  assert.ok(markdown.startsWith('---\ntags: ["work","links"]\npinned: true\ncolor: default\n---\n'));
  assert.match(markdown, /# A \[test\] new line/);
  assert.ok(markdown.includes('> one\n> two'));
  assert.ok(markdown.includes('[A \\[test\\] new line](<https://example.com/a%28b%29>)'));
  assert.throws(() => clipMarkdown({ url: 'javascript:alert(1)' }));
});

test('clipper reconciles an error after COMMIT across server restart and preserves genuinely conflicting drafts', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-clipper-commit-'));
  const enrollmentToken = randomToken();
  let connection;
  const prepare = DatabaseSync.prototype.prepare;
  const capture = t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) { connection = this; return prepare.call(this, sql); });
  const app = await createCloudServer({ dataDir, enrollmentToken, maxHistoryEntries: 3 });
  capture.mock.restore();
  let restarted;
  t.after(async () => { await app.close(); await restarted?.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { client } = await CloudClient.create({ url: `http://127.0.0.1:${app.port}`, enrollmentToken, deviceName: 'Test clipper' });
  const password = 'clipper commit test passphrase';
  const data = { cloudConnection: await sealLocal(client.credentials, password) };
  const storage = { async get(keys) { return keys === null ? { ...data } : Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]])); }, async set(value) { Object.assign(data, value); }, async remove(key) { delete data[key]; } };
  let loseNetworkResponse = false;
  const clipper = createClipperCloud(storage, async (url, options) => {
    const response = await fetch(url, options);
    if (options.method === 'PUT' && loseNetworkResponse) {
      loseNetworkResponse = false;
      assert.equal(response.status, 201);
      await response.text();
      throw new TypeError('Synthetic lost network response');
    }
    return response;
  });
  let failAcknowledgment = true;
  const exec = connection.exec;
  const inject = t.mock.method(connection, 'exec', function (sql) {
    const result = exec.call(this, sql);
    if (sql === 'COMMIT' && failAcknowledgment) {
      failAcknowledgment = false;
      assert.equal(this.isTransaction, false);
      throw Object.assign(new Error('Synthetic private post-commit failure'), { code: 'ERR_SQLITE_ERROR', errcode: 778 });
    }
    return result;
  });
  const payload = { url: 'https://example.com', title: 'Synthetic private clip', selection: 'Secret synthetic selection', tags: [], pinned: false };
  const captureId = crypto.randomUUID();
  await assert.rejects(clipper.save(payload, password, captureId), (error) => error.status === 500 && error.message === 'Internal server error');
  const draftKey = Object.keys(data).find((key) => key.startsWith('cloudDraft:'));
  assert.ok(draftKey);
  assert.ok(!JSON.stringify(data).includes(payload.selection));
  assert.equal((await client.read(data[draftKey].id)).envelope, data[draftKey].envelope);
  inject.mock.restore();
  await app.close();
  restarted = await createCloudServer({ dataDir, enrollmentToken, maxHistoryEntries: 3, port: app.port });
  await clipper.save(payload, password, captureId);
  assert.equal(Object.keys(data).filter((key) => key.startsWith('cloudDraft:')).length, 0);
  assert.equal((await client.listChanges()).changes.length, 1);
  assert.deepEqual((await client.status()).history, { revisionCount: 1, changeCount: 1, maxEntries: 3 });
  loseNetworkResponse = true;
  const conflictId = crypto.randomUUID();
  await assert.rejects(clipper.save(payload, password, conflictId), /lost network/);
  const conflictKey = Object.keys(data).find((key) => key.startsWith('cloudDraft:'));
  const pending = data[conflictKey];
  await client.write(`notes/Inbox/${conflictId}.md`, new TextEncoder().encode('Different cloud version'), 1);
  const before = JSON.stringify(data);
  await assert.rejects(clipper.save(payload, password, conflictId), /different cloud version/i);
  assert.equal(JSON.stringify(data), before);
  assert.equal(data[conflictKey].envelope, pending.envelope);
  assert.ok(!before.includes(payload.selection));
  assert.equal((await client.history(pending.id)).versions.length, 2);
  assert.equal((await client.listChanges()).changes.length, 3);
});

test('clipper preserves encrypted drafts at the history limit and reconciles lost successful uploads', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-clipper-test-'));
  const enrollmentToken = randomToken();
  const app = await createCloudServer({ dataDir, enrollmentToken, maxHistoryEntries: 1 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { client } = await CloudClient.create({ url: `http://127.0.0.1:${app.port}`, enrollmentToken, deviceName: 'Test clipper' });
  const password = 'clipper test unlock passphrase';
  const data = { cloudConnection: await sealLocal(client.credentials, password) };
  const storage = { async get(keys) { return keys === null ? { ...data } : Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]])); }, async set(value) { Object.assign(data, value); }, async remove(key) { delete data[key]; } };
  let loseResponse = true;
  const clipper = createClipperCloud(storage, async (url, options) => {
    const response = await fetch(url, options);
    if (options.method === 'PUT' && loseResponse) { loseResponse = false; await response.text(); throw new TypeError('Synthetic lost network response'); }
    return response;
  });
  const captureId = crypto.randomUUID();
  const payload = { url: 'https://example.com', title: 'Synthetic private clip', selection: 'Private selected text', tags: [], pinned: false };
  await assert.rejects(clipper.save(payload, password, captureId), /lost network/);
  assert.equal(Object.keys(data).filter((key) => key.startsWith('cloudDraft:')).length, 1);
  assert.ok(!JSON.stringify(data).includes('Private selected text'));
  await clipper.save(payload, password, captureId);
  assert.equal(Object.keys(data).filter((key) => key.startsWith('cloudDraft:')).length, 0);
  assert.equal((await client.listChanges()).changes.length, 1);
  const blockedCapture = crypto.randomUUID();
  await assert.rejects(clipper.save(payload, password, blockedCapture), (error) => error.status === 507);
  const blockedDraft = JSON.stringify(data);
  assert.equal(Object.keys(data).filter((key) => key.startsWith('cloudDraft:')).length, 1);
  assert.ok(!blockedDraft.includes('Private selected text'));
  await assert.rejects(clipper.save(payload, password, blockedCapture), (error) => error.status === 507);
  assert.equal(JSON.stringify(data), blockedDraft);
  assert.deepEqual((await client.status()).history, { revisionCount: 1, changeCount: 1, maxEntries: 1 });
});

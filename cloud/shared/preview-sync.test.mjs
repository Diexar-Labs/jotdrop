import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudServer } from '../server.mjs';
import { CloudClient } from './client.mjs';
import { randomToken } from './crypto.mjs';
import { syncPreview } from './preview-sync.mjs';

test('isolated sync uploads/pulls, preserves simultaneous edits and never resurrects deleted notes', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-preview-sync-'));
  const enrollmentToken = randomToken(), server = await createCloudServer({ dataDir, enrollmentToken });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { client } = await CloudClient.create({ url: `http://127.0.0.1:${server.port}`, enrollmentToken, deviceName: 'Test plugin' });
  const text = (value) => new TextEncoder().encode(value), decode = (value) => new TextDecoder().decode(value);
  const files = new Map([['notes/a.md', text('initial')]]), conflicts = new Map(), tracked = {};
  const adapter = {
    async list() { return [...files].map(([path, bytes]) => ({ path, bytes })); },
    async writeNew(path, bytes) { if (files.has(path)) return false; files.set(path, bytes); return true; },
    async replaceText(path, expected, bytes) { if (!path.endsWith('.md') || decode(files.get(path)) !== decode(expected)) return false; files.set(path, bytes); return true; },
    async writeConflict(path, bytes) { if (!conflicts.has(path)) conflicts.set(path, bytes); },
  };
  const persist = async () => {};
  assert.equal((await syncPreview(client, adapter, tracked, persist)).uploaded, 1);
  const remoteId = (await client.listChanges()).changes[0].id;
  await client.write('notes/a.md', text('remote change'), 1);
  assert.equal((await syncPreview(client, adapter, tracked, persist)).downloaded, 1);
  assert.equal(decode(files.get('notes/a.md')), 'remote change');
  files.set('notes/a.md', text('local edit'));
  await client.write('notes/a.md', text('concurrent cloud edit'), 2);
  assert.equal((await syncPreview(client, adapter, tracked, persist)).conflicts, 1);
  assert.equal(decode(files.get('notes/a.md')), 'local edit');
  assert.equal(decode([...conflicts.values()][0]), 'concurrent cloud edit');
  await client.remove(remoteId, 3);
  assert.equal((await syncPreview(client, adapter, tracked, persist)).remoteDeletions, 1);
  assert.equal(decode(files.get('notes/a.md')), 'local edit');
  assert.equal((await client.read(remoteId)).deleted, true);
});

test('isolated sync reconciles uncertain create and update acknowledgments without duplicate revisions or local writes', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-sync-acknowledgment-'));
  const enrollmentToken = randomToken(), server = await createCloudServer({ dataDir, enrollmentToken });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { client } = await CloudClient.create({ url: `http://127.0.0.1:${server.port}`, enrollmentToken, deviceName: 'Test plugin' });
  let loseAcknowledgment = true;
  const uncertain = new CloudClient({ ...client.credentials, fetcher: async (url, options) => {
    const response = await fetch(url, options);
    if (options.method === 'PUT' && loseAcknowledgment) {
      loseAcknowledgment = false;
      assert.equal(response.status, 201);
      await response.text();
      return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 });
    }
    return response;
  } });
  let bytes = new TextEncoder().encode('Synthetic local draft');
  const tracked = {};
  let persisted;
  const adapter = {
    async list() { return [{ path: 'notes/draft.md', bytes }]; },
    async writeNew() { assert.fail('Retry must not rewrite local files'); },
    async replaceText() { assert.fail('Retry must not rewrite local files'); },
    async writeConflict() { assert.fail('An already saved draft is not a conflict'); },
  };
  const persist = async () => { persisted = structuredClone(tracked); };
  await assert.rejects(syncPreview(uncertain, adapter, tracked, persist), (error) => error.status === 500);
  assert.deepEqual(tracked, {});
  assert.equal(persisted, undefined);
  const id = (await client.listChanges()).changes[0].id;
  assert.deepEqual(await syncPreview(uncertain, adapter, tracked, persist), { uploaded: 0, downloaded: 0, conflicts: 0, remoteDeletions: 0 });
  assert.equal(persisted[id].revision, 1);
  assert.equal((await client.history(id)).versions.length, 1);
  bytes = new TextEncoder().encode('Synthetic updated draft');
  loseAcknowledgment = true;
  const before = structuredClone(tracked);
  await assert.rejects(syncPreview(uncertain, adapter, tracked, persist), (error) => error.status === 500);
  assert.deepEqual(tracked, before);
  assert.deepEqual(persisted, before);
  assert.equal(new TextDecoder().decode(bytes), 'Synthetic updated draft');
  assert.deepEqual(await syncPreview(uncertain, adapter, tracked, persist), { uploaded: 0, downloaded: 0, conflicts: 0, remoteDeletions: 0 });
  assert.equal(persisted[id].revision, 2);
  assert.equal((await client.history(id)).versions.length, 2);
  assert.equal((await client.listChanges()).changes.length, 2);
});

test('isolated sync forgets a deleted note that a full free cloud cleared, so its name can be used again', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-sync-cleared-'));
  let now = Date.parse('2026-10-23T08:00:00Z');
  const enrollmentToken = randomToken(), server = await createCloudServer({ dataDir, enrollmentToken, quotaBytes: 4000, clock: () => now });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { client } = await CloudClient.create({ url: `http://127.0.0.1:${server.port}`, enrollmentToken, deviceName: 'Test plugin' });
  const text = (value) => new TextEncoder().encode(value);
  const files = new Map(), tracked = {};
  const adapter = {
    async list() { return [...files].map(([path, bytes]) => ({ path, bytes })); },
    async writeNew(path, bytes) { if (files.has(path)) return false; files.set(path, bytes); return true; },
    async replaceText() { return false; },
    async writeConflict() {},
  };
  let persisted;
  const persist = async (value) => { persisted = structuredClone(value); };
  const saved = await client.write('notes/old.md', text('o'.repeat(1000)), 0);
  await client.remove(saved.id, 1);
  await syncPreview(client, adapter, tracked, persist);
  assert.equal(tracked[saved.id].deleted, true);
  now += 31 * 24 * 60 * 60 * 1000;
  await client.write('notes/big.md', text('b'.repeat(1800)), 0);
  await assert.rejects(client.read(saved.id), (error) => error.status === 404);
  files.set('notes/old.md', text('same name, new note'));
  const result = await syncPreview(client, adapter, tracked, persist);
  assert.equal(result.uploaded, 1);
  assert.equal(result.conflicts, 0);
  assert.deepEqual(persisted[saved.id], { revision: 1, hash: tracked[saved.id].hash, deleted: false });
});

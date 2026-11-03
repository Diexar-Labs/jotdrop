import assert from 'node:assert/strict';
import test from 'node:test';
import { CLOUD_ORIGIN, clipMarkdown, clipPath, cloudOrigin, createClipperCloud, readPairingCode } from '../chrome-extension/cloud.mjs';
import { createCloudServer } from './server.mjs';
import { CloudClient } from './shared/client.mjs';
import { base64ToBytes, bytesToBase64, randomToken, sealLocal } from './shared/crypto.mjs';
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

test('clipped text keeps its #words as text, like the plugin; only chosen tags are tags', () => {
  const markdown = clipMarkdown({ url: 'https://example.com/#anchor', title: '#1 tips for #obsidian', selection: 'Try #keep and `#code` at https://x.test/#y', tags: ['chosen'] });
  assert.ok(markdown.startsWith('---\ntags: ["chosen"]\n'));
  assert.ok(markdown.includes('# #1 tips for \\#obsidian\n'), markdown);
  assert.ok(markdown.includes('> Try \\#keep and `#code` at https://x.test/#y'), markdown);
  assert.ok(markdown.includes('(<https://example.com/#anchor>)'), markdown);
});

test('a clip is named like an Obsidian clip, at the top of notes/, and stays unique per capture', () => {
  const now = new Date(2026, 10, 3, 14, 5, 2);
  const id = '3f9a0c1e-0000-4000-8000-000000000000';
  assert.equal(clipPath({ url: 'https://example.com', title: 'A: "quoted" [page] / with *marks*?' }, id, now), 'notes/2026-11-03 140502 A quoted page  with marks 3f9a.md');
  assert.equal(clipPath({ url: 'https://example.com', title: '...' }, id, now), 'notes/2026-11-03 140502 3f9a.md');
  assert.equal(clipPath({ url: 'https://example.com', title: 'x'.repeat(80) }, id, now), `notes/2026-11-03 140502 ${'x'.repeat(40)} 3f9a.md`);
  assert.notEqual(clipPath({ url: 'https://example.com', title: 'Same' }, id, now), clipPath({ url: 'https://example.com', title: 'Same' }, `aaaa${id.slice(4)}`, now));
});

test('the store clipper pairs only with app.jotdrop.net (api is the same server) or a cloud on this computer', () => {
  assert.equal(cloudOrigin('https://app.jotdrop.net'), CLOUD_ORIGIN);
  assert.equal(cloudOrigin('https://api.jotdrop.net/'), CLOUD_ORIGIN);
  assert.equal(cloudOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(cloudOrigin('http://localhost:9000'), 'http://localhost:9000');
  assert.throws(() => cloudOrigin('https://cloud.example.com'), /app\.jotdrop\.net/);
  assert.throws(() => cloudOrigin('http://192.168.1.2:8787'), /HTTPS/);
  const code = (url) => bytesToBase64(new TextEncoder().encode(JSON.stringify({ v: 1, url, pairingId: crypto.randomUUID(), claimToken: randomToken(), wrappingKey: randomToken() })));
  const plain = code('https://app.jotdrop.net');
  assert.deepEqual(readPairingCode(` ${plain.slice(0, 20)}\n${plain.slice(20)} `), { code: plain, origin: CLOUD_ORIGIN });
  const alias = readPairingCode(code('https://api.jotdrop.net'));
  assert.equal(alias.origin, CLOUD_ORIGIN);
  assert.equal(JSON.parse(new TextDecoder().decode(base64ToBytes(alias.code))).url, CLOUD_ORIGIN);
  assert.throws(() => readPairingCode(code('https://evil.example')), /another server/);
  assert.throws(() => readPairingCode('not a code'), /not a JotDrop pairing code/);
});

test('pairing takes a device place, stays unlocked only in session memory, and disconnecting frees the place', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-clipper-pair-'));
  const enrollmentToken = randomToken(), app = await createCloudServer({ dataDir, enrollmentToken });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { client: owner } = await CloudClient.create({ url: `http://127.0.0.1:${app.port}`, enrollmentToken, deviceName: 'Synthetic web app' });
  const area = () => { const data = {}; return { data, async get(keys) { return structuredClone(keys === null ? data : Object.fromEntries([keys].flat().filter((key) => key in data).map((key) => [key, data[key]]))); }, async set(value) { Object.assign(data, structuredClone(value)); }, async remove(keys) { for (const key of [keys].flat()) delete data[key]; } }; };
  const local = area(), session = area();
  local.data.destination = 'obsidian';
  local.data.cloudEnabled = true;
  const clipper = createClipperCloud(local, fetch, session);
  const password = 'synthetic pairing passphrase';
  await assert.rejects(clipper.connect((await owner.makePairing('Web clipper')).pairingCode, 'too short'), /at least 12/);
  assert.equal(await clipper.connect((await owner.makePairing('Web clipper')).pairingCode, password, { keepUnlocked: true }), `http://127.0.0.1:${app.port}`);
  assert.deepEqual(Object.keys(local.data).sort(), ['cloudConnection', 'cloudServer', 'destination']);
  assert.equal(local.data.destination, 'cloud');
  const { credentials } = session.data.cloudSession;
  for (const secret of [credentials.token, credentials.vaultKey]) assert.ok(!JSON.stringify(local.data).includes(secret), 'Only sealed keys are stored');
  assert.deepEqual(await clipper.status(), { connected: true, server: `http://127.0.0.1:${app.port}`, unlocked: true, canStayUnlocked: true, drafts: 0 });
  // The clipper is a device like any other: on the free plan (2 devices) the cloud is now full.
  const devices = (await owner.devices()).devices;
  assert.deepEqual(devices.map((device) => [device.name, device.revoked]), [['Synthetic web app', false], ['Web clipper', false]]);
  await assert.rejects(owner.makePairing('Third device'), (error) => error.status === 403 && error.code === 'device-limit');
  // Unlocked: saves need no passphrase.
  await clipper.save({ url: 'https://example.com', title: 'Unlocked clip', tags: ['a'] }, undefined, crypto.randomUUID());
  const [change] = (await owner.listChanges()).changes;
  const { file } = await owner.read(change.id);
  assert.match(file.path, /^notes\/\d{4}-\d\d-\d\d \d{6} Unlocked clip [0-9a-f]{4}\.md$/);
  assert.ok(new TextDecoder().decode(file.bytes).includes('# Unlocked clip'));
  // Locked: the passphrase is needed again, and a wrong one says so.
  await clipper.lock();
  assert.equal((await clipper.status()).unlocked, false);
  await assert.rejects(clipper.save({ url: 'https://example.com' }, undefined, crypto.randomUUID()), (error) => error.code === 'locked');
  await assert.rejects(clipper.save({ url: 'https://example.com' }, 'wrong passphrase!!', crypto.randomUUID()), /Wrong unlock passphrase/);
  assert.equal((await clipper.status()).drafts, 0, 'Nothing is queued while locked');
  // A queued draft goes with the keys on disconnect; with the passphrase the clipper also signs itself out.
  local.data[`cloudDraft:${credentials.vaultId}:${crypto.randomUUID()}`] = await owner.prepareWrite('notes/Queued.md', new TextEncoder().encode('queued'), 0);
  await assert.rejects(clipper.disconnect('wrong passphrase!!'), /Wrong unlock passphrase/);
  assert.deepEqual(await clipper.disconnect(password), { signedOut: true, signOutError: null, droppedDrafts: 1 });
  assert.deepEqual(local.data, { destination: 'obsidian' });
  assert.deepEqual(session.data, {});
  assert.deepEqual((await owner.devices()).devices.map((device) => device.revoked), [false, true]);
  await assert.rejects(new CloudClient(credentials).status(), (error) => error.status === 401);
  // The freed place can be used again.
  assert.ok((await owner.makePairing('Web clipper')).pairingCode);
  assert.deepEqual(await clipper.status(), { connected: false, server: null, unlocked: false, canStayUnlocked: true, drafts: 0 });
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
    if ((options.method === 'POST' && url.endsWith('/commit') || options.method === 'PUT' && /\/objects\/[0-9a-f]{64}$/.test(url)) && loseNetworkResponse) {
      assert.ok(response.ok);
      await response.text();
      throw new TypeError('Synthetic lost network response');
    }
    return response;
  });
  let failAcknowledgment = true;
  const exec = connection.exec;
  const inject = t.mock.method(connection, 'exec', function (sql) {
    const result = exec.call(this, sql);
    if (sql === 'COMMIT' && failAcknowledgment && connection.prepare('SELECT COUNT(*) AS count FROM revisions').get().count > 0) {
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
  loseNetworkResponse = false;
  const conflictKey = Object.keys(data).find((key) => key.startsWith('cloudDraft:'));
  const pending = data[conflictKey];
  // The lost answer hid a save that did happen: the next version goes on top of it.
  await client.write((await client.read(pending.id)).file.path, new TextEncoder().encode('Different cloud version'), 1);
  // The immutable receipt acknowledges our old write without overwriting the newer version.
  assert.equal(await clipper.resume(password), 1);
  assert.equal(data[conflictKey], undefined);
  data[conflictKey] = await client.prepareWrite((await client.read(pending.id)).file.path, new TextEncoder().encode('A genuinely stale draft'), 0);
  const before = JSON.stringify(data);
  await assert.rejects(clipper.resume(password), /different cloud version/i);
  assert.equal(JSON.stringify(data), before);
  assert.notEqual(data[conflictKey].envelope, pending.envelope);
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
    if ((options.method === 'POST' && url.endsWith('/commit') || options.method === 'PUT' && /\/objects\/[0-9a-f]{64}$/.test(url)) && loseResponse) { await response.text(); throw new TypeError('Synthetic lost network response'); }
    return response;
  });
  const captureId = crypto.randomUUID();
  const payload = { url: 'https://example.com', title: 'Synthetic private clip', selection: 'Private selected text', tags: [], pinned: false };
  await assert.rejects(clipper.save(payload, password, captureId), /lost network/);
  assert.equal(Object.keys(data).filter((key) => key.startsWith('cloudDraft:')).length, 1);
  assert.ok(!JSON.stringify(data).includes('Private selected text'));
  loseResponse = false;
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

test('reopened clipper resumes the same cancelled encrypted draft without capturing the current page', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-clipper-resume-'));
  const enrollmentToken = randomToken(), app = await createCloudServer({ dataDir, enrollmentToken });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { client } = await CloudClient.create({ url: `http://127.0.0.1:${app.port}`, enrollmentToken, deviceName: 'Synthetic clipper' });
  const password = 'synthetic resumable clipper passphrase';
  const data = { cloudConnection: await sealLocal(client.credentials, password) };
  const storage = { async get(keys) { return structuredClone(keys === null ? data : Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]]))); }, async set(value) { Object.assign(data, value); }, async remove(key) { delete data[key]; } };
  const controller = new AbortController(), captureId = crypto.randomUUID();
  const payload = { url: 'https://example.com', title: 'Synthetic resume', selection: 'Kept privately' };
  const progress = [], confirmed = [];
  const clipper = createClipperCloud(storage);
  await assert.rejects(clipper.save(payload, password, captureId, { signal: controller.signal, onCaptureCommitted: (id) => confirmed.push(id), onProgress(event) { progress.push(event); if (event.transferredBytes || event.phase === 'committing') controller.abort(); } }), (error) => error.name === 'AbortError');
  assert.deepEqual(confirmed, [], 'An uncertain upload must retain its capture identity');
  const key = Object.keys(data).find((key) => key.startsWith('cloudDraft:'));
  const prepared = structuredClone(data[key]);
  assert.ok(prepared && !JSON.stringify(data).includes(payload.selection));
  // A small clip is one encrypted manifest: cancelled just before it was sent.
  assert.equal(progress.at(-1).phase, 'committing');
  assert.equal((await client.listChanges()).changes.length, 0);
  const retry = [];
  let saves = 0;
  const reopened = createClipperCloud(storage, async (url, options) => {
    if (options.method === 'PUT') assert.equal(++saves, 1, 'The resumed draft is saved exactly once');
    return fetch(url, options);
  });
  assert.equal(await reopened.resume(password, { onCaptureCommitted: (id) => confirmed.push(id), onProgress: (event) => retry.push(event) }), 1);
  assert.deepEqual(confirmed, [captureId], 'Only a confirmed, durably removed draft retires its own capture identity');
  assert.equal(data[key], undefined);
  assert.equal(retry.at(-1).phase, 'committed');
  assert.equal((await client.read(prepared.id)).envelope, prepared.envelope);
  assert.equal((await client.listChanges()).changes.length, 1);
  assert.equal(await reopened.resume(password), 0);
});

test('a partially successful resume confirms only the captures removed before a later failure', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-clipper-partial-resume-'));
  const enrollmentToken = randomToken(), app = await createCloudServer({ dataDir, enrollmentToken, maxHistoryEntries: 1 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { client } = await CloudClient.create({ url: `http://127.0.0.1:${app.port}`, enrollmentToken, deviceName: 'Synthetic clipper' });
  const password = 'synthetic partial resume passphrase';
  const data = { cloudConnection: await sealLocal(client.credentials, password) };
  const ids = [crypto.randomUUID(), crypto.randomUUID()], confirmed = [];
  for (const id of ids) data[`cloudDraft:${client.credentials.vaultId}:${id}`] = await client.prepareWrite(`notes/Inbox/${id}.md`, new TextEncoder().encode('Synthetic draft'), 0);
  const before = structuredClone(data);
  const storage = { async get() { return structuredClone(data); }, async remove(key) { delete data[key]; } };
  const clipper = createClipperCloud(storage);
  await assert.rejects(clipper.resume(password, { onCaptureCommitted: (id) => confirmed.push(id) }), (error) => error.status === 507);
  assert.deepEqual(confirmed, [ids[0]]);
  assert.equal(data[`cloudDraft:${client.credentials.vaultId}:${ids[0]}`], undefined);
  const retained = `cloudDraft:${client.credentials.vaultId}:${ids[1]}`;
  assert.deepEqual(data[retained], before[retained], 'A later failure cannot retire another capture identity');
});

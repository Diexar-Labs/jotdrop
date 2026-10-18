import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createCloudServer } from './server.mjs';
import { CloudClient } from './shared/client.mjs';
import { randomToken, unsealLocal } from './shared/crypto.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = await build({ entryPoints: [join(root, 'src/cloud.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [{ name: 'mock-obsidian', setup(builder) {
  builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test' }));
  builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `export class Modal {}; export class Notice {}; export class Setting {}; export class TFile { static [Symbol.hasInstance](value) { return value?.isTestFile === true; } }; export const normalizePath = p => p.replace(/\\\\/g, '/'); export const getLanguage = () => 'en';` }));
} }] });
const loaded = new Module(join(root, 'cloud/plugin-test-bundle.cjs'));
loaded.filename = join(root, 'cloud/plugin-test-bundle.cjs');
loaded._compile(bundle.outputFiles[0].text, loaded.filename);
const { CloudController } = loaded.exports;

test('plugin is locked by default, saves only wrapped credentials, syncs isolated files and rejects Syncthing/overlap', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jotdrop-plugin-test-'));
  const enrollmentToken = randomToken(), app = await createCloudServer({ dataDir: directory, enrollmentToken });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const files = new Map(), folders = new Set(), commands = [];
  const text = (value) => new TextEncoder().encode(value);
  const decode = (value) => new TextDecoder().decode(value);
  const protectedNote = 'Mini Notes/do-not-touch.md';
  files.set(protectedNote, text('User-owned note, unchanged'));
  const plugin = {
    settings: { notesFolder: 'Mini Notes', archiveFolder: 'Mini Notes/Archive', cloudConnection: '' },
    resolveAssetsFolder: () => 'Mini Notes/.attachments',
    addCommand: (command) => commands.push(command),
    async saveSettings() {},
    app: { vault: {
      adapter: {
        async exists(path) { return files.has(path) || folders.has(path); },
        async list(path) { return { files: [...files.keys()].filter((file) => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes('/')), folders: [...folders].filter((folder) => folder.startsWith(`${path}/`) && !folder.slice(path.length + 1).includes('/')) }; },
        async stat(path) { return files.has(path) ? { size: files.get(path).length } : null; },
        async readBinary(path) { return files.get(path).slice().buffer; },
      },
      async createFolder(path) { folders.add(path); },
      async createBinary(path, data) { if (files.has(path)) throw new Error('Already exists'); files.set(path, new Uint8Array(data)); },
      getAbstractFileByPath(path) { return files.has(path) ? { path, isTestFile: true } : null; },
      async process(file, callback) { files.set(file.path, text(callback(decode(files.get(file.path))))); },
    } },
  };
  const controller = new CloudController(plugin);
  controller.register();
  assert.equal(commands.length, 5);
  await assert.rejects(controller.sync(), /Unlock/);
  await assert.rejects(controller.recoverQueuedUpload(), /Unlock/);
  assert.equal(files.size, 1);
  const owner = (await CloudClient.create({ url: `http://127.0.0.1:${app.port}`, enrollmentToken, deviceName: 'Browser' })).client;
  const pairing = await owner.makePairing('Plugin test');
  await controller.connect(pairing.pairingCode, 'plugin test passphrase');
  assert.ok(!plugin.settings.cloudConnection.includes(owner.credentials.vaultKey));
  await owner.write('notes/cloud.md', text('Initial cloud note'), 0);
  await controller.sync();
  assert.equal(decode(files.get('JotDrop Cloud Test/notes/cloud.md')), 'Initial cloud note');
  assert.equal(decode(files.get(protectedNote)), 'User-owned note, unchanged');
  await owner.write('notes/cloud.md', text('Updated cloud note'), 1);
  await controller.sync();
  assert.equal(decode(files.get('JotDrop Cloud Test/notes/cloud.md')), 'Updated cloud note');
  const attachment = 'JotDrop Cloud Test/attachments/resume.bin';
  folders.add('JotDrop Cloud Test/attachments');
  files.set(attachment, new Uint8Array(128 * 1024).fill(13));
  await assert.rejects(controller.sync((event) => { if (event.transferredBytes > 0) controller.cancel(); }), (error) => error.name === 'AbortError');
  const queued = await unsealLocal(JSON.parse(plugin.settings.cloudConnection), 'plugin test passphrase');
  assert.ok(queued.pending?.prepared.envelope);
  assert.equal((await owner.listChanges()).changes.length, 2, 'A partial upload must not publish');
  controller.lock();
  // Recreate the controller, change the local file, and preserve the queued snapshot first.
  files.set(attachment, new Uint8Array(128 * 1024).fill(14));
  const reopened = new CloudController(plugin);
  await reopened.unlock('plugin test passphrase');
  const offsets = [];
  const fetcher = globalThis.fetch;
  const intercept = t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.method === 'PUT' && url.includes('/uploads/')) offsets.push(Number(new URL(url).searchParams.get('offset')));
    return fetcher(url, options);
  });
  // The existing unlocked client captures fetch; unlock again to instrument the real transport.
  await reopened.unlock('plugin test passphrase');
  await reopened.sync();
  intercept.mock.restore();
  assert.equal(offsets[0], 65536);
  assert.equal((await owner.read(queued.pending.prepared.id, 1)).envelope, queued.pending.prepared.envelope);
  assert.deepEqual((await owner.read(queued.pending.prepared.id)).file.content, Buffer.alloc(128 * 1024, 14).toString('base64url'));
  assert.equal((await owner.history(queued.pending.prepared.id)).versions.length, 2);
  assert.equal((await unsealLocal(JSON.parse(plugin.settings.cloudConnection), 'plugin test passphrase')).pending, undefined);
  files.delete(attachment);
  await controller.unlock('plugin test passphrase');
  const nested = 'JotDrop Cloud Test/notes/nested';
  folders.add(nested);
  files.set(`${nested}/local.md`, text('Never upload from another sync workspace'));
  for (const marker of ['.stfolder', '.stignore', '.stversions']) {
    const path = `${nested}/${marker}`;
    const entries = marker === '.stignore' ? files : folders;
    if (entries === files) entries.set(path, new Uint8Array());
    else entries.add(path);
    const before = (await owner.listChanges()).changes.length;
    await assert.rejects(controller.sync(), /Syncthing/);
    assert.equal((await owner.listChanges()).changes.length, before);
    entries.delete(path);
  }
  files.delete(`${nested}/local.md`);
  folders.delete(nested);
  files.set('.stfolder', new Uint8Array());
  await assert.rejects(controller.sync(), /Syncthing/);
  files.delete('.stfolder');
  plugin.settings.notesFolder = 'JotDrop Cloud Test/notes';
  await assert.rejects(controller.sync(), /overlaps/);
  controller.lock();
  await assert.rejects(controller.sync(), /Unlock/);
  await controller.unlock('plugin test passphrase');
  assert.match(controller.status, /Unlocked/);
  plugin.settings.notesFolder = 'Mini Notes';
  files.set('JotDrop Cloud Test/notes/persist-before-upload.md', text('Synthetic write-ahead check'));
  const saveSettings = plugin.saveSettings;
  plugin.saveSettings = async () => { throw new Error('Synthetic settings write failure'); };
  const changesBefore = (await owner.listChanges()).changes.length;
  await assert.rejects(controller.sync(), /settings write failure/);
  assert.equal((await owner.listChanges()).changes.length, changesBefore);
  assert.equal((await owner.status()).transport.reservedBytes, 0, 'No upload can start before durable settings');
  plugin.saveSettings = saveSettings;
  await controller.sync();
  files.set('JotDrop Cloud Test/notes/cloud.md', text('Local simultaneous edit kept'));
  files.set('JotDrop Cloud Test/notes/z-must-wait.md', text('Another local draft kept'));
  const cloudId = (await owner.prepareWrite('notes/cloud.md', text('Only an ID lookup'), 2)).id;
  let race = true;
  const stale = t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (race && options.method === 'POST' && url.includes(`/objects/${cloudId}/uploads/`)) {
      race = false;
      await owner.write('notes/cloud.md', text('Simultaneous remote edit'), 2);
    }
    return fetcher(url, options);
  });
  await controller.unlock('plugin test passphrase');
  await assert.rejects(controller.sync(), /queued upload needs review/);
  stale.mock.restore();
  const blocked = await unsealLocal(JSON.parse(plugin.settings.cloudConnection), 'plugin test passphrase');
  assert.equal(blocked.pending.prepared.id, cloudId, 'A conflict cannot overwrite the durable upload with the next file');
  assert.equal(decode(files.get('JotDrop Cloud Test/notes/cloud.md')), 'Local simultaneous edit kept');
  assert.equal(decode(files.get('JotDrop Cloud Test/notes/z-must-wait.md')), 'Another local draft kept');
  const recoverer = new CloudController(plugin);
  await recoverer.unlock('plugin test passphrase');
  await assert.rejects(recoverer.sync(), (error) => error.status === 409);
  assert.equal((await unsealLocal(JSON.parse(plugin.settings.cloudConnection), 'plugin test passphrase')).pending.prepared.envelope, blocked.pending.prepared.envelope);
  files.set('JotDrop Cloud Test/notes/cloud.md', text('A newer local edit must also survive recovery'));
  const beforeRecovery = plugin.settings.cloudConnection;
  const createBinary = plugin.app.vault.createBinary;
  plugin.app.vault.createBinary = async () => { throw new Error('Synthetic recovery write failure'); };
  await assert.rejects(recoverer.recoverQueuedUpload(), /recovery write failure/);
  assert.equal(plugin.settings.cloudConnection, beforeRecovery);
  assert.equal(recoverer.hasQueuedUpload, true, 'Never clear a queue without a verified local copy');
  plugin.app.vault.createBinary = createBinary;
  plugin.saveSettings = async () => { throw new Error('Synthetic recovery settings failure'); };
  await assert.rejects(recoverer.recoverQueuedUpload(), /recovery settings failure/);
  assert.equal(plugin.settings.cloudConnection, beforeRecovery, 'Failed persistence must retain the encrypted queue in memory too');
  assert.equal(recoverer.hasQueuedUpload, true);
  plugin.saveSettings = saveSettings;
  const recoveryPath = await recoverer.recoverQueuedUpload();
  assert.match(recoveryPath, /^JotDrop Cloud Test\/Recovered Uploads\//);
  assert.equal(decode(files.get(recoveryPath)), 'Local simultaneous edit kept', 'Recover the exact queued snapshot, not the newer local file');
  assert.equal(recoverer.hasQueuedUpload, false);
  await assert.rejects(recoverer.recoverQueuedUpload(), /no queued upload/);
  assert.equal((await unsealLocal(JSON.parse(plugin.settings.cloudConnection), 'plugin test passphrase')).pending, undefined);
  assert.equal((await owner.status()).transport.reservedBytes, 0);
  assert.equal((await owner.history(cloudId)).versions.length, 3, 'Recovery must not rewrite cloud history');
  const recoveredRestart = new CloudController(plugin);
  await recoveredRestart.unlock('plugin test passphrase');
  await recoveredRestart.sync();
  assert.equal(decode(files.get('JotDrop Cloud Test/notes/cloud.md')), 'A newer local edit must also survive recovery');
  const changes = (await owner.listChanges()).changes;
  const entries = await Promise.all([...new Set(changes.map((entry) => entry.id))].map((id) => owner.read(id)));
  assert.ok(entries.some((entry) => entry.file.path === 'notes/z-must-wait.md'), 'Unrelated uploads must resume after restart');
  assert.ok(entries.every((entry) => !entry.file.path.includes('Recovered Uploads')), 'Recovery copies stay outside the sync scope');
});

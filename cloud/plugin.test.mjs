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
import { randomToken } from './shared/crypto.mjs';

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
  assert.equal(commands.length, 4);
  await assert.rejects(controller.sync(), /Unlock/);
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
  files.set('.stfolder', new Uint8Array());
  await assert.rejects(controller.sync(), /Syncthing/);
  files.delete('.stfolder');
  plugin.settings.notesFolder = 'JotDrop Cloud Test/notes';
  await assert.rejects(controller.sync(), /overlaps/);
  controller.lock();
  await assert.rejects(controller.sync(), /Unlock/);
  await controller.unlock('plugin test passphrase');
  assert.match(controller.status, /Unlocked/);
});

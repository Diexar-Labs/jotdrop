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
import { confirmSignup, signUp } from './shared/account.mjs';
import { objectId, randomToken } from './shared/crypto.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Obsidian's requestUrl answers every status without throwing, like `throw: false`.
const obsidian = `
export class Modal {}; export class Notice {}; export class Setting {}; export class FileSystemAdapter {};
export class TFile { static [Symbol.hasInstance](value) { return value?.isTestFile === true; } };
export const Platform = { isWin: true };
export const normalizePath = (p) => p.replace(/\\\\/g, '/').replace(/\\/+/g, '/');
export const getLanguage = () => 'en';
export async function requestUrl({ url, method, headers, body }) {
  const response = await fetch(url, { method, headers, body });
  const arrayBuffer = await response.arrayBuffer();
  return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer };
}`;
const bundle = await build({ entryPoints: [join(root, 'src/cloud.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [{ name: 'mock-obsidian', setup(builder) {
  builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test' }));
  builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: obsidian }));
} }] });
const loaded = new Module(join(root, 'cloud/plugin-test-bundle.cjs'));
loaded.filename = join(root, 'cloud/plugin-test-bundle.cjs');
loaded._compile(bundle.outputFiles[0].text, loaded.filename);
const { CloudController } = loaded.exports;
globalThis.window ??= globalThis;

const text = (value) => new TextEncoder().encode(value);
const decode = (value) => new TextDecoder().decode(value);

// A vault in memory with the parts of Obsidian's API the cloud uses.
function vault() {
  const files = new Map(), folders = new Set(['']), trashed = [];
  const parentOf = (path) => path.split('/').slice(0, -1).join('/');
  const addParents = (path) => { for (let parent = parentOf(path); parent; parent = parentOf(parent)) folders.add(parent); };
  const file = (path) => (files.has(path) ? { path, extension: path.split('.').pop(), isTestFile: true } : null);
  const plugin = {
    settings: { notesFolder: 'Mini Notes', archiveFolder: 'Mini Notes/Archive', cloudServer: '' },
    resolveAssetsFolder: () => 'Mini Notes/.attachments',
    refreshViews() {},
    addCommand() {}, registerEvent() {}, registerInterval() {}, registerDomEvent() {},
    app: {
      // The Sync core plugin is on by default without a remote vault, as in a fresh vault.
      internalPlugins: { plugins: { sync: { enabled: true, instance: { vaultId: null } } } },
      workspace: { onLayoutReady() {} },
      fileManager: { async trashFile(entry) { trashed.push([entry.path, files.get(entry.path)]); files.delete(entry.path); } },
      vault: {
        getName: () => 'Test',
        on() {},
        getAbstractFileByPath: file,
        async process(entry, change) { files.set(entry.path, text(change(decode(files.get(entry.path))))); },
        async modifyBinary(entry, data) { files.set(entry.path, new Uint8Array(data)); },
        async createBinary(path, data) { if (files.has(path)) throw new Error('exists'); addParents(path); files.set(path, new Uint8Array(data)); },
        adapter: {
          async exists(path) { return files.has(path) || folders.has(path); },
          async list(path) {
            const direct = (entry) => parentOf(entry) === path;
            return { files: [...files.keys()].filter(direct), folders: [...folders].filter((entry) => entry && direct(entry)) };
          },
          async stat(path) { return files.has(path) ? { type: 'file', size: files.get(path).length } : folders.has(path) ? { type: 'folder' } : null; },
          async readBinary(path) { return files.get(path).slice().buffer; },
          async writeBinary(path, data) { addParents(path); files.set(path, new Uint8Array(data)); },
          async mkdir(path) { addParents(`${path}/x`); },
          async trashLocal(path) { trashed.push([path, files.get(path)]); files.delete(path); },
        },
      },
    },
  };
  const memory = new Map();
  const store = { get: async (key) => structuredClone(memory.get(key)), put: async (key, value) => { memory.set(key, structuredClone(value)); }, delete: async (key) => { memory.delete(key); } };
  return { plugin, files, folders, trashed, store, put: (path, value) => { addParents(path); files.set(path, typeof value === 'string' ? text(value) : value); } };
}

test('the plugin signs in with an account, syncs the real JotDrop folders both ways and refuses a second sync system', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-plugin-test-'));
  const mails = [];
  const app = await createCloudServer({ dataDir, enrollmentToken: randomToken(), mailer: async (mail) => { mails.push(mail); }, serverKey: randomToken(), freeDeviceLimit: 100 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;

  const v = vault();
  v.put('Mini Notes/Shopping.md', 'Milk');
  v.put('Mini Notes/Archive/Old.md', 'Archived');
  v.put('Mini Notes/.attachments/photo.jpg', new Uint8Array([1, 2, 3]));
  v.put('Other/Private.md', 'Never leaves this vault');
  const cloud = new CloudController(v.plugin, v.store);
  await assert.rejects(cloud.syncNow(), /Log in/);

  // Create an account the way the sign-in window does: password, then the mailed code.
  const pending = await signUp({ url, email: 'eric@example.com', password: 'correct horse battery', deviceName: 'Obsidian on Windows' });
  const { client } = await confirmSignup(pending, mails.find((mail) => mail.kind === 'verify').code);
  // The settings tab redraws on every change and registers itself again; that must not loop.
  let redraws = 0;
  let off = cloud.onChange(function redraw() { redraws++; off(); off = cloud.onChange(redraw); });
  await cloud.finishSignIn(client, 'eric@example.com');
  off();
  assert.equal(redraws, 1);
  assert.equal(cloud.signedIn, true);
  assert.ok(![...v.files.keys()].some((path) => path.includes('data.json')), 'Keys stay out of the vault');
  await assert.rejects(cloud.syncNow(), /Turn on cloud sync/);

  await cloud.setEnabled(true);
  await cloud.syncNow();
  assert.match(cloud.status, /Synced\. 3 up, 0 down/);
  const phone = await CloudClient.claim({ pairingCode: (await client.makePairing('Phone')).pairingCode });
  const pathsInCloud = async () => {
    const ids = [...new Set((await phone.listChanges()).changes.map((change) => change.id))];
    return Object.fromEntries(await Promise.all(ids.map(async (id) => { const entry = await phone.read(id); return [entry.file.path, entry.deleted ? null : decode(Buffer.from(entry.file.content, 'base64url'))]; })));
  };
  assert.deepEqual(await pathsInCloud(), { 'attachments/photo.jpg': '\x01\x02\x03', 'notes/Archive/Old.md': 'Archived', 'notes/Shopping.md': 'Milk' });

  // A note made on the phone arrives; an edit here goes up.
  await phone.write('notes/From phone.md', text('Hello from Android'), 0);
  await cloud.syncNow();
  assert.equal(decode(v.files.get('Mini Notes/From phone.md')), 'Hello from Android');
  v.put('Mini Notes/Shopping.md', 'Milk, eggs');
  await cloud.syncNow();
  assert.equal((await pathsInCloud())['notes/Shopping.md'], 'Milk, eggs');

  // A deletion on the phone moves the note to Obsidian's trash, never deletes it outright.
  const id = await objectId(client.credentials.vaultKey, 'notes/From phone.md');
  await phone.remove(id, 1);
  await cloud.syncNow();
  assert.ok(!v.files.has('Mini Notes/From phone.md'));
  assert.deepEqual(v.trashed.map(([path]) => path), ['Mini Notes/From phone.md']);

  // A note open in the editor is not replaced; the phone's version comes next to it.
  await phone.write('notes/Shopping.md', text('Phone list'), 2);
  cloud.beginEdit('Mini Notes/Shopping.md');
  await cloud.syncNow();
  assert.equal(decode(v.files.get('Mini Notes/Shopping.md')), 'Milk, eggs');
  assert.equal(decode(v.files.get('Mini Notes/Shopping.cloud-conflict-r3.md')), 'Phone list');
  assert.match(cloud.status, /changed in two places/);
  cloud.endEdit('Mini Notes/Shopping.md');

  // Two sync systems: Syncthing markers or Obsidian Sync stop the cloud before it touches anything.
  v.put('.stfolder', new Uint8Array());
  await assert.rejects(cloud.syncNow(), /Syncthing/);
  v.files.delete('.stfolder');
  v.plugin.app.internalPlugins.plugins.sync.instance.vaultId = 'remote-vault';
  await assert.rejects(cloud.syncNow(), /Obsidian Sync/);
  v.plugin.app.internalPlugins.plugins.sync.instance.vaultId = null;

  // Another notes folder would make every note look deleted: sync stops until it is turned on again.
  v.plugin.settings.notesFolder = 'Elsewhere';
  v.plugin.settings.archiveFolder = 'Elsewhere/Archive';
  await assert.rejects(cloud.syncNow(), /folder changed/);
  assert.ok(await pathsInCloud().then((files) => files['notes/Shopping.md']), 'Nothing was removed from the cloud');
  v.plugin.settings.notesFolder = 'Mini Notes';
  v.plugin.settings.archiveFolder = 'Mini Notes/Archive';

  // Restarting Obsidian keeps the session; logging out forgets it.
  const restarted = new CloudController(v.plugin, v.store);
  await restarted.syncNow();
  assert.equal(restarted.email, 'eric@example.com');
  await restarted.logOut();
  assert.equal(restarted.signedIn, false);
  await assert.rejects(new CloudController(v.plugin, v.store).syncNow(), /Log in/, 'A restart after logging out stays logged out');
  assert.ok(v.files.has('Mini Notes/Shopping.md'), 'Logging out keeps the notes');
  assert.ok(v.files.has('Other/Private.md') && !(await pathsInCloud())['notes/Private.md'], 'Only the JotDrop folders sync');
});

test('the archive must sit inside the notes folder, like on the website and Android', async () => {
  const v = vault();
  v.plugin.settings.archiveFolder = 'Archive';
  const cloud = new CloudController(v.plugin, v.store);
  await assert.rejects(cloud.checkFolders(), /archive folder/);
});

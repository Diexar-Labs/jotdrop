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
import { accountInfo, confirmSignup, providerSignUp, signUp } from './shared/account.mjs';
import { bytesToBase64, encryptEnvelope, objectId, randomToken } from './shared/crypto.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Obsidian's requestUrl answers every status without throwing, like `throw: false`.
const obsidian = `
export class Modal {}; export class Notice {}; export class Setting {}; export class ButtonComponent {}; export class FileSystemAdapter {};
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
  // Like Obsidian's stat: each new content is a new array, so its identity stands in for a modification time.
  const times = new WeakMap();
  let clock = 0;
  const stat = (path) => {
    const bytes = files.get(path);
    if (!times.has(bytes)) times.set(bytes, ++clock);
    return { type: 'file', size: bytes.length, mtime: times.get(bytes) };
  };
  const file = (path) => (files.has(path) ? { path, extension: path.split('.').pop(), isTestFile: true, stat: stat(path) } : null);
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
          async stat(path) { return files.has(path) ? stat(path) : folders.has(path) ? { type: 'folder' } : null; },
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
  const app = await createCloudServer({ dataDir, enrollmentToken: randomToken(), mailer: async (mail) => { mails.push(mail); }, serverKey: randomToken(), freeDeviceLimit: 100, maxFileBytes: 6 * 1024 * 1024 });
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

  // A photo over 4 MiB goes up in encrypted pieces; a file over the plan's maximum stays in this vault and is named.
  v.put('Mini Notes/.attachments/Big photo.jpg', new Uint8Array(5 * 1024 * 1024).fill(7));
  v.put('Mini Notes/.attachments/Huge video.mp4', new Uint8Array(7 * 1024 * 1024));
  v.put('Mini Notes/Later.md', 'Still syncs');
  await cloud.syncNow();
  assert.match(cloud.status, /Synced\. 2 up, 0 down, 0 removed\. 1 file is larger than 6 MB, your plan's maximum per file, and stays only on this device: Huge video\.mp4\./);
  const inCloud = await pathsInCloud();
  assert.ok('attachments/Big photo.jpg' in inCloud && !('attachments/Huge video.mp4' in inCloud));
  v.files.delete('Mini Notes/.attachments/Big photo.jpg');
  v.files.delete('Mini Notes/.attachments/Huge video.mp4');

  // A note made on the phone arrives; an edit here goes up.
  await phone.write('notes/From phone.md', text('Hello from Android'), 0);
  await cloud.syncNow();
  assert.equal(decode(v.files.get('Mini Notes/From phone.md')), 'Hello from Android');
  v.put('Mini Notes/Shopping.md', 'Milk, eggs');
  await cloud.syncNow();
  assert.equal((await pathsInCloud())['notes/Shopping.md'], 'Milk, eggs');

  // A large file saved before encrypted pieces arrives, then moves into pieces in the cloud; the vault keeps it as it is.
  const { vaultKey, vaultId } = phone.credentials, oldPath = 'attachments/Old scan.png', oldId = await objectId(vaultKey, oldPath);
  const old = new Uint8Array(2 * 1024 * 1024).fill(9);
  await phone.commitWrite({ id: oldId, baseRevision: 0, envelope: JSON.stringify(await encryptEnvelope(vaultKey, { path: oldPath, content: bytesToBase64(old), modifiedAt: new Date().toISOString() }, `jotdrop:object:v1:${vaultId}:${oldId}`)) });
  assert.equal((await phone.status()).pieces.legacy, 1);
  await cloud.syncNow();
  assert.match(cloud.status, /Synced\. 0 up, 1 down/);
  assert.deepEqual(v.files.get('Mini Notes/.attachments/Old scan.png'), old);
  assert.equal((await phone.status()).pieces.legacy, 0);
  assert.equal((await phone.readManifest(oldId)).manifest.pieces.length, 2);
  assert.deepEqual((await phone.read(oldId)).file.bytes, old);

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
  assert.match(cloud.status, /changed in two places.*"Resolve now"/);
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

test('the plugin signs in with Google through obsidian://jotdrop-cloud, and the ticket works only once on this device', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-plugin-test-'));
  // Google as the server sees it: the code the browser brings back names the person.
  const people = { ann: { sub: 'g-ann', email: 'ann@example.com', email_verified: true } };
  const fetcher = async (address, init = {}) => {
    const json = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    if (address === 'https://oauth2.googleapis.com/token') return json({ access_token: `token-${new URLSearchParams(init.body).get('code')}` });
    if (address === 'https://openidconnect.googleapis.com/v1/userinfo') return json(people[/token-(\w+)/.exec(init.headers.Authorization)[1]]);
    throw new Error(`Unexpected request ${address}`);
  };
  const app = await createCloudServer({ dataDir, mailer: async () => {}, serverKey: randomToken(), freeDeviceLimit: 100, fetcher, oauth: { google: { clientId: 'google-id', clientSecret: 'google-secret' } } });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;

  const v = vault(), handlers = {};
  v.plugin.registerObsidianProtocolHandler = (action, handler) => { handlers[action] = handler; };
  // Obsidian clears these on unload; here the test does, so the process can end.
  v.plugin.registerInterval = (id) => { t.after(() => clearInterval(id)); };
  const cloud = new CloudController(v.plugin, v.store);
  cloud.register();
  assert.equal(typeof handlers['jotdrop-cloud'], 'function');

  // The browser: the provider's page, then back to Obsidian; Obsidian hands the handler the decoded query.
  const browse = async (href, code) => {
    const authorize = new URL((await fetch(href, { redirect: 'manual' })).headers.get('location'));
    const callback = new URL(authorize.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({ state: authorize.searchParams.get('state'), ...(code ? { code } : { error: 'access_denied' }) }).toString();
    const location = (await fetch(callback, { redirect: 'manual' })).headers.get('location');
    assert.match(location, /^obsidian:\/\/jotdrop-cloud\?/);
    return { action: 'jotdrop-cloud', ...Object.fromEntries(new URL(location).searchParams) };
  };

  await assert.rejects(cloud.providerReturn(await browse(await cloud.startProvider(url, 'google'))), /cancelled/);
  const params = await browse(await cloud.startProvider(url, 'google'), 'ann');
  const signIn = await cloud.providerReturn(params);
  assert.deepEqual([signIn.provider, signIn.email, signIn.account], ['google', 'ann@example.com', false]);
  await assert.rejects(cloud.providerReturn(params), /started in another vault/, 'The verifier is gone after the first use');
  await assert.rejects(new CloudController(vault().plugin, vault().store).providerReturn(params), /started in another vault/, 'Another vault has no verifier');

  const { client, recoveryCode } = await providerSignUp(signIn, { deviceName: 'Obsidian' });
  assert.ok(recoveryCode);
  await cloud.finishSignIn(client, signIn.email);
  assert.equal(cloud.signedIn, true);
  assert.equal((await accountInfo(cloud.connection)).password, false, 'A Google account starts without a password');
});

test('the plugin settles a conflict either way and goes back to a moment with the time machine', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-plugin-test-'));
  const mails = [];
  let now = Date.parse('2026-10-24T10:00:00Z');
  const app = await createCloudServer({ dataDir, enrollmentToken: randomToken(), mailer: async (mail) => { mails.push(mail); }, serverKey: randomToken(), freeDeviceLimit: 100, clock: () => now });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  const minute = () => { now += 60_000; };

  const v = vault();
  v.put('Mini Notes/A.md', 'A1');
  v.put('Mini Notes/B.md', 'B1');
  const cloud = new CloudController(v.plugin, v.store);
  const pending = await signUp({ url, email: 'eric@example.com', password: 'correct horse battery', deviceName: 'Obsidian on Windows' });
  const { client } = await confirmSignup(pending, mails.find((mail) => mail.kind === 'verify').code);
  await cloud.finishSignIn(client, 'eric@example.com');
  await cloud.setEnabled(true);
  await cloud.syncNow();
  const phone = await CloudClient.claim({ pairingCode: (await client.makePairing('Phone')).pairingCode });
  const inCloud = async (path) => decode(Buffer.from((await phone.read(await objectId(client.credentials.vaultKey, path))).file.content, 'base64url'));
  minute();

  // Changed on the phone and here: keep this vault's version. It goes up; the cloud copy goes to the trash.
  await phone.write('notes/A.md', text('A phone'), 1);
  v.put('Mini Notes/A.md', 'A vault');
  await cloud.syncNow();
  assert.deepEqual(await cloud.conflicts(), [{ path: 'notes/A.md', local: 'Mini Notes/A.md', copies: ['Mini Notes/A.cloud-conflict-r2.md'] }]);
  const versions = await cloud.compare('notes/A.md');
  assert.deepEqual([decode(versions.local), decode(versions.cloud)], ['A vault', 'A phone']);
  await cloud.resolve('notes/A.md', true);
  assert.equal(await inCloud('notes/A.md'), 'A vault');
  assert.deepEqual(await cloud.conflicts(), []);
  assert.ok(v.trashed.some(([path]) => path === 'Mini Notes/A.cloud-conflict-r2.md'));
  await cloud.syncNow();
  assert.match(cloud.status, /Synced/);
  minute();

  // Use the cloud version: this vault's version goes to the trash, so it can come back.
  await phone.write('notes/B.md', text('B phone'), 1);
  v.put('Mini Notes/B.md', 'B vault');
  await cloud.syncNow();
  // A note open in the editor is never replaced.
  cloud.beginEdit('Mini Notes/B.md');
  await assert.rejects(cloud.resolve('notes/B.md', false), /open in the editor/);
  cloud.endEdit('Mini Notes/B.md');
  await cloud.resolve('notes/B.md', false);
  assert.equal(decode(v.files.get('Mini Notes/B.md')), 'B phone');
  assert.ok(v.trashed.some(([path, bytes]) => path === 'Mini Notes/B.md' && decode(bytes) === 'B vault'));
  assert.deepEqual(await cloud.conflicts(), []);
  await cloud.syncNow();
  assert.match(cloud.status, /Synced\. 0 up, 0 down/);
  minute();

  // The time machine: back to the first minute. Files from then come back, a later file moves to the trash.
  v.put('Mini Notes/C.md', 'C1');
  await cloud.syncNow();
  const steps = await cloud.timeline();
  assert.equal(steps.length, 4);
  const moment = await cloud.moment(steps[0]);
  assert.deepEqual(moment.files.map((file) => [file.path, decode(file.bytes)]), [['notes/A.md', 'A1'], ['notes/B.md', 'B1']]);
  assert.equal(moment.locked + moment.cleared, 0);
  minute();
  assert.equal(await cloud.restoreMoment(moment), 3);
  await cloud.syncNow();
  assert.deepEqual([decode(v.files.get('Mini Notes/A.md')), decode(v.files.get('Mini Notes/B.md')), v.files.has('Mini Notes/C.md')], ['A1', 'B1', false]);
  assert.ok(v.trashed.some(([path]) => path === 'Mini Notes/C.md'));
  // The time machine can undo that: the moment before the restore still has C.
  const back = await cloud.moment((await cloud.timeline()).at(-2));
  assert.ok(back.files.some((file) => file.path === 'notes/C.md'));

  // History of one note: B was B1, B phone, then B1 again. Version 2 comes back as the newest version.
  const history = await cloud.history('Mini Notes/B.md');
  assert.equal(history.path, 'notes/B.md');
  assert.deepEqual(history.versions.map((version) => version.revision), [3, 2, 1]);
  assert.equal(decode(await cloud.readVersion(history.id, 2)), 'B phone');
  await cloud.restoreVersion(history.path, 2);
  assert.equal(decode(v.files.get('Mini Notes/B.md')), 'B phone');
  assert.equal((await cloud.history('Mini Notes/B.md')).versions[0].revision, 4);
  await assert.rejects(cloud.history('Other/Private.md'), /JotDrop folders/);
  await assert.rejects(cloud.history('Mini Notes/B.cloud-conflict-r2.md'), /JotDrop folders/);
});

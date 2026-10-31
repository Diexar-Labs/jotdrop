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
import { acceptInvite, createSpace, makeInvite, readInvite, removeMember, replaceSpace, spaceClient, spaceDetails } from './shared/spaces.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Obsidian's requestUrl answers every status without throwing, like `throw: false`. A test can hold an answer with `afterRequest`.
const obsidian = `
export class Modal {}; export class Notice {}; export class Setting {}; export class ButtonComponent {}; export class FileSystemAdapter {};
export class TFile { static [Symbol.hasInstance](value) { return value?.isTestFile === true; } };
export const Platform = { isWin: true };
export const normalizePath = (p) => p.replace(/\\\\/g, '/').replace(/\\/+/g, '/');
export const getLanguage = () => 'en';
export async function requestUrl({ url, method, headers, body }) {
  const response = await fetch(url, { method, headers, body });
  const arrayBuffer = await response.arrayBuffer();
  await globalThis.afterRequest?.(url);
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
  const file = (path) => (files.has(path) ? { path, name: path.split('/').pop(), basename: path.split('/').pop().replace(/\.[^.]*$/, ''), extension: path.split('.').pop(), isTestFile: true, stat: stat(path) } : null);
  const plugin = {
    settings: { notesFolder: 'Mini Notes', archiveFolder: 'Mini Notes/Archive', cloudServer: '' },
    resolveAssetsFolder: () => 'Mini Notes/.attachments',
    refreshViews() {},
    addCommand() {}, registerEvent() {}, registerInterval() {}, registerDomEvent() {},
    app: {
      // The Sync core plugin is on by default without a remote vault, as in a fresh vault.
      internalPlugins: { plugins: { sync: { enabled: true, instance: { vaultId: null } } } },
      workspace: { onLayoutReady() {} },
      fileManager: {
        async trashFile(entry) { trashed.push([entry.path, files.get(entry.path)]); files.delete(entry.path); },
        // Enough of Obsidian's frontmatter handling for the fields a shared note leaves behind.
        async processFrontMatter(entry, change) {
          const content = decode(files.get(entry.path)), match = /^---\n([\s\S]*?)\n---\n/.exec(content);
          const fields = Object.fromEntries((match?.[1].split('\n') ?? []).map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]));
          change(fields);
          const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
          files.set(entry.path, text(`${lines.length ? `---\n${lines.join('\n')}\n---\n` : ''}${match ? content.slice(match[0].length) : content}`));
        },
      },
      metadataCache: { getFirstLinkpathDest(link) { const path = [...files.keys()].find((entry) => entry.split('/').pop() === link); return path ? { path, name: link, extension: link.split('.').pop(), isTestFile: true } : null; } },
      vault: {
        getName: () => 'Test',
        on() {},
        getAbstractFileByPath: file,
        async process(entry, change) { files.set(entry.path, text(change(decode(files.get(entry.path))))); },
        async modifyBinary(entry, data) { files.set(entry.path, new Uint8Array(data)); },
        async createBinary(path, data) { if (files.has(path)) throw new Error('exists'); addParents(path); files.set(path, new Uint8Array(data)); },
        async create(path, content) { if (files.has(path)) throw new Error('exists'); addParents(path); files.set(path, text(content)); return file(path); },
        async read(entry) { return decode(files.get(entry.path)); },
        async readBinary(entry) { return files.get(entry.path).slice().buffer; },
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
          async rmdir(path) { for (const entry of [...files.keys()]) if (entry.startsWith(`${path}/`)) files.delete(entry); for (const entry of [...folders]) if (entry === path || entry.startsWith(`${path}/`)) folders.delete(entry); },
          async trashLocal(path) {
            trashed.push([path, files.get(path)]);
            for (const entry of [...files.keys()]) if (entry === path || entry.startsWith(`${path}/`)) files.delete(entry);
            for (const entry of [...folders]) if (entry === path || entry.startsWith(`${path}/`)) folders.delete(entry);
          },
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

test('sync now during a sync waits for it and syncs again, so it sees what changed meanwhile', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-plugin-test-'));
  const mails = [];
  const app = await createCloudServer({ dataDir, enrollmentToken: randomToken(), mailer: async (mail) => { mails.push(mail); }, serverKey: randomToken(), freeDeviceLimit: 100 });
  t.after(async () => { globalThis.afterRequest = undefined; await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;

  const v = vault();
  const cloud = new CloudController(v.plugin, v.store);
  // Only the syncs this test asks for.
  cloud.request = () => {};
  const pending = await signUp({ url, email: 'eric@example.com', password: 'correct horse battery', deviceName: 'Obsidian on Windows' });
  const { client } = await confirmSignup(pending, mails.find((mail) => mail.kind === 'verify').code);
  await cloud.finishSignIn(client, 'eric@example.com');
  await cloud.setEnabled(true);
  await cloud.syncNow();
  const phone = await CloudClient.claim({ pairingCode: (await client.makePairing('Phone')).pairingCode });

  // A sync is under way and already asked the cloud what it holds; then the phone saves a file from before pieces.
  let reached, release;
  const asked = new Promise((resolve) => { reached = resolve; }), held = new Promise((resolve) => { release = resolve; });
  globalThis.afterRequest = async (requested) => { if (requested.endsWith('/status')) { globalThis.afterRequest = undefined; reached(); await held; } };
  const first = cloud.syncNow();
  await asked;
  const { vaultKey, vaultId } = phone.credentials, path = 'attachments/Old scan.png', id = await objectId(vaultKey, path);
  await phone.commitWrite({ id, baseRevision: 0, envelope: JSON.stringify(await encryptEnvelope(vaultKey, { path, content: bytesToBase64(new Uint8Array(2 * 1024 * 1024).fill(9)), modifiedAt: new Date().toISOString() }, `jotdrop:object:v1:${vaultId}:${id}`)) });
  const second = cloud.syncNow();
  release();
  await Promise.all([first, second]);
  assert.equal((await phone.status()).pieces.legacy, 0);
});

test('a sync that only sends changes up leaves the cards alone; one that brings something in redraws them', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-plugin-test-'));
  const mails = [];
  const app = await createCloudServer({ dataDir, enrollmentToken: randomToken(), mailer: async (mail) => { mails.push(mail); }, serverKey: randomToken(), freeDeviceLimit: 100 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;

  const v = vault();
  let redraws = 0;
  v.plugin.refreshViews = () => { redraws++; };
  v.put('Mini Notes/List.md', '- [ ] Milk');
  const cloud = new CloudController(v.plugin, v.store);
  cloud.request = () => {};
  const pending = await signUp({ url, email: 'eric@example.com', password: 'correct horse battery', deviceName: 'Obsidian on Windows' });
  const { client } = await confirmSignup(pending, mails.find((mail) => mail.kind === 'verify').code);
  await cloud.finishSignIn(client, 'eric@example.com');
  await cloud.setEnabled(true);
  await cloud.syncNow();
  const phone = await CloudClient.claim({ pairingCode: (await client.makePairing('Phone')).pairingCode });

  // A ticked box or a closed card: the change goes up, Obsidian already shows it, so the view keeps its place.
  redraws = 0;
  v.put('Mini Notes/List.md', '- [x] Milk');
  await cloud.syncNow();
  assert.match(cloud.status, /Synced\. 1 up, 0 down/);
  assert.equal(redraws, 0);

  // A note from the phone, a deletion and a conflict each redraw the cards.
  await phone.write('notes/From phone.md', text('Hello'), 0);
  await cloud.syncNow();
  assert.equal(redraws, 1);
  await phone.remove(await objectId(client.credentials.vaultKey, 'notes/From phone.md'), 1);
  await cloud.syncNow();
  assert.equal(redraws, 2);
  await phone.write('notes/List.md', text('- [ ] Bread'), 2);
  cloud.beginEdit('Mini Notes/List.md');
  await cloud.syncNow();
  cloud.endEdit('Mini Notes/List.md');
  assert.match(cloud.status, /changed in two places/);
  assert.equal(redraws, 3);
});

test('shared groups: a group syncs in its own folder, a bad file or being removed stops nothing, and notes can be kept', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-plugin-spaces-'));
  const mails = [];
  let now = Date.parse('2026-11-02T08:00:00Z');
  const app = await createCloudServer({ dataDir, enrollmentToken: randomToken(), mailer: async (mail) => { mails.push(mail); }, serverKey: randomToken(), clock: () => now, freeDeviceLimit: 100, signupsPerAddress: 1000 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  const account = async (email) => {
    now += 61000;
    const pending = await signUp({ url, email, password: 'correct horse battery', deviceName: 'Test' });
    return (await confirmSignup(pending, mails.filter((mail) => mail.to === email && mail.kind === 'verify').at(-1).code)).client;
  };
  const v = vault();
  v.put('Mini Notes/Mine.md', 'My own note');
  const cloud = new CloudController(v.plugin, v.store);
  await cloud.finishSignIn(await account('plugin@example.com'), 'plugin@example.com');
  await cloud.setEnabled(true);
  await cloud.syncNow();
  const own = cloud.connection;

  // Someone else makes a group; a link brings it in here. The key is wrapped for this account, so other devices get it too.
  const eric = await account('eric@example.com');
  const space = await createSpace(eric, 'Family', { memberName: 'Eric' });
  const files = spaceClient(eric, space.id, space.key);
  await files.write('notes/Groceries.md', text('- [ ] milk\n- [ ] bread\n'), 0);
  await files.write('attachments/x.png', new Uint8Array([9, 9]), 0);
  now += 61000;
  await cloud.join((await makeInvite(eric, space, 'Eric')).link, 'Ana');
  const local = `Mini Notes/Shared/${space.id}/Groceries.md`;
  assert.equal(decode(v.files.get(local)), '- [ ] milk\n- [ ] bread\n');
  assert.deepEqual([...v.files.get(`Mini Notes/Shared/${space.id}/attachments/x.png`)], [9, 9]);
  assert.equal(cloud.spaceOf(local).name, 'Family');
  assert.deepEqual(cloud.spaceOf(local).others, ['Eric']);
  assert.equal(cloud.spaceOf('Mini Notes/Mine.md'), undefined);
  // Nothing of the group goes into the own vault.
  await cloud.syncNow();
  const { changes } = await own.listChanges(0);
  assert.equal(changes.filter((change) => !change.deleted).length, 1, 'Only Mine.md');

  // Both ways, and both ticks in one note.
  v.put(local, '- [x] milk\n- [ ] bread\n');
  const id = await objectId(space.key, 'notes/Groceries.md');
  const before = await files.read(id);
  await files.write('notes/Groceries.md', text('- [ ] milk\n- [x] bread\n'), before.revision);
  await cloud.syncNow();
  const merged = '- [x] milk\n- [x] bread\n';
  assert.equal(decode(v.files.get(local)), merged);
  assert.equal(decode((await files.read(id)).file.bytes), merged);

  // A file that does not open, and a note where the attachments are: left out, and the rest still syncs.
  const evil = await files.prepareWrite('notes/Other.md', text('bad'), 0);
  await files.commitWrite({ ...evil, id: await objectId(space.key, 'notes/Evil.md') }, { source: text('bad') });
  await files.write('notes/attachments/trick.md', text('in the wrong place'), 0);
  await files.write('notes/Second.md', text('Second'), 0);
  await files.write('notes/Spare.md', text('Spare'), 0);
  await cloud.syncNow();
  assert.equal(decode(v.files.get(`Mini Notes/Shared/${space.id}/Second.md`)), 'Second');
  assert.ok(![...v.files.keys()].some((path) => /Evil|Other|trick/.test(path)));

  // Someone overwrites a note this device tracks with what does not open: the rest keeps syncing, the note stays.
  const spare = `Mini Notes/Shared/${space.id}/Spare.md`, spareId = await objectId(space.key, 'notes/Spare.md');
  const broken = await spaceClient(eric, space.id, randomToken()).prepareWrite('notes/Spare.md', text('bad'), (await files.read(spareId)).revision);
  await files.commitWrite({ ...broken, id: spareId }, { source: text('bad') });
  await files.write('notes/Third.md', text('Third'), 0);
  await cloud.syncNow();
  assert.equal(decode(v.files.get(spare)), 'Spare');
  assert.equal(decode(v.files.get(`Mini Notes/Shared/${space.id}/Third.md`)), 'Third', 'Everything else still syncs');
  // A change on top of it repairs the note for everyone.
  v.put(spare, 'Spare, repaired');
  await cloud.syncNow();
  assert.equal(decode((await files.read(spareId)).file.bytes), 'Spare, repaired');

  // The folder disappears, by hand or otherwise: that is not "deleted for everyone", the notes simply come back.
  await v.plugin.app.vault.adapter.rmdir(`Mini Notes/Shared/${space.id}`, true);
  await cloud.syncNow();
  assert.equal(decode(v.files.get(local)), merged);
  assert.equal(decode((await files.read(id)).file.bytes), merged, 'Nothing was deleted in the cloud');

  // Removed from the group: nothing is deleted without asking, and the own vault keeps syncing.
  const me = (await spaceDetails(eric, space.id)).members.find((member) => member.name === 'Ana');
  await removeMember(eric, space.id, me.accountId);
  v.put('Mini Notes/After.md', 'Written after being removed');
  await cloud.syncNow();
  assert.ok(cloud.enabled);
  assert.equal(cloud.spaceOf(local).gone, true);
  assert.ok(v.files.has(local));
  assert.equal((await own.listChanges(0)).changes.filter((change) => !change.deleted).length, 2);
  await cloud.release(cloud.spaceOf(local), true);
  assert.equal(decode(v.files.get('Mini Notes/Groceries.md')), merged);
  assert.deepEqual([...v.files.get('Mini Notes/.attachments/x.png')], [9, 9]);
  assert.ok(!v.files.has(local));
  assert.equal(cloud.spaces.length, 0);

  // Invited again after keeping a copy, with something already in the folder: the notes come back, and nobody loses them.
  v.put(`Mini Notes/Shared/${space.id}/Back.md`, 'Back');
  now += 61000;
  await cloud.join((await makeInvite(eric, space, 'Eric')).link, 'Ana');
  assert.equal(decode(v.files.get(local)), merged);
  assert.equal(decode((await files.read(id)).file.bytes), merged, 'Nothing was deleted in the cloud');
  await cloud.leave(cloud.spaceOf(local));
  await cloud.release(cloud.spaceOf(local), false);

  // Sharing: to a new group with its photo; pin, labels and a reminder stay behind, the colour goes along.
  v.put('Mini Notes/Trip.md', '---\npinned: true\ncolor: blue\nreminder: 2027-01-01T10:00\n---\nPacking\n\n![[x.png]]\n');
  await cloud.syncNow();
  await cloud.share(v.plugin.app.vault.getAbstractFileByPath('Mini Notes/Trip.md'), null, 'Holiday', 'Ana');
  await cloud.syncNow();
  const holiday = cloud.spaces[0];
  assert.equal(decode(v.files.get(`Mini Notes/Shared/${holiday.id}/Trip.md`)), '---\ncolor: blue\n---\nPacking\n\n![[x.png]]\n');
  assert.ok(v.files.has(`Mini Notes/Shared/${holiday.id}/attachments/x.png`));
  assert.ok(!v.files.has('Mini Notes/Trip.md'));
  const peer = await account('peer@example.com');
  now += 61000;
  const link = await cloud.invite(holiday.id, 'Ana');
  const joined = await acceptInvite(peer, readInvite(link), 'Peer');
  const seen = spaceClient(peer, joined.id, joined.key);
  assert.match(decode((await seen.read(await objectId(joined.key, 'notes/Trip.md'))).file.bytes), /Packing/);
  // The free plan shares one note.
  v.put('Mini Notes/Two.md', 'Two');
  await cloud.syncNow();
  await assert.rejects(cloud.share(v.plugin.app.vault.getAbstractFileByPath('Mini Notes/Two.md'), holiday.id, '', 'Ana'), /free plan/);
  assert.ok(v.files.has('Mini Notes/Two.md'));

  // An unsent change in a group that goes read-only comes back as an own note, and the group's copy stays as it was.
  await cloud.syncNow();
  const three = await account('three@example.com');
  now += 61000;
  await acceptInvite(three, readInvite(await cloud.invite(holiday.id, 'Ana')), 'Three');
  v.put(`Mini Notes/Shared/${holiday.id}/Trip.md`, '---\ncolor: blue\n---\nPacking unsent\n\n![[x.png]]\n');
  const message = await removeThroughOwner(cloud, holiday, 'Three');
  assert.match(message, /new link: Peer/);
  const next = cloud.spaces.find((item) => item.id !== holiday.id);
  assert.ok(next && next.key !== holiday.key, 'A new group with a new key');
  assert.ok(!v.files.has(`Mini Notes/Shared/${holiday.id}/Trip.md`), 'The old folder is gone');
  assert.match(decode(v.files.get(`Mini Notes/Shared/${next.id}/Trip.md`)), /Packing unsent/, 'It was sent before the copy was made');
  await assert.rejects(spaceClient(three, next.id, next.key).listChanges(0), (error) => error.status === 401);

  // The same owner replaces the group from another device: this device shows the old one as read-only, keeps what it did not send, and gets the new one.
  v.put(`Mini Notes/Shared/${next.id}/Trip.md`, '---\ncolor: blue\n---\nPacking from this device\n\n![[x.png]]\n');
  const again = await replaceSpace(cloud.connection, await spaceDetails(cloud.connection, next.id), { memberName: 'Ana' });
  await cloud.syncNow();
  assert.equal(cloud.spaces.find((item) => item.id === next.id).frozen, true);
  assert.match(decode(v.files.get('Mini Notes/Not sent - Trip.md')), /Packing from this device/);
  assert.match(decode(v.files.get(`Mini Notes/Shared/${again.id}/Trip.md`)), /Packing unsent/);

  // As a member: what could not be sent before the owner replaced the group comes back as an own note, once.
  now += 61000;
  await cloud.join((await makeInvite(eric, space, 'Eric')).link, 'Ana');
  const family = `Mini Notes/Shared/${space.id}/Second.md`;
  assert.equal(decode(v.files.get(family)), 'Second');
  v.put(family, 'Second, changed here');
  const fourth = await account('fourth@example.com');
  now += 61000;
  await acceptInvite(fourth, readInvite((await makeInvite(eric, space, 'Eric')).link), 'Fourth');
  await replaceSpace(eric, await spaceDetails(eric, space.id), { memberName: 'Eric' });
  await cloud.syncNow();
  await cloud.syncNow();
  assert.equal(decode(v.files.get('Mini Notes/Not sent - Second.md')), 'Second, changed here');
  assert.equal(decode(v.files.get(family)), 'Second, changed here', 'Copied, never moved');
  assert.equal(cloud.spaceOf(family).frozen, true);
  // Put aside, it stays away while the server still lists it.
  await cloud.release(cloud.spaceOf(family), false);
  await cloud.syncNow();
  assert.equal(cloud.spaceOf(family), undefined);
  assert.ok(!v.files.has(family));
  assert.equal((await spaceClient(eric, space.id, space.key).read(await objectId(space.key, 'notes/Second.md'))).revision, 1, 'Nothing went up to the frozen group');
  assert.ok(![...v.files.keys()].some((path) => path.includes('Not sent - Second 2')), 'Once per version');
});

const removeThroughOwner = async (cloud, space, name) => {
  const details = await cloud.details(space.id);
  return cloud.removePerson(space, details.members.find((member) => member.name === name).accountId);
};

// One account in Obsidian, invited to a group of Eric's with two notes and a photo.
async function groupSetup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-plugin-groups-'));
  const mails = [];
  let now = Date.parse('2026-11-02T08:00:00Z');
  const app = await createCloudServer({ dataDir, enrollmentToken: randomToken(), mailer: async (mail) => { mails.push(mail); }, serverKey: randomToken(), clock: () => now, freeDeviceLimit: 100, signupsPerAddress: 1000 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  const account = async (email) => {
    now += 61000;
    const pending = await signUp({ url, email, password: 'correct horse battery', deviceName: 'Test' });
    return (await confirmSignup(pending, mails.filter((mail) => mail.to === email && mail.kind === 'verify').at(-1).code)).client;
  };
  const v = vault();
  v.put('Mini Notes/Mine.md', 'My own note');
  const cloud = new CloudController(v.plugin, v.store);
  await cloud.finishSignIn(await account('plugin@example.com'), 'plugin@example.com');
  await cloud.setEnabled(true);
  await cloud.syncNow();
  const eric = await account('eric@example.com');
  const space = await createSpace(eric, 'Family', { memberName: 'Eric' });
  const files = spaceClient(eric, space.id, space.key);
  await files.write('notes/Groceries.md', text('- [ ] milk\n![[photo.png]]\n'), 0);
  await files.write('notes/Second.md', text('Second'), 0);
  await files.write('attachments/photo.png', text('photo bytes'), 0);
  const invite = async () => { now += 61000; return (await makeInvite(eric, space, 'Eric')).link; };
  await cloud.join(await invite(), 'Ana');
  const deleted = async (path) => (await files.read(await objectId(space.key, path))).deleted === true;
  return { v, cloud, eric, space, invite, deleted, local: `Mini Notes/Shared/${space.id}` };
}

test('shared groups: the conflict review of the own vault leaves a group alone', async (t) => {
  const { v, cloud, local, deleted } = await groupSetup(t);
  v.put(`${local}/Groceries.cloud-conflict-r1.md`, 'the other version');
  assert.deepEqual(await cloud.conflicts(), []);
  await cloud.syncNow();
  assert.equal(await deleted('notes/Groceries.md'), false);
});

test('shared groups: invited again after a removal, what was thrown away here comes back and stays for the others', async (t) => {
  const { v, cloud, eric, space, invite, deleted, local } = await groupSetup(t);
  const me = (await spaceDetails(eric, space.id)).members.find((member) => member.name === 'Ana');
  await removeMember(eric, space.id, me.accountId);
  await cloud.syncNow();
  assert.equal(cloud.spaceOf(`${local}/Groceries.md`).gone, true);
  v.files.delete(`${local}/Groceries.md`);
  await cloud.join(await invite(), 'Ana');
  assert.equal(await deleted('notes/Groceries.md'), false);
  assert.ok(v.files.has(`${local}/Groceries.md`));
  assert.equal(cloud.spaceOf(`${local}/Groceries.md`).gone, false);
});

test('shared groups: with cloud sync off nothing moves into a group and a link is not used up', async (t) => {
  const { v, cloud, eric, space, invite } = await groupSetup(t);
  const link = await invite();
  await cloud.setEnabled(false);
  v.put('Mini Notes/Trip.md', 'Packing');
  await assert.rejects(cloud.share(v.plugin.app.vault.getAbstractFileByPath('Mini Notes/Trip.md'), null, 'Holiday', 'Ana'), /Turn on cloud sync/);
  assert.ok(v.files.has('Mini Notes/Trip.md'));
  assert.equal(cloud.spaces.some((item) => item.name === 'Holiday'), false);
  await assert.rejects(cloud.join(link, 'Ana'), /Turn on cloud sync/);
  assert.equal((await spaceDetails(eric, space.id)).invites.filter((item) => !item.claimed).length, 1);
});

test('shared groups: removing a group from this device goes through the trash', async (t) => {
  const { v, cloud, local } = await groupSetup(t);
  await cloud.release(cloud.spaces[0], false);
  assert.ok(!v.files.has(`${local}/Groceries.md`));
  assert.ok(v.trashed.some(([path]) => path === local));
});

test('shared groups: a note moved to the own notes takes its attachments along', async (t) => {
  const { v, cloud, local } = await groupSetup(t);
  await cloud.moveToMine(v.plugin.app.vault.getAbstractFileByPath(`${local}/Groceries.md`));
  assert.ok(v.files.has('Mini Notes/Groceries.md'));
  assert.equal(decode(v.files.get('Mini Notes/.attachments/photo.png')), 'photo bytes');
});

test('shared groups: a missing attachments folder removes nothing for the others', async (t) => {
  const { v, cloud, local, deleted } = await groupSetup(t);
  const adapter = v.plugin.app.vault.adapter;
  await adapter.rmdir(`${local}/attachments`, true);
  await cloud.syncNow();
  assert.equal(await deleted('attachments/photo.png'), false);
  assert.equal(decode(v.files.get(`${local}/attachments/photo.png`)), 'photo bytes');
});

test('shared groups: a group that does not sync says so in the status, and stops saying it once it works', async (t) => {
  const { cloud, space } = await groupSetup(t);
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = async (url, options) => (String(url).endsWith('/status') && JSON.stringify(options?.headers ?? {}).includes(space.id)
    ? new Response(JSON.stringify({ error: 'The owner has no storage left.' }), { status: 402, headers: { 'Content-Type': 'application/json' } })
    : real(url, options));
  await cloud.syncNow();
  assert.match(cloud.status, /"Family" did not sync/);
  globalThis.fetch = real;
  await cloud.syncNow();
  assert.doesNotMatch(cloud.status, /did not sync/);
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

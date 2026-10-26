// 5,000 files and about 300 MB through syncFolder and remoteFiles. Run by sync.test.mjs with --expose-gc,
// so memory can be measured after collecting garbage. Prints one JSON line with the numbers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { INLINE_BYTES } from './crypto.mjs';
import { copyName, hash, remoteFiles, syncFolder } from './sync.mjs';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const MiB = 1024 * 1024;

// A synthetic file carries its own recipe in its first line, so neither side has to keep 300 MB around.
const make = (recipe) => {
  const bytes = new Uint8Array(Number(recipe.split('#')[2])).fill(recipe.length);
  bytes.set(encoder.encode(`${recipe}\n`));
  return bytes;
};
// A request waits for the network; without that wait Node frees released buffers only later, which the peak would count.
const wire = () => new Promise((done) => setImmediate(done));
// The client decodes a small file from base64 into a buffer of exactly its size; `make` keeps a bigger one alive.
const exact = (bytes) => Uint8Array.fromBase64(bytes.toBase64());
const recipe = (bytes) => decoder.decode(bytes.subarray(0, bytes.indexOf(10)));

let peak = 0;
const measure = (done) => {
  if (done % 250) return;
  globalThis.gc();
  peak = Math.max(peak, process.memoryUsage().arrayBuffers);
};

function cloud() {
  const objects = new Map(), feed = [];
  const counts = { reads: 0 }, fingerprints = new Map();
  const change = (object) => { objects.set(object.path, object); feed.push({ id: object.path, revision: object.revision }); };
  const client = {
    async listChanges(after) {
      const changes = feed.slice(after, after + 500);
      return { changes, cursor: after + changes.length, hasMore: after + 500 < feed.length };
    },
    // Like CloudClient: the manifest carries the fingerprint, saved with the file as the server saves the manifest,
    // and small files inside it.
    async readManifest(id) {
      await wire();
      counts.reads++;
      const object = objects.get(id), size = Number(object.recipe.split('#')[2]);
      return { revision: object.revision, deleted: object.deleted, manifest: { path: object.path, size, hash: fingerprints.get(object.recipe), bytes: size <= INLINE_BYTES ? exact(make(object.recipe)) : undefined } };
    },
    async readPieces(id, manifest) { if (!manifest.bytes) await wire(); return manifest.bytes ?? exact(make(objects.get(id).recipe)); },
  };
  const remote = (state, stop = () => {}) => ({
    list: () => remoteFiles(client, state.index, { checkActive: stop, save: async () => { state.saved.index = structuredClone(state.index); }, progress: measure }),
    // Like the plugin: what this device wrote goes into its index, so the feed does not bring it back.
    async write(path, bytes, baseRevision) {
      assert.equal(objects.get(path)?.revision ?? 0, baseRevision);
      change({ path, revision: baseRevision + 1, deleted: false, recipe: recipe(bytes) });
      fingerprints.set(recipe(bytes), createHash('sha256').update(bytes).digest('hex'));
      return state.index.objects[path] = { path, revision: baseRevision + 1, deleted: false, hash: await hash(bytes) };
    },
    async delete(path, baseRevision) {
      const object = objects.get(path);
      assert.equal(object.revision, baseRevision);
      change({ ...object, revision: baseRevision + 1, deleted: true });
      return state.index.objects[path] = { path, revision: baseRevision + 1, deleted: true, hash: state.index.objects[path].hash };
    },
  });
  return { counts, remote };
}

function folder() {
  const files = new Map(), times = new Map();
  let clock = 0;
  const set = (path, value) => { files.set(path, value); times.set(path, ++clock); };
  const local = {
    reads: 0,
    async list() { return new Map([...files].filter(([path]) => !path.includes('.cloud-')).map(([path, value]) => [path, { size: Number(value.split('#')[2]), modified: times.get(path) }])); },
    async read(path) { local.reads++; return make(files.get(path)); },
    async compareAndSet(path, expected, replacement) {
      const actual = files.get(path) ?? null;
      if ((actual === null) !== (expected === null) || (actual && recipe(expected) !== actual)) return false;
      if (replacement === null) files.delete(path); else set(path, recipe(replacement));
      return true;
    },
    async conflict(path, revision, bytes) { set(copyName(path, `.cloud-conflict-r${revision}`), recipe(bytes)); },
  };
  return { files, set, local };
}

// One device with what it last saved, so a restart can go on from exactly that.
function device(network) {
  const { files, set, local } = folder();
  const state = { tracked: {}, seen: {}, index: { cursor: 0, objects: {} }, saved: {} };
  const sync = (stop) => syncFolder(network.remote(state, stop), local, state.tracked, async (next) => { state.saved.tracked = structuredClone(next); state.saved.seen = structuredClone(state.seen); }, { checkActive: stop, seen: state.seen, progress: measure });
  const restart = () => {
    state.tracked = structuredClone(state.saved.tracked ?? {});
    state.seen = structuredClone(state.saved.seen ?? {});
    state.index = structuredClone(state.saved.index ?? { cursor: 0, objects: {} });
  };
  return { files, set, local, state, sync, restart };
}

globalThis.gc();
const baseline = process.memoryUsage().arrayBuffers;
const started = Date.now();
const network = cloud();
const a = device(network), b = device(network);
let total = 0;
for (let n = 0; n < 4500; n++) { a.set(`notes/Folder ${n % 30}/Note ${n}.md`, `notes/${n}#1#2048`); total += 2048; }
for (let n = 0; n < 500; n++) {
  const size = n < 10 ? 4 * MiB : 520 * 1024;
  a.set(`attachments/photo-${n}.jpg`, `attachments/${n}#1#${size}`);
  total += size;
}
assert.ok(total > 290 * MiB);

assert.deepEqual(await a.sync(), { uploaded: 5000, downloaded: 0, deleted: 0, conflicts: 0, skipped: [] });
const uploadPeak = peak;
assert.ok(uploadPeak - baseline < 64 * MiB, `${uploadPeak} bytes in memory while uploading`);
a.local.reads = 0;
network.counts.reads = 0;
assert.deepEqual(await a.sync(), { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, skipped: [] });
assert.equal(a.local.reads, 0, 'A quiet sync reads no local file');
assert.equal(network.counts.reads, 0, 'A quiet sync downloads nothing');

// A new device, cut off twice: once while it learns the cloud, once while it downloads. Each time it goes on
// from what it saved, as after closing the app.
let writes = 0;
const cut = (when) => () => { if (when()) throw new Error('Cut off'); };
peak = 0;
await assert.rejects(b.sync(cut(() => network.counts.reads >= 2000)), /Cut off/);
b.restart();
const learned = Object.keys(b.state.index.objects).length;
assert.ok(learned >= 1000, 'Files learned before the cut-off are kept');
network.counts.reads = 0;
const casBefore = b.local.compareAndSet;
b.local.compareAndSet = async (...args) => { const done = await casBefore(...args); if (done) writes++; return done; };
await assert.rejects(b.sync(cut(() => writes >= 1500)), /Cut off/);
b.restart();
const listingAfterCut = network.counts.reads;
assert.ok(listingAfterCut - writes <= 5000 - learned + 1, 'A resumed listing reads only the files it had not learned');
const resumed = await b.sync();
assert.equal(resumed.uploaded, 0);
assert.equal(resumed.conflicts, 0);
assert.equal(writes, 5000, 'Every file arrives exactly once');
assert.deepEqual(new Map([...b.files].sort()), new Map([...a.files].sort()));
const downloadPeak = peak;
assert.ok(downloadPeak - baseline < 64 * MiB, `${downloadPeak} bytes in memory while downloading`);

// Downloaded files are read once more to learn their time; after that a quiet sync reads nothing.
await b.sync();
b.local.reads = 0;
network.counts.reads = 0;
assert.deepEqual(await b.sync(), { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, skipped: [] });
assert.equal(b.local.reads, 0);
assert.equal(network.counts.reads, 0);

// Small changes stay small: 10 edits and 5 deletions read about 10 files.
for (let n = 0; n < 10; n++) a.set(`notes/Folder ${n % 30}/Note ${n}.md`, `notes/${n}#2#2100`);
for (let n = 10; n < 15; n++) a.files.delete(`notes/Folder ${n % 30}/Note ${n}.md`);
a.local.reads = 0;
assert.deepEqual(await a.sync(), { uploaded: 10, downloaded: 0, deleted: 5, conflicts: 0, skipped: [] });
assert.equal(a.local.reads, 10);
network.counts.reads = 0;
assert.deepEqual(await b.sync(), { uploaded: 0, downloaded: 10, deleted: 5, conflicts: 0, skipped: [] });
assert.ok(network.counts.reads <= 15, `${network.counts.reads} cloud reads for 15 changes`);

console.log(JSON.stringify({ files: 5000, mib: Math.round(total / MiB), baselineMiB: Math.round(baseline / MiB), uploadPeakMiB: Math.round(uploadPeak / MiB), downloadPeakMiB: Math.round(downloadPeak / MiB), seconds: Math.round((Date.now() - started) / 1000) }));

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CloudClient } from '../../shared/client.mjs';
import { Mirror } from './mirror.mjs';
import { profilePaths } from './store.mjs';
import { cloudFixture } from './test-fixture.mjs';

const SPACE = 'notes/Shared/0b7c3a52-4a2e-4f43-9a51-2f1f3c4d5e6f/Space note.md';

async function setup(t) {
  const cloud = await cloudFixture(t);
  const client = await CloudClient.claim({ pairingCode: await cloud.pairingCode() });
  const cachePath = profilePaths(cloud.home, 'default').cache;
  return { cloud, client, cachePath, mirror: new Mirror({ client, cachePath }) };
}
const ids = (mirror) => mirror.notes().map((note) => note.id).sort();

test('the mirror follows what another device does: new, changed, deleted, trash, archive', async (t) => {
  const { cloud, mirror } = await setup(t);
  await cloud.write('notes/2026-11-09 101500 Boodschappen.md', '---\njotdrop_labels: ["Thuis"]\ncolor: "yellow"\n---\n# Boodschappen\n\n- [ ] melk');
  await cloud.write('notes/Old idea.md', 'Just text, no heading');
  await cloud.write('notes/Archive/Ketel.md', '# Ketel\n\nDe ketel is van 2019.');
  await cloud.write('notes/Trash/Weg.md', '# Weg');
  await cloud.write(SPACE, '# Space note');
  await cloud.write('attachments/photo.png', 'not really a png');
  await cloud.write('notes/Gone.md', '# Gone');
  await cloud.remove('notes/Gone.md');
  const first = await mirror.refresh();
  assert.ok(first.changed > 0);
  assert.deepEqual(ids(mirror), ['notes/2026-11-09 101500 Boodschappen.md', 'notes/Archive/Ketel.md', 'notes/Old idea.md']);
  const list = mirror.get('notes/2026-11-09 101500 Boodschappen.md');
  assert.equal(list.title, 'Boodschappen');
  assert.equal(list.body, '- [ ] melk');
  assert.deepEqual(list.labels, ['Thuis']);
  assert.equal(list.color, 'yellow');
  assert.equal(list.archived, false);
  assert.ok(Number.isFinite(Date.parse(list.updatedAt)));
  assert.equal(list.revision, 1);
  assert.equal(mirror.get('notes/Old idea.md').title, 'Old idea');
  assert.equal(mirror.get('notes/Archive/Ketel.md').archived, true);
  // Paths the vault already uses, so a new note does not take one of them.
  assert.ok(mirror.knownPaths().has('notes/Gone.md'));
  assert.ok(mirror.knownPaths().has('notes/Trash/Weg.md'));

  // A second refresh with nothing new reads nothing.
  assert.equal((await mirror.refresh()).changed, 0);

  await cloud.write('notes/2026-11-09 101500 Boodschappen.md', '---\njotdrop_labels: ["Thuis"]\ncolor: "yellow"\n---\n# Boodschappen\n\n- [ ] melk\n- [ ] brood');
  await cloud.remove('notes/Old idea.md');
  await cloud.write('notes/Trash/Ketel.md', '# Ketel\n\nDe ketel is van 2019.');
  await cloud.remove('notes/Archive/Ketel.md');
  await cloud.write('notes/Nieuw.md', '# Nieuw');
  assert.equal((await mirror.refresh()).changed, 5);
  assert.deepEqual(ids(mirror), ['notes/2026-11-09 101500 Boodschappen.md', 'notes/Nieuw.md']);
  assert.equal(mirror.get('notes/2026-11-09 101500 Boodschappen.md').body, '- [ ] melk\n- [ ] brood');
  assert.equal(mirror.get('notes/2026-11-09 101500 Boodschappen.md').revision, 2);
  assert.equal(mirror.get('notes/Old idea.md'), undefined);
});

test('the cache on disk is sealed under the vault key: no title, text or path in it', async (t) => {
  const { cloud, client, cachePath, mirror } = await setup(t);
  await cloud.write('notes/2026-11-09 101500 Kerstcadeaus.md', '# Kerstcadeaus\n\nEen fiets voor Anna, geheim.');
  await mirror.refresh();
  const raw = await readFile(cachePath, 'utf8');
  for (const plain of ['Kerstcadeaus', 'fiets voor Anna', 'notes/', client.credentials.vaultKey, client.credentials.token]) assert.ok(!raw.includes(plain), plain);
  if (process.platform !== 'win32') assert.equal((await stat(cachePath)).mode & 0o777, 0o600);

  // A new process starts from the cache, without asking the cloud for every note again.
  let requests = 0;
  const counting = new CloudClient({ ...client.credentials, fetcher: (...args) => { requests++; return fetch(...args); } });
  const again = new Mirror({ client: counting, cachePath });
  assert.equal(await again.load(), true);
  assert.equal(requests, 0);
  assert.deepEqual(again.notes(), mirror.notes());
  assert.equal(again.lastSync, mirror.lastSync);
  assert.equal((await again.refresh()).changed, 0);
  assert.equal(requests, 1);
});

test('a cache that is damaged, or sealed for another vault, is ignored and rebuilt', async (t) => {
  const { cloud, client, cachePath, mirror } = await setup(t);
  await cloud.write('notes/a.md', '# A');
  await mirror.refresh();
  const other = await setup(t);
  await mkdir(dirname(other.cachePath), { recursive: true });
  await writeFile(other.cachePath, await readFile(cachePath));
  const foreign = new Mirror({ client: other.client, cachePath: other.cachePath });
  assert.equal(await foreign.load(), false);
  assert.deepEqual(foreign.notes(), []);
  await writeFile(cachePath, '{"v":1,"envelope":');
  const broken = new Mirror({ client, cachePath });
  assert.equal(await broken.load(), false);
  await broken.refresh();
  assert.deepEqual(ids(broken), ['notes/a.md']);
});

test('forget clears the notes in memory and the cache file', async (t) => {
  const { cloud, cachePath, mirror } = await setup(t);
  await cloud.write('notes/a.md', '# A');
  await mirror.refresh();
  await mirror.forget();
  assert.deepEqual(mirror.notes(), []);
  await assert.rejects(stat(cachePath), { code: 'ENOENT' });
});

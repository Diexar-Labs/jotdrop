import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { connect, disconnect, openSession, status } from './connect.mjs';
import { loadProfile, profilePaths } from './store.mjs';
import { VERSION } from './version.mjs';
import { cloudFixture } from './test-fixture.mjs';

test('a pairing code from the app connects jotdrop-mcp as its own device, with the name chosen in the app', async (t) => {
  const cloud = await cloudFixture(t);
  await cloud.write('notes/2026-11-09 101500 Boodschappen.md', '# Boodschappen\n\n- [ ] melk');
  const code = await cloud.pairingCode('Claude op mijn pc');
  const result = await connect({ pairingCode: `  ${code.slice(0, 20)}\n${code.slice(20)} `, home: cloud.home });
  assert.deepEqual({ ...result, url: undefined }, { profile: 'default', deviceName: 'Claude op mijn pc', url: undefined, notes: 1 });
  assert.equal(result.url, cloud.url);
  const saved = await loadProfile(cloud.home, 'default');
  assert.equal(saved.deviceName, 'Claude op mijn pc');
  assert.equal(saved.url, cloud.url);
  // The phone sees the new device, and which app and version it runs.
  const { devices } = await cloud.phone.devices();
  const device = devices.find((entry) => entry.id === saved.deviceId);
  assert.equal(device.name, 'Claude op mijn pc');
  assert.equal(device.revoked, false);
  const db = new DatabaseSync(cloud.app.dbPath, { readOnly: true });
  try { assert.deepEqual({ ...db.prepare('SELECT app,appVersion FROM devices WHERE id=?').get(saved.deviceId) }, { app: 'mcp', appVersion: VERSION }); }
  finally { db.close(); }
  // The result names no key, token or code.
  for (const secret of [saved.token, saved.vaultKey, code]) assert.ok(!JSON.stringify(result).includes(secret));
});

test('a used, expired or wrong pairing code gives an answer a person can act on', async (t) => {
  let now = Date.now();
  const cloud = await cloudFixture(t, { clock: () => now });
  const code = await cloud.pairingCode();
  await connect({ pairingCode: code, home: cloud.home, profile: 'first' });
  await assert.rejects(connect({ pairingCode: code, home: cloud.home, profile: 'second' }), /already used/i);
  const late = await cloud.pairingCode();
  now += 11 * 60 * 1000;
  await assert.rejects(connect({ pairingCode: late, home: cloud.home, profile: 'second' }), /expired/i);
  await assert.rejects(connect({ pairingCode: 'not a code', home: cloud.home, profile: 'second' }), /not a JotDrop pairing code/i);
  // Nothing was saved for the failed attempts.
  assert.equal(await loadProfile(cloud.home, 'second'), null);
});

test('a profile that is already connected is not overwritten', async (t) => {
  const cloud = await cloudFixture(t);
  await connect({ pairingCode: await cloud.pairingCode(), home: cloud.home });
  const before = await loadProfile(cloud.home, 'default');
  await assert.rejects(connect({ pairingCode: await cloud.pairingCode(), home: cloud.home }), /already connected.*disconnect/i);
  assert.deepEqual(await loadProfile(cloud.home, 'default'), before);
});

test('the device limit of the free plan is explained, not shown as a bare 403', async (t) => {
  const cloud = await cloudFixture(t, { freeDeviceLimit: 2 });
  const first = await cloud.pairingCode('Laptop'), second = await cloud.pairingCode('Claude op mijn pc');
  await connect({ pairingCode: first, home: cloud.home, profile: 'laptop' });
  await assert.rejects(connect({ pairingCode: second, home: cloud.home }), (error) => /free plan/i.test(error.message) && /Connected devices/.test(error.message) && error.code === 'device-limit');
});

test('status shows the device, the notes and the plan, never the key', async (t) => {
  const cloud = await cloudFixture(t);
  assert.deepEqual(await status({ home: cloud.home }), { connected: false, profile: 'default' });
  await cloud.write('notes/a.md', '# A');
  await connect({ pairingCode: await cloud.pairingCode('Matěj'), home: cloud.home });
  const shown = await status({ home: cloud.home });
  assert.equal(shown.connected, true);
  assert.equal(shown.deviceName, 'Matěj');
  assert.equal(shown.notes, 1);
  assert.equal(shown.plan, 'free');
  assert.equal(shown.reachable, true);
  assert.ok(Number.isFinite(Date.parse(shown.lastSync)));
  const saved = await loadProfile(cloud.home, 'default');
  assert.ok(!JSON.stringify(shown).includes(saved.token) && !JSON.stringify(shown).includes(saved.vaultKey));
});

test('disconnect removes the device in the cloud and every file of the profile', async (t) => {
  const cloud = await cloudFixture(t);
  await connect({ pairingCode: await cloud.pairingCode(), home: cloud.home });
  const saved = await loadProfile(cloud.home, 'default');
  const result = await disconnect({ home: cloud.home });
  assert.equal(result.revoked, true);
  assert.equal((await cloud.phone.devices()).devices.find((device) => device.id === saved.deviceId).revoked, true);
  for (const path of Object.values(profilePaths(cloud.home, 'default'))) await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.deepEqual(await disconnect({ home: cloud.home }), { connected: false, revoked: false, message: 'This profile is not connected.' });
});

test('when the cloud cannot remove the device, disconnect still clears this computer and says what to do', async (t) => {
  const cloud = await cloudFixture(t);
  await connect({ pairingCode: await cloud.pairingCode(), home: cloud.home });
  const result = await disconnect({ home: cloud.home, fetcher: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(result.revoked, false);
  assert.match(result.message, /Connected devices/);
  assert.equal(await loadProfile(cloud.home, 'default'), null);
});

test('a session opens from the saved profile; a device removed in the app gets a clear answer', async (t) => {
  const cloud = await cloudFixture(t);
  await cloud.write('notes/a.md', '# A\n\nhello');
  await connect({ pairingCode: await cloud.pairingCode(), home: cloud.home });
  const session = await openSession({ home: cloud.home });
  const found = await session.notes.call('search_notes', { query: 'hello' });
  assert.equal(found.isError, false);
  const saved = await loadProfile(cloud.home, 'default');
  await cloud.phone.revokeDevice(saved.deviceId);
  const refused = await session.notes.call('search_notes', { query: 'hello' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /no longer accepts this connection/i);
  assert.match(refused.text, /connect/);
  // What was cached on this computer is cleared once the cloud says the device is gone.
  await assert.rejects(stat(profilePaths(cloud.home, 'default').cache), { code: 'ENOENT' });
  await assert.rejects(openSession({ home: cloud.home, profile: 'other' }), /not connected.*connect/i);
});

test('no console logging anywhere in cloud/mcp: stdout belongs to the protocol', async () => {
  const root = new URL('../', import.meta.url), pattern = new RegExp(['console', 'log'].join('\\.'));
  const walk = async (dir) => (await Promise.all((await readdir(dir, { withFileTypes: true })).filter((entry) => entry.name !== 'node_modules').map((entry) => entry.isDirectory() ? walk(new URL(`${entry.name}/`, dir)) : [new URL(entry.name, dir)]))).flat();
  const files = (await walk(root)).filter((file) => /\.(mjs|js|cjs)$/.test(file.pathname));
  assert.ok(files.length >= 6);
  for (const file of files) assert.ok(!pattern.test(await readFile(file, 'utf8')), file.pathname);
});

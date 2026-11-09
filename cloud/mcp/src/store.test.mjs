import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomToken } from '../../shared/crypto.mjs';
import { httpToken, loadProfile, mcpHome, profileName, profilePaths, removeProfile, saveProfile } from './store.mjs';

const credentials = () => ({ url: 'https://app.jotdrop.net', vaultId: crypto.randomUUID(), deviceId: crypto.randomUUID(), token: randomToken(), vaultKey: randomToken(), deviceName: 'Claude op mijn pc', connectedAt: '2026-11-09T10:00:00.000Z' });

async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'jotdrop-mcp-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, '.jotdrop-mcp');
}

test('the home folder is ~/.jotdrop-mcp unless JOTDROP_MCP_HOME moves it', () => {
  assert.equal(mcpHome({}), join(homedir(), '.jotdrop-mcp'));
  assert.equal(mcpHome({ JOTDROP_MCP_HOME: '/data' }), '/data');
});

test('profile names are short, lower case and safe as file names', () => {
  assert.equal(profileName(), 'default');
  assert.equal(profileName('katharina'), 'katharina');
  for (const bad of ['', 'Katharina', '../x', 'a/b', 'x'.repeat(41), '.hidden', 'con\u0000']) assert.throws(() => profileName(bad), /profile/i, bad);
});

test('a profile is saved whole, readable only by the user, and comes back the same', async (t) => {
  const dir = await home(t), value = credentials();
  assert.equal(await loadProfile(dir, 'default'), null);
  await saveProfile(dir, 'default', value);
  assert.deepEqual(await loadProfile(dir, 'default'), { v: 1, ...value });
  const { config } = profilePaths(dir, 'default');
  if (process.platform !== 'win32') {
    assert.equal((await stat(config)).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  }
  // Written through a temporary file and a rename: nothing half-written stays behind.
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
  await saveProfile(dir, 'katharina', credentials());
  assert.notDeepEqual(await loadProfile(dir, 'katharina'), await loadProfile(dir, 'default'));
});

test('a damaged profile file gives an error that says what to do, without its contents', async (t) => {
  const dir = await home(t), value = credentials();
  await saveProfile(dir, 'default', value);
  const { config } = profilePaths(dir, 'default');
  await writeFile(config, JSON.stringify({ v: 1, ...value, token: 'short' }));
  await assert.rejects(loadProfile(dir, 'default'), (error) => /connect again/i.test(error.message) && !error.message.includes(value.vaultKey));
});

test('removing a profile removes its key, cache and HTTP token', async (t) => {
  const dir = await home(t);
  await saveProfile(dir, 'default', credentials());
  const paths = profilePaths(dir, 'default');
  await writeFile(paths.cache, '{}');
  const token = await httpToken(dir, 'default');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await httpToken(dir, 'default'), token);
  assert.equal(await readFile(paths.httpToken, 'utf8'), token);
  await removeProfile(dir, 'default');
  for (const path of Object.values(paths)) await assert.rejects(stat(path), { code: 'ENOENT' });
  await removeProfile(dir, 'default');
});

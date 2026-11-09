// The jotdrop-mcp command: connect, status, disconnect, help and version, and what a person reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { main } from '../src/cli.mjs';
import { profilePaths } from '../src/store.mjs';
import { cloudFixture } from '../src/test-fixture.mjs';
import { VERSION } from '../src/version.mjs';
import { run } from './helpers.mjs';

/** main() in this process, with its output captured. */
async function cli(argv, { env = {}, input = '', fetcher } = {}) {
  let stdout = '', stderr = '';
  const code = await main(argv, { env, fetcher, stdin: input, stdout: { write: (chunk) => { stdout += chunk; } }, stderr: { write: (chunk) => { stderr += chunk; } } });
  return { code, stdout, stderr };
}

test('connect with a pairing code says who is connected and how to add it to Claude and Cursor, never the key', async (t) => {
  const cloud = await cloudFixture(t);
  await cloud.write('notes/Lijst.md', '# Boodschappen');
  const code = await cloud.pairingCode('Claude op mijn pc');
  const result = await run(['connect', '--code', code], { home: cloud.home });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Connected as "Claude op mijn pc"\. 1 note\./);
  assert.match(result.stdout, /claude mcp add --transport stdio jotdrop -- npx -y jotdrop-mcp/);
  assert.match(result.stdout, /"jotdrop": \{ "command": "npx", "args": \["-y", "jotdrop-mcp"\] \}/);
  assert.match(result.stdout, /Cursor/);
  const saved = JSON.parse(await readFile(profilePaths(cloud.home, 'default').config, 'utf8'));
  for (const secret of [saved.token, saved.vaultKey, code]) assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
  // Once more: the profile is not overwritten.
  const again = await run(['connect', '--code', await cloud.pairingCode()], { home: cloud.home });
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already connected/);
});

test('connect reads the code from standard input, and a second profile gets its own name in the client setup', async (t) => {
  const cloud = await cloudFixture(t);
  const result = await run(['connect', '--profile', 'katharina'], { home: cloud.home, input: `${await cloud.pairingCode('Matěj')}\n` });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Connected as "Matěj"\. 0 notes\./);
  assert.match(result.stdout, /claude mcp add --transport stdio jotdrop-katharina -- npx -y jotdrop-mcp --profile katharina/);
});

test('connect --http makes the HTTP token file and names it, without printing the token', async (t) => {
  const cloud = await cloudFixture(t);
  const result = await run(['connect', '--http', '--code', await cloud.pairingCode()], { home: cloud.home });
  assert.equal(result.code, 0, result.stderr);
  const token = (await readFile(profilePaths(cloud.home, 'default').httpToken, 'utf8')).trim();
  assert.ok(!result.stdout.includes(token));
  assert.ok(result.stdout.includes(profilePaths(cloud.home, 'default').httpToken));
  assert.match(result.stdout, /jotdrop-mcp serve --http 127\.0\.0\.1:8765/);
});

test('when the first sync after pairing fails, connect says it is connected and what to do next', async (t) => {
  const cloud = await cloudFixture(t);
  const fetcher = (url, ...rest) => (String(url).includes('/changes') ? Promise.reject(new TypeError('fetch failed')) : fetch(url, ...rest));
  const result = await cli(['connect', '--code', await cloud.pairingCode('Claude op mijn pc')], { env: { JOTDROP_MCP_HOME: cloud.home }, fetcher });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Connected as "Claude op mijn pc", but the first sync with JotDrop Cloud failed\./);
  assert.match(result.stdout, /jotdrop-mcp status/);
});

test('a wrong pairing code gives the plain answer and exit code 1', async (t) => {
  const cloud = await cloudFixture(t);
  const result = await run(['connect', '--code', 'not-a-code'], { home: cloud.home });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not a JotDrop pairing code/);
});

test('status and disconnect, and serve without a connection', async (t) => {
  const cloud = await cloudFixture(t);
  const before = await run(['status'], { home: cloud.home });
  assert.equal(before.code, 1);
  assert.match(before.stdout + before.stderr, /not connected/i);
  const serve = await run(['serve'], { home: cloud.home });
  assert.equal(serve.code, 1);
  assert.match(serve.stderr, /not connected.*jotdrop-mcp connect/);
  assert.equal(serve.stdout, '', 'stdout belongs to the protocol');
  await run(['connect', '--code', await cloud.pairingCode('Claude op mijn pc')], { home: cloud.home });
  const status = await run(['status'], { home: cloud.home });
  assert.equal(status.code, 0, status.stderr);
  for (const line of [/Device: +Claude op mijn pc/, /Plan: +free/, /Notes: +0/, /Cloud: +reachable/, new RegExp(`Address: +${cloud.url.replace(/[.]/g, '\\.')}`)]) assert.match(status.stdout, line);
  const saved = JSON.parse(await readFile(profilePaths(cloud.home, 'default').config, 'utf8'));
  assert.ok(!status.stdout.includes(saved.token) && !status.stdout.includes(saved.vaultKey));
  const gone = await run(['disconnect'], { home: cloud.home });
  assert.equal(gone.code, 0, gone.stderr);
  assert.match(gone.stdout, /Disconnected "Claude op mijn pc"/);
  assert.equal((await cloud.phone.devices()).devices.find((device) => device.id === saved.deviceId).revoked, true);
});

test('--version, --help, and a wrong command', async () => {
  assert.equal((await cli(['--version'])).stdout.trim(), VERSION);
  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  for (const word of ['connect', 'serve', 'status', 'disconnect', '--http', '--tools', '--profile', '--allow-origin']) assert.ok(help.stdout.includes(word), word);
  const wrong = await cli(['delete-everything']);
  assert.equal(wrong.code, 2);
  assert.match(wrong.stderr, /Unknown command/);
  const tools = await cli(['serve', '--tools', 'search_notes,delete_note']);
  assert.equal(tools.code, 2);
  assert.match(tools.stderr, /delete_note/);
});

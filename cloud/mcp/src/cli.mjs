// The jotdrop-mcp command. Without a command it serves MCP over stdio, which is what Claude Desktop, Claude Code and
// Cursor start. Messages for a person go to stdout for connect, status and disconnect; while serving, stdout belongs
// to the protocol and everything else goes to stderr. Nothing here prints a key, a token or the text of a note.
import { parseArgs } from 'node:util';
import { connect, disconnect, openSession, status } from './connect.mjs';
import { createFactory, isLoopback, serveOverHttp, serveOverStdio, toolNames } from './server.mjs';
import { httpToken, loadProfile, mcpHome, profileName, profilePaths } from './store.mjs';
import { VERSION } from './version.mjs';

const HELP = `jotdrop-mcp ${VERSION}: your JotDrop notes for AI agents, over MCP.

  jotdrop-mcp connect [--code CODE] [--http] [--profile NAME]
      Connect to JotDrop with a pairing code. Make the code in JotDrop under
      Connected devices (Create pairing code); it works for 10 minutes.
      Without --code the code is read from standard input.
      --http also makes a token for "serve --http".

  jotdrop-mcp [serve] [--profile NAME] [--tools LIST]
      Serve MCP over stdio (what Claude Desktop, Claude Code and Cursor start).

  jotdrop-mcp serve --http HOST:PORT [--allow-origin LIST] [--tools LIST] [--profile NAME]
      Serve MCP over HTTP at http://HOST:PORT/mcp, for 127.0.0.1 or a private
      Docker network. Clients send "Authorization: Bearer <token>"; the token is
      JOTDROP_MCP_TOKEN, or the profile's http-token file. Never put this on the
      open internet. --allow-origin lists browser origins that may call it.

  jotdrop-mcp status [--profile NAME]
  jotdrop-mcp disconnect [--profile NAME]
      Show the connection, or remove this device from JotDrop and this computer.

  --tools LIST   comma-separated tools this agent gets (default: all), from
                 search_notes, read_note, list_labels, create_note,
                 append_to_note, replace_note_text, set_labels, set_reminder,
                 set_expiry
  --profile NAME a second JotDrop account on this computer (default: default)

Files: ${'~'}/.jotdrop-mcp (or JOTDROP_MCP_HOME). They hold the key to your notes:
use this only on a computer you trust like your phone.
`;

const usage = (message) => Object.assign(new Error(message), { usage: true });

function options(argv) {
  // `connect --http` is a switch; `serve --http HOST:PORT` takes an address.
  const args = argv[0] === 'connect' ? argv.map((arg) => (arg === '--http' ? '--http=on' : arg)) : argv;
  try {
    return parseArgs({ args, allowPositionals: true, strict: true, options: {
      code: { type: 'string' }, http: { type: 'string' }, profile: { type: 'string', default: 'default' }, tools: { type: 'string' },
      'allow-origin': { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    } });
  } catch (error) { throw usage(error.message); }
}

function address(value) {
  const match = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(value ?? '');
  if (!match || Number(match[2]) > 65535) throw usage('Use --http HOST:PORT, for example --http 127.0.0.1:8765.');
  return { host: match[1].replace(/^\[|\]$/g, ''), port: Number(match[2]) };
}

async function readCode(stdin) {
  if (typeof stdin === 'string') return stdin;
  let text = '';
  for await (const chunk of stdin) { text += chunk; if (text.includes('\n')) break; }
  return text;
}

function setup(profile) {
  const name = profile === 'default' ? 'jotdrop' : `jotdrop-${profile}`;
  const args = profile === 'default' ? ['-y', 'jotdrop-mcp'] : ['-y', 'jotdrop-mcp', '--profile', profile];
  return [
    'Add JotDrop to your AI app:',
    `  Claude Code:     claude mcp add --transport stdio ${name} -- npx ${args.join(' ')}`,
    `  Claude Desktop:  in claude_desktop_config.json, under "mcpServers":`,
    `                   "${name}": { "command": "npx", "args": [${args.map((arg) => `"${arg}"`).join(', ')}] }`,
    '  Cursor:          the same block in .cursor/mcp.json, under "mcpServers".',
    'Then restart the app and ask it, for example, to put milk on your shopping list.',
  ].join('\n');
}

async function runConnect(values, { env, stdin, stdout, stderr, fetcher }) {
  const home = mcpHome(env), profile = profileName(values.profile);
  let code = values.code;
  if (code === undefined) {
    if (stdin?.isTTY) stderr.write('Pairing code (from JotDrop, Connected devices): ');
    code = await readCode(stdin);
  }
  const result = await connect({ pairingCode: code, home, profile, fetcher });
  const notes = `${result.notes} note${result.notes === 1 ? '' : 's'}`;
  stdout.write(result.synced
    ? `Connected as "${result.deviceName}". ${notes}.\n\n`
    : `Connected as "${result.deviceName}", but the first sync with JotDrop Cloud failed. Run "jotdrop-mcp status${profile === 'default' ? '' : ` --profile ${profile}`}" to check the connection; the first tool call syncs again.\n\n`);
  if (values.http !== undefined) {
    await httpToken(home, profile);
    const path = profilePaths(home, profile).httpToken;
    stdout.write(`HTTP token saved in ${path} (keep it secret).\nStart with: jotdrop-mcp serve --http 127.0.0.1:8765${profile === 'default' ? '' : ` --profile ${profile}`}\nClients send "Authorization: Bearer <the token in that file>".\n\n`);
  }
  stdout.write(`${setup(profile)}\n`);
  return 0;
}

async function runStatus(values, { env, stdout, fetcher }) {
  const result = await status({ home: mcpHome(env), profile: profileName(values.profile), fetcher });
  if (!result.connected) { stdout.write(`Profile "${result.profile}" is not connected. Run "jotdrop-mcp connect" with a pairing code from JotDrop.\n`); return 1; }
  const cloud = result.revoked ? 'removed: this device no longer has access (connect again with a new pairing code)' : result.reachable ? 'reachable' : 'not reachable now';
  stdout.write([
    `Profile:   ${result.profile}`, `Device:    ${result.deviceName}`, `Address:   ${result.url}`, `Connected: ${result.connectedAt}`,
    `Plan:      ${result.plan ?? 'unknown'}`, `Notes:     ${result.notes}`, `Last sync: ${result.lastSync ?? 'not yet'}`, `Cloud:     ${cloud}`,
  ].join('\n') + '\n');
  return result.revoked ? 1 : 0;
}

async function runServe(values, { env, stderr, fetcher }) {
  const tools = toolNames(values.tools);
  const http = values.http !== undefined ? address(values.http) : null;
  const allowOrigins = (values['allow-origin'] ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
  const home = mcpHome(env), profile = profileName(values.profile);
  const log = (line) => stderr.write(`jotdrop-mcp: ${line}\n`);
  const session = await openSession({ home, profile, fetcher });
  const factory = createFactory({ notes: session.notes, tools });
  if (!http) {
    log(`serving profile "${profile}" (${session.deviceName}) over stdio`);
    await serveOverStdio(factory, { log });
    // The client closed stdin: stop, even when an idle connection to the cloud would keep Node running a while.
    setTimeout(() => process.exit(0), 500).unref();
    return 0;
  }
  let token = env.JOTDROP_MCP_TOKEN;
  if (token === undefined || token === '') {
    token = await httpToken(home, profile);
    log(`HTTP token from ${profilePaths(home, profile).httpToken}`);
  } else if (token.length < 32) throw usage('JOTDROP_MCP_TOKEN must be at least 32 characters; make one with: openssl rand -base64 32');
  if (!isLoopback(http.host)) log(`warning: listening on ${http.host}, not on 127.0.0.1. Keep this port on a private network (Docker), never on the open internet.`);
  const served = await serveOverHttp(factory, { ...http, token, allowOrigins, log });
  log(`serving profile "${profile}" (${session.deviceName}) on ${served.url}`);
  await new Promise((resolve) => { for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, resolve); });
  await served.close();
  return 0;
}

/** Runs one command; returns the exit code (0 fine, 1 failed, 2 wrong use). */
export async function main(argv, { env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, fetcher } = {}) {
  const io = { env, stdin, stdout, stderr, fetcher };
  try {
    const { values, positionals } = options(argv);
    if (values.version) { stdout.write(`${VERSION}\n`); return 0; }
    if (values.help) { stdout.write(HELP); return 0; }
    const [command = 'serve', ...rest] = positionals;
    if (rest.length) throw usage(`Unexpected "${rest[0]}". See jotdrop-mcp --help.`);
    if (command === 'connect') return await runConnect(values, io);
    if (command === 'serve') return await runServe(values, io);
    if (command === 'status') return await runStatus(values, io);
    if (command === 'disconnect') {
      const profile = profileName(values.profile), home = mcpHome(env);
      if (!(await loadProfile(home, profile))) { stdout.write(`Profile "${profile}" is not connected.\n`); return 1; }
      stdout.write(`${(await disconnect({ home, profile, fetcher })).message}\n`);
      return 0;
    }
    throw usage(`Unknown command "${command}". See jotdrop-mcp --help.`);
  } catch (error) {
    stderr.write(`jotdrop-mcp: ${error?.message ?? error}\n`);
    return error?.usage ? 2 : 1;
  }
}

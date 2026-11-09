// For the SDK tests: an in-process JotDrop Cloud with a connected jotdrop-mcp profile, and a jotdrop-mcp process.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect } from '../src/connect.mjs';
import { cloudFixture } from '../src/test-fixture.mjs';

export const CLI = fileURLToPath(new URL('../src/bin.mjs', import.meta.url));
export const BUNDLE = fileURLToPath(new URL('../dist/jotdrop-mcp.mjs', import.meta.url));

/** A cloud with two notes and a connected profile `default` in `cloud.home`. */
export async function connected(t, notes = { 'notes/Lijst.md': '---\njotdrop_labels: ["Thuis"]\n---\n# Boodschappen\n\n- [ ] melk', 'notes/Ketel.md': '# Ketel\n\nDe ketel is van 2019.' }) {
  const cloud = await cloudFixture(t);
  for (const [path, text] of Object.entries(notes)) await cloud.write(path, text);
  await connect({ pairingCode: await cloud.pairingCode('Claude op mijn pc'), home: cloud.home });
  return cloud;
}

/** Starts `jotdrop-mcp <args>`; resolves once stderr shows `ready` (a RegExp), with what it matched. */
export function start(t, args, { home, env = {}, ready = /serving/, file = CLI } = {}) {
  const child = spawn(process.execPath, [file, ...args], { env: { ...process.env, JOTDROP_MCP_HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill(); });
  let stderr = '', stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`jotdrop-mcp did not start: ${stderr}`)), 15000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = ready.exec(stderr);
      if (match) { clearTimeout(timer); resolve({ child, match, output: () => ({ stdout, stderr }) }); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`jotdrop-mcp exited with ${code}: ${stderr}`)); });
  });
}

/** Runs `jotdrop-mcp <args>` to the end; returns its exit code and output. */
export function run(args, { home, env = {}, input, file = CLI } = {}) {
  const child = spawn(process.execPath, [file, ...args], { env: { ...process.env, JOTDROP_MCP_HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(input ?? '');
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
}

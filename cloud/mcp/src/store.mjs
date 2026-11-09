// Where jotdrop-mcp keeps a connection: ~/.jotdrop-mcp/<profile>.json (or JOTDROP_MCP_HOME), readable only by the
// user. It holds the vault key, so this computer must be trusted like the phone with the app. Next to it the sealed
// note cache (<profile>.cache.json) and, for HTTP, the token (<profile>.http-token). Nothing here logs or prints
// the contents of these files.
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CloudClient } from '../../shared/client.mjs';
import { randomToken } from '../../shared/crypto.mjs';

export const mcpHome = (env = process.env) => env.JOTDROP_MCP_HOME || join(homedir(), '.jotdrop-mcp');

/** A profile name: lower case letters, digits, - and _, up to 40 characters. Lower case, because Windows and macOS ignore case in file names. */
export function profileName(value = 'default') {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(value)) throw new Error('Use a profile name of 1 to 40 lower-case letters, digits, - or _.');
  return value;
}

export function profilePaths(home, profile) {
  const name = profileName(profile);
  return { config: join(home, `${name}.json`), cache: join(home, `${name}.cache.json`), httpToken: join(home, `${name}.http-token`) };
}

/** Writes a file only the user can read, through a temporary file and a rename, so a cut-off write leaves the old one. */
export async function writePrivate(home, path, text) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  // mkdir keeps the mode of a folder that already exists; this one only ever holds private files.
  if (process.platform !== 'win32') await chmod(home, 0o700);
  const temporary = `${path}.${randomToken().slice(0, 12)}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

const damaged = () => new Error('The saved JotDrop connection on this computer is damaged. Run "jotdrop-mcp disconnect", then connect again with a new pairing code.');

/** The saved connection, or null when this profile is not connected. */
export async function loadProfile(home, profile) {
  let text;
  try { text = await readFile(profilePaths(home, profile).config, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let value;
  try { value = JSON.parse(text); } catch { throw damaged(); }
  if (value?.v !== 1 || typeof value.deviceName !== 'string' || typeof value.connectedAt !== 'string') throw damaged();
  // The client checks the address, the ids and the length of both keys.
  try { new CloudClient(value); } catch { throw damaged(); }
  const { url, vaultId, deviceId, token, vaultKey, deviceName, connectedAt } = value;
  return { v: 1, url, vaultId, deviceId, token, vaultKey, deviceName, connectedAt };
}

export async function saveProfile(home, profile, { url, vaultId, deviceId, token, vaultKey, deviceName, connectedAt }) {
  await writePrivate(home, profilePaths(home, profile).config, `${JSON.stringify({ v: 1, url, vaultId, deviceId, token, vaultKey, deviceName, connectedAt }, null, 2)}\n`);
}

/** Every file of the profile goes: the key, the cache and the HTTP token. */
export async function removeProfile(home, profile) {
  for (const path of Object.values(profilePaths(home, profile))) await rm(path, { force: true });
}

/** The token an HTTP client must send, made once per profile. */
export async function httpToken(home, profile) {
  const path = profilePaths(home, profile).httpToken;
  try {
    const saved = (await readFile(path, 'utf8')).trim();
    if (/^[A-Za-z0-9_-]{43}$/.test(saved)) return saved;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const token = randomToken();
  await writePrivate(home, path, token);
  return token;
}

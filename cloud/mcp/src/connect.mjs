// Connecting jotdrop-mcp to a JotDrop Cloud account, like the Joplin plugin: the user makes a pairing code in the
// app (Connected devices), and claiming it adds this program as a device with the name the user chose. The code
// carries the vault key wrapped for this claim only; the server cannot read it. No password, no e-mail code and
// never the recovery code.
import { CloudClient, identifyClient } from '../../shared/client.mjs';
import { base64ToBytes } from '../../shared/crypto.mjs';
import { redact } from '../../shared/ai/redact.mjs';
import { Mirror } from './mirror.mjs';
import { createNotes } from './notes.mjs';
import { loadProfile, mcpHome, profileName, profilePaths, removeProfile, saveProfile } from './store.mjs';
import { VERSION } from './version.mjs';

const flag = (profile) => (profile === 'default' ? '' : ` --profile ${profile}`);
const offline = (error) => error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error?.name);

function claimError(error, code) {
  const say = (message) => Object.assign(new Error(message), error?.code ? { code: error.code } : {});
  const again = 'Make a new pairing code in JotDrop (Connected devices) and try again.';
  if (error?.code === 'device-limit') {
    const count = error.devices?.length;
    return say(`Your free plan already has ${count ? `${count} device${count === 1 ? '' : 's'}` : 'its devices'}, and this program counts as one. Sign out a device under Connected devices in JotDrop, or try JotDrop Plus, then make a new pairing code.`);
  }
  if (error?.code === 'plus-required') return say('JotDrop MCP needs JotDrop Plus. Upgrade at jotdrop.net, then make a new pairing code.');
  if (error?.status === 409) return say(`This pairing code was already used. ${again}`);
  if (error?.status === 410) return say(`This pairing code expired; a code works for 10 minutes. ${again}`);
  if (error?.status === 401) return say(`JotDrop did not accept this pairing code. ${again}`);
  if (offline(error)) return say('Cannot reach JotDrop Cloud. Check the internet connection and try again within the 10 minutes of the code.');
  if (error?.status === undefined) return say('This is not a JotDrop pairing code. Copy it again from JotDrop (Connected devices).');
  return say(`JotDrop Cloud refused the pairing code: ${redact(error.message, [code]).slice(0, 200)}`);
}

/** The outer form of a pairing code (base64 of JSON with v 1 and an address), checked before anything goes out. */
function looksLikeCode(code) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64ToBytes(code)));
    return value?.v === 1 && typeof value.url === 'string';
  } catch { return false; }
}

const clientFor = (saved, fetcher) => new CloudClient({ ...saved, ...(fetcher ? { fetcher } : {}) });

/** Claims a pairing code and saves the connection as `profile`. Returns what to tell the user; never a key. */
export async function connect({ pairingCode, home = mcpHome(), profile = 'default', fetcher } = {}) {
  const name = profileName(profile);
  if (await loadProfile(home, name)) throw new Error(`Profile "${name}" is already connected. Run "jotdrop-mcp disconnect${flag(name)}" first, or connect another profile with --profile.`);
  identifyClient('mcp', VERSION);
  const code = String(pairingCode ?? '').replace(/\s+/g, '');
  if (!looksLikeCode(code)) throw claimError(undefined, code);
  let client;
  try { client = await CloudClient.claim({ pairingCode: code, ...(fetcher ? { fetcher } : {}) }); }
  catch (error) { throw claimError(error, code); }
  let deviceName = 'JotDrop MCP';
  try { deviceName = (await client.devices()).devices.find((device) => device.id === client.credentials.deviceId)?.name ?? deviceName; }
  catch { /* The name is only for status; the connection works without it. */ }
  // Saved before anything else can fail, so the new device is never left without its key on this computer.
  await saveProfile(home, name, { ...client.credentials, deviceName, connectedAt: new Date().toISOString() });
  const mirror = new Mirror({ client, cachePath: profilePaths(home, name).cache });
  await mirror.refresh();
  return { profile: name, deviceName, url: client.credentials.url, notes: mirror.notes().length };
}

/** The connected device, its notes and plan, and whether the cloud answers. Never the key or token. */
export async function status({ home = mcpHome(), profile = 'default', fetcher } = {}) {
  const name = profileName(profile), saved = await loadProfile(home, name);
  if (!saved) return { connected: false, profile: name };
  identifyClient('mcp', VERSION);
  const client = clientFor(saved, fetcher), mirror = new Mirror({ client, cachePath: profilePaths(home, name).cache });
  await mirror.load();
  let plan = null, reachable = false, revoked = false;
  try { plan = (await client.status()).plan?.name ?? null; reachable = true; }
  catch (error) { if (error.status === 401) { reachable = true; revoked = true; } }
  return { connected: true, profile: name, deviceName: saved.deviceName, url: saved.url, connectedAt: saved.connectedAt, notes: mirror.notes().length, lastSync: mirror.lastSync, plan, reachable, revoked };
}

/** Removes this device in the cloud and every file of the profile here. */
export async function disconnect({ home = mcpHome(), profile = 'default', fetcher } = {}) {
  const name = profileName(profile), saved = await loadProfile(home, name);
  if (!saved) return { connected: false, revoked: false, message: 'This profile is not connected.' };
  identifyClient('mcp', VERSION);
  let revoked = false, message = `Disconnected "${saved.deviceName}". The device is removed from JotDrop and its files from this computer.`;
  try { await clientFor(saved, fetcher).revokeDevice(saved.deviceId); revoked = true; }
  catch (error) {
    // Already removed in the app: then there is nothing left to do in the cloud.
    if (error.status === 401) revoked = true;
    else message = `Removed the connection from this computer, but JotDrop Cloud could not remove the device "${saved.deviceName}". Remove it yourself in JotDrop under Connected devices.`;
  }
  await removeProfile(home, name);
  return { connected: false, revoked, message };
}

/** A running connection: the client, the mirror (started from its cache) and the tools. */
export async function openSession({ home = mcpHome(), profile = 'default', fetcher, limiter, now } = {}) {
  const name = profileName(profile), saved = await loadProfile(home, name);
  if (!saved) throw new Error(`Profile "${name}" is not connected. Run "jotdrop-mcp connect${flag(name)}" with a pairing code from JotDrop (Connected devices).`);
  identifyClient('mcp', VERSION);
  const client = clientFor(saved, fetcher), mirror = new Mirror({ client, cachePath: profilePaths(home, name).cache });
  await mirror.load();
  return { profile: name, deviceName: saved.deviceName, client, mirror, notes: createNotes({ client, mirror, limiter, now }) };
}

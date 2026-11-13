// Ask JotDrop, "Use this key on all my devices" (JotDrop Plus). The AI key is sealed with the workspace key and kept
// in a place of its own on the server (/ai-key), never as a file in the workspace: older apps stop syncing on a path
// they do not know, and a file would show up in exports and in the time machine. The server cannot open the blob.
// Android has the same rules in Kotlin; ai-key-vectors.json holds what both must open, refuse and decide.
import { decryptEnvelope, encryptEnvelope } from '../crypto.mjs';
import { PROVIDERS } from './providers.mjs';

const PATH = '/ai-key';
// The server takes 8 KiB at most.
const MAX_SEALED = 8 * 1024;
// Every blob is filled up to a whole number of these, so its size does not tell the server which AI service it is for.
const BLOCK = 1024;
const MAX_KEY = 500, MAX_MODEL = 200, MAX_ADDRESS = 300;
const FIELDS = ['provider', 'key', 'model', 'baseUrl'];
const encoder = new TextEncoder();
// As the server writes ids: the workspace is part of the AAD, so another spelling would not open anywhere.
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Binds a blob to this purpose and this workspace: no other envelope under the same key can take its place. */
function aad(vaultId) {
  if (typeof vaultId !== 'string' || !idPattern.test(vaultId)) throw new Error('Invalid workspace ID.');
  return `jotdrop:ai-key:v1:${vaultId}`;
}

const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };
const oneLine = (value, maximum) => value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);

function httpsAddress(value) {
  if (!value || !oneLine(value, MAX_ADDRESS)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password; } catch { return false; }
}

/**
 * What goes to the other devices, from the settings of this one: { provider, key, model, baseUrl } and nothing else.
 * The switch for shared notes stays per device. Throws an Error with a `code` and words for the user when these
 * settings cannot be shared: 'off' (nothing chosen), 'local' (a local model has no key), 'address' (an own address
 * that is not https), 'key' or 'model'. The message never holds the key.
 */
export function sharedKey(config) {
  const value = config && typeof config === 'object' ? config : {};
  const text = (field) => (typeof value[field] === 'string' ? value[field].trim() : '');
  const provider = text('provider'), spec = Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : undefined;
  if (!spec) refuse('off', 'Choose an AI service and save its key first.');
  if (spec.base && !spec.needsKey) refuse('local', 'A local model has no key to share. It stays on this device.');
  const baseUrl = spec.base ? '' : text('baseUrl');
  if (!spec.base && !httpsAddress(baseUrl)) refuse('address', 'Only an https address can be used on your other devices. An address on this device stays here.');
  const key = text('key'), model = text('model');
  if (!key || /\s/.test(key) || !oneLine(key, MAX_KEY)) refuse('key', 'This key cannot be used on your other devices: it is empty, too long, or has a space or line break in it.');
  if (!oneLine(model, MAX_MODEL)) refuse('model', 'This model name cannot be used on your other devices.');
  return { provider, key, model, baseUrl };
}

/** The four fields of an opened blob, or null. Strict: what another device wrote must already be in its clean form. */
function checked(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.v !== 1) return null;
  if (!FIELDS.every((field) => typeof payload[field] === 'string')) return null;
  let clean;
  try { clean = sharedKey(payload); } catch { return null; }
  return FIELDS.every((field) => clean[field] === payload[field]) ? clean : null;
}

/** The sealed blob for the server, as text. Throws like sharedKey when these settings cannot be shared. */
export async function sealKey(vaultKey, vaultId, config) {
  const additional = aad(vaultId);
  const body = { v: 1, ...sharedKey(config), pad: '' };
  body.pad = '0'.repeat((BLOCK - encoder.encode(JSON.stringify(body)).length % BLOCK) % BLOCK);
  return JSON.stringify(await encryptEnvelope(vaultKey, body, additional));
}

/**
 * { provider, key, model, baseUrl } from a sealed blob, or null when it does not open or is not a key this app can
 * use: made for another workspace or purpose, changed on the way, a later format, or settings that cannot be shared.
 * Never throws: a blob that does not open must leave the key on this device alone.
 */
export async function openKey(vaultKey, vaultId, sealed) {
  try {
    if (typeof sealed !== 'string' || sealed.length > MAX_SEALED) return null;
    return checked(await decryptEnvelope(vaultKey, JSON.parse(sealed), aad(vaultId)));
  } catch { return null; }
}

const validTime = (value) => Number.isSafeInteger(value) && value > 0;

/**
 * What the server has, for a client with `credentials` and `call()` (CloudClient):
 * { status: 'found', updatedAt, config } with config null when the blob does not open here;
 * { status: 'none' } when the server says, in its own words, that there is no blob;
 * { status: 'plus' } when this needs JotDrop Plus; { status: 'unavailable' } for everything else.
 * "none" needs the server's code 'no-ai-key': an older server answers this address with a plain 404, and a device
 * that took that for "removed" would throw its key away after a rollback.
 */
export async function readSharedKey(client) {
  try {
    const answer = await client.call(PATH);
    if (typeof answer?.sealed !== 'string' || !validTime(answer.updatedAt)) return { status: 'unavailable' };
    const { vaultKey, vaultId } = client.credentials;
    return { status: 'found', updatedAt: answer.updatedAt, config: await openKey(vaultKey, vaultId, answer.sealed) };
  } catch (error) {
    if (error?.status === 404 && error.code === 'no-ai-key') return { status: 'none' };
    if (error?.status === 402 && error.code === 'plus-required') return { status: 'plus' };
    return { status: 'unavailable' };
  }
}

/** Seals these settings and saves them for the other devices. Returns the server's time of the blob, to remember. */
export async function saveSharedKey(client, config) {
  const { vaultKey, vaultId } = client.credentials;
  const answer = await client.call(PATH, 'PUT', { sealed: await sealKey(vaultKey, vaultId, config) });
  if (!validTime(answer?.updatedAt)) throw new Error('The server did not confirm the saved key.');
  return answer.updatedAt;
}

/** Removes the blob from the server. Devices that got their key from it drop it at their next look. Needs no Plus. */
export async function removeSharedKey(client) {
  await client.call(PATH, 'DELETE');
}

/**
 * What a device does with the server's answer. `local` is { hasKey, synced }: synced is the time of the blob this
 * device's key came from or was saved as, 0 when its key (if any) is its own.
 * - 'offer': no key here and one is ready: ask "Use it here?".
 * - 'available': an own key here while the other devices share one: only say so.
 * - 'update': the shared key was replaced: take the new one when it is for the same service (sameService), ask first when it is not.
 * - 'remove': the shared key was removed elsewhere: drop the copy and turn Ask JotDrop off, with a message.
 * - 'waiting': the copy stays; sharing waits for JotDrop Plus.
 * - 'none': change nothing. Also for a blob that does not open, an older blob shown again, and every answer that
 *   is not understood: when in doubt the key on this device is left alone.
 */
export function decideKeySync(local, remote) {
  const synced = validTime(local?.synced) ? local.synced : 0;
  if (remote?.status === 'plus') return synced ? 'waiting' : 'none';
  if (remote?.status === 'none') return synced ? 'remove' : 'none';
  if (remote?.status !== 'found' || !remote.config || !validTime(remote.updatedAt)) return 'none';
  if (synced) return remote.updatedAt > synced ? 'update' : 'none';
  return local?.hasKey ? 'available' : 'offer';
}

/**
 * Whether two settings talk to the same AI service: the same provider and, for an own address, the same address.
 * A newer shared key for the same service is taken without a question (a replaced key). One for another service or
 * another address is not: the device asks first, because it changes where questions and notes go.
 */
export function sameService(a, b) {
  const text = (value, field) => (typeof value?.[field] === 'string' ? value[field].trim() : '');
  return Boolean(text(a, 'provider')) && text(a, 'provider') === text(b, 'provider') && text(a, 'baseUrl') === text(b, 'baseUrl');
}

/** The service a shared key is for, in words, for "A key from another device is ready: …". Never the key. */
export function keyLabel(config) {
  const spec = Object.hasOwn(PROVIDERS, config?.provider) ? PROVIDERS[config.provider] : undefined;
  if (!spec) return 'an AI service';
  if (spec.base) return spec.name;
  try { return `your own address ${new URL(config.baseUrl).host}`; } catch { return 'your own address'; }
}

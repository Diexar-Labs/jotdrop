import { CloudError } from './client.mjs';
import { decryptEnvelope, encryptEnvelope, generateVaultKey, validId } from './crypto.mjs';

// A note anyone with the link can read, without an account. The key is only in the part of the address after #,
// which browsers do not send, so the server holds sealed text. The note goes along as it is now: a copy, not a live view.

const linkAad = (id) => `jotdrop:note-link:v1:${id}`;
const ownerAad = (vaultId, id) => `jotdrop:note-link-owner:v1:${vaultId}:${id}`;
export const LINK_DAYS = [1, 7, 30, 0];

export const linkAddress = (origin, id, key) => `${origin}/n/${id}#${key}`;

/** The link ID and key from an address, or from the page's own location. */
export function readLinkAddress(address) {
  const match = /\/n\/([0-9a-f-]{36})#([\w-]{43})$/.exec(address);
  if (!match || !validId(match[1])) throw new Error('This link is not complete.');
  return { id: match[1], key: match[2] };
}

/** `days` 0 means until it is removed. */
export async function createLink(client, note, { origin, days = 7 }) {
  const id = crypto.randomUUID(), key = generateVaultKey(), { vaultId, vaultKey } = client.credentials;
  const made = await client.call('/links', 'POST', {
    id, days,
    envelope: JSON.stringify(await encryptEnvelope(key, { title: note.title, text: note.text }, linkAad(id))),
    // So your other devices can show and copy your links; the server cannot open this either.
    ownerEnvelope: JSON.stringify(await encryptEnvelope(vaultKey, { key, title: note.title.slice(0, 200) }, ownerAad(vaultId, id))),
  });
  return { id, key, expiresAt: made.expiresAt, address: linkAddress(origin, id, key) };
}

export async function listLinks(client, origin = client.credentials.url) {
  const { vaultId, vaultKey } = client.credentials;
  const { links } = await client.call('/links');
  return Promise.all(links.map(async (link) => {
    const mine = await decryptEnvelope(vaultKey, JSON.parse(link.ownerEnvelope), ownerAad(vaultId, link.id)).catch(() => null);
    return { id: link.id, expiresAt: link.expiresAt, title: mine?.title ?? '', address: mine ? linkAddress(origin, link.id, mine.key) : null };
  }));
}

export const removeLink = (client, id) => client.call(`/links/${id}`, 'DELETE');

const publicCall = async (url, path, options) => {
  const response = await fetch(`${url}/api/v1/public-links/${path}`, options);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new CloudError(typeof result.error === 'string' ? result.error : 'This link does not open.', response.status), { code: result.code });
  return result;
};

/** No account needed. Throws with status 404 or 410 when the link has ended. */
export async function openLink(url, id, key) {
  const { envelope, expiresAt } = await publicCall(url, id);
  return { ...(await decryptEnvelope(key, JSON.parse(envelope), linkAad(id))), expiresAt };
}

export const reportLink = (url, id, report) => publicCall(url, `${id}/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });

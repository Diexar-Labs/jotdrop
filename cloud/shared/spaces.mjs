import { CloudClient } from './client.mjs';
import { decryptEnvelope, encryptEnvelope, generateVaultKey, hashToken, objectId, randomToken, validId } from './crypto.mjs';

// A shared space from the app's side: a small vault of its own, reached through the account's membership.
// The files go through an ordinary CloudClient with the space's id and key; this file is about who is in it.

const keyAad = (vaultId, spaceId) => `jotdrop:space-key:v1:${vaultId}:${spaceId}`;
const prefsAad = (vaultId, spaceId) => `jotdrop:space-prefs:v1:${vaultId}:${spaceId}`;
const spaceNameAad = (spaceId) => `jotdrop:space-name:v1:${spaceId}`;
const memberNameAad = (spaceId, accountId) => `jotdrop:member-name:v1:${spaceId}:${accountId}`;
const inviteAad = (inviteId) => `jotdrop:invite:v1:${inviteId}`;
const seal = async (key, payload, aad) => JSON.stringify(await encryptEnvelope(key, payload, aad));
const shortName = (value) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\x00-\x1f]/.test(value)) throw new Error('Enter a name of 1 to 80 characters.');
  return value.trim();
};
const opened = (key, envelope, aad) => (envelope ? decryptEnvelope(key, JSON.parse(envelope), aad).catch(() => null) : null);
const spacePath = (id, rest = '') => { if (!validId(id)) throw new Error('Invalid shared space.'); return `/spaces/${id}${rest}`; };

/** A file that does not open: not a refusal by the server and not a broken connection. In a space another person may have written it. */
export const unreadableFile = (error) => error?.status === undefined && !(error instanceof TypeError) && !['AbortError', 'TimeoutError'].includes(error?.name);

/** The client for the files of a space. */
export function spaceClient(client, spaceId, spaceKey) {
  return new CloudClient({ ...client.credentials, vaultId: spaceId, vaultKey: spaceKey, fetcher: client.fetcher });
}

export async function createSpace(client, name, { replaces, memberName } = {}) {
  const { vaultId, vaultKey } = client.credentials;
  const id = crypto.randomUUID(), key = generateVaultKey();
  const made = await client.call('/spaces', 'POST', { id, nameEnvelope: await seal(key, { name: shortName(name) }, spaceNameAad(id)), wrapped: await seal(vaultKey, { spaceKey: key }, keyAad(vaultId, id)), ...(replaces ? { replaces } : {}) });
  // Another device of this account already began the same replacement: carry on with that one.
  const space = made.id === id ? { id, key } : await spaceDetails(client, made.id);
  if (memberName) await setMemberName(client, space, memberName);
  return space;
}

/** Only ids, sequences and state: light enough to ask every 30 seconds. */
export const listSpaces = async (client) => (await client.call('/spaces')).spaces;

/** What the server keeps, opened: `key` is null while the key was not saved yet, a name null when it does not open. */
export async function spaceDetails(client, spaceId) {
  const view = await client.call(spacePath(spaceId));
  const { vaultId, vaultKey } = client.credentials;
  const key = (await opened(vaultKey, view.me.wrapped, keyAad(vaultId, spaceId)))?.spaceKey ?? null;
  const name = key ? (await opened(key, view.nameEnvelope, spaceNameAad(spaceId)))?.name ?? null : null;
  const members = await Promise.all(view.members.map(async (member) => ({ ...member, name: key ? (await opened(key, member.nameEnvelope, memberNameAad(spaceId, member.accountId)))?.name ?? null : null })));
  const prefs = view.me.prefs ? await opened(vaultKey, view.me.prefs, prefsAad(vaultId, spaceId)) : null;
  return { ...view, key, name, members, prefs: prefs ?? {} };
}

export async function setMemberName(client, space, name) {
  const { accountId } = (await client.call(spacePath(space.id))).me;
  return client.call(spacePath(space.id, '/key'), 'PUT', { nameEnvelope: await seal(space.key, { name: shortName(name) }, memberNameAad(space.id, accountId)) });
}

/** Per person and only for this account's devices, like everything under the own vault key. */
export async function saveSpacePrefs(client, spaceId, prefs) {
  const { vaultId, vaultKey } = client.credentials;
  return client.call(spacePath(spaceId, '/key'), 'PUT', { prefs: await seal(vaultKey, prefs, prefsAad(vaultId, spaceId)) });
}

/** The link holds a claim code and a key that opens the sealed envelope once; the server gets the hash and the envelope. */
export async function makeInvite(client, space, inviterName, origin = client.credentials.url) {
  const id = crypto.randomUUID(), claimToken = randomToken(), wrappingKey = randomToken();
  const envelope = await seal(wrappingKey, { spaceId: space.id, spaceKey: space.key, inviterName: shortName(inviterName) }, inviteAad(id));
  const made = await client.call(spacePath(space.id, '/invites'), 'POST', { id, claimTokenHash: await hashToken(claimToken), envelope });
  return { id, expiresAt: made.expiresAt, link: `${origin}/join#v1.${id}.${claimToken}.${wrappingKey}` };
}

export const withdrawInvite = (client, spaceId, inviteId) => client.call(spacePath(spaceId, `/invites/${inviteId}`), 'DELETE');

/** What comes after /join#, or the whole link. Throws on anything else. */
export function readInvite(link) {
  const parts = String(link).trim().split('#').pop().split('.');
  const [version, id, claimToken, wrappingKey] = parts;
  if (parts.length !== 4 || version !== 'v1' || !validId(id) || !/^[\w-]{43}$/.test(claimToken) || !/^[\w-]{43}$/.test(wrappingKey)) throw new Error('This invitation link is not complete. Ask for a new one.');
  return { id, claimToken, wrappingKey };
}

/** Joins with a chosen name. Safe to repeat after a crash: the same account gets the envelope again until the key is saved. */
export async function acceptInvite(client, invite, memberName) {
  const name = shortName(memberName);
  const claimed = await client.call(`/invites/${invite.id}/claim`, 'POST', { claimToken: invite.claimToken });
  const sealed = await decryptEnvelope(invite.wrappingKey, JSON.parse(claimed.envelope), inviteAad(invite.id));
  if (sealed.spaceId !== claimed.spaceId) throw new Error('This invitation does not match its shared space. Nothing was saved.');
  const { vaultId, vaultKey } = client.credentials;
  const { accountId } = (await client.call(spacePath(claimed.spaceId))).me;
  await client.call(spacePath(claimed.spaceId, '/key'), 'PUT', { wrapped: await seal(vaultKey, { spaceKey: sealed.spaceKey }, keyAad(vaultId, claimed.spaceId)), nameEnvelope: await seal(sealed.spaceKey, { name }, memberNameAad(claimed.spaceId, accountId)) });
  return { id: claimed.spaceId, key: sealed.spaceKey, inviterName: typeof sealed.inviterName === 'string' ? sealed.inviterName.slice(0, 80) : '' };
}

export const removeMember = (client, spaceId, accountId) => client.call(spacePath(spaceId, `/members/${accountId}`), 'DELETE');
export const leaveSpace = (client, spaceId) => client.call(spacePath(spaceId, '/leave'), 'POST', {});
/**
 * `about` is a person's account; without it the report is about the group.
 * @param {*} client
 * @param {string} spaceId
 * @param {{ reason: string, about?: string, details?: string }} report reason: abuse, illegal, spam or other
 */
export const reportSpace = (client, spaceId, { reason, about, details }) => client.call(spacePath(spaceId, '/report'), 'POST', { reason, ...(about ? { about } : {}), ...(details ? { details } : {}) });
export const blockMember = (client, spaceId, accountId) => client.call(spacePath(spaceId, '/block'), 'POST', { accountId });
export const takeOverSpace = (client, spaceId) => client.call(spacePath(spaceId, '/takeover'), 'POST', {});
export const deleteSpace = (client, spaceId) => client.call(spacePath(spaceId), 'DELETE');

/** The file at this path in that cloud, or undefined; a file in the trash counts as there, because a new version goes on top of it. */
async function fileAt(target, path) {
  try { return await target.read(await objectId(target.credentials.vaultKey, path)); }
  catch (error) { if (error.status === 404) return undefined; throw error; }
}
const sameBytes = (left, right) => left.length === right.length && left.every((byte, index) => byte === right[index]);

/** Writes under this name, or the first free one ("name 2.md"). The same bytes already there count as written, so a retry never doubles. */
export async function writeUnderFreeName(target, path, bytes) {
  const dot = path.lastIndexOf('.'), stem = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path, end = dot > path.lastIndexOf('/') ? path.slice(dot) : '';
  for (let copy = 1; copy < 1000; copy++) {
    const candidate = copy === 1 ? path : `${stem} ${copy}${end}`;
    const existing = await fileAt(target, candidate);
    if (existing && !existing.deleted && sameBytes(existing.file.bytes, bytes)) return candidate;
    if (existing && !existing.deleted) continue;
    await target.write(candidate, bytes, existing?.revision ?? 0);
    return candidate;
  }
  throw new Error(`Too many files are called "${path}".`);
}

/**
 * The current files of one cloud into another, for a replacement: only what is there now, no old versions.
 * Run it again to bring the copy up to date; `seen` is what it did before. Returns the sequence it is based on.
 */
export async function copyCurrentFiles(from, to, seen = new Map()) {
  const latest = new Map();
  for (let page = { cursor: 0, hasMore: true }; page.hasMore;) {
    page = await from.listChanges(page.cursor);
    for (const change of page.changes) latest.set(change.id, change);
  }
  for (const change of latest.values()) {
    if (seen.get(change.id)?.revision === change.revision) continue;
    if (change.deleted) {
      const copied = seen.get(change.id);
      if (copied) {
        const existing = await fileAt(to, copied.path);
        if (existing && !existing.deleted) await to.remove(existing.id, existing.revision);
      }
      seen.set(change.id, { revision: change.revision, path: copied?.path });
      continue;
    }
    let source;
    try { source = await from.read(change.id); }
    catch (error) {
      // Left out of the copy: one bad file must not stop the owner from removing someone.
      if (!unreadableFile(error)) throw error;
      seen.set(change.id, { revision: change.revision });
      continue;
    }
    const { file, revision } = source;
    const existing = await fileAt(to, file.path);
    if (!existing || existing.deleted || !sameBytes(existing.file.bytes, file.bytes)) await to.write(file.path, file.bytes, existing?.revision ?? 0, file.modifiedAt);
    seen.set(change.id, { revision, path: file.path });
  }
  return seen;
}

/**
 * Removing someone from a group of three or more: a new space with a new key, and the old one frozen once the copy is
 * complete. The server refuses the last step when the old space changed since the copy, so this copies again.
 */
export async function replaceSpace(client, space, { memberName = undefined, attempts = 5 } = {}) {
  const next = await createSpace(client, space.name ?? 'Shared', { replaces: space.id, memberName });
  const from = spaceClient(client, space.id, space.key), to = spaceClient(client, next.id, next.key), seen = new Map();
  for (let attempt = 1; ; attempt++) {
    const { sequence } = (await listSpaces(client)).find((item) => item.id === space.id) ?? { sequence: 0 };
    await copyCurrentFiles(from, to, seen);
    try {
      await client.call(spacePath(space.id, '/replace'), 'POST', { newSpaceId: next.id, expectedSequence: sequence });
      return next;
    } catch (error) {
      if (error.status !== 409 || error.code === 'space-frozen' || attempt >= attempts) throw error;
    }
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudServer } from '../server.mjs';
import { CloudClient } from './client.mjs';
import { encryptEnvelope, generateVaultKey, hashToken, objectId, randomToken } from './crypto.mjs';
import { acceptInvite, copyCurrentFiles, createSpace, deleteSpace, leaveSpace, listSpaces, makeInvite, readInvite, removeMember, replaceSpace, saveSpacePrefs, spaceClient, spaceDetails, unreadableFile, withdrawInvite, writeUnderFreeName } from './spaces.mjs';

const text = (value) => new TextEncoder().encode(value);
const read = (bytes) => new TextDecoder().decode(bytes);

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-spaces-client-'));
  const mails = [];
  let now = Date.parse('2026-11-02T08:00:00Z');
  const app = await createCloudServer({ dataDir, port: 0, mailer: async (mail) => { mails.push(mail); }, serverKey: randomToken(), enrollmentToken: randomToken(), clock: () => now, freeDeviceLimit: 100, signupsPerAddress: 1000 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  const post = async (path, body) => {
    const response = await fetch(`${url}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return response.json();
  };
  const signUp = async (name) => {
    now += 61000;
    const email = `${name}@example.test`, vaultKey = generateVaultKey(), token = randomToken();
    const { signupId } = await post('/accounts', { email, authKey: randomToken(), kdf: { salt: Buffer.from(randomBytes(16)).toString('base64url'), memory: 65536, passes: 3, parallelism: 1 }, wrappedVaultKey: JSON.stringify(await encryptEnvelope(randomToken(), { vaultKey }, 'jotdrop:wrap:v1')), recoveryTokenHash: await hashToken(randomToken()), deviceName: 'Phone', deviceTokenHash: await hashToken(token) });
    const verified = await post('/accounts/verify', { signupId, code: mails.filter((mail) => mail.to === email && mail.kind === 'verify').at(-1).code });
    return new CloudClient({ url, vaultId: verified.vaultId, deviceId: verified.deviceId, token, vaultKey });
  };
  return { url, signUp, tick: () => { now += 61000; } };
}

async function group(app) {
  const owner = await app.signUp('owner'), ana = await app.signUp('ana');
  const space = await createSpace(owner, 'Family', { memberName: 'Eric' });
  app.tick();
  const invite = await makeInvite(owner, space, 'Eric');
  await acceptInvite(ana, readInvite(invite.link), 'Ana');
  return { owner, ana, space };
}

test('an invitation link opens once, for one account, and the secrets stay in the part after #', async (t) => {
  const app = await fixture(t);
  const owner = await app.signUp('owner'), ana = await app.signUp('ana'), ben = await app.signUp('ben');
  const space = await createSpace(owner, 'Family', { memberName: 'Eric' });
  const invite = await makeInvite(owner, space, 'Eric');
  const [before, after] = invite.link.split('#');
  assert.equal(before, `${app.url}/join`);
  assert.match(after, /^v1\.[0-9a-f-]{36}\.[\w-]{43}\.[\w-]{43}$/);
  assert.ok(!invite.link.includes(space.key), 'The space key is never in the link');
  assert.throws(() => readInvite(`${app.url}/join#v1.${invite.id}`), /not complete/);

  const joined = await acceptInvite(ana, readInvite(invite.link), 'Ana');
  assert.equal(joined.id, space.id);
  assert.equal(joined.key, space.key);
  assert.equal(joined.inviterName, 'Eric');
  await assert.rejects(acceptInvite(ben, readInvite(invite.link), 'Ben'), (error) => error.status === 409 && error.code === 'invite-used');
  await assert.rejects(acceptInvite(ana, readInvite(invite.link), 'Ana'), (error) => error.status === 409 && error.code === 'already-member');

  // Resolving a conflict drops a draft; in a space there is no old upload route to ask.
  await spaceClient(ana, space.id, joined.key).discardWrite(await spaceClient(ana, space.id, joined.key).prepareWrite('notes/draft.md', text('draft'), 0));
  // Both write through an ordinary client and read each other.
  await spaceClient(ana, space.id, joined.key).write('notes/list.md', text('- [ ] milk'), 0);
  const id = await objectId(space.key, 'notes/list.md');
  assert.equal(read((await spaceClient(owner, space.id, space.key).read(id)).file.bytes), '- [ ] milk');
});

test('a withdrawn link is dead, and a repeat after a crash before the key was saved still works', async (t) => {
  const app = await fixture(t);
  const owner = await app.signUp('owner'), ana = await app.signUp('ana');
  const space = await createSpace(owner, 'Family');
  const withdrawn = await makeInvite(owner, space, 'Eric');
  await withdrawInvite(owner, space.id, withdrawn.id);
  await assert.rejects(acceptInvite(ana, readInvite(withdrawn.link), 'Ana'), (error) => error.status === 404);
  app.tick();
  const invite = await makeInvite(owner, space, 'Eric');
  const parts = readInvite(invite.link);
  // The claim went through, but the answer or the key was lost.
  await ana.call(`/invites/${parts.id}/claim`, 'POST', { claimToken: parts.claimToken });
  assert.equal((await spaceDetails(ana, space.id)).key, null);
  assert.equal((await acceptInvite(ana, parts, 'Ana')).key, space.key);
  assert.equal((await spaceDetails(ana, space.id)).key, space.key);
});

test('details open under the right key; emails only for the owner; prefs only for the account itself', async (t) => {
  const app = await fixture(t);
  const { owner, ana, space } = await group(app);
  const seen = await spaceDetails(owner, space.id), other = await spaceDetails(ana, space.id);
  assert.equal(seen.name, 'Family');
  assert.deepEqual(seen.members.map((member) => member.name), ['Eric', 'Ana']);
  assert.deepEqual(other.members.map((member) => member.name), ['Eric', 'Ana']);
  assert.equal(seen.members[1].email, 'ana@example.test');
  assert.ok(other.members.every((member) => member.email === undefined));
  assert.equal(other.key, space.key);
  await saveSpacePrefs(owner, space.id, { finishRemoval: true });
  assert.deepEqual((await spaceDetails(owner, space.id)).prefs, { finishRemoval: true });
  assert.deepEqual((await spaceDetails(ana, space.id)).prefs, {});
  // A name the server made up does not open; it shows as unknown instead of breaking the screen.
  await ana.call(`/spaces/${space.id}/key`, 'PUT', { nameEnvelope: JSON.stringify(await encryptEnvelope(randomToken(), { name: 'Fake' }, 'x')) });
  assert.equal((await spaceDetails(owner, space.id)).members[1].name, null);
});

test('a free name never overwrites, and a retry never doubles', async (t) => {
  const app = await fixture(t);
  const owner = await app.signUp('owner');
  assert.equal(await writeUnderFreeName(owner, 'notes/a.md', text('one')), 'notes/a.md');
  assert.equal(await writeUnderFreeName(owner, 'notes/a.md', text('one')), 'notes/a.md');
  assert.equal(await writeUnderFreeName(owner, 'notes/a.md', text('two')), 'notes/a 2.md');
  assert.equal(await writeUnderFreeName(owner, 'notes/a.md', text('two')), 'notes/a 2.md');
  assert.equal(await writeUnderFreeName(owner, 'attachments/noext', text('x')), 'attachments/noext');
  assert.equal(await writeUnderFreeName(owner, 'attachments/noext', text('y')), 'attachments/noext 2');
  // A file in the trash gets a new version on top of it.
  const id = await objectId(owner.credentials.vaultKey, 'notes/a.md');
  await owner.remove(id, 1);
  assert.equal(await writeUnderFreeName(owner, 'notes/a.md', text('three')), 'notes/a.md');
  assert.equal(read((await owner.read(id)).file.bytes), 'three');
});

test('replacing: new key, only current files, the old group frozen, and a change during the copy is not lost', async (t) => {
  const app = await fixture(t);
  const { owner, ana, space } = await group(app);
  const ben = await app.signUp('ben');
  app.tick();
  await acceptInvite(ben, readInvite((await makeInvite(owner, space, 'Eric')).link), 'Ben');
  const files = spaceClient(owner, space.id, space.key);
  await files.write('notes/keep.md', text('first'), 0);
  await files.write('notes/keep.md', text('second'), 1);
  const gone = await files.write('notes/gone.md', text('in the trash'), 0);
  await files.remove(gone.id, gone.revision);

  await removeMember(owner, space.id, (await spaceDetails(owner, space.id)).members.find((member) => member.name === 'Ana').accountId);
  // Someone changes a note just as the copy is made: the server refuses the swap and the copy runs again.
  const details = await spaceDetails(owner, space.id);
  let interfered = false;
  const realCall = owner.call.bind(owner);
  owner.call = async (path, ...rest) => {
    if (path.endsWith('/replace') && !interfered) {
      interfered = true;
      await spaceClient(ben, space.id, space.key).write('notes/late.md', text('written during the copy'), 0);
    }
    return realCall(path, ...rest);
  };
  const next = await replaceSpace(owner, details, { memberName: 'Eric' });
  owner.call = realCall;
  assert.ok(interfered);
  assert.notEqual(next.key, space.key);

  const copy = spaceClient(owner, next.id, next.key);
  assert.equal(read((await copy.read(await objectId(next.key, 'notes/keep.md'))).file.bytes), 'second');
  assert.equal(read((await copy.read(await objectId(next.key, 'notes/late.md'))).file.bytes), 'written during the copy');
  await assert.rejects(copy.read(await objectId(next.key, 'notes/gone.md')), (error) => error.status === 404);
  assert.deepEqual((await copy.history(await objectId(next.key, 'notes/keep.md'))).versions.map((version) => version.revision), [1], 'Old versions stay behind');

  const old = (await listSpaces(owner)).find((item) => item.id === space.id);
  assert.equal(old.frozen, true);
  assert.equal(old.replacedBy, next.id);
  await assert.rejects(spaceClient(ben, space.id, space.key).write('notes/after.md', text('too late'), 0), (error) => error.status === 403 || error.status === 409);
  // The removed member gets nothing, the remaining one is not in the new group until a new link.
  await assert.rejects(spaceClient(ana, next.id, next.key).listChanges(0), (error) => error.status === 401);
  await assert.rejects(spaceClient(ben, next.id, next.key).listChanges(0), (error) => error.status === 401);
});

test('copying again only brings what changed, including a deletion', async (t) => {
  const app = await fixture(t);
  const owner = await app.signUp('owner');
  app.tick();
  const other = await app.signUp('other');
  const seen = new Map();
  const first = await owner.write('notes/a.md', text('a'), 0);
  await copyCurrentFiles(owner, other, seen);
  assert.equal(read((await other.read(await objectId(other.credentials.vaultKey, 'notes/a.md'))).file.bytes), 'a');
  await owner.remove(first.id, first.revision);
  await owner.write('notes/b.md', text('b'), 0);
  await copyCurrentFiles(owner, other, seen);
  assert.equal((await other.read(await objectId(other.credentials.vaultKey, 'notes/a.md'))).deleted, true);
  assert.equal(read((await other.read(await objectId(other.credentials.vaultKey, 'notes/b.md'))).file.bytes), 'b');
});

test('one file that does not open stops nobody: the copy goes on, and only real failures count', async (t) => {
  const app = await fixture(t);
  const { owner, ana, space } = await group(app);
  const files = spaceClient(owner, space.id, space.key);
  await files.write('notes/good.md', text('good'), 0);
  // A member with a changed app writes under the path's id, with a path inside that does not match it.
  const evil = spaceClient(ana, space.id, space.key);
  const id = await objectId(space.key, 'notes/evil.md');
  const prepared = await evil.prepareWrite('notes/other.md', text('bad'), 0);
  await evil.commitWrite({ ...prepared, id }, { source: text('bad') });
  await assert.rejects(files.read(id), (error) => unreadableFile(error));
  assert.equal(unreadableFile(Object.assign(new Error('Refused'), { status: 403 })), false);
  assert.equal(unreadableFile(new TypeError('fetch failed')), false);
  const other = await app.signUp('other');
  await copyCurrentFiles(files, other);
  assert.equal(read((await other.read(await objectId(other.credentials.vaultKey, 'notes/good.md'))).file.bytes), 'good');
  await assert.rejects(other.read(await objectId(other.credentials.vaultKey, 'notes/other.md')), (error) => error.status === 404);
});

test('leaving and deleting: a member who left gets nothing, a deleted group is gone', async (t) => {
  const app = await fixture(t);
  const { owner, ana, space } = await group(app);
  await leaveSpace(ana, space.id);
  assert.deepEqual(await listSpaces(ana), []);
  await assert.rejects(spaceClient(ana, space.id, space.key).listChanges(0), (error) => error.status === 401);
  await deleteSpace(owner, space.id);
  assert.deepEqual(await listSpaces(owner), []);
});

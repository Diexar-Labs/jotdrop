import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createCloudServer } from './server.mjs';
import { CloudClient } from './shared/client.mjs';
import { decryptEnvelope, encryptEnvelope, generateVaultKey, hashToken, randomToken } from './shared/crypto.mjs';

const DAY = 24 * 60 * 60 * 1000, MINUTE = 60 * 1000;
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const text = (value) => new TextEncoder().encode(value);

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-spaces-test-'));
  const mails = [];
  let now = Date.parse('2026-11-02T08:00:00Z');
  const settings = { dataDir, mailer: async (mail) => { mails.push(mail); }, serverKey: randomToken(), enrollmentToken: randomToken(), clock: () => now, freeDeviceLimit: 100, signupsPerAddress: 1000, sweepEvery: 10, ...options };
  const app = await createCloudServer(settings);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = () => `http://127.0.0.1:${app.port}`;
  const api = async (path, body, headers = {}, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${url()}/api/v1${path}`, { method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const answer = await response.text();
    return { status: response.status, body: answer ? JSON.parse(answer) : undefined };
  };
  const context = { dataDir, mails, url, api, enrollmentToken: settings.enrollmentToken, advance: (ms) => { now += ms; }, time: () => now, dbPath: () => app.dbPath,
    // The server's hourly sweep runs every few milliseconds here.
    sweep: () => new Promise((done) => setTimeout(done, 60)),
    database: () => new DatabaseSync(join(dataDir, 'cloud.db')) };
  return context;
}

/** An account with one device, as a real client signs up. The password is only a random login key here: these tests are about spaces. */
async function signUp(app, name) {
  // The per-minute limits on sign-ups and codes are not what these tests are about.
  app.advance(MINUTE + 1);
  const email = `${name}@example.test`, vaultKey = generateVaultKey(), deviceToken = randomToken(), recoveryToken = randomToken(), authKey = randomToken();
  const started = await app.api('/accounts', { email, authKey, kdf: { salt: b64(randomBytes(16)), memory: 65536, passes: 3, parallelism: 1 }, wrappedVaultKey: JSON.stringify(await encryptEnvelope(randomToken(), { vaultKey }, 'jotdrop:wrap:v1')), recoveryTokenHash: await hashToken(recoveryToken), deviceName: 'Phone', deviceTokenHash: await hashToken(deviceToken) });
  assert.equal(started.status, 202);
  const code = app.mails.filter((mail) => mail.to === email && mail.kind === 'verify').at(-1).code;
  const verified = await app.api('/accounts/verify', { signupId: started.body.signupId, code });
  assert.equal(verified.status, 201);
  const client = new CloudClient({ url: app.url(), vaultId: verified.body.vaultId, deviceId: verified.body.deviceId, token: deviceToken, vaultKey });
  return person(app, client, { name, email, authKey, recoveryToken });
}

/** What a person's device can do; `headers` keep their own cloud in X-JotDrop-Vault. */
function person(app, client, extra) {
  const { vaultId, deviceId, token, vaultKey } = client.credentials;
  const headers = { Authorization: `Bearer ${token}`, 'X-JotDrop-Vault': vaultId, 'X-JotDrop-Device': deviceId };
  return { ...extra, client, vaultKey, deviceId, token, vaultId, headers,
    call: (path, body, method) => app.api(path, body, headers, method),
    inSpace: (spaceId, path, body, method) => app.api(path, body, { ...headers, 'X-JotDrop-Vault': spaceId }, method),
    /** The unchanged client from cloud/shared, pointed at a space: its sync, versions and pieces need nothing new. */
    files: (space) => new CloudClient({ url: app.url(), vaultId: space.id, deviceId, token, vaultKey: space.key }) };
}

const wrapFor = (who, space) => encryptEnvelope(who.vaultKey, { spaceKey: space.key }, `jotdrop:space-key:v1:${who.vaultId}:${space.id}`).then(JSON.stringify);

async function newSpace(owner, { replaces, name = 'Family lists' } = {}) {
  const space = { id: randomUUID(), key: generateVaultKey() };
  const nameEnvelope = JSON.stringify(await encryptEnvelope(space.key, { name }, `jotdrop:space-name:v1:${space.id}`));
  const answer = await owner.call('/spaces', { id: space.id, nameEnvelope, wrapped: await wrapFor(owner, space), ...(replaces ? { replaces } : {}) });
  return { ...space, status: answer.status, answer };
}

/** The link's secrets stay on the devices: the server gets a hash and a sealed envelope. */
async function invite(owner, space, inviterName = 'Eric') {
  const id = randomUUID(), claimToken = randomToken(), wrappingKey = randomToken();
  const envelope = JSON.stringify(await encryptEnvelope(wrappingKey, { spaceId: space.id, spaceKey: space.key, inviterName }, `jotdrop:invite:v1:${id}`));
  const answer = await owner.call(`/spaces/${space.id}/invites`, { id, claimTokenHash: await hashToken(claimToken), envelope });
  return { id, claimToken, wrappingKey, answer };
}

async function acceptKey(who, link, answer) {
  const opened = await decryptEnvelope(link.wrappingKey, JSON.parse(answer.body.envelope), `jotdrop:invite:v1:${link.id}`);
  assert.equal(opened.spaceId, answer.body.spaceId);
  const saved = await who.call(`/spaces/${opened.spaceId}/key`, { wrapped: await wrapFor(who, { id: opened.spaceId, key: opened.spaceKey }) }, 'PUT');
  assert.equal(saved.status, 200);
  return { id: opened.spaceId, key: opened.spaceKey };
}

/** Invites and accepts in one go. */
async function joinSpace(app, owner, space, who) {
  app.advance(MINUTE + 1);
  const link = await invite(owner, space);
  assert.equal(link.answer.status, 201);
  const answer = await who.call(`/invites/${link.id}/claim`, { claimToken: link.claimToken });
  assert.equal(answer.status, 200);
  return acceptKey(who, link, answer);
}

async function group(app, ...names) {
  const owner = await signUp(app, names[0]), space = await newSpace(owner);
  assert.equal(space.status, 201);
  const members = [];
  for (const name of names.slice(1)) {
    const member = await signUp(app, name);
    await joinSpace(app, owner, space, member);
    members.push(member);
  }
  return { owner, space, members };
}

const sequenceOf = async (who, space) => (await who.inSpace(space.id, '/status')).body.sequence;

test('members read and write a space with the unchanged client, and outsiders get nothing', async (t) => {
  const app = await fixture(t);
  const { owner, space, members: [ana] } = await group(app, 'owner', 'ana');
  const stranger = await signUp(app, 'stranger');
  const saved = await owner.files(space).write('notes/shopping.md', text('- [ ] milk\n- [ ] eggs'), 0);
  assert.equal(saved.revision, 1);
  const read = await ana.files(space).read(saved.id);
  assert.equal(new TextDecoder().decode(read.file.bytes), '- [ ] milk\n- [ ] eggs');
  // A file too large for a manifest goes through the piece routes and /status capabilities.
  const large = randomBytes(150 * 1024), piece = await ana.files(space).write('attachments/photo.bin', large, 0);
  assert.deepEqual(Buffer.from((await owner.files(space).read(piece.id)).file.bytes), large);
  assert.equal((await ana.files(space).write('notes/shopping.md', text('- [x] milk\n- [ ] eggs'), 1)).revision, 2);
  await assert.rejects(owner.files(space).write('notes/shopping.md', text('stale'), 1), (error) => error.status === 409);
  assert.equal((await owner.files(space).listChanges()).changes.length, 3);
  // Both see it listed, and their own cloud is untouched.
  assert.deepEqual((await ana.call('/spaces')).body.spaces, [{ id: space.id, sequence: await sequenceOf(ana, space), frozen: false, replacedBy: null }]);
  assert.equal((await ana.client.listChanges()).changes.length, 0);
  // Same answer for a stranger and for a space that does not exist.
  const missing = randomUUID();
  const refused = await stranger.inSpace(space.id, '/changes'), unknown = await stranger.inSpace(missing, '/changes');
  assert.equal(refused.status, 401);
  assert.deepEqual(refused, unknown);
  assert.deepEqual([(await stranger.call(`/spaces/${space.id}`)).status, (await stranger.call(`/spaces/${missing}`)).status], [404, 404]);
  assert.equal((await stranger.call('/spaces')).body.spaces.length, 0);
  // Not somebody else's own cloud either.
  assert.equal((await ana.inSpace(stranger.vaultId, '/status')).status, 401);
  await assert.rejects(stranger.files(space).write('notes/x.md', text('x'), 0), (error) => error.status === 401);
});

test('a removed member and a revoked device get nothing, also halfway through an upload', async (t) => {
  const app = await fixture(t);
  const { owner, space, members: [ana, ben] } = await group(app, 'owner', 'ana', 'ben');
  const saved = await owner.files(space).write('notes/a.md', text('first'), 0);
  // Ana is sending a piece when she is removed: the body arrives after the removal.
  const bytes = randomBytes(2000), name = createHash('sha256').update(bytes).digest('hex');
  const url = new URL(app.url());
  let finish;
  const answer = new Promise((done, reject) => {
    const sending = request({ host: url.hostname, port: url.port, method: 'PUT', path: `/api/v1/chunks/${name}`, headers: { Authorization: `Bearer ${ana.token}`, 'X-JotDrop-Vault': space.id, 'X-JotDrop-Device': ana.deviceId, 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length } }, (response) => { response.resume(); response.on('end', () => done(response.statusCode)); });
    sending.on('error', reject);
    sending.write(bytes.subarray(0, 100));
    finish = () => sending.end(bytes.subarray(100));
  });
  // Pieces she finished earlier, and a save that needs them afterwards.
  const source = randomBytes(100 * 1024), late = await ana.files(space).prepareWrite('attachments/late.bin', source, 0);
  await ana.files(space).uploadPieces(late, source);
  const db = app.database();
  assert.ok(db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE vaultId=? AND claimed=0').get(space.id).count > 0);
  const removed = await owner.call(`/spaces/${space.id}/members/${(await ana.call(`/spaces/${space.id}`)).body.me.accountId}`, undefined, 'DELETE');
  assert.deepEqual(removed, { status: 200, body: { ok: true, members: 2 } });
  // The body she was still sending is refused, her open pieces are gone, and her save cannot finish.
  await new Promise((done) => setTimeout(done, 50));
  finish();
  assert.equal(await answer, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE vaultId=? AND claimed=0').get(space.id).count, 0);
  db.close();
  await assert.rejects(ana.files(space).commitWrite(late, { source }), (error) => error.status === 401);
  assert.equal((await ana.inSpace(space.id, `/objects/${saved.id}`)).status, 401);
  assert.equal((await ana.inSpace(space.id, '/status')).status, 401);
  assert.deepEqual((await ana.call('/spaces')).body.spaces, []);
  assert.equal((await ana.call(`/spaces/${space.id}`)).status, 404);
  // Ben goes on, and Ana's own cloud still works.
  assert.equal((await ben.files(space).write('notes/a.md', text('second'), 1)).revision, 2);
  assert.equal((await ana.client.write('notes/mine.md', text('mine'), 0)).revision, 1);
  // Revoking a device works for every space at once, and clears its open pieces.
  const pairing = await ben.client.makePairing('Second');
  const second = person(app, await CloudClient.claim({ pairingCode: pairing.pairingCode }), {});
  const secondFiles = second.files({ id: space.id, key: space.key }), secondSource = randomBytes(100 * 1024);
  await secondFiles.uploadPieces(await secondFiles.prepareWrite('attachments/b.bin', secondSource, 0), secondSource);
  const before = app.database();
  assert.ok(before.prepare('SELECT COUNT(*) AS count FROM chunks WHERE deviceId=?').get(second.deviceId).count > 0);
  before.close();
  assert.equal((await ben.call(`/devices/${second.deviceId}`, undefined, 'DELETE')).status, 200);
  assert.equal((await second.inSpace(space.id, '/changes')).status, 401);
  const after = app.database();
  assert.equal(after.prepare('SELECT COUNT(*) AS count FROM chunks WHERE deviceId=?').get(second.deviceId).count, 0);
  after.close();
});

// Every route the server has behind device authorization, with a space in the header.
const id64 = 'a'.repeat(64), other = '12345678-1234-4234-8234-123456789012';
const refusedInSpace = [
  ['GET', '/account'], ['POST', '/account', {}], ['POST', '/account/totp', {}], ['POST', '/account/totp/enable', {}], ['POST', '/account/totp/disable', {}],
  ['GET', '/account/approvals'], ['POST', `/account/approvals/${other}`, {}], ['DELETE', `/account/approvals/${other}`, {}],
  ['POST', '/account/password', {}], ['POST', '/account/delete', { confirm: 'DELETE MY CLOUD' }], ['POST', '/recovery', { recoveryTokenHash: id64 }],
  ['POST', '/account/trial', {}], ['POST', '/account/checkout', { interval: 'month' }], ['GET', '/snapshot?at=2026-11-02T08:00:00Z'],
  ['GET', '/devices'], ['DELETE', `/devices/${other}`], ['POST', '/pairings', { deviceName: 'X', deviceTokenHash: id64, claimTokenHash: id64, envelope: '{}' }], ['GET', '/pieces/legacy'],
  ['POST', `/objects/${id64}/convert`, { from: id64 }], ['GET', `/objects/${id64}/uploads/0/${id64}`], ['POST', `/objects/${id64}/uploads/0/${id64}`, { size: 100 }], ['PUT', `/objects/${id64}/uploads/0/${id64}?offset=0`, {}], ['DELETE', `/objects/${id64}/uploads/0/${id64}`], ['POST', `/objects/${id64}/uploads/0/${id64}/commit`, {}],
  ['GET', '/spaces'], ['POST', '/spaces', {}], ['GET', `/spaces/${other}`], ['DELETE', `/spaces/${other}`], ['PUT', `/spaces/${other}/key`, {}], ['POST', `/spaces/${other}/invites`, {}], ['DELETE', `/spaces/${other}/invites/${other}`], ['DELETE', `/spaces/${other}/members/${other}`], ['POST', `/spaces/${other}/leave`, {}], ['POST', `/spaces/${other}/takeover`, {}], ['POST', `/spaces/${other}/replace`, {}], ['POST', `/invites/${other}/claim`, {}],
  // The allowed paths with another method, and a route nobody knows.
  ['POST', '/changes', {}], ['POST', '/status', {}], ['GET', '/chunks/missing'], ['DELETE', `/chunks/${id64}`], ['POST', `/objects/${id64}`, {}], ['GET', `/objects/${id64}/restore`], ['POST', `/objects/${id64}/history`, {}], ['GET', '/something-new'],
];

test('with a space in the header every route outside the allowed list is refused', async (t) => {
  const app = await fixture(t);
  const { owner, space, members: [ana] } = await group(app, 'owner', 'ana');
  await owner.files(space).write('notes/keep.md', text('keep'), 0);
  const devicesBefore = (await ana.call('/devices')).body.devices.length;
  for (const [method, path, body] of refusedInSpace) {
    for (const who of [ana, owner]) {
      const answer = await who.inSpace(space.id, path, body, method);
      assert.equal(answer.status, 403, `${method} ${path} gave ${answer.status}`);
    }
  }
  // Nothing happened: no deleted space or account, no new device, no pairing, no plan, no recovery change.
  assert.equal((await owner.files(space).listChanges()).changes.length, 1);
  assert.equal((await ana.call('/account')).status, 200);
  assert.equal((await ana.call('/devices')).body.devices.length, devicesBefore);
  const db = app.database();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM devices WHERE vaultId=?').get(space.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pairings').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM plans WHERE vaultId=?').get(space.id).count, 0);
  db.close();
});

test('the list of refused routes keeps up with the server', async () => {
  const source = await readFile(fileURLToPath(new URL('./server.mjs', import.meta.url)), 'utf8');
  const start = source.indexOf("const device = one('SELECT * FROM devices WHERE id=?', deviceId);");
  const routes = [...new Set([...source.slice(start).matchAll(/route === '(\/[^']*)'/g)].map((match) => match[1]))];
  const allowed = new Set(['/changes', '/status', '/chunks/missing']);
  assert.ok(routes.length > 15);
  for (const route of routes) if (!allowed.has(route)) assert.ok(refusedInSpace.some(([, path]) => path.split('?')[0] === route), `${route} has no refusal test`);
});

test('a recovery code never opens a space, and a space never gets an account', async (t) => {
  const app = await fixture(t);
  const { space, owner } = await group(app, 'owner');
  const recoveryToken = randomToken(), db = app.database();
  // Even with the right hash on the row, as a mistake elsewhere could leave it.
  db.prepare('UPDATE vaults SET recoveryHash=? WHERE id=?').run(await hashToken(recoveryToken), space.id);
  const recovered = await app.api('/recover', { vaultId: space.id, recoveryToken, deviceName: 'Thief', deviceTokenHash: await hashToken(randomToken()) });
  assert.equal(recovered.status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM devices WHERE vaultId=?').get(space.id).count, 0);
  assert.equal((await owner.inSpace(space.id, '/account', { email: 'x@example.test' })).status, 403);
  db.close();
});

test('a vault without an account cannot share, and /accounts/verify refuses a space', async (t) => {
  const app = await fixture(t);
  const { space } = await group(app, 'owner');
  const { client } = await CloudClient.create({ url: app.url(), enrollmentToken: app.enrollmentToken, deviceName: 'Lone' });
  const lone = person(app, client, {});
  assert.equal((await lone.call('/spaces')).status, 403);
  assert.equal((await lone.call('/spaces', { id: randomUUID(), nameEnvelope: '{}', wrapped: '{}' })).status, 403);
  assert.equal((await lone.call(`/invites/${randomUUID()}/claim`, { claimToken: randomToken() })).status, 403);
  // A signup pointed at a space by a damaged row still does not get an account.
  const started = await lone.call('/account', { email: 'late@example.test', authKey: randomToken(), kdf: { salt: b64(randomBytes(16)), memory: 65536, passes: 3, parallelism: 1 }, wrappedVaultKey: JSON.stringify(await encryptEnvelope(randomToken(), { vaultKey: client.credentials.vaultKey }, 'jotdrop:wrap:v1')) });
  assert.equal(started.status, 202);
  const db = app.database();
  db.prepare('UPDATE signups SET vaultId=?').run(space.id);
  db.close();
  const code = app.mails.filter((mail) => mail.to === 'late@example.test' && mail.kind === 'verify').at(-1).code;
  assert.equal((await app.api('/accounts/verify', { signupId: started.body.signupId, code })).status, 403);
});

test('another device of the same account gets its own key; nobody ever gets another member\'s', async (t) => {
  const app = await fixture(t);
  const { owner, space, members: [ana] } = await group(app, 'owner', 'ana');
  const pairing = await ana.client.makePairing('Tablet');
  const tablet = person(app, await CloudClient.claim({ pairingCode: pairing.pairingCode }), {});
  const view = (await tablet.call(`/spaces/${space.id}`)).body;
  const { spaceKey } = await decryptEnvelope(tablet.vaultKey, JSON.parse(view.me.wrapped), `jotdrop:space-key:v1:${tablet.vaultId}:${space.id}`);
  assert.equal(spaceKey, space.key);
  assert.equal(view.role, 'member');
  const ownerView = (await owner.call(`/spaces/${space.id}`)).body;
  assert.notEqual(ownerView.me.wrapped, view.me.wrapped);
  for (const reader of [view, ownerView]) {
    const others = JSON.stringify(reader.members);
    assert.ok(!others.includes('wrapped') && !others.includes('prefs'));
  }
  // Addresses for the owner only; open invitations too.
  assert.ok(ownerView.members.every((member) => member.email));
  assert.ok(view.members.every((member) => !('email' in member)));
  assert.ok(Array.isArray(ownerView.invites) && !('invites' in view));
  // Names and personal settings are per person; the owner cannot be replaced through them.
  const display = JSON.stringify(await encryptEnvelope(space.key, { name: 'Ana' }, `jotdrop:member-name:v1:${space.id}:${view.me.accountId}`));
  const prefs = JSON.stringify(await encryptEnvelope(ana.vaultKey, { pinned: ['notes/a.md'] }, `jotdrop:space-prefs:v1:${ana.vaultId}:${space.id}`));
  assert.equal((await ana.call(`/spaces/${space.id}/key`, { nameEnvelope: display, prefs }, 'PUT')).status, 200);
  const updated = (await tablet.call(`/spaces/${space.id}`)).body;
  assert.equal(updated.me.prefs, prefs);
  assert.equal(updated.me.wrapped, view.me.wrapped);
  assert.equal(updated.members.find((member) => member.accountId === view.me.accountId).nameEnvelope, display);
  // Personal settings have a limit, and do not count as storage.
  const big = JSON.stringify({ v: 1, iv: b64(randomBytes(12)), ciphertext: b64(randomBytes(70 * 1024)) });
  assert.equal((await ana.call(`/spaces/${space.id}/key`, { prefs: big }, 'PUT')).status, 400);
});

test('members see no billing data and no device IDs', async (t) => {
  const app = await fixture(t);
  const { owner, space, members: [ana] } = await group(app, 'owner', 'ana');
  const saved = await owner.files(space).write('notes/a.md', text('a'), 0);
  assert.equal((await owner.call('/account/trial', {})).status, 200);
  const status = (await ana.inSpace(space.id, '/status')).body;
  assert.deepEqual(Object.keys(status).sort(), ['pieces', 'plan', 'quotaBytes', 'sequence', 'usedBytes']);
  assert.deepEqual(Object.keys(status.plan).sort(), ['historyDays', 'name']);
  assert.equal(status.plan.name, 'plus');
  assert.equal(status.pieces.version, 1);
  assert.equal(status.pieces.legacy, 0);
  const changes = (await ana.inSpace(space.id, '/changes')).body.changes;
  const history = (await ana.inSpace(space.id, `/objects/${saved.id}/history`)).body.versions;
  const object = (await ana.inSpace(space.id, `/objects/${saved.id}`)).body;
  for (const entry of [...changes, ...history, object]) assert.ok(!('deviceId' in entry));
  assert.ok(!JSON.stringify([changes, history, object]).includes(owner.deviceId));
  // Their own cloud answers as it always did.
  const own = await owner.client.write('notes/own.md', text('own'), 0);
  assert.equal((await owner.call(`/objects/${own.id}`)).body.deviceId, owner.deviceId);
  assert.equal((await owner.call('/changes')).body.changes[0].deviceId, owner.deviceId);
});

test('an invitation works once, for one account, and survives a crash before the key is saved', async (t) => {
  const app = await fixture(t);
  const owner = await signUp(app, 'owner'), space = await newSpace(owner), ana = await signUp(app, 'ana'), ben = await signUp(app, 'ben');
  const link = await invite(owner, space);
  assert.equal(link.answer.status, 201);
  // Wrong or missing token, and a link for an invitation that does not exist, say the same.
  const wrong = await ana.call(`/invites/${link.id}/claim`, { claimToken: randomToken() }), unknown = await ana.call(`/invites/${randomUUID()}/claim`, { claimToken: link.claimToken });
  assert.equal(wrong.status, 404);
  assert.deepEqual(wrong, unknown);
  const first = await ana.call(`/invites/${link.id}/claim`, { claimToken: link.claimToken });
  assert.equal(first.status, 200);
  assert.equal(first.body.spaceId, space.id);
  // Someone else who got the link: visible as "already used", and no key.
  app.advance(MINUTE + 1);
  const late = await ben.call(`/invites/${link.id}/claim`, { claimToken: link.claimToken });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'invite-used');
  assert.ok(!('envelope' in late.body));
  // A crash between claim and saving: the same account gets the same envelope.
  const again = await ana.call(`/invites/${link.id}/claim`, { claimToken: link.claimToken });
  assert.deepEqual(again, first);
  // Member, but still without a key on the server: a second device could not get it yet.
  assert.equal((await ana.call(`/spaces/${space.id}`)).body.me.wrapped, null);
  await acceptKey(ana, link, again);
  // Now the sealed copy is gone and the link is worthless, also for the account that used it.
  const db = app.database();
  assert.equal(db.prepare('SELECT envelope FROM space_invites WHERE id=?').get(link.id).envelope, null);
  db.close();
  // She is in: a retry after a lost answer says so, instead of what a stranger hears.
  const retried = await ana.call(`/invites/${link.id}/claim`, { claimToken: link.claimToken });
  assert.equal(retried.status, 409);
  assert.equal(retried.body.code, 'already-member');
  assert.ok(!('envelope' in retried.body));
  // An owner can withdraw an open invitation, and nobody else can.
  app.advance(MINUTE + 1);
  const withdrawn = await invite(owner, space);
  assert.equal((await ana.call(`/spaces/${space.id}/invites/${withdrawn.id}`, undefined, 'DELETE')).status, 403);
  assert.equal((await owner.call(`/spaces/${space.id}/invites/${withdrawn.id}`, undefined, 'DELETE')).status, 200);
  assert.equal((await ben.call(`/invites/${withdrawn.id}/claim`, { claimToken: withdrawn.claimToken })).status, 404);
  // A member who is removed before saving the key cannot come back with the same link.
  app.advance(MINUTE + 1);
  const unsaved = await invite(owner, space);
  assert.equal((await ben.call(`/invites/${unsaved.id}/claim`, { claimToken: unsaved.claimToken })).status, 200);
  const benId = (await ben.call(`/spaces/${space.id}`)).body.me.accountId;
  assert.equal((await owner.call(`/spaces/${space.id}/members/${benId}`, undefined, 'DELETE')).status, 200);
  assert.equal((await ben.call(`/invites/${unsaved.id}/claim`, { claimToken: unsaved.claimToken })).status, 404);
  // Only the owner invites.
  const notOwner = await invite(ana, space);
  assert.equal(notOwner.answer.status, 403);
});

test('invitations stop at 7 days, at a frozen space, and at the member limit', async (t) => {
  const app = await fixture(t);
  const { owner, space } = await group(app, 'owner');
  const ana = await signUp(app, 'ana');
  const expired = await invite(owner, space);
  app.advance(7 * DAY + 1);
  assert.equal((await ana.call(`/invites/${expired.id}/claim`, { claimToken: expired.claimToken })).status, 410);
  // Twenty open at most.
  const open = [];
  for (let index = 0; index < 20; index++) open.push(await invite(owner, space));
  assert.ok(open.every((link) => link.answer.status === 201));
  assert.equal((await invite(owner, space)).answer.body.code, 'too-many-invites');
  // Twenty people at most: the owner plus nineteen.
  for (let index = 0; index < 19; index++) {
    const member = await signUp(app, `member${index}`);
    app.advance(MINUTE + 1);
    assert.equal((await member.call(`/invites/${open[index].id}/claim`, { claimToken: open[index].claimToken })).status, 200);
  }
  app.advance(MINUTE + 1);
  const full = await ana.call(`/invites/${open[19].id}/claim`, { claimToken: open[19].claimToken });
  assert.equal(full.status, 409);
  assert.equal(full.body.code, 'space-full');
  assert.equal((await invite(owner, space)).answer.body.code, 'space-full');
  // Frozen: a link made before the freeze no longer works.
  const small = await group(app, 'second-owner');
  const before = await invite(small.owner, small.space);
  const next = await newSpace(small.owner, { replaces: small.space.id });
  assert.equal(next.status, 201);
  assert.equal((await small.owner.call(`/spaces/${small.space.id}/replace`, { newSpaceId: next.id, expectedSequence: 0 })).status, 200);
  const frozen = await ana.call(`/invites/${before.id}/claim`, { claimToken: before.claimToken });
  assert.equal(frozen.status, 404, 'open invitations are wiped with the freeze');
  assert.equal((await invite(small.owner, small.space)).answer.body.code, 'space-frozen');
});

test('the free plan owns one live space, and Plus more; receiving is always free', async (t) => {
  const app = await fixture(t);
  const owner = await signUp(app, 'owner'), first = await newSpace(owner);
  assert.equal(first.status, 201);
  // Repeating the same request after a lost answer is not a second space.
  const repeat = await owner.call('/spaces', { id: first.id, nameEnvelope: JSON.stringify(await encryptEnvelope(first.key, { name: 'x' }, `jotdrop:space-name:v1:${first.id}`)), wrapped: await wrapFor(owner, first) });
  assert.equal(repeat.status, 200);
  const second = await newSpace(owner);
  assert.equal(second.status, 402);
  assert.equal(second.answer.body.code, 'plus-required');
  // A free account can be in as many as others invite it to.
  const ana = await signUp(app, 'ana'), anasOwn = await newSpace(ana);
  assert.equal(anasOwn.status, 201);
  await joinSpace(app, owner, first, ana);
  assert.equal((await ana.call('/spaces')).body.spaces.length, 2);
  // Plus owns more.
  assert.equal((await owner.call('/account/trial', {})).status, 200);
  app.advance(MINUTE + 1);
  assert.equal((await newSpace(owner)).status, 201);
  // Plus ended: what exists stays readable, and nothing new.
  app.advance(14 * DAY + 1);
  assert.equal((await newSpace(owner)).status, 402);
  assert.equal((await owner.inSpace(first.id, '/changes')).status, 200);
  assert.equal((await owner.inSpace(first.id, '/status')).body.plan.name, 'free');
});

test('removing someone stays possible on Free and after Plus: the replacement is exempt, and cannot be abused', async (t) => {
  const app = await fixture(t);
  const { owner, space, members: [ana, ben] } = await group(app, 'owner', 'ana', 'ben');
  const noted = await owner.files(space).write('notes/a.md', text('a'), 0);
  const anaId = (await ana.call(`/spaces/${space.id}`)).body.me.accountId;
  assert.equal((await owner.call(`/spaces/${space.id}/members/${anaId}`, undefined, 'DELETE')).status, 200);
  // Free with one space: another is refused, its replacement is not.
  assert.equal((await newSpace(owner)).status, 402);
  const next = await newSpace(owner, { replaces: space.id });
  assert.equal(next.status, 201);
  // A second device of the owner gets the running replacement back instead of a third space.
  const pairing = await owner.client.makePairing('Tablet');
  const tablet = person(app, await CloudClient.claim({ pairingCode: pairing.pairingCode }), {});
  const parallel = await newSpace(tablet, { replaces: space.id });
  assert.equal(parallel.status, 200);
  assert.equal(parallel.answer.body.id, next.id);
  // Unfinished: no chain, no second Free space, no invitations.
  const chain = await newSpace(owner, { replaces: next.id });
  assert.equal(chain.status, 409);
  assert.equal(chain.answer.body.code, 'space-unfinished');
  assert.equal((await newSpace(owner)).status, 402);
  assert.equal((await invite(owner, next)).answer.body.code, 'space-unfinished');
  assert.equal((await owner.call(`/spaces/${next.id}`)).body.unfinished, true);
  assert.equal((await owner.call(`/spaces/${next.id}`)).body.members.length, 1);
  // Not somebody else's space, and only one per space.
  const stranger = await signUp(app, 'stranger');
  assert.equal((await newSpace(stranger, { replaces: space.id })).status, 404);
  // A change during the copy: try again with the new position.
  await owner.files(next).write('notes/a.md', text('a'), 0);
  const copiedAt = await sequenceOf(owner, space);
  await ben.files(space).write('notes/a.md', text('changed by ben'), noted.revision);
  const late = await owner.call(`/spaces/${space.id}/replace`, { newSpaceId: next.id, expectedSequence: copiedAt });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'space-changed');
  assert.equal(late.body.sequence, await sequenceOf(owner, space));
  assert.equal((await owner.inSpace(space.id, '/status')).status, 200);
  const done = await owner.call(`/spaces/${space.id}/replace`, { newSpaceId: next.id, expectedSequence: late.body.sequence });
  assert.equal(done.status, 200);
  // Repeating is fine; the old space is frozen and points at the new one, for everybody still in it.
  assert.equal((await owner.call(`/spaces/${space.id}/replace`, { newSpaceId: next.id, expectedSequence: 0 })).status, 200);
  const list = (await ben.call('/spaces')).body.spaces;
  assert.deepEqual(list, [{ id: space.id, sequence: late.body.sequence, frozen: true, replacedBy: next.id }]);
  await assert.rejects(ben.files(space).write('notes/a.md', text('late'), 2), (error) => error.status === 403);
  assert.equal(new TextDecoder().decode((await ben.files(space).read(noted.id)).file.bytes), 'changed by ben');
  // The new one is finished: invitations are open, it counts as the one Free space, and its old space does not.
  assert.equal((await owner.call(`/spaces/${next.id}`)).body.unfinished, false);
  assert.equal((await newSpace(owner)).status, 402);
  await joinSpace(app, owner, next, ben);
  assert.equal((await ben.files(next).write('notes/b.md', text('b'), 0)).revision, 1);
  // Only the owner replaces.
  assert.equal((await ben.call(`/spaces/${next.id}/replace`, { newSpaceId: space.id, expectedSequence: 0 })).status, 403);
  // Old space gone after 30 days.
  app.advance(30 * DAY + 1);
  await app.sweep();
  assert.deepEqual((await ben.call('/spaces')).body.spaces.map((entry) => entry.id), [next.id]);
});

test('an owner who was on Plus can still remove someone from each group', async (t) => {
  const app = await fixture(t);
  const owner = await signUp(app, 'owner');
  assert.equal((await owner.call('/account/trial', {})).status, 200);
  const first = await newSpace(owner), second = await newSpace(owner);
  assert.deepEqual([first.status, second.status], [201, 201]);
  app.advance(14 * DAY + 1);
  const next = await newSpace(owner, { replaces: first.id });
  assert.equal(next.status, 201);
  assert.equal((await owner.call(`/spaces/${first.id}/replace`, { newSpaceId: next.id, expectedSequence: 0 })).status, 200);
  const other = await newSpace(owner, { replaces: second.id });
  assert.equal(other.status, 201);
  assert.equal((await owner.call(`/spaces/${second.id}/replace`, { newSpaceId: other.id, expectedSequence: 0 })).status, 200);
});

test('an unfinished replacement disappears after 48 hours, and the old space keeps working', async (t) => {
  const app = await fixture(t);
  const { owner, space, members: [ana] } = await group(app, 'owner', 'ana');
  const next = await newSpace(owner, { replaces: space.id });
  await owner.files(next).write('notes/copy.md', text('copy'), 0);
  app.advance(47 * 60 * 60 * 1000);
  await app.sweep();
  assert.equal((await owner.call(`/spaces/${next.id}`)).status, 200);
  app.advance(2 * 60 * 60 * 1000);
  await app.sweep();
  assert.equal((await owner.call(`/spaces/${next.id}`)).status, 404);
  assert.equal((await ana.files(space).write('notes/still.md', text('still'), 0)).revision, 1);
  const db = app.database();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM vaults WHERE id=?').get(next.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM revisions WHERE vaultId=?').get(next.id).count, 0);
  db.close();
  // The owner can begin again.
  assert.equal((await newSpace(owner, { replaces: space.id })).status, 201);
});

test('a full space can be replaced next to itself, without using the owner\'s own room', async (t) => {
  // Spaces share half: 60 KB.
  const app = await fixture(t, { quotaBytes: 120 * 1024 });
  const { owner, space, members: [ana] } = await group(app, 'owner', 'ana');
  const big = randomBytes(20 * 1024);
  await ana.files(space).write('attachments/big.bin', big, 0);
  const next = await newSpace(owner, { replaces: space.id });
  // The same bytes again fit in the new space while the old one still holds them.
  await owner.files(next).write('attachments/big.bin', big, 0);
  // For the old space and the owner's own cloud they do count.
  await assert.rejects(ana.files(space).write('attachments/more.bin', randomBytes(20 * 1024), 0), (error) => error.status === 507 && error.code === 'storage-full');
  // A chain of these is not possible, so this is the only place where the limit is bent.
  assert.equal((await newSpace(owner, { replaces: next.id })).status, 409);
});

test('a finished replacement does not block the owner\'s own notes, and a chain of replacements gains no room', async (t) => {
  const quotaBytes = 200 * 1024;
  const app = await fixture(t, { quotaBytes });
  const { owner, space, members: [ana] } = await group(app, 'owner', 'ana');
  await owner.client.write('notes/mine.md', randomBytes(20 * 1024), 0);
  const large = randomBytes(90 * 1024);
  await ana.files(space).write('attachments/big.bin', large, 0);
  const next = await newSpace(owner, { replaces: space.id });
  await owner.files(next).write('attachments/big.bin', large, 0);
  assert.equal((await owner.call(`/spaces/${space.id}/replace`, { newSpaceId: next.id, expectedSequence: await sequenceOf(owner, space) })).status, 200);
  // The old copy goes within 30 days: it does not count against the owner's own notes meanwhile.
  assert.equal((await owner.client.write('notes/short.md', text('still works'), 0)).revision, 1);
  const status = await owner.client.status();
  assert.ok(status.usedBytes <= status.quotaBytes, `${status.usedBytes} of ${status.quotaBytes}`);
  // It does keep counting between spaces, so replacing again and again never makes extra room.
  const third = await newSpace(owner, { replaces: next.id });
  assert.equal(third.status, 201);
  await assert.rejects(owner.files(third).write('attachments/big.bin', large, 0), (error) => error.status === 507 && error.code === 'storage-full');
});

test('storage: own cloud and spaces count together, spaces get half, and members cannot crowd out the owner', async (t) => {
  const quotaBytes = 200 * 1024;
  const app = await fixture(t, { quotaBytes });
  const { owner, space, members: [ana] } = await group(app, 'owner', 'ana');
  // Half is 100 KB. Ana fills most of it; the rest is refused, and her file stays with her.
  await ana.files(space).write('attachments/one.bin', randomBytes(90 * 1024), 0);
  await assert.rejects(ana.files(space).write('attachments/two.bin', randomBytes(30 * 1024), 0), (error) => error.status === 507 && error.code === 'storage-full');
  const reported = (await ana.inSpace(space.id, '/status')).body;
  assert.equal(reported.quotaBytes, quotaBytes / 2);
  // The owner's own half is free whatever members do.
  await owner.client.write('attachments/own.bin', randomBytes(80 * 1024), 0);
  const own = (await owner.client.status());
  assert.ok(own.usedBytes >= 170 * 1024, 'the owner sees spaces in their usage');
  assert.equal(own.quotaBytes, quotaBytes);
  // Together they stop at the quota: the owner's next file does not fit either.
  await assert.rejects(owner.client.write('attachments/own2.bin', randomBytes(40 * 1024), 0), (error) => error.status === 507);
  // Ana's own cloud is hers: the space does not count there.
  assert.equal((await ana.client.write('attachments/hers.bin', randomBytes(100 * 1024), 0)).revision, 1);
  assert.ok((await ana.client.status()).usedBytes < 110 * 1024);
});

test('after Plus ends a space that no longer fits is read-only until it fits again', async (t) => {
  const app = await fixture(t, { quotaBytes: 100 * 1024, plusQuotaBytes: 1024 * 1024 });
  const { owner, space, members: [ana] } = await group(app, 'owner', 'ana');
  assert.equal((await owner.call('/account/trial', {})).status, 200);
  const big = await ana.files(space).write('attachments/big.bin', randomBytes(70 * 1024), 0);
  const small = await ana.files(space).write('notes/small.md', text('small'), 0);
  app.advance(14 * DAY + 1);
  // Everyone can still read, nobody can write: not even a change that makes no difference in size.
  assert.equal((await ana.files(space).read(small.id)).file.path, 'notes/small.md');
  await assert.rejects(ana.files(space).write('notes/small.md', text('edit'), 1), (error) => error.status === 507 && error.code === 'storage-full');
  await assert.rejects(owner.files(space).remove(small.id, 1), (error) => error.status === 507);
  // Plus again, and it works.
  const db = app.database();
  db.prepare('UPDATE plans SET plusUntil=? WHERE vaultId=?').run(app.time() + 30 * DAY, owner.vaultId);
  db.close();
  assert.equal((await ana.files(space).write('notes/small.md', text('edit'), 1)).revision, 2);
  assert.ok(big.id);
});

test('one member cannot block another with unfinished uploads', async (t) => {
  const app = await fixture(t);
  const { owner, space, members: [ana, ben] } = await group(app, 'owner', 'ana', 'ben');
  const db = app.database();
  const device = (name) => db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE deviceId=? AND claimed=0').get(name).count;
  const send = async (who, count) => {
    const statuses = [];
    for (let index = 0; index < count; index++) {
      const bytes = randomBytes(40), name = createHash('sha256').update(bytes).digest('hex');
      const response = await fetch(`${app.url()}/api/v1/chunks/${name}`, { method: 'PUT', headers: { ...who.headers, 'X-JotDrop-Vault': space.id, 'Content-Type': 'application/octet-stream' }, body: bytes });
      statuses.push(response.status);
      await response.text();
    }
    return statuses;
  };
  // Ana fills her own allowance of open pieces (200 per device), and then only she is refused.
  assert.ok((await send(ana, 200)).every((status) => status === 200));
  assert.equal(device(ana.deviceId), 200);
  assert.deepEqual(await send(ana, 1), [507]);
  assert.deepEqual(await send(ben, 1), [200]);
  // Saving a version takes a piece out of the count and forgets who sent it.
  assert.equal((await ben.files(space).write('attachments/ok.bin', randomBytes(80 * 1024), 0)).revision, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE claimed=1 AND deviceId IS NOT NULL').get().count, 0);
  // Removing her clears what she left behind.
  const anaId = (await ana.call(`/spaces/${space.id}`)).body.me.accountId;
  assert.equal((await owner.call(`/spaces/${space.id}/members/${anaId}`, undefined, 'DELETE')).status, 200);
  assert.equal(device(ana.deviceId), 0);
  db.close();
});

test('leaving: a member goes alone, an owner leaves the space frozen, and the last one out removes it', async (t) => {
  const app = await fixture(t);
  const { owner, space, members: [ana, ben] } = await group(app, 'owner', 'ana', 'ben');
  const noted = await ana.files(space).write('notes/a.md', text('a'), 0);
  assert.equal((await ben.call(`/spaces/${space.id}/leave`, {})).status, 200);
  assert.equal((await ben.inSpace(space.id, '/changes')).status, 401);
  assert.equal((await ben.call(`/spaces/${space.id}`)).status, 404);
  assert.equal((await ana.files(space).write('notes/a.md', text('b'), 1)).revision, 2);
  // Only the owner removes others, and nobody removes themselves that way.
  const ownerId = (await owner.call(`/spaces/${space.id}`)).body.me.accountId;
  assert.equal((await ana.call(`/spaces/${space.id}/members/${ownerId}`, undefined, 'DELETE')).status, 403);
  assert.equal((await owner.call(`/spaces/${space.id}/members/${ownerId}`, undefined, 'DELETE')).status, 400);
  assert.equal((await ana.call(`/spaces/${space.id}`, undefined, 'DELETE')).status, 403);
  // The owner leaves: frozen, and the remaining member still reads.
  assert.equal((await owner.call(`/spaces/${space.id}/leave`, {})).status, 200);
  const view = (await ana.call(`/spaces/${space.id}`)).body;
  assert.equal(view.frozen, true);
  assert.ok(view.ownerGoneAt);
  assert.equal(view.canTakeOver, true);
  assert.equal((await ana.files(space).read(noted.id)).file.path, 'notes/a.md');
  await assert.rejects(ana.files(space).write('notes/a.md', text('c'), 2), (error) => error.status === 403);
  // The last one out: gone.
  assert.equal((await ana.call(`/spaces/${space.id}/leave`, {})).status, 200);
  const db = app.database();
  for (const table of ['spaces', 'vaults']) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE id=?`).get(space.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM revisions WHERE vaultId=?').get(space.id).count, 0);
  db.close();
});

test('the owner can remove a whole space', async (t) => {
  const app = await fixture(t);
  const { owner, space, members: [ana] } = await group(app, 'owner', 'ana');
  await ana.files(space).write('attachments/big.bin', randomBytes(80 * 1024), 0);
  assert.equal((await owner.call(`/spaces/${space.id}`, undefined, 'DELETE')).status, 200);
  assert.equal((await ana.inSpace(space.id, '/changes')).status, 401);
  const db = app.database();
  for (const table of ['chunks', 'envelopes', 'revisions', 'changes', 'envelope_chunks']) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE vaultId=?`).get(space.id).count, 0, table);
  for (const table of ['space_members', 'space_keys', 'space_invites']) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE spaceId=?`).get(space.id).count, 0, table);
  db.close();
  // Room again for a Free owner.
  assert.equal((await newSpace(owner)).status, 201);
});

test('deleting an account: what they wrote stays with the others, without their device, and an open upload does not get in the way', async (t) => {
  const app = await fixture(t);
  const { owner, space, members: [ana, ben] } = await group(app, 'owner', 'ana', 'ben');
  const anasSpace = await newSpace(ana), lonely = await signUp(app, 'lonely'), lonelySpace = await newSpace(lonely);
  await joinSpace(app, ana, anasSpace, ben);
  const saved = await ana.files(space).write('notes/hers.md', text('written by ana'), 0);
  // A piece she has not used yet.
  const source = randomBytes(100 * 1024), files = ana.files(space);
  await files.uploadPieces(await files.prepareWrite('attachments/open.bin', source, 0), source);
  const anaId = (await ana.call(`/spaces/${space.id}`)).body.me.accountId;
  const deleted = await ana.call('/account/delete', { confirm: 'DELETE MY CLOUD', currentAuthKey: ana.authKey });
  assert.equal(deleted.status, 200);
  const db = app.database();
  // She is out of every space, and the space she owned waits for Ben.
  for (const table of ['space_members', 'space_keys']) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE accountId=?`).get(anaId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE vaultId=? AND claimed=0').get(space.id).count, 0);
  const rows = db.prepare('SELECT deviceId FROM revisions WHERE vaultId=? UNION ALL SELECT deviceId FROM changes WHERE vaultId=?').all(space.id, space.id);
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((row) => row.deviceId === 'removed'));
  assert.ok(db.prepare('SELECT ownerGoneAt FROM spaces WHERE id=?').get(anasSpace.id).ownerGoneAt);
  db.close();
  assert.equal(new TextDecoder().decode((await ben.files(space).read(saved.id)).file.bytes), 'written by ana');
  assert.equal((await owner.files(space).write('notes/hers.md', text('still here'), 1)).revision, 2);
  // Alone in a space: removed along with the account.
  assert.equal((await lonely.call('/account/delete', { confirm: 'DELETE MY CLOUD', currentAuthKey: lonely.authKey })).status, 200);
  const after = app.database();
  assert.equal(after.prepare('SELECT COUNT(*) AS count FROM spaces WHERE id=?').get(lonelySpace.id).count, 0);
  assert.deepEqual(after.prepare('PRAGMA foreign_key_check').all(), []);
  after.close();
  // Her wiped device can do nothing.
  assert.equal((await ana.inSpace(space.id, '/changes')).status, 401);
});

test('starting over with a new vault key leaves every space the same way', async (t) => {
  const app = await fixture(t);
  const { owner, space, members: [ana] } = await group(app, 'owner', 'ana');
  await owner.files(space).write('notes/a.md', text('a'), 0);
  app.advance(MINUTE + 1);
  const { resetId } = (await app.api('/auth/reset/start', { email: owner.email })).body;
  const code = app.mails.filter((mail) => mail.kind === 'reset').at(-1).code, token = randomToken();
  const restarted = await app.api('/auth/reset/restart', { resetId, code, confirm: 'DELETE CLOUD DATA', recoveryTokenHash: await hashToken(randomToken()), deviceName: 'New', deviceTokenHash: await hashToken(token), authKey: randomToken(), kdf: { salt: b64(randomBytes(16)), memory: 65536, passes: 3, parallelism: 1 }, wrappedVaultKey: JSON.stringify(await encryptEnvelope(randomToken(), { vaultKey: generateVaultKey() }, 'jotdrop:wrap:v1')) });
  assert.equal(restarted.status, 201);
  const view = (await ana.call(`/spaces/${space.id}`)).body;
  assert.equal(view.frozen, true);
  assert.ok(view.ownerGoneAt);
  assert.equal(view.members.length, 1);
  // Starting over leaves no way back in with the old key rows.
  const fresh = new CloudClient({ url: app.url(), vaultId: restarted.body.vaultId, deviceId: restarted.body.deviceId, token, vaultKey: generateVaultKey() });
  const again = person(app, fresh, {});
  assert.deepEqual((await again.call('/spaces')).body.spaces, []);
  assert.equal((await again.inSpace(space.id, '/changes')).status, 401);
});

test('owner gone: the longest-standing member takes over at once, others after a week, and nobody means gone after 30 days', async (t) => {
  const app = await fixture(t);
  const { owner, space, members: [ana, ben] } = await group(app, 'owner', 'ana', 'ben');
  const noted = await ana.files(space).write('notes/a.md', text('a'), 0);
  const open = await invite(owner, space);
  assert.equal((await owner.call(`/spaces/${space.id}/leave`, {})).status, 200);
  // Not a Free user's second space, and not a space that does not fit: checked below. Ben waits a week.
  const notYet = await ben.call(`/spaces/${space.id}/takeover`, {});
  assert.equal(notYet.status, 403);
  assert.equal(notYet.body.code, 'not-yet');
  assert.equal((await ben.call(`/spaces/${space.id}`)).body.canTakeOver, false);
  // A change of owner clears open invitations.
  assert.equal((await ben.call(`/invites/${open.id}/claim`, { claimToken: open.claimToken })).status, 404);
  assert.equal((await ana.call(`/spaces/${space.id}/takeover`, {})).status, 200);
  const view = (await ana.call(`/spaces/${space.id}`)).body;
  assert.equal(view.role, 'owner');
  assert.equal(view.frozen, false);
  assert.equal(view.ownerGoneAt, null);
  // Same key, same versions, and Ana's plan and storage now.
  assert.equal((await ben.files(space).write('notes/a.md', text('b'), noted.revision)).revision, 2);
  assert.equal((await ana.client.status()).usedBytes > 0, true);
  // A member after a week.
  const second = await group(app, 'second', 'carl', 'dana');
  assert.equal((await second.owner.call(`/spaces/${second.space.id}/leave`, {})).status, 200);
  const [carl, dana] = second.members;
  assert.equal((await dana.call(`/spaces/${second.space.id}/takeover`, {})).status, 403);
  app.advance(7 * DAY + 1);
  assert.equal((await dana.call(`/spaces/${second.space.id}/takeover`, {})).status, 200);
  assert.equal((await carl.call(`/spaces/${second.space.id}`)).body.role, 'member');
  // Nobody within 30 days: gone, for everyone.
  const third = await group(app, 'third', 'eve');
  assert.equal((await third.owner.call(`/spaces/${third.space.id}/leave`, {})).status, 200);
  app.advance(30 * DAY + 1);
  await app.sweep();
  assert.equal((await third.members[0].call(`/spaces/${third.space.id}`)).status, 404);
  assert.equal((await third.members[0].inSpace(third.space.id, '/changes')).status, 401);
});

test('taking over needs room on the new owner\'s plan and storage', async (t) => {
  const app = await fixture(t, { quotaBytes: 100 * 1024 });
  const { owner, space, members: [ana] } = await group(app, 'owner', 'ana');
  // Ana already has her one Free space.
  const anasOwn = await newSpace(ana);
  assert.equal(anasOwn.status, 201);
  assert.equal((await owner.call(`/spaces/${space.id}/leave`, {})).status, 200);
  const blocked = await ana.call(`/spaces/${space.id}/takeover`, {});
  assert.equal(blocked.status, 402);
  assert.equal(blocked.body.code, 'plus-required');
  assert.equal((await ana.call(`/spaces/${anasOwn.id}`, undefined, 'DELETE')).status, 200);
  // Her own cloud is so full that a space would not fit in what is left for spaces.
  await ana.client.write('attachments/own.bin', randomBytes(95 * 1024), 0);
  const db = app.database();
  db.prepare('INSERT INTO chunks(vaultId,name,size,data,createdAt,claimed) VALUES(?,?,?,?,?,1)').run(space.id, 'a'.repeat(64), 30 * 1024, Buffer.alloc(1), app.time());
  db.close();
  const full = await ana.call(`/spaces/${space.id}/takeover`, {});
  assert.equal(full.status, 507);
  assert.equal(full.body.code, 'storage-full');
  // A replaced space is not available to take over.
  const replaced = await group(app, 'fourth', 'fay');
  const next = await newSpace(replaced.owner, { replaces: replaced.space.id });
  assert.equal((await replaced.owner.call(`/spaces/${replaced.space.id}/replace`, { newSpaceId: next.id, expectedSequence: 0 })).status, 200);
  assert.equal((await replaced.owner.call(`/spaces/${replaced.space.id}/leave`, {})).status, 200);
  const unavailable = await replaced.members[0].call(`/spaces/${replaced.space.id}/takeover`, {});
  assert.equal(unavailable.status, 409);
  assert.equal(unavailable.body.code, 'not-available');
});

test('a member\'s versions can be restored, on the owner\'s plan', async (t) => {
  const app = await fixture(t);
  const { owner, space, members: [ana] } = await group(app, 'owner', 'ana');
  const first = await owner.files(space).write('notes/a.md', text('good'), 0);
  await ana.files(space).remove(first.id, 1);
  assert.equal((await owner.files(space).read(first.id)).deleted, true);
  // Restoring is a write and is allowed; the free plan's lock is the owner's.
  const restored = await owner.files(space).restore(first.id, 1, 2);
  assert.equal(restored.revision, 3);
  assert.equal((await ana.files(space).read(first.id, 1)).deleted, false);
  app.advance(31 * DAY);
  await owner.files(space).write('notes/a.md', text('newer'), 3);
  app.advance(31 * DAY);
  assert.equal((await ana.inSpace(space.id, `/objects/${first.id}?revision=1`)).status, 402);
});

test('the database holds no readable name, note or link', async (t) => {
  const app = await fixture(t);
  const owner = await signUp(app, 'owner'), ana = await signUp(app, 'ana');
  const name = 'SECRETSPACENAME', note = 'SECRETNOTEBODY', display = 'SECRETDISPLAYNAME', inviter = 'SECRETINVITERNAME';
  const space = await newSpace(owner, { name });
  const link = await invite(owner, space, inviter);
  const answer = await ana.call(`/invites/${link.id}/claim`, { claimToken: link.claimToken });
  await acceptKey(ana, link, answer);
  const anaId = (await ana.call(`/spaces/${space.id}`)).body.me.accountId;
  await ana.call(`/spaces/${space.id}/key`, { nameEnvelope: JSON.stringify(await encryptEnvelope(space.key, { name: display }, `jotdrop:member-name:v1:${space.id}:${anaId}`)) }, 'PUT');
  await ana.files(space).write('notes/secret-path.md', text(note), 0);
  const db = app.database();
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  let stored = Buffer.alloc(0);
  for (const file of ['cloud.db', 'cloud.db-wal']) stored = Buffer.concat([stored, await readFile(join(app.dataDir, file)).catch(() => Buffer.alloc(0))]);
  for (const secret of [name, note, display, inviter, 'secret-path', link.claimToken, link.wrappingKey, space.key]) assert.ok(!stored.includes(secret), `${secret} is readable`);
});

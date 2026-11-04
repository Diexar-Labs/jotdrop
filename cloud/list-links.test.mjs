import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCloudServer } from './server.mjs';
import { createLink, removeLink } from './shared/links.mjs';
import { addItem, createListLink, listListLinks, openList, readListLinkAddress, removeListLink, reportList, syncList, tickItem, writeProof } from './shared/list-links.mjs';
import { CloudClient } from './shared/client.mjs';
import { encryptEnvelope, generateVaultKey, hashToken, randomToken } from './shared/crypto.mjs';

// The server side of a list link: what cloud/shared/list-links.test.mjs plays against a server in memory, here against the real one.
const DAY = 24 * 60 * 60 * 1000, MINUTE = 60 * 1000;
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-lists-test-'));
  const mails = [];
  let now = Date.parse('2026-11-04T18:00:00Z');
  const app = await createCloudServer({ dataDir, signupTrial: 0, mailer: async (mail) => { mails.push(mail); }, serverKey: randomToken(), enrollmentToken: randomToken(), clock: () => now, freeDeviceLimit: 100, signupsPerAddress: 1000, sweepEvery: 10 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = () => `http://127.0.0.1:${app.port}`;
  const api = async (path, body, headers = {}, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${url()}/api/v1${path}`, { method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const answer = await response.text();
    return { status: response.status, body: answer ? JSON.parse(answer) : undefined };
  };
  return { dataDir, mails, url, api, now: () => now, advance: (ms) => { now += ms; }, sweep: () => new Promise((done) => setTimeout(done, 60)) };
}

async function signUp(app, name) {
  app.advance(MINUTE + 1);
  const email = `${name}@example.test`, vaultKey = generateVaultKey(), token = randomToken();
  const started = await app.api('/accounts', { email, authKey: randomToken(), kdf: { salt: b64(randomBytes(16)), memory: 65536, passes: 3, parallelism: 1 }, wrappedVaultKey: JSON.stringify(await encryptEnvelope(randomToken(), { vaultKey }, 'jotdrop:wrap:v1')), recoveryTokenHash: await hashToken(randomToken()), deviceName: 'Phone', deviceTokenHash: await hashToken(token) });
  assert.equal(started.status, 202);
  const code = app.mails.filter((mail) => mail.to === email && mail.kind === 'verify').at(-1).code;
  const verified = await app.api('/accounts/verify', { signupId: started.body.signupId, code });
  assert.equal(verified.status, 201);
  return { email, client: new CloudClient({ url: app.url(), vaultId: verified.body.vaultId, deviceId: verified.body.deviceId, token, vaultKey }) };
}

const groceries = { title: 'Groceries', text: '# Groceries\n- [ ] milk\n- [ ] eggs\n- [ ] bread\n' };
const at = Date.parse('2026-11-04T18:00:00Z');
const share = (client, app, extra = {}) => createListLink(client, groceries, { origin: app.url(), path: 'notes/Groceries.md', noteRevision: 1, ...extra });
const refused = async (promise, status, code) => {
  await assert.rejects(promise, (error) => { assert.equal(error.status, status); if (code) assert.equal(error.code, code); return true; });
};
// A guest's raw write, for what the shared code never sends.
const rawPut = (app, id, body) => app.api(`/public-lists/${id}`, body, {}, 'PUT');
const row = (app, id) => { const db = new DatabaseSync(join(app.dataDir, 'cloud.db')); try { return db.prepare('SELECT * FROM list_links WHERE id=?').get(id); } finally { db.close(); } };

test('anyone with the link reads and ticks the list; the server has sealed text, a number and a hash of the proof', async (t) => {
  const app = await fixture(t);
  const me = await signUp(app, 'ana');
  const link = await share(me.client, app);
  assert.match(link.address, new RegExp(`^${app.url()}/l/[0-9a-f-]{36}#[\\w-]{43}$`));
  const { id, key } = readListLinkAddress(link.address);
  const raw = await app.api(`/public-lists/${id}`);
  assert.equal(raw.status, 200);
  assert.deepEqual(Object.keys(raw.body).sort(), ['envelope', 'expiresAt', 'revision']);
  assert.equal(raw.body.revision, 1);
  assert.ok(!JSON.stringify(raw.body).includes('milk') && !JSON.stringify(raw.body).includes('ana@'));
  const stored = row(app, id);
  assert.ok(!JSON.stringify(stored).includes('milk') && !JSON.stringify(stored).includes(key));
  assert.equal(stored.writeProofHash, hash(await writeProof(key)));
  assert.deepEqual([stored.revision, stored.createdAt, stored.updatedAt, stored.expiresAt], [1, app.now(), app.now(), app.now() + 7 * DAY]);

  let anna = await openList(app.url(), id, key);
  assert.deepEqual({ title: anna.title, text: anna.text, revision: anna.revision, marks: anna.marks }, { ...groceries, revision: 1, marks: [] });
  await assert.rejects(openList(app.url(), id, generateVaultKey()));
  anna = await tickItem(app.url(), id, key, anna, anna.lines[1], true, { name: 'Anna', now: at });
  anna = await addItem(app.url(), id, key, anna, 'butter', { name: 'Anna', now: at });
  assert.deepEqual([anna.revision, anna.text], [3, '# Groceries\n- [x] milk\n- [ ] eggs\n- [ ] bread\n- [ ] butter\n']);
  const seen = await openList(app.url(), id, key);
  assert.deepEqual([seen.revision, seen.text, seen.lines.map((line) => line.mark?.by ?? null)], [3, anna.text, [null, 'Anna', null, null, 'Anna', null]]);
  assert.equal((await app.api(`/public-lists/${id}`)).body.revision, 3);

  // Two guests from the same version: the second one tries again on the newest, and both changes stay.
  const ben = await openList(app.url(), id, key), cora = await openList(app.url(), id, key);
  const ben2 = await tickItem(app.url(), id, key, ben, ben.lines[2], true, { name: 'Ben', now: at });
  const cora2 = await addItem(app.url(), id, key, cora, 'jam', { name: 'Cora', now: at });
  assert.deepEqual([ben2.revision, cora2.revision, cora2.text], [4, 5, '# Groceries\n- [x] milk\n- [x] eggs\n- [ ] bread\n- [ ] butter\n- [ ] jam\n']);

  // Without the proof, on an old number, or malformed: refused, and the list stays as it is.
  const envelope = (await app.api(`/public-lists/${id}`)).body.envelope;
  const proof = await writeProof(key);
  assert.equal((await rawPut(app, id, { envelope, baseRevision: 5, writeProof: hash('guess') })).status, 403);
  const stale = await rawPut(app, id, { envelope, baseRevision: 4, writeProof: proof });
  assert.deepEqual([stale.status, stale.body.currentRevision], [409, 5]);
  assert.equal((await rawPut(app, id, { envelope, baseRevision: 0, writeProof: proof })).status, 400);
  assert.equal((await rawPut(app, id, { envelope, baseRevision: 5 })).status, 400);
  assert.equal((await rawPut(app, id, { envelope: '{"v":1}', baseRevision: 5, writeProof: proof })).status, 400);
  assert.equal((await rawPut(app, id, { envelope, baseRevision: 5, writeProof: proof })).status, 200);
  assert.equal((await app.api(`/public-lists/${id}`)).body.revision, 6);
  assert.equal((await app.api(`/public-lists/${randomUUID()}`)).status, 404);
  assert.equal((await app.api('/public-lists/not-an-id')).status, 400);
  assert.equal((await rawPut(app, randomUUID(), { envelope, baseRevision: 1, writeProof: proof })).status, 404);
});

test('the list page holds no list, and search engines stay out', async (t) => {
  const app = await fixture(t);
  const me = await signUp(app, 'ana');
  const { id } = await share(me.client, app);
  const page = await fetch(`${app.url()}/l/${id}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const html = await page.text();
  assert.ok(html.includes('list-link.js') && !html.includes('milk'));
  assert.equal((await fetch(`${app.url()}/list-link.js`)).status, 200);
  assert.equal((await fetch(`${app.url()}/shared/list-links.mjs`)).status, 200);
  assert.equal((await fetch(`${app.url()}/l/not-a-link`)).status, 404);
});

test('the owner takes over what guests did and writes its own changes back; the listing carries the number and the time', async (t) => {
  const app = await fixture(t);
  const me = await signUp(app, 'ana');
  const link = await share(me.client, app);
  const anna = await openList(app.url(), link.id, link.key);
  await tickItem(app.url(), link.id, link.key, anna, anna.lines[1], true, { name: 'Anna', now: at });
  const mine = async () => (await listListLinks(me.client, app.url()))[0];
  const sync = async (note, noteRevision, extra = {}) => syncList(me.client, await mine(), { note, noteRevision, ownerName: 'Eric', now: at, ...extra });
  const first = await mine();
  assert.deepEqual([first.id, first.revision, first.updatedAt, first.expiresAt, first.title, first.path, first.key, first.base, first.address], [link.id, 2, new Date(app.now()).toISOString(), new Date(app.now() + 7 * DAY).toISOString(), 'Groceries', 'notes/Groceries.md', link.key, { revision: 1, noteRevision: 1, text: groceries.text }, link.address]);

  // The tick comes in as text to save; the next check, with the note uploaded as version 2, moves the base without a new number.
  const taken = await sync(groceries.text, 1);
  assert.deepEqual([taken.text, taken.noteChanged, taken.linkChanged, taken.revision], ['# Groceries\n- [x] milk\n- [ ] eggs\n- [ ] bread\n', true, false, 2]);
  const settled = await sync(taken.text, 2);
  assert.deepEqual([settled.noteChanged, settled.linkChanged, settled.revision, (await mine()).base], [false, false, 2, { revision: 2, noteRevision: 2, text: taken.text }]);
  assert.equal((await app.api(`/public-lists/${link.id}`)).body.revision, 2);

  // The owner ticks eggs (version 3): a new number, a later time, and the guest sees it under the owner's name.
  app.advance(MINUTE);
  const ticked = taken.text.replace('- [ ] eggs', '- [x] eggs');
  const wrote = await sync(ticked, 3);
  assert.deepEqual([wrote.noteChanged, wrote.linkChanged, wrote.revision], [false, true, 3]);
  const after = await mine();
  assert.deepEqual([after.revision, after.updatedAt, after.base], [3, new Date(app.now()).toISOString(), { revision: 3, noteRevision: 3, text: ticked }]);
  const seen = await openList(app.url(), link.id, link.key);
  assert.deepEqual([seen.revision, seen.text, seen.lines[2].mark.by, seen.lines[1].mark.by], [3, ticked, 'Eric', 'Anna']);

  // The owner's own route: the number must hold, the owner envelope must be there, and only the owner may call it.
  const ownerEnvelope = row(app, link.id).ownerEnvelope;
  await refused(me.client.call(`/list-links/${link.id}`, 'PUT', { baseRevision: 2, ownerEnvelope }), 409);
  await assert.rejects(me.client.call(`/list-links/${link.id}`, 'PUT', { baseRevision: 2, ownerEnvelope }), (error) => error.currentRevision === 3);
  await refused(me.client.call(`/list-links/${link.id}`, 'PUT', { baseRevision: 3 }), 400);
  await refused(me.client.call(`/list-links/${link.id}`, 'PUT', { baseRevision: 3, ownerEnvelope, envelope: 'nonsense' }), 400);
  assert.deepEqual(await me.client.call(`/list-links/${link.id}`, 'PUT', { baseRevision: 3, ownerEnvelope }), { revision: 3 });
  const ben = await signUp(app, 'ben');
  await refused(ben.client.call(`/list-links/${link.id}`, 'PUT', { baseRevision: 3, ownerEnvelope }), 404);
  await refused(removeListLink(ben.client, link.id), 404);
  assert.deepEqual(await listListLinks(ben.client, app.url()), []);
  await refused(me.client.call(`/list-links/${randomUUID()}`, 'PUT', { baseRevision: 1, ownerEnvelope }), 404);
  await refused(me.client.call('/list-links/abc', 'PUT', { baseRevision: 1, ownerEnvelope }), 400);
});

test('note links and list links count together: Free has one link of either kind, Plus has more and chooses how long', async (t) => {
  const app = await fixture(t);
  const me = await signUp(app, 'ana');
  await refused(share(me.client, app, { days: 30 }), 402, 'plus-required');
  await refused(share(me.client, app, { days: 0 }), 402, 'plus-required');
  const noteLink = await createLink(me.client, groceries, { origin: app.url() });
  await refused(share(me.client, app), 402, 'plus-required');
  await removeLink(me.client, noteLink.id);
  const listLink = await share(me.client, app);
  await refused(createLink(me.client, groceries, { origin: app.url() }), 402, 'plus-required');
  await refused(share(me.client, app), 402, 'plus-required');
  await removeListLink(me.client, listLink.id);
  assert.equal((await app.api(`/public-lists/${listLink.id}`)).status, 404);
  await createLink(me.client, groceries, { origin: app.url() });

  await me.client.call('/account/trial', 'POST', {});
  const forever = await share(me.client, app, { days: 0 });
  assert.equal(forever.expiresAt, null);
  const month = await share(me.client, app, { days: 30 });
  assert.equal(Date.parse(month.expiresAt), app.now() + 30 * DAY);
  await refused(share(me.client, app, { days: 2 }), 400);
  assert.deepEqual((await listListLinks(me.client, app.url())).map((entry) => entry.id).sort(), [forever.id, month.id].sort());
  await assert.rejects(createListLink(me.client, { title: 'Text', text: 'No boxes here' }, { origin: app.url(), noteRevision: 1 }), /no checklist/);
});

test('a list link ends on time: reading and writing stop, and the sweep removes it', async (t) => {
  const app = await fixture(t);
  const me = await signUp(app, 'ana');
  const free = await share(me.client, app);
  const guest = await openList(app.url(), free.id, free.key);
  app.advance(7 * DAY + 1);
  // Ended (410), or already swept away (404) on a slow machine: either way it neither opens nor takes a tick.
  assert.ok([404, 410].includes((await app.api(`/public-lists/${free.id}`)).status));
  await assert.rejects(tickItem(app.url(), free.id, free.key, guest, guest.lines[1], true, { name: 'Anna' }), (error) => [404, 410].includes(error.status));
  await app.sweep();
  assert.equal((await app.api(`/public-lists/${free.id}`)).status, 404);
  assert.deepEqual(await listListLinks(me.client, app.url()), []);

  await me.client.call('/account/trial', 'POST', {});
  const made = app.now();
  const forever = await share(me.client, app, { days: 0 });
  app.advance(10 * DAY);
  assert.equal((await app.api(`/public-lists/${forever.id}`)).status, 200);
  // The 14-day trial ends: the link is older than 7 days, so it pauses. The owner still sees it, with the day it paused.
  app.advance(5 * DAY);
  assert.equal((await app.api(`/public-lists/${forever.id}`)).status, 410);
  const [paused] = await listListLinks(me.client, app.url());
  assert.equal(paused.expiresAt, new Date(made + 7 * DAY).toISOString());
});

test('anyone can report a list link; the mail names the list and its owner, not the items', async (t) => {
  const app = await fixture(t);
  const me = await signUp(app, 'ana');
  const link = await share(me.client, app);
  await reportList(app.url(), link.id, { reason: 'abuse', details: 'This is not ok' });
  const mail = app.mails.find((entry) => entry.kind === 'list-report');
  assert.equal(mail.to, 'hello@jotdrop.net');
  assert.deepEqual(mail.report, { reason: 'abuse', owner: 'ana@example.test', linkId: link.id, details: 'This is not ok' });
  assert.ok(!JSON.stringify(mail).includes('milk'));
  await refused(reportList(app.url(), link.id, { reason: 'nonsense' }), 400);
  await refused(reportList(app.url(), randomUUID(), { reason: 'spam' }), 404);
});

test('too much for a link is refused, and so are too many writes from one address', async (t) => {
  const app = await fixture(t);
  const me = await signUp(app, 'ana');
  await refused(createListLink(me.client, { title: 'Big', text: `- [ ] ${'x'.repeat(70 * 1024)}\n` }, { origin: app.url(), noteRevision: 1 }), 413);
  const link = await share(me.client, app);
  const anna = await openList(app.url(), link.id, link.key);
  await refused(addItem(app.url(), link.id, link.key, { ...anna, text: `${'- [ ] x\n'.repeat(10000)}` }, 'one more', { name: 'Anna' }), 413);
  // The owner's envelope may be 4 KB more than a list (the key, title and path next to the base), not more. Sealed text grows by a third.
  const sealed = (size) => encryptEnvelope(me.client.credentials.vaultKey, { key: link.key, base: { text: 'y'.repeat(size) } }, `jotdrop:list-link-owner:v1:${me.client.credentials.vaultId}:${link.id}`).then(JSON.stringify);
  assert.ok(Buffer.byteLength(await sealed(48 * 1024)) > 64 * 1024 && Buffer.byteLength(await sealed(55 * 1024)) > 68 * 1024);
  assert.deepEqual(await me.client.call(`/list-links/${link.id}`, 'PUT', { baseRevision: 1, ownerEnvelope: await sealed(48 * 1024) }), { revision: 1 });
  await refused(me.client.call(`/list-links/${link.id}`, 'PUT', { baseRevision: 1, ownerEnvelope: await sealed(55 * 1024) }), 413);
  await refused(me.client.call('/list-links', 'POST', { id: randomUUID(), days: 7, envelope: anna.text, ownerEnvelope: await sealed(10), writeProofHash: hash('x') }), 400);
  await refused(me.client.call('/list-links', 'POST', { id: randomUUID(), days: 7, envelope: (await app.api(`/public-lists/${link.id}`)).body.envelope, ownerEnvelope: await sealed(10), writeProofHash: 'short' }), 400);
  // Sixty writes a minute from one address, right or wrong (the refused one above was the first); the list itself has not moved.
  const envelope = (await app.api(`/public-lists/${link.id}`)).body.envelope;
  for (let i = 0; i < 59; i++) assert.equal((await rawPut(app, link.id, { envelope, baseRevision: 1, writeProof: hash('guess') })).status, 403);
  assert.equal((await rawPut(app, link.id, { envelope, baseRevision: 1, writeProof: await writeProof(link.key) })).status, 429);
  assert.equal((await app.api(`/public-lists/${link.id}`)).body.revision, 1);
  app.advance(MINUTE + 1);
  assert.equal((await rawPut(app, link.id, { envelope, baseRevision: 1, writeProof: await writeProof(link.key) })).status, 200);
});

test('closing an account ends its list links', async (t) => {
  const app = await fixture(t);
  const me = await signUp(app, 'ana');
  const link = await share(me.client, app);
  const db = new DatabaseSync(join(app.dataDir, 'cloud.db'));
  db.prepare('DELETE FROM accounts WHERE email=?').run(me.email);
  db.close();
  await app.sweep();
  assert.equal((await app.api(`/public-lists/${link.id}`)).status, 404);
  assert.equal(row(app, link.id), undefined);
});

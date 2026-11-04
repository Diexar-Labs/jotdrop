import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { encryptEnvelope, generateVaultKey } from './crypto.mjs';
import { addItem, allowedGuestChange, applyGuestChanges, createListLink, findLine, guestName, hasChecklist, listLines, listListLinks, newItemLine, openList, readListLinkAddress, readMarks, reconcile, removeListLink, syncList, tickItem, writeProof } from './list-links.mjs';

// The same cases are for Android later, like merge-vectors.json: a guest's version against the base, and what counts.
const vectors = JSON.parse(readFileSync(new URL('./list-link-vectors.json', import.meta.url), 'utf8'));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const MAX_BYTES = 64 * 1024;

// The server of phase 2 in memory, with the rules the design gives it: sealed text only, a guest's write needs the
// proof, the number must still hold (409 otherwise), 64 KB at most, and an ended link gives 410.
function fakeServer() {
  const lists = new Map();
  const url = 'http://cloud.test';
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const calls = [];
  const fetcher = async (address, init = {}) => {
    calls.push(address);
    const match = /^http:\/\/cloud\.test\/api\/v1\/public-lists\/([^/]+)(\/report)?$/.exec(address);
    const list = lists.get(match?.[1]);
    if (!list) return reply(404, { error: 'This link has ended.' });
    if (list.ended) return reply(410, { error: 'This link has ended.' });
    if (match[2]) { list.reports = (list.reports ?? 0) + 1; return reply(200, { ok: true }); }
    if (!init.method || init.method === 'GET') return reply(200, { envelope: list.envelope, revision: list.revision, expiresAt: list.expiresAt });
    const value = JSON.parse(init.body);
    if (hash(value.writeProof) !== list.writeProofHash) return reply(403, { error: 'This link cannot be written to.' });
    if (Buffer.byteLength(value.envelope) > MAX_BYTES) return reply(413, { error: 'This list is too long for a link.' });
    if (value.baseRevision !== list.revision) return reply(409, { error: 'Someone else changed the list.', currentRevision: list.revision });
    list.revision++;
    list.envelope = value.envelope;
    return reply(200, { revision: list.revision });
  };
  const account = (vaultId) => ({
    credentials: { url, vaultId, vaultKey: generateVaultKey() },
    async call(path, method = 'GET', body) {
      calls.push(`${method} ${path}`);
      if (path === '/list-links' && method === 'GET') return { links: [...lists.values()].filter((list) => list.vaultId === vaultId && !list.ended).map((list) => ({ id: list.id, ownerEnvelope: list.ownerEnvelope, revision: list.revision, updatedAt: '2026-11-04T18:00:00.000Z', expiresAt: list.expiresAt }))};
      if (path === '/list-links' && method === 'POST') {
        assert.match(body.writeProofHash, /^[0-9a-f]{64}$/);
        lists.set(body.id, { ...body, vaultId, revision: 1, expiresAt: '2026-11-11T18:00:00.000Z' });
        return { id: body.id, expiresAt: '2026-11-11T18:00:00.000Z' };
      }
      const target = /^\/list-links\/(.+)$/.exec(path), list = lists.get(target?.[1]);
      if (!list || list.vaultId !== vaultId) throw Object.assign(new Error('Link not found'), { status: 404 });
      if (method === 'DELETE') { list.ended = true; return { ok: true }; }
      if (method === 'PUT') {
        assert.ok(Buffer.byteLength(body.ownerEnvelope) <= MAX_BYTES + 4096);
        if (body.baseRevision !== list.revision) throw Object.assign(new Error('Someone else changed the list.'), { status: 409, currentRevision: list.revision });
        if (body.envelope !== undefined) { list.revision++; list.envelope = body.envelope; }
        list.ownerEnvelope = body.ownerEnvelope;
        return { revision: list.revision };
      }
      throw new Error(`Unexpected call ${method} ${path}`);
    },
  });
  return { url, lists, calls, fetcher, account };
}

const groceries = { title: 'Groceries', text: '# Groceries\n- [ ] milk\n- [ ] eggs\n- [ ] bread\n' };
const at = Date.parse('2026-11-04T18:00:00Z');

async function shared(text = groceries.text) {
  const server = fakeServer();
  const owner = server.account(randomUUID());
  const link = await createListLink(owner, { ...groceries, text }, { origin: server.url, days: 7, path: 'notes/Groceries.md', noteRevision: 1 });
  const options = { fetcher: server.fetcher, now: at };
  const open = () => openList(server.url, link.id, link.key, options);
  // One check on one of the owner's devices, with the note uploaded as version `noteRevision`.
  const sync = async (note, noteRevision, extra = {}, client = owner) => syncList(client, (await listListLinks(client, server.url))[0], { ...options, note, noteRevision, ownerName: 'Eric', ...extra });
  return { server, owner, link, options, open, sync };
}

test('what a guest may change and how it goes into your note: the vectors, the same for Android later', () => {
  for (const vector of vectors) {
    if (vector.next !== undefined) assert.equal(allowedGuestChange(vector.base, vector.next), vector.accepted, vector.name);
    if (vector.mine !== undefined) {
      assert.equal(applyGuestChanges(vector.base, vector.accepted, vector.mine), vector.result, vector.name);
      assert.equal(applyGuestChanges(vector.base, vector.accepted, vector.result), vector.result, `${vector.name} (again)`);
    }
  }
  const long = vectors.find((vector) => vector.name.includes('501'));
  assert.deepEqual(long.next.split('\n').slice(1).map((line) => line.length - '- [ ] '.length), [501, 500]);
});

test('the link holds the key only after #, the server holds sealed text and a hash of the write proof', async () => {
  const { server, owner, link } = await shared();
  assert.match(link.address, new RegExp(`^${server.url}/l/[0-9a-f-]{36}#[\\w-]{43}$`));
  assert.deepEqual(readListLinkAddress(link.address), { id: link.id, key: link.key });
  assert.throws(() => readListLinkAddress(`${server.url}/l/${link.id}`), /not complete/);
  assert.throws(() => readListLinkAddress(`${server.url}/n/${link.id}#${link.key}`), /not complete/);
  const stored = server.lists.get(link.id);
  assert.ok(!JSON.stringify(stored).includes('milk') && !JSON.stringify(stored).includes(link.key));
  assert.equal(stored.writeProofHash, hash(await writeProof(link.key)));
  assert.deepEqual(link.base, { revision: 1, noteRevision: 1, text: groceries.text });
  const mine = await listListLinks(owner, server.url);
  assert.deepEqual(mine, [{ id: link.id, revision: 1, updatedAt: '2026-11-04T18:00:00.000Z', expiresAt: '2026-11-11T18:00:00.000Z', title: 'Groceries', path: 'notes/Groceries.md', key: link.key, base: link.base, address: link.address }]);
  const opened = await openList(server.url, link.id, link.key, { fetcher: server.fetcher });
  assert.deepEqual({ title: opened.title, text: opened.text, revision: opened.revision, marks: opened.marks }, { ...groceries, revision: 1, marks: [] });
  assert.deepEqual(opened.lines.map((line) => [line.task, line.text, line.ticked ?? null]), [[false, '# Groceries', null], [true, 'milk', false], [true, 'eggs', false], [true, 'bread', false], [false, '', null]]);
  await assert.rejects(openList(server.url, link.id, generateVaultKey(), { fetcher: server.fetcher }));
  await assert.rejects(openList(server.url, randomUUID(), link.key, { fetcher: server.fetcher }), (error) => error.status === 404);
  // Another account's owner envelope does not open: no key, no address.
  const other = server.account(randomUUID());
  server.lists.get(link.id).vaultId = other.credentials.vaultId;
  assert.deepEqual((await listListLinks(other, server.url)).map((item) => [item.key, item.address, item.base]), [[null, null, null]]);
  server.lists.get(link.id).vaultId = owner.credentials.vaultId;
  await removeListLink(owner, link.id);
  await assert.rejects(openList(server.url, link.id, link.key, { fetcher: server.fetcher }), (error) => error.status === 410);
});

test('a guest ticks and adds; the owner takes both over with names; the owner ticks and the guest sees it', async () => {
  const { server, owner, link, options, open, sync } = await shared();
  // Nothing to do while the number and the note stand still: no fetch.
  const before = server.calls.length;
  const still = await sync(groceries.text, 1);
  assert.deepEqual([still.noteChanged, still.linkChanged, still.revision, server.calls.length - before], [false, false, 1, 1]);

  let anna = await open();
  anna = await tickItem(server.url, link.id, link.key, anna, anna.lines[1], true, { ...options, name: 'Anna' });
  anna = await addItem(server.url, link.id, link.key, anna, '  butter  ', { ...options, name: 'Anna' });
  assert.equal(anna.text, '# Groceries\n- [x] milk\n- [ ] eggs\n- [ ] bread\n- [ ] butter\n');
  assert.equal(anna.revision, 3);
  assert.deepEqual(anna.marks, [{ line: '- [ ] milk', n: 0, by: 'Anna', at, added: false }, { line: '- [ ] butter', n: 0, by: 'Anna', at, added: true }]);
  assert.deepEqual((await open()).lines.map((line) => line.mark?.by ?? null), [null, 'Anna', null, null, 'Anna', null]);

  // The owner's device fetches, takes over, and hands the text back to save; the link and the base stay.
  const taken = await sync(groceries.text, 1);
  assert.deepEqual([taken.text, taken.noteChanged, taken.linkChanged, taken.revision], [anna.text, true, false, 3]);
  assert.equal((await listListLinks(owner, server.url))[0].base.revision, 1);
  // Saved and uploaded as version 2: the next check moves the base, without a new version for guests.
  const settled = await sync(taken.text, 2);
  assert.deepEqual([settled.noteChanged, settled.linkChanged, settled.revision], [false, false, 3]);
  const [mine] = await listListLinks(owner, server.url);
  assert.deepEqual(mine.base, { revision: 3, noteRevision: 2, text: anna.text });
  assert.deepEqual(await sync(taken.text, 2), { text: anna.text, marks: null, noteChanged: false, linkChanged: false, revision: 3 });

  // The owner ticks eggs (uploaded as version 3): written to the link under the owner's name; the guest sees it.
  const ticked = anna.text.replace('- [ ] eggs', '- [x] eggs');
  const wrote = await sync(ticked, 3);
  assert.deepEqual([wrote.noteChanged, wrote.linkChanged, wrote.revision], [false, true, 4]);
  const seen = await open();
  assert.equal(seen.text, ticked);
  assert.deepEqual(seen.lines[2].mark, { line: '- [ ] eggs', n: 0, by: 'Eric', at, added: false });
  assert.equal(seen.lines[1].mark.by, 'Anna');
  assert.deepEqual((await listListLinks(owner, server.url))[0].base, { revision: 4, noteRevision: 3, text: ticked });
});

test('two guests at once: the second one tries again on the newest version; both ticks and both lines stay', async () => {
  const { server, link, options, open } = await shared();
  const anna = await open(), ben = await open();
  const anna2 = await tickItem(server.url, link.id, link.key, anna, anna.lines[1], true, { ...options, name: 'Anna' });
  const ben2 = await tickItem(server.url, link.id, link.key, ben, ben.lines[2], true, { ...options, name: 'Ben' });
  assert.deepEqual([anna2.revision, ben2.revision, ben2.text], [2, 3, '# Groceries\n- [x] milk\n- [x] eggs\n- [ ] bread\n']);
  assert.deepEqual(ben2.marks.map((mark) => mark.by), ['Anna', 'Ben']);
  // Both add "brood" from the same version: it is there twice, visibly.
  const anna3 = await addItem(server.url, link.id, link.key, anna2, 'brood', { ...options, name: 'Anna' });
  const ben3 = await addItem(server.url, link.id, link.key, ben2, 'brood', { ...options, name: 'Ben' });
  assert.equal(ben3.text, '# Groceries\n- [x] milk\n- [x] eggs\n- [ ] bread\n- [ ] brood\n- [ ] brood\n');
  assert.deepEqual(ben3.lines.filter((line) => line.text === 'brood').map((line) => [line.n, line.mark.by]), [[0, 'Anna'], [1, 'Ben']]);
  assert.equal(anna3.revision, 4);
  // One ticks while the other adds, from the same version.
  const anna4 = await tickItem(server.url, link.id, link.key, anna3, anna3.lines[3], true, { ...options, name: 'Anna' });
  const ben4 = await addItem(server.url, link.id, link.key, ben3, 'jam', { ...options, name: 'Ben' });
  assert.equal(ben4.text, '# Groceries\n- [x] milk\n- [x] eggs\n- [x] bread\n- [ ] brood\n- [ ] brood\n- [ ] jam\n');
  assert.equal(ben4.revision, anna4.revision + 1);
  // Ticking what already stands that way writes nothing.
  const stale = await tickItem(server.url, link.id, link.key, anna4, anna4.lines[4], false, { ...options, name: 'Anna' });
  assert.equal(stale.revision, anna4.revision);
});

test('a guest and the owner at once: the guest ticks while the owner adds text; the owner merges and writes back', async () => {
  const { server, link, options, open, sync } = await shared();
  const anna = await open();
  const owned = '# Groceries\n\nFor Saturday.\n- [ ] milk\n- [ ] eggs\n- [ ] bread\n- [ ] wine\n';
  await tickItem(server.url, link.id, link.key, anna, anna.lines[3], true, { ...options, name: 'Anna' });
  // The owner's text was uploaded as version 2 while the guest ticked: first the tick comes in, then the text goes out.
  const result = await sync(owned, 2);
  assert.equal(result.text, '# Groceries\n\nFor Saturday.\n- [ ] milk\n- [ ] eggs\n- [x] bread\n- [ ] wine\n');
  assert.deepEqual([result.noteChanged, result.linkChanged, result.revision], [true, false, 2]);
  const wrote = await sync(result.text, 3);
  assert.deepEqual([wrote.noteChanged, wrote.linkChanged, wrote.revision], [false, true, 3]);
  assert.deepEqual(wrote.marks, [{ line: '- [ ] bread', n: 0, by: 'Anna', at, added: false }, { line: '- [ ] wine', n: 0, by: 'Eric', at, added: true }]);
  const seen = await open();
  assert.deepEqual([seen.text, seen.marks], [result.text, wrote.marks]);
  // The guest page holds the old lines: the tick on "milk" still lands on milk after the owner's insertion.
  const late = await tickItem(server.url, link.id, link.key, anna, anna.lines[1], true, { ...options, name: 'Anna' });
  assert.equal(late.text, '# Groceries\n\nFor Saturday.\n- [x] milk\n- [ ] eggs\n- [x] bread\n- [ ] wine\n');
  // A guest write on an older number is tried again; one that may not try again gives up with 409.
  await assert.rejects(tickItem(server.url, link.id, link.key, anna, anna.lines[2], true, { ...options, name: 'Anna', attempts: 1 }), (error) => error.status === 409 && error.currentRevision === 4);
  // The owner's write meets a guest's in between and tries again too.
  const ben = await open();
  const racing = { ...options, fetcher: async (address, init) => { const response = await server.fetcher(address, init); if (!init?.method) await tickItem(server.url, link.id, link.key, ben, ben.lines[4], true, { ...options, name: 'Ben' }).catch(() => {}); return response; } };
  const raced = await sync(`${late.text}- [ ] cake\n`, 4, racing);
  assert.deepEqual([raced.noteChanged, raced.linkChanged, raced.revision, raced.text], [true, false, 5, '# Groceries\n\nFor Saturday.\n- [x] milk\n- [x] eggs\n- [x] bread\n- [ ] wine\n- [ ] cake\n']);
  const settled = await sync(raced.text, 5);
  assert.deepEqual([settled.linkChanged, settled.revision, (await open()).text], [true, 6, raced.text]);
});

test('a made-up request cannot change or remove existing text, but its ticks and allowed new lines still count', async () => {
  const { server, link, options, open, sync } = await shared();
  const forge = async (text, marks = []) => {
    const list = server.lists.get(link.id);
    const envelope = JSON.stringify(await encryptEnvelope(link.key, { v: 1, revision: list.revision + 1, title: 'Groceries', text, marks }, `jotdrop:list-link:v1:${link.id}`));
    const response = await server.fetcher(`${server.url}/api/v1/public-lists/${link.id}`, { method: 'PUT', body: JSON.stringify({ envelope, baseRevision: list.revision, writeProof: await writeProof(link.key) }) });
    return response.status;
  };
  assert.equal(await forge('# Groceries\n- [x] milk 2L\n- [x] eggs\n- [ ] bread\n- [ ] cheese\nBuy all of it\n'), 200);
  const result = await sync(groceries.text, 1);
  assert.deepEqual([result.text, result.noteChanged], ['# Groceries\n- [ ] milk\n- [x] eggs\n- [ ] bread\n- [ ] cheese\n', true]);
  const restored = await sync(result.text, 2);
  assert.ok(restored.linkChanged, 'The owner puts the real text back in the link');
  assert.equal((await open()).text, result.text);
  // Without the proof the server refuses.
  const list = server.lists.get(link.id);
  const without = await server.fetcher(`${server.url}/api/v1/public-lists/${link.id}`, { method: 'PUT', body: JSON.stringify({ envelope: list.envelope, baseRevision: list.revision, writeProof: hash('guess') }) });
  assert.equal(without.status, 403);
  // Names in a made-up envelope are cleaned when read; marks on lines that do not exist drop out.
  assert.equal(await forge(result.text, [{ line: '- [ ] eggs', n: 0, by: 'x'.repeat(41), at }, { line: '- [ ] eggs', n: 0, by: 'Bad\nName', at }, { line: '- [ ] gone', n: 0, by: 'Anna', at }, 'junk', { line: '- [ ] milk', n: 0, by: 'Anna', at: 'soon' }]), 200);
  const seen = await open();
  assert.deepEqual(seen.marks, [{ line: '- [ ] eggs', n: 0, by: 'Someone', at, added: false }, { line: '- [ ] eggs', n: 0, by: 'Someone', at, added: false }]);
  assert.deepEqual(readMarks(null), []);
});

test('names and new items have limits; a guest without a name is Someone', async () => {
  assert.equal(guestName(''), 'Someone');
  assert.equal(guestName(undefined), 'Someone');
  assert.equal(guestName('  Anna  '), 'Anna');
  assert.equal(guestName('x'.repeat(40)), 'x'.repeat(40));
  assert.throws(() => guestName('x'.repeat(41)), /1 to 40/);
  assert.throws(() => guestName('An\tna'), /1 to 40/);
  assert.throws(() => guestName(['Anna']), /1 to 40/);
  assert.equal(newItemLine(' bread '), '- [ ] bread');
  assert.equal(newItemLine('y'.repeat(500)), `- [ ] ${'y'.repeat(500)}`);
  assert.throws(() => newItemLine('y'.repeat(501)), /1 to 500/);
  assert.throws(() => newItemLine('two\nlines'), /1 to 500/);
  assert.throws(() => newItemLine('   '), /1 to 500/);
  const { server, link, options, open } = await shared();
  const anna = await open();
  await assert.rejects(addItem(server.url, link.id, link.key, anna, 'z'.repeat(501), { ...options, name: 'Anna' }), /1 to 500/);
  await assert.rejects(tickItem(server.url, link.id, link.key, anna, anna.lines[1], true, { ...options, name: 'x'.repeat(41) }), /1 to 40/);
  const nobody = await tickItem(server.url, link.id, link.key, anna, anna.lines[1], true, options);
  assert.equal(nobody.marks[0].by, 'Someone');
  assert.equal(nobody.lines[1].mark.by, 'Someone');
});

test('marks follow their line when lines above it move, and equal lines are told apart by place, then text', async () => {
  const { server, link, options, open, sync } = await shared('- [ ] melk\n- [ ] melk\n- [ ] kaas\n');
  const anna = await open();
  const second = await tickItem(server.url, link.id, link.key, anna, anna.lines[1], true, { ...options, name: 'Anna' });
  assert.equal(second.text, '- [ ] melk\n- [x] melk\n- [ ] kaas\n');
  // The owner put two lines above (uploaded as version 2): the mark is still on the second "melk".
  const taken = await sync('# Shop\n\n- [ ] melk\n- [ ] melk\n- [ ] kaas\n', 2);
  assert.equal(taken.text, '# Shop\n\n- [ ] melk\n- [x] melk\n- [ ] kaas\n');
  const wrote = await sync(taken.text, 3);
  assert.deepEqual([wrote.linkChanged, wrote.marks], [true, [{ line: '- [ ] melk', n: 1, by: 'Anna', at, added: false }]]);
  const moved = await open();
  assert.deepEqual(moved.lines.map((line) => line.mark?.by ?? null), [null, null, null, 'Anna', null, null]);
  // Anna's page still shows the old places: her untick of the second "melk" lands on the second one.
  const back = await tickItem(server.url, link.id, link.key, second, second.lines[1], false, { ...options, name: 'Anna' });
  assert.equal(back.text, '# Shop\n\n- [ ] melk\n- [ ] melk\n- [ ] kaas\n');
  // The line itself: same place first, then the same one among equals, then the nearest.
  const lines = listLines('- [ ] a\n- [ ] melk\n- [ ] b\n- [ ] melk\n');
  assert.equal(findLine(lines, { index: 1, key: '- [ ] melk', n: 1 }).index, 1);
  assert.equal(findLine(lines, { index: 0, key: '- [ ] melk', n: 1 }).index, 3);
  assert.equal(findLine(lines, { index: 2, key: '- [ ] melk', n: 5 }).index, 1);
  assert.equal(findLine(lines, { index: 0, key: '- [ ] gone', n: 0 }), null);
  await assert.rejects(tickItem(server.url, link.id, link.key, back, { index: 0, key: '- [ ] gone', n: 0 }, true, { ...options, name: 'Anna' }), /no longer in the list/);
});

test('two of your devices: one waits until it has the version the base came from, so neither undoes the other', async () => {
  const { server, link, options, open, sync } = await shared();
  const anna = await open();
  await tickItem(server.url, link.id, link.key, anna, anna.lines[1], true, { ...options, name: 'Anna' });
  // Device A takes the tick (version 2) and settles the base.
  const onA = await sync(groceries.text, 1);
  assert.ok(onA.noteChanged);
  await sync(onA.text, 2);
  // Device B still has version 1: it waits for its own sync. With version 2 it has nothing to do.
  assert.deepEqual((await sync(groceries.text, 1)).skipped, true);
  const quiet = await sync(onA.text, 2);
  assert.deepEqual([quiet.noteChanged, quiet.linkChanged, quiet.skipped], [false, false, undefined]);
  // Device B removes bread and changes milk (version 3) and writes the link.
  const onB = '# Groceries\n- [x] milk 2L\n- [ ] eggs\n';
  assert.deepEqual([(await sync(onB, 3)).linkChanged, (await open()).text], [true, onB]);
  // A guest adds cheese. Device A, still on version 2, waits; with version 3 it takes cheese and nothing else comes back.
  const ben = await open();
  await addItem(server.url, link.id, link.key, ben, 'cheese', { ...options, name: 'Ben' });
  assert.equal((await sync(onA.text, 2)).skipped, true);
  const late = await sync(onB, 3);
  assert.deepEqual([late.text, late.noteChanged], ['# Groceries\n- [x] milk 2L\n- [ ] eggs\n- [ ] cheese\n', true]);
  const done = await sync(late.text, 4);
  assert.deepEqual([done.noteChanged, done.linkChanged, (await listListLinks(server.account(randomUUID()), server.url)).length], [false, false, 0]);
  assert.deepEqual(reconcile({ text: groceries.text }, groceries.text, { text: groceries.text, marks: [] }), { text: groceries.text, marks: [], noteChanged: false, linkChanged: false });
});

test('a sealed version that does not open, or does not match its number, is nothing new: the owner writes over it', async () => {
  const { server, link, open, sync } = await shared();
  const list = server.lists.get(link.id);
  const good = list.envelope;
  list.envelope = JSON.stringify(await encryptEnvelope(generateVaultKey(), { v: 1, revision: 1, title: 'x', text: '- [ ] x', marks: [] }, `jotdrop:list-link:v1:${link.id}`));
  await assert.rejects(open());
  // The listing still says 1, the base says 1 and the note is the base: without a fetch the owner would not notice. Force one.
  const unnoticed = await sync(groceries.text, 1);
  assert.deepEqual([unnoticed.linkChanged, unnoticed.revision], [false, 1]);
  const fixed = await sync(groceries.text, 1, { title: 'Groceries!' });
  assert.deepEqual([fixed.text, fixed.linkChanged, fixed.noteChanged, fixed.revision], [groceries.text, true, false, 2]);
  assert.deepEqual([(await open()).text, (await open()).title], [groceries.text, 'Groceries!']);
  // The server claims a number the sealed text does not carry.
  list.envelope = good;
  list.revision = 3;
  await assert.rejects(open(), /does not match its version/);
  const again = await sync(groceries.text, 1, { title: 'Groceries!' });
  assert.deepEqual([again.linkChanged, again.revision, (await open()).revision], [true, 4, 4]);
  // The server plays an older version than this device already saw.
  list.revision = 1;
  list.envelope = good;
  await assert.rejects(openList(server.url, link.id, link.key, { fetcher: server.fetcher, minRevision: 4 }), /older version/);
  await assert.rejects(sync(groceries.text, 1, { title: 'Groceries!' }), /older version/);
});

test('a note without a checklist cannot become a list link; CRLF text is kept as LF', async () => {
  const { server } = await shared();
  const owner = server.account(randomUUID());
  assert.equal(hasChecklist('Just text\n- a bullet\n'), false);
  assert.equal(hasChecklist('Text\r\n- [x] done\r\n'), true);
  await assert.rejects(createListLink(owner, { title: 'Text', text: 'Just text' }, { origin: server.url, noteRevision: 1 }), /no checklist/);
  await assert.rejects(createListLink(owner, groceries, { origin: server.url }), /Upload the note/);
  const link = await createListLink(owner, { title: 'Windows', text: '- [ ] milk\r\n- [ ] eggs\r\n' }, { origin: server.url, path: 'notes/Windows.md', noteRevision: 1 });
  assert.equal(link.base.text, '- [ ] milk\n- [ ] eggs\n');
  const options = { fetcher: server.fetcher, now: at };
  const anna = await openList(server.url, link.id, link.key, options);
  await tickItem(server.url, link.id, link.key, anna, anna.lines[0], true, { ...options, name: 'Anna' });
  const [mine] = await listListLinks(owner, server.url);
  const result = await syncList(owner, mine, { ...options, note: '- [ ] milk\r\n- [ ] eggs\r\n- [ ] jam\r\n', noteRevision: 2 });
  assert.deepEqual([result.text, result.noteChanged], ['- [x] milk\n- [ ] eggs\n- [ ] jam\n', true]);
  const quiet = await syncList(owner, mine, { ...options, note: '- [ ] milk\r\n- [ ] eggs\r\n', noteRevision: 1 });
  assert.ok(quiet.noteChanged, 'A CRLF note with nothing but the tick to take still changes');
});

test('the title follows the owner; an envelope over 64 KB is refused by the server', async () => {
  const { server, link, options, open, sync } = await shared();
  const renamed = await sync(groceries.text, 1, { title: 'Saturday' });
  assert.deepEqual([renamed.linkChanged, (await open()).title], [true, 'Saturday']);
  const anna = await open();
  await assert.rejects(addItem(server.url, link.id, link.key, { ...anna, text: `${'- [ ] x'.repeat(10000)}\n` }, 'one more', { ...options, name: 'Anna' }), (error) => error.status === 413);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { base64ToBytes, bytesToBase64, generateVaultKey } from './crypto.mjs';
import { ADDRESS_ALPHABET, addressHash, importMailPrivate, mailAddress, mailKeyPair, mailToNote, openMailBody, openMailKey, openMailPart, sealMail, senderHash } from './mail.mjs';

const vector = JSON.parse(readFileSync(new URL('./fixtures/mail-vectors.json', import.meta.url), 'utf8'));

test('a sealed mail only opens for the right account, mail and part', async () => {
  const vaultKey = generateVaultKey();
  const pair = await mailKeyPair(vaultKey);
  assert.equal((await mailKeyPair(vaultKey)).publicKey, pair.publicKey);
  assert.notEqual((await mailKeyPair(generateVaultKey())).publicKey, pair.publicKey);
  const payload = { v: 1, from: 'a@b.cd', subject: 'Hello', date: 'now', text: 'body', attachments: [{ name: 'x.txt', type: 'text/plain', size: 5 }] };
  const sealed = await sealMail(pair.publicKey, 'vault-1', 'mail-1', payload, [Uint8Array.of(1, 2, 3)]);
  assert.ok(!JSON.stringify(sealed).includes('Hello') && !JSON.stringify(sealed).includes('x.txt'));
  const key = await openMailKey(pair.privateKey, pair.publicKey, sealed.ephemeralKey, 'mail-1');
  assert.deepEqual(await openMailBody(key, 'vault-1', 'mail-1', sealed.body), payload);
  assert.deepEqual(await openMailPart(key, 'vault-1', 'mail-1', 0, sealed.parts[0]), Uint8Array.of(1, 2, 3));
  await assert.rejects(openMailBody(key, 'vault-2', 'mail-1', sealed.body));
  await assert.rejects(openMailPart(key, 'vault-1', 'mail-1', 1, sealed.parts[0]));
  const wrongKey = await openMailKey(pair.privateKey, pair.publicKey, sealed.ephemeralKey, 'mail-2');
  await assert.rejects(openMailBody(wrongKey, 'vault-1', 'mail-1', sealed.body));
  const other = await mailKeyPair(generateVaultKey());
  const otherKey = await openMailKey(other.privateKey, pair.publicKey, sealed.ephemeralKey, 'mail-1');
  await assert.rejects(openMailBody(otherKey, 'vault-1', 'mail-1', sealed.body));
});

test('the frozen vectors keep every platform byte-compatible', async () => {
  const pair = await mailKeyPair(vector.vaultKey);
  assert.equal(pair.publicKey, vector.publicKey);
  const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
  assert.equal(d, vector.privateScalar);
  const scalar = base64ToBytes(vector.privateScalar);
  assert.equal(scalar[0] & 7, 0);
  assert.equal(scalar[31] & 192, 64);
  const { x } = await crypto.subtle.exportKey('jwk', await importMailPrivate(scalar));
  assert.equal(x, vector.publicKey);
  const key = await openMailKey(pair.privateKey, vector.publicKey, vector.ephemeralKey, vector.mailId);
  assert.deepEqual(await openMailBody(key, vector.vaultId, vector.mailId, vector.body), vector.payload);
  assert.deepEqual(await openMailPart(key, vector.vaultId, vector.mailId, 0, vector.parts[0]), base64ToBytes(vector.partsPlain[0]));
  const note = mailToNote(vector.payload, vector.mailId, vector.receivedAt);
  assert.equal(note.path, 'notes/Mail/2026-11-02 Receipt desk lamp a1b2c3.md');
  assert.deepEqual(note.attachments, [{ part: 0, type: 'application/pdf', name: 'mail-a1b2c3-1 bon.pdf' }]);
  assert.equal(note.content, [
    '# Receipt desk lamp', '',
    'From Anna Voss <anna@example.com> on Mon, 2 Nov 2026 21:14:55 +0100', '',
    'Hi Eric,\n\nthe receipt is attached.\n\nAnna', '',
    '![[mail-a1b2c3-1 bon.pdf]]', '',
    '#mail', '',
  ].join('\n'));
});

test('addresses are unguessable, readable and only ever stored as hashes', async () => {
  const address = mailAddress('in.jotdrop.net');
  assert.match(address, /^[a-km-np-z2-9]{12}@in\.jotdrop\.net$/);
  assert.equal(ADDRESS_ALPHABET.length, 32);
  assert.ok(!/[0o1l]/.test(ADDRESS_ALPHABET));
  assert.notEqual(mailAddress('in.jotdrop.net'), address);
  assert.equal(await addressHash(address), await addressHash(` ${address.toUpperCase()} `));
  assert.match(await addressHash(address), /^[0-9a-f]{64}$/);
  assert.notEqual(await addressHash(address), await senderHash(address));
  await assert.rejects(addressHash('no-at-sign'));
  assert.throws(() => mailAddress('bad domain'));
});

test('mailToNote stays deterministic and safe for hostile subjects and names', () => {
  const payload = { v: 1, from: 'x', subject: '  ../../etc: pass#wd [a]|b^  ', date: '', text: '', attachments: [{ name: '..\\..\\evil :name.pdf' }, {}] };
  const note = mailToNote(payload, 'ABC123-rest', '2026-01-05T06:07:08.000Z');
  assert.equal(note.path, 'notes/Mail/2026-01-05 etc pass wd a b abc123.md');
  assert.equal(note.attachments[0].name, 'mail-abc123-1 evil name.pdf');
  assert.equal(note.attachments[1].name, 'mail-abc123-2 attachment');
  assert.equal(note.attachments[1].type, 'application/octet-stream');
  assert.ok(note.content.includes('From x on 2026-01-05 06:07'));
  assert.ok(note.content.endsWith('#mail\n'));
  const fallback = mailToNote({ v: 1 }, 'id9876', '2026-01-05T06:07:08.000Z');
  assert.equal(fallback.path, 'notes/Mail/2026-01-05 Mail id9876.md');
  assert.ok(fallback.content.startsWith('# Mail\n\nFrom unknown sender on '));
  assert.throws(() => mailToNote(payload, '!!!', '2026-01-05T06:07:08.000Z'));
  assert.throws(() => mailToNote(payload, 'id9876', 'not a date'));
});

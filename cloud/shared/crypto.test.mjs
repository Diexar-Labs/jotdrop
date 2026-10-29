import assert from 'node:assert/strict';
import test from 'node:test';
import { base64ToBytes, bytesToBase64, decodeRecovery, decryptEnvelope, encodeRecovery, encryptEnvelope, generateVaultKey, hashToken, normalizePath, objectId, randomToken, sealLocal, unsealLocal } from './crypto.mjs';

test('AES-GCM authenticates content, key and object context; paths use keyed identities', async () => {
  const key = generateVaultKey(), payload = { path: 'notes/private.md', content: 'private test text' };
  const envelope = await encryptEnvelope(key, payload, 'object-a');
  assert.deepEqual(await decryptEnvelope(key, envelope, 'object-a'), payload);
  assert.ok(!JSON.stringify(envelope).includes('private'));
  await assert.rejects(decryptEnvelope(key, envelope, 'object-b'));
  await assert.rejects(decryptEnvelope(generateVaultKey(), envelope, 'object-a'));
  const tampered = { ...envelope, ciphertext: bytesToBase64(Uint8Array.from(base64ToBytes(envelope.ciphertext), (byte, index) => index === 0 ? byte ^ 1 : byte)) };
  await assert.rejects(decryptEnvelope(key, tampered, 'object-a'));
  assert.equal(await objectId(key, payload.path), await objectId(key, payload.path));
  assert.notEqual(await objectId(key, payload.path), await objectId(generateVaultKey(), payload.path));
  for (const path of ['../secret', '/root', 'notes//x', 'C:\\x', '.obsidian/token', 'notes/../x', 'notes/.git/config']) assert.throws(() => normalizePath(path));
  for (const value of ['=', 'a', 'a+', 'ab']) assert.throws(() => base64ToBytes(value));
});

test('native and fallback base64 agree and reject the same non-canonical input', () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, index) => (index * 7919) & 255);
  const native = { from: Uint8Array.fromBase64, to: Uint8Array.prototype.toBase64 };
  const check = () => {
    for (const length of [0, 1, 2, 3, 4, 70000]) assert.deepEqual(base64ToBytes(bytesToBase64(bytes.subarray(0, length))), bytes.subarray(0, length));
    assert.equal(bytesToBase64(Uint8Array.of(251, 255)), '-_8');
    for (const value of ['=', 'a', 'a+', 'ab', 'AB', 'AAB', 'QQ==', 'Q Q']) assert.throws(() => base64ToBytes(value));
  };
  check();
  delete Uint8Array.fromBase64;
  delete Uint8Array.prototype.toBase64;
  try { check(); } finally {
    Uint8Array.fromBase64 = native.from;
    Uint8Array.prototype.toBase64 = native.to;
  }
});

test('device keys stay wrapped and recovery validates identifiers and secrets', async () => {
  const secret = { token: randomToken(), vaultKey: generateVaultKey() };
  const sealed = await sealLocal(secret, 'a long test passphrase');
  assert.ok(!JSON.stringify(sealed).includes(secret.token));
  assert.deepEqual(await unsealLocal(sealed, 'a long test passphrase'), secret);
  await assert.rejects(unsealLocal(sealed, 'another long passphrase'));
  await assert.rejects(unsealLocal({ ...sealed, iterations: 1000000000 }, 'a long test passphrase'));
  const recovery = { vaultId: crypto.randomUUID(), vaultKey: secret.vaultKey, recoveryToken: randomToken() };
  const decoded = decodeRecovery(encodeRecovery(recovery));
  assert.equal(decoded.vaultKey, secret.vaultKey);
  assert.equal((await hashToken(secret.token)).length, 64);
  assert.throws(() => encodeRecovery({ ...recovery, vaultId: '../x' }));
});

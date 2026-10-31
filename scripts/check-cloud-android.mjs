import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hugeCase, longCase, randomCases } from '../cloud/shared/merge-cases.mjs';
import { mergeNote } from '../cloud/shared/merge.mjs';
import { base64ToBytes, bytesToBase64, CHUNK_BYTES, decryptChunk, decryptEnvelope, encryptChunk, encryptEnvelope, generateVaultKey, hashToken, normalizePath, objectId, sha256Hex } from '../cloud/shared/crypto.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(path.join(tmpdir(), 'jotdrop-android-crypto-'));
const encodeText = (value) => bytesToBase64(new TextEncoder().encode(value));
try {
  const vectors = [];
  for (const [filename, content] of [
    ['notes/plain.md', new TextEncoder().encode('# Synthetic note\n')],
    ['notes/caf\u00e9-\u65e5\u672c-\ud83d\udcdd.md', new TextEncoder().encode('Accents \u00e9, \u65e5\u672c, \ud83d\udcdd\n')],
    ['attachments/all-bytes.bin', Uint8Array.from({ length: 256 }, (_, index) => index)],
    ['notes/empty.md', new Uint8Array()],
    ['notes/long.md', new Uint8Array(65536).fill(97)],
    ['attachments/max.bin', Uint8Array.from({ length: 4 * 1024 * 1024 }, (_, index) => index % 251)],
  ]) {
    normalizePath(filename);
    const key = generateVaultKey();
    const id = await objectId(key, filename);
    const aad = `jotdrop:object:v1:00000000-0000-4000-8000-000000000001:${id}`;
    const payload = { path: filename, content: bytesToBase64(content), modifiedAt: '2026-10-14T00:00:00Z' };
    const envelope = await encryptEnvelope(key, payload, aad);
    vectors.push({ key, aad, payload, line: [key, encodeText(filename), encodeText(aad), encodeText(JSON.stringify(payload)), envelope.iv, envelope.ciphertext, id, await hashToken(key)].join('\t') });
  }
  // v2 pieces: a full piece, a last partial piece and a tiny one; Android must give exactly the same bytes.
  const pieces = [];
  for (const [index, size] of [[0, CHUNK_BYTES], [1, 123457], [199, 1]]) {
    const key = generateVaultKey(), vaultId = '00000000-0000-4000-8000-000000000002';
    const id = await objectId(key, `attachments/piece-${index}.bin`);
    const plain = Uint8Array.from({ length: size }, (_, offset) => (offset * 7 + index) % 256);
    const sealed = await encryptChunk(key, vaultId, id, index, plain);
    pieces.push({ key, vaultId, id, index, plain, sealed, line: ['chunk', key, vaultId, id, index, bytesToBase64(plain), bytesToBase64(sealed)].join('\t') });
  }
  const input = path.join(temporary, 'input.tsv'), output = path.join(temporary, 'output.tsv');
  writeFileSync(input, [...vectors, ...pieces].map((vector) => vector.line).join('\n'));
  // The merge cases the JavaScript tests use; Android must merge each note to the same bytes, or not at all.
  const merges = path.join(temporary, 'merge.tsv'), field = (value) => value === null ? '-' : encodeText(value);
  const utf8 = (value) => new TextEncoder().encode(value);
  const generated = [...randomCases(3000), hugeCase(), longCase()].map((item) => {
    const merged = mergeNote(utf8(item.base), utf8(item.local), utf8(item.cloud));
    return { ...item, merged: merged && new TextDecoder().decode(merged) };
  });
  writeFileSync(merges, [...JSON.parse(readFileSync(path.join(root, 'cloud/shared/merge-vectors.json'), 'utf8')), ...generated]
    .map((vector) => [vector.name, vector.base, vector.local, vector.cloud, vector.merged].map(field).join('\t')).join('\n'));
  const windows = process.platform === 'win32';
  execFileSync(windows ? process.env.ComSpec || 'cmd.exe' : './gradlew', windows ? ['/d', '/c', 'gradlew.bat checkCloudCrypto checkCloudSync --no-daemon --console=plain'] : ['checkCloudCrypto', 'checkCloudSync', '--no-daemon', '--console=plain'], {
    cwd: path.join(root, 'android'), stdio: 'inherit',
    env: { ...process.env, JOTDROP_CRYPTO_INPUT: input, JOTDROP_CRYPTO_OUTPUT: output, JOTDROP_MERGE_INPUT: merges },
  });
  const results = readFileSync(output, 'utf8').split('\n');
  assert.equal(results.length, vectors.length + pieces.length);
  for (const [offset, line] of results.slice(vectors.length).entries()) {
    const [kind, sealed, name] = line.split('\t');
    const piece = pieces[offset];
    assert.equal(kind, 'chunk');
    assert.equal(sealed, bytesToBase64(piece.sealed), 'Android encrypts a piece to the same bytes');
    assert.equal(name, await sha256Hex(piece.sealed));
    assert.deepEqual(await decryptChunk(piece.key, piece.vaultId, piece.id, piece.index, base64ToBytes(sealed)), piece.plain);
  }
  for (const [index, line] of results.slice(0, vectors.length).entries()) {
    const [iv, ciphertext, uploadPath] = line.split('\t');
    const { key, aad, payload } = vectors[index];
    const envelope = { v: 1, iv, ciphertext };
    const id = await objectId(key, payload.path);
    assert.equal(uploadPath, `/objects/${id}/uploads/0/${createHash('sha256').update(JSON.stringify(envelope)).digest('hex')}`);
    const snapshot = JSON.stringify({ id, baseRevision: 0, envelope: JSON.stringify(envelope) });
    const sealedSnapshotBytes = JSON.stringify({ v: 1, iv: 'A'.repeat(16), ciphertext: bytesToBase64(new Uint8Array(Buffer.byteLength(snapshot) + 16)) }).length;
    assert.ok(sealedSnapshotBytes < 12 * 1024 * 1024, 'A maximum file snapshot fits the bounded Android upload store');
    if (payload.path === 'attachments/max.bin') assert.ok(sealedSnapshotBytes > 8 * 1024 * 1024, 'A double-sealed 4 MiB snapshot needs the upload-specific read bound');
    assert.deepEqual(await decryptEnvelope(key, envelope, aad), payload);
    await assert.rejects(decryptEnvelope(generateVaultKey(), envelope, aad));
    await assert.rejects(decryptEnvelope(key, envelope, `${aad}:wrong`));
    const tampered = base64ToBytes(ciphertext);
    tampered[0] ^= 1;
    await assert.rejects(decryptEnvelope(key, { ...envelope, ciphertext: bytesToBase64(tampered) }, aad));
  }
  console.log('JavaScript <-> Android JVM AES-GCM, HMAC paths, token hashes, canonical resumable upload hashes and v2 pieces passed, including 4 MiB. Synthetic data only; no APK or device access.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

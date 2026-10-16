import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { base64ToBytes, bytesToBase64, decryptEnvelope, encryptEnvelope, generateVaultKey, hashToken, normalizePath, objectId } from '../cloud/shared/crypto.mjs';

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
  ]) {
    normalizePath(filename);
    const key = generateVaultKey();
    const id = await objectId(key, filename);
    const aad = `jotdrop:object:v1:00000000-0000-4000-8000-000000000001:${id}`;
    const payload = { path: filename, content: bytesToBase64(content), modifiedAt: '2026-10-14T00:00:00Z' };
    const envelope = await encryptEnvelope(key, payload, aad);
    vectors.push({ key, aad, payload, line: [key, encodeText(filename), encodeText(aad), encodeText(JSON.stringify(payload)), envelope.iv, envelope.ciphertext, id, await hashToken(key)].join('\t') });
  }
  const input = path.join(temporary, 'input.tsv'), output = path.join(temporary, 'output.tsv');
  writeFileSync(input, vectors.map((vector) => vector.line).join('\n'));
  const windows = process.platform === 'win32';
  execFileSync(windows ? process.env.ComSpec || 'cmd.exe' : './gradlew', windows ? ['/d', '/c', 'gradlew.bat checkCloudCrypto checkCloudSync --no-daemon --console=plain'] : ['checkCloudCrypto', 'checkCloudSync', '--no-daemon', '--console=plain'], {
    cwd: path.join(root, 'android'), stdio: 'inherit',
    env: { ...process.env, JOTDROP_CRYPTO_INPUT: input, JOTDROP_CRYPTO_OUTPUT: output },
  });
  const results = readFileSync(output, 'utf8').split('\n');
  assert.equal(results.length, vectors.length);
  for (const [index, line] of results.entries()) {
    const [iv, ciphertext] = line.split('\t');
    const { key, aad, payload } = vectors[index];
    const envelope = { v: 1, iv, ciphertext };
    assert.deepEqual(await decryptEnvelope(key, envelope, aad), payload);
    await assert.rejects(decryptEnvelope(generateVaultKey(), envelope, aad));
    await assert.rejects(decryptEnvelope(key, envelope, `${aad}:wrong`));
    const tampered = base64ToBytes(ciphertext);
    tampered[0] ^= 1;
    await assert.rejects(decryptEnvelope(key, { ...envelope, ciphertext: bytesToBase64(tampered) }, aad));
  }
  console.log('JavaScript <-> Android JVM AES-GCM, HMAC paths and token hashes passed. Synthetic data only; no APK or device access.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

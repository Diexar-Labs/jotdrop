import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveKeys, verificationWords } from '../cloud/shared/account.mjs';
import { base64ToBytes, bytesToBase64, decryptEnvelope, encryptEnvelope, generateVaultKey } from '../cloud/shared/crypto.mjs';

// Same keys, wrapping, words and approval secrets in cloud/shared/account.mjs and Android CloudAccountCrypto.kt.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(path.join(tmpdir(), 'jotdrop-android-account-'));
const encodeText = (value) => bytesToBase64(new TextEncoder().encode(value));
const ecdh = { name: 'ECDH', namedCurve: 'P-256' };
const exportPublic = async (keys) => bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));

async function approvalKey(privateKey, publicKey, approvalId) {
  const peer = await crypto.subtle.importKey('raw', base64ToBytes(publicKey), ecdh, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256));
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return bytesToBase64(new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(`jotdrop:approval:v1:${approvalId}`) }, key, 256)));
}

try {
  const lines = [], checks = [];
  for (const [password, memory, passes, parallelism] of [
    ['correct horse battery staple', 65536, 3, 1],
    ['café au lait 日本 📝', 65536, 3, 1],
    ['twelve chars', 65536, 4, 2],
  ]) {
    const kdf = { salt: bytesToBase64(crypto.getRandomValues(new Uint8Array(16))), memory, passes, parallelism };
    const keys = await deriveKeys(password, kdf);
    lines.push(['kdf', encodeText(password), kdf.salt, memory, passes, parallelism, keys.authKey, keys.unlockKey].join('\t'));
    checks.push((result) => assert.equal(result, 'ok'));
  }
  // NFC: the decomposed and composed spellings must give the same keys on both sides.
  const nfcKdf = { salt: bytesToBase64(new Uint8Array(16).fill(7)), memory: 65536, passes: 3, parallelism: 1 };
  const composed = await deriveKeys('café au lait 1234', nfcKdf);
  lines.push(['kdf', encodeText('café au lait 1234'), nfcKdf.salt, 65536, 3, 1, composed.authKey, composed.unlockKey].join('\t'));
  checks.push((result) => assert.equal(result, 'ok'));

  const unlockKey = generateVaultKey(), vaultKey = generateVaultKey();
  const wrapped = await encryptEnvelope(unlockKey, { vaultKey }, 'jotdrop:wrap:v1');
  lines.push(['wrap', unlockKey, encodeText(JSON.stringify({ vaultKey })), wrapped.iv, wrapped.ciphertext].join('\t'));
  checks.push(async (result) => {
    const [iv, ciphertext] = result.split('\t');
    assert.deepEqual(await decryptEnvelope(unlockKey, { v: 1, iv, ciphertext }, 'jotdrop:wrap:v1'), { vaultKey });
  });

  for (let index = 0; index < 4; index += 1) {
    const publicKey = await exportPublic(await crypto.subtle.generateKey(ecdh, false, ['deriveBits']));
    lines.push(['words', publicKey, (await verificationWords(publicKey)).join(' ')].join('\t'));
    checks.push((result) => assert.equal(result, 'ok'));
  }

  const approvalId = '00000000-0000-4000-8000-000000000001';
  const device = await crypto.subtle.generateKey(ecdh, true, ['deriveBits']), phone = await crypto.subtle.generateKey(ecdh, false, ['deriveBits']);
  const pkcs8 = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', device.privateKey)));
  lines.push(['ecdh', pkcs8, await exportPublic(phone), approvalId, await approvalKey(phone.privateKey, await exportPublic(device), approvalId)].join('\t'));
  checks.push((result) => assert.equal(result, 'ok'));
  const browser = await crypto.subtle.generateKey(ecdh, false, ['deriveBits']);
  for (let index = 0; index < 3; index += 1) {
    lines.push(['ecdh-new', await exportPublic(browser), approvalId].join('\t'));
    checks.push(async (result) => {
      const [publicKey, key] = result.split('\t');
      assert.equal(base64ToBytes(publicKey).length, 65);
      assert.equal(key, await approvalKey(browser.privateKey, publicKey, approvalId));
    });
  }
  const offCurve = new Uint8Array(65); offCurve[0] = 4; offCurve[32] = 1; offCurve[64] = 1;
  for (const value of [bytesToBase64(offCurve), bytesToBase64(new Uint8Array(33).fill(2)), (await exportPublic(browser)).slice(0, -4)]) {
    lines.push(['bad-public', value].join('\t'));
    checks.push((result) => assert.equal(result, 'ok'));
  }

  const input = path.join(temporary, 'input.tsv'), output = path.join(temporary, 'output.tsv');
  writeFileSync(input, lines.join('\n'));
  const windows = process.platform === 'win32';
  execFileSync(windows ? process.env.ComSpec || 'cmd.exe' : './gradlew', windows ? ['/d', '/c', 'gradlew.bat checkCloudAccount --no-daemon --console=plain'] : ['checkCloudAccount', '--no-daemon', '--console=plain'], {
    cwd: path.join(root, 'android'), stdio: 'inherit',
    env: { ...process.env, JOTDROP_ACCOUNT_INPUT: input, JOTDROP_ACCOUNT_OUTPUT: output },
  });
  const results = readFileSync(output, 'utf8').split('\n');
  assert.equal(results.length, checks.length);
  for (const [index, result] of results.entries()) await checks[index](result);
  console.log(`JavaScript <-> Android JVM Argon2id, HKDF, vault key wrapping, verification words and ECDH approval keys passed (${results.length} vectors). Synthetic data only; no APK or device access.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

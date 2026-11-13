// Makes cloud/shared/ai/ai-key-vectors.json with plain WebCrypto, not through keysync.mjs, so the tests check
// keysync (and Android's Kotlin) against blobs made another way. Fixed IVs: the file comes out the same every time.
// Every key in here is fake. Run: node scripts/make-ai-key-vectors.mjs
import { writeFileSync } from 'node:fs';

const encoder = new TextEncoder();
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const fixed = (seed, length) => Uint8Array.from({ length }, (_, index) => (seed * 31 + index * 7) & 255);

const vaultKey = b64(fixed(1, 32)), otherKey = b64(fixed(2, 32));
const vaultId = '0b0f6f0e-3c56-4d0a-9d55-7a1c3a5e9f10', otherVault = '5d2a4c1b-8e7f-4a6b-b3c2-1f0e9d8c7b6a';

async function seal(key, aad, payload, ivSeed) {
  const iv = fixed(ivSeed, 12);
  const imported = await crypto.subtle.importKey('raw', Buffer.from(key, 'base64url'), 'AES-GCM', false, ['encrypt']);
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad), tagLength: 128 }, imported, encoder.encode(text));
  return JSON.stringify({ v: 1, iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) });
}
function padded(fields) {
  const body = { v: 1, ...fields, pad: '' };
  const length = encoder.encode(JSON.stringify(body)).length;
  body.pad = '0'.repeat((1024 - length % 1024) % 1024);
  return body;
}
const aad = (id) => `jotdrop:ai-key:v1:${id}`;
const claude = { provider: 'anthropic', key: 'sk-ant-test-NOT-A-REAL-KEY-0123456789', model: 'claude-haiku-5-5', baseUrl: '' };
const own = { provider: 'custom', key: 'test-own-address-NOT-A-REAL-KEY', model: 'my-model', baseUrl: 'https://ai.example.test/v1' };
const router = { provider: 'openrouter', key: 'sk-or-test-NOT-A-REAL-KEY-é', model: '', baseUrl: '' };

const good = await seal(vaultKey, aad(vaultId), padded(claude), 3);
const flipped = JSON.parse(good);
const bytes = Buffer.from(flipped.ciphertext, 'base64url');
bytes[40] ^= 1;
flipped.ciphertext = b64(bytes);

const vectors = {
  about: 'Ask JotDrop, the key on all your devices: blobs every app must open or refuse the same way, and what a device does with what the server answers. All keys are fake.',
  aad: 'jotdrop:ai-key:v1:<vaultId>',
  vaultKey, vaultId,
  opens: [
    { name: 'a Claude key, padded to 1024 bytes', sealed: good, config: claude },
    { name: 'an own https address with a key', sealed: await seal(vaultKey, aad(vaultId), padded(own), 4), config: own },
    { name: 'a key with a letter outside ASCII and no model', sealed: await seal(vaultKey, aad(vaultId), padded(router), 5), config: router },
    { name: 'without padding and with a field a later version added', sealed: await seal(vaultKey, aad(vaultId), { v: 1, ...claude, later: true }, 6), config: claude },
  ],
  refuses: [
    { name: 'sealed for another workspace (the AAD does not match)', sealed: await seal(vaultKey, aad(otherVault), padded(claude), 7) },
    { name: 'sealed with another key', sealed: await seal(otherKey, aad(vaultId), padded(claude), 8) },
    { name: 'a note envelope of the same workspace (another purpose in the AAD)', sealed: await seal(vaultKey, `jotdrop:object:v1:${vaultId}:${'ab'.repeat(32)}`, padded(claude), 9) },
    { name: 'space preferences of the same workspace', sealed: await seal(vaultKey, `jotdrop:space-prefs:v1:${vaultId}:${otherVault}`, padded(claude), 10) },
    { name: 'one bit of the ciphertext changed', sealed: JSON.stringify(flipped) },
    { name: 'a later format this app does not know', sealed: await seal(vaultKey, aad(vaultId), { ...padded(claude), v: 2 }, 11) },
    { name: 'a local model, which has no key to share', sealed: await seal(vaultKey, aad(vaultId), padded({ provider: 'ollama', key: '', model: 'llama', baseUrl: '' }), 12) },
    { name: 'an unknown service', sealed: await seal(vaultKey, aad(vaultId), padded({ ...claude, provider: 'elsewhere' }), 13) },
    { name: 'an own address without https', sealed: await seal(vaultKey, aad(vaultId), padded({ ...own, baseUrl: 'http://ai.example.test/v1' }), 14) },
    { name: 'an own address with a name and password in it', sealed: await seal(vaultKey, aad(vaultId), padded({ ...own, baseUrl: 'https://user:pass@ai.example.test/v1' }), 15) },
    { name: 'a fixed service with an address of its own', sealed: await seal(vaultKey, aad(vaultId), padded({ ...claude, baseUrl: 'https://evil.example.test/v1' }), 16) },
    { name: 'no key', sealed: await seal(vaultKey, aad(vaultId), padded({ ...claude, key: '' }), 17) },
    { name: 'a key with a line break', sealed: await seal(vaultKey, aad(vaultId), padded({ ...claude, key: 'sk-test\nX-Other: 1' }), 18) },
    { name: 'a key that is not text', sealed: await seal(vaultKey, aad(vaultId), padded({ ...claude, key: 12345 }), 19) },
    { name: 'not an object', sealed: await seal(vaultKey, aad(vaultId), '"sk-test"', 20) },
    { name: 'not JSON inside', sealed: await seal(vaultKey, aad(vaultId), 'sk-test', 21) },
    { name: 'not an envelope', sealed: '{"v":1}' },
    { name: 'not JSON', sealed: 'sealed' },
  ],
  shares: [
    { name: 'a Claude key', config: { provider: 'anthropic', key: '  sk-ant-test-NOT-A-REAL-KEY  ', model: ' claude-haiku-5-5 ', baseUrl: 'https://ignored.example.test', includeShared: true }, shared: { provider: 'anthropic', key: 'sk-ant-test-NOT-A-REAL-KEY', model: 'claude-haiku-5-5', baseUrl: '' } },
    { name: 'an own https address', config: { provider: 'custom', key: 'test-NOT-A-REAL-KEY', model: 'm', baseUrl: 'https://ai.example.test/v1/' }, shared: { provider: 'custom', key: 'test-NOT-A-REAL-KEY', model: 'm', baseUrl: 'https://ai.example.test/v1/' } },
    { name: 'a local model', config: { provider: 'ollama', key: '', model: 'llama', baseUrl: '' }, error: 'local' },
    { name: 'an own address on this computer', config: { provider: 'custom', key: 'k', model: 'm', baseUrl: 'http://127.0.0.1:8080' }, error: 'address' },
    { name: 'an own address without a key', config: { provider: 'custom', key: '', model: 'm', baseUrl: 'https://ai.example.test' }, error: 'key' },
    { name: 'nothing chosen', config: { provider: '', key: '', model: '', baseUrl: '' }, error: 'off' },
    { name: 'a key of 501 characters', config: { provider: 'openai', key: 'k'.repeat(501), model: '', baseUrl: '' }, error: 'key' },
  ],
  decisions: [
    { name: 'no key here, a key is ready', local: { hasKey: false, synced: 0 }, remote: { status: 'found', updatedAt: 1000, opens: true }, action: 'offer' },
    { name: 'an own key here, a shared one exists', local: { hasKey: true, synced: 0 }, remote: { status: 'found', updatedAt: 1000, opens: true }, action: 'available' },
    { name: 'the shared copy is current', local: { hasKey: true, synced: 1000 }, remote: { status: 'found', updatedAt: 1000, opens: true }, action: 'none' },
    { name: 'a newer key was shared', local: { hasKey: true, synced: 1000 }, remote: { status: 'found', updatedAt: 1001, opens: true }, action: 'update' },
    { name: 'the server shows an older blob again', local: { hasKey: true, synced: 1000 }, remote: { status: 'found', updatedAt: 999, opens: true }, action: 'none' },
    { name: 'a newer blob that does not open never replaces the copy', local: { hasKey: true, synced: 1000 }, remote: { status: 'found', updatedAt: 2000, opens: false }, action: 'none' },
    { name: 'a blob that does not open is not offered', local: { hasKey: false, synced: 0 }, remote: { status: 'found', updatedAt: 2000, opens: false }, action: 'none' },
    { name: 'removed on another device', local: { hasKey: true, synced: 1000 }, remote: { status: 'none' }, action: 'remove' },
    { name: 'nothing shared and nothing from sharing here', local: { hasKey: true, synced: 0 }, remote: { status: 'none' }, action: 'none' },
    { name: 'nothing shared, no key here', local: { hasKey: false, synced: 0 }, remote: { status: 'none' }, action: 'none' },
    { name: 'Plus ended: the copy stays', local: { hasKey: true, synced: 1000 }, remote: { status: 'plus' }, action: 'waiting' },
    { name: 'no Plus and nothing from sharing', local: { hasKey: true, synced: 0 }, remote: { status: 'plus' }, action: 'none' },
    { name: 'the server could not be reached: nothing changes', local: { hasKey: true, synced: 1000 }, remote: { status: 'unavailable' }, action: 'none' },
    { name: 'an answer without a usable time: nothing changes', local: { hasKey: true, synced: 1000 }, remote: { status: 'found', updatedAt: 'soon', opens: true }, action: 'none' },
    { name: 'an answer this app does not know: nothing changes', local: { hasKey: true, synced: 1000 }, remote: { status: 'gone' }, action: 'none' },
  ],
  services: [
    { name: 'the same service with another key and model', a: claude, b: { ...claude, key: 'sk-ant-test-NOT-A-REAL-KEY-other', model: 'claude-other' }, same: true },
    { name: 'another service', a: claude, b: router, same: false },
    { name: 'the same own address', a: own, b: { ...own, key: 'test-NOT-A-REAL-KEY-other' }, same: true },
    { name: 'an own address that moved', a: own, b: { ...own, baseUrl: 'https://elsewhere.example.test/v1' }, same: false },
    { name: 'no key here yet', a: claude, b: { provider: '', key: '', model: '', baseUrl: '' }, same: false },
    { name: 'nothing at all', a: claude, b: null, same: false },
  ],
  answers: [
    { name: 'a blob', response: { status: 200, body: { sealed: '<sealed>', updatedAt: 1000 } }, remote: 'found' },
    { name: 'no blob, said by a server that knows this address', response: { status: 404, body: { error: 'No key is kept for your devices.', code: 'no-ai-key' } }, remote: 'none' },
    { name: 'an older server that does not know this address', response: { status: 404, body: { error: 'Not found' } }, remote: 'unavailable' },
    { name: 'no Plus', response: { status: 402, body: { error: 'Plus', code: 'plus-required' } }, remote: 'plus' },
    { name: 'this app is not let in', response: { status: 403, body: { error: 'no', code: 'client-not-allowed' } }, remote: 'unavailable' },
    { name: 'signed out', response: { status: 401, body: { error: 'Device access denied' } }, remote: 'unavailable' },
    { name: 'a server error', response: { status: 500, body: { error: 'Internal server error' } }, remote: 'unavailable' },
    { name: 'busy', response: { status: 503, body: { error: 'Cloud is busy.' } }, remote: 'unavailable' },
    { name: 'a blob without a time', response: { status: 200, body: { sealed: '<sealed>' } }, remote: 'unavailable' },
    { name: 'a blob that is not text', response: { status: 200, body: { sealed: { v: 1 }, updatedAt: 1000 } }, remote: 'unavailable' },
  ],
};
writeFileSync(process.argv[2] ?? new URL('../cloud/shared/ai/ai-key-vectors.json', import.meta.url), `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`${vectors.opens.length} open, ${vectors.refuses.length} refuse, ${vectors.shares.length} share, ${vectors.decisions.length} decisions, ${vectors.answers.length} answers, ${vectors.services.length} services`);

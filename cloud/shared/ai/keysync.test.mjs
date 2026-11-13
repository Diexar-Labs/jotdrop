import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decryptEnvelope } from '../crypto.mjs';
import { decideKeySync, keyLabel, openKey, readSharedKey, removeSharedKey, sameService, saveSharedKey, sealKey, sharedKey } from './keysync.mjs';

const vectors = JSON.parse(readFileSync(new URL('./ai-key-vectors.json', import.meta.url), 'utf8'));
const { vaultKey, vaultId } = vectors;

for (const vector of vectors.opens) {
  test(`key sync opens: ${vector.name}`, async () => assert.deepEqual(await openKey(vaultKey, vaultId, vector.sealed), vector.config));
}
for (const vector of vectors.refuses) {
  test(`key sync refuses: ${vector.name}`, async () => assert.equal(await openKey(vaultKey, vaultId, vector.sealed), null));
}
for (const vector of vectors.shares) {
  test(`key sync shares: ${vector.name}`, () => {
    if (vector.error) assert.throws(() => sharedKey(vector.config), (error) => error.code === vector.error && typeof error.message === 'string' && (vector.config.key.length < 8 || !error.message.includes(vector.config.key)));
    else assert.deepEqual(sharedKey(vector.config), vector.shared);
  });
}
for (const vector of vectors.decisions) {
  test(`key sync decides: ${vector.name}`, () => {
    const { opens, ...remote } = vector.remote;
    assert.equal(decideKeySync(vector.local, remote.status === 'found' ? { ...remote, config: opens ? { provider: 'anthropic' } : null } : remote), vector.action);
  });
}

for (const vector of vectors.services) {
  test(`key sync, same service: ${vector.name}`, () => {
    assert.equal(sameService(vector.a, vector.b), vector.same);
    assert.equal(sameService(vector.b, vector.a), vector.same);
  });
}

test('key sync: the label names the service or the host of an own address, never the key', () => {
  assert.equal(keyLabel(vectors.opens[0].config), 'Claude (Anthropic)');
  assert.equal(keyLabel(vectors.opens[1].config), 'your own address ai.example.test');
  assert.equal(keyLabel({ provider: 'elsewhere', key: 'sk-test-NOT-A-REAL-KEY' }), 'an AI service');
  for (const { config } of vectors.opens) assert.ok(!keyLabel(config).includes(config.key));
});

// A client as the apps have it: credentials and call(). The answers come from the vectors.
function fakeClient(answer) {
  const calls = [];
  return { calls, credentials: { vaultKey, vaultId }, async call(path, method = 'GET', body) {
    calls.push({ path, method, body });
    const { status, body: reply } = answer({ path, method, body });
    if (status >= 200 && status < 300) return reply;
    throw Object.assign(new Error(reply.error), { status, code: reply.code });
  } };
}
for (const vector of vectors.answers) {
  test(`key sync reads: ${vector.name}`, async () => {
    const sealed = vectors.opens[0].sealed;
    const body = JSON.parse(JSON.stringify(vector.response.body).replace('"<sealed>"', JSON.stringify(sealed)));
    const client = fakeClient(() => ({ status: vector.response.status, body }));
    const remote = await readSharedKey(client);
    assert.equal(remote.status, vector.remote);
    assert.deepEqual(client.calls, [{ path: '/ai-key', method: 'GET', body: undefined }]);
    if (vector.remote === 'found') assert.deepEqual(remote, { status: 'found', updatedAt: 1000, config: vectors.opens[0].config });
  });
}

test('key sync: a broken connection is "unavailable", never "none"', async () => {
  const client = { credentials: { vaultKey, vaultId }, call: async () => { throw new TypeError('fetch failed'); } };
  assert.deepEqual(await readSharedKey(client), { status: 'unavailable' });
});

test('key sync: a blob that does not open is found without a configuration', async () => {
  const client = fakeClient(() => ({ status: 200, body: { sealed: vectors.refuses[0].sealed, updatedAt: 7 } }));
  assert.deepEqual(await readSharedKey(client), { status: 'found', updatedAt: 7, config: null });
});

test('key sync: what is sealed opens again, is padded to a fixed size and holds nothing but the four fields', async () => {
  const short = { provider: 'gemini', key: 'test-NOT-A-REAL-KEY', model: '', baseUrl: '' };
  const long = { provider: 'custom', key: `test-NOT-A-REAL-${'k'.repeat(400)}`, model: 'm'.repeat(150), baseUrl: `https://ai.example.test/${'p'.repeat(200)}` };
  const sizes = [];
  for (const config of [short, long]) {
    const sealed = await sealKey(vaultKey, vaultId, { ...config, includeShared: true, synced: 5 });
    assert.deepEqual(await openKey(vaultKey, vaultId, sealed), config);
    const inside = await decryptEnvelope(vaultKey, JSON.parse(sealed), `jotdrop:ai-key:v1:${vaultId}`);
    assert.deepEqual(Object.keys(inside).sort(), ['baseUrl', 'key', 'model', 'pad', 'provider', 'v']);
    assert.equal(new TextEncoder().encode(JSON.stringify(inside)).length % 1024, 0);
    assert.ok(sealed.length <= 8192, 'fits the server limit');
    assert.ok(!sealed.includes(config.key));
    sizes.push(sealed.length);
  }
  // A Gemini key is 39 characters and an OpenAI key over 150: the size must not tell the server which service it is.
  const other = await sealKey(vaultKey, vaultId, { provider: 'openai', key: `sk-test-NOT-A-REAL-${'k'.repeat(140)}`, model: 'gpt-6-luna', baseUrl: '' });
  assert.equal(other.length, sizes[0]);
  // A fresh IV each time: the same key sealed twice gives two different blobs.
  assert.notEqual(await sealKey(vaultKey, vaultId, short), await sealKey(vaultKey, vaultId, short));
});

test('key sync: sealing needs a workspace id in the form the server uses, and refuses what cannot be shared', async () => {
  const config = { provider: 'anthropic', key: 'sk-ant-test-NOT-A-REAL-KEY', model: '', baseUrl: '' };
  await assert.rejects(sealKey(vaultKey, vaultId.toUpperCase(), config), /workspace/i);
  await assert.rejects(sealKey(vaultKey, 'not-an-id', config), /workspace/i);
  await assert.rejects(sealKey(vaultKey, vaultId, { provider: 'ollama', key: '', model: 'llama' }), (error) => error.code === 'local');
  assert.equal(await openKey(vaultKey, vaultId.toUpperCase(), vectors.opens[0].sealed), null);
});

test('key sync: saving sends only the sealed blob and returns the server time; removing asks the server to delete', async () => {
  const config = { provider: 'anthropic', key: 'sk-ant-test-NOT-A-REAL-KEY', model: 'claude-haiku-5-5', baseUrl: '' };
  const client = fakeClient(({ method }) => ({ status: 200, body: method === 'PUT' ? { updatedAt: 4242 } : { ok: true } }));
  assert.equal(await saveSharedKey(client, { ...config, includeShared: true }), 4242);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(Object.keys(client.calls[0].body), ['sealed']);
  assert.ok(!JSON.stringify(client.calls[0]).includes(config.key));
  assert.deepEqual(await openKey(vaultKey, vaultId, client.calls[0].body.sealed), config);
  await removeSharedKey(client);
  assert.deepEqual(client.calls[1], { path: '/ai-key', method: 'DELETE', body: undefined });
  // A server that answers without a time did not save it in a way this device can follow.
  await assert.rejects(saveSharedKey(fakeClient(() => ({ status: 200, body: {} })), config), /did not/i);
  // Something that cannot be shared never reaches the server.
  const idle = fakeClient(() => ({ status: 200, body: { updatedAt: 1 } }));
  await assert.rejects(saveSharedKey(idle, { provider: 'ollama', key: '', model: 'llama' }), (error) => error.code === 'local');
  assert.equal(idle.calls.length, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudClient, CloudError, validateUrl } from './client.mjs';
import { generateVaultKey, randomToken } from './crypto.mjs';

test('client transmits opaque ciphertext, scoped credentials and strict optimistic revision', async () => {
  let sent;
  const client = new CloudClient({ url: 'http://127.0.0.1:8080', vaultId: crypto.randomUUID(), deviceId: crypto.randomUUID(), token: randomToken(), vaultKey: generateVaultKey(), fetcher: async (url, options) => { sent = { url, options }; return new Response(JSON.stringify({ revision: 1, sequence: 1 }), { status: 200 }); } });
  const prepared = await client.prepareWrite('notes/private.md', new TextEncoder().encode('secret note body'), 0);
  await client.commitWrite(prepared);
  assert.ok(!sent.options.body.includes('secret note body'));
  assert.ok(!sent.options.body.includes('private.md'));
  assert.ok(!sent.options.body.includes(client.credentials.vaultKey));
  assert.equal(JSON.parse(sent.options.body).baseRevision, 0);
  assert.equal(sent.options.headers['X-JotDrop-Vault'], client.credentials.vaultId);
  assert.equal(sent.options.redirect, 'error');
  const envelope = prepared.envelope;
  client.fetcher = async () => new Response(JSON.stringify({ id: prepared.id, revision: 1, deleted: false, envelope }), { status: 200 });
  assert.equal((await client.read(prepared.id)).file.path, 'notes/private.md');
  client.fetcher = async () => new Response(JSON.stringify({ error: 'Conflict', currentRevision: 2 }), { status: 409 });
  await assert.rejects(client.commitWrite(prepared), (error) => error instanceof CloudError && error.status === 409 && error.currentRevision === 2);
  await assert.rejects(client.prepareWrite('notes/x', new Uint8Array(4 * 1024 * 1024 + 1), 0));
});

test('client refuses insecure servers, URL credentials, path injection and malformed keys', () => {
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com?token=secret', 'https://example.com/subpath', 'file:///tmp/x']) assert.throws(() => validateUrl(url));
  assert.equal(validateUrl('https://example.com/'), 'https://example.com');
  assert.equal(validateUrl('http://localhost:8080'), 'http://localhost:8080');
  assert.throws(() => new CloudClient({ url: 'https://example.com', vaultId: crypto.randomUUID(), deviceId: crypto.randomUUID(), token: 'bad', vaultKey: generateVaultKey() }));
});

test('client bounds streamed response bytes and cancels before buffering the entire body', async () => {
  const chunk = new TextEncoder().encode('\u00e9'.repeat(512 * 1024));
  let pulls = 0, cancelled = false;
  const client = new CloudClient({ url: 'https://example.com', vaultId: crypto.randomUUID(), deviceId: crypto.randomUUID(), token: randomToken(), vaultKey: generateVaultKey(), fetcher: async () => new Response(new ReadableStream({
    pull(controller) {
      if (pulls === 0) controller.enqueue(new TextEncoder().encode('{"padding":"'));
      else if (pulls <= 18) controller.enqueue(chunk);
      else { controller.enqueue(new TextEncoder().encode('"}')); controller.close(); }
      pulls++;
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 })) });
  await assert.rejects(client.status(), (error) => error instanceof CloudError && error.status === 502);
  assert.ok(cancelled);
  assert.ok(pulls < 20);
});

test('client rejects announced oversized responses before reading and rejects non-object JSON', async () => {
  let pulls = 0, cancelled = false;
  const client = new CloudClient({ url: 'https://example.com', vaultId: crypto.randomUUID(), deviceId: crypto.randomUUID(), token: randomToken(), vaultKey: generateVaultKey(), fetcher: async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode('{}')); controller.close(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers: { 'Content-Length': String(16 * 1024 * 1024 + 1) } }) });
  await assert.rejects(client.status(), (error) => error instanceof CloudError && error.status === 502);
  assert.equal(pulls, 0);
  assert.ok(cancelled);
  for (const status of [200, 401]) for (const value of [null, [], 'not an object']) {
    client.fetcher = async () => new Response(JSON.stringify(value), { status });
    await assert.rejects(client.status(), (error) => error instanceof CloudError && error.status === status);
  }
  client.fetcher = async () => new Response(new ReadableStream({
    start(controller) {
      for (const byte of new TextEncoder().encode('{"name":"\u00e9"}')) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }));
  assert.deepEqual(await client.status(), { name: '\u00e9' });
});

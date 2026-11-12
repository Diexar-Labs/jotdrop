import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AiError, TRANSCRIBE_MODEL, buildRequest, createProvider, keyRequest, parseTranscription, transcribeRequest } from './providers.mjs';

// A part with "size" gets that many zero bytes as base64 (the same as in parts.test.mjs).
const fakeData = (size) => 'A'.repeat(4 * Math.floor(size / 3)) + ['', 'AA==', 'AAA='][size % 3];
const withData = (part) => part.size === undefined ? part : (({ size, ...rest }) => ({ ...rest, data: fakeData(size) }))(part);

const vectors = JSON.parse(readFileSync(new URL('./ai-vectors-v2.json', import.meta.url), 'utf8'));
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const failure = (fn) => { try { fn(); } catch (error) { return error; } return null; };
const bytesOf = (body) => body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(String(body), 'utf8');

test('the transcription model was checked on 11 Nov 2026 (whisper-1 and gpt-4o-transcribe stop on 26 Feb 2027)', () => {
  assert.equal(TRANSCRIBE_MODEL, 'gpt-transcribe');
});

for (const vector of vectors.partRequests) {
  test(`request with files: ${vector.name}`, () => {
    if (vector.error) {
      const error = failure(() => buildRequest(vector.config, { ...vector.input, tools: [] }));
      assert.ok(error instanceof AiError, String(error));
      assert.equal(error.code, vector.error);
      assert.ok(error.detail.length > 10, 'the detail says what cannot go');
      return;
    }
    const request = buildRequest(vector.config, { ...vector.input, tools: [] });
    assert.equal(request.url, vector.expect.url);
    assert.equal(request.method, vector.expect.method);
    assert.deepEqual(request.headers, vector.expect.headers);
    assert.deepEqual(JSON.parse(request.body), vector.expect.body);
  });
}

for (const vector of vectors.partErrors) {
  test(`service error with files: ${vector.name}`, async () => {
    const provider = createProvider(vector.config, async () => reply(vector.status, vector.body));
    const error = await provider.complete({ system: 'S', messages: [{ role: 'user', text: 'Hi', parts: vector.parts }], tools: [] }).then(() => null, (e) => e);
    assert.ok(error instanceof AiError, String(error));
    assert.equal(error.code, vector.expect.code);
    if (vector.config.key) assert.ok(!JSON.stringify({ ...error, message: error.message }).includes(vector.config.key));
  });
}

for (const vector of vectors.transcribe) {
  test(`transcribe: ${vector.name}`, () => {
    const input = { audio: withData(vector.audio), language: vector.language, boundary: vector.boundary };
    if (vector.error) {
      const error = failure(() => transcribeRequest(vector.config, input));
      assert.ok(error instanceof AiError, String(error));
      assert.equal(error.code, vector.error);
      return;
    }
    const request = transcribeRequest(vector.config, input);
    assert.equal(request.url, vector.expect.url);
    assert.equal(request.method, vector.expect.method);
    assert.deepEqual(request.headers, vector.expect.headers);
    if (vector.expect.body) assert.deepEqual(JSON.parse(request.body), vector.expect.body);
    if (vector.expect.bodyText) {
      assert.ok(request.body instanceof Uint8Array, 'the multipart body is bytes, for every fetcher');
      assert.equal(bytesOf(request.body).toString('latin1'), vector.expect.bodyText);
    }
    if (vector.expect.bodyBase64) {
      assert.ok(request.body instanceof Uint8Array);
      assert.equal(bytesOf(request.body).toString('base64'), vector.expect.bodyBase64);
    }
  });
}

for (const vector of vectors.transcribeResponses) {
  test(`transcription answer: ${vector.name}`, () => {
    if (vector.error) {
      const error = failure(() => parseTranscription(vector.provider, vector.json));
      assert.ok(error instanceof AiError, String(error));
      assert.equal(error.code, vector.error);
      return;
    }
    assert.deepEqual(parseTranscription(vector.provider, vector.json), vector.expect);
  });
}

test('a boundary is made fresh when none is given, and never appears in the recording', () => {
  const audio = { kind: 'audio', mime: 'audio/mp4', name: 'a.m4a', data: 'ZmFrZSBtNGE=' };
  const one = transcribeRequest({ provider: 'openai', key: 'sk-proj-test-key-0002' }, { audio });
  const two = transcribeRequest({ provider: 'openai', key: 'sk-proj-test-key-0002' }, { audio });
  const boundary = /boundary=(.+)$/.exec(one.headers['Content-Type'])[1];
  assert.match(boundary, /^jotdrop-[0-9a-f]{32}$/);
  assert.notEqual(boundary, /boundary=(.+)$/.exec(two.headers['Content-Type'])[1]);
  assert.ok(bytesOf(one.body).toString('latin1').endsWith(`--${boundary}--\r\n`));
});

test('provider.transcribe sends the bytes through the app fetcher and keeps the key out of errors', async () => {
  const seen = [];
  const key = 'sk-proj-test-key-0002';
  const ok = createProvider({ provider: 'openai', key }, async (url, init) => { seen.push({ url, init }); return reply(200, { text: 'Hallo', usage: { type: 'tokens', input_tokens: 3, output_tokens: 1 } }); });
  const audio = { kind: 'audio', mime: 'audio/webm', name: 'voice.webm', data: 'GkXfowD/DQotLQ==' };
  assert.deepEqual(await ok.transcribe({ audio, language: 'nl' }), { text: 'Hallo', usage: { input: 3, output: 1 } });
  assert.equal(seen[0].url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.ok(seen[0].init.body instanceof Uint8Array);
  assert.ok(bytesOf(seen[0].init.body).includes(Buffer.from('GkXfowD/DQotLQ==', 'base64')));

  const bad = createProvider({ provider: 'openai', key }, async () => reply(401, { error: { message: `Incorrect API key provided: ${key}` } }));
  const error = await bad.transcribe({ audio }).then(() => null, (e) => e);
  assert.equal(error.code, 'auth');
  assert.ok(!JSON.stringify({ ...error, message: error.message }).includes(key));

  const stop = new AbortController();
  stop.abort(new DOMException('Stopped.', 'AbortError'));
  const cancelled = await createProvider({ provider: 'openai', key }, async (url, init) => { if (init.signal?.aborted) throw new Error('aborted'); return reply(200, { text: 'x' }); })
    .transcribe({ audio, signal: stop.signal }).then(() => null, (e) => e);
  assert.equal(cancelled.code, 'cancelled');
});

test('provider.transcribe refuses before anything goes out when the service cannot listen', async () => {
  let calls = 0;
  const provider = createProvider({ provider: 'anthropic', key: 'sk-ant-api03-test-key-0001' }, async () => { calls++; return reply(200, {}); });
  const error = await provider.transcribe({ audio: { kind: 'audio', mime: 'audio/mp4', name: 'a.m4a', data: 'ZmFrZSBtNGE=' } }).then(() => null, (e) => e);
  assert.equal(error.code, 'unsupported_input');
  assert.equal(error.detail, 'Claude cannot listen to recordings. Gemini and OpenAI can.');
  assert.equal(calls, 0);
});

test('a message with files goes out as JSON text; a version 1 message is unchanged', () => {
  const config = { provider: 'openai', key: 'sk-proj-test-key-0002' };
  const plain = buildRequest(config, { system: 'S', messages: [{ role: 'user', text: 'Hi' }] });
  const empty = buildRequest(config, { system: 'S', messages: [{ role: 'user', text: 'Hi', parts: [] }] });
  assert.equal(empty.body, plain.body);
  assert.equal(typeof buildRequest(config, { system: 'S', messages: [{ role: 'user', text: 'Hi', parts: [{ kind: 'image', mime: 'image/jpeg', name: 'a.jpg', data: '/9j/4AAQ' }] }] }).body, 'string');
});

// 12 Nov 2026: "Test and load models" said "Connected" on OpenRouter with a wrong key, because its model list is public.
// Only the key's own address (GET /key) says no with a wrong key, so OpenRouter is asked there first.
for (const vector of vectors.keyRequests) {
  test(`key check: ${vector.name}`, () => {
    const request = keyRequest(vector.config);
    if (vector.expect === null) { assert.equal(request, null); return; }
    assert.equal(request.url, vector.expect.url);
    assert.equal(request.method, 'GET');
    assert.deepEqual(request.headers, vector.expect.headers);
  });
}

test('OpenRouter listModels checks the key first: a wrong key is an auth error and the list is never asked', async () => {
  const calls = [];
  const fetcher = async (url) => { calls.push(url); return url.endsWith('/key') ? reply(401, { error: { message: 'User not found.', code: 401 } }) : reply(200, { data: [{ id: 'a/b', name: 'B' }] }); };
  const provider = createProvider({ provider: 'openrouter', key: 'sk-or-v1-wrong-0009', model: 'any' }, fetcher);
  const error = await provider.listModels().catch((e) => e);
  assert.ok(error instanceof AiError);
  assert.equal(error.code, 'auth');
  assert.ok(!`${error.message} ${error.detail}`.includes('sk-or-v1-wrong-0009'));
  assert.deepEqual(calls, ['https://openrouter.ai/api/v1/key']);
});

test('OpenRouter listModels with a good key asks /key, then the list', async () => {
  const calls = [];
  const fetcher = async (url) => { calls.push(url); return url.endsWith('/key') ? reply(200, { data: { label: 'sk-or-v1-abc...xyz', limit: 5 } }) : reply(200, { data: [{ id: 'a/b', name: 'B' }] }); };
  const provider = createProvider({ provider: 'openrouter', key: 'sk-or-v1-good-0010', model: 'any' }, fetcher);
  const models = await provider.listModels();
  assert.deepEqual(models.map((m) => m.id), ['a/b']);
  assert.deepEqual(calls, ['https://openrouter.ai/api/v1/key', 'https://openrouter.ai/api/v1/models']);
});

test('the other services ask for their model list only, as before', async () => {
  const calls = [];
  const fetcher = async (url) => { calls.push(url); return reply(200, { data: [] }); };
  await createProvider({ provider: 'openai', key: 'sk-proj-test-key-0002', model: 'any' }, fetcher).listModels();
  assert.deepEqual(calls, ['https://api.openai.com/v1/models']);
});

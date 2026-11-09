import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AiError, PROVIDERS, buildRequest, checkAddress, createProvider, modelsRequest, parseModels, parseResponse, pickDefaultModel } from './providers.mjs';

const vectors = JSON.parse(readFileSync(new URL('./ai-vectors.json', import.meta.url), 'utf8'));
const reply = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('five providers plus your own address; the defaults checked on 9 Nov 2026', () => {
  assert.deepEqual(Object.keys(PROVIDERS), ['anthropic', 'openai', 'gemini', 'openrouter', 'ollama', 'custom']);
  assert.equal(PROVIDERS.anthropic.defaultModel, 'claude-haiku-5-5');
  assert.equal(PROVIDERS.openai.defaultModel, 'gpt-6-luna');
  assert.equal(PROVIDERS.gemini.defaultModel, 'gemini-3.5-flash-lite');
  assert.equal(PROVIDERS.ollama.needsKey, false);
  assert.equal(PROVIDERS.custom.needsKey, false);
  // Only the web app's fixed addresses can be reached from a browser page (CSP, design 5.4).
  assert.deepEqual(Object.entries(PROVIDERS).filter(([, p]) => p.web).map(([id]) => id), ['anthropic', 'openai', 'gemini', 'openrouter', 'ollama']);
});

for (const vector of vectors.requests) {
  test(`request: ${vector.name}`, () => {
    const request = buildRequest(vector.config, { ...vector.input, tools: [vectors.tool] });
    assert.equal(request.url, vector.expect.url);
    assert.equal(request.method, vector.expect.method);
    assert.deepEqual(request.headers, vector.expect.headers);
    assert.deepEqual(JSON.parse(request.body), vector.expect.body);
  });
}

for (const vector of vectors.responses) {
  test(`response: ${vector.name}`, () => {
    assert.deepEqual(parseResponse(vector.provider, vector.json), vector.expect);
  });
}

for (const vector of vectors.errors) {
  test(`error: ${vector.name}`, async () => {
    const fetcher = async () => reply(vector.status, vector.text ?? vector.body);
    const provider = createProvider(vector.config, fetcher);
    const error = await provider.complete({ system: 'S', messages: [{ role: 'user', text: 'Hi' }], tools: [] }).then(() => null, (e) => e);
    assert.ok(error instanceof AiError, String(error));
    assert.equal(error.code, vector.expect.code);
    assert.ok(error.message.length > 10);
    // Neither the message nor the detail nor anything else on the error shows the key.
    if (vector.config.key) assert.ok(!JSON.stringify({ ...error, message: error.message, stack: error.stack }).includes(vector.config.key));
  });
}

for (const vector of vectors.models) {
  test(`models: ${vector.name}`, () => {
    const models = parseModels(vector.provider, vector.json);
    assert.deepEqual(models.map(({ id, name, tools }) => ({ id, name, tools })), vector.expect);
    assert.equal(pickDefaultModel(vector.provider, models), vector.default);
  });
}

test('the model lists are asked with the right address and headers', () => {
  for (const vector of vectors.modelRequests) {
    const request = modelsRequest(vector.config);
    assert.equal(request.url, vector.expect.url);
    assert.deepEqual(request.headers, vector.expect.headers);
  }
});

test('own address: https anywhere, http only on this computer', () => {
  for (const vector of vectors.addresses) assert.equal(checkAddress(vector.baseUrl), vector.ok, vector.baseUrl);
  assert.throws(() => createProvider({ provider: 'custom', baseUrl: 'http://192.168.1.20:11434', model: 'm' }, () => assert.fail('no network')), (e) => e.code === 'bad_address');
});

test('no key or no model: an error before anything goes out', () => {
  const fetcher = () => assert.fail('nothing may go out');
  for (const key of [undefined, '', '   ']) assert.throws(() => createProvider({ provider: 'anthropic', key }, fetcher), (e) => e instanceof AiError && e.code === 'no_key');
  assert.throws(() => createProvider({ provider: 'openrouter', key: 'sk-or-v1-x' }, fetcher), (e) => e.code === 'no_model');
  assert.throws(() => createProvider({ provider: 'mystery', key: 'x' }, fetcher), (e) => e.code === 'no_provider');
});

test('complete and listModels go through the given fetcher, with the abort signal', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/models?limit=1000')) return reply(200, vectors.models[0].json);
    return reply(200, vectors.responses[0].json);
  };
  const provider = createProvider({ provider: 'anthropic', key: 'sk-ant-api03-test-key-0001' }, fetcher);
  assert.equal(provider.model, 'claude-haiku-5-5');
  const answer = await provider.complete({ system: 'S', messages: [{ role: 'user', text: 'Hi' }], tools: [], signal });
  assert.equal(answer.text, 'Hello');
  assert.equal(calls[0].init.signal, signal);
  assert.equal(calls[0].init.method, 'POST');
  const models = await provider.listModels({ signal });
  assert.equal(models.length, 2);
  assert.equal(calls[1].init.method, 'GET');
});

test('network trouble and a cut-off wait become errors without the key', async () => {
  const key = 'sk-proj-SECRET-0123456789';
  const down = createProvider({ provider: 'openai', key }, async () => { throw new TypeError(`fetch failed for Bearer ${key}`); });
  const network = await down.complete({ system: 'S', messages: [{ role: 'user', text: 'Hi' }], tools: [] }).catch((e) => e);
  assert.equal(network.code, 'network');
  assert.ok(!`${network.message} ${network.detail}`.includes(key));
  const controller = new AbortController();
  const slow = createProvider({ provider: 'openai', key }, (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))));
  const waiting = slow.complete({ system: 'S', messages: [{ role: 'user', text: 'Hi' }], tools: [], signal: controller.signal }).catch((e) => e);
  controller.abort(new DOMException('Too slow', 'TimeoutError'));
  assert.equal((await waiting).code, 'timeout');
});

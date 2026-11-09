import { redact } from './redact.mjs';

// The AI services Ask JotDrop talks to, straight from this device with the user's own key; never through our
// server. Three forms: Anthropic's Messages API, OpenAI's Chat Completions (also OpenRouter, Ollama and any
// OpenAI-compatible address) and Gemini's generateContent. No streaming in version 1.
//
// Messages are in JotDrop's own form, the same for every provider:
//   { role: 'user', text }
//   { role: 'assistant', text, toolCalls: [{ id, name, input }], raw }   raw: the provider's own content, sent back
//                                                                         as it came (thinking blocks, signatures)
//   { role: 'tool', results: [{ id, name, content, isError }] }
// complete() answers { text, toolCalls, stop: 'end' | 'tool' | 'length' | 'refusal', usage: { input, output }, raw }.
// A tool call whose arguments cannot be read has input null and error 'invalid_arguments'.
//
// The fetcher is the app's: fetch in the browser and Joplin, cloudFetch in Obsidian. Model ids and the Anthropic
// API version were checked on 9 Nov 2026 (claude-api skill, OpenAI and Google model pages).

export const ANTHROPIC_VERSION = '2026-10-21';
const MAX_TOKENS = 16000;
const DETAIL = 300;

export const PROVIDERS = {
  anthropic: { name: 'Claude (Anthropic)', form: 'anthropic', needsKey: true, web: true, base: 'https://api.anthropic.com', defaultModel: 'claude-haiku-5-5' },
  openai: { name: 'OpenAI', form: 'openai', needsKey: true, web: true, base: 'https://api.openai.com/v1', defaultModel: 'gpt-6-luna' },
  gemini: { name: 'Gemini (Google)', form: 'gemini', needsKey: true, web: true, base: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-3.5-flash-lite' },
  openrouter: { name: 'OpenRouter', form: 'openai', needsKey: true, web: true, base: 'https://openrouter.ai/api/v1', defaultModel: null, headers: { 'HTTP-Referer': 'https://jotdrop.net', 'X-Title': 'JotDrop' } },
  ollama: { name: 'Local model (Ollama)', form: 'openai', needsKey: false, web: true, base: 'http://127.0.0.1:11434/v1', defaultModel: null },
  custom: { name: 'Own address (OpenAI-compatible)', form: 'openai', needsKey: false, web: false, base: null, defaultModel: null },
};

const MESSAGES = {
  no_provider: 'Choose an AI provider in Settings.',
  no_key: 'AI is off. Add your own key in Settings to use Ask JotDrop.',
  no_model: 'Choose a model in Settings.',
  bad_address: 'Use an https address, or one on this computer such as http://127.0.0.1:11434.',
  auth: 'The AI service did not accept the key. Check it in Settings.',
  quota: 'The AI service says there is no credit left on this account.',
  rate: 'The AI service is busy or a limit was reached. Try again in a minute.',
  model: 'The AI service does not know this model. Choose another one in Settings.',
  bad_request: 'The AI service did not accept the request.',
  server: 'The AI service has a problem right now. Try again later.',
  network: 'Could not reach the AI service.',
  timeout: 'The AI service took too long to answer.',
  cancelled: 'Stopped.',
  bad_response: 'The AI service sent an answer JotDrop does not understand.',
};

/** An error for the user: a fixed message per code, and a short detail from the service with keys hidden. */
export class AiError extends Error {
  constructor(code, detail = '', status = 0) {
    super(MESSAGES[code] ?? MESSAGES.bad_request);
    this.name = 'AiError';
    this.code = code;
    this.detail = String(detail).slice(0, DETAIL);
    this.status = status;
  }
}

const LOCAL_HOSTS = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/i;

/** An own address may be https anywhere, or http on this computer only. */
export function checkAddress(address) {
  try {
    const url = new URL(address);
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.test(url.hostname));
  } catch {
    return false;
  }
}

// The provider, key, model and address for a configuration, or the reason AI cannot run. Nothing goes out here.
function resolve(config = {}, needModel = true) {
  const spec = PROVIDERS[config.provider];
  if (!spec) throw new AiError('no_provider');
  const key = String(config.key ?? '').trim();
  if (spec.needsKey && !key) throw new AiError('no_key');
  let base = spec.base;
  if (!base) {
    if (!checkAddress(String(config.baseUrl ?? '').trim())) throw new AiError('bad_address');
    base = String(config.baseUrl).trim().replace(/\/+$/, '');
    if (!/\/v1$/.test(base)) base += '/v1';
  }
  const model = String(config.model ?? '').trim() || spec.defaultModel;
  if (needModel && !model) throw new AiError('no_model');
  return { id: config.provider, spec, key, base, model };
}

function headersFor({ spec, key }, json) {
  const type = json ? { 'Content-Type': 'application/json' } : {};
  if (spec.form === 'anthropic') return { ...type, 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' };
  if (spec.form === 'gemini') return { ...type, 'x-goog-api-key': key };
  return { ...type, ...(key ? { Authorization: `Bearer ${key}` } : {}), ...spec.headers };
}

// Gemini's function declarations take an OpenAPI subset without additionalProperties.
function openApi(schema) {
  if (Array.isArray(schema)) return schema.map(openApi);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== 'additionalProperties').map(([key, value]) => [key, openApi(value)]));
}

const isGeminiOwnId = (id) => typeof id === 'string' && !id.startsWith('gemini_');

function anthropicMessages(messages) {
  return messages.map((message) => {
    if (message.role === 'user') return { role: 'user', content: message.text };
    if (message.role === 'tool') return { role: 'user', content: message.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })) };
    return { role: 'assistant', content: message.raw ?? [...(message.text ? [{ type: 'text', text: message.text }] : []), ...(message.toolCalls ?? []).map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} }))] };
  });
}

function openAiMessages(system, messages) {
  return [{ role: 'system', content: system }, ...messages.flatMap((message) => {
    if (message.role === 'user') return [{ role: 'user', content: message.text }];
    if (message.role === 'tool') return message.results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.content }));
    if (message.raw) return [{ role: 'assistant', ...message.raw }];
    const calls = (message.toolCalls ?? []).map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }));
    return [{ role: 'assistant', content: message.text || null, ...(calls.length ? { tool_calls: calls } : {}) }];
  })];
}

function geminiContents(messages) {
  return messages.map((message) => {
    if (message.role === 'user') return { role: 'user', parts: [{ text: message.text }] };
    if (message.role === 'tool') return { role: 'user', parts: message.results.map((r) => ({ functionResponse: { ...(isGeminiOwnId(r.id) ? { id: r.id } : {}), name: r.name, response: r.isError ? { error: r.content } : { content: r.content } } })) };
    return { role: 'model', parts: message.raw ?? [...(message.text ? [{ text: message.text }] : []), ...(message.toolCalls ?? []).map((c) => ({ functionCall: { ...(isGeminiOwnId(c.id) ? { id: c.id } : {}), name: c.name, args: c.input ?? {} } }))] };
  });
}

/** The HTTP request for one round: { url, method, headers, body }. Throws AiError when AI cannot run. */
export function buildRequest(config, { system, messages, tools = [] }) {
  const target = resolve(config);
  const { spec, base, model } = target;
  const headers = headersFor(target, true);
  let url, body;
  if (spec.form === 'anthropic') {
    url = `${base}/v1/messages`;
    body = { model, max_tokens: MAX_TOKENS, system, messages: anthropicMessages(messages), ...(tools.length ? { tools: tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })) } : {}) };
  } else if (spec.form === 'gemini') {
    url = `${base}/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`;
    body = { systemInstruction: { parts: [{ text: system }] }, contents: geminiContents(messages), ...(tools.length ? { tools: [{ functionDeclarations: tools.map(({ name, description, input_schema }) => ({ name, description, parameters: openApi(input_schema) })) }] } : {}) };
  } else {
    url = `${base}/chat/completions`;
    body = { model, messages: openAiMessages(system, messages), ...(tools.length ? { tools: tools.map(({ name, description, input_schema }) => ({ type: 'function', function: { name, description, parameters: input_schema } })) } : {}) };
  }
  return { url, method: 'POST', headers, body: JSON.stringify(body) };
}

/** The request for the provider's model list. */
export function modelsRequest(config) {
  const target = resolve(config, false);
  const { spec, base } = target;
  const path = spec.form === 'anthropic' ? '/v1/models?limit=1000' : spec.form === 'gemini' ? '/models?pageSize=1000' : '/models';
  return { url: `${base}${path}`, method: 'GET', headers: headersFor(target, false) };
}

const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const REFUSED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);

/** One round's answer in JotDrop's form. */
export function parseResponse(provider, json) {
  const form = PROVIDERS[provider]?.form;
  if (form === 'anthropic') {
    const content = Array.isArray(json?.content) ? json.content : [];
    const toolCalls = content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: plainObject(b.input) ? b.input : {} }));
    const stop = { refusal: 'refusal', max_tokens: 'length', tool_use: 'tool' }[json?.stop_reason] ?? (toolCalls.length ? 'tool' : 'end');
    return { text: content.filter((b) => b.type === 'text').map((b) => b.text).join(''), toolCalls, stop, usage: { input: json?.usage?.input_tokens ?? 0, output: json?.usage?.output_tokens ?? 0 }, raw: content };
  }
  if (form === 'gemini') {
    const candidate = json?.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const toolCalls = parts.flatMap((part, index) => part.functionCall ? [{ id: part.functionCall.id ?? `gemini_${index}`, name: part.functionCall.name, ...(plainObject(part.functionCall.args ?? {}) ? { input: part.functionCall.args ?? {} } : { input: null, error: 'invalid_arguments' }) }] : []);
    const reason = candidate?.finishReason;
    const stop = !candidate || REFUSED.has(reason) ? 'refusal' : reason === 'MAX_TOKENS' ? 'length' : toolCalls.length ? 'tool' : 'end';
    if (!candidate && !json?.promptFeedback) throw new AiError('bad_response');
    return { text: parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join(''), toolCalls, stop, usage: { input: json?.usageMetadata?.promptTokenCount ?? 0, output: json?.usageMetadata?.candidatesTokenCount ?? 0 }, raw: parts };
  }
  const choice = json?.choices?.[0];
  if (!choice) throw new AiError('bad_response');
  const message = choice.message ?? {};
  const toolCalls = (message.tool_calls ?? []).map((call, index) => {
    const name = call.function?.name ?? '', id = call.id ?? `call_${index}`, args = call.function?.arguments;
    let input;
    try { input = typeof args === 'string' ? JSON.parse(args || '{}') : args ?? {}; } catch { input = undefined; }
    return plainObject(input) ? { id, name, input } : { id, name, input: null, error: 'invalid_arguments' };
  });
  const stop = choice.finish_reason === 'content_filter' ? 'refusal' : choice.finish_reason === 'length' ? 'length' : toolCalls.length ? 'tool' : 'end';
  // OpenRouter asks reasoning models to get their reasoning_details back unchanged; OpenAI does not take the field.
  const raw = { content: message.content ?? null, ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}), ...(provider === 'openrouter' && message.reasoning_details ? { reasoning_details: message.reasoning_details } : {}) };
  return { text: typeof message.content === 'string' ? message.content : '', toolCalls, stop, usage: { input: json?.usage?.prompt_tokens ?? 0, output: json?.usage?.completion_tokens ?? 0 }, raw };
}

const NOT_CHAT = /embed|tts|whisper|transcri|dall-e|image|moderation|realtime|audio|live|search/i;

/** The provider's model list as [{ id, name, tools }]; tools is null when the list does not say. */
export function parseModels(provider, json) {
  const form = PROVIDERS[provider]?.form;
  if (form === 'anthropic') return (json?.data ?? []).map((m) => ({ id: m.id, name: m.display_name || m.id, tools: true }));
  if (form === 'gemini') return (json?.models ?? []).filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent')).map((m) => { const id = String(m.name).replace(/^models\//, ''); return { id, name: m.displayName || id, tools: true }; });
  if (provider === 'openrouter') return (json?.data ?? []).map((m) => ({ id: m.id, name: m.name || m.id, tools: (m.supported_parameters ?? []).includes('tools'), price: Number(m.pricing?.prompt ?? 0) + Number(m.pricing?.completion ?? 0) }));
  return (json?.data ?? []).filter((m) => provider !== 'openai' || !NOT_CHAT.test(m.id)).map((m) => ({ id: m.id, name: m.id, tools: null }));
}

/** The model to start with: the fixed default when the list has it; on OpenRouter the cheapest paid one with tools. */
export function pickDefaultModel(provider, models) {
  const spec = PROVIDERS[provider];
  if (spec?.defaultModel && models.some((m) => m.id === spec.defaultModel)) return spec.defaultModel;
  if (provider === 'openrouter') return models.filter((m) => m.tools && m.price > 0).sort((a, b) => a.price - b.price)[0]?.id ?? null;
  return spec?.defaultModel ? models[0]?.id ?? null : null;
}

function readError(status, json, text, secrets) {
  const info = json?.error ?? {};
  const message = typeof info === 'string' ? info : info.message ?? (json ? '' : text);
  const reasons = (info.details ?? []).map((d) => d?.reason);
  const detail = redact(message, secrets);
  if (reasons.includes('API_KEY_INVALID') || (status === 400 && /api key/i.test(message))) return new AiError('auth', detail, status);
  if (status === 401 || status === 403) return new AiError('auth', detail, status);
  if (status === 402 || info.code === 'insufficient_quota' || info.type === 'insufficient_quota') return new AiError('quota', detail, status);
  if (status === 429) return new AiError('rate', detail, status);
  if (status === 404) return new AiError('model', detail, status);
  if (status >= 500) return new AiError('server', detail, status);
  return new AiError('bad_request', detail, status);
}

/**
 * A provider for one configuration { provider, key, model, baseUrl }. Throws AiError (no_provider, no_key,
 * no_model, bad_address) before anything goes out. The object it gives does not carry the key.
 */
export function createProvider(config, fetcher = (url, init) => globalThis.fetch(url, init)) {
  const target = resolve(config);
  const secrets = [target.key];
  async function send(request, signal) {
    let response;
    try {
      response = await fetcher(request.url, { method: request.method, headers: request.headers, body: request.body, signal });
    } catch (error) {
      if (signal?.aborted) throw new AiError(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled');
      throw new AiError('network', redact(error, secrets));
    }
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    // OpenRouter can put an error inside a 200 answer.
    if (!response.ok || plainObject(json?.error)) throw readError(response.ok ? Number(json.error.code) || 400 : response.status, json, text, secrets);
    if (json === undefined) throw new AiError('bad_response', redact(text, secrets));
    return json;
  }
  return {
    id: target.id,
    model: target.model,
    async complete({ system, messages, tools = [], signal }) {
      return parseResponse(target.id, await send(buildRequest(config, { system, messages, tools }), signal));
    },
    async listModels({ signal } = {}) {
      return parseModels(target.id, await send(modelsRequest(config), signal));
    },
  };
}

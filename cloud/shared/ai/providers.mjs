import { redact } from './redact.mjs';
import { base64Bytes, capabilities, checkParts, explain } from './parts.mjs';

// The AI services Ask JotDrop talks to, straight from this device with the user's own key; never through our
// server. Three forms: Anthropic's Messages API, OpenAI's Chat Completions (also OpenRouter, Ollama and any
// OpenAI-compatible address) and Gemini's generateContent. No streaming in version 1.
//
// Messages are in JotDrop's own form, the same for every provider:
//   { role: 'user', text, parts? }    parts: files the user pointed at (parts.mjs); without them the request is
//                                     byte for byte the one of version 1
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
  unsupported_input: 'This AI service or model cannot read this kind of file.',
  too_large: 'This is too much to send to the AI service at once.',
  refusal: 'The AI service would not do this.',
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

const hasParts = (message) => message.role === 'user' && Array.isArray(message.parts) && message.parts.length > 0;
const dataUrl = (part) => `data:${part.mime};base64,${part.data}`;
const fileName = (part) => String(part.name ?? '').replace(/[\x00-\x1f\x7f"\\]+/g, ' ').trim().slice(0, 100) || 'document.pdf';
// Files first, the text last: Anthropic advises it, and it does no harm elsewhere.
const AUDIO_FORMAT = { 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };
// Gemini's lists (11 Nov 2026): no GIF among the pictures; recordings as audio/m4a, not audio/mp4.
const GEMINI_IMAGES = ['image/jpeg', 'image/png', 'image/webp'];
const GEMINI_AUDIO = { 'audio/mp4': 'audio/m4a', 'audio/x-m4a': 'audio/m4a', 'audio/x-wav': 'audio/wav' };

function anthropicPart(part) {
  if (part.kind === 'image') return { type: 'image', source: { type: 'base64', media_type: part.mime, data: part.data } };
  if (part.kind === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: part.data } };
  throw new AiError('unsupported_input', explain('anthropic', part.kind));
}

function openAiPart(part) {
  if (part.kind === 'image') return { type: 'image_url', image_url: { url: dataUrl(part) } };
  if (part.kind === 'pdf') return { type: 'file', file: { filename: fileName(part), file_data: dataUrl(part) } };
  return { type: 'input_audio', input_audio: { data: part.data, format: AUDIO_FORMAT[part.mime] } };
}

function geminiPart(part) {
  if (part.kind === 'image' && !GEMINI_IMAGES.includes(part.mime)) throw new AiError('unsupported_input', 'Gemini cannot read GIF pictures. Use a JPEG, PNG or WebP picture.');
  return { inlineData: { mimeType: GEMINI_AUDIO[part.mime] ?? part.mime, data: part.data } };
}

function anthropicMessages(messages) {
  return messages.map((message) => {
    if (hasParts(message)) return { role: 'user', content: [...message.parts.map(anthropicPart), { type: 'text', text: message.text }] };
    if (message.role === 'user') return { role: 'user', content: message.text };
    if (message.role === 'tool') return { role: 'user', content: message.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })) };
    return { role: 'assistant', content: message.raw ?? [...(message.text ? [{ type: 'text', text: message.text }] : []), ...(message.toolCalls ?? []).map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} }))] };
  });
}

function openAiMessages(system, messages) {
  return [{ role: 'system', content: system }, ...messages.flatMap((message) => {
    if (hasParts(message)) return [{ role: 'user', content: [...message.parts.map(openAiPart), { type: 'text', text: message.text }] }];
    if (message.role === 'user') return [{ role: 'user', content: message.text }];
    if (message.role === 'tool') return message.results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.content }));
    if (message.raw) return [{ role: 'assistant', ...message.raw }];
    const calls = (message.toolCalls ?? []).map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }));
    return [{ role: 'assistant', content: message.text || null, ...(calls.length ? { tool_calls: calls } : {}) }];
  })];
}

function geminiContents(messages) {
  return messages.map((message) => {
    if (hasParts(message)) return { role: 'user', parts: [...message.parts.map(geminiPart), { text: message.text }] };
    if (message.role === 'user') return { role: 'user', parts: [{ text: message.text }] };
    if (message.role === 'tool') return { role: 'user', parts: message.results.map((r) => ({ functionResponse: { ...(isGeminiOwnId(r.id) ? { id: r.id } : {}), name: r.name, response: r.isError ? { error: r.content } : { content: r.content } } })) };
    return { role: 'model', parts: message.raw ?? [...(message.text ? [{ text: message.text }] : []), ...(message.toolCalls ?? []).map((c) => ({ functionCall: { ...(isGeminiOwnId(c.id) ? { id: c.id } : {}), name: c.name, args: c.input ?? {} } }))] };
  });
}

/** The HTTP request for one round: { url, method, headers, body }. Throws AiError when AI cannot run. */
export function buildRequest(config, { system, messages, tools = [] }) {
  const target = resolve(config);
  const { spec, base, model } = target;
  const parts = messages.filter(hasParts).flatMap((message) => message.parts);
  checkFiles(target, config, parts, 'ask');
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
    // Without file input of its own, OpenRouter turns a PDF into text; its default for that is the paid OCR
    // (mistral-ocr, read 11 Nov 2026). JotDrop asks for the free conversion; a model that reads files gets the PDF.
    if (target.id === 'openrouter' && parts.some((part) => part.kind === 'pdf') && !(config.inputs ?? []).includes('file')) body.plugins = [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }];
  }
  return { url, method: 'POST', headers, body: JSON.stringify(body) };
}

const capsFor = (target, config) => capabilities(target.id, { id: target.model, inputs: config.inputs });

// What cannot go stops here, before anything goes out: a kind the service cannot read, then the limits.
function checkFiles(target, config, parts, use) {
  if (!parts.length) return;
  const caps = capsFor(target, config);
  const field = (kind) => kind === 'audio' && use === 'transcribe' ? 'transcribe' : kind;
  for (const part of parts) if (caps[field(part?.kind)] === false) throw new AiError('unsupported_input', explain(target.id, part.kind, use));
  checkParts(parts, use === 'transcribe' ? { audio: caps.transcribe } : caps);
}

// Writing out a recording (version 2). OpenAI has its own address and model for it; the old whisper-1 and
// gpt-4o-transcribe stop on 26 Feb 2027 (read 11 Nov 2026). Gemini and OpenRouter get the recording with this
// instruction and no tools.
export const TRANSCRIBE_MODEL = 'gpt-transcribe';
export const TRANSCRIBE_PROMPT = 'Write out this recording word for word, in the language that is spoken. Return only the text.';
const OPENAI_AUDIO = { 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };

function freshBoundary() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `jotdrop-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// multipart/form-data as bytes, made here so that every fetcher (browser, Obsidian, Joplin, Android) sends the same.
function multipart(boundary, fields, file) {
  const encoder = new TextEncoder();
  const head = encoder.encode(fields.map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join('')
    + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`);
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + file.bytes.length + tail.length);
  body.set(head, 0);
  body.set(file.bytes, head.length);
  body.set(tail, head.length + file.bytes.length);
  return body;
}

/**
 * The HTTP request that writes out a recording: { url, method, headers, body }; body is bytes for OpenAI.
 * language: the app's language as a hint ("nl" or "nl-NL"); left out when it is not a two-letter code.
 */
export function transcribeRequest(config, { audio, language, boundary } = {}) {
  const target = resolve(config);
  const { spec, base, model, id } = target;
  if (audio?.kind !== 'audio') throw new AiError('unsupported_input', 'Only a recording can be written out.');
  checkFiles(target, config, [audio], 'transcribe');
  if (id === 'openai') {
    const ext = OPENAI_AUDIO[audio.mime];
    if (!ext) throw new AiError('unsupported_input', `OpenAI cannot write out ${AUDIO_FORMAT[audio.mime] ?? 'these'} recordings. Gemini can.`);
    const code = /^([a-z]{2})(?:[-_]|$)/i.exec(String(language ?? '').trim())?.[1]?.toLowerCase();
    const mark = boundary ?? freshBoundary();
    const fields = [['model', TRANSCRIBE_MODEL], ...(code ? [['languages[]', code]] : [])];
    const body = multipart(mark, fields, { filename: `recording.${ext}`, mime: audio.mime, bytes: base64Bytes(audio.data) });
    return { url: `${base}/audio/transcriptions`, method: 'POST', headers: { ...headersFor(target, false), 'Content-Type': `multipart/form-data; boundary=${mark}` }, body };
  }
  if (spec.form === 'gemini') {
    const body = { contents: [{ role: 'user', parts: [geminiPart(audio), { text: TRANSCRIBE_PROMPT }] }] };
    return { url: `${base}/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`, method: 'POST', headers: headersFor(target, true), body: JSON.stringify(body) };
  }
  if (id === 'openrouter') {
    const body = { model, messages: [{ role: 'user', content: [openAiPart(audio), { type: 'text', text: TRANSCRIBE_PROMPT }] }] };
    return { url: `${base}/chat/completions`, method: 'POST', headers: headersFor(target, true), body: JSON.stringify(body) };
  }
  throw new AiError('unsupported_input', explain(id, 'audio', 'transcribe'));
}

/** A transcription answer as { text, usage: { input, output, seconds? } }. */
export function parseTranscription(provider, json) {
  if (provider === 'openai') {
    if (typeof json?.text !== 'string') throw new AiError('bad_response');
    const usage = json.usage ?? {};
    return { text: json.text.trim(), usage: usage.type === 'duration' ? { input: 0, output: 0, seconds: Number(usage.seconds) || 0 } : { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 } };
  }
  const answer = parseResponse(provider, json);
  if (answer.stop === 'refusal') throw new AiError('refusal');
  return { text: answer.text.trim(), usage: answer.usage };
}

/** The request for the provider's model list. */
export function modelsRequest(config) {
  const target = resolve(config, false);
  const { spec, base } = target;
  const path = spec.form === 'anthropic' ? '/v1/models?limit=1000' : spec.form === 'gemini' ? '/models?pageSize=1000' : '/models';
  return { url: `${base}${path}`, method: 'GET', headers: headersFor(target, false) };
}

/**
 * The request that checks the key on its own, or null when the model list already does. OpenRouter lists its models
 * to anyone, a wrong key included, so there "Test and load models" said "Connected" for nothing (12 Nov 2026):
 * GET /key is the address that answers 401 to a wrong key.
 */
export function keyRequest(config) {
  const target = resolve(config, false);
  if (target.id !== 'openrouter') return null;
  return { url: `${target.base}/key`, method: 'GET', headers: headersFor(target, false) };
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

/** The provider's model list as [{ id, name, tools }]; tools is null when the list does not say. OpenRouter adds inputs (text, image, file, audio, video). */
export function parseModels(provider, json) {
  const form = PROVIDERS[provider]?.form;
  if (form === 'anthropic') return (json?.data ?? []).map((m) => ({ id: m.id, name: m.display_name || m.id, tools: true }));
  if (form === 'gemini') return (json?.models ?? []).filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent')).map((m) => { const id = String(m.name).replace(/^models\//, ''); return { id, name: m.displayName || id, tools: true }; });
  if (provider === 'openrouter') return (json?.data ?? []).map((m) => ({ id: m.id, name: m.name || m.id, tools: (m.supported_parameters ?? []).includes('tools'), price: Number(m.pricing?.prompt ?? 0) + Number(m.pricing?.completion ?? 0), ...(Array.isArray(m.architecture?.input_modalities) ? { inputs: m.architecture.input_modalities } : {}) }));
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
  const caps = capsFor(target, config);
  return {
    id: target.id,
    model: target.model,
    capabilities: caps,
    async complete({ system, messages, tools = [], signal }) {
      const request = buildRequest(config, { system, messages, tools });
      try {
        return parseResponse(target.id, await send(request, signal));
      } catch (error) {
        // A service that may or may not read a kind of file (Ollama, an own address, an OpenRouter model not in the
        // list) says no with a plain 400, or with a 404 that names the input: tell the user what it is.
        const unknown = messages.filter(hasParts).flatMap((m) => m.parts).some((part) => caps[part.kind] === 'unknown');
        if (unknown && error instanceof AiError && (error.code === 'bad_request' || (error.code === 'model' && /support|image|audio|file|pdf|vision|modalit|input/i.test(error.detail)))) throw new AiError('unsupported_input', error.detail, error.status);
        throw error;
      }
    },
    async transcribe({ audio, language, signal } = {}) {
      return parseTranscription(target.id, await send(transcribeRequest(config, { audio, language }), signal));
    },
    async listModels({ signal } = {}) {
      const check = keyRequest(config);
      if (check) await send(check, signal);
      return parseModels(target.id, await send(modelsRequest(config), signal));
    },
  };
}

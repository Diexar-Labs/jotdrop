import { AiError } from './providers.mjs';

// Files that go along with a request to the user's own AI service (Ask JotDrop version 2): a photo, a PDF or a
// recording, only when the user points at it. A part is { kind: 'image' | 'pdf' | 'audio', mime, name, data }, data
// being base64 without line breaks. The app makes photos small first (long side at most 2048 pixels, JPEG); this file
// says what each service can read and checks the limits before anything goes out. Never cut a file short: too large
// is a message beforehand.
//
// Read on 11 Nov 2026: Anthropic reads photos and PDFs, no sound. OpenAI reads photos and PDFs in chat and writes out
// recordings on its own address (/audio/transcriptions, gpt-transcribe; m4a, webm, mp3, wav, no ogg). Gemini reads
// all three inline (20 MB per request in all). OpenRouter per model (architecture.input_modalities in its model
// list); PDFs it turns into text itself for models without file input. Ollama and an own address: maybe photos.

export const KINDS = ['image', 'pdf', 'audio'];

const MIB = 1024 * 1024;
export const LIMITS = { files: 4, image: 4 * MIB, pdf: 12 * MIB, audio: 14 * MIB, total: 14 * MIB };

// The types JotDrop sends. HEIC and the like the app turns into JPEG first.
export const MIMES = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  pdf: ['application/pdf'],
  audio: ['audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/x-wav'],
};

const NONE = { image: false, pdf: false, audio: false, transcribe: false };

/**
 * What a service and model can read: { image, pdf, audio, transcribe }, each true, false or 'unknown' (then the app
 * tries and a refusal becomes unsupported_input). audio: a recording along with a question; transcribe: writing a
 * recording out as text. model is an id, or { id, inputs } from the model list (OpenRouter gives inputs).
 */
export function capabilities(provider, model) {
  if (provider === 'anthropic') return { image: true, pdf: true, audio: false, transcribe: false };
  if (provider === 'openai') return { image: true, pdf: true, audio: false, transcribe: true };
  if (provider === 'gemini') return { image: true, pdf: true, audio: true, transcribe: true };
  if (provider === 'openrouter') {
    const inputs = Array.isArray(model?.inputs) ? model.inputs : null;
    const has = (name) => inputs ? inputs.includes(name) : 'unknown';
    return { image: has('image'), pdf: true, audio: has('audio'), transcribe: has('audio') };
  }
  if (provider === 'ollama' || provider === 'custom') return { image: 'unknown', pdf: false, audio: false, transcribe: false };
  return { ...NONE };
}

const WHO = { anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini', openrouter: 'This OpenRouter model', ollama: 'This local model', custom: 'This address' };
const OTHERS = [['gemini', 'Gemini'], ['openai', 'OpenAI'], ['anthropic', 'Claude'], ['openrouter', 'OpenRouter']];
const VERB = { image: 'read photos', pdf: 'read PDFs', audio: 'listen to recordings' };

/** The sentence for a file a service cannot read, with the services that can: "Claude cannot listen to recordings. Gemini and OpenAI can." */
export function explain(provider, kind, use = 'ask') {
  const field = kind === 'audio' && use === 'transcribe' ? 'transcribe' : kind;
  const can = OTHERS.filter(([id]) => id !== provider && capabilities(id)[field] === true).map(([, name]) => name);
  const list = can.length > 1 ? `${can.slice(0, -1).join(', ')} and ${can.at(-1)}` : can[0];
  return `${WHO[provider] ?? 'This AI service'} cannot ${VERB[kind] ?? 'read this file'}.${list ? ` ${list} can.` : ''}`;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const mib = (bytes) => `${Math.round(bytes / MIB)} MiB`;
const label = (part) => String(part?.name ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 80) || 'The file';

/** The number of bytes base64 stands for. */
export function decodedLength(data) {
  const text = String(data ?? '');
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

/**
 * Checks the files against the limits and against what the service can read (caps from capabilities). Throws
 * AiError too_large, unsupported_input or bad_request (the app's own mistake); gives { bytes } when all can go.
 */
export function checkParts(parts, caps = {}) {
  if (!parts?.length) return { bytes: 0 };
  if (parts.length > LIMITS.files) throw new AiError('too_large', `At most ${LIMITS.files} files go along at once.`);
  let total = 0;
  for (const part of parts) {
    const name = label(part);
    if (!KINDS.includes(part?.kind)) throw new AiError('unsupported_input', `${name}: JotDrop sends photos, PDFs and recordings only.`);
    if (!MIMES[part.kind].includes(part.mime)) throw new AiError('unsupported_input', `${name}: the type ${String(part.mime).slice(0, 40)} cannot go along as ${part.kind === 'image' ? 'a photo' : part.kind === 'pdf' ? 'a PDF' : 'a recording'}.`);
    const data = part.data;
    if (typeof data !== 'string' || data.length % 4 !== 0 || !BASE64.test(data)) throw new AiError('bad_request', `${name}: the file was not read correctly.`);
    const bytes = decodedLength(data);
    if (bytes <= 0) throw new AiError('bad_request', `${name} is empty.`);
    if (caps[part.kind] === false) throw new AiError('unsupported_input', `${name}: this AI service or model cannot ${VERB[part.kind]}.`);
    if (bytes > LIMITS[part.kind]) throw new AiError('too_large', `${name} is larger than ${mib(LIMITS[part.kind])}.`);
    total += bytes;
  }
  if (total > LIMITS.total) throw new AiError('too_large', `Together the files are larger than ${mib(LIMITS.total)}.`);
  return { bytes: total };
}

/** base64 to bytes, without a library (browser, Obsidian, Joplin and Node all have atob). */
export function base64Bytes(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

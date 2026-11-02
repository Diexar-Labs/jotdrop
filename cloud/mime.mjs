/**
 * The one MIME parser of Mail to JotDrop. It runs only inside the mailin process, on a mail that is
 * in memory anyway, and turns it into the payload of `cloud/shared/mail.mjs` so no client ever parses MIME.
 * Anything it does not recognise falls back to the whole raw mail as `message.eml`: nothing is ever lost.
 */

const MAX_PARTS = 20;
const MAX_TEXT = 512 * 1024;
const MAX_HEADER_TEXT = 10 * 1024;

const decoderFor = (charset) => {
  try { return new TextDecoder(charset || 'utf-8'); }
  catch { return new TextDecoder('latin1'); }
};
const decodeText = (bytes, charset) => {
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  if (!charset || /^(utf-?8|us-ascii|ascii|ansi_x3\.4-1968)$/i.test(charset)) {
    try { return utf8.decode(bytes); } catch { return new TextDecoder('latin1').decode(bytes); }
  }
  return decoderFor(charset).decode(bytes);
};

function decodeQuotedPrintable(text, forWord = false) {
  const source = forWord ? text.replace(/_/g, ' ') : text.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let index = 0; index < source.length; index++) {
    const hex = /^[0-9A-Fa-f]{2}/.exec(source.slice(index + 1, index + 3));
    if (source[index] === '=' && hex) { bytes.push(parseInt(hex[0], 16)); index += 2; }
    else bytes.push(source.charCodeAt(index) & 255);
  }
  return Uint8Array.from(bytes);
}

const decodeBase64 = (text) => Uint8Array.from(Buffer.from(text.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64'));

/** RFC 2047 encoded words in headers: `=?charset?B|Q?...?=`. */
function decodeWords(value) {
  return value.replace(/=\?([^?\s]+)\?([bq])\?([^?\s]*)\?=(\s+(?==\?))?/gi, (_, charset, encoding, encoded) =>
    decodeText(encoding.toLowerCase() === 'b' ? decodeBase64(encoded) : decodeQuotedPrintable(encoded, true), charset.split('*')[0]));
}

function parseHeaders(text) {
  const headers = new Map();
  for (const line of text.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at < 1) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(at + 1).trim());
  }
  return headers;
}

/** `text/plain; charset="utf-8"; name*=utf-8''b%C3%B3n.pdf` with RFC 2231 charsets and segments. */
function parseParams(value = '') {
  const [type, ...rest] = value.split(';');
  const params = {}, extended = {};
  for (const part of rest) {
    const match = /^\s*([^=\s]+)\s*=\s*(.*?)\s*$/.exec(part);
    if (!match) continue;
    const raw = match[2].replace(/^"(.*)"$/s, '$1');
    const star = /^([^*]+)\*(\d+)?(\*)?$/.exec(match[1]);
    if (!star) { params[match[1].toLowerCase()] ??= raw; continue; }
    const name = star[1].toLowerCase();
    (extended[name] ??= { parts: [], encoded: false }).parts[Number(star[2] ?? 0)] = raw;
    if (star[3] || star[2] === undefined) extended[name].encoded = true;
  }
  for (const [name, { parts, encoded }] of Object.entries(extended)) {
    let joined = parts.join('');
    if (encoded) {
      const match = /^([^']*)'[^']*'(.*)$/s.exec(joined);
      const charset = match ? match[1] : 'utf-8';
      const escaped = (match ? match[2] : joined).replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      joined = decodeText(Uint8Array.from([...escaped].map((char) => char.charCodeAt(0) & 255)), charset);
    }
    params[name] = joined;
  }
  return { type: (type ?? '').trim().toLowerCase(), params };
}

function decodeBody(bytes, encoding) {
  const text = () => new TextDecoder('latin1').decode(bytes);
  if (/base64/i.test(encoding)) return decodeBase64(text());
  if (/quoted-printable/i.test(encoding)) return decodeQuotedPrintable(text());
  return bytes;
}

/** Just enough HTML to read a mail that has no plain-text part. Never rendered: notes are plain text. */
export function htmlToText(html) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', mdash: ' - ', ndash: '-', hellip: '...', copy: '(c)' };
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|table)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (_, name) => entities[name.toLowerCase()] ?? ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitMessage(bytes) {
  const text = new TextDecoder('latin1').decode(bytes);
  const at = /\r?\n\r?\n/.exec(text);
  const headerText = at ? text.slice(0, at.index) : text;
  return { headers: parseHeaders(headerText), headerText, body: at ? bytes.subarray(at.index + at[0].length) : new Uint8Array(0) };
}

function splitMultipart(body, boundary) {
  // latin1 maps bytes to characters one to one, so these indexes are byte offsets.
  const text = new TextDecoder('latin1').decode(body);
  const pattern = new RegExp(`(?:^|\\r?\\n)--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(--)?[^\\r\\n]*(?:\\r?\\n|$)`, 'g');
  const parts = [];
  let previous = null, match;
  while ((match = pattern.exec(text))) {
    if (previous !== null) parts.push(body.subarray(previous, match.index));
    if (match[1]) return parts;
    previous = pattern.lastIndex;
  }
  return parts;
}

function walk(bytes, out, depth) {
  if (depth > 6 || out.attachments.length > MAX_PARTS) throw new Error('Mail structure too deep.');
  const { headers, body } = splitMessage(bytes);
  const { type, params } = parseParams(headers.get('content-type') ?? 'text/plain');
  const disposition = parseParams(headers.get('content-disposition') ?? '');
  const filename = disposition.params.filename ?? params.name;
  if (type.startsWith('multipart/')) {
    if (!params.boundary) throw new Error('Multipart without boundary.');
    const parts = splitMultipart(body, params.boundary);
    if (type === 'multipart/alternative') {
      // The alternatives say the same thing: take the most readable one, prefer plain text.
      let best = null;
      for (const part of parts) {
        const { headers: partHeaders } = splitMessage(part);
        const partType = parseParams(partHeaders.get('content-type') ?? 'text/plain').type;
        if (partType === 'text/plain' || partType.startsWith('multipart/')) { best = part; break; }
        if (!best && partType === 'text/html') best = part;
      }
      if (best) walk(best, out, depth + 1);
      return;
    }
    for (const part of parts) walk(part, out, depth + 1);
    return;
  }
  const content = decodeBody(body, headers.get('content-transfer-encoding') ?? '7bit');
  const attach = (name, attachmentType) => {
    if (out.attachments.length >= MAX_PARTS) throw new Error('Too many attachments.');
    out.attachments.push({ name, type: attachmentType, size: content.length });
    out.parts.push(content);
  };
  if (type === 'message/rfc822') return attach(filename ?? 'forwarded.eml', type);
  if ((type === 'text/plain' || type === 'text/html') && disposition.type !== 'attachment') {
    const text = decodeText(content, params.charset);
    if (type === 'text/html') { if (!out.sawText) out.html.push(text); }
    else { out.sawText = true; out.text.push(text); }
    return;
  }
  attach(filename ?? `attachment-${out.attachments.length + 1}`, type || 'application/octet-stream');
}

/**
 * One mail, as raw bytes, to the sealed payload's shape: `{ payload, parts }`, where `parts[i]` holds the
 * bytes of `payload.attachments[i]`. On anything unexpected: the `message.eml` fallback, headers as text.
 */
export function parseMail(bytes) {
  const { headers, headerText } = splitMessage(bytes);
  const header = (name) => { const value = headers.get(name); return value === undefined ? undefined : decodeWords(value); };
  const envelope = { v: 1, from: header('from') ?? '', to: header('to') ?? '', subject: header('subject') ?? '', date: header('date') ?? '' };
  try {
    const out = { text: [], html: [], attachments: [], parts: [], sawText: false };
    walk(bytes, out, 0);
    const text = (out.sawText ? out.text.join('\n\n') : out.html.map(htmlToText).join('\n\n')).replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT);
    return { payload: { ...envelope, text, attachments: out.attachments }, parts: out.parts, fallback: false };
  } catch {
    return {
      payload: { ...envelope, text: headerText.slice(0, MAX_HEADER_TEXT), attachments: [{ name: 'message.eml', type: 'message/rfc822', size: bytes.length }] },
      parts: [Uint8Array.from(bytes)],
      fallback: true,
    };
  }
}

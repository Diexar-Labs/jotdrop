// A note changed on two devices merges when the changes do not overlap, the same rules as Android's CloudNoteMerge.
// The note splits into frontmatter fields and the text below them. Against the version both devices last shared
// (`base`), a field or the text that only one side changed takes that side; the same value on both sides is one
// change, however each device writes it (`[a, b]` or a block list, quotes, 10 or 10.0). Anything else, and any
// frontmatter this simple reading does not understand, gives null: then the sync keeps both versions as before.

const utf8 = (bytes) => {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
};

const number = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/** One scalar as JotDrop reads it: quotes off, and numbers by value. Null when it needs real YAML. */
function scalar(raw) {
  const value = raw.trim();
  if (/^["'].*["']$/s.test(value) && value.length >= 2) {
    const inner = value.slice(1, -1);
    return value[0] !== value.at(-1) || /["'\\]/.test(inner) ? null : `s:${inner}`;
  }
  if (/^[[\]{}|>&*!%@`"'#]/.test(value) || value.includes(' #') || value.includes(': ')) return null;
  return number.test(value) ? `n:${Number(value)}` : `s:${value}`;
}

/** `{ fields: Map(key -> { lines, value }), body }`, or null when the frontmatter is more than flat keys and lists. */
export function splitNote(text) {
  if (text.includes('\r')) return null;
  const lines = text.split('\n');
  if (lines[0] !== '---') return { fields: new Map(), body: text };
  const end = lines.indexOf('---', 1);
  if (end < 0 || end === lines.length - 1) return null;
  const fields = new Map();
  for (let i = 1; i < end;) {
    const line = lines[i], colon = line.indexOf(':');
    const key = colon > 0 ? line.slice(0, colon) : '';
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(key) || fields.has(key)) return null;
    const rest = line.slice(colon + 1);
    if (rest && !rest.startsWith(' ')) return null;
    const own = [line];
    let value;
    if (!rest.trim()) {
      const items = [];
      for (i++; i < end && /^\s*- /.test(lines[i]); i++) { own.push(lines[i]); items.push(scalar(lines[i].replace(/^\s*- /, ''))); }
      if (i < end && /^\s/.test(lines[i])) return null;
      value = items.length ? items : 's:';
    } else {
      i++;
      const flow = rest.trim();
      if (flow.startsWith('[') && flow.endsWith(']')) {
        const inner = flow.slice(1, -1);
        value = inner.trim() ? inner.split(',').map(scalar) : [];
      } else value = scalar(rest);
    }
    if (value === null || (Array.isArray(value) && value.includes(null))) return null;
    fields.set(key, { lines: own, value: Array.isArray(value) ? `l:${JSON.stringify(value)}` : value });
  }
  return { fields, body: lines.slice(end + 1).join('\n') };
}

/** The merged note's bytes, or null when the two versions really disagree. */
export function mergeNote(base, local, cloud) {
  const texts = [local, cloud].map(utf8);
  if (texts.includes(null)) return null;
  const [mine, theirs] = texts.map(splitNote);
  if (!mine || !theirs) return null;
  const shared = base && utf8(base) !== null ? splitNote(utf8(base)) : null;
  const pick = (own, other, old) => {
    if (own === other) return 'cloud';
    if (shared && own === old) return 'cloud';
    if (shared && other === old) return 'local';
    return null;
  };
  const body = pick(mine.body, theirs.body, shared?.body);
  if (!body) return null;
  const lines = [];
  for (const key of new Set([...theirs.fields.keys(), ...mine.fields.keys()])) {
    const own = mine.fields.get(key), other = theirs.fields.get(key);
    const side = pick(own?.value, other?.value, shared?.fields.get(key)?.value);
    if (!side) return null;
    const chosen = side === 'cloud' ? other : own;
    if (chosen) lines.push(...chosen.lines);
  }
  const text = (lines.length ? `---\n${lines.join('\n')}\n---\n` : '') + (body === 'cloud' ? theirs.body : mine.body);
  return new TextEncoder().encode(text);
}

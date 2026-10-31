// A note changed on two devices merges when the changes do not overlap, the same rules as Android's CloudNoteMerge.
// The note splits into frontmatter fields and the text below them. Against the version both devices last shared
// (`base`), a field that only one side changed takes that side; the same value on both sides is one change, however
// each device writes it (`[a, b]` or a block list, quotes, 10 or 10.0). The text merges per line the same way. Two
// additions at one place both stay, the cloud's first. Anything else (one line changed two ways, a line changed and
// removed), a missing `base` and any frontmatter this simple reading does not understand give null: then the sync
// keeps both versions as before.

const utf8 = (bytes) => {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
};

// A changed stretch of text bigger than this (base lines times changed lines) is not compared: both versions stay.
const MERGE_CELLS = 1000000;

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

/** What one side changed, in order: `[start, end, lines]` puts `lines` in place of those base lines. Null when too much changed. */
function changes(base, side) {
  let start = 0, baseEnd = base.length, sideEnd = side.length;
  while (start < baseEnd && start < sideEnd && base[start] === side[start]) start++;
  while (baseEnd > start && sideEnd > start && base[baseEnd - 1] === side[sideEnd - 1]) { baseEnd--; sideEnd--; }
  const rows = baseEnd - start, columns = sideEnd - start, width = columns + 1;
  if ((rows + 1) * width > MERGE_CELLS) return null;
  // Lines in common from base line r and side line c onward. On a tie a base line counts as removed first.
  const common = new Int32Array((rows + 1) * width);
  for (let r = rows - 1; r >= 0; r--) for (let c = columns - 1; c >= 0; c--) {
    common[r * width + c] = base[start + r] === side[start + c] ? common[(r + 1) * width + c + 1] + 1 : Math.max(common[(r + 1) * width + c], common[r * width + c + 1]);
  }
  const found = [];
  for (let r = 0, c = 0, fromRow = 0, fromColumn = 0; ;) {
    const same = r < rows && c < columns && base[start + r] === side[start + c];
    if (same || (r === rows && c === columns)) {
      // As many lines in as out: each line changed by itself, so two devices ticking neighbours do not collide.
      if (r - fromRow === c - fromColumn) for (let i = 0; i < r - fromRow; i++) found.push([start + fromRow + i, start + fromRow + i + 1, [side[start + fromColumn + i]]]);
      else found.push([start + fromRow, start + r, side.slice(start + fromColumn, start + c)]);
      if (!same) return found;
      fromRow = ++r;
      fromColumn = ++c;
    } else if (c === columns || (r < rows && common[(r + 1) * width + c] >= common[r * width + c + 1])) r++;
    else c++;
  }
}

/** The text with both sides' changes, or null when they touch the same lines differently. */
function mergeLines(old, mine, theirs) {
  const base = old.split('\n');
  const own = changes(base, mine.split('\n')), other = changes(base, theirs.split('\n'));
  if (!own || !other) return null;
  const lines = [];
  let at = 0, last = null;
  for (const change of [...other, ...own].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const [start, end, added] = change;
    if (last && start === last[0] && end === last[1] && added.length === last[2].length && added.every((line, i) => line === last[2][i])) continue;
    if (start < at) return null;
    for (let i = at; i < start; i++) lines.push(base[i]);
    for (const line of added) lines.push(line);
    at = end;
    last = change;
  }
  for (let i = at; i < base.length; i++) lines.push(base[i]);
  return lines.join('\n');
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
  const side = pick(mine.body, theirs.body, shared?.body);
  const body = side ? (side === 'cloud' ? theirs.body : mine.body) : shared ? mergeLines(shared.body, mine.body, theirs.body) : null;
  if (body === null) return null;
  const lines = [];
  for (const key of new Set([...theirs.fields.keys(), ...mine.fields.keys()])) {
    const own = mine.fields.get(key), other = theirs.fields.get(key);
    const from = pick(own?.value, other?.value, shared?.fields.get(key)?.value);
    if (!from) return null;
    const chosen = from === 'cloud' ? other : own;
    if (chosen) lines.push(...chosen.lines);
  }
  const text = (lines.length ? `---\n${lines.join('\n')}\n---\n` : '') + body;
  return new TextEncoder().encode(text);
}

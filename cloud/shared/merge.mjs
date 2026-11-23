// A note changed on two devices merges when the changes do not overlap, the same rules as Android's CloudNoteMerge.
// The note splits into frontmatter fields and the text below them. Against the version both devices last shared
// (`base`), a field that only one side changed takes that side; the same value on both sides is one change, however
// each device writes it (`[a, b]` or a block list, quotes, 10 or 10.0). The text merges per line the same way. Two
// additions at one place both stay, the cloud's first. A line that moved is followed: a change the other device made
// to it travels along, a line both devices moved stays once, where the cloud has it, and a line both devices changed
// the same way stays once too when one of them moved it as well. Anything else (one line changed two ways, a line
// changed and removed), a missing `base` and any frontmatter this simple reading does not understand give null: then
// the sync keeps both versions as before.

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

/** Only spaces and tabs (and a Windows line end): such a line says nothing and is never followed as it moves. */
const blank = (line) => /^[ \t\r]*$/.test(line);

/** How often each line is there. */
const tally = (lines) => { const counts = new Map(); for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1); return counts; };

/**
 * To the merge per line a moved line is gone in one place and new in another: a tick on the other device collides with
 * it, and two devices that move the same line leave it twice. This tells a move apart and gives the three texts back
 * the way the merge per line reads them right (`texts`), with the lines both sides moved (`both`) and a check that
 * what comes of them is whole (`whole`). Null when no line moved like that.
 * A line moved on one side and changed where it stood on the other (that line alone, into a text the note did not have
 * and that side has once): the change travels along to the new place. A line both sides moved: once, where the cloud
 * has it. Moved is a line that says something and stands once in the note, before and after.
 * A line both sides made into the same text, one where it stood and the other at another place (two devices tick a
 * task, one of them with "Move checked items to the bottom"): that text is what the two share, so one side moved it.
 */
function followMoves(base, local, cloud, own, other) {
  const adds = (found) => { const added = new Set(); for (const change of found) for (const line of change[2]) added.add(line); return added; };
  const ownPut = adds(own), otherPut = adds(other);
  // The base lines a side took out while it has the same line somewhere else.
  const taken = (found, added) => {
    const lines = [];
    for (const [start, end] of found) for (let i = start; i < end; i++) if (added.has(base[i]) && !blank(base[i])) lines.push(i);
    return lines;
  };
  const mine = taken(own, ownPut), theirs = taken(other, otherPut);
  // The base lines a side changed one line for one line: base line number -> the new text.
  const single = (found) => new Map(found.filter(([start, end, lines]) => end === start + 1 && lines.length === 1).map(([start, , lines]) => [start, lines[0]]));
  const ownSingle = single(own), otherSingle = single(other);
  // A line one side changed where it stood into a text the other side put in, without changing that line one for one itself.
  const elsewhere = (changed, single, added) => { for (const [i, line] of changed) if (added.has(line) && !single.has(i)) return true; return false; };
  if (!mine.length && !theirs.length && !elsewhere(ownSingle, otherSingle, otherPut) && !elsewhere(otherSingle, ownSingle, ownPut)) return null;
  const before = tally(base), here = tally(local), there = tally(cloud);
  const moved = (lines, after) => new Set(lines.filter((i) => before.get(base[i]) === 1 && after.get(base[i]) === 1));
  const movedHere = moved(mine, here), movedThere = moved(theirs, there);
  // What a side made of a base line it changed alone: base line number -> the new text.
  const alone = (changed, after) => new Map([...changed].filter(([, line]) => !blank(line) && !before.has(line) && after.get(line) === 1));
  const ownAlone = alone(ownSingle, here), otherAlone = alone(otherSingle, there);
  // Per text what a line becomes there: nothing (the line goes) or its changed text. A moved line stands once, so its text names it.
  const inBase = new Map(), inLocal = new Map(), inCloud = new Map(), both = new Set();
  for (const i of movedHere) {
    if (movedThere.has(i)) { both.add(base[i]); inBase.set(base[i], []); inLocal.set(base[i], []); }
    else if (otherAlone.has(i)) { inBase.set(base[i], [otherAlone.get(i)]); inLocal.set(base[i], [otherAlone.get(i)]); }
  }
  for (const i of movedThere) if (!movedHere.has(i) && ownAlone.has(i)) { inBase.set(base[i], [ownAlone.get(i)]); inCloud.set(base[i], [ownAlone.get(i)]); }
  // The same change on both sides. `changed` is what one side made of its lines where they stood; the other side
  // (`single` and `after`) did not change that line one for one, has it no more, and has the new text once.
  const same = [];
  const agreed = (changed, single, after) => {
    for (const [i, line] of changed) if (!single.has(i) && !blank(base[i]) && before.get(base[i]) === 1 && !after.has(base[i]) && after.get(line) === 1) same.push([base[i], line]);
  };
  agreed(otherAlone, ownSingle, here);
  agreed(ownAlone, otherSingle, there);
  // Each side has that text once, so one line at most became it: named for two lines, it is followed for neither.
  const named = tally([...[...inBase.values()].flat(), ...same.map(([, text]) => text)]);
  // The lines that can only be there once: a text both sides made of a line, and what both have once of the note.
  const once = new Set();
  for (const [line, text] of same) if (named.get(text) === 1) { inBase.set(line, [text]); once.add(text); }
  if (!inBase.size) return null;
  for (const [line, count] of before) if (count === 1 && !blank(line) && here.get(line) === 1 && there.get(line) === 1) once.add(line);
  // Following compares the texts again, and that can read a line differently. So what comes of it must be whole: every
  // line a side put in, and once each line that can only be there once. Else both versions stay.
  const whole = (lines) => {
    const counts = tally(lines);
    for (const line of once) if (counts.get(line) !== 1) return false;
    for (const side of [here, there]) for (const [line, count] of side) if ((counts.get(line) ?? 0) < count - (before.get(line) ?? 0)) return false;
    return true;
  };
  const put = (lines, swaps) => swaps.size ? lines.flatMap((line) => swaps.get(line) ?? [line]) : lines;
  return { texts: [put(base, inBase), put(local, inLocal), put(cloud, inCloud)], both, whole };
}

/** The base lines with both sides' changes, or null when they touch the same lines differently. */
function combine(base, own, other) {
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
  return lines;
}

/** The text with both sides' changes, or null when they touch the same lines differently. */
function mergeLines(old, mine, theirs) {
  const base = old.split('\n'), local = mine.split('\n'), cloud = theirs.split('\n');
  const own = changes(base, local), other = changes(base, cloud);
  if (!own || !other) return null;
  let lines = combine(base, own, other);
  const moves = followMoves(base, local, cloud, own, other);
  // Per line it collides on a move, or a line both sides moved is in twice: then the moves are followed. A line that
  // stood once never comes out twice; when following cannot be done either, or leaves the note less than whole, both
  // versions stay.
  if (moves && (!lines || lines.filter((line) => moves.both.has(line)).length > moves.both.size)) {
    const [from, near, far] = moves.texts, nearChanges = changes(from, near), farChanges = changes(from, far);
    lines = nearChanges && farChanges ? combine(from, nearChanges, farChanges) : null;
    if (lines && !moves.whole(lines)) lines = null;
  }
  return lines && lines.join('\n');
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

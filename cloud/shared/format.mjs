// The formatting core: pure text functions shared by the web app, Obsidian, Joplin and (as FormatCore.kt) Android.
// The Markdown text is and stays the source. Nothing here rewrites a note; callers only read from it, or later
// apply one small replacement. Positions are UTF-16 indexes, the same in JavaScript and Kotlin. Lines are split
// on `\n`; a `\r` at the end belongs to its line. The cases in format-vectors.json hold every app to these rules.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// GFM: a table starts at most 3 spaces in; a line in a quote or list item is no table.
const INDENT_OK = /^ {0,3}(?![ \t])/;
const QUOTE_OR_LIST = /^ {0,3}(?:>|[-*+][ \t]|\d{1,9}[.)][ \t])/;
const DELIMITER_CELL = /^:?-+:?$/;

/** The positions of the `|` signs in a line that no `\` escapes. */
function pipes(line) {
  /** @type {number[]} */
  const at = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === '|') at.push(i);
  }
  return at;
}

const withoutCr = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line);

/**
 * The cells of one table line, as source: one `|` at the start and one at the end go, then it splits on every unescaped `|`.
 * @param {string} line
 */
export function tableCells(line) {
  let text = withoutCr(line).trim();
  let at = pipes(text);
  if (text.startsWith('|')) { text = text.slice(1); at = at.slice(1).map((i) => i - 1); }
  if (at.length && at[at.length - 1] === text.length - 1) { text = text.slice(0, -1); at = at.slice(0, -1); }
  /** @type {string[]} */
  const cells = [];
  let from = 0;
  for (const i of at) { cells.push(text.slice(from, i)); from = i + 1; }
  cells.push(text.slice(from));
  return cells;
}

function delimiterAligns(line) {
  if (!INDENT_OK.test(line) || !pipes(withoutCr(line)).length) return null;
  const cells = tableCells(line).map((cell) => cell.trim());
  if (!cells.every((cell) => DELIMITER_CELL.test(cell))) return null;
  return cells.map((cell) => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : ''));
}

function isHeader(line) {
  return INDENT_OK.test(line) && !QUOTE_OR_LIST.test(line) && pipes(withoutCr(line)).length > 0;
}

/**
 * The text in runs of whole lines: `text`, `code` (a fence with its fence lines; an unclosed fence runs to the end)
 * and `table`. Each run: { kind, fromLine, toLine (inclusive), from, to } with `to` at the end of its last line,
 * before the `\n`. The runs follow each other and together cover every line.
 */
export function blocks(text) {
  const lines = String(text).split('\n');
  const starts = [];
  let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  /** @type {{ kind: string, fromLine: number, toLine: number, from: number, to: number }[]} */
  const out = [];
  const add = (kind, fromLine, toLine) => {
    const last = out[out.length - 1];
    if (kind === 'text' && last?.kind === 'text') { last.toLine = toLine; last.to = starts[toLine] + lines[toLine].length; return; }
    out.push({ kind, fromLine, toLine, from: starts[fromLine], to: starts[toLine] + lines[toLine].length });
  };
  for (let i = 0; i < lines.length;) {
    const fence = FENCE.exec(lines[i])?.[1];
    if (fence) {
      let end = i + 1;
      while (end < lines.length) {
        const close = FENCE.exec(lines[end])?.[1];
        if (close && close[0] === fence[0] && close.length >= fence.length && !withoutCr(lines[end]).slice(lines[end].indexOf(close) + close.length).trim()) break;
        end++;
      }
      end = Math.min(end, lines.length - 1);
      add('code', i, end);
      i = end + 1;
      continue;
    }
    const aligns = i + 1 < lines.length && isHeader(lines[i]) ? delimiterAligns(lines[i + 1]) : null;
    if (aligns && aligns.length === tableCells(lines[i]).length) {
      let end = i + 1;
      while (end + 1 < lines.length && withoutCr(lines[end + 1]).trim() && pipes(withoutCr(lines[end + 1])).length && !FENCE.test(lines[end + 1])) end++;
      add('table', i, end);
      i = end + 1;
      continue;
    }
    add('text', i, i);
    i++;
  }
  return out;
}

/**
 * A table's lines (header, delimiter, rows) as { align, header, rows }, each cell as its source without the spaces
 * at its edges. A row with too few cells is filled with empty ones, extra cells are not shown: only for the display,
 * the source does not change.
 * @param {string[]} lines
 * @returns {{ align: string[], header: string[], rows: string[][] }}
 */
export function parseTable(lines) {
  const header = tableCells(lines[0]).map((cell) => cell.trim());
  const align = delimiterAligns(lines[1]) || header.map(() => '');
  const rows = lines.slice(2).map((line) => {
    const cells = tableCells(line).map((cell) => cell.trim());
    return header.map((_, i) => cells[i] ?? '');
  });
  return { align, header, rows };
}

/** What a cell shows: `\|` is `|`, `<br>` is a line break. Other Markdown stays for the caller. */
export function cellText(source) {
  return String(source).replace(/\\\|/g, '|').replace(/<br\s*\/?>/gi, '\n');
}

/** A cell's display text back as source: `|` becomes `\|`, a line break `<br>`, no spaces at the edges. */
export function cellSource(text) {
  return String(text).trim().replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 2: the editor. Every function below reads the text and returns at most one replacement
// { from, to, insert, selFrom, selTo }: from/to/insert in positions of the text it was given, the selection in the
// text after it. Nothing is converted to a document model: a button is one small text change, the rest stays byte
// for byte.

/** One replacement that turns `before` into `after`: the common start and end stay out of it. */
function replacement(before, after, selFrom, selTo) {
  if (before === after) return null;
  let from = 0;
  const max = Math.min(before.length, after.length);
  while (from < max && before.charCodeAt(from) === after.charCodeAt(from)) from++;
  let end = 0;
  while (end < max - from && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
  return { from, to: before.length - end, insert: after.slice(from, after.length - end), selFrom, selTo: selTo ?? selFrom };
}

/** Several small edits ({ from, to, insert }, not overlapping) at once, with a way to follow a position. */
function applyEdits(text, edits) {
  const sorted = edits.filter((edit) => edit.from !== edit.to || edit.insert).sort((a, b) => a.from - b.from || a.to - b.to);
  let out = '', last = 0;
  for (const edit of sorted) { out += text.slice(last, edit.from) + edit.insert; last = edit.to; }
  out += text.slice(last);
  /** Where `pos` lands. At an insertion `after` puts it behind the inserted text; in a removed range it goes to its start. */
  const map = (pos, after = false) => {
    let delta = 0;
    for (const edit of sorted) {
      const insertion = edit.from === edit.to;
      if (pos < edit.from || (insertion && pos === edit.from && !after)) break;
      if (insertion && pos === edit.from) return pos + delta + edit.insert.length;
      if (!insertion && pos <= edit.to) return edit.from + delta + (pos === edit.to && after ? edit.insert.length : 0);
      delta += edit.insert.length - (edit.to - edit.from);
    }
    return pos + delta;
  };
  return { text: out, map };
}

/** The lines of a text with their start positions, and the line a position is on. */
function lineTable(text) {
  const lines = String(text).split('\n'), starts = [];
  let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  const at = (pos) => {
    let lo = 0, hi = lines.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo;
  };
  return { lines, starts, at };
}

const blank = (line) => line === undefined || !line.trim();

// The inline signs, in the same order and with the same rules as stripInlineMarks in cloud/web/note.mjs (the card
// text), plus links, so that the card and the editor always agree on what is bold or italic.
const INLINE = /\\(?<esc>[!-/:-@[-`{-~])|(?<ticks>`+)(?<code>[^`\n]+?)\k<ticks>|(?<embed>!?)\[\[(?<target>[^\]\n|]+)(?:\|(?<alias>[^\]\n]+))?\]\]|(?<image>!?)\[(?<label>[^\]\n]+)\]\((?<href>[^()\s]+)\)|(?<url>https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}])|(?<mark>\*{3}|_{3}|\*\*|__|~~|==)(?=\S)(?<marked>.*?\S)\k<mark>|(?<starLead>^|[^\w*])\*(?=[^\s*])(?<star>[^*\n]*?[^\s*])\*(?!\*)|(?<underLead>^|[^\w_])_(?=[^\s_])(?<under>[^_\n]*?[^\s_])_(?!\w)/g;
const MARK_KIND = { '**': 'bold', __: 'bold', '~~': 'strike', '==': 'highlight' };

function scanInline(text, offset, out) {
  for (const match of text.matchAll(INLINE)) {
    const groups = match.groups, start = offset + match.index, end = start + match[0].length;
    const span = (kind, from, to, openTo, closeFrom, extra) => out.push({ kind, from, to, openTo, closeFrom, ...extra });
    if (groups.esc !== undefined) span('escape', start, end, start + 1, end);
    else if (groups.code !== undefined) span('code', start, end, start + groups.ticks.length, end - groups.ticks.length);
    else if (groups.target !== undefined) {
      // An embed (![[file]]) stays as it is written.
      if (!groups.embed) span('wikilink', start, end, groups.alias === undefined ? start + 2 : start + 3 + groups.target.length, end - 2, { target: groups.target });
    } else if (groups.href !== undefined) {
      // So does an image (![alt](file)).
      if (!groups.image) {
        span('link', start, end, start + 1, start + 1 + groups.label.length, { href: groups.href });
        scanInline(groups.label, start + 1, out);
      }
    } else if (groups.url !== undefined) span('url', start, end, start, end, { href: groups.url });
    else if (groups.mark !== undefined) {
      const sign = groups.mark;
      if (sign.length === 3) {
        span('bold', start, end, start + 2, end - 2);
        span('italic', start + 2, end - 2, start + 3, end - 3);
      } else span(MARK_KIND[sign], start, end, start + 2, end - 2);
      scanInline(groups.marked, start + sign.length, out);
    } else {
      const lead = (groups.starLead ?? groups.underLead).length, inner = groups.star ?? groups.under;
      span('italic', start + lead, end, start + lead + 1, end - 1);
      scanInline(inner, start + lead + 1, out);
    }
  }
}

/**
 * The formatting in one line: { kind, from, to, openTo, closeFrom }, with the opening sign from `from` to `openTo`,
 * the content up to `closeFrom` and the closing sign up to `to`. Kinds: bold, italic, strike, highlight, code, link
 * (with href), wikilink (with target), url, escape. Nested spans are all listed, outer ones first.
 * @param {string} line
 */
export function inlineSpans(line) {
  /** @type {{ kind: string, from: number, to: number, openTo: number, closeFrom: number, href?: string, target?: string }[]} */
  const out = [];
  scanInline(String(line), 0, out);
  return out.sort((a, b) => a.from - b.from || b.to - a.to);
}

const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING = /^( {0,3})(#{1,6})(?:[ \t]+|$)/;
const QUOTE = /^([ \t]*)>[ \t]?/;
const TASK = /^([ \t]*)([-*+])[ \t]+\[([ xX])\](?:[ \t]+|$)/;
const BULLET = /^([ \t]*)([-*+])[ \t]+/;
const ORDERED = /^([ \t]*)(\d{1,9})([.)])[ \t]+/;

/**
 * How a line starts: { kind, indent, markFrom, markTo }, kind bullet, ordered, task, quote, heading, rule or ''
 * (nothing). The sign runs from markFrom to markTo, where the content starts. Headings carry `level`, ordered items
 * `number` and `delimiter`, tasks `checked`.
 * @param {string} line
 */
export function linePrefix(line) {
  const text = withoutCr(String(line));
  const indent = /^[ \t]*/.exec(text)[0].length;
  let match;
  if (RULE.test(text)) return { kind: 'rule', indent, markFrom: indent, markTo: text.length };
  if ((match = HEADING.exec(text))) return { kind: 'heading', indent, markFrom: match[1].length, markTo: match[0].length, level: match[2].length };
  if ((match = QUOTE.exec(text))) return { kind: 'quote', indent, markFrom: match[1].length, markTo: match[0].length };
  if ((match = TASK.exec(text))) return { kind: 'task', indent, markFrom: match[1].length, markTo: match[0].length, checked: match[3] !== ' ' };
  if ((match = BULLET.exec(text))) return { kind: 'bullet', indent, markFrom: match[1].length, markTo: match[0].length };
  if ((match = ORDERED.exec(text))) return { kind: 'ordered', indent, markFrom: match[1].length, markTo: match[0].length, number: Number(match[2]), delimiter: match[3] };
  return { kind: '', indent, markFrom: indent, markTo: indent };
}

const SIGNS = { bold: '**', italic: '*', strike: '~~', highlight: '==', code: '`' };
// A letter's accent belongs to its word; an emoji's variation selector does not make it one.
const WORD = /[\p{L}\p{N}_'’]|(?![︎️])\p{M}/u;
const SPACE = /\s/;
const SIGN_KIND = { '**': 'bold', '*': 'italic', '~~': 'strike', '==': 'highlight', '`': 'code' };
const PAIR_SIGN = /[*~=`]/;

/** The signs of the left half of an empty pair, outer first (`***` is bold around italic), or null. */
function pairSigns(run) {
  const signs = [];
  for (let i = 0; i < run.length;) {
    const two = run.slice(i, i + 2);
    const sign = ['**', '~~', '=='].includes(two) ? two : ['*', '`'].includes(run[i]) ? run[i] : null;
    if (!sign || signs.some((other) => SIGN_KIND[other] === SIGN_KIND[sign])) return null;
    signs.push(sign);
    i += sign.length;
  }
  return signs;
}

/**
 * An empty pair around the caret: a button pressed before typing (Eric, 16 nov: "first the button, then type", as in a
 * word processor; selecting is awkward on a phone). `**¦**`, `***¦***` (bold and italic), `~~¦~~`. The editors hide its
 * signs and show the buttons as on; what is typed lands between the signs. { from, to, signs (outer first), kinds },
 * or null. Signs right against a word are the end of one span and the start of the next, not a pair.
 */
export function emptyPair(text, selFrom, selTo = selFrom) {
  text = String(text);
  if (selFrom !== selTo) return null;
  let from = selFrom, to = selFrom;
  while (from > 0 && PAIR_SIGN.test(text[from - 1])) from--;
  while (to < text.length && PAIR_SIGN.test(text[to])) to++;
  if (from === selFrom || to === selFrom || WORD.test(text[from - 1] ?? '') || WORD.test(text[to] ?? '')) return null;
  const signs = pairSigns(text.slice(from, selFrom));
  if (!signs || [...signs].reverse().join('') !== text.slice(selFrom, to)) return null;
  return { from, to, signs, kinds: signs.map((sign) => SIGN_KIND[sign]) };
}

/** The text with an empty pair's signs as spaces: the same positions, but `****` is no rule and `~~~~` no code fence. */
function maskPair(text, pair) {
  return pair ? text.slice(0, pair.from) + ' '.repeat(pair.to - pair.from) + text.slice(pair.to) : text;
}

/** The kind of run (text, code, table) each line is in. */
function lineKinds(text) {
  const kinds = [];
  for (const run of blocks(text)) for (let line = run.fromLine; line <= run.toLine; line++) kinds[line] = run.kind;
  return kinds;
}

/** The lines a selection touches; a selection that ends at the very start of a line leaves that line out. */
function touchedLines(table, from, to) {
  const first = table.at(from);
  let last = table.at(to);
  if (to > from && last > first && to === table.starts[last]) last--;
  return [first, last];
}

/** The spans of one line, in positions of the whole text. */
function spansOfLine(table, index) {
  const start = table.starts[index];
  return inlineSpans(table.lines[index]).map((span) => ({ ...span, from: span.from + start, to: span.to + start, openTo: span.openTo + start, closeFrom: span.closeFrom + start }));
}

/**
 * The span of `kind` that holds the selection (its signs included); a caret must be strictly inside. A selection
 * may also reach past the span over signs only, as when `***both***` is selected whole and italic is pressed.
 */
function holder(spans, kind, a, b, text) {
  return spans.find((span) => span.kind === kind && (a === b ? span.from < a && a < span.to
    : (span.from <= a && b <= span.to) || (a <= span.from && span.to <= b && text !== undefined && /^[*_~=`]*$/.test(text.slice(a, span.from) + text.slice(span.to, b)))));
}

/** The analysis behind an inline button: what it would take away, or where it would add its signs. */
function inlinePlan(text, selFrom, selTo, kind) {
  const sign = SIGNS[kind];
  const table = lineTable(text), kinds = lineKinds(text);
  if (selFrom === selTo) {
    const caret = selFrom;
    const pair = emptyPair(text, caret);
    if (pair) {
      // In an empty pair a button that is on takes its own signs away; another one adds its signs inside.
      const at = pair.kinds.indexOf(kind);
      if (at < 0) return { remove: false, edits: [{ from: caret, to: caret, insert: sign }, { from: caret, to: caret, insert: sign }], caret };
      const offset = pair.signs.slice(0, at).join('').length, left = pair.from + offset, right = pair.to - offset - sign.length;
      return { remove: true, edits: [{ from: left, to: left + sign.length, insert: '' }, { from: right, to: right + sign.length, insert: '' }], caret };
    }
    const index = table.at(caret);
    if (kinds[index] === 'code') return null;
    const spans = spansOfLine(table, index), own = holder(spans, kind, caret, caret);
    // At the end of the formatted words the button stops the formatting there, as in a word processor: the caret steps
    // over the closing sign and what is typed next is plain. Elsewhere in the words it takes the formatting away.
    if (own && caret === own.closeFrom && own.closeFrom > own.openTo) return { remove: true, step: own.to, edits: [], caret };
    if (own) return { remove: true, edits: [{ from: own.from, to: own.openTo, insert: '' }, { from: own.closeFrom, to: own.to, insert: '' }], caret };
    // No signs inside code, a web address or a link to a note.
    if (spans.some((span) => ['code', 'url', 'wikilink'].includes(span.kind) && span.from < caret && caret < span.to)) return null;
    const lineStart = table.starts[index], lineEnd = lineStart + withoutCr(table.lines[index]).length;
    let a = caret, b = caret;
    // A caret in a word formats that word: selecting is awkward on a phone.
    while (a > lineStart && WORD.test(text[a - 1])) a--;
    while (b < lineEnd && WORD.test(text[b])) b++;
    return { remove: false, edits: [{ from: a, to: a, insert: sign }, { from: b, to: b, insert: sign }], caret };
  }
  const [first, last] = touchedLines(table, selFrom, selTo);
  const segments = [];
  for (let index = first; index <= last; index++) {
    if (kinds[index] === 'code') continue;
    const lineStart = table.starts[index], line = withoutCr(table.lines[index]);
    let a = Math.max(selFrom, lineStart + linePrefix(line).markTo), b = Math.min(selTo, lineStart + line.length);
    // Spaces at the edges of the selection do not count.
    while (a < b && SPACE.test(text[a])) a++;
    while (b > a && SPACE.test(text[b - 1])) b--;
    if (a >= b) continue;
    const spans = spansOfLine(table, index);
    segments.push({ a, b, spans, own: holder(spans, kind, a, b, text) });
  }
  if (!segments.length) return null;
  const remove = segments.every((segment) => segment.own);
  const edits = [];
  for (const segment of segments) {
    if (remove) {
      edits.push({ from: segment.own.from, to: segment.own.openTo, insert: '' }, { from: segment.own.closeFrom, to: segment.own.to, insert: '' });
    } else if (!segment.own) {
      // The same formatting inside the selection goes, so it is not doubled.
      for (const span of segment.spans) {
        if (span.kind === kind && segment.a <= span.from && span.to <= segment.b) edits.push({ from: span.from, to: span.openTo, insert: '' }, { from: span.closeFrom, to: span.to, insert: '' });
      }
      edits.push({ from: segment.a, to: segment.a, insert: sign }, { from: segment.b, to: segment.b, insert: sign });
    }
  }
  return { remove, edits, a: segments[0].a, b: segments[segments.length - 1].b };
}

function inlineFormat(text, selFrom, selTo, kind) {
  const plan = inlinePlan(text, selFrom, selTo, kind);
  if (!plan) return null;
  // Stepping out changes no text: an empty replacement that only moves the caret.
  if (plan.step !== undefined) return { from: plan.caret, to: plan.caret, insert: '', selFrom: plan.step, selTo: plan.step };
  const { text: out, map } = applyEdits(text, plan.edits);
  if (plan.caret !== undefined) {
    // The caret stays in the same place in the words: behind the opening sign that is added in front of it.
    return replacement(text, out, plan.remove ? map(plan.caret) : plan.caret + SIGNS[kind].length);
  }
  return replacement(text, out, map(plan.a, true), map(plan.b, false));
}

/** The lines a line button works on: every touched line, blank ones left out when there are several. */
function lineTargets(table, kinds, selFrom, selTo) {
  const [first, last] = touchedLines(table, selFrom, selTo);
  const out = [];
  for (let index = first; index <= last; index++) {
    if (kinds[index] !== 'text') continue;
    if (first !== last && blank(table.lines[index])) continue;
    out.push(index);
  }
  return out;
}

function lineFormat(text, selFrom, selTo, command) {
  const table = lineTable(text), kinds = lineKinds(text);
  const targets = lineTargets(table, kinds, selFrom, selTo);
  if (!targets.length) return null;
  const prefixes = targets.map((index) => linePrefix(table.lines[index]));
  const edits = [];
  const set = (index, from, to, insert) => edits.push({ from: table.starts[index] + from, to: table.starts[index] + to, insert });
  if (command === 'heading') {
    // None, then ##, then ###, then none again. Never #: the first # heading is the note's title.
    const level = prefixes[0].kind === 'heading' ? prefixes[0].level : 0;
    const next = level <= 1 ? 2 : level === 2 ? 3 : 0;
    targets.forEach((index, i) => {
      const prefix = prefixes[i];
      if (prefix.kind === 'heading') set(index, prefix.markFrom, prefix.markTo, next ? `${'#'.repeat(next)} ` : '');
      else if (next) set(index, prefix.indent, prefix.indent, `${'#'.repeat(next)} `);
    });
  } else if (command === 'quote') {
    const all = prefixes.every((prefix) => prefix.kind === 'quote');
    targets.forEach((index, i) => {
      const prefix = prefixes[i];
      if (all) set(index, prefix.markFrom, prefix.markTo, '');
      else if (prefix.kind !== 'quote') set(index, 0, 0, '> ');
    });
  } else {
    // A task counts as a bullet: the bullet button takes its sign away instead of turning it into a plain item.
    const same = (prefix) => (command === 'bullet' ? prefix.kind === 'bullet' || prefix.kind === 'task' : prefix.kind === 'ordered');
    const all = prefixes.every(same);
    let number = 1;
    targets.forEach((index, i) => {
      const prefix = prefixes[i], list = ['bullet', 'task', 'ordered'].includes(prefix.kind);
      const from = list ? prefix.markFrom : prefix.indent, to = list ? prefix.markTo : prefix.indent;
      if (all) set(index, prefix.markFrom, prefix.markTo, '');
      else if (command === 'bullet') { if (!same(prefix)) set(index, from, to, '- '); }
      else set(index, from, to, `${number++}. `);
    });
  }
  const { text: out, map } = applyEdits(text, edits.filter((edit) => text.slice(edit.from, edit.to) !== edit.insert));
  if (out === text) return null;
  if (selFrom === selTo) return replacement(text, out, map(selFrom, true));
  return replacement(text, out, map(selFrom), map(selTo, true));
}

/**
 * A block of whole lines (a rule, a table) on the caret's line when that is blank, else under it. Always exactly one
 * blank line before and after it, except at the start or end of the text: without the blank line before, not every
 * app sees the block (`text` straight above `---` is a heading). `caretAfter` puts the caret on the line after it.
 */
function insertBlock(text, pos, block, caretAfter) {
  const { lines, at: lineAt } = lineTable(text);
  const index = lineAt(pos);
  const cr = lines[index].endsWith('\r') ? '\r' : '';
  let at = index + 1, remove = 0;
  if (blank(lines[index]) && (index === 0 || blank(lines[index - 1]))) { at = index; remove = 1; }
  const before = at > 0 && !blank(lines[at - 1]) ? [''] : [];
  const rest = at + remove;
  const after = rest < lines.length ? (blank(lines[rest]) ? [] : ['']) : caretAfter ? [''] : [];
  const next = [...lines.slice(0, at), ...[...before, ...block, ...after].map((line) => line + cr), ...lines.slice(rest)];
  const out = next.join('\n');
  const blockStart = next.slice(0, at + before.length).reduce((sum, line) => sum + line.length + 1, 0);
  const lastLine = at + before.length + block.length - 1;
  // After a rule the caret goes to the start of the line right under it.
  const caret = caretAfter ? next.slice(0, lastLine + 1).reduce((sum, line) => sum + line.length + 1, 0) : blockStart;
  return replacement(text, out, Math.min(caret, out.length));
}

/** A new table of 3 columns: the header and 2 rows, all cells empty. The selection lands at its start. */
export function insertTable(text, pos) {
  const row = '|  |  |  |';
  return insertBlock(String(text), pos, [row, '| --- | --- | --- |', row, row], false);
}

/**
 * The formatting buttons: bold, italic, strike, highlight, code, heading, bullet, ordered, quote, rule, table.
 * One replacement, or null when there is nothing to do (for example inside a code block).
 * @param {string} text
 * @param {number} selFrom
 * @param {number} selTo
 * @param {string} command
 */
export function applyFormat(text, selFrom, selTo, command) {
  text = String(text);
  const from = Math.max(0, Math.min(selFrom, selTo, text.length)), to = Math.min(text.length, Math.max(selFrom, selTo));
  if (command in SIGNS) return inlineFormat(text, from, to, command);
  if (['heading', 'bullet', 'ordered', 'quote'].includes(command)) return lineFormat(text, from, to, command);
  if (command !== 'rule' && command !== 'table') return null;
  if (lineKinds(text)[lineTable(text).at(to)] !== 'text') return null;
  return command === 'rule' ? insertBlock(text, to, ['---'], true) : insertTable(text, to);
}

/**
 * Which buttons are "on" for this selection: exactly when pressing them would take formatting away. Plus `checklist`
 * on a task, `table` in a table and `codeblock` in a code block.
 */
export function activeFormats(text, selFrom, selTo) {
  text = String(text);
  const from = Math.max(0, Math.min(selFrom, selTo, text.length)), to = Math.min(text.length, Math.max(selFrom, selTo));
  // An empty pair (a button pressed before typing) is on; its signs count as spaces for everything else.
  const pair = emptyPair(text, from, to), plain = maskPair(text, pair);
  const table = lineTable(plain), kinds = lineKinds(plain), index = table.at(from);
  if (kinds[index] === 'code') return ['codeblock'];
  const on = [];
  if (kinds[index] === 'table') on.push('table');
  for (const kind of Object.keys(SIGNS)) {
    if (pair?.kinds.includes(kind) || inlinePlan(plain, from, to, kind)?.remove) on.push(kind);
  }
  const prefix = linePrefix(table.lines[index]);
  const line = { heading: 'heading', bullet: 'bullet', ordered: 'ordered', task: 'checklist', quote: 'quote' }[prefix.kind];
  if (line && kinds[index] === 'text') on.push(line);
  return on.sort();
}

/**
 * Backspace with the caret right behind signs that the formatted view hides (`hidden`: [from, to] ranges from the
 * editor's own display). As in a word processor it takes the last visible letter before them (`**hello**¦` becomes
 * `**hell**¦`), not half a sign that would then show. Right behind a heading's hidden `## ` the line becomes plain
 * text; behind hidden signs at the start of a line it joins the line above. In an empty pair the whole pair goes.
 * Null: an ordinary Backspace.
 */
export function backspaceEdit(text, caret, hidden) {
  text = String(text);
  const pair = emptyPair(text, caret);
  if (pair) return { from: pair.from, to: pair.to, insert: '', selFrom: pair.from, selTo: pair.from };
  let start = caret;
  for (let run; (run = hidden.find(([from, to]) => to === start && from < start));) start = run[0];
  if (start === caret) return null;
  const at = (from, to = start) => ({ from, to, insert: '', selFrom: caret - (to - from), selTo: caret - (to - from) });
  const lineStart = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
  const next = text.indexOf('\n', lineStart), prefix = linePrefix(text.slice(lineStart, next < 0 ? text.length : next));
  if (prefix.kind === 'heading' && start === lineStart + prefix.markFrom && caret >= lineStart + prefix.markTo) return at(lineStart + prefix.markFrom, lineStart + prefix.markTo);
  if (start === lineStart) return start === 0 ? at(caret, caret) : at(start >= 2 && text[start - 2] === '\r' ? start - 2 : start - 1);
  const pairStart = start >= 2 && /[\uDC00-\uDFFF]/.test(text[start - 1]) && /[\uD800-\uDBFF]/.test(text[start - 2]);
  const from = pairStart ? start - 2 : start - 1;
  // The last letter of formatted words: its signs go with it, so no `****` is left to see.
  const left = emptyPair(text.slice(0, from) + text.slice(start), from);
  return left ? at(left.from, left.to + (start - from)) : at(from);
}

const LIST_ITEM = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))[ \t]+(?:\[([ xX])\](?:[ \t]+|$))?/;

const CARRIED = new Set(['bold', 'italic', 'strike', 'highlight', 'code']);

/**
 * Enter in a list, as in src/listEditor.ts and ListEditing.kt, plus numbered lists: the next item gets the same sign
 * (a bullet, the next number, an empty box), and Enter on an empty item takes its sign away.
 * On any text line, Enter inside bold, italic, strike, highlight or code goes on in it, as in a word processor (Eric,
 * 16 nov): the line is closed before the break and opened again after it (`**hel¦lo**` becomes `**hel**` and
 * `**¦lo**`), so no sign is carried to the next line on its own. An empty pair (a button pressed, nothing typed) moves
 * to the next line as it is. Null: an ordinary Enter.
 */
export function listEnterEdit(text, from, to = from) {
  text = String(text);
  const lineStart = text.lastIndexOf('\n', from - 1) + 1;
  const next = text.indexOf('\n', from);
  const lineEnd = next < 0 ? text.length : next;
  const line = text.slice(lineStart, lineEnd);
  if (to > lineEnd) return null;
  const table = lineTable(text);
  if (lineKinds(text)[table.at(lineStart)] !== 'text') return null;
  // A CRLF line keeps its `\r`, and the new line gets one too.
  const cr = line.endsWith('\r') ? '\r' : '', contentEnd = lineEnd - cr.length;
  from = Math.min(from, contentEnd); to = Math.min(to, contentEnd);
  const marker = LIST_ITEM.exec(line);
  const list = marker && from >= lineStart + marker[0].length ? marker : null;

  // The formatting the caret is in: `at` is where the break goes, before signs right in front of the caret.
  let at = from, close = '', open = '', before = '', after = '';
  const pair = from === to ? emptyPair(text, from) : null;
  if (pair) at = pair.from;
  else if (from === to) {
    const offset = lineStart + linePrefix(line).markTo;
    const spans = inlineSpans(text.slice(offset, contentEnd)).filter((span) => CARRIED.has(span.kind))
      .map((span) => ({ from: span.from + offset, to: span.to + offset, openTo: span.openTo + offset, closeFrom: span.closeFrom + offset }));
    for (let back; (back = spans.find((span) => span.openTo === at && span.from < at));) at = back.from;
    const inside = spans.filter((span) => span.openTo < at && at <= span.closeFrom);
    close = inside.map((span) => text.slice(span.closeFrom, span.to)).reverse().join('');
    open = inside.map((span) => text.slice(span.from, span.openTo)).join('');
    // Formatting cannot start or end on a space: spaces at the break stay outside the signs.
    if (inside.length) {
      while (at - before.length > lineStart && SPACE.test(text[at - before.length - 1])) before = text[at - before.length - 1] + before;
      if (at === from) while (SPACE.test(text[at + after.length] ?? '') && at + after.length < contentEnd) after += text[at + after.length];
    }
  }
  if (list) {
    const plain = maskPair(text, pair);
    const remaining = plain.slice(lineStart + list[0].length, from) + plain.slice(to, contentEnd);
    if (!remaining.trim()) {
      // An empty item in a level goes one level back; only on level 0 its sign goes (design kaarten-en-lijsten, part 7).
      const back = listLevels(text)[table.at(lineStart)] > 0 ? indentEdit(text, from, to, 'out') : null;
      return back || { from: lineStart, to: contentEnd, insert: '', selFrom: lineStart, selTo: lineStart };
    }
  } else if (at === from && !close) return null;
  const sign = list ? `${list[1]}${list[2] ? '-' : `${Number(list[3]) + 1}${list[4]}`} ${list[5] === undefined ? '' : '[ ] '}` : '';
  const start = at - before.length;
  const insert = `${close}${before}${cr}\n${sign}${after}${open}${text.slice(at, from)}`;
  return { from: start, to: to + after.length, insert, selFrom: start + insert.length, selTo: start + insert.length };
}

// --- Tables ------------------------------------------------------------------------------------------------------

const indentOf = (line) => /^[ \t]*/.exec(line)[0];
const crOf = (line) => (line.endsWith('\r') ? '\r' : '');
/** A table line in the one form JotDrop writes: `| a | b |`, one space around each cell, indent and `\r` kept. */
const tableLine = (like, cells) => `${indentOf(like)}| ${cells.join(' | ')} |${crOf(like)}`;
const DASH = { '': '---', left: ':---', center: ':---:', right: '---:' };

/**
 * One change to the table that starts on line `fromLine`, rewriting as few lines as possible (sync merges per line):
 * { type: 'setCell', row, column, text } (row 0 is the header; `text` as shown, cellSource makes it source),
 * { type: 'addRow', after } (0 = right under the header), { type: 'deleteRow', row }, { type: 'addColumn', at },
 * { type: 'deleteColumn', column }, { type: 'setAlign', column, align }, { type: 'deleteTable' }.
 * Never realigns the table with padding. Null when nothing changes or the change is not allowed (the header row and
 * the last column cannot go: that is "delete table").
 */
export function tableEdit(text, fromLine, op) {
  text = String(text);
  const run = blocks(text).find((item) => item.kind === 'table' && item.fromLine === fromLine);
  if (!run || !op) return null;
  const lines = text.split('\n');
  const columns = tableCells(lines[run.fromLine]).length, rows = run.toLine - run.fromLine - 1;
  const lineOf = (row) => (row === 0 ? run.fromLine : run.fromLine + 1 + row);
  const cellsOf = (line) => tableCells(line).map((cell) => cell.trim());
  const dashes = (line) => delimiterAligns(line).map((align) => DASH[align]);
  const tableStart = run.from;
  const done = (selection = tableStart) => replacement(text, lines.join('\n'), selection);
  switch (op.type) {
    case 'setCell': {
      if (!(op.row >= 0 && op.row <= rows && op.column >= 0 && op.column < columns)) return null;
      const index = lineOf(op.row), cells = cellsOf(lines[index]);
      while (cells.length < columns) cells.push('');
      const source = cellSource(op.text ?? '');
      if (cells[op.column] === source) return null;
      // Only this row's line is written again; extra cells past the last column stay.
      cells[op.column] = source;
      lines[index] = tableLine(lines[index], cells);
      return done();
    }
    case 'addRow': {
      const after = Math.max(0, Math.min(rows, op.after ?? rows));
      const at = run.fromLine + 2 + after, cr = crOf(lines[run.fromLine]);
      let row = tableLine(withoutCr(lines[run.fromLine]), Array(columns).fill(''));
      // A new last line of a CRLF text: the line above gets its `\r`, the new one ends the text without one.
      if (at === lines.length) { if (cr && !lines[at - 1].endsWith('\r')) lines[at - 1] += cr; }
      else row += cr;
      lines.splice(at, 0, row);
      return done();
    }
    case 'deleteRow': {
      if (!(op.row >= 1 && op.row <= rows)) return null;
      lines.splice(lineOf(op.row), 1);
      return done();
    }
    case 'addColumn': {
      const at = Math.max(0, Math.min(columns, op.at ?? columns));
      for (let index = run.fromLine; index <= run.toLine; index++) {
        const cells = index === run.fromLine + 1 ? dashes(lines[index]) : cellsOf(lines[index]);
        while (cells.length < at) cells.push('');
        cells.splice(at, 0, index === run.fromLine + 1 ? DASH[''] : '');
        lines[index] = tableLine(lines[index], cells);
      }
      return done();
    }
    case 'deleteColumn': {
      if (columns <= 1 || !(op.column >= 0 && op.column < columns)) return null;
      for (let index = run.fromLine; index <= run.toLine; index++) {
        const cells = index === run.fromLine + 1 ? dashes(lines[index]) : cellsOf(lines[index]);
        if (op.column < cells.length) cells.splice(op.column, 1);
        lines[index] = tableLine(lines[index], cells);
      }
      return done();
    }
    case 'setAlign': {
      // Only the delimiter line holds the alignment, so only that line changes.
      if (!(op.column >= 0 && op.column < columns) || !(op.align in DASH)) return null;
      const index = run.fromLine + 1, aligns = delimiterAligns(lines[index]);
      if (aligns[op.column] === op.align) return null;
      aligns[op.column] = op.align;
      lines[index] = tableLine(lines[index], aligns.map((align) => DASH[align]));
      return done();
    }
    case 'deleteTable': {
      let from = run.fromLine, count = run.toLine - run.fromLine + 1;
      const end = from + count;
      // At most one blank line stays where the table was; none at the very start or end of the text.
      if (end < lines.length && blank(lines[end]) && (from === 0 || blank(lines[from - 1]))) count++;
      else if (end >= lines.length && from > 0 && blank(lines[from - 1])) { from--; count++; }
      lines.splice(from, count);
      return done(Math.min(tableStart, lines.join('\n').length));
    }
    default: return null;
  }
}

// --- Lists in levels and ticking a task (design kaarten-en-lijsten, parts 4 and 6) ---------------------------------

const LIST_KINDS = new Set(['task', 'bullet', 'ordered']);

/** The width of a line's indent in columns: a space is 1, a tab goes on to the next multiple of 4. */
function indentColumns(line) {
  let column = 0;
  for (const char of line) {
    if (char === ' ') column++;
    else if (char === '\t') column += 4 - (column % 4);
    else break;
  }
  return column;
}

/**
 * The lists of a text, per line: a list line (task, bullet, numbered) is { level, column, parent, series }, with
 * `parent` the line of its main item or -1; a line of more text that belongs to an item (indented deeper than the
 * series' first level) is { level: -1, column, parent, series }; every other line is null. A series of list lines
 * ends at a blank line, a plain text line that is not indented deeper, a heading, a rule, a quote, a table or a code
 * block. The level comes from a stack: a line at column k takes everything at k or further off it.
 */
function listStructure(text) {
  const lines = String(text).split('\n'), kinds = lineKinds(text);
  /** @type {({ level: number, column: number, parent: number, series: number } | null)[]} */
  const out = [];
  /** @type {{ column: number, line: number }[]} */
  let stack = [];
  let series = -1;
  lines.forEach((line, index) => {
    const kind = kinds[index] === 'text' ? linePrefix(line).kind : null;
    const column = indentColumns(line);
    if (kind !== null && LIST_KINDS.has(kind)) {
      if (!stack.length) series++;
      while (stack.length && stack[stack.length - 1].column >= column) stack.pop();
      out.push({ level: stack.length, column, parent: stack.length ? stack[stack.length - 1].line : -1, series });
      stack.push({ column, line: index });
      return;
    }
    if (kind === '' && !blank(line) && stack.length && column > stack[0].column) {
      while (stack[stack.length - 1].column >= column) stack.pop();
      out.push({ level: -1, column, parent: stack[stack.length - 1].line, series });
      return;
    }
    stack = [];
    out.push(null);
  });
  return out;
}

/** The last line of an item: its own line plus the lines under it that are indented deeper (sub-items, more text). */
function itemEnd(structure, line) {
  const item = structure[line];
  let end = line;
  while (end + 1 < structure.length && structure[end + 1]?.series === item.series && structure[end + 1].column > item.column) end++;
  return end;
}

/**
 * The level of every line: 0 and up for a task, bullet or numbered line, -1 for any other line (design part 4).
 * Tabs, 2 spaces and 4 spaces all read: a tab counts to the next multiple of 4 columns.
 * @param {string} text
 * @returns {number[]}
 */
export function listLevels(text) {
  return listStructure(text).map((item) => (item ? item.level : -1));
}

/**
 * Ticks or unticks the task on line `line` (ticking writes a small `x`). With `move` (the setting "Move checked items
 * to the bottom") the task moves along with the lines under it, never past a blank or text line (design part 6):
 * ticked, it goes right under its last open sibling below it; unticked, right above its first ticked sibling above
 * it; else it stays. Bullets and numbered lines between the tasks stay where they are. Siblings are the items with the
 * same main item in the same series, so a sub-item stays among the sub-items of its main item.
 * One replacement plus `line`, the line the task is on now. The selection stays in its own text: in the task it goes
 * along with it, so a second press puts the same task back. Null when `line` is no task in a text block.
 * @param {string} text
 * @param {number} line
 * @param {boolean} move
 * @param {number} [selFrom]
 * @param {number} [selTo]
 */
export function tickEdit(text, line, move, selFrom = 0, selTo = selFrom) {
  text = String(text);
  const lines = text.split('\n'), structure = listStructure(text);
  const item = structure[line];
  if (!item || item.level < 0) return null;
  const prefix = linePrefix(lines[line]);
  if (prefix.kind !== 'task') return null;
  const box = lines[line].indexOf('[', prefix.markFrom + 1) + 1;
  const checked = !prefix.checked;
  const toggled = lines.slice();
  toggled[line] = lines[line].slice(0, box) + (checked ? 'x' : ' ') + lines[line].slice(box + 1);

  let order = lines.map((_, index) => index), at = line;
  if (move) {
    const end = itemEnd(structure, line);
    // More text of the main item between its sub-items splits them into two lists, as in Markdown.
    const joined = (index) => structure[index]?.series === item.series && !(structure[index].level < 0 && structure[index].parent === item.parent);
    let first = line, last = line;
    while (joined(first - 1)) first--;
    while (joined(last + 1)) last++;
    const siblings = [];
    for (let index = first; index <= last; index++) {
      const other = structure[index];
      if (index !== line && other.level >= 0 && other.parent === item.parent) {
        const kind = linePrefix(lines[index]);
        if (kind.kind === 'task') siblings.push({ index, checked: kind.checked });
      }
    }
    const block = order.slice(line, end + 1);
    const open = siblings.filter((other) => other.index > line && !other.checked);
    const done = siblings.filter((other) => other.index < line && other.checked);
    if (checked && open.length) {
      const target = itemEnd(structure, open[open.length - 1].index);
      order = [...order.slice(0, line), ...order.slice(end + 1, target + 1), ...block, ...order.slice(target + 1)];
      at = line + target - end;
    } else if (!checked && done.length) {
      const target = done[0].index;
      order = [...order.slice(0, target), ...block, ...order.slice(target, line), ...order.slice(end + 1)];
      at = target;
    }
  }
  const arrange = () => {
    const next = order.map((index) => toggled[index]);
    const last = lines.length - 1;
    if (order[last] !== last) {
      // The last line has no `\n` after it: the line that ends the text now takes over its ending, and the old last
      // line gets the ending of the line it swapped with. A CRLF text stays CRLF.
      const moved = order.indexOf(last), middleCr = crOf(toggled[order[last]]);
      next[moved] = withoutCr(next[moved]) + middleCr;
      next[last] = withoutCr(next[last]) + crOf(toggled[last]);
    }
    return next;
  };
  let next = arrange();
  if (at !== line) {
    // With mixed indents (4 spaces, then 2) a moved task could land under another main item. Then it is only ticked.
    const after = listStructure(next.join('\n'));
    const kept = order.every((old, index) => {
      const was = structure[old], now = after[index];
      if (!was || !now) return !was && !now;
      return was.level === now.level && (was.parent < 0 ? now.parent < 0 : order[now.parent] === was.parent);
    });
    if (!kept) { order = lines.map((_, index) => index); at = line; next = arrange(); }
  }
  const out = next.join('\n');
  const before = lineTable(text);
  const starts = [];
  let offset = 0;
  for (const value of next) { starts.push(offset); offset += value.length + 1; }
  const map = (pos) => {
    pos = Math.max(0, Math.min(text.length, pos));
    const index = before.at(pos), to = order.indexOf(index);
    return starts[to] + Math.min(pos - before.starts[index], next[to].length);
  };
  const a = map(selFrom), b = map(selTo);
  return { ...replacement(text, out, Math.min(a, b), Math.max(a, b)), line: at };
}

/** The item a line belongs to: the line itself for a list line, its main item for a line of more text, else -1. */
function itemOf(structure, line) {
  const item = structure[line];
  if (!item) return -1;
  return item.level >= 0 ? line : item.parent;
}

/** The nearest earlier item with the same main item in the same series, or -1. */
function previousSibling(structure, line) {
  const item = structure[line];
  for (let index = line - 1; index >= 0 && index !== item.parent && structure[index]?.series === item.series; index--) {
    if (structure[index].level >= 0 && structure[index].parent === item.parent) return index;
  }
  return -1;
}

/**
 * Indent (`'in'`) or outdent (`'out'`) every list item the selection touches, each with the lines under it (design
 * kaarten-en-lijsten, part 7). In: only an item with an earlier sibling, which becomes its main item; the item gets the
 * indent of that sibling's sub-items, or one tab more than it had. Out: the item gets the indent of its main item. A
 * numbered item gets the number that fits its new place (1, or one more than the item before it); the lines after it
 * are not renumbered. Only indents (and that number) change, so every line stays a line. Null when nothing can change:
 * outside a list, in a code block or table, the first item of a list, an item on level 0 going out.
 * @param {string} text
 * @param {number} selFrom
 * @param {number} selTo
 * @param {'in' | 'out'} direction
 */
export function indentEdit(text, selFrom, selTo = selFrom, direction = 'in') {
  text = String(text);
  const from = Math.max(0, Math.min(selFrom, selTo, text.length)), to = Math.min(text.length, Math.max(selFrom, selTo));
  const table = lineTable(text), original = table.lines;
  let lines = original.slice(), structure = listStructure(text);
  const [first, last] = touchedLines(table, from, to);
  const picked = [];
  for (let index = first; index <= last; index++) {
    const item = itemOf(structure, index);
    if (item >= 0 && !picked.includes(item)) picked.push(item);
  }
  // A picked item under another picked item moves along with that one.
  const roots = picked.filter((line) => {
    for (let up = structure[line].parent; up >= 0; up = structure[up].parent) if (picked.includes(up)) return false;
    return true;
  });
  // One item after the other, from the top, each on the text as the items above it left it.
  for (const root of roots) {
    structure = listStructure(lines.join('\n'));
    const item = structure[root], end = itemEnd(structure, root), own = indentOf(lines[root]);
    let parent, indent;
    if (direction === 'in') {
      parent = previousSibling(structure, root);
      if (parent < 0) continue;
      let child = -1;
      for (let index = parent + 1; index < root && child < 0; index++) if (structure[index]?.level >= 0 && structure[index].parent === parent) child = index;
      indent = child >= 0 ? indentOf(lines[child]) : `${own}\t`;
    } else {
      if (item.parent < 0) continue;
      parent = structure[item.parent].parent;
      indent = indentOf(lines[item.parent]);
    }
    const next = lines.slice();
    for (let index = root; index <= end; index++) {
      const line = next[index];
      next[index] = line.startsWith(own) ? indent + line.slice(own.length)
        : indent + ' '.repeat(Math.max(0, indentColumns(line) - item.column)) + line.slice(indentOf(line).length);
    }
    // With mixed indents the item could land somewhere else than meant; then it stays as it was.
    let after = listStructure(next.join('\n'));
    if (after[root]?.level !== item.level + (direction === 'in' ? 1 : -1) || after[root].parent !== parent) continue;
    const prefix = linePrefix(next[root]);
    if (prefix.kind === 'ordered') {
      const before = previousSibling(after, root), previous = before >= 0 ? linePrefix(next[before]) : null;
      const number = previous?.kind === 'ordered' ? previous.number + 1 : 1;
      next[root] = next[root].slice(0, prefix.markFrom) + next[root].slice(prefix.markFrom).replace(/^\d+/, String(number));
    }
    lines = next;
  }
  const out = lines.join('\n');
  if (out === text) return null;
  // Only the start of a line changes: a position in its words moves along, one in the old indent stays in the new one.
  const starts = [];
  let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  const map = (pos) => {
    const index = table.at(pos), was = original[index], now = lines[index];
    let same = 0;
    while (same < Math.min(was.length, now.length) && was[was.length - 1 - same] === now[now.length - 1 - same]) same++;
    const head = was.length - same, column = pos - table.starts[index];
    return starts[index] + (column >= head ? column + now.length - was.length : Math.min(column, now.length - same));
  };
  return replacement(text, out, map(from), map(to));
}

/**
 * The Checklist button (design kaarten-en-lijsten, part 7), the same in every app. On one line: a line without a list
 * sign gets `- [ ] ` after its indent, a bullet or numbered line gets a box in place of its sign (the indent stays),
 * and a task is ticked or unticked (tickEdit, moving with `move`). On several lines: the ones that are no task yet
 * become one; when all are tasks, all get ticked, or all unticked when they all were ticked (no moving then). Blank
 * lines in a selection of several stay blank. Null in a code block or table.
 * @param {string} text
 * @param {number} selFrom
 * @param {number} selTo
 * @param {boolean} move
 */
export function checklistEdit(text, selFrom, selTo = selFrom, move = false) {
  text = String(text);
  const from = Math.max(0, Math.min(selFrom, selTo, text.length)), to = Math.min(text.length, Math.max(selFrom, selTo));
  const table = lineTable(text), kinds = lineKinds(text);
  const [first, last] = touchedLines(table, from, to);
  const targets = [];
  for (let index = first; index <= last; index++) {
    if (kinds[index] !== 'text' || (first !== last && blank(table.lines[index]))) continue;
    targets.push(index);
  }
  if (!targets.length) return null;
  const prefixes = targets.map((index) => linePrefix(table.lines[index]));
  if (targets.length === 1 && prefixes[0].kind === 'task') return tickEdit(text, targets[0], move, from, to);
  const edits = [];
  const allTasks = prefixes.every((prefix) => prefix.kind === 'task'), tick = prefixes.some((prefix) => !prefix.checked);
  targets.forEach((index, i) => {
    const prefix = prefixes[i], at = table.starts[index];
    if (allTasks) {
      if (prefix.checked === tick) return;
      const box = at + table.lines[index].indexOf('[', prefix.markFrom + 1) + 1;
      edits.push({ from: box, to: box + 1, insert: tick ? 'x' : ' ' });
    } else if (prefix.kind === 'bullet') edits.push({ from: at + prefix.markTo, to: at + prefix.markTo, insert: '[ ] ' });
    else if (prefix.kind === 'ordered') edits.push({ from: at + prefix.markFrom, to: at + prefix.markTo, insert: '- [ ] ' });
    else if (prefix.kind !== 'task') edits.push({ from: at + prefix.indent, to: at + prefix.indent, insert: '- [ ] ' });
  });
  const { text: out, map } = applyEdits(text, edits);
  if (out === text) return null;
  if (from === to) return replacement(text, out, map(from, true));
  return replacement(text, out, map(from), map(to, true));
}

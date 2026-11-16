// Android must read tables and apply the formatting buttons exactly as the web app does: android/checks/FormatCheck.kt answers every case of
// cloud/shared/format-vectors.json and a few hundred random notes with FormatCore.kt, and this compares the answers with
// cloud/shared/format.mjs (whose own test, format.test.mjs, holds it to the vectors).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeFormats, applyFormat, backspaceEdit, blocks, cellSource, cellText, emptyPair, inlineSpans, linePrefix, listEnterEdit, parseTable, tableCells } from '../cloud/shared/format.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = (value) => Buffer.from(value, 'utf8').toString('base64');
const vectors = JSON.parse(readFileSync(path.join(root, 'cloud/shared/format-vectors.json'), 'utf8'));

const answer = {
  blocks: (text) => blocks(text).map((run) => [run.kind, run.fromLine, run.toLine, run.from, run.to].join(':')).join(','),
  cells: (line) => tableCells(line).map(code).join(','),
  parse: (lines) => {
    const table = parseTable(lines.split('\n'));
    return `${table.align.join(',')}|${table.header.map(code).join(',')}|${table.rows.map((row) => row.map(code).join(',')).join(';')}`;
  },
  cellText: (source) => code(cellText(source)),
  cellSource: (text) => code(cellSource(text)),
  inline: (line) => inlineSpans(line).map((span) => [span.kind, span.from, span.to, span.openTo, span.closeFrom].join(':')).join(','),
  prefix: (line) => { const prefix = linePrefix(line); return [prefix.kind, prefix.indent, prefix.markFrom, prefix.markTo].join(':'); },
  pair: (text, from, to) => { const pair = emptyPair(text, Number(from), Number(to)); return pair ? `${pair.from}:${pair.to}:${pair.kinds.join('+')}` : 'null'; },
  active: (text, from, to) => activeFormats(text, Number(from), Number(to)).join(','),
  apply: (text, from, to, command) => edit(applyFormat(text, Number(from), Number(to), command)),
  enter: (text, from, to) => edit(listEnterEdit(text, Number(from), Number(to))),
  backspace: (text, from, to, hidden = '') => edit(backspaceEdit(text, Number(from), hidden.split(';').filter(Boolean).map((range) => range.split('-').map(Number)))),
};
// The inserted text as UTF-16 units: a random selection can cut an emoji in half, which UTF-8 cannot carry.
const units = (value) => Array.from({ length: value.length }, (_, i) => value.charCodeAt(i).toString(16)).join('.');
function edit(value) { return value ? `${value.from}:${value.to}:${units(value.insert)}:${value.selFrom}:${value.selTo}` : 'null'; }
// In apply, active, pair and enter a ¦ marks the caret; two of them mark a selection.
const unmark = (marked) => {
  const a = marked.indexOf('¦'), b = marked.indexOf('¦', a + 1);
  if (b < 0) return [marked.slice(0, a) + marked.slice(a + 1), a, a];
  return [marked.slice(0, a) + marked.slice(a + 1, b) + marked.slice(b + 1), a, b - 1];
};

// A small deterministic generator, so a failing case can be found again.
let seed = 20261116;
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (items) => items[Math.floor(random() * items.length)];
const pool = ['| a | b |', '|---|:-:|', 'a | b', '--|--', '|:--|--:|', '| a | b | c |', '| 1 |', '| x \\| y | z |', '| `c | d` |', '```', '```js', '~~~', '````',
  '> | q | r |', '- a | b', '1. a | b', '    | i | j |', '\t| t |', '   | s | t |', '', '   ', 'text', 'Total: 3 €', '| 🎟️ | é |\r', '|---|\r', '| a |', '|', '||', '---', ': | -'];

const cases = [];
for (const vector of vectors.blocks) cases.push(['blocks', vector.text]);
for (const vector of vectors.cells) cases.push(['cells', vector.line]);
for (const vector of vectors.parse) cases.push(['parse', vector.lines.join('\n')]);
for (const vector of vectors.cellText) cases.push(['cellText', vector.source]);
for (const vector of vectors.cellSource) cases.push(['cellSource', vector.text]);
for (const vector of vectors.inline) cases.push(['inline', vector.line]);
for (const vector of vectors.prefix) cases.push(['prefix', vector.line]);
for (const vector of vectors.pair) cases.push(['pair', ...unmark(vector.text)]);
for (const vector of vectors.active) cases.push(['active', ...unmark(vector.text)]);
for (const vector of vectors.apply) cases.push(['apply', ...unmark(vector.text), vector.command]);
for (const vector of vectors.enter) cases.push(['enter', ...unmark(vector.text)]);
for (const vector of vectors.backspace) cases.push(['backspace', ...unmark(vector.text), vector.hidden.map((range) => range.join('-')).join(';')]);
for (let i = 0; i < 400; i++) {
  // Often a header and delimiter pair, so most notes hold a table to read (or nearly one).
  const text = Array.from({ length: 1 + Math.floor(random() * 7) }, () => (random() < 0.4
    ? `${pick(pool)}\n${pick(['|---|---|', '|:-:|', '--|--', '| --- | :-- | --: |', '|---|\r'])}` : pick(pool))).join('\n');
  cases.push(['blocks', text]);
  const lines = text.split('\n');
  for (const run of blocks(text).filter((item) => item.kind === 'table')) cases.push(['parse', lines.slice(run.fromLine, run.toLine + 1).join('\n')]);
  cases.push(['cells', pick(pool)]);
}
assert.ok(cases.filter(([kind]) => kind === 'parse').length > 100, 'the random notes hold enough tables');

// Random notes for the buttons: every button at a random caret or selection, with JavaScript's own whitespace and word
// rules in play (no-break spaces, accents, emoji, CRLF), where Java's regular expressions read text differently.
const lines = ['Hello world', '**bold** and *it*', '***both*** __u__ _i_', 'snake_case 2*3*4', 'a **** b', '~~gone~~ ==mark== `code`',
  '- milk', '* eggs', '  - [ ] task', '- [x] done', '1. one', '9) nine', '> quote', '## Head', '# Title', '---', '***', '', '  ', 'end\r',
  'see [Our site](https://example.com) and https://jotdrop.net.', '[[Note|alias]] ![[pic.png]]', '\\*not\\* italic', 'café ñ é', 'tab\there',
  ' no-break space ', 'em space', '🎟️ ticket 👍🏽', '```', '~~~', '| a | b |', '|---|---|', '| 1 | 2 |', '****', '~~~~', '`` x ``', '**a****b**', '==🎉=='];
const commands = ['bold', 'italic', 'strike', 'highlight', 'code', 'heading', 'bullet', 'ordered', 'quote', 'rule', 'table'];
for (let i = 0; i < 1500; i++) {
  const text = Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(lines)).join('\n');
  const a = Math.floor(random() * (text.length + 1)), b = random() < 0.5 ? a : Math.floor(random() * (text.length + 1));
  const from = Math.min(a, b), to = Math.max(a, b);
  cases.push(['apply', text, from, to, pick(commands)], ['active', text, from, to], ['pair', text, from, to], ['enter', text, from, to]);
  if (i % 5 === 0) cases.push(['inline', pick(lines)], ['prefix', pick(lines)]);
  // Backspace: the signs a display hides are the inline signs and a heading's sign, as both editors hide them.
  const hidden = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const prefix = linePrefix(line);
    if (prefix.kind === 'heading') hidden.push([offset + prefix.markFrom, offset + prefix.markTo]);
    for (const span of inlineSpans(line.slice(prefix.markTo))) {
      const at = offset + prefix.markTo;
      for (const [x, y] of [[span.from, span.openTo], [span.closeFrom, span.to]]) if (y > x) hidden.push([at + x, at + y]);
    }
    offset += line.length + 1;
  }
  for (const [, to] of hidden.slice(0, 4)) cases.push(['backspace', text, to, to, hidden.map((range) => range.join('-')).join(';')]);
  // A button pressed before typing: a caret inside the signs it leaves.
  const spaced = `${text} `, once = applyFormat(spaced, spaced.length, spaced.length, pick(['bold', 'italic', 'strike', 'highlight', 'code']));
  if (once) {
    const after = spaced.slice(0, once.from) + once.insert + spaced.slice(once.to);
    cases.push(['apply', after, once.selFrom, once.selFrom, pick(commands)], ['active', after, once.selFrom, once.selFrom], ['pair', after, once.selFrom, once.selFrom]);
  }
}

const temporary = mkdtempSync(path.join(tmpdir(), 'jotdrop-android-format-'));
try {
  const input = path.join(temporary, 'input.tsv'), output = path.join(temporary, 'output.tsv');
  writeFileSync(input, cases.map(([kind, value, ...rest]) => [kind, code(value), ...rest].join('\t')).join('\n'));
  const windows = process.platform === 'win32';
  execFileSync(windows ? process.env.ComSpec || 'cmd.exe' : './gradlew', windows ? ['/d', '/c', 'gradlew.bat checkFormat --no-daemon --console=plain'] : ['checkFormat', '--no-daemon', '--console=plain'], {
    cwd: path.join(root, 'android'), stdio: 'inherit', env: { ...process.env, JOTDROP_FORMAT_INPUT: input, JOTDROP_FORMAT_OUTPUT: output },
  });
  const results = readFileSync(output, 'utf8').split('\n');
  assert.equal(results.length, cases.length);
  for (const [index, [kind, value, ...rest]] of cases.entries()) {
    assert.equal(results[index], answer[kind](value, ...rest), `${kind} differs on Android for ${JSON.stringify(value)} ${JSON.stringify(rest)}`);
  }
  console.log(`Android format core matches the web app: ${cases.length} cases`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

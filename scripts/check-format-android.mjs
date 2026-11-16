// Android must find and read tables exactly as the web app does: android/checks/FormatCheck.kt answers every case of
// cloud/shared/format-vectors.json and a few hundred random notes with FormatCore.kt, and this compares the answers with
// cloud/shared/format.mjs (whose own test, format.test.mjs, holds it to the vectors).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocks, cellSource, cellText, parseTable, tableCells } from '../cloud/shared/format.mjs';

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

const temporary = mkdtempSync(path.join(tmpdir(), 'jotdrop-android-format-'));
try {
  const input = path.join(temporary, 'input.tsv'), output = path.join(temporary, 'output.tsv');
  writeFileSync(input, cases.map(([kind, value]) => `${kind}\t${code(value)}`).join('\n'));
  const windows = process.platform === 'win32';
  execFileSync(windows ? process.env.ComSpec || 'cmd.exe' : './gradlew', windows ? ['/d', '/c', 'gradlew.bat checkFormat --no-daemon --console=plain'] : ['checkFormat', '--no-daemon', '--console=plain'], {
    cwd: path.join(root, 'android'), stdio: 'inherit', env: { ...process.env, JOTDROP_FORMAT_INPUT: input, JOTDROP_FORMAT_OUTPUT: output },
  });
  const results = readFileSync(output, 'utf8').split('\n');
  assert.equal(results.length, cases.length);
  for (const [index, [kind, value]] of cases.entries()) {
    assert.equal(results[index], answer[kind](value), `${kind} differs on Android for ${JSON.stringify(value)}`);
  }
  console.log(`Android format core matches the web app: ${cases.length} cases`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

// Android must read tables and apply the formatting buttons exactly as the web app does: android/checks/FormatCheck.kt answers every case of
// cloud/shared/format-vectors.json and a few hundred random notes with FormatCore.kt, and this compares the answers with
// cloud/shared/format.mjs (whose own test, format.test.mjs, holds it to the vectors).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeFormats, applyFormat, backspaceEdit, blocks, cellSource, cellText, checklistEdit, deleteCheckedEdit, deleteItemEdit, dropItemEdit, dropSlots, emptyPair, indentEdit, inlineSpans, itemSpan, linePrefix, listEnterEdit, listItems, listLevels, moveItemEdit, parseTable, pasteLinesEdit, tableCells, tableEdit, tickEdit, uncheckAllEdit } from '../cloud/shared/format.mjs';

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
  table: (text, fromLine, type, row, column, after, at, align, cell) => {
    const op = { type };
    for (const [key, value] of [['row', row], ['column', column], ['after', after], ['at', at]]) if (value !== '_') op[key] = Number(value);
    if (align !== '_') op.align = align;
    if (cell !== '_') op.text = Buffer.from(cell, 'base64').toString('utf8');
    return edit(tableEdit(text, Number(fromLine), op));
  },
  backspace: (text, from, to, hidden = '') => edit(backspaceEdit(text, Number(from), hidden.split(';').filter(Boolean).map((range) => range.split('-').map(Number)))),
  levels: (text) => listLevels(text).join(','),
  items: (text) => listItems(text).join(','),
  tick: (text, from, to, line, move) => {
    const tick = tickEdit(text, Number(line), Number(move) === 1, Number(from), Number(to));
    return tick ? `${edit(tick)}:${tick.line}` : 'null';
  },
  indent: (text, from, to, direction) => edit(indentEdit(text, Number(from), Number(to), direction)),
  checklist: (text, from, to, move) => edit(checklistEdit(text, Number(from), Number(to), Number(move) === 1)),
  // Checklists in an open note (design checklists-77): a move and a drop answer with the line the item is on, the
  // others with their count. The pasted text comes in base64.
  move: (text, from, to, line, direction) => placed(moveItemEdit(text, Number(line), direction, Number(from), Number(to))),
  slots: (text, line) => dropSlots(text, Number(line)).map((slot) => [slot.before, slot.minLevel, slot.maxLevel].join(':')).join(','),
  drop: (text, from, to, line, before, level) => placed(dropItemEdit(text, Number(line), Number(before), Number(level), Number(from), Number(to))),
  delete: (text, from, to, line) => counted(deleteItemEdit(text, Number(line), Number(from), Number(to))),
  span: (text, line) => { const span = itemSpan(text, Number(line)); return span ? [span.line, span.end, span.count, span.place, span.of].join(':') : 'null'; },
  uncheckAll: (text, from, to) => counted(uncheckAllEdit(text, Number(from), Number(to))),
  deleteChecked: (text, from, to) => counted(deleteCheckedEdit(text, Number(from), Number(to))),
  paste: (text, from, to, pasted) => edit(pasteLinesEdit(text, Number(from), Number(to), Buffer.from(pasted, 'base64').toString('utf8'))),
};
// The inserted text as UTF-16 units: a random selection can cut an emoji in half, which UTF-8 cannot carry.
const units = (value) => Array.from({ length: value.length }, (_, i) => value.charCodeAt(i).toString(16)).join('.');
function edit(value) { return value ? `${value.from}:${value.to}:${units(value.insert)}:${value.selFrom}:${value.selTo}` : 'null'; }
function placed(value) { return value ? `${edit(value)}:${value.line}` : 'null'; }
function counted(value) { return value ? `${edit(value)}:${value.count}` : 'null'; }
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
for (const vector of vectors.levels) cases.push(['levels', vector.text]);
for (const vector of vectors.items) cases.push(['items', vector.text]);
for (const vector of vectors.tick) cases.push(['tick', ...unmark(vector.text), vector.line, vector.move ? 1 : 0]);
for (const vector of vectors.indent) cases.push(['indent', ...unmark(vector.text), vector.direction]);
for (const vector of vectors.checklist) cases.push(['checklist', ...unmark(vector.text), vector.move ? 1 : 0]);
for (const vector of vectors.move) cases.push(['move', ...unmark(vector.text), vector.line, vector.direction]);
for (const vector of vectors.slots) cases.push(['slots', vector.text, vector.line]);
for (const vector of vectors.drop) cases.push(['drop', ...unmark(vector.text), vector.line, vector.before, vector.level]);
for (const vector of vectors.delete) cases.push(['delete', ...unmark(vector.text), vector.line]);
for (const vector of vectors.span) cases.push(['span', vector.text, vector.line]);
for (const vector of vectors.uncheckAll) cases.push(['uncheckAll', ...unmark(vector.text)]);
for (const vector of vectors.deleteChecked) cases.push(['deleteChecked', ...unmark(vector.text)]);
for (const vector of vectors.paste) cases.push(['paste', ...unmark(vector.text), code(vector.pasted)]);
// A table change as fields: fromLine, type, row, column, after, at, align, text (base64); `_` is not set.
const tableCase = (text, fromLine, op) => ['table', text, fromLine, op.type,
  ...['row', 'column', 'after', 'at', 'align'].map((key) => (op[key] === undefined ? '_' : op[key])), op.text === undefined ? '_' : code(op.text)];
for (const vector of vectors.table) cases.push(tableCase(vector.text, vector.fromLine, vector.op));
const tableTypes = ['setCell', 'addRow', 'deleteRow', 'addColumn', 'deleteColumn', 'setAlign', 'deleteTable'];
const cellTexts = ['x', '', ' 1 ', 'a | b', 'two\nlines', 'cr\r\nlf', '**b**', '🎟️ é', '\\|'];
for (let i = 0; i < 400; i++) {
  // Often a header and delimiter pair, so most notes hold a table to read (or nearly one).
  const text = Array.from({ length: 1 + Math.floor(random() * 7) }, () => (random() < 0.4
    ? `${pick(pool)}\n${pick(['|---|---|', '|:-:|', '--|--', '| --- | :-- | --: |', '|---|\r'])}` : pick(pool))).join('\n');
  cases.push(['blocks', text]);
  const lines = text.split('\n');
  for (const run of blocks(text).filter((item) => item.kind === 'table')) cases.push(['parse', lines.slice(run.fromLine, run.toLine + 1).join('\n')]);
  cases.push(['cells', pick(pool)]);
  // Every table change on the tables of this note, with numbers just out of range too.
  for (const run of blocks(text).filter((item) => item.kind === 'table')) {
    const n = () => Math.floor(random() * 6) - 1;
    const op = { type: pick(tableTypes), row: n(), column: n(), after: n(), at: n(), align: pick(['', 'left', 'center', 'right', 'middle']), text: pick(cellTexts) };
    cases.push(tableCase(text, run.fromLine, op), tableCase(text, run.fromLine + 1, { type: 'addRow' }));
  }
}
assert.ok(cases.filter(([kind]) => kind === 'parse').length > 100, 'the random notes hold enough tables');
assert.ok(cases.filter(([kind]) => kind === 'table').length > 200, 'the random notes give enough table changes');

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

// Lists in levels and ticks (design kaarten-en-lijsten): every line of the vector texts, the nested-lists fixture and
// random lists, ticked with and without moving, the caret somewhere at random. Tabs, 2 and 4 spaces mix, as do CRLF,
// text between the items, code, quotes and tables.
const listTexts = [...vectors.levels.map((vector) => vector.text), ...vectors.tick.map((vector) => unmark(vector.text)[0]), ...vectors.indent.map((vector) => unmark(vector.text)[0]),
  readFileSync(path.join(root, 'cloud/shared/fixtures/format/nested-lists.md'), 'utf8')];
const listPool = ['- [ ] a', '- [x] b', '- [X] c', '\t- [ ] d', '\t- [x] e', '  - [ ] f', '  - [x] g', '    - [ ] h', '\t\t- [ ] i', '      - [x] j',
  '* [ ] k', '+ [x] l', '- m', '  - n', '1. o', '  2) p', 'text', '  more text', '\tmore', '', '   ', '# Head', '---', '```', '> - [ ] q',
  '| a | b |', '|---|---|', '- [ ] crlf\r', '\t- [x] tab crlf\r', '- [ ] 🚆 emoji', '   - [ ] three', '- [ ]', '- [x]'];
// Half of them only list lines, so many ticks move.
const itemPool = listPool.filter((line) => /^[ \t]*(?:[-*+] |\d)/.test(line));
for (let i = 0; i < 800; i++) listTexts.push(Array.from({ length: 1 + Math.floor(random() * 9) }, () => pick(i % 2 ? itemPool : listPool)).join('\n'));
for (const text of listTexts) {
  cases.push(['levels', text], ['items', text]);
  const count = text.split('\n').length;
  for (let line = -1; line <= count; line++) {
    for (const move of [0, 1]) {
      const a = Math.floor(random() * (text.length + 1)), b = random() < 0.5 ? a : Math.floor(random() * (text.length + 1));
      cases.push(['tick', text, Math.min(a, b), Math.max(a, b), line, move]);
    }
  }
  // Tab, Shift+Tab, the Checklist button and Enter at the end of every line; for the first three the caret or a
  // selection at random.
  let offset = 0;
  for (const line of text.split('\n')) {
    const a = offset + Math.floor(random() * (line.length + 1)), b = random() < 0.7 ? a : Math.floor(random() * (text.length + 1));
    const end = offset + line.length - (line.endsWith('\r') ? 1 : 0);
    cases.push(['indent', text, Math.min(a, b), Math.max(a, b), 'in'], ['indent', text, Math.min(a, b), Math.max(a, b), 'out'],
      ['checklist', text, Math.min(a, b), Math.max(a, b), random() < 0.5 ? 1 : 0], ['enter', text, end, end]);
    offset += line.length + 1;
  }
}
const moving = cases.filter(([kind, text, , , line, move]) => kind === 'tick' && move === 1 && (tickEdit(text, line, true)?.line ?? line) !== line).length;
assert.ok(moving > 400, `the lists give enough ticks that move (${moving})`);
const indenting = cases.filter(([kind, text, from, to, direction]) => kind === 'indent' && direction === 'in' && indentEdit(text, from, to, 'in')).length;
assert.ok(indenting > 400, `the lists give enough items that indent (${indenting})`);

// Checklists in an open note (design checklists-77): the same lists plus the texts of its own cases and the checklists
// fixture. Every line (and one before and after the text) is moved up and down, deleted and asked for its places; it is
// dropped on every place, on a level in or just outside the range, and on a line that may be no place at all. The menu
// runs on the whole text, and a paste lands at the end of every line and somewhere at random.
const checklistTexts = [...listTexts, ...vectors.slots.map((vector) => vector.text), ...vectors.span.map((vector) => vector.text),
  ...['move', 'drop', 'delete', 'uncheckAll', 'deleteChecked', 'paste'].flatMap((kind) => vectors[kind].map((vector) => unmark(vector.text)[0])),
  readFileSync(path.join(root, 'cloud/shared/fixtures/format/checklists.md'), 'utf8')];
const pastedPool = ['one\ntwo', 'a\r\nb\r\n', '- [x] done\n* [ ] open\n\n1. numbered', '\n\n', 'no break', '  indented\n\tmore\n', 'x\ry', '- \n- [ ]\nlast',
  '🚆 emoji\n2) two', '[x] loose\n+ plus', '- [X] capital\n\t- [ ] deep\n> quote', ' \n \n'];
for (const text of checklistTexts) {
  const count = text.split('\n').length;
  const selection = () => {
    const a = Math.floor(random() * (text.length + 1)), b = random() < 0.5 ? a : Math.floor(random() * (text.length + 1));
    return [Math.min(a, b), Math.max(a, b)];
  };
  cases.push(['uncheckAll', text, ...selection()], ['deleteChecked', text, ...selection()]);
  for (let line = -1; line <= count; line++) {
    cases.push(['move', text, ...selection(), line, 'up'], ['move', text, ...selection(), line, 'down'], ['delete', text, ...selection(), line], ['slots', text, line], ['span', text, line]);
    for (const slot of dropSlots(text, line)) {
      cases.push(['drop', text, ...selection(), line, slot.before, slot.minLevel - 1 + Math.floor(random() * (slot.maxLevel - slot.minLevel + 3))]);
    }
    cases.push(['drop', text, ...selection(), line, Math.floor(random() * (count + 3)) - 1, Math.floor(random() * 4)]);
  }
  let offset = 0;
  for (const line of text.split('\n')) {
    const end = offset + line.length - (line.endsWith('\r') ? 1 : 0), [from, to] = selection();
    cases.push(['paste', text, end, end, code(pick(pastedPool))], ['paste', text, from, random() < 0.6 ? from : to, code(pick(pastedPool))]);
    offset += line.length + 1;
  }
}
const tally = (kind, works) => cases.filter(([name, text, ...rest]) => name === kind && works(text, ...rest)).length;
const trading = tally('move', (text, from, to, line, direction) => moveItemEdit(text, line, direction));
assert.ok(trading > 1500, `the lists give enough items that trade places (${trading})`);
const dropping = tally('drop', (text, from, to, line, before, level) => dropItemEdit(text, line, before, level));
assert.ok(dropping > 5000, `the lists give enough drops (${dropping})`);
const deleting = tally('delete', (text, from, to, line) => deleteItemEdit(text, line));
assert.ok(deleting > 2500, `the lists give enough items to delete (${deleting})`);
const clearing = tally('deleteChecked', (text) => deleteCheckedEdit(text));
assert.ok(clearing > 300, `the lists give enough ticked tasks to delete (${clearing})`);
const pasting = tally('paste', (text, from, to, pasted) => pasteLinesEdit(text, from, to, Buffer.from(pasted, 'base64').toString('utf8')));
assert.ok(pasting > 1500, `the lists give enough pastes that make items (${pasting})`);

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

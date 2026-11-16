import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { activeFormats, applyFormat, blocks, cellSource, cellText, inlineSpans, insertTable, linePrefix, listEnterEdit, parseTable, tableCells, tableEdit } from './format.mjs';

// The same cases run on Android (scripts/check-format-android.mjs), so every app sees the same tables.
const vectors = JSON.parse(readFileSync(new URL('./format-vectors.json', import.meta.url), 'utf8'));
const fixtures = new URL('./fixtures/format/', import.meta.url);

test('a note splits into text, code and table runs', () => {
  for (const vector of vectors.blocks) {
    assert.deepEqual(blocks(vector.text).map((run) => [run.kind, run.fromLine, run.toLine]), vector.expect, vector.name);
  }
});

test('the runs follow each other, cover every line and point at their own text', () => {
  const texts = [...vectors.blocks.map((vector) => vector.text), ...readdirSync(fixtures).map((name) => readFileSync(new URL(name, fixtures), 'utf8'))];
  for (const text of texts) {
    const runs = blocks(text), lines = text.split('\n');
    assert.equal(runs[0].fromLine, 0);
    assert.equal(runs.at(-1).toLine, lines.length - 1);
    for (const [i, run] of runs.entries()) {
      if (i) assert.equal(run.fromLine, runs[i - 1].toLine + 1);
      if (i) assert.notEqual(run.kind === 'text' && runs[i - 1].kind === 'text', true, 'text runs are joined');
      assert.equal(text.slice(run.from, run.to), lines.slice(run.fromLine, run.toLine + 1).join('\n'));
    }
  }
});

test('table cells, parsed tables and cell text', () => {
  for (const vector of vectors.cells) assert.deepEqual(tableCells(vector.line), vector.expect, vector.name);
  for (const vector of vectors.parse) assert.deepEqual(parseTable(vector.lines), vector.expect, vector.name);
  for (const vector of vectors.cellText) assert.equal(cellText(vector.source), vector.expect, vector.name);
  for (const vector of vectors.cellSource) assert.equal(cellSource(vector.text), vector.expect, vector.name);
});

test('real notes: the tables are found and a cell goes back to its own source', () => {
  const tables = { 'obsidian-note.md': 1, 'decimos.md': 1 };
  for (const name of readdirSync(fixtures)) {
    const text = readFileSync(new URL(name, fixtures), 'utf8');
    const found = blocks(text).filter((run) => run.kind === 'table');
    assert.equal(found.length, tables[name], name);
    for (const run of found) {
      const table = parseTable(text.split('\n').slice(run.fromLine, run.toLine + 1));
      for (const cell of [...table.header, ...table.rows.flat()]) assert.equal(cellSource(cellText(cell)), cell, `${name}: ${cell}`);
    }
  }
  const decimos = parseTable(readFileSync(new URL('decimos.md', fixtures), 'utf8').split('\n').filter((line) => line.startsWith('|')).map((line) => line.replace(/\r$/, '')));
  assert.equal(decimos.header.length, 8);
  assert.equal(decimos.rows.length, 5);
  assert.equal(cellText(decimos.rows[1][7]), '| compartido');
});

// In apply, active and enter a ¦ marks the caret; two of them mark a selection.
const unmark = (marked) => {
  const a = marked.indexOf('¦'), b = marked.indexOf('¦', a + 1);
  if (b < 0) return { text: marked.slice(0, a) + marked.slice(a + 1), from: a, to: a };
  return { text: marked.slice(0, a) + marked.slice(a + 1, b) + marked.slice(b + 1), from: a, to: b - 1 };
};
const marked = (text, from, to) => (from === to ? `${text.slice(0, from)}¦${text.slice(from)}` : `${text.slice(0, from)}¦${text.slice(from, to)}¦${text.slice(to)}`);
const applied = (text, edit) => text.slice(0, edit.from) + edit.insert + text.slice(edit.to);

test('formatting signs in a line, as the card text reads them', () => {
  for (const vector of vectors.inline) assert.deepEqual(inlineSpans(vector.line).map((span) => [span.kind, span.from, span.to, span.openTo, span.closeFrom]), vector.expect, vector.name);
  for (const vector of vectors.prefix) {
    const prefix = linePrefix(vector.line);
    assert.deepEqual([prefix.kind, prefix.markFrom, prefix.markTo], vector.expect, vector.name);
  }
});

test('the buttons make one small replacement and put the selection where the words are', () => {
  for (const vector of vectors.apply) {
    const { text, from, to } = unmark(vector.text);
    const edit = applyFormat(text, from, to, vector.command);
    assert.equal(edit && marked(applied(text, edit), edit.selFrom, edit.selTo), vector.expect, vector.name);
    // One replacement: nothing outside it changes, and it is as small as it can be.
    if (edit) assert.ok(edit.insert[0] !== text[edit.from] || edit.from === edit.to, `${vector.name}: the replacement starts where the text differs`);
  }
  for (const vector of vectors.active) {
    const { text, from, to } = unmark(vector.text);
    assert.deepEqual(activeFormats(text, from, to), vector.expect, vector.name);
  }
});

test('a button that is on takes its formatting away, and pressing it twice gives the text back', () => {
  for (const vector of vectors.apply.filter((item) => ['bold', 'italic', 'strike', 'highlight', 'code', 'bullet', 'ordered', 'quote'].includes(item.command))) {
    const { text, from, to } = unmark(vector.text);
    const once = applyFormat(text, from, to, vector.command);
    if (!once) continue;
    const after = applied(text, once);
    const on = activeFormats(after, once.selFrom, once.selTo).includes(vector.command);
    const twice = applyFormat(after, once.selFrom, once.selTo, vector.command);
    // Only for plain text: on text that was partly formatted, the second press makes it all plain.
    const plain = !/[*_~=`]/.test(text) && !text.split('\n').some((line) => linePrefix(line).kind);
    if (on && twice && plain) assert.equal(applied(after, twice), text, `${vector.name}: twice`);
  }
});

test('Enter in a list', () => {
  for (const vector of vectors.enter) {
    const { text, from, to } = unmark(vector.text);
    const edit = listEnterEdit(text, from, to);
    assert.equal(edit && marked(applied(text, edit), edit.selFrom, edit.selTo), vector.expect, vector.name);
  }
});

test('table edits rewrite as few lines as possible', () => {
  for (const vector of vectors.table) {
    const edit = tableEdit(vector.text, vector.fromLine, vector.op);
    assert.equal(edit && applied(vector.text, edit), vector.expect, vector.name);
  }
});

test('real notes: one cell edit changes exactly one line, every other byte stays', () => {
  for (const name of readdirSync(fixtures)) {
    const text = readFileSync(new URL(name, fixtures), 'utf8');
    for (const run of blocks(text).filter((item) => item.kind === 'table')) {
      const table = parseTable(text.split('\n').slice(run.fromLine, run.toLine + 1));
      for (let row = 0; row <= table.rows.length; row++) {
        for (let column = 0; column < table.header.length; column++) {
          const edit = tableEdit(text, run.fromLine, { type: 'setCell', row, column, text: 'changed' });
          const before = text.split('\n'), after = applied(text, edit).split('\n');
          assert.equal(after.length, before.length, name);
          const changed = after.map((line, i) => i).filter((i) => after[i] !== before[i]);
          assert.deepEqual(changed, [row === 0 ? run.fromLine : run.fromLine + 1 + row], `${name} ${row}/${column}`);
          // The table is still the same table, with the new cell in it.
          const again = blocks(applied(text, edit)).find((item) => item.kind === 'table' && item.fromLine === run.fromLine);
          assert.equal(again.toLine, run.toLine, name);
          const cells = parseTable(after.slice(run.fromLine, run.toLine + 1));
          assert.equal((row === 0 ? cells.header : cells.rows[row - 1])[column], 'changed', name);
        }
      }
      // Writing a cell's own text back is no change at all.
      for (let column = 0; column < table.header.length; column++) assert.equal(tableEdit(text, run.fromLine, { type: 'setCell', row: 1, column, text: cellText(table.rows[0][column]) }), null, name);
    }
  }
});

test('a new table is found as a table in every place it can land', () => {
  for (const text of ['', 'One', 'One\n', 'One\n\nTwo', 'One\r\nTwo\r\n', '- item', '```\ncode\n```\nafter', '| a |\n|---|\n| 1 |\n\nend']) {
    for (let pos = 0; pos <= text.length; pos++) {
      const edit = applyFormat(text, pos, pos, 'table');
      if (!edit) continue;
      const out = applied(text, edit);
      const found = blocks(out).filter((run) => run.kind === 'table');
      assert.equal(found.length, blocks(text).filter((run) => run.kind === 'table').length + 1, `${JSON.stringify(text)} at ${pos}`);
      assert.ok(found.some((run) => run.from === edit.selFrom), `${JSON.stringify(text)} at ${pos}: the selection is at the new table`);
      assert.equal(insertTable(text, pos)?.insert, edit.insert);
      // Only lines are added: every old line with words on it is still there, in order.
      const old = text.split('\n').filter((line) => line.trim()), lines = out.split('\n');
      let i = 0;
      for (const line of lines) if (line === old[i]) i++;
      assert.equal(i, old.length, `${JSON.stringify(text)} at ${pos}: old lines stay`);
    }
  }
});

test('the buttons never break a surrogate pair', () => {
  const text = '🎟️ **a** 😀b c😀\n- 😀 x';
  for (let from = 0; from <= text.length; from++) {
    for (const to of [from, Math.min(text.length, from + 3)]) {
      for (const command of ['bold', 'italic', 'strike', 'highlight', 'code', 'heading', 'bullet', 'ordered', 'quote']) {
        const edit = applyFormat(text, from, to, command);
        if (!edit) continue;
        const out = applied(text, edit);
        // Every high surrogate is still followed by its low surrogate, unless the caret was put between them.
        const broken = [...out.matchAll(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g)].length;
        const before = [...text.slice(0, from).matchAll(/[\uD800-\uDBFF]$/g)].length + [...text.slice(0, to).matchAll(/[\uD800-\uDBFF]$/g)].length;
        if (!before) assert.equal(broken, 0, `${command} ${from}-${to}: ${JSON.stringify(out)}`);
      }
    }
  }
});

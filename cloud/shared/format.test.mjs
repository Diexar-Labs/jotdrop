import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { blocks, cellSource, cellText, parseTable, tableCells } from './format.mjs';

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

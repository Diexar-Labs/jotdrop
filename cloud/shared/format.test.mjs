import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { activeFormats, addItemEdit, applyFormat, backspaceEdit, blocks, cellSource, cellText, checkedTail, checklistEdit, deleteCheckedEdit, deleteItemEdit, dropItemEdit, dropSlots, emptyPair, indentEdit, inlineSpans, insertTable, itemBackspaceEdit, itemSpan, linePrefix, listEnterEdit, listItems, listLevels, moveItemEdit, parseTable, pasteLinesEdit, tableCells, tableEdit, tickEdit, uncheckAllEdit } from './format.mjs';

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
  const tables = { 'obsidian-note.md': 1, 'decimos.md': 1, 'nested-lists.md': 0, 'checklists.md': 0 };
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
    // Stepping out of formatting changes no text, so there is nothing to give back.
    if (!once || (once.from === once.to && !once.insert)) continue;
    const after = applied(text, once);
    const on = activeFormats(after, once.selFrom, once.selTo).includes(vector.command);
    const twice = applyFormat(after, once.selFrom, once.selTo, vector.command);
    // Only for plain text: on text that was partly formatted, the second press makes it all plain.
    const plain = !/[*_~=`]/.test(text) && !text.split('\n').some((line) => linePrefix(line).kind);
    // At the end of the words the second press steps out instead (one more case in the 'empty pair' test).
    const steps = twice && twice.from === twice.to && !twice.insert;
    if (on && twice && plain && !steps) assert.equal(applied(after, twice), text, `${vector.name}: twice`);
  }
});

test('an empty pair: a button pressed before typing', () => {
  for (const vector of vectors.pair) {
    const { text, from, to } = unmark(vector.text);
    const pair = emptyPair(text, from, to);
    assert.deepEqual(pair && [pair.from, pair.to, pair.kinds], vector.expect, vector.name);
  }
  // First the button, then type, then the button again: the words are formatted and what follows is plain.
  let text = 'Say ', caret = 4;
  const press = (command) => {
    const edit = applyFormat(text, caret, caret, command);
    text = applied(text, edit);
    caret = edit.selFrom;
  };
  const type = (words) => { text = text.slice(0, caret) + words + text.slice(caret); caret += words.length; };
  press('bold');
  assert.deepEqual(activeFormats(text, caret, caret), ['bold']);
  type('hello');
  press('bold');
  assert.deepEqual(activeFormats(text, caret, caret), []);
  type(' there');
  assert.equal(text, 'Say **hello** there');
});

test('Backspace behind hidden signs takes a letter you see', () => {
  for (const vector of vectors.backspace) {
    const { text, from } = unmark(vector.text);
    const edit = backspaceEdit(text, from, vector.hidden);
    assert.equal(edit && marked(applied(text, edit), edit.selFrom, edit.selTo), vector.expect, vector.name);
  }
});

test('Backspace at the sign of a list item joins the line above, or takes the sign of a first line', () => {
  for (const vector of vectors.itemBackspace) {
    const { text, from } = unmark(vector.text);
    const edit = itemBackspaceEdit(text, from, vector.hidden);
    assert.equal(edit && marked(applied(text, edit), edit.selFrom, edit.selTo), vector.expect, vector.name);
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

test('lists in levels', () => {
  for (const vector of vectors.levels) assert.deepEqual(listLevels(vector.text), vector.expect, vector.name);
  const nested = readFileSync(new URL('nested-lists.md', fixtures), 'utf8');
  assert.deepEqual(listLevels(nested), [-1, -1, -1, 0, 1, 1, 2, 0, 1, 2, 0, -1, 0, 1, 1, 0, -1, 0, 1, 1, 0, 1, -1, 0, 1, 1, -1, -1, -1, -1, -1, -1, -1]);
});

test('the item a line belongs to', () => {
  for (const vector of vectors.items) assert.deepEqual(listItems(vector.text), vector.expect, vector.name);
  // On every list text: a list line is its own item, any other line that has one is plain text right under a list
  // line or under more of its text, and its item is a list line above it in the same run of lines.
  const texts = [...vectors.levels.map((vector) => vector.text), ...vectors.items.map((vector) => vector.text),
    readFileSync(new URL('nested-lists.md', fixtures), 'utf8'), readFileSync(new URL('checklists.md', fixtures), 'utf8')];
  let more = 0;
  for (const text of texts) {
    const levels = listLevels(text), items = listItems(text);
    assert.equal(items.length, text.split('\n').length, 'one answer per line');
    items.forEach((item, index) => {
      if (levels[index] >= 0) return assert.equal(item, index, 'a list line is its own item');
      if (item < 0) return;
      more++;
      assert.ok(item < index && levels[item] >= 0, 'more text belongs to a list line above it');
      for (let line = item; line <= index; line++) assert.ok(items[line] >= 0, 'no line outside the list between an item and its text');
    });
  }
  assert.ok(more >= 8, `the texts hold enough lines of more text (${more})`);
});

test('ticking a task, with and without moving it', () => {
  for (const vector of vectors.tick) {
    const { text, from, to } = unmark(vector.text);
    const edit = tickEdit(text, vector.line, vector.move, from, to);
    assert.equal(edit && marked(applied(text, edit), edit.selFrom, edit.selTo), vector.expect, vector.name);
    if (edit) assert.equal(edit.line, vector.expectLine, `${vector.name}: the line it is on`);
  }
});

// The lines whose box a tick changes besides the task's own (design checklists-77-v2, part 7), found here with itemSpan
// alone: the tasks under it that are not that way yet, and for an untick the ticked tasks it lies in.
const tickedAlong = (text, index, checked) => {
  const lines = text.split('\n'), levels = listLevels(text), end = itemSpan(text, index).end, along = [];
  lines.forEach((line, other) => {
    const box = levels[other] >= 0 && linePrefix(line).kind === 'task' ? linePrefix(line) : null;
    if (!box || other === index) return;
    const under = other > index && other <= end, above = other < index && itemSpan(text, other).end >= index;
    if ((under && box.checked !== checked) || (above && !checked && box.checked)) along.push(other);
  });
  return along;
};

test('a tick changes the box of the task, of the tasks under it and, unticked, of the ticked tasks above it; whole lines move only and every line keeps its level', () => {
  const strip = (line) => line.replace(/\r$/, '');
  const texts = [...vectors.levels.map((vector) => vector.text), ...vectors.tick.map((vector) => unmark(vector.text).text),
    ...vectors.tail.map((vector) => vector.text), ...readdirSync(fixtures).map((name) => readFileSync(new URL(name, fixtures), 'utf8'))];
  let moved = 0, under = 0, above = 0, twice = 0;
  for (const text of texts) {
    const lines = text.split('\n'), levels = listLevels(text);
    lines.forEach((line, index) => {
      for (const move of [false, true]) {
        const name = `${JSON.stringify(text.slice(0, 40))} line ${index}${move ? ', moving' : ''}`;
        const edit = tickEdit(text, index, move);
        if (!edit) { assert.ok(!(linePrefix(line).kind === 'task' && levels[index] >= 0), `${name}: a task is ticked`); continue; }
        const checked = !linePrefix(line).checked, along = tickedAlong(text, index, checked);
        const out = applied(text, edit), after = out.split('\n'), afterLevels = listLevels(out);
        // The lines as they must be before anything moves: the task and the ones that go along have the new box, the
        // rest is as it was. Ticking writes a small x; a box that was right already stays as it is written.
        const boxed = lines.map((value, i) => (i === index || along.includes(i) ? strip(value).replace(/\[[ xX]\]/, checked ? '[x]' : '[ ]') : strip(value)));
        assert.equal(strip(after[edit.line]), boxed[index], `${name}: the same words with the other box`);
        // Only whole lines move, each with its level; the line endings stay as they were.
        assert.deepEqual(after.map((value, i) => `${strip(value)}|${afterLevels[i]}`).sort(), boxed.map((value, i) => `${value}|${levels[i]}`).sort(), name);
        assert.equal(after.filter((value) => value.endsWith('\r')).length, lines.filter((value) => value.endsWith('\r')).length, name);
        assert.equal(out.endsWith('\n'), text.endsWith('\n'), name);
        // Afterwards every task under it has its box, and unticked no ticked task has it under it.
        assert.deepEqual(tickedAlong(out, edit.line, checked), [], `${name}: nothing is left to take along`);
        if (!move) {
          assert.equal(edit.line, index, name);
          assert.deepEqual(after.map(strip), boxed, `${name}: only those boxes change`);
          if (!along.length) assert.deepEqual([edit.to - edit.from, edit.insert.length], [1, 1], `${name}: only the box changes`);
          if (!along.length && !tickedAlong(out, index, !checked).length) {
            // With nothing to take along either way, twice gives the text back; ticking writes a small x.
            const back = tickEdit(out, index, false);
            assert.equal(applied(out, back), lines.map((value, i) => (i === index ? value.replace('[X]', '[x]') : value)).join('\n'), `${name}: twice gives the text back`);
            twice++;
          }
          under += along.filter((other) => other > index).length;
          above += along.filter((other) => other < index).length;
        } else if (edit.line !== index) moved++;
      }
    });
  }
  assert.ok(moved >= 40, `only ${moved} moves were tried`);
  assert.ok(under >= 40 && above >= 20, `only ${under} tasks under a task and ${above} above one went along`);
  assert.ok(twice >= 100, `only ${twice} ticks were pressed twice`);
});

test('Tab and Shift+Tab on list items', () => {
  for (const vector of vectors.indent) {
    const { text, from, to } = unmark(vector.text);
    const edit = indentEdit(text, from, to, vector.direction);
    assert.equal(edit && marked(applied(text, edit), edit.selFrom, edit.selTo), vector.expect, vector.name);
  }
});

test('indenting changes only the start of lines, one level at a time, and out undoes in', () => {
  const texts = [...vectors.levels.map((vector) => vector.text), ...vectors.indent.map((vector) => unmark(vector.text).text),
    ...vectors.tick.map((vector) => unmark(vector.text).text), ...readdirSync(fixtures).map((name) => readFileSync(new URL(name, fixtures), 'utf8'))];
  const words = (line) => line.replace(/^[ \t]*(?:\d+(?=[.)]))?/, '');
  let indented = 0;
  for (const text of texts) {
    const lines = text.split('\n'), levels = listLevels(text);
    let offset = 0;
    lines.forEach((line, index) => {
      const caret = offset + line.length - (line.endsWith('\r') ? 1 : 0);
      offset += line.length + 1;
      for (const direction of ['in', 'out']) {
        const name = `${JSON.stringify(text.slice(0, 40))} line ${index} ${direction}`;
        const edit = indentEdit(text, caret, caret, direction);
        if (!edit) continue;
        const out = applied(text, edit), after = out.split('\n'), afterLevels = listLevels(out);
        assert.equal(after.length, lines.length, `${name}: every line stays a line`);
        after.forEach((value, i) => assert.equal(words(value), words(lines[i]), `${name}: only the indent and number of line ${i} change`));
        const item = levels[index] >= 0 ? index : null;
        if (item !== null) assert.equal(afterLevels[item], levels[item] + (direction === 'in' ? 1 : -1), `${name}: one level`);
        if (direction === 'in') {
          indented++;
          // Out right after in gives the same levels back.
          const back = indentEdit(out, edit.selFrom, edit.selTo, 'out');
          assert.ok(back, `${name}: out after in`);
          assert.deepEqual(listLevels(applied(out, back)), levels, `${name}: out after in gives the levels back`);
        }
      }
    });
  }
  assert.ok(indented >= 30, `only ${indented} indents were tried`);
});

test('the Checklist button', () => {
  for (const vector of vectors.checklist) {
    const { text, from, to } = unmark(vector.text);
    const edit = checklistEdit(text, from, to, vector.move);
    assert.equal(edit && marked(applied(text, edit), edit.selFrom, edit.selTo), vector.expect, vector.name);
  }
});

// --- Checklists in an open note (design checklists-77, part 7) ------------------------------------------------------

/** A case with a ¦ in its text: the edit gives the expected text and selection, as one replacement that starts where the text differs. */
const plays = (vector, edit) => {
  const { text } = unmark(vector.text);
  assert.equal(edit && marked(applied(text, edit), edit.selFrom, edit.selTo), vector.expect, vector.name);
  if (edit) assert.ok(edit.from === edit.to || edit.insert[0] !== text[edit.from], `${vector.name}: the replacement starts where the text differs`);
};

test('Move up and Move down trade an item with its sibling', () => {
  for (const vector of vectors.move) {
    const { text, from, to } = unmark(vector.text);
    const edit = moveItemEdit(text, vector.line, vector.direction, from, to);
    plays(vector, edit);
    if (edit) assert.equal(edit.line, vector.expectLine, `${vector.name}: the line it is on`);
  }
});

test('the places where a dragged item may land', () => {
  for (const vector of vectors.slots) {
    assert.deepEqual(dropSlots(vector.text, vector.line).map((slot) => [slot.before, slot.minLevel, slot.maxLevel]), vector.expect, vector.name);
  }
});

test('dropping a dragged item', () => {
  for (const vector of vectors.drop) {
    const { text, from, to } = unmark(vector.text);
    const edit = dropItemEdit(text, vector.line, vector.before, vector.level, from, to);
    plays(vector, edit);
    if (edit) assert.equal(edit.line, vector.expectLine, `${vector.name}: the line it is on`);
  }
});

test('deleting an item with what is under it', () => {
  for (const vector of vectors.delete) {
    const { text, from, to } = unmark(vector.text);
    const edit = deleteItemEdit(text, vector.line, from, to);
    plays(vector, edit);
    if (edit) assert.equal(edit.count, vector.expectCount, `${vector.name}: the sub-items that went along`);
  }
});

test('an item: its lines, the sub-items under it and its place among its siblings', () => {
  for (const vector of vectors.span) {
    const span = itemSpan(vector.text, vector.line);
    assert.deepEqual(span && [span.line, span.end, span.count, span.place, span.of], vector.expect, vector.name);
  }
});

test('the menu of a note: Uncheck all items and Delete checked items', () => {
  for (const [kind, change] of [['uncheckAll', uncheckAllEdit], ['deleteChecked', deleteCheckedEdit]]) {
    for (const vector of vectors[kind]) {
      const { text, from, to } = unmark(vector.text);
      const edit = change(text, from, to);
      plays(vector, edit);
      if (edit) assert.equal(edit.count, vector.expectCount, `${vector.name}: the number of tasks`);
    }
  }
});

test('pasting several lines in a list item', () => {
  for (const vector of vectors.paste) {
    const { text, from, to } = unmark(vector.text);
    plays(vector, pasteLinesEdit(text, from, to, vector.pasted));
  }
});

// --- The ticked end of a list and "+ List item" (design checklists-77-v2, part 6) -----------------------------------

test('the ticked end of a list', () => {
  for (const vector of vectors.tail) assert.deepEqual(checkedTail(vector.text).map((tail) => [tail.from, tail.to, tail.count]), vector.expect, vector.name);
});

test('"+ List item" puts an empty task under the open tasks of a list', () => {
  for (const vector of vectors.addItem) {
    const edit = addItemEdit(vector.text, vector.line);
    assert.equal(edit && marked(applied(vector.text, edit), edit.selFrom, edit.selTo), vector.expect, vector.name);
    if (edit) assert.equal(edit.line, vector.expectLine, `${vector.name}: the line it is on`);
  }
});

// Every text with a list that the cases and the real notes hold, for the checks below that try every line of them.
const listTexts = () => [...new Set([...['levels', 'slots', 'span', 'tail', 'addItem'].flatMap((kind) => vectors[kind].map((vector) => vector.text)),
  ...['tick', 'indent', 'move', 'drop', 'delete', 'uncheckAll', 'deleteChecked', 'paste'].flatMap((kind) => vectors[kind].map((vector) => unmark(vector.text).text)),
  ...readdirSync(fixtures).map((name) => readFileSync(new URL(name, fixtures), 'utf8'))])];
const bare = (line) => line.replace(/\r$/, '');
// A line without its indent and, for a numbered line, its number: what stays the same when its item moves.
const words = (line) => bare(line).replace(/^[ \t]*(?:\d+(?=[.)]))?/, '');
const endings = (text) => [text.split('\n').filter((line) => line.endsWith('\r')).length, text.endsWith('\n')];
const label = (text, rest) => `${JSON.stringify(text.slice(0, 40))} ${rest}`;
// The number of lines of the item on a list line: its own line and the lines under it. A line of plain text after the
// note keeps a line in it when the item is all there is.
const itemSize = (text, line) => {
  const padded = `${text}\nEND`;
  return padded.split('\n').length - applied(padded, deleteItemEdit(padded, line)).split('\n').length;
};
const task = (line, level) => (level >= 0 && linePrefix(line).kind === 'task' ? linePrefix(line) : null);
// The text with every open task under a ticked task ticked as well: what ticking a task leaves under it.
const tickedThrough = (text) => {
  const lines = text.split('\n'), levels = listLevels(text), under = new Set();
  lines.forEach((line, index) => {
    if (!task(line, levels[index])?.checked) return;
    for (let other = index + 1, end = itemSpan(text, index).end; other <= end; other++) if (task(lines[other], levels[other])) under.add(other);
  });
  return lines.map((line, index) => (under.has(index) ? line.replace(/\[[ xX]\]/, (box) => (box === '[ ]' ? '[x]' : box)) : line)).join('\n');
};

test('Backspace at a sign takes the whole sign and nothing else: every other line stays, no word is lost, the caret stands in front of the words', () => {
  let joined = 0, unsigned = 0;
  for (const text of [...listTexts(), ...vectors.itemBackspace.map((vector) => unmark(vector.text).text)]) {
    const lines = text.split('\n'), levels = listLevels(text), items = listItems(text);
    let offset = 0;
    lines.forEach((line, index) => {
      const prefix = linePrefix(line), rest = line.slice(prefix.markTo);
      for (let at = 0; at <= bare(line).length; at++) {
        const name = label(text, `line ${index} at ${at}`);
        const edit = itemBackspaceEdit(text, offset + at, []);
        // Exactly in and right behind the sign of a list line.
        assert.equal(Boolean(edit), levels[index] >= 0 && at <= prefix.markTo, `${name}: where the rule holds`);
        if (!edit) continue;
        const after = applied(text, edit).split('\n');
        assert.equal(edit.selFrom, edit.selTo, `${name}: a caret`);
        if (index > 0 && items[index - 1] >= 0) {
          // The line above is of the same list: one line fewer, and the two lines are one, the words behind each other.
          joined++;
          const above = bare(lines[index - 1]), glue = bare(rest) && /^[ \t]*[-*+][ \t]+\[[ xX]\]$/.test(above) ? ' ' : '';
          assert.deepEqual(after, [...lines.slice(0, index - 1), above + glue + rest, ...lines.slice(index + 1)], `${name}: joined`);
          assert.equal(edit.selFrom, offset - lines[index - 1].length - 1 + above.length + glue.length, `${name}: the caret between the words`);
          assert.equal(linePrefix(after[index - 1]).kind, linePrefix(above).kind, `${name}: the line above keeps its sign`);
        } else {
          unsigned++;
          assert.deepEqual(after, [...lines.slice(0, index), rest, ...lines.slice(index + 1)], `${name}: only the sign went`);
          assert.equal(edit.selFrom, offset, `${name}: the caret in front of the words`);
        }
      }
      offset += line.length + 1;
    });
  }
  assert.ok(joined > 2000 && unsigned > 300, `${joined} joins and ${unsigned} first lines were tried`);
});

test('moving trades two whole items: every line keeps its words and level, and the other way gives the text back', () => {
  const signature = (lines, levels) => lines.map((line, index) => `${words(line)}|${levels[index]}`).sort();
  const numbers = (lines) => lines.map((line) => /^[ \t]*(\d+)[.)]/.exec(line)?.[1]).filter(Boolean).sort();
  let moved = 0;
  for (const text of listTexts()) {
    const lines = text.split('\n'), levels = listLevels(text);
    lines.forEach((_, index) => {
      for (const direction of ['up', 'down']) {
        const name = label(text, `line ${index} ${direction}`);
        const edit = moveItemEdit(text, index, direction);
        if (!edit) continue;
        moved++;
        const out = applied(text, edit), after = out.split('\n');
        assert.deepEqual(signature(after, listLevels(out)), signature(lines, levels), `${name}: every line keeps its words and level`);
        assert.deepEqual(numbers(after), numbers(lines), `${name}: the numbers stay in the list`);
        assert.deepEqual(endings(out), endings(text), `${name}: the line endings stay`);
        const back = moveItemEdit(out, edit.line, direction === 'up' ? 'down' : 'up');
        assert.equal(back && applied(out, back), text, `${name}: the other way gives the text back`);
      }
    });
  }
  assert.ok(moved >= 100, `only ${moved} moves were tried`);
});

test('an item passes a sibling with the same text exactly as it passes one with other text', () => {
  let passed = 0;
  for (const text of listTexts()) {
    if (text.includes('\r')) continue;
    const lines = text.split('\n'), owners = listItems(text);
    lines.forEach((_, index) => {
      if (owners[index] !== index) return;
      // The item once more right under it, and the same with one letter more: a twin and a sibling that differs.
      const size = itemSize(text, index), block = lines.slice(index, index + size);
      const build = (first) => [...lines.slice(0, index + size), first, ...block.slice(1), ...lines.slice(index + size)].join('\n');
      const twin = build(block[0]), other = build(`${block[0]}Z`);
      if (listLevels(twin).join() !== listLevels(other).join()) return;
      const caret = lines.slice(0, index).join('\n').length + (index ? 1 : 0), below = caret + block.join('\n').length + 1;
      for (const [direction, line, at] of [['down', index, caret], ['up', index + size, below]]) {
        const name = label(text, `line ${index} ${direction}`);
        const edit = moveItemEdit(twin, line, direction, at), unlike = moveItemEdit(other, line, direction, at);
        assert.equal(Boolean(edit), Boolean(unlike), `${name}: it moves when a sibling with other text would`);
        if (!edit) continue;
        passed++;
        assert.equal(applied(twin, edit), twin, `${name}: the text stays as it is`);
        assert.deepEqual([edit.from, edit.to, edit.insert], [twin.length, twin.length, ''], `${name}: nothing is replaced`);
        assert.equal(edit.line, unlike.line, `${name}: the line the item is on`);
        const start = direction === 'down' ? below : caret;
        assert.deepEqual([edit.selFrom, edit.selTo], [start, start], `${name}: the caret went along to the start of the other one`);
      }
    });
  }
  assert.ok(passed >= 300, `only ${passed} twins were passed`);
});

test('a drop puts the item on the level asked for and leaves every other line as it is', () => {
  let drops = 0, refused = 0, returned = 0;
  for (const text of listTexts()) {
    const lines = text.split('\n'), levels = listLevels(text);
    lines.forEach((_, index) => {
      const slots = dropSlots(text, index);
      if (levels[index] < 0) { assert.deepEqual(slots, [], label(text, `line ${index}: no list line`)); return; }
      const size = itemSize(text, index);
      assert.ok(slots.some((slot) => slot.before === index && slot.minLevel <= levels[index] && levels[index] <= slot.maxLevel), label(text, `line ${index}: its own place`));
      assert.ok(!slots.some((slot) => slot.before > index && slot.before <= index + size), label(text, `line ${index}: no place in its own lines`));
      for (const slot of slots) {
        assert.ok(slot.minLevel >= 0 && slot.minLevel <= slot.maxLevel, label(text, `line ${index} before ${slot.before}: the levels`));
        for (let level = slot.minLevel - 1; level <= slot.maxLevel + 1; level++) {
          const name = label(text, `line ${index} before ${slot.before} level ${level}`);
          const edit = dropItemEdit(text, index, slot.before, level);
          const own = slot.before === index && level === levels[index];
          if (level < slot.minLevel || level > slot.maxLevel || own) { assert.equal(edit, null, `${name}: nothing to do`); continue; }
          // With mixed indents a place can turn out not to work; then nothing happens.
          if (!edit) { refused++; continue; }
          drops++;
          const out = applied(text, edit), after = out.split('\n'), afterLevels = listLevels(out), at = edit.line;
          assert.equal(at, slot.before <= index ? slot.before : slot.before - size, `${name}: the line it is on`);
          // The same lines in another order: when the last item leaves its list, the blank line above it ends the text.
          assert.deepEqual([after.length, endings(out)[0]], [lines.length, endings(text)[0]], `${name}: the lines and their endings stay`);
          for (let under = 0; under < size; under++) {
            assert.equal(words(after[at + under]), words(lines[index + under]), `${name}: the words of line ${under} of the item`);
            assert.equal(afterLevels[at + under], levels[index + under] < 0 ? -1 : levels[index + under] + level - levels[index], `${name}: the level of line ${under} of the item`);
          }
          const others = (all, depth, from) => all.map((line, i) => `${bare(line)}|${depth[i]}`).filter((_, i) => i < from || i >= from + size);
          assert.deepEqual(others(after, afterLevels, at), others(lines, levels, index), `${name}: the other lines`);
          // Back to its own place and level: the same words on the same levels (an indent may be written another way).
          const back = dropItemEdit(out, at, index <= at ? index : index + size, levels[index]);
          if (!back) continue;
          returned++;
          const restored = applied(out, back);
          assert.equal(back.line, index, `${name}: back on its line`);
          assert.deepEqual(restored.split('\n').map(words), lines.map(words), `${name}: back gives the words back`);
          assert.deepEqual(listLevels(restored), levels, `${name}: back gives the levels back`);
        }
      }
    });
  }
  assert.ok(drops >= 1000, `only ${drops} drops were tried`);
  assert.ok(returned >= drops / 2, `only ${returned} of ${drops} drops were taken back`);
  assert.ok(refused * 20 < drops, `${refused} places of ${drops} did not work`);
});

test('deleting takes the lines of one item away and leaves the other lines as they are', () => {
  let deleted = 0;
  for (const text of listTexts()) {
    const lines = text.split('\n'), levels = listLevels(text);
    lines.forEach((_, index) => {
      const name = label(text, `line ${index}`);
      const edit = deleteItemEdit(text, index);
      if (!edit) { assert.ok(levels[index] < 0, `${name}: a list line can be deleted`); return; }
      deleted++;
      const out = applied(text, edit);
      // An empty text is no lines at all, or the one empty line that was left.
      const fits = [out.split('\n'), ...(out ? [] : [[]])].some((after) => {
        const gone = lines.length - after.length;
        let from = 0;
        while (from < after.length && bare(after[from]) === bare(lines[from])) from++;
        from = Math.min(from, index);
        const rest = lines.filter((_, i) => i < from || i >= from + gone);
        return gone > 0 && from <= index && index < from + gone && levels[from] >= 0
          && rest.every((line, i) => bare(line) === bare(after[i]))
          && edit.count === levels.slice(from + 1, from + gone).filter((level) => level >= 0).length
          && (!out || listLevels(out).join() === levels.filter((_, i) => i < from || i >= from + gone).join());
      });
      assert.ok(fits, `${name}: one item went, with ${edit.count} sub-items: ${JSON.stringify(out)}`);
    });
  }
  assert.ok(deleted >= 300, `only ${deleted} items were deleted`);
});

test('an item is the lines a delete takes away, and a move takes it one place up or down', () => {
  let items = 0, moved = 0;
  for (const text of listTexts()) {
    const lines = text.split('\n'), owners = listItems(text), levels = listLevels(text);
    lines.forEach((_, index) => {
      const name = label(text, `line ${index}`);
      const span = itemSpan(text, index);
      if (owners[index] < 0) { assert.equal(span, null, `${name}: no item`); return; }
      items++;
      assert.equal(span.line, owners[index], `${name}: its own line`);
      assert.equal(span.end - span.line + 1, itemSize(text, index), `${name}: the lines a delete takes away`);
      assert.equal(span.count, deleteItemEdit(text, index).count, `${name}: the sub-items a delete counts`);
      assert.ok(span.place >= 1 && span.place <= span.of, `${name}: its place is one of its siblings'`);
      // Every line of the item, more text and sub-items alike, lies in it; a sub-item is a smaller item inside it.
      for (let under = span.line; under <= span.end; under++) {
        const inner = itemSpan(text, under);
        assert.ok(inner.line >= span.line && inner.end <= span.end, `${name}: line ${under} lies in the item`);
        if (levels[under] < 0) assert.ok(inner.line < under, `${name}: more text on line ${under} gives the item above it`);
      }
      for (const direction of ['up', 'down']) {
        const edit = moveItemEdit(text, index, direction);
        if (!edit) continue;
        moved++;
        const after = itemSpan(applied(text, edit), edit.line);
        assert.deepEqual([after.place, after.of, after.count], [span.place + (direction === 'up' ? -1 : 1), span.of, span.count], `${name} ${direction}: one place further, with what is under it`);
      }
    });
  }
  assert.ok(items >= 300 && moved >= 100, `only ${items} items and ${moved} moves were tried`);
});

test('Uncheck all items empties every box and changes nothing else; ticking them again gives the text back', () => {
  let unticked = 0;
  for (const text of listTexts()) {
    const lines = text.split('\n'), levels = listLevels(text);
    const ticked = lines.map((_, index) => index).filter((index) => task(lines[index], levels[index])?.checked);
    const edit = uncheckAllEdit(text), name = label(text, 'uncheck all');
    if (!ticked.length) { assert.equal(edit, null, name); continue; }
    unticked += ticked.length;
    assert.equal(edit.count, ticked.length, `${name}: the number of tasks`);
    let out = applied(text, edit);
    assert.deepEqual(out.split('\n'), lines.map((line, index) => (ticked.includes(index) ? line.replace(/\[[xX]\]/, '[ ]') : line)), `${name}: only the boxes`);
    assert.equal(uncheckAllEdit(out), null, `${name}: nothing is left to untick`);
    // Ticked again from the bottom up, the text is back, but for the tasks under a ticked task: a tick takes those along.
    for (const index of [...ticked].reverse()) out = applied(out, tickEdit(out, index, false));
    assert.equal(out, tickedThrough(text).split('\n').map((line, index) => (ticked.includes(index) ? line.replace('[X]', '[x]') : line)).join('\n'), `${name}: ticked again`);
  }
  assert.ok(unticked >= 40, `only ${unticked} tasks were unticked`);
});

test('Delete checked items takes ticked tasks only, never an open task, and leaves nothing to do', () => {
  let gone = 0;
  for (const text of listTexts()) {
    const lines = text.split('\n'), levels = listLevels(text), name = label(text, 'delete checked');
    const open = (all, depth) => all.filter((line, index) => task(line, depth[index])?.checked === false).map(bare);
    const ticked = (all, depth) => all.filter((line, index) => task(line, depth[index])?.checked).length;
    const edit = deleteCheckedEdit(text);
    if (!edit) {
      // Every ticked task has an open task under it.
      lines.forEach((line, index) => {
        if (!task(line, levels[index])?.checked) return;
        const size = itemSize(text, index);
        assert.ok(lines.slice(index + 1, index + size).some((under, i) => task(under, levels[index + 1 + i])?.checked === false), `${name}: line ${index} stays for an open task`);
      });
      continue;
    }
    const out = applied(text, edit), after = out ? out.split('\n') : [], afterLevels = out ? listLevels(out) : [];
    gone += edit.count;
    assert.deepEqual(open(after, afterLevels), open(lines, levels), `${name}: every open task stays`);
    assert.equal(edit.count, ticked(lines, levels) - ticked(after, afterLevels), `${name}: the number of tasks`);
    assert.ok(edit.count > 0, name);
    // What is left is the old text with lines taken out, each still on its level.
    let at = 0;
    const kept = [];
    lines.forEach((line, index) => { if (at < after.length && bare(after[at]) === bare(line) && afterLevels[at] === levels[index]) { kept.push(index); at++; } });
    assert.equal(at, after.length, `${name}: only whole lines went`);
    assert.equal(deleteCheckedEdit(out), null, `${name}: nothing is left to delete`);
  }
  assert.ok(gone >= 40, `only ${gone} tasks were deleted`);
});

test('pasting lines in a list item adds items on the level of that item and changes no other line', () => {
  const pasted = 'one\n\n- [x] two\r\n  3. three\n';
  let pastes = 0;
  for (const text of listTexts()) {
    const lines = text.split('\n'), levels = listLevels(text);
    let offset = 0;
    lines.forEach((line, index) => {
      const caret = offset + bare(line).length, name = label(text, `line ${index}`);
      offset += line.length + 1;
      const edit = pasteLinesEdit(text, caret, caret, pasted);
      assert.equal(Boolean(edit), levels[index] >= 0, `${name}: only in a list item`);
      if (!edit) return;
      pastes++;
      const out = applied(text, edit), after = out.split('\n'), afterLevels = listLevels(out);
      const others = (all, from, count) => [...all.slice(0, from), ...all.slice(from + count)];
      assert.deepEqual(others(after, index, 3), others(lines, index, 1), `${name}: the other lines`);
      assert.deepEqual(others(afterLevels, index + 1, 2), levels, `${name}: the levels of the old lines`);
      assert.deepEqual(afterLevels.slice(index + 1, index + 3), [levels[index], levels[index]], `${name}: the new items are on its level`);
      assert.deepEqual(after.slice(index, index + 3).map((value) => value.endsWith('\r')), [line.endsWith('\r'), line.endsWith('\r'), line.endsWith('\r')], `${name}: the line endings`);
      assert.equal(bare(after[index]), `${bare(line)}one`, `${name}: the first line lands at the caret`);
      assert.ok(bare(after[index + 1]).endsWith(' [x] two') && /^[ \t]*(?:[-*+]|\d+[.)]) (?:\[ \] )?three$/.test(bare(after[index + 2])), `${name}: the new items: ${JSON.stringify(after.slice(index, index + 3))}`);
      assert.ok(edit.selFrom === edit.selTo && out.slice(0, edit.selFrom).endsWith('three'), `${name}: the caret is behind the last pasted line`);
    });
  }
  assert.ok(pastes >= 300, `only ${pastes} pastes were tried`);
});

// The main items of the list a line is in, each as { line, end, done }: done is a ticked task with no open task in its
// lines. Found with itemSpan and listLevels alone, to hold checkedTail and tickEdit against.
const mainItems = (text, line) => {
  const lines = text.split('\n'), owners = listItems(text), levels = listLevels(text), items = [];
  let first = line;
  while (first > 0 && owners[first - 1] >= 0) first--;
  for (let index = first; index < lines.length && owners[index] >= 0; index++) {
    if (levels[index] !== 0) continue;
    const end = itemSpan(text, index).end, boxes = [];
    for (let under = index; under <= end; under++) if (task(lines[under], levels[under])) boxes.push(task(lines[under], levels[under]).checked);
    items.push({ line: index, end, done: Boolean(task(lines[index], 0)?.checked) && boxes.every(Boolean), tasks: boxes.length });
  }
  return items;
};

test('the ticked end is the done main items at the end of a list, with every line under them', () => {
  let tails = 0, lists = 0;
  for (const text of listTexts()) {
    const lines = text.split('\n'), owners = listItems(text), found = checkedTail(text), name = label(text, 'ticked end');
    const want = [];
    lines.forEach((_, index) => {
      // The first line of a list: the line above it is in no list.
      if (owners[index] < 0 || (index > 0 && owners[index - 1] >= 0)) return;
      lists++;
      const items = mainItems(text, index);
      let from = items.length;
      while (from > 0 && items[from - 1].done) from--;
      if (from < items.length) want.push({ from: items[from].line, to: items.at(-1).end, count: items.slice(from).reduce((sum, item) => sum + item.tasks, 0) });
    });
    assert.deepEqual(found, want, name);
    tails += found.length;
    for (const tail of found) {
      assert.ok(tail.to + 1 >= lines.length || owners[tail.to + 1] < 0, `${name}: it runs to the end of its list`);
      assert.ok(tail.count >= 1 && tail.count <= tail.to - tail.from + 1, `${name}: the number of tasks`);
    }
  }
  assert.ok(tails >= 40 && lists >= 150, `only ${tails} ticked ends in ${lists} lists`);
});

test('with moving, a ticked main task lands in the ticked end of its list and an unticked one right above it', () => {
  let landed = 0, back = 0, kept = 0;
  for (const text of listTexts()) {
    const lines = text.split('\n'), levels = listLevels(text);
    lines.forEach((line, index) => {
      const box = task(line, levels[index]);
      if (!box || levels[index] !== 0) return;
      const name = label(text, `line ${index}`), items = mainItems(text, index), own = items.findIndex((item) => item.line === index);
      const edit = tickEdit(text, index, true), out = applied(text, edit), tail = checkedTail(out).find((range) => range.from <= edit.line && edit.line <= range.to);
      if (box.checked) {
        // Unticked: it is in no ticked end, and when a done task stood above it, the ticked end starts right under it.
        assert.equal(tail, undefined, `${name}: an open task is in no ticked end`);
        const first = items.slice(0, own).find((item) => item.done);
        if (!first || edit.line === index) return;
        back++;
        assert.equal(edit.line, first.line, `${name}: it stands where the first done task stood`);
        if (items.slice(own + 1).every((item) => item.done) && items.slice(items.indexOf(first), own).every((item) => item.done)) {
          assert.equal(checkedTail(out).find((range) => range.to === items.at(-1).end)?.from, itemSpan(out, edit.line).end + 1, `${name}: the ticked end starts right under it`);
        }
        return;
      }
      // Ticked: every main item under it that is not done is a task it moves past, unless a bullet or a numbered line
      // stands there (those stay where they are) or mixed indents keep it in place.
      const below = items.slice(own + 1), open = below.filter((item) => !item.done);
      if (open.some((item) => !task(lines[item.line], 0))) return;
      if (open.length && edit.line === index) { kept++; return; }
      landed++;
      assert.ok(tail, `${name}: it is in the ticked end`);
      // Moved, it stands right under the last item that is not done: it is the first of the ticked end.
      if (open.length) assert.equal(tail.from, edit.line, `${name}: it is the first of the ticked end`);
    });
  }
  assert.ok(landed >= 100 && back >= 15, `only ${landed} ticks landed in a ticked end and ${back} unticks went back`);
  assert.ok(kept * 10 < landed, `${kept} ticks of ${landed} could not move`);
});

test('"+ List item" adds one line, an empty task on the main level, right in front of the ticked end or at the end of its list', () => {
  let added = 0, inFront = 0, atEnd = 0;
  for (const text of listTexts()) {
    const lines = text.split('\n'), owners = listItems(text), levels = listLevels(text), tails = checkedTail(text);
    for (let index = -1; index <= lines.length; index++) {
      const name = label(text, `line ${index}`), edit = addItemEdit(text, index);
      if (!(owners[index] >= 0)) { assert.equal(edit, null, `${name}: no list`); continue; }
      added++;
      const out = applied(text, edit), after = out.split('\n'), at = edit.line;
      assert.deepEqual([edit.to, edit.selFrom], [edit.from, edit.selTo], `${name}: a line is put in and the caret is a caret`);
      assert.deepEqual([...after.slice(0, at), ...after.slice(at + 1)].map(bare), lines.map(bare), `${name}: the other lines`);
      assert.match(bare(after[at]), /^[ \t]*[-*+] \[ \] $/, `${name}: an empty task`);
      const afterLevels = listLevels(out);
      assert.equal(afterLevels[at], 0, `${name}: on the main level`);
      assert.deepEqual([...afterLevels.slice(0, at), ...afterLevels.slice(at + 1)], levels, `${name}: the levels of the other lines`);
      assert.equal(out.slice(0, edit.selFrom).split('\n').length - 1, at, `${name}: the caret is on the new line`);
      assert.ok(out.slice(edit.selFrom).startsWith('\n') || out.slice(edit.selFrom).startsWith('\r\n') || edit.selFrom === out.length, `${name}: the caret is at its end`);
      // The line endings: a CRLF text stays CRLF, and the text ends as it ended.
      const crs = (all) => all.filter((value) => value.endsWith('\r')).length;
      assert.ok(crs(after) === crs(lines) || crs(after) === crs(lines) + 1, `${name}: the line endings`);
      if (crs(lines) === lines.length - 1 && lines.length > 1) assert.equal(crs(after), after.length - 1, `${name}: a CRLF text stays CRLF`);
      if (!crs(lines)) assert.equal(crs(after), 0, `${name}: no \\r comes in`);
      assert.equal(out.endsWith('\n'), text.endsWith('\n'), `${name}: the end of the text`);
      // Its place: the first line of the ticked end of its list, which starts right under it now; with none, the last of its list.
      let last = index;
      while (last + 1 < lines.length && owners[last + 1] >= 0) last++;
      const tail = tails.find((range) => range.to === last), moved = checkedTail(out);
      if (tail) {
        inFront++;
        assert.equal(at, tail.from, `${name}: in front of the ticked end`);
        assert.ok(moved.some((range) => range.from === tail.from + 1 && range.to === tail.to + 1 && range.count === tail.count), `${name}: the ticked end is as it was, one line down`);
      } else {
        atEnd++;
        assert.equal(at, last + 1, `${name}: after the last line of its list`);
        assert.ok(at + 1 >= after.length || listItems(out)[at + 1] < 0, `${name}: it is the last of its list`);
      }
      assert.equal(moved.length, tails.length, `${name}: no ticked end comes or goes`);
      // Asked again from the new line, the next one lands right under it.
      const again = addItemEdit(out, at);
      assert.equal(again.line, at + 1, `${name}: the next one lands under it`);
    }
  }
  assert.ok(added >= 300 && inFront >= 60 && atEnd >= 150, `only ${added} items were added, ${inFront} in front of a ticked end and ${atEnd} at the end of a list`);
});

test('real note: every move and drop can be taken back byte for byte, and so can unticking', () => {
  const text = readFileSync(new URL('checklists.md', fixtures), 'utf8');
  const lines = text.split('\n'), levels = listLevels(text);
  let moves = 0, drops = 0;
  lines.forEach((_, index) => {
    for (const direction of ['up', 'down']) {
      const edit = moveItemEdit(text, index, direction);
      if (!edit) continue;
      moves++;
      const out = applied(text, edit);
      assert.notEqual(out, text);
      assert.equal(applied(out, moveItemEdit(out, edit.line, direction === 'up' ? 'down' : 'up')), text, `line ${index} ${direction} and back`);
    }
    if (levels[index] < 0) return;
    const size = itemSize(text, index);
    for (const slot of dropSlots(text, index)) {
      for (let level = slot.minLevel; level <= slot.maxLevel; level++) {
        const name = `line ${index} before ${slot.before} level ${level}`;
        const edit = dropItemEdit(text, index, slot.before, level);
        if (slot.before === index && level === levels[index]) { assert.equal(edit, null, name); continue; }
        assert.ok(edit, `${name}: every place works in a note with tidy indents`);
        drops++;
        const out = applied(text, edit);
        const back = dropItemEdit(out, edit.line, index <= edit.line ? index : index + size, levels[index]);
        assert.equal(back && applied(out, back), text, `${name} and back`);
        // Deleting the item where it landed leaves the same note as deleting it where it was.
        assert.equal(applied(out, deleteItemEdit(out, edit.line)), applied(text, deleteItemEdit(text, index)), `${name}: the note without the item`);
      }
    }
  });
  assert.ok(moves >= 20 && drops >= 300, `${moves} moves and ${drops} drops were tried`);
  // Unticking all and ticking again from the bottom up: the note is back, with the open tasks under a ticked task ticked.
  let out = applied(text, uncheckAllEdit(text));
  for (let index = lines.length - 1; index >= 0; index--) if (task(lines[index], levels[index])?.checked) out = applied(out, tickEdit(out, index, false));
  assert.equal(out, tickedThrough(text));
  assert.notEqual(tickedThrough(text), text, 'the note holds a ticked task with an open task under it');
});

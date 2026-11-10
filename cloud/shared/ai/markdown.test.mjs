import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, plainMarkdown } from './markdown.mjs';

// The same cases as the Android check (android/checks/AiCheck.kt, markdown()): a span is written as its text plus
// |b (bold), |i (italic), |c (code), so a failing case on one side reads the same as on the other.
const mark = (span) => span.text + (span.bold ? '|b' : '') + (span.italic ? '|i' : '') + (span.code ? '|c' : '');
const blocks = (text) => parseMarkdown(text).map((block) => [block.kind, block.level, block.spans.map(mark)]);
const spans = (text) => {
  const all = blocks(text);
  assert.equal(all.length, 1, `one block for ${JSON.stringify(text)}`);
  return all[0][2];
};
const b = (kind, level, ...parts) => [kind, level, parts];

test('inline marks', () => {
  assert.deepEqual(spans('Plain text'), ['Plain text']);
  assert.deepEqual(spans('A **bold** word'), ['A ', 'bold|b', ' word']);
  assert.deepEqual(spans('A __bold__ word'), ['A ', 'bold|b', ' word']);
  assert.deepEqual(spans('An *italic* word'), ['An ', 'italic|i', ' word']);
  assert.deepEqual(spans('An _italic_ word'), ['An ', 'italic|i', ' word']);
  assert.deepEqual(spans('Use `code` here'), ['Use ', 'code|c', ' here']);
  assert.deepEqual(spans('**bold and *both* here**'), ['bold and |b', 'both|b|i', ' here|b']);
  assert.deepEqual(spans('`**not bold**`'), ['**not bold**|c']);
  assert.deepEqual(spans('**AI testnotitie**'), ['AI testnotitie|b']);
});

test('marks that must stay as typed', () => {
  assert.deepEqual(spans('snake_case_name and 2*3*4'), ['snake_case_name and 2*3*4']);
  assert.deepEqual(spans('a * b * c and ** x'), ['a * b * c and ** x']);
  assert.deepEqual(spans('Unclosed **bold and `code'), ['Unclosed **bold and `code']);
  assert.deepEqual(spans('<b>html</b> [link](http://x.y)'), ['<b>html</b> [link](http://x.y)']);
});

test('headings, bullets and tasks', () => {
  assert.deepEqual(blocks('# Title\n## Smaller\n###### Last\n####### seven'), [
    b('heading', 1, 'Title|b'), b('heading', 2, 'Smaller|b'), b('heading', 6, 'Last|b'), b('paragraph', 0, '####### seven'),
  ]);
  assert.deepEqual(blocks('-no space\n- one\n* two *x*\n+ three\n  - nested\n- [ ] open\n- [x] done'), [
    b('paragraph', 0, '-no space'), b('bullet', 0, 'one'), b('bullet', 0, 'two ', 'x|i'), b('bullet', 0, 'three'),
    b('bullet', 1, 'nested'), b('bullet', 0, '☐ open'), b('bullet', 0, '☑ done'),
  ]);
});

test('blank lines, code blocks, numbers, empty', () => {
  assert.deepEqual(blocks('Line one\n\n\n\nLine two\n'), [b('paragraph', 0, 'Line one'), b('space', 0), b('paragraph', 0, 'Line two')]);
  assert.deepEqual(blocks('```kotlin\nval a = **1**\n\n  indented\n```\nafter'), [
    b('code', 0, 'val a = **1**|c'), b('code', 0, '|c'), b('code', 0, '  indented|c'), b('paragraph', 0, 'after'),
  ]);
  assert.deepEqual(blocks('```\nnever closed'), [b('code', 0, 'never closed|c')]);
  assert.deepEqual(blocks('1. first\r\n2. second\r\n'), [b('paragraph', 0, '1. first'), b('paragraph', 0, '2. second')]);
  assert.equal(blocks('').length, 0);
});

test('plain text is the answer without its marks', () => {
  assert.equal(plainMarkdown('# T\n**a** and *b*\n- c'), 'T\na and b\nc');
});

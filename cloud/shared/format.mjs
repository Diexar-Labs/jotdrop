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

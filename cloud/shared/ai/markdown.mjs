// The little Markdown that Ask JotDrop's answer shows nicely: bold, italic, `code`, # headings, - or * bullets (with
// [ ] and [x]) and ``` code blocks. Nothing else is interpreted: no HTML, and links stay as typed, so nothing opens
// by itself. This is the same rule as android/.../AiMarkdown.kt (10 Nov 2026: the answer showed **AI testnotitie**
// with its stars); markdown.test.mjs holds the same cases as the Android check. Pure functions: the page turns the
// blocks into elements with textContent, never innerHTML.
//
// A block is { kind: 'paragraph' | 'heading' | 'bullet' | 'code' | 'space', level, spans }.
// level is the heading size (1 to 6) or how far a bullet is indented (0 to 3).
// A span is { text, bold, italic, code }.

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const BULLET = /^([ \t]*)[-*+][ \t]+(.*)$/;
const TASK = /^\[([ xX])\][ \t]+(.*)$/;
const FENCE = /^[ \t]*```/;
const OPEN_BOX = '☐';
const DONE_BOX = '☑';
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

export function parseMarkdown(text) {
  const out = [];
  let inCode = false;
  for (const line of String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    if (FENCE.test(line)) { inCode = !inCode; continue; }
    if (inCode) { out.push({ kind: 'code', level: 0, spans: [{ text: line, bold: false, italic: false, code: true }] }); continue; }
    if (!line.trim()) {
      if (out.length && out[out.length - 1].kind !== 'space') out.push({ kind: 'space', level: 0, spans: [] });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ kind: 'heading', level: heading[1].length, spans: inline(heading[2]).map((span) => ({ ...span, bold: true })) });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      const level = Math.min(3, Math.floor(bullet[1].replace(/\t/g, '  ').length / 2));
      const task = TASK.exec(bullet[2]);
      const content = task ? `${task[1] === ' ' ? OPEN_BOX : DONE_BOX} ${task[2]}` : bullet[2];
      out.push({ kind: 'bullet', level, spans: inline(content) });
      continue;
    }
    out.push({ kind: 'paragraph', level: 0, spans: inline(line.trim()) });
  }
  while (out.length && out[out.length - 1].kind === 'space') out.pop();
  return out;
}

// The answer without its marks, one line per block (a blank-line block gives an empty part, as on Android).
export function plainMarkdown(text) {
  return parseMarkdown(text).map((block) => block.spans.map((span) => span.text).join('')).join('\n');
}

function inline(text) {
  const out = [];
  run(text, false, false, out);
  return out;
}

function run(s, bold, italic, out) {
  let plain = '';
  const flush = () => {
    if (plain) { out.push({ text: plain, bold, italic, code: false }); plain = ''; }
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush();
        out.push({ text: s.slice(i + 1, j), bold, italic, code: true });
        i = j + 1;
        continue;
      }
    } else if (c === '*' || c === '_') {
      const double = i + 1 < s.length && s[i + 1] === c;
      const mark = double ? c + c : c;
      const end = closing(s, i, mark);
      if (end > 0) {
        flush();
        run(s.slice(i + mark.length, end), bold || double, italic || !double, out);
        i = end + mark.length;
        continue;
      }
    }
    plain += c;
    i += 1;
  }
  flush();
}

// Where the mark opened at `open` closes, or -1. A mark opens after a non-letter and before a non-space, and closes
// after a non-space and before a non-letter, so snake_case_names, 2*3*4 and "a * b" stay as typed.
function closing(s, open, mark) {
  if (open > 0 && LETTER_OR_DIGIT.test(s[open - 1])) return -1;
  const after = open + mark.length;
  if (after >= s.length || SPACE.test(s[after])) return -1;
  let from = after + 1;
  while (from < s.length) {
    const k = s.indexOf(mark, from);
    if (k < 0) return -1;
    // Looking for a single mark: step over a doubled one (bold inside italic).
    if (mark.length === 1 && k + 1 < s.length && s[k + 1] === mark[0]) { from = k + 2; continue; }
    const next = k + mark.length;
    if (!SPACE.test(s[k - 1]) && (next >= s.length || !LETTER_OR_DIGIT.test(s[next]))) return k;
    from = k + 1;
  }
  return -1;
}

// What changed between two versions of a note, line by line. Runs on the device: the server cannot read notes.
const MAX_CELLS = 4_000_000;

const split = (text) => text.replace(/\r\n/g, '\n').split('\n');

/** Lines of `{ type: 'same' | 'added' | 'removed', text }`, or null when a note is too long to compare here. */
export function diffLines(before, after) {
  const a = split(before), b = split(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const rows = endA - start, columns = endB - start;
  if ((rows + 1) * (columns + 1) > MAX_CELLS) return null;
  const width = columns + 1, lengths = new Uint32Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      lengths[row * width + column] = a[start + row] === b[start + column]
        ? lengths[(row + 1) * width + column + 1] + 1
        : Math.max(lengths[(row + 1) * width + column], lengths[row * width + column + 1]);
    }
  }
  const lines = a.slice(0, start).map((text) => ({ type: 'same', text }));
  let row = 0, column = 0;
  while (row < rows || column < columns) {
    if (row < rows && column < columns && a[start + row] === b[start + column]) {
      lines.push({ type: 'same', text: a[start + row] });
      row++; column++;
    } else if (row < rows && (column === columns || lengths[(row + 1) * width + column] >= lengths[row * width + column + 1])) {
      lines.push({ type: 'removed', text: a[start + row++] });
    } else {
      lines.push({ type: 'added', text: b[start + column++] });
    }
  }
  return lines.concat(a.slice(endA).map((text) => ({ type: 'same', text })));
}

/** Keeps a few lines around each change and folds the rest into `{ type: 'gap', count }`. */
export function foldUnchanged(lines, around = 2) {
  const keep = new Set();
  lines.forEach((line, index) => {
    if (line.type === 'same') return;
    for (let near = index - around; near <= index + around; near++) keep.add(near);
  });
  const folded = [];
  let gap = 0;
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      if (gap) folded.push({ type: 'gap', count: gap });
      gap = 0;
      folded.push(line);
    } else gap++;
  });
  if (gap) folded.push({ type: 'gap', count: gap });
  return folded;
}

// Random but repeatable notes for the merge checks: merge.test.mjs tests the rules on them, and
// scripts/check-cloud-android.mjs has Android merge them to the same bytes.

// Few different lines, so equal lines and equal changes on both sides come up all the time.
const words = ['- [ ] milk', '- [x] milk', '- [ ] eggs', '- [ ] bread', '', 'café', '📝', '# Title', 'Text'];

function change(lines, next) {
  const result = [...lines];
  for (let steps = next(4); steps >= 0; steps--) {
    const at = next(result.length + 1), kind = next(4);
    if (kind === 0 || !result.length) result.splice(at, 0, words[next(words.length)]);
    else if (at < result.length && kind === 1) result[at] = words[next(words.length)];
    else if (at < result.length && kind === 2) result.splice(at, 1);
    else if (at < result.length) result.splice(next(result.length), 0, result.splice(at, 1)[0]);
  }
  return result.join('\n');
}

export function randomCases(count) {
  let seed = 20261031;
  const next = (limit) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor((seed / 4294967296) * limit); };
  const cases = [];
  for (let n = 0; n < count; n++) {
    const lines = Array.from({ length: next(12) }, () => words[next(words.length)]);
    cases.push({ name: `random ${n}`, base: lines.join('\n'), local: change(lines, next), cloud: change(lines, next) });
  }
  return cases;
}

/** Under the 1 MB merge limit but 300,000 lines, with one change on each side: still an ordinary merge. */
export function longCase() {
  const lines = Array.from({ length: 300000 }, () => 'x');
  const changed = (at) => { const copy = [...lines]; copy[at] = 'y'; return copy.join('\n'); };
  return { name: 'a very long note', base: lines.join('\n'), local: changed(10), cloud: changed(299990) };
}

/** Too much changed on one side to compare: both versions stay, on JavaScript and Android alike. */
export function hugeCase() {
  const lines = (word) => Array.from({ length: 1100 }, (_, n) => `${word} ${n}`).join('\n');
  return { name: 'too much changed to compare', base: lines('base'), local: lines('local'), cloud: `${lines('base')}\nOne more line` };
}

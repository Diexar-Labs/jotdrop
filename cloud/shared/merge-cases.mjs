// Random but repeatable notes and dragged lists for the merge checks: merge.test.mjs tests the rules on them, and
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

/**
 * A list where one device drags a task while the other ticks that task or drags it somewhere else, for every task and
 * every place. `merged` is the note the merge must give. It is left out where two neighbours changed places on a
 * device: which of the two moved cannot be told there, so the task may stand where either device put it.
 */
export function dragCases() {
  const words = ['milk', 'eggs', 'bread', 'cheese', 'tea', 'rice', 'salt'];
  const list = (tasks) => tasks.map((word) => `- [ ] ${word}`).join('\n') + '\n';
  const move = (from, to) => { const moved = [...words]; moved.splice(to, 0, moved.splice(from, 1)[0]); return moved; };
  const base = list(words), cases = [];
  for (let from = 0; from < words.length; from++) for (let to = 0; to < words.length; to++) {
    if (to === from) continue;
    const dragged = list(move(from, to)), tick = (text) => text.replace(`[ ] ${words[from]}`, `[x] ${words[from]}`);
    cases.push({ name: `task ${from} dragged to ${to} here and ticked there`, base, local: dragged, cloud: tick(base), merged: tick(dragged) });
    cases.push({ name: `task ${from} ticked here and dragged to ${to} there`, base, local: tick(base), cloud: dragged, merged: tick(dragged) });
    for (let other = 0; other < words.length; other++) {
      if (other === from || other === to) continue;
      const item = { name: `task ${from} dragged to ${to} here and to ${other} there`, base, local: dragged, cloud: list(move(from, other)) };
      if (Math.abs(to - from) > 1 && Math.abs(other - from) > 1) item.merged = item.cloud;
      cases.push(item);
    }
  }
  return cases;
}

/**
 * A list where two devices tick the same task, one of them with "Move checked items to the bottom": there the task
 * goes right under the last open task below it. For every task, alone and with every other task ticked as well, on the
 * device where the task stayed or on the one where it moved. `merged` is the note the merge must give: the task once,
 * where the device that moved it has it. Null where both versions stay.
 */
export function tickCases() {
  const open = ['milk', 'eggs', 'bread', 'cheese', 'tea'];
  const base = [...open.map((word) => ({ word })), { word: 'rice', ticked: true }, { word: 'salt', ticked: true }];
  const list = (tasks) => tasks.map(({ word, ticked }) => `- [${ticked ? 'x' : ' '}] ${word}`).join('\n') + '\n';
  const tick = (tasks, word, move) => {
    const at = tasks.findIndex((task) => task.word === word), last = tasks.findLastIndex((task) => !task.ticked);
    const next = tasks.map((task) => task.word === word ? { word, ticked: true } : task);
    if (move && last > at) next.splice(last, 0, next.splice(at, 1)[0]);
    return next;
  };
  const cases = [];
  const both = (name, here, there, merged) => cases.push(
    { name: `${name}, moved here`, base: list(base), local: list(here), cloud: list(there), merged },
    { name: `${name}, moved there`, base: list(base), local: list(there), cloud: list(here), merged });
  for (const [at, word] of open.entries()) {
    const moved = tick(base, word, true), stayed = tick(base, word, false);
    both(`${word} ticked on both devices`, moved, stayed, list(moved));
    for (const [next, other] of open.entries()) {
      if (other === word) continue;
      both(`${word} ticked on both devices, ${other} too where it stayed`, moved, tick(stayed, other, false), list(tick(moved, other, false)));
      // The last two open tasks, ticked from the top down, end up the other way round: line for line that reads as each
      // changed into the other, so which line the task became cannot be told and both versions stay.
      const two = tick(moved, other, true), swapped = at === open.length - 2 && next === open.length - 1;
      both(`${word} ticked on both devices, ${other} too where it moved`, two, stayed, swapped ? null : list(two));
    }
  }
  return cases;
}

/**
 * Lists as two devices leave them, random but repeatable. Each device does one to three things: tick or untick a task
 * (with "Move checked items to the bottom" on or off: ticked, the task goes right under the last open task below it;
 * unticked, right above the first ticked task above it), drag a task, change its words, add a task, delete one. Every
 * task has its own words, so a line that stands once is one task.
 */
export function listCases(count) {
  let seed = 20261123;
  const next = (limit) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor((seed / 4294967296) * limit); };
  const words = ['milk', 'eggs', 'bread', 'cheese', 'tea', 'rice', 'salt', 'jam'];
  const list = (tasks) => tasks.map(({ word, ticked }) => `- [${ticked ? 'x' : ' '}] ${word}`).join('\n') + '\n';
  const act = (from, move, device) => {
    const tasks = from.map((task) => ({ ...task }));
    for (let steps = 1 + next(3), added = 0; steps > 0; steps--) {
      const kind = next(20), at = next(tasks.length), task = tasks[at];
      if (!task || kind >= 17) tasks.splice(next(tasks.length + 1), 0, { word: `new ${device}${added++}` });
      else if (kind >= 15) tasks.splice(at, 1);
      else if (kind >= 13) task.word += '!';
      else if (kind >= 10) tasks.splice(next(tasks.length), 0, tasks.splice(at, 1)[0]);
      else {
        task.ticked = !task.ticked;
        const to = task.ticked ? tasks.findLastIndex((other) => !other.ticked) : tasks.findIndex((other) => other.ticked);
        if (move && (task.ticked ? to > at : to >= 0 && to < at)) tasks.splice(to, 0, tasks.splice(at, 1)[0]);
      }
    }
    return list(tasks);
  };
  const cases = [];
  while (cases.length < count) {
    const size = 3 + next(6), done = next(3), here = next(2) === 1, there = next(2) === 1;
    const tasks = words.slice(0, size).map((word, index) => ({ word, ticked: index >= size - done }));
    const base = list(tasks), local = act(tasks, here, 'a'), cloud = act(tasks, there, 'b');
    if (local !== base && cloud !== base && local !== cloud) cases.push({ name: `list ${cases.length}`, base, local, cloud });
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

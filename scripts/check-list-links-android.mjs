// Android must apply the same list link rules as cloud/shared/list-links.mjs: the shared vectors, random reconcile
// cases computed here, and the sealing of a list and its owner envelope (AAD strings, write proof).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToBase64, decryptEnvelope, encryptEnvelope, generateVaultKey, sha256Hex } from '../cloud/shared/crypto.mjs';
import { allowedGuestChange, applyGuestChanges, reconcile, updateMarks, writeProof } from '../cloud/shared/list-links.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const encoder = new TextEncoder();
const encodeText = (value) => bytesToBase64(encoder.encode(value));
const field = (value) => (value === undefined || value === null ? '-' : encodeText(value));
const flat = (marks) => marks.map((mark) => [encodeText(mark.line), mark.n, encodeText(mark.by), mark.at, mark.added ? 1 : 0].join('|')).join(',');

// A small deterministic generator, so a failing case can be found again.
let seed = 20261104;
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (items) => items[Math.floor(random() * items.length)];
const words = ['milk', 'eggs', 'bread', 'brood', 'kaas', 'butter', 'jam', 'milk', 'tea', 'rice'];

function randomCase() {
  const baseLines = [];
  if (random() < 0.5) baseLines.push('# Groceries', '');
  const count = 2 + Math.floor(random() * 6);
  for (let i = 0; i < count; i++) baseLines.push(`${random() < 0.2 ? '  ' : ''}- [${random() < 0.3 ? 'x' : ' '}] ${pick(words)}`);
  if (random() < 0.3) baseLines.push('Notes', '');
  const base = baseLines.join('\n') + (random() < 0.5 ? '\n' : '');
  // Guests: ticks, new lines, and now and then something they may not do.
  let link = base.split('\n');
  let marks = [];
  const guestEdits = 1 + Math.floor(random() * 4);
  for (let i = 0; i < guestEdits; i++) {
    const tasks = link.map((line, index) => [line, index]).filter(([line]) => /^\s*- \[[ x]\] /.test(line));
    const roll = random();
    if (roll < 0.5 && tasks.length) {
      const [line, index] = pick(tasks);
      link[index] = line.includes('[x]') ? line.replace('[x]', '[ ]') : line.replace('[ ]', '[x]');
    } else if (roll < 0.8) {
      const at = tasks.length ? pick(tasks)[1] + 1 : link.length;
      link.splice(at, 0, `- [ ] ${pick(words)}`);
    } else if (roll < 0.9 && tasks.length) {
      const [, index] = pick(tasks);
      link[index] = `${link[index]} 2L`;
    } else if (tasks.length) link.splice(pick(tasks)[1], 1);
    const text = link.join('\n');
    marks = updateMarks(marks, text, []);
  }
  const linkText = link.join('\n');
  // Marks for whatever guests ticked or added, as the page would have written them.
  const accepted = allowedGuestChange(base, linkText);
  marks = [];
  const baseTasks = base.split('\n').filter((line) => /^\s*- \[[ x]\] /.test(line));
  for (const [i, line] of accepted.split('\n').entries()) {
    if (!/^\s*- \[[ x]\] /.test(line)) continue;
    const key = line.replace(/\[[xX]\]/, '[ ]');
    const n = accepted.split('\n').slice(0, i).filter((other) => other.replace(/\[[xX]\]/, '[ ]') === key).length;
    const wasThere = baseTasks.some((other) => other.replace(/\[[xX]\]/, '[ ]') === key);
    if (!wasThere || !baseTasks.includes(line)) marks.push({ line: key, n, by: pick(['Anna', 'Ben', '']) || 'Someone', at: 1000 + i, added: !wasThere });
  }
  marks = updateMarks(marks, accepted, []);
  // The owner meanwhile: ticks, removed or added lines, moved lines.
  let mine = base.split('\n');
  const ownEdits = Math.floor(random() * 3);
  for (let i = 0; i < ownEdits; i++) {
    const tasks = mine.map((line, index) => [line, index]).filter(([line]) => /^\s*- \[[ x]\] /.test(line));
    const roll = random();
    if (roll < 0.4 && tasks.length) { const [line, index] = pick(tasks); mine[index] = line.includes('[x]') ? line.replace('[x]', '[ ]') : line.replace('[ ]', '[x]'); }
    else if (roll < 0.6 && tasks.length) mine.splice(pick(tasks)[1], 1);
    else if (roll < 0.8) mine.splice(tasks.length ? pick(tasks)[1] : 0, 0, `- [ ] ${pick(words)}`);
    else if (tasks.length) { const [line, index] = pick(tasks); mine.splice(index, 1); mine.push(line); }
  }
  const note = mine.join('\n');
  const now = 5000 + Math.floor(random() * 1000);
  const ownerName = pick(['Eric', 'Owner', '', 'x'.repeat(41)]);
  const result = reconcile({ text: base }, note, { text: linkText, marks }, { ownerName, now });
  return ['reconcile', encodeText(base), encodeText(note), encodeText(linkText), flat(marks), encodeText(ownerName), now, encodeText(result.text), flat(result.marks), result.noteChanged ? 1 : 0, result.linkChanged ? 1 : 0].join('\t');
}

const temporary = mkdtempSync(path.join(tmpdir(), 'jotdrop-android-list-links-'));
try {
  const lines = [];
  for (const vector of JSON.parse(readFileSync(path.join(root, 'cloud/shared/list-link-vectors.json'), 'utf8'))) {
    lines.push(['vector', encodeText(vector.name), encodeText(vector.base), field(vector.next), encodeText(vector.accepted), field(vector.mine), field(vector.result)].join('\t'));
  }
  for (let i = 0; i < 400; i++) lines.push(randomCase());
  // Sealing: Android must open what the web sealed, with the same AAD strings and write proof, and seal what the web opens.
  const cases = [];
  for (let i = 0; i < 3; i++) {
    const key = generateVaultKey(), vaultKey = generateVaultKey(), id = randomUUID(), vaultId = randomUUID();
    const list = { v: 1, revision: 2 + i, title: `List ${i} é日`, text: '# Groceries\n- [x] milk\n- [ ] eggs\n', marks: [{ line: '- [ ] milk', n: 0, by: 'Anna', at: 1762279200000, added: false }] };
    const owner = { key, title: list.title, path: 'notes/Groceries.md', base: { revision: 1, noteRevision: 3, text: list.text } };
    const proof = await writeProof(key);
    cases.push({ key, vaultKey, id, vaultId, list, owner });
    lines.push(['crypto', key, id, vaultKey, vaultId, encodeText(JSON.stringify(await encryptEnvelope(key, list, `jotdrop:list-link:v1:${id}`))),
      encodeText(JSON.stringify(await encryptEnvelope(vaultKey, owner, `jotdrop:list-link-owner:v1:${vaultId}:${id}`))),
      encodeText(JSON.stringify(list)), encodeText(JSON.stringify(owner)), proof, await sha256Hex(encoder.encode(proof))].join('\t'));
  }
  const input = path.join(temporary, 'input.tsv'), output = path.join(temporary, 'output.tsv');
  writeFileSync(input, lines.join('\n'));
  const windows = process.platform === 'win32';
  execFileSync(windows ? process.env.ComSpec || 'cmd.exe' : './gradlew', windows ? ['/d', '/c', 'gradlew.bat checkListLinks --no-daemon --console=plain'] : ['checkListLinks', '--no-daemon', '--console=plain'], {
    cwd: path.join(root, 'android'), stdio: 'inherit', env: { ...process.env, JOTDROP_LIST_LINK_INPUT: input, JOTDROP_LIST_LINK_OUTPUT: output },
  });
  const results = readFileSync(output, 'utf8').split('\n');
  assert.equal(results.length, cases.length);
  for (const [index, line] of results.entries()) {
    const [kind, iv, ciphertext, ownerIv, ownerCiphertext] = line.split('\t');
    const { key, vaultKey, id, vaultId, list, owner } = cases[index];
    assert.equal(kind, 'sealed');
    assert.deepEqual(await decryptEnvelope(key, { v: 1, iv, ciphertext }, `jotdrop:list-link:v1:${id}`), list, 'the web opens what Android sealed');
    assert.deepEqual(await decryptEnvelope(vaultKey, { v: 1, iv: ownerIv, ciphertext: ownerCiphertext }, `jotdrop:list-link-owner:v1:${vaultId}:${id}`), owner, 'the web opens the owner envelope Android sealed');
    await assert.rejects(decryptEnvelope(key, { v: 1, iv, ciphertext }, `jotdrop:list-link:v1:${randomUUID()}`));
  }
  // The vectors here must be the ones the JavaScript tests pass too.
  for (const vector of JSON.parse(readFileSync(path.join(root, 'cloud/shared/list-link-vectors.json'), 'utf8'))) {
    if (vector.next !== undefined) assert.equal(allowedGuestChange(vector.base, vector.next), vector.accepted);
    if (vector.mine !== undefined) assert.equal(applyGuestChanges(vector.base, vector.accepted, vector.mine), vector.result);
  }
  console.log('Android list link parity ok');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

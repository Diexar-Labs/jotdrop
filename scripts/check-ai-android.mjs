// Ask JotDrop on Android against the shared code: the Kotlin check (android/checks/AiCheck.kt) plays every case of
// cloud/shared/ai/ai-vectors.json and ai-vectors-v2.json (files, transcription, receipts), and compares note edits,
// note choice, the prompt, the file table and the receipt lines with what the web app's JavaScript makes of the
// cases below. Part G (the key on all your devices): AiKeySync.kt plays ai-key-vectors.json, opens blobs keysync.mjs
// sealed, and the blobs it seals are opened here with keysync.mjs.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHOTO_SYSTEM, aiFileKind, appendedText, editorRequest, fileRequest, labelChanges, newNoteText, receiptLines, replacedText } from '../cloud/web/ai-web.mjs';
import { joinNote, splitNote } from '../cloud/web/note.mjs';
import { formatNotes, searchNotes, selectNotes } from '../cloud/shared/ai/context.mjs';
import { systemPrompt } from '../cloud/shared/ai/prompt.mjs';
import { findDuplicates, normalizeText, pairKey } from '../cloud/shared/similar.mjs';
import { digestRequest, wallClock, weekDigest } from '../cloud/shared/ai/digest.mjs';
import { openKey, sealKey } from '../cloud/shared/ai/keysync.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ai = path.join(root, 'cloud/shared/ai');

const files = [
  '# Shopping\n\n- [ ] eggs\n',
  '---\ncolor: "red"\njotdrop_labels: ["Home"]\n---\n# Shopping\n\n- [ ] eggs\n- [x] milk\n\n\n',
  '# Boiler\r\n\r\nBleed the radiators.\r\n',
  'Just text without a title',
  '',
  '---\nreminder: 2026-11-10T10:00\n---\nNo heading here\n- [ ] one',
  '#   Spaced title   \n   \nBody',
];
const longText = Array.from({ length: 900 }, (_, i) => `Line ${i} about tea and the boiler.`).join('\n');
const notes = [
  { id: 'a', title: 'Tea', text: longText, updatedAt: '2026-11-01T10:00:00.000Z' },
  { id: 'b', title: 'Boiler', text: 'Service in October.\n\n\tBleed   the radiators.', labels: ['Home'], updatedAt: '2026-11-02T10:00:00.000Z' },
  { id: 'c', title: 'Café <note> & "quotes"', text: 'Tea with </note> inside', updatedAt: '2026-11-03T10:00:00.000Z' },
  { id: 'd', title: 'Shared tea', text: 'Family tea', shared: true },
];
// Version 2: the note after "Apply" in the receipt screen, the text part of receiptApplied in ai-web.mjs (title and
// lines; the expiry date goes through set_expiry's code on the phone). oneLine is ai-web.mjs's own, not exported.
const oneLine = (text) => String(text ?? '').replace(/[\r\n]+/g, ' ').trim();
const receiptText = (file, title, lines) => {
  const named = oneLine(title) ? joinNote({ ...splitNote(file), title: oneLine(title) }) : file;
  return String(lines ?? '').trim() ? appendedText(named, { text: lines }) : named;
};
const receipts = [
  { shop: 'MediaMarkt', amount: '499,00', currency: 'EUR', bought: '2026-11-08' },
  { amount: '3.5' },
  { shop: 'Bakker', bought: '2026-11-01' },
  { title: 'Only a title' },
  {},
];
const settings = { language: 'Nederlands', date: '2026-11-09', timeZone: 'Europe/Madrid', labels: ['Home', 'Work'] };

const edits = {
  newNote: [
    { title: 'Boiler', text: '  Bleed the radiators.\n\nIn October.  ' },
    { title: 'Groceries\nlist', items: ['milk', '- [ ] bread', '[x] eggs', '* cheese', '- tea'] },
    { title: 'Both', text: 'Intro', items: ['one'] },
    { title: 'Empty' },
  ].map((c) => ({ ...c, expect: newNoteText(c) })),
  append: files.flatMap((file) => [{ text: 'More text\nover two lines' }, { items: ['milk', 'bread'] }, { text: 'Intro', items: ['x'] }]
    .map((change) => ({ file, ...change, expect: appendedText(file, change) }))),
  replace: files.flatMap((file) => ['New body', '# Shopping\n\nSorted:\n- [ ] a', '# Other heading\nText', '   ', 'Line\r\nTwo']
    .map((text) => ({ file, text, expect: replacedText(file, text) }))),
  split: files.map((file) => ({ file, expect: splitNote(file) })),
  labels: [['Home', 'home', ' Work ', '', 'Two\nlines'], []].map((labels) => ({ labels, expect: labelChanges(labels).jotdrop_labels ?? [] })),
  editor: ['rewrite', 'checklist', 'summarize'].flatMap((kind) => ['Shopping', '', 'Two\nlines'].map((title) => ({ kind, title, expect: editorRequest(kind, title) }))),
  search: ['tea', 'radiators boiler', 'café'].map((query) => ({ query, notes, expect: searchNotes(notes, query) })),
  select: [{ question: 'tea boiler' }, { question: 'tea', maxChars: 5000 }, { question: 'café quotes' }].map((c) => {
    const picked = selectNotes(notes, c.question, c.maxChars ? { maxChars: c.maxChars } : {});
    return { ...c, notes, expect: picked, formatted: formatNotes(picked.notes) };
  }),
  prompt: { ...settings, expect: systemPrompt(settings) },
  promptDefaults: { date: '2026-11-09', expect: systemPrompt({ date: '2026-11-09' }) },
  files: ['a.JPG', 'x.jpeg', 'p.png', 'w.webp', 'g.gif', 'b.bmp', 'd.pdf', 'diexar-1.m4a', 'v.webm', 'o.ogg', 's.mp3', 'w.wav', 'a.aac', 'drawing-1.png', 'Drawing-2.PNG', 'f.flac', 'h.heic', 's.svg', 'noext', '.pdf', 'map/sub/c.PDF']
    .map((name) => ({ name, expect: aiFileKind(name) })),
  fileRequests: { photo: fileRequest('photo'), transcribe: fileRequest('transcribe'), photoSystem: PHOTO_SYSTEM },
  receiptLines: receipts.map((data) => ({ data, expect: receiptLines(data) })),
  receiptNote: files.flatMap((file) => [['Wasmachine', 'Shop: MediaMarkt\nAmount: 499,00 EUR'], ['', 'Bought: 2026-11-08'], ['Two\nlines', ''], ['  ', '  ']]
    .map(([title, lines]) => ({ file, title, lines, expect: receiptText(file, title, lines) }))),
};

// Version 2, part E and F (Find duplicates, This week): Similar.kt and Digest.kt against similar.mjs and digest.mjs,
// for every vector case, the limits, and a few hundred generated notes (a fixed seed, so a failure can be found again).
const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
let seed = 20261113;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (list) => list[Math.floor(random() * list.length)];
const vocabulary = ['zolder', 'offerte', 'aannemer', 'dak', 'café', 'Zoë', 'boodschappen', 'brood', 'melk', 'kaas', 'garantie', 'bon', 'wasmachine',
  'tandarts', 'afspraak', 'trein', 'Madrid', 'vergunning', 'gemeente', 'vloer', 'trap', 'tuin', 'schutting', 'verf', 'kraan', 'loodgieter', 'donderdag',
  'vakantie', 'paspoort', 'verzekering', 'factuur', 'BTW', 'klant', 'project', 'JotDrop', 'release', 'Android', 'web', 'sleutel', '2026', '42', 'één'];
const sentence = (words) => Array.from({ length: words }, () => pick(vocabulary)).join(pick([' ', ' ', ' ', '  ', ', ', '\n', '\t']));
const similarNotes = [];
for (let i = 0; i < 260; i += 1) {
  const base = sentence(8 + Math.floor(random() * 40));
  const updatedAt = `2026-1${Math.floor(random() * 2)}-${String(1 + Math.floor(random() * 28)).padStart(2, '0')}T10:00:00Z`;
  similarNotes.push({ id: `g${i}`, title: `G${i}`, text: base, updatedAt, shared: random() < 0.05 });
  const kind = random();
  if (kind < 0.12) similarNotes.push({ id: `g${i}s`, title: 'Copy', text: base.toUpperCase(), updatedAt });
  else if (kind < 0.24) similarNotes.push({ id: `g${i}n`, title: 'Near', text: base.replace(/\S+$/, 'anders'), updatedAt: '2026-11-12T10:00:00Z' });
  else if (kind < 0.32) similarNotes.push({ id: `g${i}i`, title: 'Inside', text: `${sentence(30)}\n${base}\n${sentence(3)}`, updatedAt: '2026-10-01T10:00:00Z' });
}
const similarVectors = readJson('cloud/shared/similar-vectors.json').cases;
const base40 = Array.from({ length: 40 }, (_, i) => `woord${i}`).join(' ');
const equal40 = 'dit is een precies gelijke notitie die ruim veertig tekens lang is';
const threeEqual = similarVectors.find((vector) => vector.name.startsWith('three equal')).notes;
const similarCases = [
  ...similarVectors.map((vector) => ({ name: vector.name, notes: vector.notes, dismissed: (vector.dismissed ?? []).map(([a, b]) => pairKey(a, b)) })),
  { name: 'three equal, reversed', notes: [...threeEqual].reverse() },
  { name: 'fewer than three words', notes: [{ id: 'a', title: 'A', text: 'Onderhoudscontract-verlenging-aanvraagformulier-ingevuld' }, { id: 'b', title: 'B', text: 'Onderhoudscontract-verlenging-aanvraagformulier-ingevuld ' }] },
  { name: 'time limit', notes: Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, title: `N${i}`, text: `${base40} extra${i}` })), timeLimitMs: 10, tick: 5 },
  { name: '500 pairs', notes: Array.from({ length: 40 }, (_, i) => ({ id: `n${String(i).padStart(2, '0')}`, title: 'N', text: equal40 })) },
  { name: 'generated', notes: similarNotes },
  { name: 'generated, some kept', notes: similarNotes, dismissed: findDuplicates(similarNotes).pairs.filter((_, i) => i % 3 === 0).map((pair) => pairKey(pair.b, pair.a)) },
].map((c) => {
  let tick = 0;
  const result = findDuplicates(c.notes, { dismissed: c.dismissed ?? [], ...(c.timeLimitMs ? { timeLimitMs: c.timeLimitMs } : {}), now: c.tick ? () => (tick += c.tick) : () => 0 });
  return { ...c, expect: result };
});
if (similarCases.find((c) => c.name === 'generated').expect.pairs.length < 30) throw new Error('the generated notes should give some pairs');

const digestVectors = readJson('cloud/shared/ai/digest-vectors.json');
const nowMs = Date.parse(digestVectors.now);
const at = (days) => new Date(nowMs + days * 86400000);
const iso = (days) => at(days).toISOString();
const wall = (days) => at(days).toISOString().slice(0, 16);
const digestNotes = Array.from({ length: 300 }, (_, i) => {
  const note = { id: `d${String(i).padStart(3, '0')}`, title: pick(['Boodschappen', '', '  Klus  ', 'Bon <note>', 'Week\nplan', pick(vocabulary)]),
    text: [pick(['', '## Kop', '- [ ] eerste', '> citaat', '   ', 'Gewone regel']), ...Array.from({ length: Math.floor(random() * 14) }, () => pick(['- [ ] ', '- [x] ', '* [ ] ', '  + [ ] ', '']) + sentence(3))].join(pick(['\n', '\r\n'])) };
  if (random() < 0.8) note.updatedAt = pick([iso(-20 + random() * 22), '2026-11-13', '', 'not a date']);
  if (random() < 0.3) note.reminder = pick([wall(-3 + random() * 12), `${wall(random() * 8)}:00`, '2026-11-15', ' 2026-11-14T08:00 ']);
  if (random() < 0.3) note.expires = pick([iso(-45 + random() * 90).slice(0, 10), '2026-02-30', '0026-11-20', ' 2026-11-20 ', '2026-11-20T00:00']);
  if (random() < 0.1) note.shared = true;
  return note;
});
const bons = Array.from({ length: 45 }, (_, i) => ({ id: `bon${i}`, title: `Bon ${i}`, text: 'x', expires: `202${i % 5}-0${1 + (i % 9)}-15` }));
const week3 = [1, 2, 3].map((i) => ({ id: `c${i}`, title: `This week ${i}`, text: 'y', updatedAt: '2026-11-12T10:00:00Z' }));
const longTasks = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, title: `N${i}`, text: Array.from({ length: 20 }, () => `- [ ] ${'x'.repeat(500)}`).join('\n'), updatedAt: '2026-11-12T10:00:00Z' }));
const digestCases = [
  ...digestVectors.cases.map((vector) => ({ name: vector.name, notes: vector.notes, now: digestVectors.now, timeZone: digestVectors.timeZone, includeShared: vector.includeShared ?? false })),
  { name: 'zone UTC', notes: [{ id: 'a', title: 'A', text: 'x', reminder: '2026-11-13T23:30' }], now: '2026-11-13T22:45:00Z', timeZone: 'UTC' },
  { name: 'zone Amsterdam', notes: [{ id: 'a', title: 'A', text: 'x', reminder: '2026-11-13T23:30' }], now: '2026-11-13T22:45:00Z', timeZone: 'Europe/Amsterdam' },
  { name: 'old papers', notes: [...bons, ...week3], now: digestVectors.now, timeZone: 'UTC' },
  { name: '30,000 characters', notes: longTasks, now: digestVectors.now, timeZone: 'UTC' },
  { name: 'generated', notes: digestNotes, now: digestVectors.now, timeZone: 'Europe/Madrid' },
  { name: 'generated, shared allowed', notes: digestNotes, now: digestVectors.now, timeZone: 'America/New_York', includeShared: true },
  { name: 'generated, unknown zone', notes: digestNotes, now: '2026-03-29T00:30:00Z', timeZone: 'Not/AZone' },
].map((c) => {
  const digest = weekDigest(c.notes, { now: new Date(c.now), timeZone: c.timeZone, includeShared: c.includeShared });
  return { ...c, expect: { notes: digest.notes, left: digest.left, truncated: digest.truncated, counts: digest.counts, text: digest.text } };
});
if (digestCases.find((c) => c.name === 'generated').expect.notes.length < 20) throw new Error('the generated notes should give a digest');
edits.similar = similarCases;
edits.pairKeys = [['a', 'b'], ['b', 'a'], ['n10', 'n9'], ['É', 'e']].map(([a, b]) => ({ a, b, expect: pairKey(a, b) }));
edits.normalize = ['  Café\n\tAU   Lait ', 'Ünïcödé  spaces﻿', 'İstanbul ŞEHİR', '', '\u001ftab\u001c'].map((text) => ({ text, expect: normalizeText(text) }));
edits.digest = digestCases;
edits.wallClock = [['2026-11-13T10:00:00Z', 'Europe/Amsterdam'], ['2026-07-01T23:30:00Z', 'Europe/Amsterdam'], ['2026-11-13T10:00:00Z', 'Not/AZone'], ['2026-03-29T01:30:00Z', 'Europe/Madrid'], ['2026-11-13T10:00:00Z', 'Asia/Kolkata']]
  .map(([now, timeZone]) => ({ now, timeZone, expect: wallClock(new Date(now), timeZone) }));
// "Merge with AI": the request is app.js's own mergeRequest, read from the file (it is not exported).
const mergeSource = /function mergeRequest\(\{ older, newer \}\) \{\s*return `([^`]+)`;/.exec(readFileSync(path.join(root, 'cloud/web/app.js'), 'utf8'));
if (!mergeSource) throw new Error('cloud/web/app.js: mergeRequest is not where this check looks for it');
edits.merge = [['n1', 'n2'], ['n12', 'n3']].map(([older, newer]) => ({ older, newer, expect: mergeSource[1].replaceAll('${older.id}', older).replaceAll('${newer.id}', newer) }));
edits.digestRequest = [{ language: 'nl-NL', date: 'Friday 13 November 2026', timeZone: 'Europe/Amsterdam', text: '<note id="a">\nTitle: A\n</note>' }, { date: '2026-11-13', text: '' }]
  .map((c) => ({ ...c, expect: digestRequest(c) }));

// The JVM check runs java.util.regex; the phone runs ICU, which rejects some Java-only flags (found 9 Nov 2026: (?U)
// crashed Ask JotDrop on the emulator while the JVM check passed).
const kotlin = path.join(root, 'android/app/src/main/kotlin/com/diexar/keepcapture');
for (const file of readdirSync(kotlin).filter((name) => /^Ai.*\.kt$/.test(name))) {
  if (/\(\?[a-zA-Z]*U/.test(readFileSync(path.join(kotlin, file), 'utf8'))) throw new Error(`${file}: Android's ICU regex does not take the U flag`);
}

// 10 Nov 2026, Eric's phone: "Summarize with AI" sent only the request. The screen kept the card's note id from a
// composition before the notes were read, and the automatic send used that old, empty value. What goes along must
// be decided by AiAsk.plan when it is needed, and the request must carry exactly that choice.
const screen = readFileSync(path.join(kotlin, 'AiActivity.kt'), 'utf8');
if (/remember\([^)]*\)\s*\{[^}]*(uriOf|idOf)/.test(screen)) throw new Error('AiActivity.kt: the card\'s note is looked up in a remembered value; look it up when sending');
if (!/AiAsk\.plan\(/.test(screen) || !/chosen = chosen/.test(screen)) throw new Error('AiActivity.kt: the ask screen must send what AiAsk.plan chose');
if (/pinned = listOfNotNull\(pinnedId\)/.test(screen)) throw new Error('AiActivity.kt: the old pinnedId is back');

// 10 Nov 2026: listing 500 notes for the ask screen took ~2.5 s on Eric's phone (3.9 s on the emulator). The attachments
// folder was read three times (notes, Mail, Archive), Mail and Archive were looked up from the vault root each time, and
// every note compiled some twenty Regex objects. The ask screen lists Notes and Archive in one pass without attachments.
const android = readFileSync(path.join(kotlin, 'AiAndroid.kt'), 'utf8');
if (/Storage\.listNotes\(/.test(android) || !/Storage\.listNotesForAsk\(/.test(android)) throw new Error('AiAndroid.kt: the ask screen must list with Storage.listNotesForAsk (one pass, no attachments)');
const storage = readFileSync(path.join(kotlin, 'Storage.kt'), 'utf8');
const body = (name) => {
  const start = storage.indexOf(`fun ${name}(`);
  if (start < 0) throw new Error(`Storage.kt: ${name} is missing`);
  const open = storage.indexOf('{', storage.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < storage.length; i++) {
    if (storage[i] === '{') depth++;
    else if (storage[i] === '}' && --depth === 0) return storage.slice(open, i);
  }
  throw new Error(`Storage.kt: ${name} has no end`);
};
for (const name of ['buildNoteSummaries', 'extractTitle', 'extractSnippet', 'withoutHeadingMarks', 'extractUrls', 'collectEmbedBasenames']) {
  if (/Regex\(/.test(body(name))) throw new Error(`Storage.kt: ${name} compiles a Regex for every note; keep it in a val`);
}
if (/attachments: Map<String, Uri> = snapshotAttachments/.test(storage)) throw new Error('Storage.kt: buildNoteSummaries must get the attachments of its listing, not read the folder again');
if (/traverseSubfolder\(context, tree, "\$\{getSubfolder\(context\)\}\/Mail"\)/.test(storage)) throw new Error('Storage.kt: Mail is a folder in the notes folder; take it from that listing');

// Part G: blobs the web app seals (random IVs, so new ones every run) for Kotlin to open, and Kotlin's for keysync.mjs.
const keyVectors = readJson('cloud/shared/ai/ai-key-vectors.json');
const cross = { web: await Promise.all(keyVectors.opens.map(async ({ name, config }) => ({ name, config, sealed: await sealKey(keyVectors.vaultKey, keyVectors.vaultId, config) }))) };

const temporary = mkdtempSync(path.join(tmpdir(), 'jotdrop-ai-android-'));
try {
  const editsFile = path.join(temporary, 'edits.json');
  writeFileSync(editsFile, JSON.stringify(edits));
  const crossFile = path.join(temporary, 'key-cross.json'), outFile = path.join(temporary, 'key-android.json');
  writeFileSync(crossFile, JSON.stringify(cross));
  const windows = process.platform === 'win32';
  execFileSync(windows ? process.env.ComSpec || 'cmd.exe' : './gradlew', windows ? ['/d', '/c', 'gradlew.bat checkAi --no-daemon --console=plain'] : ['checkAi', '--no-daemon', '--console=plain'], {
    cwd: path.join(root, 'android'), stdio: 'inherit',
    env: { ...process.env, JOTDROP_AI_VECTORS: path.join(ai, 'ai-vectors.json'), JOTDROP_AI_TOOLS: path.join(ai, 'tools.json'), JOTDROP_AI_PROMPT: path.join(ai, 'prompt.json'), JOTDROP_AI_EDITS: editsFile, JOTDROP_AI_VECTORS_V2: path.join(ai, 'ai-vectors-v2.json'),
      JOTDROP_AI_KEY_VECTORS: path.join(ai, 'ai-key-vectors.json'), JOTDROP_AI_KEY_CROSS: crossFile, JOTDROP_AI_KEY_OUT: outFile },
  });
  // What Android sealed opens in the web app with the same settings, and not for another workspace.
  const sealed = JSON.parse(readFileSync(outFile, 'utf8')).android;
  if (sealed.length !== keyVectors.opens.length) throw new Error('AiKeySync.kt sealed fewer blobs than the vectors have');
  for (const { name, config, sealed: blob } of sealed) {
    const opened = await openKey(keyVectors.vaultKey, keyVectors.vaultId, blob);
    if (JSON.stringify(opened) !== JSON.stringify(config)) throw new Error(`keysync.mjs does not open what Android sealed: ${name}`);
    if (await openKey(keyVectors.vaultKey, '1b0f6f0e-3c56-4d0a-9d55-7a1c3a5e9f10', blob) !== null) throw new Error(`Android's blob opens for another workspace: ${name}`);
  }
  console.log('Android Ask JotDrop parity ok');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

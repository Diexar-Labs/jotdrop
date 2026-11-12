// Ask JotDrop on Android against the shared code: the Kotlin check (android/checks/AiCheck.kt) plays every case of
// cloud/shared/ai/ai-vectors.json and ai-vectors-v2.json (files, transcription, receipts), and compares note edits,
// note choice, the prompt, the file table and the receipt lines with what the web app's JavaScript makes of the
// cases below.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHOTO_SYSTEM, aiFileKind, appendedText, editorRequest, fileRequest, labelChanges, newNoteText, receiptLines, replacedText } from '../cloud/web/ai-web.mjs';
import { joinNote, splitNote } from '../cloud/web/note.mjs';
import { formatNotes, searchNotes, selectNotes } from '../cloud/shared/ai/context.mjs';
import { systemPrompt } from '../cloud/shared/ai/prompt.mjs';

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

const temporary = mkdtempSync(path.join(tmpdir(), 'jotdrop-ai-android-'));
try {
  const editsFile = path.join(temporary, 'edits.json');
  writeFileSync(editsFile, JSON.stringify(edits));
  const windows = process.platform === 'win32';
  execFileSync(windows ? process.env.ComSpec || 'cmd.exe' : './gradlew', windows ? ['/d', '/c', 'gradlew.bat checkAi --no-daemon --console=plain'] : ['checkAi', '--no-daemon', '--console=plain'], {
    cwd: path.join(root, 'android'), stdio: 'inherit',
    env: { ...process.env, JOTDROP_AI_VECTORS: path.join(ai, 'ai-vectors.json'), JOTDROP_AI_TOOLS: path.join(ai, 'tools.json'), JOTDROP_AI_PROMPT: path.join(ai, 'prompt.json'), JOTDROP_AI_EDITS: editsFile, JOTDROP_AI_VECTORS_V2: path.join(ai, 'ai-vectors-v2.json') },
  });
  console.log('Android Ask JotDrop parity ok');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

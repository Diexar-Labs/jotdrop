// Ask JotDrop on Android against the shared code: the Kotlin check (android/checks/AiCheck.kt) plays every case of
// cloud/shared/ai/ai-vectors.json, and compares note edits, note choice and the prompt with what the web app's
// JavaScript makes of the cases below.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendedText, editorRequest, labelChanges, newNoteText, replacedText } from '../cloud/web/ai-web.mjs';
import { splitNote } from '../cloud/web/note.mjs';
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

const temporary = mkdtempSync(path.join(tmpdir(), 'jotdrop-ai-android-'));
try {
  const editsFile = path.join(temporary, 'edits.json');
  writeFileSync(editsFile, JSON.stringify(edits));
  const windows = process.platform === 'win32';
  execFileSync(windows ? process.env.ComSpec || 'cmd.exe' : './gradlew', windows ? ['/d', '/c', 'gradlew.bat checkAi --no-daemon --console=plain'] : ['checkAi', '--no-daemon', '--console=plain'], {
    cwd: path.join(root, 'android'), stdio: 'inherit',
    env: { ...process.env, JOTDROP_AI_VECTORS: path.join(ai, 'ai-vectors.json'), JOTDROP_AI_TOOLS: path.join(ai, 'tools.json'), JOTDROP_AI_PROMPT: path.join(ai, 'prompt.json'), JOTDROP_AI_EDITS: editsFile },
  });
  console.log('Android Ask JotDrop parity ok');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

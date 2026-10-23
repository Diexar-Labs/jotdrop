// Markdown import (Apple Notes export and other apps): links to attachments, dates, names.
const assert = require("node:assert/strict");
const { makeZip, loadSource } = require("./zip-fixture.cjs");

const dosDate = new Date(2025, 10, 2, 10, 20, 30);
const unixDate = new Date("2025-12-24T18:00:00Z");
const vacation = [
  "# Vakantie", "",
  "![](Attachments/IMG_0001.jpeg)", "",
  'Zie [plan](Attachments/Reis%20plan.pdf "Plan") en <https://example.com>.',
  "![photo](<Attachments/beach photo.png>)",
  "[site](https://example.com/x)",
  "[Andere notitie](Boodschappen.md)",
  "![missing](Attachments/gone.png)", "",
].join("\n");
const fixture = [
  ["Notes export/Boodschappen.md", "# Boodschappen\n\n- [ ] Melk\n- [x] Brood\n\n#thuis\n", true, { mtime: dosDate }],
  ["Notes export/Vakantie.md", vacation, true, { mtime: dosDate, unixTime: unixDate }],
  ["Notes export/Attachments/IMG_0001.jpeg", Buffer.from([1, 2, 3]), false],
  ["Notes export/Attachments/Reis plan.pdf", Buffer.from("%PDF"), false],
  ["Notes export/Attachments/beach photo.png", Buffer.from([4, 5]), false],
  ["Notes export/Leeg.md", " \n", false],
  ["Notes export/Met frontmatter.md", "---\ntags: [x]\n---\nBody", false],
  ["Notes export/Windows.md", "﻿# Titel\r\nRegel\r\n", false],
  ["Notes export/.DS_Store", "junk", false],
  ["__MACOSX/Notes export/._Vakantie.md", "resource fork", false],
];

(async () => {
  const { readZip } = await loadSource("src/keepImport.ts");
  const { parseMarkdownExport, markdownNoteFileName, markdownNoteMarkdown } = await loadSource("src/markdownImport.ts");
  const files = await readZip(makeZip(fixture));
  // DOS time is local; the Info-ZIP "UT" field is UTC seconds and wins when present.
  assert.equal(files.get("Notes export/Boodschappen.md").modified, dosDate.getTime());
  assert.equal(files.get("Notes export/Vakantie.md").modified, unixDate.getTime());
  assert.equal(files.get("Notes export/Leeg.md").modified, undefined);

  const now = Date.UTC(2026, 9, 22, 12, 0, 0);
  const { notes, failed } = await parseMarkdownExport(files, now);
  assert.deepEqual(failed, []);
  assert.deepEqual(notes.map((note) => note.title), ["Boodschappen", "Met frontmatter", "Vakantie", "Windows"]);
  const [groceries, frontmatter, trip, windows] = notes;
  const stamp = (ms) => {
    const d = new Date(ms), pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  };

  // Apple Notes has real tags, so hashtags stay; the text is otherwise untouched.
  assert.equal(markdownNoteFileName(groceries), `${stamp(dosDate.getTime())} Boodschappen.md`);
  assert.equal(markdownNoteMarkdown(groceries, new Map()), "# Boodschappen\n\n- [ ] Melk\n- [x] Brood\n\n#thuis\n");

  assert.equal(frontmatter.createdMs, now);
  assert.equal(markdownNoteMarkdown(frontmatter, new Map()), "---\ntags: [x]\n---\nBody\n");
  assert.equal(markdownNoteMarkdown(windows, new Map()), "# Titel\nRegel\n");

  assert.deepEqual(trip.attachments, [
    "Notes export/Attachments/IMG_0001.jpeg",
    "Notes export/Attachments/Reis plan.pdf",
    "Notes export/Attachments/beach photo.png",
  ]);
  assert.equal(trip.missingAttachments, 1);
  const names = new Map([
    ["Notes export/Attachments/IMG_0001.jpeg", "IMG_0001.jpeg"],
    ["Notes export/Attachments/Reis plan.pdf", "Reis plan.pdf"],
    ["Notes export/Attachments/beach photo.png", "beach photo 2.png"],
  ]);
  assert.equal(markdownNoteMarkdown(trip, names), [
    "# Vakantie", "",
    "![[IMG_0001.jpeg]]", "",
    "Zie [[Reis plan.pdf|plan]] en <https://example.com>.",
    "![[beach photo 2.png]]",
    "[site](https://example.com/x)",
    "[Andere notitie](Boodschappen.md)",
    "![missing](Attachments/gone.png)", "",
  ].join("\n"));
  // An attachment that could not be written keeps its original link.
  names.delete("Notes export/Attachments/IMG_0001.jpeg");
  assert.ok(markdownNoteMarkdown(trip, names).includes("![](Attachments/IMG_0001.jpeg)"));

  // Loose files from a picker (no folders) resolve attachments by name too.
  const loose = new Map([
    ["Vakantie.md", Object.assign(async () => new TextEncoder().encode(vacation), { modified: dosDate.getTime() })],
    ["IMG_0001.jpeg", async () => new Uint8Array([1, 2, 3])],
  ]);
  const looseTrip = (await parseMarkdownExport(loose, now)).notes[0];
  assert.deepEqual(looseTrip.attachments, ["IMG_0001.jpeg"]);
  assert.equal(looseTrip.missingAttachments, 3);
  console.log("Markdown import checks passed.");
})().catch((error) => { console.error(error); process.exit(1); });

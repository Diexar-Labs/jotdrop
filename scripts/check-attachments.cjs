// Attach file in the Obsidian plugin: file kinds from cloud/shared/filekinds.json, safe and unique names,
// and every photo, sound and drawing saved through the one saveAttachment (never overwriting).
const assert = require("node:assert/strict");
const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const source = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

(async () => {
  const result = await esbuild.build({
    stdin: { contents: `export { fileKind, isFileEmbed, cleanFileName, uniqueFileName, collectEmbedBasenames, formatFileSize } from "./src/fileKinds.ts";`, resolveDir: ROOT },
    bundle: true, platform: "node", format: "cjs", write: false,
    alias: { obsidian: path.join(__dirname, "mock-obsidian.cjs") },
  });
  const loaded = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(loaded, loaded.exports, require);
  const { fileKind, isFileEmbed, cleanFileName, uniqueFileName, collectEmbedBasenames, formatFileSize } = loaded.exports;

  // Kinds come from the shared list, case-insensitive.
  assert.equal(fileKind("Offerte.PDF"), "pdf");
  assert.equal(fileKind("photo.jpeg"), "image");
  assert.equal(fileKind("scan.svg"), "image");
  assert.equal(fileKind("memo.m4a"), "audio");
  assert.equal(fileKind("call.amr"), "audio");
  assert.equal(fileKind("film.mp4"), "video");
  assert.equal(fileKind("sheet.xlsx"), "file");
  assert.equal(fileKind("README"), "file");

  // A file embed has an extension that is not a note or an Excalidraw drawing.
  assert.equal(isFileEmbed("report.pdf"), true);
  assert.equal(isFileEmbed("drawing-2026-11-11 101010.png"), true);
  assert.equal(isFileEmbed("Other note"), false);
  assert.equal(isFileEmbed("Other note.md"), false);
  assert.equal(isFileEmbed("Sketch.excalidraw"), false);

  // Names keep what the person sees, without what breaks a path or a wiki link, or hides the file from sync.
  assert.equal(cleanFileName("Offerte keuken.pdf"), "Offerte keuken.pdf");
  assert.equal(cleanFileName("C:\\Users\\me\\Offerte [v2] #1.pdf"), "Offerte -v2- -1.pdf");
  assert.equal(cleanFileName("../../etc/passwd"), "passwd");
  assert.equal(cleanFileName(".secret.pdf"), "secret.pdf");
  assert.equal(cleanFileName("a|b:c?.txt"), "a-b-c-.txt");
  assert.equal(cleanFileName("   "), "file");
  assert.equal(cleanFileName("diexar-2026-11-11 101010.m4a"), "diexar-2026-11-11 101010.m4a");
  const long = cleanFileName(`${"x".repeat(300)}.pdf`);
  assert.ok(long.length <= 104 && long.endsWith(".pdf"), long);

  // Never overwrite: report.pdf twice gives report (2).pdf, a third time report (3).pdf.
  const taken = new Set(["report.pdf", "report (2).pdf", "notes"]);
  const isTaken = async (name) => taken.has(name);
  assert.equal(await uniqueFileName("report.pdf", isTaken), "report (3).pdf");
  assert.equal(await uniqueFileName("other.pdf", isTaken), "other.pdf");
  assert.equal(await uniqueFileName("notes", isTaken), "notes (2)");

  // Embeds: both link forms, and a pdf page link is still the pdf.
  assert.deepEqual(collectEmbedBasenames("![[report.pdf#page=3]]\n![](attachments/offer.docx)\n![[Other note]]", isFileEmbed), ["report.pdf", "offer.docx"]);
  assert.equal(formatFileSize(1536), "2 KiB");
  assert.equal(formatFileSize(5 * 1048576), "5.0 MiB");

  // One way to save attachments: photos, voice memos and drawings go through saveAttachment (unique names).
  const view = source("src/view.ts");
  const drawing = source("src/drawing.ts");
  const edit = source("src/edit.ts");
  assert.doesNotMatch(view, /adapter\.writeBinary/, "view.ts writes attachments itself");
  assert.doesNotMatch(drawing, /adapter\.writeBinary/, "drawing.ts writes attachments itself");
  assert.match(drawing, /plugin\.saveAttachment\(/);
  assert.doesNotMatch(view, /IMAGE_EXT_RE|AUDIO_EXT_RE/, "view.ts keeps its own extension list");
  // The editor shows every attachment, not only the first.
  assert.doesNotMatch(edit, /embedLines\[0\]/, "edit.ts only looks at the first attachment");
  assert.match(edit, /renderFileChip\(/);
  assert.match(view, /renderFileChip\(/);
  // Too large: the plan's maximum from the cloud, with the Plus line.
  assert.match(source("src/main.ts"), /this\.cloud\.maxFileBytes/);
  assert.match(source("src/cloud.ts"), /"max-file-bytes"/);

  console.log("Attachment checks passed");
})().catch((error) => { console.error(error); process.exit(1); });

// Google Keep Takeout import: zip reading and conversion to JotDrop notes.
const assert = require("node:assert/strict");
const esbuild = require("esbuild");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");

/** Minimal zip writer for fixtures: stored or deflated entries, optional ZIP64 records. */
function makeZip(entries, { zip64 = false } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content, deflate] of entries) {
    const raw = Buffer.from(content);
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name, "utf8");
    const crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const extra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(1, 0); extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(raw.length), 4); extra.writeBigUInt64LE(BigInt(data.length), 12); extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(45, 4); central.writeUInt16LE(45, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(deflate ? 8 : 0, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(zip64 ? 0xffffffff : data.length, 20); central.writeUInt32LE(zip64 ? 0xffffffff : raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes, extra);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const tail = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0); record.writeBigUInt64LE(44n, 4); record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24); record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40); record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(offset + directory.length), 8); locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8); end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12); end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  return new Blob([Buffer.concat([...locals, directory, ...tail, end])]);
}

const usec = (iso) => String(Date.parse(iso) * 1000);
const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const keepJson = (fields) => JSON.stringify({
  color: "DEFAULT", isTrashed: false, isPinned: false, isArchived: false, title: "",
  createdTimestampUsec: usec("2023-05-01T08:00:00Z"), userEditedTimestampUsec: usec("2023-05-02T09:30:00Z"), ...fields,
});
const fixture = [
  ["Takeout/Keep/Groceries.json", keepJson({
    title: "Groceries", color: "YELLOW", isPinned: true, labels: [{ name: "Home" }, { name: "Food" }, { name: "home" }],
    listContent: [{ text: "Milk", isChecked: false }, { text: "Coffee", isChecked: true }, { text: "", isChecked: false }],
    createdTimestampUsec: usec("2024-02-03T10:11:12Z"),
  }), true],
  ["Takeout/Keep/Groceries.html", "<html>ignored</html>", true],
  ["Takeout/Keep/Recipe idea.json", keepJson({
    title: "Recipe: soup / stew?", textContent: "Chickpeas and #spinach\r\nSee the link.", isArchived: true, color: "CERULEAN",
    attachments: [{ filePath: "1a2b3c.jpeg", mimetype: "image/jpeg" }, { filePath: "gone.png", mimetype: "image/png" }],
    annotations: [
      { source: "WEBLINK", url: "https://example.com/soup", title: "Soup [best]", description: "Long text" },
      { source: "WEBLINK", url: "https://example.com/seen", title: "Already in text" },
    ],
  }).replace("See the link.", "See the link. https://example.com/seen"), false],
  ["Takeout/Keep/1a2b3c.jpg", photo, false],
  ["Takeout/Keep/Old.json", keepJson({ title: "Deleted", textContent: "x", isTrashed: true }), true],
  ["Takeout/Keep/Untitled.json", keepJson({ textContent: "\n  First line becomes the name\nsecond line" }), true],
  ["Takeout/Keep/Broken.json", "{ not json", false],
  ["Takeout/Keep/Labels.txt", "Home\nFood", false],
  ["Takeout/archive_browser.html", "<html></html>", false],
];

(async () => {
  const result = await esbuild.build({
    stdin: { contents: `export * from "./src/keepImport.ts";`, resolveDir: ROOT },
    bundle: true, platform: "node", format: "cjs", write: false,
    alias: { obsidian: path.join(__dirname, "mock-obsidian.cjs") },
  });
  const loaded = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(loaded, loaded.exports, require);
  const { readZip, parseKeepExport, keepNoteFileName, keepNoteMarkdown } = loaded.exports;

  for (const zip64 of [false, true]) {
    const files = await readZip(makeZip(fixture, { zip64 }));
    assert.deepEqual([...files.keys()].sort(), fixture.map(([name]) => name).sort());
    assert.deepEqual(await files.get("Takeout/Keep/1a2b3c.jpg")(), new Uint8Array(photo));
    assert.equal(new TextDecoder().decode(await files.get("Takeout/Keep/Groceries.html")()), "<html>ignored</html>");
  }
  await assert.rejects(readZip(new Blob([Buffer.from("not a zip at all")])), /zip/i);
  // Windows PowerShell's Compress-Archive writes backslash separators.
  const windows = await readZip(makeZip(fixture.map(([name, ...rest]) => [name.replace(/\//g, "\\"), ...rest])));
  assert.deepEqual((await parseKeepExport(windows)).notes[1].attachments, ["Takeout/Keep/1a2b3c.jpg"]);

  const files = await readZip(makeZip(fixture));
  const { notes, trashed, failed } = await parseKeepExport(files);
  assert.equal(trashed, 1);
  assert.deepEqual(failed, ["Takeout/Keep/Broken.json"]);
  assert.deepEqual(notes.map((note) => note.source), ["Takeout/Keep/Groceries.json", "Takeout/Keep/Recipe idea.json", "Takeout/Keep/Untitled.json"]);

  const [groceries, recipe, untitled] = notes;
  const stamp = (ms) => {
    const d = new Date(ms), pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  };
  assert.equal(groceries.createdMs, Date.parse("2024-02-03T10:11:12Z"));
  assert.equal(groceries.editedMs, Date.parse("2023-05-02T09:30:00Z"));
  assert.equal(keepNoteFileName(groceries), `${stamp(Date.parse("2024-02-03T10:11:12Z"))} Groceries.md`);
  assert.equal(keepNoteMarkdown(groceries, (source) => source), [
    "---", "color: yellow", "pinned: true", 'jotdrop_labels: ["Home","Food"]', "---",
    "# Groceries", "", "- [ ] Milk", "- [x] Coffee", "",
  ].join("\n"));

  // Archived, Keep's dark blue maps to blue, the .jpeg reference finds the .jpg file, missing files are counted.
  assert.equal(recipe.archived, true);
  assert.equal(recipe.color, "blue");
  assert.deepEqual(recipe.attachments, ["Takeout/Keep/1a2b3c.jpg"]);
  assert.equal(recipe.missingAttachments, 1);
  assert.equal(keepNoteFileName(recipe), `${stamp(Date.parse("2023-05-01T08:00:00Z"))} Recipe soup stew.md`);
  assert.equal(keepNoteMarkdown(recipe, (source) => `img-${source.split("/").pop()}`), [
    "---", "color: blue", "---",
    "# Recipe: soup / stew?", "",
    // Keep has labels, not tags: typed hashtags stay text, like shared content.
    "Chickpeas and \\#spinach", "See the link. https://example.com/seen", "",
    "![[img-1a2b3c.jpg]]", "",
    "[Soup best](https://example.com/soup)", "",
  ].join("\n"));

  // Without a title the first text line names the file; no heading or frontmatter is invented.
  assert.equal(keepNoteFileName(untitled), `${stamp(Date.parse("2023-05-01T08:00:00Z"))} First line becomes the name.md`);
  assert.equal(keepNoteMarkdown(untitled, (source) => source), "First line becomes the name\nsecond line\n");

  // Review fixes: body starting with `---` must not turn into frontmatter; unsafe name characters and
  // emoji cuts; zero timestamps fall back; JSON from other Takeout products is never even loaded.
  const edge = new Map([
    ["Takeout/Keep/rule.json", async () => new TextEncoder().encode(keepJson({ textContent: "---\nTodo\n---\nmore", createdTimestampUsec: "0" }))],
    ["Takeout/Keep/odd.json", async () => new TextEncoder().encode(keepJson({ title: "Tab\there\u0001 " + "😀".repeat(40) }))],
    ["Takeout/Location History/Records.json", async () => { throw new Error("must not be read"); }],
    ["Takeout/Keep/unreadable.json", async () => { throw new Error("DecompressionStream is not defined"); }],
  ]);
  const edgeResult = await parseKeepExport(edge);
  assert.deepEqual(edgeResult.failed, ["Takeout/Keep/unreadable.json"]);
  assert.equal(edgeResult.error, "DecompressionStream is not defined");
  const [odd, rule] = edgeResult.notes;
  assert.equal(rule.createdMs, rule.editedMs);
  assert.equal(keepNoteMarkdown(rule, (source) => source), "\n---\nTodo\n---\nmore\n");
  const oddName = keepNoteFileName(odd);
  assert.ok(!/[\x00-\x1f]/.test(oddName) && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(oddName), JSON.stringify(oddName));
  assert.ok(oddName.startsWith(`${stamp(odd.createdMs)} Tab here 😀`), oddName);

  // Loose JSON files picked without a zip work the same way.
  const loose = new Map([["Groceries.json", async () => new TextEncoder().encode(fixture[0][1])]]);
  assert.equal((await parseKeepExport(loose)).notes[0].title, "Groceries");
  console.log("Keep import checks passed.");
})().catch((error) => { console.error(error); process.exit(1); });

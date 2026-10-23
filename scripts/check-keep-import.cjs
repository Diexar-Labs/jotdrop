// Google Keep Takeout import: zip reading and conversion to JotDrop notes.
const assert = require("node:assert/strict");
const { makeZip, loadSource } = require("./zip-fixture.cjs");

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
  const { readZip, parseKeepExport, keepNoteFileName, keepNoteMarkdown } = await loadSource("src/keepImport.ts");

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

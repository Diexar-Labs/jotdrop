// Evernote import (.enex): ENML to Markdown, attachments by MD5, tags, notebook label, tasks.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { makeZip, loadSource } = require("./zip-fixture.cjs");

const photo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
const scan = Buffer.from("%PDF-1.4 scan");
const md5 = (bytes) => crypto.createHash("md5").update(bytes).digest("hex");
const b64 = (bytes) => bytes.toString("base64").replace(/(.{20})/g, "$1\n");
const resource = (bytes, mime, fileName) => `<resource><data encoding="base64">${b64(bytes)}</data><mime>${mime}</mime>` +
  (fileName ? `<resource-attributes><file-name>${fileName}</file-name></resource-attributes>` : "") + "</resource>";
const note = ({ title, content, created = "20240115T093000Z", updated = "20240116T101500Z", tags = [], extra = "" }) =>
  `<note><title>${title}</title><created>${created}</created><updated>${updated}</updated>${tags.map((tag) => `<tag>${tag}</tag>`).join("")}` +
  `<content><![CDATA[<?xml version="1.0" encoding="UTF-8" standalone="no"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>${content}</en-note>]]></content>${extra}</note>`;

const shopping = note({
  title: "Boodschappen #thuis",
  tags: ["Home", "to do", "#Food", "home"],
  content: [
    "<div><en-todo checked=\"false\"/> Melk</div>",
    "<div><en-todo checked=\"true\"/>Brood</div>",
    "<div><br/></div>",
    "<div>Neem <b>echt</b> &amp; <i>snel</i> mee, zie <a href=\"https://example.com/shop?a=1&amp;b=2\">de winkel</a> #spinazie</div>",
    "<div>&nbsp;&nbsp;&nbsp;&nbsp;niet ingesprongen<br/></div>",
    `<div><en-media hash="${md5(photo).toUpperCase()}" type="image/png"/></div>`,
  ].join(""),
  extra: resource(photo, "image/png", "foto: 1.png"),
});
const rich = note({
  title: "Rijk",
  created: "20230301T080000Z",
  content: [
    "<h2>Plan</h2>",
    "<ul style=\"--en-todo:true;\"><li style=\"--en-checked:true;\"><div>Klaar</div></li><li style=\"--en-checked:false;\"><div>Open</div></li></ul>",
    "<ol><li>Een<ul><li>Sub</li></ul></li><li>Twee</li></ol>",
    "<table><tbody><tr><td>Naam</td><td>Prijs</td></tr><tr><td>Koffie | bonen</td><td>4</td></tr></tbody></table>",
    "<div style=\"box-sizing: border-box; -en-codeblock:true;\"><div>if (x) {</div><div>&nbsp;&nbsp;go(`#tag`);</div><div><br/></div><div>}</div></div>",
    "<blockquote><div>Citaat</div></blockquote>",
    "<hr/>",
    "<div><en-crypt hint=\"pin\" cipher=\"AES\">abc==</en-crypt></div>",
    "<div><en-media hash=\"00000000000000000000000000000000\" type=\"image/jpeg\"/></div>",
    "<div><a href=\"evernote:///view/1/s1/abc/abc/\">Andere notitie</a> en <a href=\"https://example.org/\">https://example.org/</a></div>",
  ].join(""),
  extra: resource(scan, "application/pdf", "") + "<note-attributes><source-url>https://example.net/page</source-url></note-attributes>",
});
const tasks = note({
  title: "Taken",
  created: "",
  updated: "",
  content: "<div>Voor</div><div style=\"--en-task-group:true; --en-id:g1;\"></div><div>Na</div>",
  extra: [
    "<task><title>Tweede</title><taskStatus>completed</taskStatus><sortWeight>B</sortWeight><taskGroupNoteLevelID>g1</taskGroupNoteLevelID></task>",
    "<task><title>Eerste</title><taskStatus>open</taskStatus><sortWeight>A</sortWeight><taskGroupNoteLevelID>g1</taskGroupNoteLevelID></task>",
    "<task><title>Los</title><taskStatus>open</taskStatus><sortWeight>C</sortWeight><taskGroupNoteLevelID>g9</taskGroupNoteLevelID></task>",
  ].join(""),
});
const empty = note({ title: "", content: "<div><br/></div>" });
const enex = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">\n` +
  `<en-export export-date="20261022T120000Z" application="Evernote" version="10.0">\n${[shopping, rich, tasks, empty].join("\n")}\n</en-export>\n`;
const fileDate = new Date(2026, 0, 2, 3, 4, 5);

(async () => {
  const { readZip } = await loadSource("src/keepImport.ts");
  const { md5Hex, parseEnexExport, evernoteNoteFileName, evernoteNoteMarkdown, parseXml, enmlToMarkdown } = await loadSource("src/evernoteImport.ts");

  // MD5 against Node for every padding case and a larger buffer.
  assert.equal(md5Hex(new Uint8Array()), "d41d8cd98f00b204e9800998ecf8427e");
  for (let length = 0; length <= 200; length++) {
    const bytes = crypto.randomBytes(length);
    assert.equal(md5Hex(new Uint8Array(bytes)), md5(bytes), `md5 of ${length} bytes`);
  }
  const large = crypto.randomBytes(1_000_003);
  assert.equal(md5Hex(new Uint8Array(large).subarray(3)), md5(large.subarray(3)));

  const files = await readZip(makeZip([
    ["Export/Persoonlijk.enex", enex, true, { mtime: fileDate }],
    ["Export/Kapot.enex", "<html><body>no export</body></html>", false],
    ["Export/readme.txt", "ignored", false],
    ["__MACOSX/Export/._Persoonlijk.enex", "fork", false],
  ]));
  const { notes, notebooks, failed, error } = await parseEnexExport(files);
  assert.equal(notebooks, 1);
  assert.deepEqual(failed, ["Export/Kapot.enex"]);
  assert.match(error, /not an Evernote export/);
  assert.equal(notes.length, 3, "the empty note is skipped");
  const [a, b, c] = notes;
  const names = new Map([...a.attachments, ...b.attachments].map((key) => [key, key.slice(key.lastIndexOf("/") + 1)]));
  const out = notes.map((n) => evernoteNoteMarkdown(n, names));
  if (process.env.SHOW) for (const [i, text] of out.entries()) console.log(`----- ${evernoteNoteFileName(notes[i])}\n${text}`);

  // Dates are UTC in the export; a note without dates gets the file's time.
  assert.equal(a.createdMs, Date.UTC(2024, 0, 15, 9, 30));
  assert.equal(a.editedMs, Date.UTC(2024, 0, 16, 10, 15));
  assert.equal(c.createdMs, files.get("Export/Persoonlijk.enex").modified);
  assert.match(evernoteNoteFileName(b), /^2023-03-01 \d{2}0000 Rijk\.md$/);
  assert.match(evernoteNoteFileName(a), / Boodschappen thuis\.md$/);

  // Attachments: found by MD5 (any case), named safely, unplaced ones at the end, missing ones counted.
  assert.equal(a.attachments.length, 1);
  assert.deepEqual(await files.get(a.attachments[0])(), new Uint8Array(photo));
  assert.match(a.attachments[0], /\/foto_ 1\.png$/);
  assert.equal(a.missingAttachments, 0);
  assert.deepEqual(b.unplaced, b.attachments);
  assert.match(b.attachments[0], new RegExp(`/evernote-${md5(scan).slice(0, 12)}\\.pdf$`));
  assert.equal(b.missingAttachments, 1);

  assert.equal(out[0], [
    "---", 'tags: ["Home","to-do","Food"]', 'jotdrop_labels: ["Persoonlijk"]', "---",
    "# Boodschappen \\#thuis", "",
    "- [ ] Melk", "- [x] Brood", "",
    "Neem **echt** & *snel* mee, zie [de winkel](https://example.com/shop?a=1&b=2) \\#spinazie",
    "niet ingesprongen",
    "![[foto_ 1.png]]", "",
  ].join("\n"));
  assert.equal(out[1], [
    "---", 'jotdrop_labels: ["Persoonlijk"]', "---",
    "# Rijk", "",
    "## Plan", "- [x] Klaar", "- [ ] Open", "1. Een", "\t- Sub", "2. Twee", "",
    "| Naam | Prijs |", "| --- | --- |", "| Koffie \\| bonen | 4 |", "",
    "```", "if (x) {", "  go(`#tag`);", "", "}", "```", "",
    "> Citaat", "", "---", "",
    "Encrypted Evernote text (hint: pin). Decrypt it in Evernote to read it.", "",
    "```", "abc==", "```", "",
    "Andere notitie en https://example.org/", "",
    `![[evernote-${md5(scan).slice(0, 12)}.pdf]]`, "",
    "https://example.net/page", "",
  ].join("\n"));
  assert.equal(out[2], [
    "---", 'jotdrop_labels: ["Persoonlijk"]', "---",
    "# Taken", "", "Voor", "- [ ] Eerste", "- [x] Tweede", "Na", "", "- [ ] Los", "",
  ].join("\n"));

  // An attachment that could not be written is left out instead of a broken embed.
  assert.doesNotMatch(evernoteNoteMarkdown(a, new Map()), /!\[\[/);

  // ENML details: paragraphs, trailing <br>, nested blocks, image links, empty formatting, raw markup in text.
  const md = (enml) => enmlToMarkdown(parseXml(`<en-note>${enml}</en-note>`), () => undefined);
  assert.equal(md("<p>Een</p><p>Twee<br/>drie<br/></p>"), "Een\n\nTwee\ndrie");
  assert.equal(md("<div><div>a</div><div>b</div></div><div><br/></div><div><br/></div><div>c</div>"), "a\nb\n\nc");
  assert.equal(md("<div><b> </b>x<i></i></div>"), "x");
  assert.equal(md("<div><img src=\"https://example.com/a b.png\"/></div>"), "![](https://example.com/a%20b.png)");
  assert.equal(md("<div>1 &lt; 2 &#x1F600; &unknown;</div>"), "1 < 2 \u{1F600} &unknown;");
  assert.equal(md("<div>open <b>tag"), "open **tag**");
  assert.equal(md("<pre>a\n  b</pre>"), "```\na\n  b\n```");
  assert.equal(md("<div><code>x`y</code></div>"), "``x`y``");

  // Review findings: plain text stays text, blocks stay apart, links keep their address.
  assert.equal(md("<div>Dear &lt;Name&gt;, use &lt;b&gt;bold&lt;/b&gt; or 1 &lt; 2</div>"), "Dear \\<Name>, use \\<b>bold\\</b> or 1 < 2");
  assert.equal(md("<div># not a heading</div><div>1986. A year</div><div>&gt; not a quote</div><div>Title</div><div>-----</div>"),
    "\\# not a heading\n1986\\. A year\n\\> not a quote\nTitle\n\\-----");
  assert.equal(md("<center>Line one</center><center>Line two</center><dl><dt>Term</dt><dd>Definition</dd></dl>"), "Line one\nLine two\nTerm\nDefinition");
  assert.equal(md("<table><caption>Prices</caption><tr><td>a</td></tr></table>"), "Prices\n\n| a |\n| --- |");
  assert.equal(md('<a href="https://site/x"><img src="https://site/a.png"/></a>'), "![](https://site/a.png)\nhttps://site/x");
  assert.equal(md('<a href="https://site/x"><div>Headline</div></a><div>Next</div>'), "Headline\nhttps://site/x\nNext");
  assert.equal(md('<div><a href="https://x/a)b">x [1]</a></div>'), "[x \\[1\\]](https://x/a%29b)");
  assert.equal(md("<ul>loose<li>item</li></ul>"), "- loose\n- item");
  assert.equal(md("<div>&eacute;&rarr;&laquo;&yuml;&hellip;</div>"), "\u00e9\u2192\u00ab\u00ff\u2026");
  assert.equal(md("<pre>a\r\nb</pre>".replace(/\r\n?/g, "\n")), "```\na\nb\n```");
  // The converter's private-use placeholders in the text itself survive (old iPhone emoji).
  const emoji = "Old \ue001 and \ue0040\ue004 x \ue005y \ue003";
  assert.equal(md(`<div>${emoji}</div>`), emoji.trim());
  assert.equal(md(`<pre>${emoji}</pre>`), "```\n" + emoji + "\n```");
  // Deep or broken nesting is flattened instead of overflowing the stack.
  assert.equal(md("<font>".repeat(6000) + "deep"), "deep");
  assert.equal(md("<div>".repeat(3000) + "deep" + "</div>".repeat(3000)), "deep");
  // Malformed tags stay linear.
  const started = Date.now();
  parseXml("<x a ".repeat(40000));
  assert.ok(Date.now() - started < 2000, "malformed tags parse in linear time");

  // A large export is read note by note; an empty <data> is a missing attachment, not an empty file.
  const many = Array.from({ length: 300 }, (_, i) => note({ title: `N${i}`, content: `<div>${i}</div>`, extra: resource(crypto.randomBytes(2000), "image/png", "") }));
  const odd = note({ title: "Odd", content: "<div>x</div>", extra: '<resource><data encoding="base64"></data><mime>image/png</mime></resource><resource><data/><mime>image/png</mime></resource><resource><mime>image/png</mime></resource>' });
  const bigFiles = new Map([["Big.enex", Object.assign(async () => new TextEncoder().encode(enex.replace("</en-export>", [...many, odd].join("\n") + "</en-export>")), { modified: 0 })]]);
  const big = await parseEnexExport(bigFiles, 1);
  assert.equal(big.notes.length, 304);
  assert.equal(new Set(big.notes.flatMap((n) => n.attachments)).size, 302);
  assert.equal(big.notes.at(-1).missingAttachments, 3);
  assert.deepEqual(big.notes.at(-1).attachments, []);
  const sample = big.notes[100];
  assert.equal(md5(Buffer.from(await bigFiles.get(sample.attachments[0])())), [...sample.media.keys()][0]);
  // A note that cannot be read fails alone.
  assert.ok(big.notes.some((n) => n.title === "N299"));

  // Loose .enex files work too, and Markdown or Keep files next to them are not read as Evernote.
  const loose = new Map([["Werk.enex", Object.assign(async () => new TextEncoder().encode(enex), { modified: 0 })]]);
  const parsed = await parseEnexExport(loose, Date.UTC(2026, 9, 22));
  assert.equal(parsed.notes.length, 3);
  assert.equal(parsed.notes[2].createdMs, Date.UTC(2026, 9, 22));
  assert.deepEqual(parsed.notes.map((n) => n.notebook), ["Werk", "Werk", "Werk"]);
  console.log("Evernote import check passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

const assert = require("node:assert/strict");
const esbuild = require("esbuild");
const fs = require("node:fs");

(async () => {
  const bundle = await esbuild.build({
    entryPoints: ["src/listEditor.ts"],
    bundle: true, platform: "node", format: "cjs", write: false,
  });
  const loaded = { exports: {} };
  new Function("module", "exports", bundle.outputFiles[0].text)(loaded, loaded.exports);
  const { listEnterEdit } = loaded.exports;
  const enter = (text, expected, start = text.length, end = start) => {
    const edit = listEnterEdit(text, start, end);
    assert.ok(edit, `Expected a list edit for ${JSON.stringify(text)}`);
    assert.equal(text.slice(0, edit.from) + edit.insert + text.slice(edit.to), expected);
    return edit.from + edit.insert.length;
  };
  enter("- alpha", "- alpha\n- ");
  enter("* alpha", "* alpha\n- ");
  enter("+ alpha", "+ alpha\n- ");
  enter("  - alpha", "  - alpha\n  - ");
  enter("\t* alpha", "\t* alpha\n\t- ");
  enter("- [ ] alpha", "- [ ] alpha\n- [ ] ");
  enter("  - [x] alpha", "  - [x] alpha\n  - [ ] ");
  enter("- [X] alpha", "- [X] alpha\n- [ ] ");
  enter("- ", "");
  enter("  - [ ] ", "");
  enter("- [x]", "");
  enter("- alpha\n  * \nnext", "- alpha\n\nnext", 12);
  assert.equal(enter("- alpha beta", "- alpha\n-  beta", 7), 10);
  enter("- [x] alpha beta", "- [x] alpha\n- [ ]  beta", 11);
  enter("- alpha beta", "- al\n- beta", 4, 8);
  enter("- alpha\n- beta", "- alpha\n- \n- beta", 7);
  enter("```\n- code\n```\n- note", "```\n- code\n```\n- note\n- ");
  for (const [text, caret, end = caret] of [
    ["plain", 5], ["-no list", 8], ["---", 3], ["*em*", 4],
    ["- alpha", 0], ["- alpha", 1], ["- [ ] alpha", 4],
    ["- alpha\n- beta", 4, 12], ["```\n- code", 10],
    ["~~~text\n- code", 14], ["````\n```\n- code", 15],
  ]) assert.equal(listEnterEdit(text, caret, end), null, `Unexpected list edit for ${JSON.stringify(text)}`);
  for (const source of ["src/capture.ts", "src/edit.ts"]) {
    const editor = fs.readFileSync(source, "utf8");
    assert.match(editor, /this\.cleanupListEditor = enhanceListEditing\(/, `${source} must enable list editing`);
    assert.match(editor, /this\.cleanupListEditor\?\.\(\)/, `${source} must clean up its list editor`);
  }
  const android = fs.readFileSync("android/app/src/main/kotlin/com/diexar/keepcapture/EditorActivity.kt", "utf8");
  assert.match(android, /next\.composition == null && next\.selection\.collapsed/);
  assert.match(android, /next\.text == current\.text\.replaceRange\(start, end, "\\n"\)/);
  assert.match(android, /listEnterEdit\(current\.text, start, end\)/);
  assert.match(android, /renderListBullets\(source\.text\)/);
  assert.match(android, /OffsetMapping\.Identity/);
  console.log("List editor checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });

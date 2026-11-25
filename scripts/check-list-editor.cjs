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
    return edit.selFrom;
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
  // An empty item in a level goes one level back first (design kaarten-en-lijsten, part 7); the caret goes along.
  assert.equal(enter("- alpha\n  * \nnext", "- alpha\n* \nnext", 12), 10);
  enter("- alpha\n\t- [ ] ", "- alpha\n- [ ] ");
  // Numbered lists, from the shared core.
  enter("1. one", "1. one\n2. ");
  enter("1. one\n2. ", "1. one\n");
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
  // A formatted line that is no list keeps an ordinary Enter in the raw text box (no signs carried on).
  assert.equal(listEnterEdit("**bold**", 6), null);
  for (const source of ["src/capture.ts", "src/edit.ts"]) {
    const editor = fs.readFileSync(source, "utf8");
    assert.match(editor, /this\.cleanupListEditor = enhanceListEditing\(/, `${source} must enable list editing`);
    assert.match(editor, /this\.cleanupListEditor\?\.\(\)/, `${source} must clean up its list editor`);
    // The Checklist button goes through the shared core, with the setting "Move checked items to the bottom".
    assert.match(editor, /toggleChecklistOnTextArea\(this\.\w+, this\.plugin\.settings\.moveChecked\)/, `${source} must use the shared Checklist button`);
  }
  // Tab and Shift+Tab, and the Checklist button, in a real text box (jsdom-free: a small stand-in with the same calls).
  const { toggleChecklistOnTextArea, enhanceListEditing } = loaded.exports;
  const fakeArea = (value, start, end = start) => {
    const listeners = {};
    const area = {
      value, selectionStart: start, selectionEnd: end, clientWidth: 100, clientHeight: 100, scrollTop: 0, scrollLeft: 0,
      ownerDocument: {
        execCommand: (command, _ui, text) => {
          area.value = area.value.slice(0, area.selectionStart) + text + area.value.slice(area.selectionEnd);
          area.selectionStart = area.selectionEnd = area.selectionStart + text.length;
          return true;
        },
        createElement: () => ({ className: "", style: {}, setAttribute() {}, append() {}, replaceChildren() {}, after() {}, before() {}, replaceWith() {} }),
        createTextNode: () => ({}),
      },
      setSelectionRange(from, to) { area.selectionStart = from; area.selectionEnd = to; },
      focus() {},
      before() {},
      addEventListener(type, listener) { listeners[type] = listener; },
      removeEventListener() {},
      dispatchEvent() {},
      key(key, shift = false) {
        const event = { key, shiftKey: shift, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, prevented: false, preventDefault() { this.prevented = true; } };
        listeners.keydown(event);
        return event.prevented;
      },
    };
    return area;
  };
  global.ResizeObserver = class { observe() {} disconnect() {} };
  const area = fakeArea("- a\n- b", 7);
  enhanceListEditing(area);
  assert.equal(area.key("Tab"), true);
  assert.equal(area.value, "- a\n\t- b");
  assert.equal(area.selectionStart, 8);
  assert.equal(area.key("Tab", true), true);
  assert.equal(area.value, "- a\n- b");
  // The first item cannot go in, but Tab stays in the text on a list line; off a list it leaves the box.
  area.selectionStart = area.selectionEnd = 0;
  assert.equal(area.key("Tab"), true);
  assert.equal(area.value, "- a\n- b");
  area.value = "plain";
  area.selectionStart = area.selectionEnd = 5;
  assert.equal(area.key("Tab"), false);
  const box = fakeArea("- a\n\t- b", 8);
  toggleChecklistOnTextArea(box, false);
  assert.equal(box.value, "- a\n\t- [ ] b");
  const move = fakeArea("- [ ] a\n- [ ] b", 3);
  toggleChecklistOnTextArea(move, true);
  assert.equal(move.value, "- [ ] b\n- [x] a");
  delete global.ResizeObserver;
  const android = fs.readFileSync("android/app/src/main/kotlin/com/diexar/keepcapture/EditorActivity.kt", "utf8");
  assert.match(android, /next\.composition == null && next\.selection\.collapsed/);
  assert.match(android, /next\.text == current\.text\.replaceRange\(start, end, "\\n"\)/);
  assert.match(android, /listEnterEdit\(current\.text, start, end\)/);
  // The body is drawn by FormatTransformation (formatting editor, phase 3): list signs as bullets, and every source
  // offset kept, so the list Enter above works on the same positions.
  assert.match(android, /FormatTransformation\(formatted,/);
  // Typing on at the bottom keeps the caret above the keyboard and the formatting bar (Eric, 16 Nov).
  assert.match(android, /caretView\.bringIntoView\(/);
  assert.match(android, /Modifier\.bringIntoViewRequester\(caretView\)/);
  assert.match(android, /onTextLayout = \{ bodyLayout = it; bands\.layout = it \}/);
  const transformation = fs.readFileSync("android/app/src/main/kotlin/com/diexar/keepcapture/FormatTransformation.kt", "utf8");
  assert.match(transformation, /renderListBullets\(source\)/);
  assert.match(transformation, /OffsetMapping\.Identity/);
  console.log("List editor checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });

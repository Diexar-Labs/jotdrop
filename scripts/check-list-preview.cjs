const esbuild = require("esbuild");

(async () => {
  const result = await esbuild.build({
    stdin: {
      contents: 'export { checklistToGlyphs, renderInlinePreview, toggleChecklistItem } from "./src/metadata.ts";',
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    plugins: [{
      name: "obsidian-stub",
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: 'export const getLanguage = () => "en";',
        }));
      },
    }],
  });

  const loaded = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(loaded, loaded.exports, require);
  const { checklistToGlyphs, renderInlinePreview, toggleChecklistItem } = loaded.exports;

  const input = [
    "- alpha",
    "* beta",
    "+ gamma",
    "  - nested bullet",
    "    1. nested ordered",
    "2) second ordered",
    "- [ ] root task",
    "  - [x] nested task",
    "- [link](https://example.com)",
  ].join("\n");
  const expected = [
    "• alpha",
    "• beta",
    "• gamma",
    "  • nested bullet",
    "    1. nested ordered",
    "2. second ordered",
    "☐ root task",
    "  ☑ nested task",
    "• [link](https://example.com)",
  ].join("\n");

  if (checklistToGlyphs(input) !== expected) throw new Error("list normalization mismatch");
  if (checklistToGlyphs(expected) !== expected) throw new Error("normalization is not idempotent");
  const untouched = "---\n-no\n*em*\n1234567890) no";
  if (checklistToGlyphs(untouched) !== untouched) throw new Error("non-list text changed");

  const nodes = [];
  const parent = {
    appendText(text) { nodes.push({ kind: "text", text }); },
    createEl(tag, options) {
      const element = { kind: "element", tag, options, dataset: {} };
      nodes.push(element);
      return element;
    },
    createSpan(options) {
      const element = { kind: "span", options, dataset: {} };
      nodes.push(element);
      return element;
    },
  };
  renderInlinePreview(parent, "- [ ] root\n  - [x] nested");
  const buttons = nodes.filter((node) => node.kind === "element");
  if (buttons.length !== 2 || buttons[0].dataset.checklistIndex !== "0" || buttons[1].dataset.checklistIndex !== "1") {
    throw new Error("checklist indices mismatch");
  }
  if (!nodes.some((node) => node.kind === "text" && node.text === "  ")) {
    throw new Error("nested indentation missing");
  }

  const toggled = toggleChecklistItem("# Lists\n- [ ] root\n  - [x] nested\n", 1);
  if (toggled !== "# Lists\n- [ ] root\n  - [ ] nested\n") throw new Error("nested toggle mismatch");
  console.log("Markdown list preview checks passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

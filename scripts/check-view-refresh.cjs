// Run: node scripts/check-view-refresh.cjs. The JotDrop view redraws only for changes it can show: a tool that writes
// files elsewhere in the vault (a session log every few seconds) must not make the whole view flicker.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const esbuild = require("esbuild");

(async () => {
  const result = await esbuild.build({
    stdin: { contents: 'export { affectsView } from "./src/fileKinds.ts";', resolveDir: process.cwd() },
    bundle: true, platform: "node", format: "cjs", write: false,
    plugins: [{ name: "refresh-obsidian-mock", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "refresh-test" }));
      build.onLoad({ filter: /.*/, namespace: "refresh-test" }, () => ({ contents: "export class TFile {}; export const setIcon = () => {}; export const getLanguage = () => 'en';" }));
    } }],
  });
  const loaded = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(loaded, loaded.exports, require);
  const { affectsView } = loaded.exports;
  const folders = ["Mini Notes", "Mini Notes/Archive", "Mini Notes/.attachments"];

  for (const path of ["Mini Notes/2026-11-14 Groceries.md", "Mini Notes/Archive/Old.md", "Mini Notes/Trash/Gone.md", "Mini Notes/.attachments/photo.jpg", "Mini Notes"])
    assert.equal(affectsView(path, folders), true, `${path} is shown`);
  for (const path of ["_Assets/photo.jpg", "Pictures/memo.m4a", "Scans/bill.pdf", "Excalidraw/Drawing 1.excalidraw.md", "Drawing.excalidraw"])
    assert.equal(affectsView(path, folders), true, `${path} can be embedded in a card`);
  for (const path of ["Conversations/Claude/2026-11-14 1214 - summary.md", "Conversations/Claude/_pending/abc.jsonl", ".obsidian/workspace.json", "Daily/2026-11-14.md", "Mini Notes Old/x.md", "data.csv"])
    assert.equal(affectsView(path, folders), false, `${path} does not change the view`);

  const main = fs.readFileSync("src/main.ts", "utf8");
  for (const event of ["create", "delete", "modify"])
    assert.match(main, new RegExp(`vault\\.on\\("${event}"[\\s\\S]{0,400}?if \\(this\\.affectsView\\((f|file)\\.path\\)\\) this\\.refreshViews\\(\\);`), `${event} redraws only for its own files`);
  assert.match(main, /vault\.on\("rename"[\s\S]{0,400}?if \(this\.affectsView\(f\.path\) \|\| this\.affectsView\(oldPath\)\) this\.refreshViews\(\);/, "a rename into or out of the notes redraws");
  assert.doesNotMatch(main.slice(main.indexOf('vault.on("create"'), main.indexOf("onLayoutReady")), /^\s*this\.refreshViews\(\);$/m, "no event redraws for every file");
  console.log("check-view-refresh: ok");
})().catch((error) => { console.error(error); process.exit(1); });

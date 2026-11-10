// Excalidraw drawings on a card (read only): recognising them, finding the export next to them,
// the Excalidraw plugin as fallback, and never opening a drawing in the JotDrop editor.
const assert = require("node:assert/strict");
const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const source = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

(async () => {
  const result = await esbuild.build({
    stdin: { contents: `export { isDrawingLink, drawingTitle, exportPathsFor, drawingEmbedBeforeImage, ExcalidrawPreviews } from "./src/excalidraw.ts";`, resolveDir: ROOT },
    bundle: true, platform: "node", format: "cjs", write: false,
    alias: { obsidian: path.join(__dirname, "mock-obsidian.cjs") },
  });
  const loaded = { exports: {} };
  global.window = global; // the module uses window.setTimeout and window.ExcalidrawAutomate
  new Function("module", "exports", "require", result.outputFiles[0].text)(loaded, loaded.exports, require);
  const { isDrawingLink, drawingTitle, exportPathsFor, drawingEmbedBeforeImage, ExcalidrawPreviews } = loaded.exports;

  // Links: the plugin's own names only; folders and #subpaths are fine.
  assert.equal(isDrawingLink("Sketch.excalidraw"), true);
  assert.equal(isDrawingLink("Sketch.excalidraw.md"), true);
  assert.equal(isDrawingLink("Drawings/Sketch.EXCALIDRAW"), true);
  assert.equal(isDrawingLink("Sketch.excalidraw#^group=abc"), true);
  assert.equal(isDrawingLink("Sketch"), false);
  assert.equal(isDrawingLink("Sketch.excalidraw.png"), false);
  assert.equal(isDrawingLink("excalidraw.md"), false);

  assert.equal(drawingTitle("Sketch.excalidraw"), "Sketch");
  assert.equal(drawingTitle("Plan.v2.excalidraw"), "Plan.v2");
  assert.equal(drawingTitle("Plain note"), "Plain note");
  assert.deepEqual(exportPathsFor("Excalidraw/Sketch.excalidraw.md"), ["Excalidraw/Sketch.excalidraw.png", "Excalidraw/Sketch.excalidraw.svg"]);

  // A drawing embed takes the picture slot only when it comes before the first photo.
  assert.equal(drawingEmbedBeforeImage("Text\n\n![[Sketch.excalidraw]]\n"), "Sketch.excalidraw");
  assert.equal(drawingEmbedBeforeImage("![[a.excalidraw.md|300]]"), "a.excalidraw.md");
  assert.equal(drawingEmbedBeforeImage("![[Sketch.excalidraw#^group=x]]"), "Sketch.excalidraw");
  assert.equal(drawingEmbedBeforeImage("![[photo.jpg]]\n![[Sketch.excalidraw]]"), null);
  assert.equal(drawingEmbedBeforeImage("![](photo.png)\n![[Sketch.excalidraw]]"), null);
  assert.equal(drawingEmbedBeforeImage("![[Sketch.excalidraw]]\n![[photo.jpg]]"), "Sketch.excalidraw");
  assert.equal(drawingEmbedBeforeImage("![[Sketch.excalidraw.png]]"), null); // an ordinary image already shows
  assert.equal(drawingEmbedBeforeImage("![[Sketch]]"), null);
  assert.equal(drawingEmbedBeforeImage("[[Sketch.excalidraw]]"), null); // a link, not an embed

  // Drawing files: by name, or by the plugin's frontmatter key.
  const files = new Map();
  const file = (p, mtime, frontmatter) => { const f = { path: p, name: p.split("/").pop(), basename: p.split("/").pop().replace(/\.md$/, ""), stat: { mtime } }; files.set(p, f); f.frontmatter = frontmatter; return f; };
  const app = {
    metadataCache: {
      getFileCache: (f) => (f.frontmatter ? { frontmatter: f.frontmatter } : null),
      getFirstLinkpathDest: (link) => files.get(link.includes("/") ? link : `Excalidraw/${link}`) ?? files.get(`Excalidraw/${link}.md`) ?? null,
    },
    vault: { getFileByPath: (p) => files.get(p) ?? null, getResourcePath: (f) => `app://x/${f.path}` },
  };
  const previews = new ExcalidrawPreviews(app);
  const drawing = file("Excalidraw/Sketch.excalidraw.md", 10_000);
  const renamed = file("Notes/odd.md", 1, { "excalidraw-plugin": "parsed" });
  const note = file("Notes/plain.md", 1);
  assert.equal(previews.isDrawingFile(drawing), true);
  assert.equal(previews.isDrawingFile(renamed), true);
  assert.equal(previews.isDrawingFile(note), false);
  assert.equal(previews.resolveDrawing("Sketch.excalidraw", note), drawing);
  assert.equal(previews.resolveDrawing("Sketch.excalidraw#^group=1", note), drawing);
  assert.equal(previews.resolveDrawing("plain", note), null);

  // Export next to the drawing: PNG first, and fresh only when not older than the drawing.
  assert.equal(previews.findExport(drawing), null);
  const svg = file("Excalidraw/Sketch.excalidraw.svg", 10_500);
  assert.deepEqual(previews.findExport(drawing), { file: svg, fresh: true });
  const png = file("Excalidraw/Sketch.excalidraw.png", 7_000);
  assert.deepEqual(previews.findExport(drawing), { file: png, fresh: false });
  png.stat.mtime = 9_000; // written 1 s before the save finished: still the same drawing
  assert.equal(previews.findExport(drawing).fresh, true);
  // Can a picture be had at all? With an export yes; otherwise only when the plugin is on.
  app.plugins = { enabledPlugins: new Set() };
  assert.equal(previews.canPicture(drawing), true);
  const lonely = file("Excalidraw/Lonely.excalidraw.md", 1);
  assert.equal(previews.canPicture(lonely), false);
  app.plugins = { enabledPlugins: new Set(["obsidian-excalidraw-plugin"]) };
  assert.equal(previews.canPicture(lonely), true);

  // The plugin as fallback: not ready at first (retried), cached per file version, never when absent.
  let calls = 0; let failuresLeft = 2; let created = 0;
  global.ExcalidrawAutomate = { createPNG: async () => { calls++; if (failuresLeft-- > 0) throw new Error("plugin not ready"); return new Blob([new Uint8Array(10)], { type: "image/png" }); }, reset() {} };
  app.plugins = { enabledPlugins: new Set(["obsidian-excalidraw-plugin"]) };
  const url = await previews.render(drawing);
  assert.match(url, /^blob:/);
  assert.equal(calls, 3);
  assert.equal(await previews.render(drawing), url);
  assert.equal(calls, 3, "same file version comes from the cache");
  drawing.stat.mtime = 20_000;
  assert.match(await previews.render(drawing), /^blob:/);
  assert.equal(calls, 4, "a changed drawing is drawn again");

  // getAPI gives an own instance, so a user's script state is not touched.
  let ownUsed = false; let sharedUsed = false;
  global.ExcalidrawAutomate = { createPNG: async () => { sharedUsed = true; return new Blob([new Uint8Array(1)]); }, getAPI: () => ({ createPNG: async () => { ownUsed = true; return new Blob([new Uint8Array(1)]); } }) };
  drawing.stat.mtime = 30_000;
  await previews.render(drawing);
  assert.equal(ownUsed, true);
  assert.equal(sharedUsed, false);

  // Without the plugin: null at once, and no endless waiting.
  delete global.ExcalidrawAutomate;
  app.plugins = { enabledPlugins: new Set() };
  drawing.stat.mtime = 40_000;
  const t0 = Date.now();
  assert.equal(await previews.render(drawing), null);
  assert.ok(Date.now() - t0 < 1000);
  previews.dispose();

  // Wiring: cards, search, navigation and the editor never treat a drawing as a note.
  const view = source("src/view.ts");
  assert.match(view, /if \(this\.plugin\.excalidraw\.isDrawingFile\(file\)\) \{\s*void this\.app\.workspace\.getLeaf\("tab"\)\.openFile\(file\);\s*return;\s*\}/);
  assert.match(view, /\]\.filter\(\(c\) => !c\.isDrawing\)\.map\(\(c\) => c\.file\);/);
  assert.match(view, /\(!card\.isDrawing && card\.content\.toLowerCase\(\)\.includes\(q\)\)/);
  assert.match(view, /meta\.tags = meta\.tags\.filter\(\(tag\) => tag\.toLowerCase\(\) !== "excalidraw"\)/);
  assert.match(view, /const titleText = isDrawing \? drawingTitle\(file\.basename\)/);
  assert.match(view, /const urls = isDrawing \? \[\] : extractUrls\(content\)/);
  assert.match(view, /const thumbnailBasename = drawing \? null : firstImage;/);
  assert.match(view, /!firstImage \|\| this\.plugin\.excalidraw\.canPicture\(embeddedDrawing\)/);
  assert.match(source("src/main.ts"), /this\.excalidraw = new ExcalidrawPreviews\(this\.app\)/);
  assert.match(source("src/main.ts"), /this\.excalidraw\?\.dispose\(\)/);
  // Words, never only an icon, and nothing is written to the vault by this feature.
  assert.match(view, /wrap\.createSpan\(\{ cls: "jotdrop-card-drawing-label", text: label \}\)/);
  assert.doesNotMatch(source("src/excalidraw.ts"), /vault\.(create|modify|process|delete|rename|trash)|adapter\.write|createBinary/);
  assert.match(source("src/i18n.ts"), /excalidraw_card_label: "Excalidraw drawing"/);
  assert.match(source("src/i18n.ts"), /excalidraw_card_label: "Excalidraw-tekening"/);
  console.log("Excalidraw checks passed");
})().catch((error) => { console.error(error); process.exit(1); });

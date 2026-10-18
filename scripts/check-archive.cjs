// Run: node scripts/check-archive.cjs. No real vault or plugin artifact is written.
const assert = require("node:assert/strict");
const esbuild = require("esbuild");

(async () => {
  const result = await esbuild.build({
    stdin: { contents: 'export { JotDropView } from "./src/view.ts"; export { TFile, Notice } from "obsidian";', resolveDir: process.cwd() },
    bundle: true, platform: "node", format: "cjs", write: false,
    plugins: [{ name: "archive-obsidian-mock", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "archive-test" }));
      build.onLoad({ filter: /.*/, namespace: "archive-test" }, () => ({ contents: `
        export class ItemView {}; export class Modal {}; export class SuggestModal {}; export class TFile {}; export class TFolder {};
        export class Notice { static messages = []; constructor(message) { Notice.messages.push(message); } }
        export class Menu {}; export class Setting {}; export class FileSystemAdapter {};
        export const normalizePath = p => p;
        export const getLanguage = () => "en"; export const setIcon = () => {}; export const Platform = {};
        export const requestUrl = () => { throw new Error("Unexpected network access"); };
      ` }));
    } }],
  });
  const loaded = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(loaded, loaded.exports, require);
  const { JotDropView, TFile, Notice } = loaded.exports;
  const name = "2026-10-18 120000 Google Play Closed Testing Professional.md";

  function fixture(paths, archiveExists = true) {
    const files = new Map(paths.map(([path, content]) => {
      const name = path.split("/").pop();
      return [path, Object.assign(new TFile(), { path, name, basename: name.slice(0, -3), extension: "md", content })];
    }));
    const folders = new Set(["Mini Notes", ...(archiveExists ? ["Mini Notes/Archive"] : [])]);
    const view = Object.create(JotDropView.prototype);
    let refreshes = 0, renamed = 0, bulk;
    view.app = {
      vault: {
        getAbstractFileByPath: path => files.get(path) || (folders.has(path) ? { path } : null),
        async createFolder(path) { folders.add(path); },
      },
      fileManager: { async renameFile(file, target) {
        assert.ok(!files.has(target), "Never overwrite an existing note");
        assert.ok(folders.has(target.slice(0, target.lastIndexOf("/"))), "Destination must exist");
        files.delete(file.path);
        file.path = target; file.name = target.split("/").pop(); file.basename = file.name.slice(0, -3);
        files.set(target, file); renamed++;
      } },
    };
    view.plugin = { settings: { notesFolder: "Mini Notes", archiveFolder: "Mini Notes/Archive" }, refreshViews() { refreshes++; } };
    view.exitSelection = () => {};
    view.reportBulkResult = (key, ok, fail) => { bulk = { ok, fail }; };
    return { view, files, folders, get refreshes() { return refreshes; }, get renamed() { return renamed; }, get bulk() { return bulk; } };
  }

  const source = `Mini Notes/${name}`, target = `Mini Notes/Archive/${name}`;
  const suffix = number => target.replace(/\.md$/, ` (${number}).md`);
  const content = "---\norder: 123\n---\n# Google Play Closed Testing | Professional App Testing Service\n![[shared.jpg]]\n";
  const collision = fixture([[source, content], [target, "Existing archived note"], [suffix(1), "Another archived note"]]);
  await collision.view.toggleArchive(collision.files.get(source), false);
  assert.equal(collision.files.get(suffix(2))?.content, content, "Archive must preserve both notes on a name collision");
  assert.equal(collision.files.get(target).content, "Existing archived note");
  assert.equal(collision.files.get(suffix(1)).content, "Another archived note");
  assert.equal(collision.files.has(source), false);
  assert.equal(collision.refreshes, 1);

  const normal = fixture([[source, content]], false);
  await normal.view.toggleArchive(normal.files.get(source), false);
  assert.equal(normal.files.get(target)?.content, content, "An unused filename must stay unchanged");
  assert.ok(normal.folders.has("Mini Notes/Archive"));

  const restore = fixture([[source, "An existing active note"], [target, content]]);
  await restore.view.toggleArchive(restore.files.get(target), true);
  assert.equal(restore.files.get(source.replace(/\.md$/, " (1).md"))?.content, content, "Restore must also preserve name collisions");
  assert.equal(restore.files.get(source).content, "An existing active note");

  const bulk = fixture([[`Mini Notes/A/${name}`, "First note"], [`Mini Notes/B/${name}`, "Second note"], [target, "Original archive"]]);
  bulk.view.selectedPaths = new Set([`Mini Notes/A/${name}`, `Mini Notes/B/${name}`]);
  await bulk.view.bulkArchive();
  assert.deepEqual(bulk.bulk, { ok: 2, fail: 0 });
  assert.equal(bulk.files.get(suffix(1))?.content, "First note");
  assert.equal(bulk.files.get(suffix(2))?.content, "Second note");
  assert.equal(bulk.files.get(target).content, "Original archive");
  bulk.view.selectedPaths = new Set([target]);
  await bulk.view.bulkArchive();
  assert.equal(bulk.renamed, 2, "Already archived selections must not be renamed again");

  const failure = fixture([[source, content]]);
  failure.view.app.fileManager.renameFile = async () => { throw new Error("Synthetic permission failure"); };
  await failure.view.toggleArchive(failure.files.get(source), false);
  assert.equal(failure.files.get(source).content, content);
  assert.equal(failure.files.has(target), false);
  assert.match(Notice.messages.at(-1), /Synthetic permission failure/);
  console.log("Archive checks passed: collisions, preservation, restore, bulk, no-op and errors");
})().catch(error => { console.error(error); process.exitCode = 1; });

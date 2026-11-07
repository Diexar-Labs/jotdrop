const assert = require("node:assert/strict");
const esbuild = require("esbuild");

(async () => {
  const bundle = await esbuild.build({
    entryPoints: ["src/previewRescue.ts"],
    bundle: true, platform: "node", format: "cjs", external: ["obsidian"], write: false,
  });
  const loaded = { exports: {} };
  const stub = (name) => (name === "obsidian" ? { normalizePath: (p) => p, requestUrl: async () => ({}) } : require(name));
  new Function("module", "exports", "require", bundle.outputFiles[0].text)(loaded, loaded.exports, stub);
  const { keepTextAfterPending } = loaded.exports;
  const pending = "<!-- jotdrop-preview: pending -->";
  // 7 Nov: tasks typed on a card while its link preview waited vanished in the rewrite.
  assert.equal(keepTextAfterPending(`# u\n\n${pending}\n\n- [x] a\n- [ ] b\n`, "# T\n\n[T](u)"), "# T\n\n[T](u)\n\n- [x] a\n- [ ] b");
  assert.equal(keepTextAfterPending(`# u\n\n${pending}`, "# T"), "# T");
  assert.equal(keepTextAfterPending("# u", "# T"), "# T");
  assert.equal(keepTextAfterPending("<!-- obsidrop-preview: pending -->\nx", "# T"), "# T\n\nx");
  console.log("Preview rescue checks passed");
})().catch((error) => { console.error(error); process.exit(1); });

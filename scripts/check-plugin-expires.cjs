// `expires` in the Obsidian plugin: read only as a real date, written and cleared through updateMeta,
// and the card badge text. The same rules as cloud/shared/paper.mjs (Paper drawer).
const esbuild = require("esbuild");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const mockObsidianPath = path.join(__dirname, "mock-obsidian.cjs");

(async () => {
  const result = await esbuild.build({
    stdin: {
      contents: `export { readMeta, updateMeta, formatExpiresBadge } from "./src/metadata.ts";`,
      resolveDir: ROOT,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    alias: { obsidian: mockObsidianPath },
  });
  const loaded = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(loaded, loaded.exports, require);
  const { readMeta, updateMeta, formatExpiresBadge } = loaded.exports;

  const fail = (message) => { console.error("FAIL: " + message); process.exit(1); };
  const file = { path: "notes/a.md" };
  const app = (frontmatter) => ({
    metadataCache: { getFileCache: () => ({ frontmatter }) },
    fileManager: { processFrontMatter: async (_file, fn) => fn(frontmatter) },
  });

  if (readMeta(app({ expires: "2027-03-12" }), file).expires !== "2027-03-12") fail("reads a valid date");
  for (const bad of ["2027-02-29", "12-03-2027", 20270312, ""]) {
    if (readMeta(app({ expires: bad }), file).expires !== null) fail(`ignores ${JSON.stringify(bad)}`);
  }
  if (readMeta(app({}), file).expires !== null) fail("missing is null");

  const fm = { title: "keep me", reminder: "2027-01-01T09:00" };
  await updateMeta(app(fm), file, { expires: "2027-03-12" });
  if (fm.expires !== "2027-03-12" || fm.title !== "keep me" || fm.reminder !== "2027-01-01T09:00") fail("sets expires, keeps the rest");
  await updateMeta(app(fm), file, { color: "red" });
  if (fm.expires !== "2027-03-12") fail("other edits keep expires");
  await updateMeta(app(fm), file, { expires: "not a date" });
  if ("expires" in fm) fail("an invalid date clears expires");
  fm.expires = "2027-03-12";
  await updateMeta(app(fm), file, { expires: null });
  if ("expires" in fm) fail("null clears expires");

  const future = formatExpiresBadge("2999-03-12");
  if (!future || future.expired || future.text !== "📅 Expires 12 Mar 2999") fail(`future badge: ${JSON.stringify(future)}`);
  const past = formatExpiresBadge("2001-01-05");
  if (!past || !past.expired || past.text !== "📅 Expired 5 Jan 2001") fail(`past badge: ${JSON.stringify(past)}`);
  if (formatExpiresBadge(null) !== null) fail("no badge without a date");

  console.log("check-plugin-expires: all checks passed");
})().catch((err) => { console.error(err); process.exit(1); });

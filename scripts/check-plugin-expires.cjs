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

  // Paper drawer texts: English straight from cloud/shared/paper.mjs, Dutch complete, no em-dashes.
  const i18nBuild = await esbuild.build({
    stdin: { contents: `export { t, resetLangCache } from "./src/i18n.ts"; export { INTRO } from "./cloud/shared/paper.mjs";`, resolveDir: ROOT },
    bundle: true, platform: "node", format: "cjs", write: false,
    alias: { obsidian: mockObsidianPath },
  });
  const i18n = { exports: {} };
  new Function("module", "exports", "require", i18nBuild.outputFiles[0].text)(i18n, i18n.exports, require);
  const { t, INTRO } = i18n.exports;
  const keys = ["paper_drawer", "paper_new_drawer", "paper_new_drawer_title", "paper_new_drawer_placeholder", "paper_intro_title",
    "paper_intro_lead", "paper_intro_scan", "paper_intro_search", "paper_intro_alarm", "paper_intro_phone", "paper_tip_close"];
  if (t("paper_intro_title") !== INTRO.title || t("paper_intro_alarm") !== INTRO.points[2].text || t("paper_intro_phone") !== INTRO.phone) fail("English intro comes from INTRO");
  const fs = require("fs");
  const source = fs.readFileSync(path.join(ROOT, "src/i18n.ts"), "utf8");
  const nl = source.slice(source.indexOf("const NL"), source.indexOf("const ES"));
  for (const key of keys) {
    const line = nl.split("\n").find((l) => l.trim().startsWith(`${key}:`));
    if (!line) fail(`Dutch text for ${key}`);
    if (line.includes("—")) fail(`em-dash in Dutch ${key}`);
  }

  // The drawer is always in the filter bar, opens its small drawers, and a new date warns a week before by default.
  const view = fs.readFileSync(path.join(ROOT, "src/view.ts"), "utf8");
  if (!/if \(!this\.showTrash\) \{\s*this\.filterBarEl\.toggleClass\("is-hidden", false\);\s*this\.renderPaperChips\(cards\);/.test(view)) fail("Paper drawer chip is always shown");
  if (!view.includes("isPaperDrawer(sel) ? inDrawer(labels, sel)")) fail("drawer filter uses inDrawer");
  if (!view.includes("this.plugin.settings.paperTipClosed = true")) fail("closing the tip is remembered");
  const edit = fs.readFileSync(path.join(ROOT, "src/edit.ts"), "utf8");
  if (!edit.includes("this.warnChoice = meta.expires ? \"\" : DEFAULT_WARN;")) fail("one week warning by default");

  console.log("check-plugin-expires: all checks passed");
})().catch((err) => { console.error(err); process.exit(1); });

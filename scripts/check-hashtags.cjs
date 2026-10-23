// Issue #16: editors keep hashtags; only shared, clipped and preview text is neutralized.
const assert = require("node:assert/strict");
const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const source = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

(async () => {
  const result = await esbuild.build({
    stdin: { contents: `export { readMeta, neutralizeBodyHashtags, plainPreviewText } from "./src/metadata.ts";`, resolveDir: ROOT },
    bundle: true, platform: "node", format: "cjs", write: false,
    alias: { obsidian: path.join(__dirname, "mock-obsidian.cjs") },
  });
  const loaded = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(loaded, loaded.exports, require);
  const { readMeta, neutralizeBodyHashtags, plainPreviewText } = loaded.exports;

  // Obsidian's own index supplies the inline tags; frontmatter tags stay the only editable ones.
  const cache = { frontmatter: { tags: ["home"] }, tags: [{ tag: "#Home" }, { tag: "#errand" }, { tag: "#project/alpha" }] };
  const meta = readMeta({ metadataCache: { getFileCache: () => cache } }, { path: "n.md" });
  assert.deepEqual(meta.tags, ["home"]);
  assert.deepEqual(meta.inlineTags, ["errand", "project/alpha"]);
  assert.deepEqual(readMeta({ metadataCache: { getFileCache: () => null } }, { path: "x.md" }).inlineTags, []);

  // Shared and clipped text is still neutralized.
  assert.equal(neutralizeBodyHashtags("Trending #fyp"), "Trending \\#fyp");
  // Tags as Obsidian reads them: any letter, digits only with a letter; not in code, links or URLs.
  assert.equal(neutralizeBodyHashtags("#\u00e9migr\u00e9 #2024plan #ok issue #16 (#x) a#b \\#done"), "\\#\u00e9migr\u00e9 \\#2024plan \\#ok issue #16 (\\#x) a#b \\#done");
  assert.equal(neutralizeBodyHashtags("# Title\n## Sub"), "# Title\n## Sub");
  assert.equal(neutralizeBodyHashtags("https://x.com/a?b=#frag [s](#heading) [[Note#Part]] [[#Part]] `#c`"), "https://x.com/a?b=#frag [s](#heading) [[Note#Part]] [[#Part]] `#c`");
  assert.equal(neutralizeBodyHashtags("````\n```\n#in\n```\n````\n#out"), "````\n```\n#in\n```\n````\n\\#out");
  assert.equal(neutralizeBodyHashtags("~~~\n#in\n~~~ #out"), "~~~\n#in\n~~~ \\#out");
  assert.equal(neutralizeBodyHashtags("---\ntags: [x]\n---\n#a"), "---\ntags: [x]\n---\n\\#a");

  // Editors never neutralize; capture only for a bare link replaced by its page preview.
  assert.doesNotMatch(source("src/edit.ts"), /neutraliz/i);
  assert.match(source("src/capture.ts"), /const safeContent = fromPreview \? neutralizeBodyHashtags\(content\) : content;/);
  assert.match(source("src/clipServer.ts"), /neutralizeBodyHashtags\(content\)/);
  assert.doesNotMatch(source("android/app/src/main/kotlin/com/diexar/keepcapture/EditorActivity.kt"), /neutralizeBodyHashtags/);
  assert.match(source("android/app/src/main/kotlin/com/diexar/keepcapture/Storage.kt"), /fun saveNote\(context: Context, content: String\): Result<String> \{\s*return createNote\(context, neutralizeBodyHashtags\(content\)\)/);
  assert.match(source("android/app/src/main/kotlin/com/diexar/keepcapture/PreviewWorker.kt"), /neutralizeBodyHashtags/);

  // Cards show escaped `\#tag` without the backslash, like Obsidian's reading view.
  assert.equal(plainPreviewText("Trending \\#fyp"), "Trending #fyp");
  assert.equal(source("src/view.ts").match(/plainPreviewText\(/g)?.length, 2);
  // Android: CardText.plain does the same for card titles and snippets (android/checks/InlineTagsCheck.kt).
  assert.equal(source("android/app/src/main/kotlin/com/diexar/keepcapture/Storage.kt").match(/CardText\.plain\(/g)?.length, 2);
  console.log("Hashtag checks passed");
})().catch((error) => { console.error(error); process.exit(1); });

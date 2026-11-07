const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const esbuild = require("esbuild");

globalThis.crypto ??= webcrypto;

// TikTok video pages have no og: tags and the same <title> for every video; the video's own data
// sits in the rehydration JSON. oEmbed gives no title or thumbnail for videos any more.
const page = (id, desc, extra = {}) => `<html><head><title>TikTok - Make Your Day</title></head><body>` +
  `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
    __DEFAULT_SCOPE__: { "webapp.video-detail": { itemInfo: { itemStruct: {
      id, desc, video: { cover: "https://cdn.example.com/cover.image?sig=1", originCover: "" },
      author: { uniqueId: "tjrobertson52", nickname: "TJ Robertson" }, ...extra,
    } } } },
  })}</script></body></html>`;

(async () => {
  const bundle = await esbuild.build({
    entryPoints: ["src/ogfetch.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["obsidian"],
    write: false,
  });
  const files = new Map();
  const requests = [];
  const pages = new Map();
  const obsidian = {
    normalizePath: (path) => path,
    requestUrl: async ({ url }) => {
      requests.push(url);
      if (pages.has(url)) return { status: 200, text: pages.get(url) };
      if (url.startsWith("https://www.tiktok.com/oembed?")) {
        return url.includes("music") ? { status: 200, text: JSON.stringify({ title: "♬ original-sound - xaeryum", author_name: "xaeryum" }) }
          : { status: 200, text: JSON.stringify({ type: "video", html: "<iframe>" }) };
      }
      if (url === "https://cdn.example.com/cover.image?sig=1") return {
        status: 200,
        headers: { "content-type": "image/jpeg" },
        arrayBuffer: Uint8Array.from([0xff, 0xd8, 0xff]).buffer,
      };
      throw new Error(`Unexpected request: ${url}`);
    },
  };
  const loaded = { exports: {} };
  new Function("module", "exports", "require", bundle.outputFiles[0].text)(
    loaded, loaded.exports, (id) => id === "obsidian" ? obsidian : require(id),
  );
  const { fetchOg, parseTikTokVideo, isGenericTikTokTitle } = loaded.exports;
  const app = { vault: { adapter: {
    mkdir: async () => {},
    exists: async (path) => files.has(path),
    writeBinary: async (path, bytes) => files.set(path, bytes),
  } } };

  // A shared short link: caption (without hashtags) as title, the maker, and the cover as thumbnail.
  const short = "https://vm.tiktok.com/ZGdXB8vwb/";
  pages.set(short, page("7705168790996176142", "Sprite sheets close the loop #ClaudeAI #fyp https://example.com/x"));
  let preview = await fetchOg(app, "Mini Notes/.attachments", short);
  assert.equal(preview?.title, "Sprite sheets close the loop");
  assert.equal(preview?.description, "via @tjrobertson52");
  assert.equal(preview?.sourceUrl, short);
  assert.match(preview?.imageBasename ?? "", /^[a-f0-9]{12}\.jpg$/);
  assert.ok(files.has(`Mini Notes/.attachments/${preview.imageBasename}`));
  assert.ok(!requests.some((url) => url.startsWith("https://www.tiktok.com/oembed")));

  // A caption of only hashtags: the maker's name instead of an empty title.
  const tags = "https://www.tiktok.com/@u/video/42";
  pages.set(tags, page("42", "#fyp #viral"));
  assert.equal((await fetchOg(app, "Mini Notes/.attachments", tags, false))?.title, "TikTok · TJ Robertson");

  // Not the video asked for: no preview of another video, and never the generic title.
  const other = "https://www.tiktok.com/@u/video/1";
  pages.set(other, page("2", "Someone else's video"));
  const wrong = await fetchOg(app, "Mini Notes/.attachments", other, false);
  assert.ok(!wrong?.title, `unexpected title ${wrong?.title}`);

  // A music page has no video: oEmbed's title wins over the generic page title.
  const music = "https://www.tiktok.com/music/original-sound-1?music";
  pages.set(music, "<html><head><title>TikTok - Make Your Day</title></head></html>");
  preview = await fetchOg(app, "Mini Notes/.attachments", music, false);
  assert.equal(preview?.title, "♬ original-sound - xaeryum");

  assert.equal(parseTikTokVideo("<title>TikTok - Make Your Day</title>"), null);
  assert.ok(isGenericTikTokTitle(" TikTok - Make Your Day ") && !isGenericTikTokTitle("TikTok · Eric"));
  console.log("TikTok preview checks passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

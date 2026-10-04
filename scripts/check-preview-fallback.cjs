const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const esbuild = require("esbuild");

globalThis.crypto ??= webcrypto;

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
  const canonical = "https://www.tiktok.com/@example/photo/123";
  const short = "https://vm.tiktok.com/photo123/";
  const image = "https://cdn.example.com/photo.jpg";
  const obsidian = {
    normalizePath: (path) => path,
    requestUrl: async ({ url }) => {
      requests.push(url);
      if (url === short) return { status: 200, text: `<link rel="canonical" href="${canonical}">` };
      if (url.startsWith("https://www.tiktok.com/oembed?")) return { status: 400 };
      if (url === canonical) return {
        status: 200,
        text: `<meta property="og:title" content="Photo"><meta property="og:image" content="${image}">`,
      };
      if (url === image) return {
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
  const app = { vault: { adapter: {
    mkdir: async () => {},
    exists: async (path) => files.has(path),
    writeBinary: async (path, bytes) => files.set(path, bytes),
  } } };

  const preview = await loaded.exports.fetchOg(app, "Mini Notes/.attachments", short);
  assert.equal(preview?.title, "Photo");
  assert.equal(preview?.sourceUrl, short);
  assert.match(preview?.imageBasename ?? "", /^[a-f0-9]{12}\.jpg$/);
  assert.ok(files.has(`Mini Notes/.attachments/${preview.imageBasename}`));
  assert.ok(requests.includes(canonical));
  console.log("Preview fallback checks passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

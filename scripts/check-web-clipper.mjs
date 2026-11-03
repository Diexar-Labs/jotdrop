// Focused regression check for the Web Clipper transport/protocol module.
// Uses only Node's standard test/assert APIs; no test framework dependency.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildWebClipperBundle } from "./build-web-clipper.mjs";
import { CLOUD_ORIGIN } from "../chrome-extension/cloud.mjs";

const require = createRequire(import.meta.url);
const proto = require("../chrome-extension/protocol.js");

test("URI serialization includes every field, especially pinned", () => {
  const uri = proto.buildClipUri({
    url: "https://example.com/a",
    title: "Example",
    selection: "Some quoted text",
    tags: ["idea", "work"],
    color: "red",
    pinned: true,
  });
  const qs = new URLSearchParams(uri.split("?")[1]);
  assert.equal(uri.startsWith("obsidian://jotdrop-clip?"), true);
  assert.equal(qs.get("url"), "https://example.com/a");
  assert.equal(qs.get("title"), "Example");
  assert.equal(qs.get("selection"), "Some quoted text");
  assert.equal(qs.get("tags"), "idea,work");
  assert.equal(qs.get("color"), "red");
  assert.equal(qs.get("pinned"), "true");
});

test("pinned is always serialized, also when false", () => {
  const uri = proto.buildClipUri({ url: "https://example.com", pinned: false });
  const qs = new URLSearchParams(uri.split("?")[1]);
  assert.equal(qs.get("pinned"), "false");
});

test("spaces are encoded as %20, never as a literal +", () => {
  const uri = proto.buildClipUri({
    url: "https://example.com",
    title: "Al jaren een doorn in het oog: einde aan asielbonanza?",
    selection: " regel met\nnieuwe regel ",
  });
  assert.equal(uri.includes("+"), false);
  const qs = new URLSearchParams(uri.split("?")[1]);
  assert.equal(qs.get("title"), "Al jaren een doorn in het oog: einde aan asielbonanza?");
  // A real + in a value must survive as %2B and round-trip correctly.
  const uri2 = proto.buildClipUri({ url: "https://example.com", title: "C++ tips" });
  assert.equal(uri2.includes("%2B"), true);
  assert.equal(new URLSearchParams(uri2.split("?")[1]).get("title"), "C++ tips");
});

test("token present selects localhost mode", () => {
  assert.equal(proto.pickRoute({ token: "abc", port: 27124 }), "server");
});

test("token absent selects direct URI mode", () => {
  assert.equal(proto.pickRoute({ token: "", port: 27124 }), "direct");
  assert.equal(proto.pickRoute({}), "direct");
  assert.equal(proto.pickRoute(undefined), "direct");
});

test("over-limit URI is rejected with the intended reason, not truncated", () => {
  const payload = {
    url: "https://example.com",
    title: "Long",
    selection: "x".repeat(3000),
  };
  const result = proto.serializeDirectClip(payload);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "uri-too-long");
  assert.ok(result.length > proto.DIRECT_URI_MAX_LENGTH);
});

test("short clip serializes to a usable direct URI", () => {
  const result = proto.serializeDirectClip({ url: "https://example.com", pinned: false });
  assert.equal(result.ok, true);
  assert.equal(result.uri.startsWith("obsidian://jotdrop-clip?url="), true);
});
// --- 0.2: JotDrop Cloud in the store build ---------------------------------------------------------------

const extension = (name) => readFileSync(fileURLToPath(new URL(`../chrome-extension/${name}`, import.meta.url)), "utf8");
const manifest = JSON.parse(extension("manifest.json"));

test("store manifest asks for the narrowest access: localhost always, app.jotdrop.net only when cloud is turned on", () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "scripting", "storage"]);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*", "http://localhost/*"]);
  assert.deepEqual(manifest.optional_host_permissions, [`${CLOUD_ORIGIN}/*`]);
  assert.equal(CLOUD_ORIGIN, "https://app.jotdrop.net");
  const all = JSON.stringify(manifest);
  for (const wide of ["<all_urls>", "https://*/*", "http://*/*", "*://*/*"]) assert.equal(all.includes(wide), false, wide);
  assert.equal(manifest.content_scripts, undefined);
  assert.ok(manifest.description.length <= 132, "Chrome Web Store limit");
});

test("popup and settings load the bundled cloud client before their own script", () => {
  for (const [page, own] of [["popup/popup.html", "popup.js"], ["options/options.html", "options.js"]]) {
    const html = extension(page);
    const bundle = html.indexOf('<script src="../cloud-client.js"></script>');
    assert.ok(bundle > 0, page);
    assert.ok(bundle < html.indexOf(`src="${own}"`), page);
    assert.equal(/<script(?![^>]*src=)/.test(html), false, `${page}: inline scripts are blocked in extensions`);
  }
});

test("committed cloud-client.js is the fresh build of chrome-extension/cloud.mjs", async () => {
  assert.equal(extension("cloud-client.js").replace(/\r\n/g, "\n"), await buildWebClipperBundle());
});

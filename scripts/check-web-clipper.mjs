// Focused regression check for the Web Clipper transport/protocol module.
// Uses only Node's standard test/assert APIs; no test framework dependency.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

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
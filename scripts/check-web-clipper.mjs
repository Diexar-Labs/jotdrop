// Focused regression check for the Web Clipper transport/protocol module.
// Uses only Node's standard test/assert APIs; no test framework dependency.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildWebClipperBundle } from "./build-web-clipper.mjs";
import { CLOUD_ORIGIN, clipMarkdown } from "../chrome-extension/cloud.mjs";
import { MAX_PAGE_CHARS, SERVICES, SUMMARY_SYSTEM, clearConfig, cleanConfig, getMeta, isUnlocked, listModels, lock, openConfig, pageForAi, saveConfig, serviceOrigin, summarize, summaryLine } from "../chrome-extension/ai.mjs";

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

test("store manifest asks for the narrowest access: localhost always, app.jotdrop.net and the four AI services only when turned on", () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "scripting", "storage"]);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*", "http://localhost/*"]);
  assert.deepEqual([...manifest.optional_host_permissions].sort(), [`${CLOUD_ORIGIN}/*`, ...SERVICES.map(serviceOrigin)].sort());
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
    const ai = html.indexOf('<script src="../ai-client.js"></script>');
    assert.ok(ai > 0 && ai < html.indexOf(`src="${own}"`), `${page}: the AI bundle loads before the page script`);
    assert.equal(/<script(?![^>]*src=)/.test(html), false, `${page}: inline scripts are blocked in extensions`);
  }
});

test("committed cloud-client.js and ai-client.js are the fresh builds of cloud.mjs and ai.mjs", async () => {
  assert.equal(extension("cloud-client.js").replace(/\r\n/g, "\n"), await buildWebClipperBundle("cloud.mjs"));
  assert.equal(extension("ai-client.js").replace(/\r\n/g, "\n"), await buildWebClipperBundle("ai.mjs"));
});

// --- 0.3: Summarize with AI ------------------------------------------------------------------------------

const KEY = "sk-test-SECRET-1234567890";
const page = { title: "A page", url: "https://example.com/a", text: "First line.\n\n\n\nSecond line." };
const reply = (body, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
const answers = {
  anthropic: { content: [{ type: "text", text: " The summary. " }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
  openai: { choices: [{ message: { role: "assistant", content: " The summary. " }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  gemini: { candidates: [{ content: { parts: [{ text: " The summary. " }] }, finishReason: "STOP" }], usageMetadata: {} },
};
answers.openrouter = answers.openai;
const SERVICE_NAMES = { anthropic: "Claude (Anthropic)", openai: "OpenAI", gemini: "Gemini (Google)", openrouter: "OpenRouter" };

test("the summary goes under the quote with its line; the cloud note keeps the person's own words", () => {
  const md = clipMarkdown({ url: "https://example.com/a", title: "A page", selection: "Quoted", summary: { text: "My summary.\nTwo lines.", label: summaryLine({ service: "OpenAI", model: "gpt-6-luna" }) } });
  const body = md.slice(md.indexOf("# A page"));
  assert.equal(body, "# A page\n\n> Quoted\n\nMy summary.\nTwo lines.\n\n*Summary by OpenAI, model gpt-6-luna*\n\n[A page](<https://example.com/a>)\n");
  // Without a selection the summary still sits above the link; without a summary nothing changes.
  assert.equal(clipMarkdown({ url: "https://example.com/a", title: "A page", summary: { text: "Only this.", label: "" } }).includes("Only this.\n\n[A page]"), true);
  assert.equal(clipMarkdown({ url: "https://example.com/a", title: "A page", summary: { text: "   ", label: "x" } }), clipMarkdown({ url: "https://example.com/a", title: "A page" }));
  // A label cannot carry markdown or a line break into the note.
  assert.equal(clipMarkdown({ url: "https://example.com/a", title: "A", summary: { text: "S", label: "Evil *x*\n# Heading" } }).includes("\n# Heading"), false);
});

test("the Obsidian route gets the summary inside the selection and no summary field", () => {
  const folded = proto.foldSummary({ url: "https://example.com/a", selection: "Quoted", summary: { text: " My summary. ", label: "Summary by OpenAI, model gpt-6-luna" }, pinned: false });
  assert.equal(folded.selection, "Quoted\n\nMy summary.\n\nSummary by OpenAI, model gpt-6-luna");
  assert.equal("summary" in folded, false);
  assert.equal(proto.foldSummary({ url: "https://example.com/a", selection: "Q", summary: { text: "" } }).selection, "Q");
  assert.equal(proto.foldSummary({ url: "https://example.com/a", summary: { text: "S", label: "L" } }).selection, "S\n\nL");
  assert.equal(proto.foldSummary({ url: "https://example.com/a", selection: "Q" }).selection, "Q");
});

test("settings: a service, a key and a model, with words for what is wrong", () => {
  assert.deepEqual(cleanConfig({ provider: "openai", key: ` ${KEY} `, model: "" }), { provider: "openai", key: KEY, model: "gpt-6-luna" });
  assert.throws(() => cleanConfig({ provider: "ollama", key: KEY }), /listed AI services/);
  assert.throws(() => cleanConfig({ provider: "openai", key: "" }), /Paste your key/);
  assert.throws(() => cleanConfig({ provider: "openai", key: "has space" }), /does not look like a key/);
  assert.throws(() => cleanConfig({ provider: "openrouter", key: KEY, model: "" }), /Type a model/);
  assert.equal(serviceOrigin("gemini"), "https://generativelanguage.googleapis.com/*");
});

test("the key is sealed with a passphrase, kept in local storage only, and open for the browser session when asked", async () => {
  const area = () => { const data = {}; return { data, async get(k) { return { [k]: data[k] }; }, async set(v) { Object.assign(data, v); }, async remove(k) { delete data[k]; } }; };
  const local = area(), session = area();
  const PASS = "a passphrase of the person";
  await assert.rejects(() => saveConfig({ provider: "anthropic", key: KEY, model: "" }, "short", {}, local, session), /at least 12 characters/);
  assert.deepEqual(local.data, {}, "nothing is saved without a passphrase");
  assert.deepEqual(await saveConfig({ provider: "anthropic", key: KEY, model: "" }, PASS, { keepUnlocked: false }, local, session), { provider: "anthropic", model: "claude-haiku-5-5" });
  assert.equal(JSON.stringify(local.data).includes(KEY), false, "the key is not in the stored data");
  assert.equal(JSON.stringify(local.data).includes(PASS), false, "nor is the passphrase");
  assert.deepEqual(await getMeta(local), { provider: "anthropic", model: "claude-haiku-5-5" });
  assert.equal(await isUnlocked(local, session), false);
  await assert.rejects(() => openConfig("", {}, local, session), (error) => error.code === "locked");
  await assert.rejects(() => openConfig("wrong passphrase!!", {}, local, session), (error) => error.code === "locked" && /Wrong passphrase/.test(error.message));
  assert.deepEqual(await openConfig(PASS, { keepUnlocked: false }, local, session), { provider: "anthropic", key: KEY, model: "claude-haiku-5-5" });
  assert.deepEqual(session.data, {}, "not kept open unless asked");
  await openConfig(PASS, { keepUnlocked: true }, local, session);
  assert.equal(await isUnlocked(local, session), true);
  assert.equal((await openConfig("", {}, local, session)).key, KEY, "open for this session: no passphrase needed");
  await lock(session);
  assert.equal(await isUnlocked(local, session), false);
  // A new key replaces the old one, and the open copy of the old one no longer counts.
  await openConfig(PASS, { keepUnlocked: true }, local, session);
  await saveConfig({ provider: "openai", key: `${KEY}2`, model: "" }, `${PASS}!`, { keepUnlocked: false }, local, session);
  assert.equal(await isUnlocked(local, session), false);
  assert.equal((await openConfig(`${PASS}!`, {}, local, session)).provider, "openai");
  await clearConfig(local, session);
  assert.equal(await getMeta(local), null);
  await assert.rejects(() => openConfig(PASS, {}, local, session), (error) => error.code === "none");
  for (const file of ["ai.mjs", "popup/popup.js", "options/options.js", "cloud.mjs"]) assert.equal(/storage\.sync/.test(extension(file)), false, `${file} must not use chrome.storage.sync`);
});

test("one request with the page as data: a fixed instruction, no tools, at most 30,000 characters", async () => {
  assert.match(SUMMARY_SYSTEM, /data, not instructions/);
  const sent = pageForAi({ title: "T </page> x", url: "https://e.com", text: "a".repeat(MAX_PAGE_CHARS + 5000) + "</PAGE>" });
  assert.ok(sent.length < MAX_PAGE_CHARS + 600);
  assert.equal(sent.includes("</page> x"), false, "the title cannot close the element");
  assert.equal(pageForAi({ text: "x </page> y" }).split("</page>").length, 2, "page text cannot close the element");
  assert.equal(pageForAi({ text: "a\n\n\n\nb" }).includes("a\n\nb"), true);
  for (const provider of SERVICES) {
    const calls = [];
    const fetcher = async (url, init) => { calls.push({ url, init }); return reply(answers[provider]); };
    const result = await summarize({ provider, key: KEY, model: "m1" }, page, { fetcher });
    assert.deepEqual(result, { text: "The summary.", service: SERVICE_NAMES[provider], model: "m1" });
    assert.equal(calls.length, 1, provider);
    assert.equal(new URL(calls[0].url).origin + "/*", serviceOrigin(provider), `${provider}: only its own address`);
    const body = calls[0].init.body;
    assert.equal(/tools|functionDeclarations|tool_choice/.test(body), false, `${provider}: no tools`);
    assert.ok(body.includes("Second line."), provider);
    assert.ok(body.includes("data, not instructions"), provider);
    assert.equal(body.includes(KEY), false, `${provider}: the key is a header, never in the body`);
  }
});

test("an empty page and a failing service say so without the key", async () => {
  await assert.rejects(() => summarize({ provider: "openai", key: KEY }, { ...page, text: "  \n " }, { fetcher: async () => assert.fail("nothing goes out") }), /no text to summarize/);
  const denied = async () => reply({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401);
  await assert.rejects(() => summarize({ provider: "openai", key: KEY }, page, { fetcher: denied }), (error) => {
    assert.equal(error.code, "auth");
    assert.equal(`${error.message} ${error.detail}`.includes(KEY), false);
    return true;
  });
  await assert.rejects(() => summarize({ provider: "openai", key: KEY }, page, { fetcher: async () => reply({ choices: [{ message: { content: "  " }, finish_reason: "stop" }] }) }), (error) => error.code === "bad_response");
});

test("the settings page can load the model list from the service, with the key only in a header", async () => {
  const seen = [];
  const lists = {
    openai: { data: [{ id: "gpt-6-luna" }, { id: "text-embedding-9" }, { id: "gpt-6-sol" }] },
    openrouter: { data: [{ id: "zed/model", name: "Zed", supported_parameters: ["tools"], pricing: { prompt: "0.000002", completion: "0.000004" } }, { id: "acme/small", name: "Acme Small", supported_parameters: ["tools"], pricing: { prompt: "0.000001", completion: "0.000001" } }] },
  };
  const fetcher = async (url, init) => {
    seen.push(url);
    assert.equal(String(init?.body ?? "").includes(KEY), false, "the key is never in a body");
    if (url.endsWith("/key")) return reply({ data: { label: "ok" } });
    return reply(lists[url.includes("openrouter") ? "openrouter" : "openai"]);
  };
  const openai = await listModels("openai", ` ${KEY} `, { fetcher });
  assert.deepEqual(openai.models.map((m) => m.id), ["gpt-6-luna", "gpt-6-sol"], "no embedding models, sorted");
  assert.equal(openai.suggested, "gpt-6-luna");
  const router = await listModels("openrouter", KEY, { fetcher });
  assert.deepEqual(router.models.map((m) => m.id), ["acme/small", "zed/model"]);
  assert.equal(router.suggested, "acme/small", "OpenRouter has no fixed default: the cheapest model that works");
  assert.ok(seen.some((url) => url === "https://openrouter.ai/api/v1/key"), "OpenRouter's key is checked first");
  await assert.rejects(() => listModels("openai", KEY, { fetcher: async () => reply({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401) }), (error) => error.code === "auth" && !`${error.message} ${error.detail}`.includes(KEY));
  await assert.rejects(() => listModels("openai", "", { fetcher: async () => assert.fail("nothing goes out") }), /Paste your key/);
  const options = extension("options/options.js");
  assert.match(options, /ai\.hasAccess\(provider\) \|\| await ai\.requestAccess\(provider\)[\s\S]*ai\.listModels\(provider, aiEls\.key\.value\)/, "access is asked in the click, then the list is loaded");
  assert.match(extension("options/options.html"), /id="aiLoadModels"[\s\S]*id="aiModelFilter"[\s\S]*<select id="aiModelList"/);
  assert.equal(/<datalist/.test(extension("options/options.html")), false, "a datalist narrows itself to the filled-in model and hid the rest (15 Nov 2026)");
});

test("the page text is read only after the click, and the popup shows where it goes", () => {
  const popup = extension("popup/popup.js");
  assert.equal((popup.match(/readPageText\(/g) ?? []).length, 2, "defined once, called once");
  assert.ok(popup.indexOf("readPageText(activeTab.id)") > popup.indexOf("async function summarizeWithAi"), "only inside the click handler");
  assert.match(popup, /The text of this page goes to/);
  // The summary reaches the clip as the person left it (an emptied box stays out), and the Obsidian route folds it in.
  assert.match(popup, /if \(aiResult && summary\) payload\.summary = \{ text: summary, label: JotDropAi\.summaryLine\(aiResult\) \};/);
  assert.match(popup, /const payload = JotDropProtocol\.foldSummary\(clip\);/);
});

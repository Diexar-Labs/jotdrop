const assert = require("node:assert/strict");
const esbuild = require("esbuild");

(async () => {
  const result = await esbuild.build({
    stdin: { contents: 'export { notifyPlayTest, DEFAULT_SETTINGS } from "./src/settings.ts";', resolveDir: process.cwd() },
    bundle: true, platform: "node", format: "cjs", write: false,
    plugins: [{
      name: "obsidian-stub",
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: `
          export const getLanguage = () => "en";
          export const normalizePath = (path) => path;
          export class PluginSettingTab {}
          export class Setting {}
          export class Notice {
            constructor(message, timeout) { this.message = message; this.timeout = timeout; globalThis.notices.push(this); }
            hide() { this.hidden = true; }
          }
        ` }));
      },
    }],
  });
  globalThis.notices = [];
  const node = () => ({ children: [], events: {}, appendChild(child) { this.children.push(child); }, addEventListener(event, action) { this.events[event] = action; } });
  globalThis.document = { createDocumentFragment: node, createElement: node };
  const loaded = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(loaded, loaded.exports, require);
  const { notifyPlayTest, DEFAULT_SETTINGS } = loaded.exports;
  let saved = 0;
  const plugin = { settings: { ...DEFAULT_SETTINGS }, async saveSettings() { saved++; } };
  await notifyPlayTest(plugin);
  assert.equal(saved, 1);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].timeout, 0);
  const links = notices[0].message.children.flatMap((child) => child.href ? [child] : child.children.filter((nested) => nested.href));
  assert.equal(links.length, 3, "signup must expose both direct steps and optional switching help");
  const step1 = new URL(links[0].href);
  assert.equal(step1.protocol, "mailto:", "step 1 must be an email route, not a group/login URL");
  assert.equal(step1.pathname, "eric@diexar.com");
  assert.equal(step1.searchParams.get("subject"), "JotDrop Play test access");
  assert.equal(
    step1.searchParams.get("body"),
    "Please add my Google Play account to the JotDrop closed test.\n\nGoogle account email used in Play: ",
  );
  assert.ok(!/ServiceLogin|groups\.google\.com/.test(links[0].href), "step 1 must not reference the Google Group or ServiceLogin");
  assert.equal(links[1].href, "https://play.google.com/apps/testing/com.diexar.keepcapture");
  assert.match(links[2].href, /#help-test-jotdrop-on-google-play$/);
  assert.match(links[0].textContent, /^1\./);
  assert.match(links[1].textContent, /^2\./);
  assert.equal(notices[0].hidden, undefined, "opening signup must not dismiss the return path");
  notices[0].message.children.at(-1).events.click();
  assert.equal(notices[0].hidden, true);
  await notifyPlayTest(plugin);
  assert.equal(notices.length, 1, "repeat load must not nag");
  await notifyPlayTest({ settings: { playTestLiveNoticeSeen: true }, async saveSettings() { throw new Error("must not save"); } });
  const failed = { settings: { ...DEFAULT_SETTINGS }, async saveSettings() { throw new Error("storage error"); } };
  await assert.rejects(notifyPlayTest(failed), /storage error/);
  assert.equal(failed.settings.playTestLiveNoticeSeen, false, "failed save must allow a retry");
  assert.equal(notices.length, 1);
  console.log("Play invitation: email-first step 1, Play step 2, first load, dismissal, persistence and save failure checks passed");
})().catch((error) => { console.error(error); process.exit(1); });

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
  assert.match(notices[0].message.children[1].href, /#help-test-jotdrop-on-google-play$/);
  notices[0].message.children[2].events.click();
  assert.equal(notices[0].hidden, true);
  await notifyPlayTest(plugin);
  assert.equal(notices.length, 1, "repeat load must not nag");
  await notifyPlayTest({ settings: { playTestLiveNoticeSeen: true }, async saveSettings() { throw new Error("must not save"); } });
  const failed = { settings: { ...DEFAULT_SETTINGS }, async saveSettings() { throw new Error("storage error"); } };
  await assert.rejects(notifyPlayTest(failed), /storage error/);
  assert.equal(failed.settings.playTestLiveNoticeSeen, false, "failed save must allow a retry");
  assert.equal(notices.length, 1);
  console.log("Play invitation: first load, dismissal, persistence and save failure checks passed");
})().catch((error) => { console.error(error); process.exit(1); });

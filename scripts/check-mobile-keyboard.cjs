const assert = require("node:assert/strict");
const esbuild = require("esbuild");
const fs = require("node:fs");

(async () => {
  const css = fs.readFileSync("styles.css", "utf8");
  assert.match(css, /\.is-mobile \.jotdrop-keyboard-modal textarea\s*\{[^}]*flex-shrink:\s*0;/,
    "Native mobile flex layout must not collapse the editor to one line");
  assert.match(css, /--jotdrop-top-gap:\s*max\(16px, var\(--safe-area-inset-top, 0px\)\)/);
  assert.match(css, /max-height:\s*calc\(var\(--jotdrop-viewport-height, 100dvh\) - var\(--jotdrop-top-gap\)\)/);
  const bundle = await esbuild.build({
    entryPoints: ["src/mobileKeyboard.ts"],
    bundle: true, platform: "node", format: "cjs", write: false,
  });
  const loaded = { exports: {} };
  new Function("module", "exports", bundle.outputFiles[0].text)(loaded, loaded.exports);
  const { keepModalAboveKeyboard } = loaded.exports;
  const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 });
  const frames = new Map();
  const observers = [];
  let keyboard = 0;
  let nextFrame = 0;
  const win = Object.assign(new EventTarget(), {
    visualViewport: viewport, innerHeight: 800,
    requestAnimationFrame: (fn) => { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame: (id) => frames.delete(id),
    getComputedStyle: () => ({ getPropertyValue: () => `${keyboard}px` }),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
  });
  const flush = () => {
    for (const [id, fn] of frames) { frames.delete(id); fn(); }
  };
  let mobile = true;
  let scrolls = 0;
  const field = { matches: () => true, scrollIntoView: (options) => {
    assert.deepEqual(options, { block: "nearest", inline: "nearest" });
    scrolls++;
  } };
  const doc = {
    defaultView: win, activeElement: field,
    body: { classList: { contains: () => mobile } },
    documentElement: {},
  };
  const styles = new Map();
  const classes = new Set();
  const modalEl = Object.assign(new EventTarget(), {
    ownerDocument: doc,
    contains: (el) => el === field,
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
    style: { setProperty: (key, value) => styles.set(key, value), removeProperty: (key) => styles.delete(key) },
  });
  const cleanup = keepModalAboveKeyboard({ modalEl });
  flush();
  assert.ok(classes.has("jotdrop-keyboard-modal"));
  assert.equal(styles.get("--jotdrop-viewport-height"), "800px");

  // Android can shrink only the visual viewport, leaving innerHeight unchanged.
  viewport.height = 360;
  viewport.offsetTop = 24;
  const before = scrolls;
  viewport.dispatchEvent(new Event("resize"));
  viewport.dispatchEvent(new Event("scroll"));
  assert.equal(frames.size, 1);
  flush();
  assert.equal(styles.get("--jotdrop-viewport-height"), "360px");
  assert.equal(styles.get("--jotdrop-viewport-top"), "24px");
  assert.equal(scrolls, before + 1);
  modalEl.dispatchEvent(new Event("focusin"));
  modalEl.dispatchEvent(new Event("input"));
  flush();
  assert.equal(scrolls, before + 2);

  doc.activeElement = { matches: () => true };
  viewport.height = 800;
  viewport.offsetTop = 0;
  viewport.dispatchEvent(new Event("resize"));
  flush();
  assert.equal(styles.get("--jotdrop-viewport-height"), "800px");
  assert.equal(scrolls, before + 2, "Never scroll another modal's input");

  // Obsidian's real Android WebView keeps both viewport heights unchanged.
  keyboard = 310;
  observers[0].callback();
  flush();
  assert.equal(styles.get("--jotdrop-viewport-height"), "490px");
  viewport.height = 490;
  viewport.dispatchEvent(new Event("resize"));
  flush();
  assert.equal(styles.get("--jotdrop-viewport-height"), "490px", "Never subtract the IME twice");
  keyboard = 0;
  viewport.height = 800;
  observers[0].callback();
  flush();
  assert.equal(styles.get("--jotdrop-viewport-height"), "800px");

  modalEl.dispatchEvent(new Event("input"));
  cleanup();
  assert.equal(frames.size, 0);
  assert.equal(styles.size, 0);
  assert.equal(classes.size, 0);
  assert.ok(observers[0].disconnected, "Close must disconnect native inset observer");
  viewport.dispatchEvent(new Event("resize"));
  win.dispatchEvent(new Event("resize"));
  modalEl.dispatchEvent(new Event("focusin"));
  modalEl.dispatchEvent(new Event("input"));
  assert.equal(frames.size, 0, "Close must remove every listener");

  mobile = false;
  keepModalAboveKeyboard({ modalEl })();
  assert.equal(classes.size, 0, "Desktop must retain its original layout");
  assert.equal(frames.size, 0);

  mobile = true;
  win.visualViewport = null;
  const fallbackCleanup = keepModalAboveKeyboard({ modalEl });
  flush();
  win.innerHeight = 320;
  win.dispatchEvent(new Event("resize"));
  flush();
  assert.equal(styles.get("--jotdrop-viewport-height"), "320px");
  fallbackCleanup();
  console.log("Mobile keyboard checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });

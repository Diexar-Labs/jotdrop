import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";
import { builtinModules } from "module";

const prod = process.argv[2] === "production";

// Plugin install location in the vault. Override via JOTDROP_VAULT_PLUGIN_DIR env var
// if you use a different vault. Silently skips if the path doesn't exist, preventing
// build failures on CI or fresh clones without a local vault.
const VAULT_PLUGIN_DIR =
  process.env.JOTDROP_VAULT_PLUGIN_DIR ||
  process.env.DIEXAR_VAULT_PLUGIN_DIR ||
  "F:/New Dee/My Notes/Vault_1/.obsidian/plugins/jotdrop";

function copyToVault() {
  if (!fs.existsSync(VAULT_PLUGIN_DIR)) {
    console.log(`[deploy] skip — vault plugin directory not found: ${VAULT_PLUGIN_DIR}`);
    return;
  }
  const files = ["main.js", "manifest.json", "styles.css"];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    try {
      fs.copyFileSync(f, path.join(VAULT_PLUGIN_DIR, f));
    } catch (e) {
      console.error(`[deploy] failed to copy ${f}:`, e.message);
    }
  }
  console.log(`[deploy] copied to ${VAULT_PLUGIN_DIR}`);
}

// esbuild plugin: calls copyToVault() after every successful build, in both
// production and watch mode. Reload Obsidian (Ctrl+R) or toggle the plugin
// to pick up the new bundle.
const deployPlugin = {
  name: "jotdrop-deploy",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) copyToVault();
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  plugins: [deployPlugin],
});

if (prod) {
  await context.rebuild();
  await context.dispose();
  process.exit(0);
} else {
  await context.watch();
}

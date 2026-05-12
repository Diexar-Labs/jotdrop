import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

// Plugin-install-locatie in de vault. Override via OBSIDROP_VAULT_PLUGIN_DIR env-var
// als je een andere vault gebruikt. Skip-stilletjes-als-pad-ontbreekt voorkomt
// build-failures op CI of bij een verse clone zonder lokale vault.
const VAULT_PLUGIN_DIR =
  process.env.OBSIDROP_VAULT_PLUGIN_DIR ||
  process.env.DIEXAR_VAULT_PLUGIN_DIR ||
  "F:/New Dee/My Notes/Vault_1/.obsidian/plugins/obsidrop";

function copyToVault() {
  if (!fs.existsSync(VAULT_PLUGIN_DIR)) {
    console.log(`[deploy] skip — vault-pluginmap bestaat niet: ${VAULT_PLUGIN_DIR}`);
    return;
  }
  const files = ["main.js", "manifest.json", "styles.css"];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    try {
      fs.copyFileSync(f, path.join(VAULT_PLUGIN_DIR, f));
    } catch (e) {
      console.error(`[deploy] kon ${f} niet kopiëren:`, e.message);
    }
  }
  console.log(`[deploy] gekopieerd naar ${VAULT_PLUGIN_DIR}`);
}

// esbuild-plugin: roept copyToVault() na elke succesvolle build aan, zowel in
// production als in watch-mode. Reload Obsidian (Ctrl+R) of toggle de plugin
// om de nieuwe bundle te zien.
const deployPlugin = {
  name: "obsidrop-deploy",
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
    ...builtins,
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

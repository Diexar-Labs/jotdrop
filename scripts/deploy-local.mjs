import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.env.JOTDROP_VAULT_PLUGIN_DIR;

if (!target) {
  console.error("Set JOTDROP_VAULT_PLUGIN_DIR before running deploy:local.");
  process.exit(1);
}

try {
  execFileSync(process.execPath, ["scripts/verify-release-source.mjs", "deploy"], {
    cwd: root,
    stdio: "inherit",
  });
} catch (error) {
  process.exit(error?.status || 1);
}
// Node 24+ refuses to spawn .cmd files without a shell (EINVAL). When this
// script already runs under npm, use its JS entry point via node instead.
const npmExec = process.env.npm_execpath;
const useNpmJs =
  process.platform === "win32" && npmExec && npmExec.endsWith(".js");
execFileSync(
  useNpmJs ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm",
  useNpmJs ? [npmExec, "run", "build"] : ["run", "build"],
  {
    cwd: root,
    stdio: "inherit",
  },
);

if (!fs.existsSync(target)) {
  console.error(`Vault plugin directory not found: ${target}`);
  process.exit(1);
}

for (const file of ["main.js", "manifest.json", "styles.css"]) {
  fs.copyFileSync(path.join(root, file), path.join(target, file));
}
console.log(`[deploy] copied plugin assets to ${target}`);

// Packages the committed chrome-extension tree as a reproducible release ZIP.
// Uses the installed Git binary (git archive) — no ZIP dependency added.
// Output goes only to the ignored release-staging/ directory.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staging = path.join(root, "release-staging");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "chrome-extension", "manifest.json"), "utf8"),
);
const version = manifest.version;
const zipPath = path.join(staging, `jotdrop-web-clipper-${version}.zip`);

// Verify the required files are committed in HEAD:chrome-extension.
const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD:chrome-extension"], {
  cwd: root,
  encoding: "utf8",
});
const files = new Set(tree.split("\n"));
const required = [
  "manifest.json",
  "popup/popup.html",
  "popup/popup.js",
  "options/options.html",
  "options/options.js",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
];
const missing = required.filter((f) => !files.has(f));
if (missing.length > 0) {
  throw new Error(`Missing required files in committed chrome-extension: ${missing.join(", ")}`);
}

// Package the committed subtree so the archive root is the extension root and
// the contents match the tagged source exactly.
fs.mkdirSync(staging, { recursive: true });
execFileSync(
  "git",
  ["archive", "--format=zip", `--output=${zipPath}`, "HEAD:chrome-extension"],
  { cwd: root },
);
const size = fs.statSync(zipPath).size;
console.log(`Packaged chrome-extension ${version} -> ${zipPath} (${size} bytes)`);
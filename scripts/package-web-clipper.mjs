// Packages the committed chrome-extension tree as a reproducible release ZIP.
// Uses the installed Git binary (git archive) — no ZIP dependency added.
// Output goes only to the ignored release-staging/ directory.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildWebClipperBundle } from "./build-web-clipper.mjs";

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
  "cloud-client.js",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
];
const missing = required.filter((f) => !files.has(f));
if (missing.length > 0) {
  throw new Error(`Missing required files in committed chrome-extension: ${missing.join(", ")}`);
}

// The committed cloud bundle must be the build of the committed source.
const committedBundle = execFileSync("git", ["show", "HEAD:chrome-extension/cloud-client.js"], { cwd: root, encoding: "utf8" });
if (committedBundle.replace(/\r\n/g, "\n") !== await buildWebClipperBundle()) {
  throw new Error("Committed chrome-extension/cloud-client.js is not a fresh build. Run npm run build:web-clipper and commit.");
}

// Package the committed subtree so the archive root is the extension root and
// the contents match the tagged source exactly. cloud.mjs is only the source of
// cloud-client.js (it imports ../cloud/shared, which is not in the package).
fs.mkdirSync(staging, { recursive: true });
execFileSync(
  "git",
  ["archive", "--format=zip", `--output=${zipPath}`, "HEAD:chrome-extension", "--", ".", ":(exclude)cloud.mjs"],
  { cwd: root },
);

// File names from the ZIP's central directory (no unzip tool needed).
function zipEntries(file) {
  const bytes = fs.readFileSync(file);
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("Not a ZIP file.");
  const names = [];
  for (let at = bytes.readUInt32LE(end + 16), left = bytes.readUInt16LE(end + 10); left > 0; left--) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error("Broken ZIP central directory.");
    const nameLength = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32);
    names.push(bytes.toString("utf8", at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extra + comment;
  }
  return names;
}
const listed = zipEntries(zipPath);
if (listed.includes("cloud.mjs") || !listed.includes("cloud-client.js") || !listed.includes("manifest.json")) {
  throw new Error(`Unexpected package contents: ${listed.join(", ")}`);
}
const size = fs.statSync(zipPath).size;
console.log(`Packaged chrome-extension ${version} -> ${zipPath} (${size} bytes, ${listed.length} entries)`);

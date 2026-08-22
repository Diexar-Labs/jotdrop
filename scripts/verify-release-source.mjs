import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] || "release";
const expectedSha = process.env.JOTDROP_EXPECTED_SHA?.trim() || "";

if (!["base", "deploy", "release"].includes(mode)) {
  console.error(`Usage: node scripts/verify-release-source.mjs <base|deploy|release>`);
  process.exit(2);
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.allowFailure ? "pipe" : "inherit"],
  }).trim();
}

if (mode === "base") {
  try {
    git(["fetch", "origin", "main", "--tags", "--prune"]);
  } catch {
    console.error("Source verification failed: unable to refresh origin/main.");
    process.exit(1);
  }
}

const errors = [];
const head = git(["rev-parse", "HEAD"]);
const remoteLine = git(["ls-remote", "origin", "refs/heads/main"]);
const liveMain = remoteLine.split(/\s+/)[0];
const status = git(["status", "--short", "--untracked-files=all"]);
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const gradle = fs.readFileSync(path.join(root, "android", "app", "build.gradle.kts"), "utf8");
const versionCode = gradle.match(/versionCode\s*=\s*(\d+)/)?.[1] || "unknown";
const versionName = gradle.match(/versionName\s*=\s*"([^"]+)"/)?.[1] || "unknown";
const appId = gradle.match(/applicationId\s*=\s*"([^"]+)"/)?.[1] || "unknown";
const namespace = gradle.match(/namespace\s*=\s*"([^"]+)"/)?.[1] || "unknown";

console.log(`verification mode: ${mode}`);
console.log(`HEAD: ${head}`);
console.log(`origin/main: ${liveMain}`);
console.log(`working tree: ${status ? "dirty" : "clean"}`);
console.log(`plugin version: ${manifest.version || "unknown"}`);
console.log(`android version: ${versionName} (versionCode ${versionCode})`);
console.log(`android package: ${appId} (namespace ${namespace})`);

if (!/^[0-9a-f]{40}$/.test(head)) errors.push("HEAD is not a full commit SHA.");
if (!/^[0-9a-f]{40}$/.test(liveMain)) errors.push("origin/main did not return a commit SHA.");
if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version))) errors.push("manifest.json has no valid plugin version.");
if (versionName === "unknown" || versionCode === "unknown") errors.push("Android version fields are missing.");
if (appId !== "com.diexar.keepcapture" || namespace !== "com.diexar.keepcapture") {
  errors.push("Android package identity is not com.diexar.keepcapture.");
}
if (expectedSha && !/^[0-9a-f]{40}$/.test(expectedSha)) {
  errors.push("JOTDROP_EXPECTED_SHA is not a full commit SHA.");
}

if (mode !== "base" && status) errors.push("working tree is dirty.");
if (mode === "base") {
  if (expectedSha) {
    if (head !== expectedSha) errors.push("build HEAD must equal the GitHub Actions event SHA.");
  } else {
    const currentBase = spawnSync("git", ["merge-base", "--is-ancestor", liveMain, head], {
      cwd: root,
      stdio: "ignore",
    }).status === 0;
    if (!currentBase) errors.push("checkout is stale: build HEAD is not based on live origin/main.");
  }
}
if (mode === "release") {
  const releaseSha = expectedSha || liveMain;
  if (head !== releaseSha) {
    errors.push(expectedSha
      ? "release HEAD must equal the GitHub Actions event SHA."
      : "release HEAD must equal live origin/main.");
  }
}
if (mode === "deploy") {
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", liveMain, head], {
    cwd: root,
    stdio: "ignore",
  }).status === 0;
  if (!ancestor) errors.push("current HEAD is not based on live origin/main.");
}

if (errors.length > 0) {
  console.error("Source verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Source verification passed.");

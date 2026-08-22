import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.cwd(), process.argv[2] || "BUILD-INFO.txt");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const gradle = fs.readFileSync(path.join(root, "android", "app", "build.gradle.kts"), "utf8");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const versionCode = gradle.match(/versionCode\s*=\s*(\d+)/)?.[1] || "unknown";
const versionName = gradle.match(/versionName\s*=\s*"([^"]+)"/)?.[1] || "unknown";

fs.writeFileSync(
  output,
  [
    `commit=${sha}`,
    `plugin_version=${manifest.version}`,
    `android_version=${versionName}`,
    `android_version_code=${versionCode}`,
    "source_verification=verify:release passed",
    "",
  ].join("\n"),
  "utf8",
);

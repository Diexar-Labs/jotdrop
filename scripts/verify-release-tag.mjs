import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2]?.trim() || process.env.GITHUB_REF_NAME?.trim() || "";
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const gradle = fs.readFileSync(path.join(root, "android", "app", "build.gradle.kts"), "utf8");
const androidVersion = gradle.match(/versionName\s*=\s*"([^"]+)"/)?.[1];

if (!tag) throw new Error("Release tag is required.");
const expected = tag.startsWith("v") ? `v${androidVersion}` : manifest.version;
if (tag !== expected) {
  throw new Error(`Release tag ${tag} does not match expected version ${expected}.`);
}

console.log(`Release tag verified: ${tag}`);

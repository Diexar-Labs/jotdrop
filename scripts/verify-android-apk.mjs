import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const androidDir = path.join(root, "android");
const defaultApk = path.join(androidDir, "app", "build", "outputs", "apk", "release", "app-release.apk");
const apk = path.resolve(process.argv[2] || defaultApk);

if (!apk.endsWith(`${path.sep}apk${path.sep}release${path.sep}app-release.apk`)) {
  throw new Error(`Only the R8 release APK is accepted: ${defaultApk}`);
}
if (!fs.existsSync(apk)) throw new Error(`Release APK not found: ${apk}`);

const gradle = fs.readFileSync(path.join(androidDir, "app", "build.gradle.kts"), "utf8");
const expectedPackage = gradle.match(/applicationId\s*=\s*"([^"]+)"/)?.[1];
const expectedVersionCode = gradle.match(/versionCode\s*=\s*(\d+)/)?.[1];
const expectedVersionName = gradle.match(/versionName\s*=\s*"([^"]+)"/)?.[1];
if (!expectedPackage || !expectedVersionCode || !expectedVersionName) {
  throw new Error("Android version metadata is incomplete in build.gradle.kts.");
}

function findTool(name) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const candidates = [];
  if (sdk) {
    const buildTools = path.join(sdk, "build-tools");
    if (fs.existsSync(buildTools)) {
      for (const version of fs.readdirSync(buildTools).sort().reverse()) {
        const extensions = process.platform === "win32" ? [".exe", ".bat", ""] : [""];
        for (const extension of extensions) {
          candidates.push(path.join(buildTools, version, `${name}${extension}`));
        }
      }
    }
  }
  candidates.push(name);
  const found = candidates.find((candidate) => candidate === name || fs.existsSync(candidate));
  if (!found) throw new Error(`Android build tool not found: ${name}. Set ANDROID_HOME or ANDROID_SDK_ROOT.`);
  return found;
}

function runTool(tool, args) {
  const isWindowsBatch = process.platform === "win32" && tool.toLowerCase().endsWith(".bat");
  const command = isWindowsBatch ? process.env.ComSpec || "cmd.exe" : tool;
  const commandArgs = isWindowsBatch ? ["/d", "/c", "call", tool, ...args] : args;
  return execFileSync(command, commandArgs, { encoding: "utf8" });
}

const badging = runTool(findTool("aapt2"), ["dump", "badging", apk]);
const packageMatch = badging.match(/package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/);
if (!packageMatch) throw new Error("aapt2 did not return APK package metadata.");
const [, actualPackage, actualVersionCode, actualVersionName] = packageMatch;
if (actualPackage !== expectedPackage) throw new Error(`Package mismatch: ${actualPackage} != ${expectedPackage}`);
if (actualVersionCode !== expectedVersionCode) throw new Error(`versionCode mismatch: ${actualVersionCode} != ${expectedVersionCode}`);
if (actualVersionName !== expectedVersionName) throw new Error(`versionName mismatch: ${actualVersionName} != ${expectedVersionName}`);

const signer = runTool(findTool("apksigner"), ["verify", "--verbose", "--print-certs", apk]);
if (!/Verified using v\d+ scheme.*true/i.test(signer) || !/(?:Signer #1|V\d+ Signer): certificate DN:/i.test(signer)) {
  throw new Error("APK signer verification did not return a valid signer.");
}

console.log(`Verified release APK: ${apk}`);
console.log(`Package: ${actualPackage}`);
console.log(`Version: ${actualVersionName} (versionCode ${actualVersionCode})`);
console.log("Signer: verified");

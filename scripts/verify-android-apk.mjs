import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_CERT_SHA256, RETIRED_CERT_SHA256, findTool, runTool } from "./android-tools.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const androidDir = path.join(root, "android");
const defaultApk = path.join(androidDir, "app", "build", "outputs", "apk", "release", "app-release.apk");
const args = process.argv.slice(2);
const expectReleaseKey = args.includes("--github-key");
const apk = path.resolve(args.find((arg) => !arg.startsWith("--")) || defaultApk);

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

const badging = runTool(findTool("aapt2"), ["dump", "badging", apk]);
const packageMatch = badging.match(/package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/);
if (!packageMatch) throw new Error("aapt2 did not return APK package metadata.");
const [, actualPackage, actualVersionCode, actualVersionName] = packageMatch;
if (actualPackage !== expectedPackage) throw new Error(`Package mismatch: ${actualPackage} != ${expectedPackage}`);
if (actualVersionCode !== expectedVersionCode) throw new Error(`versionCode mismatch: ${actualVersionCode} != ${expectedVersionCode}`);
if (actualVersionName !== expectedVersionName) throw new Error(`versionName mismatch: ${actualVersionName} != ${expectedVersionName}`);

const signer = runTool(findTool("apksigner"), ["verify", "--verbose", "--print-certs", apk]);
if (!/Verified using v\d+ scheme.*true/i.test(signer) || !/(?:Signer #1|V\d+(?:\.\d+)? Signer): certificate DN:/i.test(signer)) {
  throw new Error("APK signer verification did not return a valid signer.");
}

if (expectReleaseKey) {
  if (!/Verified using v3 scheme.*true/i.test(signer)) throw new Error("A public APK needs a v3 signature to carry the key rotation.");
  const lineage = runTool(findTool("apksigner"), ["lineage", "--in", apk, "--print-certs", "-v"]);
  const signers = [...lineage.matchAll(/certificate SHA-256 digest: ([0-9a-f]{64})/gi)].map((match) => match[1].toLowerCase());
  if (signers.join() !== [RETIRED_CERT_SHA256, RELEASE_CERT_SHA256].join()) {
    throw new Error(`The rotation has to run from the retired key to the release key, found: ${signers.join(" -> ") || "nothing"}`);
  }
  if (!signer.toLowerCase().includes(RELEASE_CERT_SHA256)) throw new Error("The APK is not signed with the release key.");
  const retired = lineage.split(/Signer #2/)[0];
  if (!/rollback capability\s*:\s*false/i.test(retired)) throw new Error("The retired key must not be able to roll an install back.");
  console.log("Release key: verified, with rotation from the retired key");
}

console.log(`Verified release APK: ${apk}`);
console.log(`Package: ${actualPackage}`);
console.log(`Version: ${actualVersionName} (versionCode ${actualVersionCode})`);
console.log("Signer: verified");

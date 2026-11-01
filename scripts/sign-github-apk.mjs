import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findTool, runTool } from "./android-tools.mjs";

// Signs the public GitHub APK with the release key. Android 9 and newer read the v3
// signature: the release key, plus the lineage that lets existing installs accept it.
// Android 8 can only read the v2 signature, which has to stay with the retired key.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(root, "android", "app");
const apk = path.join(app, "build", "outputs", "apk", "release", "app-release.apk");
const encoded = process.env.JOTDROP_GITHUB_KEYSTORE_BASE64;
if (!encoded || !process.env.JOTDROP_GITHUB_KEYSTORE_PASSWORD) {
  throw new Error("The release key is not available, so this APK cannot be published.");
}
if (!fs.existsSync(apk)) throw new Error(`Release APK not found: ${apk}`);

const secrets = fs.mkdtempSync(path.join(os.tmpdir(), "jotdrop-signing-"));
const keystore = path.join(secrets, "release.p12");
const signed = path.join(secrets, "signed.apk");
try {
  fs.writeFileSync(keystore, Buffer.from(encoded, "base64"), { mode: 0o600 });
  runTool(findTool("apksigner"), [
    "sign",
    "--ks", path.join(app, "debug.keystore"), "--ks-key-alias", "androiddebugkey", "--ks-pass", "pass:android", "--key-pass", "pass:android",
    "--next-signer",
    "--ks", keystore, "--ks-key-alias", "jotdrop-github-release", "--ks-pass", "env:JOTDROP_GITHUB_KEYSTORE_PASSWORD", "--key-pass", "env:JOTDROP_GITHUB_KEYSTORE_PASSWORD",
    "--lineage", path.join(app, "github-signing.lineage"),
    "--rotation-min-sdk-version", "28",
    "--v4-signing-enabled", "false",
    "--out", signed,
    apk,
  ], { stdio: "inherit" });
  fs.copyFileSync(signed, apk);
} finally {
  fs.rmSync(secrets, { recursive: true, force: true });
}

execFileSync(process.execPath, ["scripts/verify-android-apk.mjs", apk, "--github-key"], { cwd: root, stdio: "inherit" });

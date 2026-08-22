import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apk = path.resolve(process.argv[2] || path.join(root, "android", "app", "build", "outputs", "apk", "release", "app-release.apk"));

execFileSync(process.execPath, ["scripts/verify-android-apk.mjs", apk], {
  cwd: root,
  stdio: "inherit",
});

const packageName = "com.diexar.keepcapture";
const versionCode = Number(
  fs.readFileSync(path.join(root, "android", "app", "build.gradle.kts"), "utf8").match(/versionCode\s*=\s*(\d+)/)?.[1],
);
const state = execFileSync("adb", ["get-state"], { encoding: "utf8" }).trim();
if (state !== "device") throw new Error(`ADB device is not ready: ${state || "no device"}`);

const installed = execFileSync("adb", ["shell", "dumpsys", "package", packageName], { encoding: "utf8" });
const installedVersion = installed.match(/versionCode=(\d+)/)?.[1];
if (installedVersion && Number(installedVersion) > versionCode) {
  throw new Error(`Installed versionCode ${installedVersion} is newer than APK versionCode ${versionCode}.`);
}

// Never uninstall and never pass -d: Android must reject downgrades or signer changes.
execFileSync("adb", ["install", "-r", apk], { stdio: "inherit" });
console.log(`Installed release APK without uninstalling: ${apk}`);

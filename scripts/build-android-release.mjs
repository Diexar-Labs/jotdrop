import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const androidDir = path.join(root, "android");
const testMode = process.argv.includes("--test");
const wrapper = process.platform === "win32" ? "gradlew.bat" : "gradlew";
const gradle = fs.existsSync(path.join(androidDir, wrapper))
  ? path.join(androidDir, wrapper)
  : process.env.GRADLE_BIN || "gradle";

try {
  execFileSync(process.execPath, ["scripts/verify-release-source.mjs", testMode ? "base" : "release"], {
    cwd: root,
    stdio: "inherit",
  });
} catch (error) {
  process.exit(error?.status || 1);
}

const gradleArgs = [":app:assembleRelease", "--no-daemon", "--stacktrace"];
const isWindowsBatch = process.platform === "win32" && gradle.toLowerCase().endsWith(".bat");
const gradleCommand = isWindowsBatch ? process.env.ComSpec || "cmd.exe" : gradle;
const commandArgs = isWindowsBatch ? ["/d", "/c", "call", gradle, ...gradleArgs] : gradleArgs;
execFileSync(gradleCommand, commandArgs, {
  cwd: androidDir,
  env: { ...process.env, JOTDROP_ANDROID_TEST_RELEASE: testMode ? "true" : "false" },
  stdio: "inherit",
});

const apk = path.join(androidDir, "app", "build", "outputs", "apk", "release", "app-release.apk");
execFileSync(process.execPath, ["scripts/verify-android-apk.mjs", apk], {
  cwd: root,
  stdio: "inherit",
});
console.log(`${testMode ? "Local test-release APK" : "Release APK"}: ${apk}`);

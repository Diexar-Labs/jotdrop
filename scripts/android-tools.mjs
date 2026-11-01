import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// The key of public GitHub APKs. Its private half is only in GitHub secrets and with the owner.
export const RELEASE_CERT_SHA256 = "c4a10072d1eb988e9e1d9426d9038dd9bd3fdb7cc4ab90003dedf87dfc4a433a";
// android/app/debug.keystore: published in this repository, so it proves nothing.
export const RETIRED_CERT_SHA256 = "be2a291960d917621ff4470d86ab914c8c1ce5de79ffd18fc0c8bcee6c5af785";

export const certColons = (digest) => digest.toUpperCase().match(/../g).join(":");

export function findTool(name) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const candidates = [];
  if (sdk) {
    const buildTools = path.join(sdk, "build-tools");
    if (fs.existsSync(buildTools)) {
      const versions = fs.readdirSync(buildTools).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const version of versions) {
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

export function runTool(tool, args, options = {}) {
  const isWindowsBatch = process.platform === "win32" && tool.toLowerCase().endsWith(".bat");
  const command = isWindowsBatch ? process.env.ComSpec || "cmd.exe" : tool;
  const commandArgs = isWindowsBatch ? ["/d", "/c", "call", tool, ...args] : args;
  return execFileSync(command, commandArgs, { encoding: "utf8", ...options });
}

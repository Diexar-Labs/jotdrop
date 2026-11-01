import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_CERT_SHA256, RETIRED_CERT_SHA256, certColons } from "./android-tools.mjs";

// A public APK must never go out with only the key that is published in this repository.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const problems = [];
const need = (ok, text) => { if (!ok) problems.push(text); };

const workflow = read(".github/workflows/android-build.yml");
const step = (name) => workflow.indexOf(`- name: ${name}`);
const sign = step("Sign the public APK with the release key");
need(sign !== -1, "The workflow has no step that signs the APK with the release key.");
need(sign !== -1 && sign > step("Build release APK"), "Signing has to come after the APK is built.");
need(sign !== -1 && sign < step("Stage Android release assets"), "Signing has to come before the APK is staged.");
need(sign !== -1 && sign < step("Publish Android release"), "Signing has to come before the APK is published.");
const signStep = sign === -1 ? "" : workflow.slice(sign, workflow.indexOf("- name:", sign + 10));
need(/if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/.test(signStep), "Only a release tag may sign with the release key.");
need(!/continue-on-error/.test(signStep), "A failed signing step has to stop the release.");
need(signStep.includes("secrets.JOTDROP_GITHUB_KEYSTORE_BASE64") && signStep.includes("secrets.JOTDROP_GITHUB_KEYSTORE_PASSWORD"), "The signing step has to read the key from GitHub secrets.");

need(fs.existsSync(path.join(root, "android/app/github-signing.lineage")), "The rotation lineage is missing.");
const tracked = read("android/.gitignore");
need(/^\*\.p12$/m.test(tracked), "android/.gitignore has to keep .p12 key files out of the repository.");

const links = JSON.parse(read("cloud/web/assetlinks.json"));
const prints = links.flatMap((link) => link.target.sha256_cert_fingerprints);
need(prints.includes(certColons(RELEASE_CERT_SHA256)), "App Links have to trust the release key.");
need(!prints.includes(certColons(RETIRED_CERT_SHA256)), "App Links must never trust the published key.");

if (problems.length) {
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  process.exit(1);
}
console.log("PASS: public APKs are signed with the release key, the published key is retired");

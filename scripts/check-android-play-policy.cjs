// Google Play rules that a later change could quietly break:
// - no direct link to a payment page in the app, and no Ko-fi anywhere (Payments policy);
// - link previews do not pretend to be a crawler or to come from Google;
// - the account deletion page has its own section and no link onward to the web app,
//   because the app and Play Console link to it and it must not lead to checkout.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const errors = [];
const check = (ok, message) => { if (!ok) errors.push(message); };

const noKofi = [
  "README.md",
  "manifest.json",
  "src/settings.ts",
  "src/i18n.ts",
  "docs/android-privacy-policy.md",
  "android/app/src/main/kotlin/com/diexar/keepcapture/MainActivity.kt",
  "android/app/src/main/res/layout/activity_main.xml",
  "android/app/src/main/res/values/strings.xml",
  "android/app/src/main/res/values-nl/strings.xml",
];
for (const file of noKofi) check(!/ko-?fi/i.test(read(file)), `${file} must not mention Ko-fi`);
check(!fs.existsSync(path.join(root, ".github/FUNDING.yml")), ".github/FUNDING.yml must not exist");

const preview = read("android/app/src/main/kotlin/com/diexar/keepcapture/OgFetcher.kt");
for (const disguise of ["Twitterbot", "facebookexternalhit", "Googlebot", "www.google.com/"]) {
  check(!preview.includes(disguise), `OgFetcher must not use ${disguise}`);
}

const privacy = read("cloud/web/privacy.html");
check(/<h2 id="delete-account">[^<]*JotDrop[^<]*<\/h2>/.test(privacy), "privacy page needs a delete-account section that names JotDrop");
check(privacy.includes('href="#delete-account"'), "privacy page needs a link to the delete-account section at the top");
check(!/href="\/"/.test(privacy), "privacy page must not link to the web app");

if (errors.length) {
  for (const error of errors) console.error(`FAIL: ${error}`);
  process.exit(1);
}
console.log("Play policy checks passed");

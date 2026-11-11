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

// User-generated content policy: terms before sharing, and reporting and blocking inside the app.
const spacesUi = read("android/app/src/main/kotlin/com/diexar/keepcapture/CloudSpacesUi.kt");
for (const needed of ["CloudSpaces.report(", "CloudSpaces.block(", "TermsNotice(\"joining\")"]) {
  check(spacesUi.includes(needed), `CloudSpacesUi must use ${needed}`);
}
// Sharing a note has its own page; the terms come before both ways of sharing.
const shareUi = read("android/app/src/main/kotlin/com/diexar/keepcapture/CloudShareUi.kt");
check((shareUi.match(/TermsNotice\("sharing"\)/g) || []).length >= 2, "CloudShareUi must show TermsNotice(\"sharing\") before sharing with people and before making a link");
check(/runCatching \{ context\.startActivity\(Intent\(Intent\.ACTION_VIEW, Uri\.parse\("\$\{.*\/terms"/.test(spacesUi), "the terms link must follow the server and survive a phone without a browser");
// The notice line sits under the list of groups, out of sight while a group is open: a report needs its own answer.
check(spacesUi.includes("reported = true") && !spacesUi.includes('setNotice("Thanks.'), "sending a report must answer in a dialog");
// Linked from the app, so it must not lead to checkout either.
const terms = read("cloud/web/terms.html");
check(!/href="\/"|href="https?:\/\/[^"]*jotdrop\.net/.test(terms), "the terms must not link onward to the web app or the site");

// Mail to JotDrop (Payments policy): the card may name JotDrop Plus and the website,
// but no price, no currency and no tappable link or button to a checkout.
const mailUi = read("android/app/src/main/kotlin/com/diexar/keepcapture/CloudMailUi.kt");
check(!/€|\$\d|\bEUR\b|\bUSD\b|per month|per year/i.test(mailUi), "CloudMailUi must not name a price or currency");
check(!/https?:\/\/|Uri\.parse|ACTION_VIEW|uriHandler|LocalUriHandler/.test(mailUi), "CloudMailUi must not open or show a link");
check(mailUi.includes("Upgrade on our website."), "CloudMailUi names the website in words only");

// Attach file and Share to JotDrop (11 Nov 2026): a file over the plan's maximum names Plus and the website in words
// only, without a price, a currency or a link, and the code that shows it opens nothing.
for (const locale of ["", "-nl"]) {
  const file = `android/app/src/main/res/values${locale}/strings_attach.xml`;
  const text = read(file);
  check(!/€|\$\d|\bEUR\b|\bUSD\b|per month|per year|per maand|per jaar|checkout|stripe/i.test(text), `${file} must not name a price or a checkout`);
  check(!/https?:\/\/|www\./i.test(text), `${file} must not show a web link`);
}
check(read("android/app/src/main/res/values/strings_attach.xml").includes("Upgrade on our website."), "the attach Plus line names the website in words only");
for (const file of ["Attachments.kt", "AttachProblemsDialog.kt", "ShareFilesChooser.kt"]) {
  const code = read(`android/app/src/main/kotlin/com/diexar/keepcapture/${file}`);
  check(!/https?:\/\/|Uri\.parse|ACTION_VIEW|uriHandler|LocalUriHandler/.test(code), `${file} must not open or show a link`);
}

// Ask JotDrop (generative AI with the user's own key): no price, currency or checkout link in its screens and texts,
// a way to report an answer, every answer marked as AI, and a change to a note only after a yes.
const aiFiles = ["android/app/src/main/kotlin/com/diexar/keepcapture/AiActivity.kt", ...["", "-nl", "-de", "-es", "-fr", "-it"].map((locale) => `android/app/src/main/res/values${locale}/strings_ai.xml`)];
for (const file of aiFiles) {
  const text = read(file);
  check(!/€|\$\d|\bEUR\b|\bUSD\b|per month|per year|JotDrop Plus|checkout|stripe/i.test(text), `${file} must not name a price, Plus or a checkout`);
  check(!/https?:\/\/[a-z0-9]/i.test(text), `${file} must not show a web link`);
}
const aiUi = read(aiFiles[0]);
check(aiUi.includes("R.string.ai_report") && aiUi.includes("mailto:hello@jotdrop.net"), "Ask JotDrop needs a report button for answers");
check(aiUi.includes("R.string.ai_answer_label"), "Ask JotDrop must mark an answer as coming from AI");
check(aiUi.includes("AiConfirmDialog(") && read("android/app/src/main/kotlin/com/diexar/keepcapture/AiAssistant.kt").includes('tool.mode == "confirm"'), "Ask JotDrop must ask before it changes a note");

if (errors.length) {
  for (const error of errors) console.error(`FAIL: ${error}`);
  process.exit(1);
}
console.log("Play policy checks passed");

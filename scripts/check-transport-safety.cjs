const assert = require("node:assert/strict");
const fs = require("node:fs");

const manifest = fs.readFileSync("android/app/src/main/AndroidManifest.xml", "utf8");
assert.match(manifest, /android:usesCleartextTraffic="false"/, "explicitly block HTTP, including on older Android versions");
assert.doesNotMatch(manifest, /android:networkSecurityConfig=/, "audit any network security config before overriding manifest transport policy");
const fetcher = fs.readFileSync("android/app/src/main/kotlin/com/diexar/keepcapture/OgFetcher.kt", "utf8");
assert.match(fetcher, /if \(url\.protocol != "https"\) return true/, "reject plaintext preview targets");
assert.doesNotMatch(fetcher, /instanceFollowRedirects\s*=\s*true/, "automatic redirects bypass target validation");
assert.match(fetcher, /fun fetch\([^\n]+\{\s+if \(isForbiddenTarget\(url\)\)/, "validate the original URL before sending it to preview endpoints");
for (const name of ["downloadHtml", "downloadImage"]) {
  const body = fetcher.slice(fetcher.indexOf(`private fun ${name}(`), fetcher.indexOf("\n    private fun ", fetcher.indexOf(`private fun ${name}(`) + 1));
  assert.match(body, /isForbiddenTarget\(urlString\)/, `${name} must validate each target`);
  assert.match(body, /code in listOf\(301, 302, 303, 307, 308\) && redirectsRemaining > 0/, `${name} must handle bounded redirects explicitly`);
  assert.match(body, new RegExp(`return ${name}\\(.*redirectsRemaining - 1\\)`), `${name} must revalidate each redirect hop`);
}
console.log("Transport guards: explicit HTTP denial and bounded, revalidated HTML/image redirects passed");

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// One list of file kinds for every app (cloud/shared/filekinds.json). The Obsidian plugin imports it;
// the web app and Android keep their own copy, and this check keeps those copies equal.
const kinds = JSON.parse(readFileSync(new URL('./filekinds.json', import.meta.url), 'utf8'));
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const sorted = (list) => [...list].sort();

test('every extension has one kind, in lower case', () => {
  const seen = new Map();
  for (const [kind, types] of Object.entries(kinds)) {
    for (const extension of Object.keys(types)) {
      assert.equal(extension, extension.toLowerCase(), extension);
      assert.ok(!seen.has(extension), `${extension} is both ${seen.get(extension)} and ${kind}`);
      seen.set(extension, kind);
    }
  }
});

test('the web app shows the same photos and sounds', () => {
  const literal = read('../web/app.js').match(/const MEDIA_TYPES = (\{[^}]*\});/);
  assert.ok(literal, 'MEDIA_TYPES in cloud/web/app.js');
  const web = Function(`return ${literal[1]}`)();
  assert.deepEqual(web, { ...kinds.image, ...kinds.audio });
});

// Not in the server's test list: it reads the Android source next to the repo's cloud folder.
test('Android shows the same photos and sounds', () => {
  const sets = (source) => [...source.matchAll(/setOf\(((?:\s*"[a-z0-9]+",?)+)\s*\)/g)].map((m) => sorted(m[1].match(/[a-z0-9]+/g)));
  const image = sorted(Object.keys(kinds.image)), audio = sorted(Object.keys(kinds.audio));
  const kotlin = '../../android/app/src/main/kotlin/com/diexar/keepcapture/';
  for (const file of ['Storage.kt', 'EditorActivity.kt']) {
    const found = sets(read(`${kotlin}${file}`)).filter((list) => list.includes('png') || list.includes('m4a'));
    assert.deepEqual(found.filter((list) => list.includes('png')), [image], `${file}: image extensions`);
    assert.deepEqual(found.filter((list) => list.includes('m4a')), [audio], `${file}: audio extensions`);
  }
});

// Videos and PDFs get their own icon on Android's file chips (DocumentChip.kt).
test('Android shows the same videos and PDFs as files with their own icon', () => {
  const source = read('../../android/app/src/main/kotlin/com/diexar/keepcapture/DocumentChip.kt');
  const list = (name) => {
    const found = source.match(new RegExp(`${name} = setOf\\(((?:\\s*"[a-z0-9]+",?)+)\\s*\\)`));
    assert.ok(found, `${name} in DocumentChip.kt`);
    return sorted(found[1].match(/[a-z0-9]+/g));
  };
  assert.deepEqual(list('VIDEO_EXTENSIONS'), sorted(Object.keys(kinds.video)));
  assert.deepEqual(list('PDF_EXTENSIONS'), sorted(Object.keys(kinds.pdf)));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Safari before iOS 16.4 cannot load a script with a lookbehind in a regular expression, and then nothing that
// imports it runs either. So no script of ours that a page loads may have one.
const web = dirname(fileURLToPath(import.meta.url)), shared = resolve(web, '../shared'), cloud = resolve(web, '..');

/** The file a page or script asks for, if it is one of ours: /shared/... from cloud/shared, other paths from cloud/web. */
function ours(spec, from) {
  const file = spec.startsWith('/shared/') ? join(shared, spec.slice(8))
    : spec.startsWith('/') ? join(web, spec.slice(1))
      : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
  return file && existsSync(file) ? file : null;
}

/** Every script of ours the pages load: their module scripts, what those import (also later, with import()), and workers. */
function loaded() {
  const found = new Set();
  const walk = (file) => {
    if (!file || found.has(file)) return;
    found.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\b(?:import|export)\b[^'";()]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\bnew\s+(?:Shared)?Worker\(\s*['"]([^'"]+)['"]/g)) {
      walk(ours(m[1] || m[2] || m[3] || m[4], file));
    }
  };
  for (const page of readdirSync(web).filter((name) => name.endsWith('.html'))) {
    for (const m of readFileSync(join(web, page), 'utf8').matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) walk(ours(m[1], join(web, page)));
  }
  return [...found].map((file) => relative(cloud, file).replace(/\\/g, '/'));
}

test('no script the web app loads has a lookbehind', () => {
  const files = loaded();
  // The walk reaches the files it is meant for, so an empty walk cannot pass.
  for (const file of ['web/app.js', 'web/note.mjs', 'web/editor.mjs', 'web/import.mjs', 'web/ocr-worker.js', 'shared/expiry.mjs', 'shared/ai/redact.mjs']) assert.ok(files.includes(file), file);
  assert.deepEqual(files.filter((file) => /\(\?<[!=]/.test(readFileSync(join(cloud, file), 'utf8'))), []);
});

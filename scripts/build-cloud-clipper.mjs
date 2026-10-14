import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'release-staging', 'cloud-clipper-development');
await mkdir(output, { recursive: true });
await cp(resolve(root, 'chrome-extension'), output, { recursive: true });
await build({ entryPoints: [resolve(root, 'chrome-extension/cloud.mjs')], outfile: resolve(output, 'cloud-client.js'), bundle: true, format: 'iife', platform: 'browser', target: 'chrome120' });
for (const page of ['popup/popup.html', 'options/options.html']) {
  const filename = resolve(output, page);
  const html = await readFile(filename, 'utf8');
  await writeFile(filename, html.replace(page.startsWith('popup') ? '<script src="../protocol.js">' : '<script src="options.js">', page.startsWith('popup') ? '<script src="../cloud-client.js"></script>\n  <script src="../protocol.js">' : '<script src="../cloud-client.js"></script>\n  <script src="options.js">'));
}
const manifestPath = resolve(output, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.name += ' - Local Cloud Preview';
manifest.optional_host_permissions = ['https://*/*'];
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Local test extension built at ${output}. Not a store release. Explicitly allow its extension origin on the local server.`);

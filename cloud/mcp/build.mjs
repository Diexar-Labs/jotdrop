// Bundles jotdrop-mcp with the shared JotDrop code (cloud/shared, cloud/web/note.mjs) into one file, so the npm
// package never carries copies that can drift. The MCP SDK stays an ordinary dependency.
import { copyFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = (path) => new URL(path, import.meta.url);
const { version } = JSON.parse(await readFile(here('./package.json'), 'utf8'));
const { VERSION } = await import(here('./src/version.mjs'));
if (version !== VERSION) throw new Error(`package.json says ${version}, src/version.mjs says ${VERSION}.`);

await build({
  entryPoints: [fileURLToPath(here('./src/bin.mjs'))],
  outfile: fileURLToPath(here('./dist/jotdrop-mcp.mjs')),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@modelcontextprotocol/*'],
  legalComments: 'inline',
  logLevel: 'warning',
});
await copyFile(here('../../LICENSE'), here('./LICENSE'));

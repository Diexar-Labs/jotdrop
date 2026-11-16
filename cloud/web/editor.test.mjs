import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bundleCloudEditor, output } from '../../scripts/build-cloud-editor.mjs';

test('the formatted editor bundle matches its source', async () => {
  assert.equal((await readFile(output, 'utf8')).replace(/\r\n/g, '\n'), (await bundleCloudEditor()).replace(/\r\n/g, '\n'),
    'Run `npm run build:cloud-editor` after changing cloud/web/editor-src or a CodeMirror version.');
});

test('the bundle loads the core and the grid from the server, and brings no inline style', async () => {
  const bundle = await readFile(output, 'utf8');
  // One copy of the core for the whole page: the bundle imports it like app.js does.
  assert.match(bundle, /from"\/shared\/format\.mjs"/);
  assert.match(bundle, /from"\/shared\/table-grid\.mjs"/);
  assert.doesNotMatch(bundle, /function blocks\(|function tableEdit\(/);
  // The page's CSP blocks style attributes in markup; CodeMirror's own styles go through a constructed sheet.
  assert.doesNotMatch(bundle, /setAttribute\("style"/);
  assert.match(bundle, /attachShadow\(\{mode:"open"\}\)/);
});

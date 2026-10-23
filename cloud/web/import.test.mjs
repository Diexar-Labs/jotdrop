import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { bundleCloudImport, output } from '../../scripts/build-cloud-import.mjs';
import { readImport } from './import.mjs';

const { makeZip } = createRequire(import.meta.url)('../../scripts/zip-fixture.cjs');
const usec = 1760000000000000;
const keepJson = JSON.stringify({ title: 'Groceries', textContent: 'Milk #weekend', color: 'YELLOW', isPinned: true, isArchived: true, isTrashed: false,
  labels: [{ name: 'Home' }], attachments: [{ filePath: 'photo.jpg' }], createdTimestampUsec: usec, userEditedTimestampUsec: usec + 1000000 });

test('the browser import bundle matches its source', async () => {
  assert.equal((await readFile(output, 'utf8')).replace(/\r\n/g, '\n'), (await bundleCloudImport()).replace(/\r\n/g, '\n'),
    'Run `npm run build:cloud-import` after changing an importer.');
});

test('picked files go to the importer that fits them', async () => {
  const takeout = new File([makeZip([['Takeout/Keep/Groceries.json', keepJson, true], ['Takeout/Keep/photo.jpg', 'JPEGDATA', false]])], 'takeout.zip');
  const keep = await readImport([takeout]);
  assert.equal(keep.kind, 'keep');
  assert.equal(keep.items.length, 1);
  assert.equal(keep.items[0].archived, true);
  assert.equal(keep.items[0].editedMs, usec / 1000 + 1000);
  assert.deepEqual(keep.items[0].attachments, ['Takeout/Keep/photo.jpg']);
  assert.deepEqual([...await keep.files.get('Takeout/Keep/photo.jpg')()], [...new TextEncoder().encode('JPEGDATA')]);
  const markdown = keep.items[0].render(new Map([['Takeout/Keep/photo.jpg', 'photo 2.jpg']]));
  assert.match(markdown, /color: yellow/);
  assert.match(markdown, /!\[\[photo 2\.jpg\]\]/);
  assert.match(markdown, /Milk \\#weekend/);

  const enex = '<?xml version="1.0"?><en-export><note><title>Plan</title><created>20251001T080000Z</created><updated>20251002T080000Z</updated>'
    + '<content><![CDATA[<en-note><div><b>Bold</b> start</div></en-note>]]></content></note></en-export>';
  const evernote = await readImport([new File([enex], 'Work.enex')]);
  assert.equal(evernote.kind, 'evernote');
  assert.match(evernote.items[0].render(new Map()), /\*\*Bold\*\* start/);

  const apple = await readImport([new File(['# Idea\n\nA #realtag'], 'Idea.md')]);
  assert.equal(apple.kind, 'markdown');
  assert.match(apple.items[0].render(new Map()), /A #realtag/);
});

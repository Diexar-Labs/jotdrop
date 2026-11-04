import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Not in the server's test list: it reads the Android source next to the repo's cloud folder.
test('Android has the same expiry words (npm run build:paper-words)', async () => {
  const { KOTLIN_FILE, kotlinWords } = await import('../../scripts/build-paper-words.mjs');
  assert.equal(readFileSync(KOTLIN_FILE, 'utf8').replace(/\r\n/g, '\n'), kotlinWords());
});

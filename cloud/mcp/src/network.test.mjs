import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudError } from '../../shared/client.mjs';
import { isOffline } from './network.mjs';

test('only a real network problem counts as "cannot reach JotDrop Cloud"', () => {
  const named = (name) => Object.assign(new Error('stopped'), { name });
  for (const error of [new TypeError('fetch failed'), new TypeError('terminated'), named('AbortError'), named('TimeoutError'), new DOMException('The cloud stopped sending data.', 'TimeoutError'), new CloudError('Bad gateway', 502), new CloudError('Unavailable', 503), new CloudError('Gateway timeout', 504)]) {
    assert.equal(isOffline(error), true, `${error.name}: ${error.message}`);
  }
  // A programming error or a bad file must never look like a missing internet connection.
  for (const error of [new TypeError("Cannot read properties of undefined (reading 'path')"), new TypeError('The encoded data was not valid for encoding utf-8'), new CloudError('Not found', 404), new CloudError('Conflict', 409), new CloudError('Server error', 500), new Error('fetch failed'), undefined, null, 'fetch failed']) {
    assert.equal(isOffline(error), false, String(error?.message ?? error));
  }
});

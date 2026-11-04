import test from 'node:test';
import assert from 'node:assert/strict';
import { PAPER_DRAWER, expiresBadge, isPaperDrawer, localDay, shortDate, validExpires, warnReminder, withPaperDrawer } from './paper.mjs';

// The same cases as android/checks/PaperDrawerCheck.kt.
test('expires must be a real date', () => {
  assert.equal(validExpires('2027-03-12'), '2027-03-12');
  assert.equal(validExpires(' 2028-02-29 '), '2028-02-29');
  for (const bad of ['2027-02-29', '2027-13-01', '2027-3-12', '12-03-2027', '', null, undefined, '2027-03-12T09:00']) assert.equal(validExpires(bad), '', String(bad));
});

test('badge says expired only after the day itself', () => {
  assert.deepEqual(expiresBadge('2027-03-12', '2027-03-11'), { expired: false, text: 'Expires 12 Mar 2027' });
  assert.deepEqual(expiresBadge('2027-03-12', '2027-03-12'), { expired: false, text: 'Expires 12 Mar 2027' });
  assert.deepEqual(expiresBadge('2027-03-12', '2027-03-13'), { expired: true, text: 'Expired 12 Mar 2027' });
  assert.equal(expiresBadge('nope', '2027-03-13'), null);
  assert.equal(shortDate('2026-01-05'), '5 Jan 2026');
});

test('warning reminder before the expiry date', () => {
  assert.equal(warnReminder('2027-03-12', '1w'), '2027-03-05T09:00');
  assert.equal(warnReminder('2027-03-03', '1w'), '2027-02-24T09:00');
  assert.equal(warnReminder('2027-03-12', '1m'), '2027-02-12T09:00');
  assert.equal(warnReminder('2027-03-31', '1m'), '2027-02-28T09:00');
  assert.equal(warnReminder('2028-03-31', '1m'), '2028-02-29T09:00');
  assert.equal(warnReminder('2027-01-15', '2m'), '2026-11-15T09:00');
  assert.equal(warnReminder('2027-05-31', '3m'), '2027-02-28T09:00');
  assert.equal(warnReminder('2027-03-12', ''), null);
  assert.equal(warnReminder('bad', '1m'), null);
});

test('the Paper drawer label is added once', () => {
  assert.deepEqual(withPaperDrawer([]), [PAPER_DRAWER]);
  assert.deepEqual(withPaperDrawer(['Home']), ['Home', PAPER_DRAWER]);
  assert.deepEqual(withPaperDrawer(['paper DRAWER']), ['paper DRAWER']);
  assert.ok(isPaperDrawer(' Paper Drawer '));
  assert.ok(!isPaperDrawer('Papers'));
});

test('local day', () => {
  assert.equal(localDay(new Date(2027, 2, 5, 23, 59)), '2027-03-05');
});

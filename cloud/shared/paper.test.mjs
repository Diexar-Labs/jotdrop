import test from 'node:test';
import assert from 'node:assert/strict';
import { PAPER_DRAWER, drawerLabel, drawerName, expiresBadge, findExpiry, inDrawer, isPaperDrawer, localDay, shortDate, validExpires, warnReminder, withPaperDrawer } from './paper.mjs';

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

test('small drawers inside the Paper drawer', () => {
  assert.equal(drawerLabel(' Work '), 'Paper drawer/Work');
  assert.equal(drawerName('Paper drawer/Work'), 'Work');
  assert.equal(drawerName('Paper drawer'), '');
  assert.equal(drawerName('Work'), '');
  assert.ok(isPaperDrawer('paper drawer/Home'));
  assert.ok(!isPaperDrawer('Paper drawer/'));
  assert.ok(!isPaperDrawer('Paper drawers'));
  assert.deepEqual(withPaperDrawer(['Paper drawer/Work']), ['Paper drawer/Work']);
  assert.ok(inDrawer(['Paper drawer/Work'], 'Paper drawer'));
  assert.ok(inDrawer(['Paper drawer'], 'Paper drawer'));
  assert.ok(inDrawer(['paper drawer/work'], 'Paper drawer/Work'));
  assert.ok(!inDrawer(['Paper drawer/Home'], 'Paper drawer/Work'));
  assert.ok(!inDrawer(['Paper drawer'], 'Paper drawer/Work'));
  assert.ok(!inDrawer(['Home'], 'Home'));
});

// The same texts as android/checks/PaperDrawerCheck.kt.
test('expiry date found in scanned text', () => {
  assert.equal(findExpiry('Policy certificate\nStart date: 04-11-2026\nValid until: 12-03-2031\nPremium: EUR 214.00'), '2031-03-12');
  assert.equal(findExpiry('Geldig tot 01.02.2030'), '2030-02-01');
  assert.equal(findExpiry('VERVALDATUM\n15 mrt 2032'), '2032-03-15');
  assert.equal(findExpiry('Date of expiry / Date d\'expiration\n23 SEP 2033'), '2033-09-23');
  assert.equal(findExpiry('Best before 2027-06-30'), '2027-06-30');
  assert.equal(findExpiry('Expires: 06/30/2028'), '2028-06-30');
  assert.equal(findExpiry('THT 12.03.27'), '2027-03-12');
  assert.equal(findExpiry('Fecha de caducidad: 5 de mayo de 2031'), '');
  assert.equal(findExpiry('Válido hasta 05/05/2031'), '2031-05-05');
  assert.equal(findExpiry('Valid until 12-03-2031\nexpires 01-01-2029'), '2031-03-12');
  assert.equal(findExpiry('Invoice date 04-11-2026\nTotal 12.00'), '');
  assert.equal(findExpiry('Valid until 31-02-2031'), '');
  assert.equal(findExpiry(''), '');
});

test('expiry date from a passport or ID card line', () => {
  // ICAO 9303 sample passport: expiry 120415, check digit 9.
  assert.equal(findExpiry('P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10'), '2012-04-15');
  assert.equal(findExpiry('L898902C3 6UTO7408122F1204159ZE184226B<<<<< 10'), '2012-04-15');
  // A wrong check digit is OCR noise: fall back to the words.
  assert.equal(findExpiry('L898902C36UTO7408122F1204158ZE184226B<<<<<10\nDate of expiry 15 APR 2032'), '2032-04-15');
  // ICAO 9303 sample ID card (TD1) second line: expiry 120415, check digit 9.
  assert.equal(findExpiry('7408122F1204159UTO<<<<<<<<<<<6'), '2012-04-15');
});

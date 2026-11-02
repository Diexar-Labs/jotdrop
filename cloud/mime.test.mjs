import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { htmlToText, parseMail } from './mime.mjs';
import { mailToNote } from './shared/mail.mjs';

const fixture = (name) => Uint8Array.from(readFileSync(new URL(`./fixtures/mail/${name}`, import.meta.url)));

test('Gmail: the plain-text alternative wins and quoted-printable UTF-8 comes out right', () => {
  const { payload, parts, fallback } = parseMail(fixture('gmail-plain.eml'));
  assert.equal(fallback, false);
  assert.equal(payload.from, 'Anna Voss <anna.voss@gmail.com>');
  assert.equal(payload.subject, 'Boodschappen voor dinsdag');
  assert.equal(payload.date, 'Mon, 2 Nov 2026 21:01:00 +0100');
  assert.match(payload.text, /Vergeet de café niet – en neem kaas mee\./);
  assert.doesNotMatch(payload.text, /<div|=C3/);
  assert.deepEqual(payload.attachments, []);
  assert.deepEqual(parts, []);
});

test('Gmail: a base64 attachment keeps its name, type and exact bytes', () => {
  const { payload, parts, fallback } = parseMail(fixture('gmail-attachment.eml'));
  assert.equal(fallback, false);
  assert.equal(payload.text, 'De bon zit erbij.');
  assert.equal(payload.attachments.length, 1);
  assert.deepEqual(payload.attachments[0], { name: 'bon.pdf', type: 'application/pdf', size: parts[0].length });
  assert.equal(new TextDecoder().decode(parts[0]), '%PDF-1.4 fake receipt for the desk lamp');
});

test('Outlook: RFC 2047 subject and windows-1252 body decode, inline forward stays in the text', () => {
  const { payload, fallback } = parseMail(fixture('outlook-forward.eml'));
  assert.equal(fallback, false);
  assert.equal(payload.subject, 'FW: Rekening café');
  assert.match(payload.text, /Zie onder – groet Bert/);
  assert.match(payload.text, /Café De Hoek/);
  assert.match(payload.text, /Totaal € 12,50/);
});

test('Apple Mail: RFC 2231 filename with accents and base64 bytes survive', () => {
  const { payload, parts, fallback } = parseMail(fixture('apple-mail.eml'));
  assert.equal(fallback, false);
  assert.equal(payload.subject, 'Foto’s tuin');
  assert.match(payload.text, /Hierbij de foto ’s!|Hierbij de foto’s!/);
  assert.deepEqual(payload.attachments[0], { name: 'tuin café.png', type: 'image/png', size: parts[0].length });
  assert.equal(new TextDecoder().decode(parts[0]), 'PNGBYTES-not-really-a-png');
});

test('Proton: plain 8bit UTF-8 needs nothing special', () => {
  const { payload, fallback } = parseMail(fixture('proton.eml'));
  assert.equal(fallback, false);
  assert.equal(payload.text, 'Zullen we naar het café? Météo ziet er goed uit.');
});

test('HTML-only: readable text, no tags, styles or entities', () => {
  const { payload, fallback } = parseMail(fixture('html-only.eml'));
  assert.equal(fallback, false);
  assert.match(payload.text, /Beste klant,\nJe pakket komt morgen & wordt bezorgd tussen 9 en 12\./);
  assert.match(payload.text, /- Track: hier/);
  assert.doesNotMatch(payload.text, /<|style|color/);
});

test('an unknown charset never crashes the parser', () => {
  const { payload, fallback } = parseMail(fixture('bad-charset.eml'));
  assert.equal(fallback, false);
  assert.equal(payload.text, 'Gewone tekst.');
});

test('a mail forwarded as attachment becomes an .eml attachment', () => {
  const { payload, parts, fallback } = parseMail(fixture('forwarded-message.eml'));
  assert.equal(fallback, false);
  assert.equal(payload.text, 'Zie bijgevoegde mail.');
  assert.equal(payload.attachments[0].name, 'forwarded.eml');
  assert.equal(payload.attachments[0].type, 'message/rfc822');
  assert.match(new TextDecoder().decode(parts[0]), /Uw vlucht is omgeboekt\./);
});

test('anything unparseable falls back to message.eml and loses nothing', () => {
  const raw = fixture('broken.eml');
  const { payload, parts, fallback } = parseMail(raw);
  assert.equal(fallback, true);
  assert.equal(payload.subject, 'Kapotte mail');
  assert.match(payload.text, /From: kapot@example\.com/);
  assert.deepEqual(payload.attachments, [{ name: 'message.eml', type: 'message/rfc822', size: raw.length }]);
  assert.deepEqual(parts[0], raw);
  // And the note built from it still works.
  const note = mailToNote(payload, 'feedc0ffee-1111-4222-8333-444455556666'.slice(0, 36), '2026-11-06T12:00:00.000Z');
  assert.ok(note.content.includes('![[mail-feedc0-1 message.eml]]'));
});

test('hostile HTML keeps scripts and event handlers out of the text', () => {
  const text = htmlToText('<p>Hallo</p><script>alert(1)</script><img src=x onerror=alert(2)><style>x{}</style><p>Daag</p>');
  assert.equal(text, 'Hallo\nDaag');
});

test('a mail with only LF line endings parses the same', () => {
  const lf = new TextDecoder('latin1').decode(fixture('gmail-attachment.eml')).replaceAll('\r\n', '\n');
  const { payload, parts } = parseMail(Uint8Array.from([...lf].map((char) => char.charCodeAt(0))));
  assert.equal(payload.text, 'De bon zit erbij.');
  assert.equal(new TextDecoder().decode(parts[0]), '%PDF-1.4 fake receipt for the desk lamp');
});

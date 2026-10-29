import test from 'node:test';
import assert from 'node:assert/strict';
import { createSesMailer, mailHtml, mailText, signRequest } from './mailer.mjs';

test('requests are signed like the AWS Signature Version 4 test suite (get-vanilla)', () => {
  const signed = signRequest({ method: 'GET', url: 'https://example.amazonaws.com/', headers: {}, body: '', service: 'service', region: 'us-east-1',
    accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', date: new Date('2015-08-30T12:36:00Z') });
  assert.equal(signed['x-amz-date'], '20150830T123600Z');
  assert.equal(signed.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

test('the SES mailer sends one email through the SES v2 API', async () => {
  const sent = [];
  const mailer = createSesMailer({ region: 'eu-central-1', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', from: 'JotDrop <noreply@jotdrop.net>',
    clock: () => Date.parse('2026-10-23T12:00:00Z'), fetcher: async (url, options) => { sent.push({ url, options }); return new Response('{"MessageId":"1"}', { status: 200 }); } });
  await mailer({ to: 'person@example.com', kind: 'login', code: '123456' });
  assert.equal(sent.length, 1);
  const [{ url, options }] = sent;
  assert.equal(url, 'https://email.eu-central-1.amazonaws.com/v2/email/outbound-emails');
  assert.equal(options.method, 'POST');
  assert.match(options.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261023\/eu-central-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  const body = JSON.parse(options.body);
  assert.equal(body.FromEmailAddress, 'JotDrop <noreply@jotdrop.net>');
  assert.deepEqual(body.Destination, { ToAddresses: ['person@example.com'] });
  assert.match(body.Content.Simple.Subject.Data, /123456/);
  assert.match(body.Content.Simple.Body.Text.Data, /123456/);
});

test('a refused email fails, so the server can say the email could not be sent', async () => {
  const mailer = createSesMailer({ region: 'eu-central-1', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', from: 'noreply@jotdrop.net',
    fetcher: async () => new Response('{"message":"Email address is not verified."}', { status: 400 }) });
  await assert.rejects(mailer({ to: 'person@example.com', kind: 'verify', code: '123456' }), /SES refused the email \(400\)/);
});

test('every kind of mail the server sends has a text, and codes appear only where they belong', () => {
  for (const kind of ['verify', 'login', 'reset']) assert.match(mailText({ kind, code: '654321' }).body, /654321/);
  for (const kind of ['signup-exists', 'recovery-changed']) assert.doesNotMatch(mailText({ kind }).body, /\d{6}/);
  assert.throws(() => mailText({ kind: 'unknown' }), /Unknown mail kind/);
  // Public text: no em dashes.
  for (const kind of ['verify', 'login', 'reset', 'signup-exists', 'recovery-changed']) assert.doesNotMatch(JSON.stringify(mailText({ kind, code: '1' })), /\u2014/);
});

test('each mail also goes as HTML in the house style, the code large in its own box (Eric, 27 Oct)', async () => {
  const html = mailHtml({ kind: 'verify', code: '689386' });
  assert.match(html, /font-size:38px[^>]*>689386<\/div>/);
  assert.match(html, /#FBF8F1/);
  assert.match(html, />JotDrop</);
  assert.match(html, /The code works for 15 minutes/);
  // A mail without a code has no code box, and text is escaped.
  assert.doesNotMatch(mailHtml({ kind: 'signup-exists' }), /font-size:38px/);
  assert.match(mailHtml({ kind: 'provider-linked', provider: '<b>Google</b>' }), /&#60;b&#62;Google/);
  assert.doesNotMatch(mailHtml({ kind: 'reset', code: '1' }), /—/);
  const sent = [];
  const mailer = createSesMailer({ region: 'eu-central-1', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', from: 'noreply@jotdrop.net',
    fetcher: async (url, options) => { sent.push(JSON.parse(options.body)); return new Response('{}', { status: 200 }); } });
  await mailer({ to: 'person@example.com', kind: 'login', code: '123456' });
  assert.match(sent[0].Content.Simple.Body.Html.Data, />123456<\/div>/);
  assert.match(sent[0].Content.Simple.Body.Text.Data, /123456/);
});

test('the SES mailer needs all of its settings', () => {
  assert.throws(() => createSesMailer({ region: 'eu-central-1', accessKeyId: 'AKIDEXAMPLE', from: 'noreply@jotdrop.net' }), /SES/);
});

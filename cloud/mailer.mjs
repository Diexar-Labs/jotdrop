import { createHash, createHmac } from 'node:crypto';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

/** AWS Signature Version 4 for a request without a query string; returns the headers to send. */
export function signRequest({ method, url, headers, body, service, region, accessKeyId, secretAccessKey, date }) {
  const { host, pathname, search } = new URL(url);
  if (search) throw new Error('Signing a query string is not supported.');
  const amzDate = date.toISOString().replace(/[-:]|\.\d{3}/g, ''), day = amzDate.slice(0, 8);
  const all = Object.fromEntries(Object.entries({ ...headers, host, 'x-amz-date': amzDate }).map(([name, value]) => [name.toLowerCase(), String(value).trim()]));
  const names = Object.keys(all).sort();
  const scope = `${day}/${region}/${service}/aws4_request`;
  const canonical = [method, pathname, '', ...names.map((name) => `${name}:${all[name]}`), '', names.join(';'), sha256(body)].join('\n');
  const key = ['aws4_request'].reduce(hmac, [day, region, service].reduce(hmac, `AWS4${secretAccessKey}`));
  const signature = createHmac('sha256', key).update(['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')).digest('hex');
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

const footer = '\n\nJotDrop, private notes that sync end to end encrypted.';

/** The subject and plain text of each mail the server sends. */
export function mailText({ kind, code, provider }) {
  const texts = {
    verify: [`Your JotDrop code: ${code}`, `Enter this code to finish creating your JotDrop account:\n\n${code}\n\nThe code works for 15 minutes. If you did not sign up, you can ignore this email.`],
    login: [`Your JotDrop sign-in code: ${code}`, `Enter this code to sign in to JotDrop:\n\n${code}\n\nThe code works for 15 minutes. If you did not try to sign in, change your password.`],
    reset: [`Your JotDrop reset code: ${code}`, `Enter this code to choose a new JotDrop password:\n\n${code}\n\nThe code works for 15 minutes. If you did not ask for this, ignore this email; your password stays the same.`],
    'signup-exists': ['You already have a JotDrop account', 'Someone tried to create a JotDrop account with this email address, but you already have one.\n\nTo sign in, use your password, or the Google or GitHub button you used before. If you forgot your password, choose "Forgot password". If this was not you, you can ignore this email.'],
    'provider-linked': [`You can now sign in to JotDrop with ${provider}`, `Your JotDrop account can now be opened by signing in with ${provider}. A new device still needs your approval on a signed-in device, or your recovery code, before it can read your notes.\n\nIf this was not you, change your ${provider} password and check the devices in your JotDrop account.`],
    'account-deleted': ['Your JotDrop account was deleted', 'Your JotDrop account and everything in your JotDrop Cloud were deleted, and every device was signed out. Your notes on your own devices were not touched.\n\nIf this was not you, write to hello@jotdrop.net.'],
    'recovery-changed': ['Your JotDrop recovery code was changed', 'A new recovery code was made for your JotDrop cloud. The old code no longer works.\n\nIf this was you, keep the new code in a safe place. If this was not you, change your password and make a new recovery code.'],
  };
  if (!texts[kind]) throw new Error(`Unknown mail kind: ${kind}`);
  const [subject, body] = texts[kind];
  return { subject, body: body + footer };
}

const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
const FONT = "'Instrument Sans', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** The same mail dressed in the house style "paper and ink" (Eric, 27 Oct): the code large in an amber box, easy to copy.
 * Tables and inline styles only, since mail apps ignore style sheets; the plain text goes along for apps that show no HTML. */
export function mailHtml({ kind, code, provider }) {
  const { subject, body } = mailText({ kind, code, provider });
  const paragraphs = body.split('\n\n');
  const closing = paragraphs.pop();
  const content = paragraphs.map((paragraph) => paragraph === code
    ? `<div style="margin:22px 0;padding:16px 8px 16px 18px;background:#F4C458;border:2px solid #14213D;border-radius:10px 10px 22px 10px;text-align:center;font-family:'JetBrains Mono',Consolas,'Courier New',monospace;font-size:38px;line-height:1.1;font-weight:700;letter-spacing:10px;color:#14213D;">${escapeHtml(code)}</div>`
    : `<p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:#14213D;">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light only"><title>${escapeHtml(subject)}</title></head>`
    + `<body style="margin:0;padding:0;background:#FBF8F1;font-family:${FONT};">`
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FBF8F1;"><tr><td align="center" style="padding:32px 16px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#FFFFFF;border:2px solid #14213D;border-radius:12px 12px 28px 12px;box-shadow:6px 6px 0 #F4C458;">'
    // The logo as type, not an image: many mail apps block images at first.
    + `<tr><td style="padding:26px 28px 6px;font-family:${FONT};"><span style="display:inline-block;width:34px;height:34px;line-height:34px;text-align:center;background:#F4C458;border:2px solid #14213D;border-radius:7px 7px 14px 7px;font-size:20px;font-weight:800;color:#14213D;">J</span>`
    + '<span style="padding-left:10px;font-size:21px;font-weight:800;letter-spacing:-0.02em;color:#14213D;vertical-align:middle;">JotDrop</span></td></tr>'
    + `<tr><td style="padding:16px 28px 22px;font-family:${FONT};">${content}</td></tr></table>`
    + `<p style="max-width:480px;margin:18px auto 0;font-family:${FONT};font-size:13px;line-height:1.5;color:#56607A;">${escapeHtml(closing)}</p>`
    + '</td></tr></table></body></html>';
}

/** Adds someone who ticked "Email me news about JotDrop" to a Brevo contact list; Brevo handles unsubscribing. `remove` forgets a deleted account. */
export function createBrevoList({ apiKey, listId, fetcher = globalThis.fetch }) {
  if (typeof apiKey !== 'string' || !apiKey || !Number.isSafeInteger(listId) || listId < 1) throw new Error('Provide the Brevo API key and list ID.');
  const add = async (email) => {
    const body = JSON.stringify({ email, listIds: [listId], updateEnabled: true });
    const response = await fetcher('https://api.brevo.com/v3/contacts', { method: 'POST', headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' }, body, signal: AbortSignal.timeout(10000) });
    await response.body?.cancel();
    // The reason stays out of the error: it can repeat the address.
    if (!response.ok) throw new Error(`Brevo refused the contact (${response.status}).`);
  };
  add.remove = async (email) => {
    const response = await fetcher(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, { method: 'DELETE', headers: { 'api-key': apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    await response.body?.cancel();
    // 404: Brevo never had the address.
    if (!response.ok && response.status !== 404) throw new Error(`Brevo refused to delete the contact (${response.status}).`);
  };
  return add;
}

/** Sends the server's mail through the Amazon SES v2 API. `from` is a verified sender, for example "JotDrop <noreply@jotdrop.net>". */
export function createSesMailer({ region, accessKeyId, secretAccessKey, from, fetcher = globalThis.fetch, clock = Date.now }) {
  if (![region, accessKeyId, secretAccessKey, from].every((value) => typeof value === 'string' && value.length > 0) || !/^[a-z]{2}-[a-z]+-\d$/.test(region)) throw new Error('Provide the SES region, access key, secret key and sender address.');
  const url = `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;
  return async ({ to, kind, code, provider }) => {
    const { subject, body: text } = mailText({ kind, code, provider });
    const html = mailHtml({ kind, code, provider });
    const body = JSON.stringify({ FromEmailAddress: from, Destination: { ToAddresses: [to] }, Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: text, Charset: 'UTF-8' }, Html: { Data: html, Charset: 'UTF-8' } } } } });
    const headers = signRequest({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-amz-content-sha256': sha256(body) }, body, service: 'ses', region, accessKeyId, secretAccessKey, date: new Date(clock()) });
    const response = await fetcher(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
    // The reason stays out of the error: it can repeat the address.
    if (!response.ok) { await response.body?.cancel(); throw new Error(`SES refused the email (${response.status}).`); }
    await response.body?.cancel();
  };
}

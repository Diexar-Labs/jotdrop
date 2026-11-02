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

// The trial mails are service notices about the account's own trial: worded as information, not promotion,
// and at most two per account (jurist, 2 Nov 2026; LSSI art. 21 covers promotional mail).
// Opens the Plus choice in the web app, after signing in (`takePlanChoice` in web/app.js).
const PLUS_LINK = 'https://app.jotdrop.net/?plan=plus';
// What stays above the free plan once the trial ends; empty when everything fits in Free.
function aboveFreeLines(trial) {
  const lines = [];
  if (trial.usedMb) lines.push(`- You use ${trial.usedMb} MB, and Free has ${trial.quotaMb} MB. Everything stays and you can still read it, but new notes and photos only sync once there is room again.`);
  if (trial.devices) lines.push(`- ${trial.devices} devices are signed in, and Free has ${trial.deviceLimit}. They all keep working. To add a new one, sign out one of these first.`);
  if (trial.groups) lines.push(`- You share ${trial.groups} notes or lists, and Free shares one. They all keep working; only a new one needs Plus.`);
  if (trial.links) lines.push(`- ${trial.links === 1 ? '1 note link is' : `${trial.links} note links are`} older than 7 days. On Free a link lasts 7 days, so ${trial.links === 1 ? 'it is' : 'they are'} paused. With Plus ${trial.links === 1 ? 'it works' : 'they work'} again.`);
  return lines;
}

/** The subject and plain text of each mail the server sends. */
export function mailText({ kind, code, provider, report, trial }) {
  const texts = {
    verify: [`Your JotDrop code: ${code}`, `Enter this code to finish creating your JotDrop account:\n\n${code}\n\nThe code works for 15 minutes. If you did not sign up, you can ignore this email.`],
    login: [`Your JotDrop sign-in code: ${code}`, `Enter this code to sign in to JotDrop:\n\n${code}\n\nThe code works for 15 minutes. If you did not try to sign in, change your password.`],
    reset: [`Your JotDrop reset code: ${code}`, `Enter this code to choose a new JotDrop password:\n\n${code}\n\nThe code works for 15 minutes. If you did not ask for this, ignore this email; your password stays the same.`],
    'signup-exists': ['You already have a JotDrop account', 'Someone tried to create a JotDrop account with this email address, but you already have one.\n\nTo sign in, use your password, or the Google or GitHub button you used before. If you forgot your password, choose "Forgot password". If this was not you, you can ignore this email.'],
    'provider-linked': [`You can now sign in to JotDrop with ${provider}`, `Your JotDrop account can now be opened by signing in with ${provider}. A new device still needs your approval on a signed-in device, or your recovery code, before it can read your notes.\n\nIf this was not you, change your ${provider} password and check the devices in your JotDrop account.`],
    'account-deleted': ['Your JotDrop account was deleted', 'Your JotDrop account and everything in your JotDrop Cloud were deleted, and every device was signed out. Your notes on your own devices were not touched.\n\nIf this was not you, write to hello@jotdrop.net.'],
    'group-removed': ['A shared group was removed from JotDrop', 'We removed a shared group you were in, because someone reported it and it broke our terms of use. Notes already on your devices stay there.\n\nIf you think this is wrong, reply to hello@jotdrop.net.'],
    'link-removed': ['A note link was removed from JotDrop', 'We removed a link to one of your notes, because someone reported it and it broke our terms of use. The note itself stays with you.\n\nIf you think this is a mistake, write to hello@jotdrop.net.'],
    'account-closed': ['Your JotDrop account was closed', 'We closed your JotDrop account because it broke our terms of use. Your cloud and devices were removed from JotDrop, and a running JotDrop Plus subscription was cancelled. Notes on your own devices were not touched.\n\nIf you think this is wrong, reply to hello@jotdrop.net.'],
    'recovery-changed': ['Your JotDrop recovery code was changed', 'A new recovery code was made for your JotDrop cloud. The old code no longer works.\n\nIf this was you, keep the new code in a safe place. If this was not you, change your password and make a new recovery code.'],
  };
  if (kind === 'trial-ending') {
    const lines = aboveFreeLines(trial), day = new Date(trial.endsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
    const now = lines.length ? `This is what you use now that goes beyond Free:\n${lines.join('\n')}` : 'Everything you use now also fits in Free: 250 MB, 2 devices, one shared note, one note link and 30 days of history.';
    texts[kind] = ['Your JotDrop Plus trial ends in 3 days', `Your 14 days of JotDrop Plus end on ${day}. After that your cloud moves to the free plan. Nothing is deleted, and nothing is charged.\n\n${now}\n\nIf you want Plus after that, you can choose it at ${PLUS_LINK}. If you do nothing, you stay on Free.\n\nYou get this email because every new JotDrop account starts with a Plus trial. We send two emails about it: this one, and one on the day it ends.`];
  }
  if (kind === 'trial-ended') {
    const lines = aboveFreeLines(trial);
    const now = lines.length ? `A few things go beyond Free:\n${lines.join('\n')}` : 'Everything you have fits in Free, so nothing changes for you.';
    texts[kind] = ['Your JotDrop Plus trial has ended', `Your cloud is on the free plan now. Your notes, photos and history are all still there.\n\n${now}\n\nIf you want Plus later, you can choose it at ${PLUS_LINK}.\n\nThis is the last email about your trial.`];
  }
  // Only for us. What the writer typed stays plain text here; mailHtml escapes it.
  if (kind === 'space-report') texts[kind] = [`JotDrop report: ${report.reason}`, `Someone reported something in a shared group.\n\nReason: ${report.reason}\nFrom: ${report.from}\nAbout: ${report.about ?? 'the group'}\nGroup: ${report.spaceId}\n\nTheir words, each line marked:\n${(report.details || 'They wrote nothing more.').split('\n').map((line) => `> ${line}`).join('\n')}\n\nThe server cannot read the notes in this group. Ask the writer if you need to see them.`];
  if (kind === 'link-report') texts[kind] = [`JotDrop link report: ${report.reason}`, `Someone reported a shared note link. We cannot read the note: open the link only if the report includes it.\n\nReason: ${report.reason}\nOwner: ${report.owner}\nLink ID: ${report.linkId}\n\nWhat they wrote:\n${report.details.split('\n').map((text) => `> ${text}`).join('\n')}`];
  if (!texts[kind]) throw new Error(`Unknown mail kind: ${kind}`);
  const [subject, body] = texts[kind];
  return { subject, body: body + footer };
}

const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
const FONT = "'Instrument Sans', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** The same mail dressed in the house style "paper and ink" (Eric, 27 Oct): the code large in an amber box, easy to copy.
 * Tables and inline styles only, since mail apps ignore style sheets; the plain text goes along for apps that show no HTML. */
export function mailHtml({ kind, code, provider, report, trial }) {
  const { subject, body } = mailText({ kind, code, provider, report, trial });
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
  return async ({ to, kind, code, provider, report, trial }) => {
    const { subject, body: text } = mailText({ kind, code, provider, report, trial });
    const html = mailHtml({ kind, code, provider, report, trial });
    const body = JSON.stringify({ FromEmailAddress: from, Destination: { ToAddresses: [to] }, Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: text, Charset: 'UTF-8' }, Html: { Data: html, Charset: 'UTF-8' } } } } });
    const headers = signRequest({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-amz-content-sha256': sha256(body) }, body, service: 'ses', region, accessKeyId, secretAccessKey, date: new Date(clock()) });
    const response = await fetcher(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
    // The reason stays out of the error: it can repeat the address.
    if (!response.ok) { await response.body?.cancel(); throw new Error(`SES refused the email (${response.status}).`); }
    await response.body?.cancel();
  };
}

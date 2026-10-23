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
export function mailText({ kind, code }) {
  const texts = {
    verify: [`Your JotDrop code: ${code}`, `Enter this code to finish creating your JotDrop account:\n\n${code}\n\nThe code works for 15 minutes. If you did not sign up, you can ignore this email.`],
    login: [`Your JotDrop sign-in code: ${code}`, `Enter this code to sign in to JotDrop:\n\n${code}\n\nThe code works for 15 minutes. If you did not try to sign in, change your password.`],
    reset: [`Your JotDrop reset code: ${code}`, `Enter this code to choose a new JotDrop password:\n\n${code}\n\nThe code works for 15 minutes. If you did not ask for this, ignore this email; your password stays the same.`],
    'signup-exists': ['You already have a JotDrop account', 'Someone tried to create a JotDrop account with this email address, but you already have one.\n\nTo sign in, use your password. If you forgot it, choose "Forgot password". If this was not you, you can ignore this email.'],
    'recovery-changed': ['Your JotDrop recovery code was changed', 'A new recovery code was made for your JotDrop cloud. The old code no longer works.\n\nIf this was you, keep the new code in a safe place. If this was not you, change your password and make a new recovery code.'],
  };
  if (!texts[kind]) throw new Error(`Unknown mail kind: ${kind}`);
  const [subject, body] = texts[kind];
  return { subject, body: body + footer };
}

/** Sends the server's mail through the Amazon SES v2 API. `from` is a verified sender, for example "JotDrop <noreply@jotdrop.net>". */
export function createSesMailer({ region, accessKeyId, secretAccessKey, from, fetcher = globalThis.fetch, clock = Date.now }) {
  if (![region, accessKeyId, secretAccessKey, from].every((value) => typeof value === 'string' && value.length > 0) || !/^[a-z]{2}-[a-z]+-\d$/.test(region)) throw new Error('Provide the SES region, access key, secret key and sender address.');
  const url = `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;
  return async ({ to, kind, code }) => {
    const { subject, body: text } = mailText({ kind, code });
    const body = JSON.stringify({ FromEmailAddress: from, Destination: { ToAddresses: [to] }, Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: text, Charset: 'UTF-8' } } } } });
    const headers = signRequest({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-amz-content-sha256': sha256(body) }, body, service: 'ses', region, accessKeyId, secretAccessKey, date: new Date(clock()) });
    const response = await fetcher(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
    // The reason stays out of the error: it can repeat the address.
    if (!response.ok) { await response.body?.cancel(); throw new Error(`SES refused the email (${response.status}).`); }
    await response.body?.cancel();
  };
}

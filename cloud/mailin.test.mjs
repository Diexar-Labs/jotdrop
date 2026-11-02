import test from 'node:test';
import assert from 'node:assert/strict';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudServer } from './server.mjs';
import { createMailin } from './mailin.mjs';
import { CloudClient } from './shared/client.mjs';
import { encryptEnvelope, generateVaultKey, hashToken, randomToken } from './shared/crypto.mjs';
import { addressHash, mailAddress, mailKeyPair, mailToNote, openMailBody, openMailKey, openMailPart } from './shared/mail.mjs';

const DOMAIN = 'in.test.jotdrop.net';
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const fixturePath = (name) => fileURLToPath(new URL(`./fixtures/mail/${name}`, import.meta.url));

async function fixture(t, mailinOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-mailin-test-'));
  const mails = [];
  let now = Date.parse('2026-11-03T08:00:00Z');
  const mailinToken = randomToken();
  const app = await createCloudServer({ dataDir, mailer: async (mail) => { mails.push(mail); }, serverKey: randomToken(), enrollmentToken: randomToken(), clock: () => now, signupsPerAddress: 1000, mailDomain: DOMAIN, mailinToken });
  const mailin = await createMailin({ hostname: DOMAIN, apiUrl: `http://127.0.0.1:${app.port}`, mailinToken, port: 0, tlsKey: fixturePath('tls-test-key.pem'), tlsCert: fixturePath('tls-test-cert.pem'), ...mailinOptions });
  t.after(async () => { await mailin.close(); await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  const api = async (path, body) => {
    const response = await fetch(`${url}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: JSON.parse(await response.text() || 'null') };
  };
  return { mails, url, api, mailin, advance: (ms) => { now += ms; } };
}

async function signUp(cloud, name) {
  const email = `${name}@example.test`, vaultKey = generateVaultKey(), token = randomToken();
  const started = await cloud.api('/accounts', { email, authKey: randomToken(), kdf: { salt: b64(randomBytes(16)), memory: 65536, passes: 3, parallelism: 1 }, wrappedVaultKey: JSON.stringify(await encryptEnvelope(randomToken(), { vaultKey }, 'jotdrop:wrap:v1')), recoveryTokenHash: await hashToken(randomToken()), deviceName: 'Phone', deviceTokenHash: await hashToken(token) });
  assert.equal(started.status, 202);
  const code = cloud.mails.filter((mail) => mail.to === email && mail.kind === 'verify').at(-1).code;
  const verified = await cloud.api('/accounts/verify', { signupId: started.body.signupId, code });
  assert.equal(verified.status, 201);
  const client = new CloudClient({ url: cloud.url, vaultId: verified.body.vaultId, deviceId: verified.body.deviceId, token, vaultKey });
  const pair = await mailKeyPair(vaultKey);
  const address = mailAddress(DOMAIN);
  await client.call('/mail', 'POST', { action: 'enable', publicKey: pair.publicKey, addressHash: await addressHash(address), addressEnvelope: JSON.stringify(await encryptEnvelope(vaultKey, { address }, 'jotdrop:mail-address:v1')) });
  return { client, vaultKey, pair, address };
}

/** A small SMTP talker: sends a line, reads until the final line of the reply, returns its code. */
function talker(socket) {
  let buffer = '', waiter = null;
  const feed = (chunk) => { buffer += chunk.toString('latin1'); waiter?.(); };
  socket.on('data', feed);
  const readReply = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No reply; have: ${JSON.stringify(buffer)}`)), 10000);
    const check = () => {
      const lines = buffer.split('\r\n');
      for (let index = 0; index < lines.length - 1; index++) {
        if (/^\d{3} /.test(lines[index])) {
          const kept = lines.slice(0, index + 1);
          buffer = lines.slice(index + 1).join('\r\n');
          clearTimeout(timer);
          resolve({ code: kept.at(-1).slice(0, 3), lines: kept });
          return;
        }
      }
      waiter = check;
    };
    check();
  });
  return { readReply, send: (line) => { socket.write(line + '\r\n'); return readReply(); }, raw: (text) => socket.write(text), socket, rewire: (next) => { socket.off('data', feed); socket = next; socket.on('data', feed); } };
}

const open = (port) => new Promise((resolve, reject) => {
  const socket = netConnect({ host: '127.0.0.1', port }, () => resolve(talker(socket)));
  socket.on('error', reject);
});

/** Sends one mail through a fresh SMTP session and returns the final reply code. */
async function smtpSend(port, { from = 'sender@example.test', to, data, starttls = false }) {
  const smtp = await open(port);
  assert.equal((await smtp.readReply()).code, '220');
  assert.equal((await smtp.send(`EHLO client.example.test`)).code, '250');
  if (starttls) {
    assert.equal((await smtp.send('STARTTLS')).code, '220');
    const upgraded = await new Promise((resolve, reject) => {
      const secure = tlsConnect({ socket: smtp.socket, rejectUnauthorized: false }, () => resolve(secure));
      secure.on('error', reject);
    });
    smtp.rewire(upgraded);
    assert.equal((await smtp.send(`EHLO client.example.test`)).code, '250');
  }
  assert.equal((await smtp.send(`MAIL FROM:<${from}>`)).code, '250');
  const rcpt = await smtp.send(`RCPT TO:<${to}>`);
  if (rcpt.code !== '250') { await smtp.send('QUIT'); return { code: rcpt.code, stage: 'rcpt' }; }
  assert.equal((await smtp.send('DATA')).code, '354');
  smtp.raw(data.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..'));
  const outcome = await smtp.send('\r\n.');
  await smtp.send('QUIT');
  return { code: outcome.code, stage: 'data' };
}

test('a real SMTP session ends as a readable note with the attachment bytes intact', async (t) => {
  const cloud = await fixture(t);
  const account = await signUp(cloud, 'ana');
  const raw = readFileSync(fixturePath('gmail-attachment.eml'), 'latin1');
  const sent = await smtpSend(cloud.mailin.port, { from: 'anna.voss@gmail.com', to: account.address, data: raw });
  assert.deepEqual(sent, { code: '250', stage: 'data' });
  const { items } = await account.client.call('/mail', 'GET');
  assert.equal(items.length, 1);
  const item = await account.client.call(`/mail/${items[0].id}`, 'GET');
  const key = await openMailKey(account.pair.privateKey, account.pair.publicKey, item.ephemeralKey, item.id);
  const vaultId = account.client.credentials.vaultId;
  const payload = await openMailBody(key, vaultId, item.id, item.body);
  assert.equal(payload.subject, 'Bon van de lamp');
  assert.equal(payload.text, 'De bon zit erbij.');
  assert.deepEqual(payload.attachments.map(({ name, type }) => ({ name, type })), [{ name: 'bon.pdf', type: 'application/pdf' }]);
  const part = await account.client.call(`/mail/${item.id}/parts/0`, 'GET');
  assert.equal(new TextDecoder().decode(await openMailPart(key, vaultId, item.id, 0, part.sealed)), '%PDF-1.4 fake receipt for the desk lamp');
  const note = mailToNote(payload, item.id, item.receivedAt);
  assert.ok(note.path.startsWith('notes/Mail/2026-11-03 Bon van de lamp '));
  assert.ok(note.content.endsWith('#mail\n'));
});

test('the same mail arrives over STARTTLS, and dots at line starts survive the wire', async (t) => {
  const cloud = await fixture(t);
  const account = await signUp(cloud, 'ben');
  const data = ['From: Dot <dot@example.test>', `To: ${account.address}`, 'Subject: Dots', '', '.hidden dot line', '..double', 'done', ''].join('\r\n');
  const sent = await smtpSend(cloud.mailin.port, { to: account.address, data, starttls: true });
  assert.equal(sent.code, '250');
  const { items } = await account.client.call('/mail', 'GET');
  const item = await account.client.call(`/mail/${items[0].id}`, 'GET');
  const key = await openMailKey(account.pair.privateKey, account.pair.publicKey, item.ephemeralKey, item.id);
  const payload = await openMailBody(key, account.client.credentials.vaultId, item.id, item.body);
  assert.equal(payload.text, '.hidden dot line\n..double\ndone');
});

test('RCPT refuses strangers, lost Plus and bad destinations without storing anything', async (t) => {
  const cloud = await fixture(t);
  const account = await signUp(cloud, 'cas');
  assert.deepEqual(await smtpSend(cloud.mailin.port, { to: `${'x'.repeat(12)}@${DOMAIN}`, data: 'x' }), { code: '550', stage: 'rcpt' });
  cloud.advance(15 * 24 * 60 * 60 * 1000);
  assert.deepEqual(await smtpSend(cloud.mailin.port, { to: account.address, data: 'x' }), { code: '550', stage: 'rcpt' });
  assert.deepEqual((await account.client.call('/mail', 'GET')).items, []);
});

test('the SMTP rules hold: order, size, unknown commands and connection limits', async (t) => {
  const cloud = await fixture(t, { maxPerIp: 2 });
  const account = await signUp(cloud, 'eva');
  const smtp = await open(cloud.mailin.port);
  assert.equal((await smtp.readReply()).code, '220');
  const ehlo = await smtp.send('EHLO x');
  assert.ok(ehlo.lines.some((line) => line.includes('STARTTLS')));
  assert.ok(ehlo.lines.some((line) => line.includes(`SIZE ${20 * 1024 * 1024}`)));
  assert.equal((await smtp.send('DATA')).code, '503');
  assert.equal((await smtp.send('RCPT TO:<x@y.z>')).code, '503');
  assert.equal((await smtp.send('MAKEUP')).code, '500');
  assert.equal((await smtp.send(`MAIL FROM:<a@b.c> SIZE=${50 * 1024 * 1024}`)).code, '552');
  assert.equal((await smtp.send('MAIL FROM:<a@b.c>')).code, '250');
  assert.equal((await smtp.send('MAIL FROM:<a@b.c>')).code, '503');
  assert.equal((await smtp.send('RSET')).code, '250');
  assert.equal((await smtp.send('VRFY x')).code, '252');
  // A message over the limit is read to its end and refused, and the session stays usable.
  assert.equal((await smtp.send('MAIL FROM:<a@b.c>')).code, '250');
  assert.equal((await smtp.send(`RCPT TO:<${account.address}>`)).code, '250');
  assert.equal((await smtp.send('DATA')).code, '354');
  const chunk = `${'a'.repeat(998)}\r\n`;
  for (let sent = 0; sent < 21 * 1024 * 1024; sent += chunk.length) smtp.raw(chunk);
  assert.equal((await smtp.send('.')).code, '552');
  assert.equal((await smtp.send('NOOP')).code, '250');
  assert.equal((await smtp.send('QUIT')).code, '221');
  // The third connection from one address is turned away.
  const first = await open(cloud.mailin.port), second = await open(cloud.mailin.port);
  assert.equal((await first.readReply()).code, '220');
  assert.equal((await second.readReply()).code, '220');
  const third = await open(cloud.mailin.port);
  assert.equal((await third.readReply()).code, '421');
  for (const extra of [first, second, third]) extra.socket.destroy();
  assert.deepEqual((await account.client.call('/mail', 'GET')).items, []);
});

test('when the main server is unreachable the answer is a retry, never a loss', async (t) => {
  const mailinToken = randomToken();
  const mailin = await createMailin({ hostname: DOMAIN, apiUrl: 'http://127.0.0.1:9', mailinToken, port: 0 });
  t.after(() => mailin.close());
  const smtp = await open(mailin.port);
  assert.equal((await smtp.readReply()).code, '220');
  assert.equal((await smtp.send('EHLO x')).code, '250');
  assert.equal((await smtp.send('MAIL FROM:<a@b.c>')).code, '250');
  assert.equal((await smtp.send(`RCPT TO:<x@${DOMAIN}>`)).code, '451');
  assert.equal((await smtp.send('QUIT')).code, '221');
});

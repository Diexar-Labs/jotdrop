/**
 * Mail to JotDrop's receiving process: a small SMTP listener next to the main server.
 * A mail lives only in this process's memory, readable for one moment. It is parsed (mime.mjs),
 * sealed to the account's public key (shared/mail.mjs) and handed to the main server over loopback.
 * The main server never sees a readable mail; this process never touches a disk.
 *
 * No runtime dependencies, like the rest of the cloud. Refusals happen at RCPT where possible,
 * so the sending server reports them and we never send backscatter.
 */
import { createServer } from 'node:net';
import { TLSSocket, createSecureContext } from 'node:tls';
import { readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseMail } from './mime.mjs';
import { MAX_MAIL_BYTES, addressHash, sealMail, senderHash } from './shared/mail.mjs';

const CRLF = '\r\n';
const MAX_COMMAND = 2048;
const MAX_RECIPIENTS = 4;
const MAX_MAILS_PER_CONNECTION = 20;

const REFUSALS = {
  unknown: '550 5.1.1 No such mailbox here',
  'no-plus': '550 5.2.1 Mailbox unavailable',
  sender: '550 5.7.1 Sender not allowed for this mailbox',
  full: '452 4.2.2 Mailbox full, try again later',
  rate: '452 4.2.1 Too much mail for this mailbox, try again later',
};

const mailboxIn = (line) => /<([^<>]*)>/.exec(line)?.[1] ?? line.split(/[\s=]/)[0];

export async function createMailin({ hostname, apiUrl, mailinToken, tlsKey, tlsCert, port = 25, maxConnections = 20, maxPerIp = 3, commandTimeout = 120000, fetcher = globalThis.fetch, log = () => {} }) {
  if (!hostname || !apiUrl || !mailinToken) throw new Error('Provide the hostname, the main server URL and the mailin token.');
  if (Boolean(tlsKey) !== Boolean(tlsCert)) throw new Error('Provide both the TLS key and certificate, or neither.');
  let context = null, certSeen = 0;
  function secureContext() {
    // Let's Encrypt renews in place: pick up a changed certificate without a restart.
    const changed = statSync(tlsCert).mtimeMs;
    if (!context || changed !== certSeen) { context = createSecureContext({ key: readFileSync(tlsKey), cert: readFileSync(tlsCert) }); certSeen = changed; }
    return context;
  }

  async function api(path, value) {
    const response = await fetcher(`${apiUrl}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mailinToken}` }, body: JSON.stringify(value), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`The main server answered ${response.status}.`);
    return response.json();
  }

  const sockets = new Set(), perIp = new Map();
  const server = createServer((socket) => {
    const ip = socket.remoteAddress ?? '?';
    const sameIp = (perIp.get(ip) ?? 0) + 1;
    if (sockets.size >= maxConnections || sameIp > maxPerIp) {
      socket.end(`421 4.3.2 Too many connections, try again later${CRLF}`);
      socket.destroy();
      return;
    }
    perIp.set(ip, sameIp);
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left <= 0) perIp.delete(ip); else perIp.set(ip, left);
    });
    session(socket, ip);
  });

  function session(first, ip) {
    // All state of one connection; STARTTLS swaps the socket and resets everything else, as the RFC asks.
    const state = { buffer: '', from: null, recipients: [], data: null, oversize: false, mails: 0, busy: false, secure: false, quit: false };
    let socket = first;
    const write = (line) => { if (!socket.destroyed) socket.write(line + CRLF); };
    const reset = () => { state.from = null; state.recipients = []; state.data = null; state.oversize = false; state.scanned = 0; };
    function hangUp(line) {
      if (line) write(line);
      state.quit = true;
      socket.end();
      setTimeout(() => socket.destroy(), 2000).unref();
    }

    function attach() {
      socket.setTimeout(commandTimeout, () => hangUp('421 4.4.2 Idle too long, closing'));
      socket.on('data', (chunk) => {
        state.buffer += chunk.toString('latin1');
        if (state.data === null && state.buffer.length > MAX_COMMAND * 4) return hangUp('500 5.5.2 Command line too long');
        void pump();
      });
      socket.on('error', () => socket.destroy());
    }

    async function pump() {
      if (state.busy) return;
      state.busy = true;
      try {
        while (!state.quit && !socket.destroyed) {
          if (state.data !== null) {
            // DATA mode: everything until <CRLF>.<CRLF>. `state.data` starts with a virtual CRLF, so a terminator
            // on the very first line is found too. An oversized mail is still read to its end, but not kept.
            state.data += state.buffer;
            state.buffer = '';
            const end = state.data.indexOf(`${CRLF}.${CRLF}`, Math.max(0, state.scanned - 4));
            state.scanned = state.data.length;
            if (end < 0) {
              if (state.data.length > MAX_MAIL_BYTES + 1024 * 1024) { state.oversize = true; state.data = state.data.slice(-4); state.scanned = 0; }
              return;
            }
            state.buffer = state.data.slice(end + 5);
            const raw = state.oversize || end > MAX_MAIL_BYTES ? null : state.data.slice(2, end + 2).replace(/^\.\./, '.').replaceAll(`${CRLF}..`, `${CRLF}.`);
            const { recipients, from } = state;
            reset();
            if (raw === null) { write(`552 5.3.4 Message too large, at most ${Math.floor(MAX_MAIL_BYTES / (1024 * 1024))} MB`); continue; }
            write(await deliver(Buffer.from(raw, 'latin1'), recipients, from));
            continue;
          }
          const lineEnd = state.buffer.indexOf(CRLF);
          if (lineEnd < 0) return;
          const line = state.buffer.slice(0, lineEnd);
          state.buffer = state.buffer.slice(lineEnd + 2);
          if (line.length > MAX_COMMAND) { write('500 5.5.2 Command line too long'); continue; }
          await command(line);
        }
      } catch (error) {
        log(`mailin: ${ip}: ${error.message}`);
        hangUp('421 4.3.0 Local error, closing');
      } finally {
        state.busy = false;
      }
    }

    async function command(line) {
      const space = line.indexOf(' ');
      const verb = (space < 0 ? line : line.slice(0, space)).toUpperCase();
      const rest = space < 0 ? '' : line.slice(space + 1).trim();
      if (verb === 'QUIT') return hangUp('221 2.0.0 Bye');
      if (verb === 'NOOP') return write('250 2.0.0 Ok');
      if (verb === 'RSET') { reset(); return write('250 2.0.0 Ok'); }
      if (verb === 'HELO') { reset(); return write(`250 ${hostname}`); }
      if (verb === 'EHLO') {
        reset();
        const lines = [hostname, `SIZE ${MAX_MAIL_BYTES}`, '8BITMIME', 'SMTPUTF8', ...!state.secure && tlsCert ? ['STARTTLS'] : []];
        return write(lines.map((entry, index) => `250${index === lines.length - 1 ? ' ' : '-'}${entry}`).join(CRLF));
      }
      if (verb === 'STARTTLS') {
        if (state.secure || !tlsCert) return write('502 5.5.1 Not available');
        if (state.buffer) return write('503 5.5.1 No pipelining across STARTTLS');
        write('220 2.0.0 Ready to start TLS');
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        socket.setTimeout(0);
        const plain = socket;
        socket = new TLSSocket(plain, { isServer: true, secureContext: secureContext() });
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        state.secure = true;
        state.buffer = '';
        reset();
        attach();
        return;
      }
      if (verb === 'MAIL') {
        if (state.from !== null) return write('503 5.5.1 Nested MAIL');
        const declared = /\bSIZE=(\d{1,12})/i.exec(rest)?.[1];
        if (declared && Number(declared) > MAX_MAIL_BYTES) return write(`552 5.3.4 Message too large, at most ${Math.floor(MAX_MAIL_BYTES / (1024 * 1024))} MB`);
        state.from = mailboxIn(rest.replace(/^from:\s*/i, '')).toLowerCase();
        return write('250 2.1.0 Ok');
      }
      if (verb === 'RCPT') {
        if (state.from === null) return write('503 5.5.1 MAIL first');
        if (state.recipients.length >= MAX_RECIPIENTS) return write('452 4.5.3 Too many recipients');
        const address = mailboxIn(rest.replace(/^to:\s*/i, '')).toLowerCase();
        if (!address.includes('@') || address.length > 320) return write('550 5.1.1 No such mailbox here');
        let found;
        try { found = await api('/mailin/rcpt', { addressHash: await addressHash(address), ...state.from.includes('@') ? { senderHash: await senderHash(state.from) } : {} }); }
        catch (error) { log(`mailin: rcpt: ${error.message}`); return write('451 4.3.0 Temporary local error, try again later'); }
        if (!found.accept) { log(`mailin: ${ip}: rcpt refused (${found.code})`); return write(REFUSALS[found.code] ?? REFUSALS.unknown); }
        state.recipients.push({ address, publicKey: found.publicKey, vaultId: found.vaultId });
        return write('250 2.1.5 Ok');
      }
      if (verb === 'DATA') {
        if (!state.recipients.length) return write('503 5.5.1 RCPT first');
        if (++state.mails > MAX_MAILS_PER_CONNECTION) return hangUp('421 4.7.0 Too much mail on one connection');
        state.data = CRLF;
        return write('354 End data with <CR><LF>.<CR><LF>');
      }
      if (verb === 'VRFY') return write('252 2.5.2 Cannot verify');
      return write('500 5.5.2 Command not recognised');
    }

    async function deliver(bytes, recipients, from) {
      // The readable moment: parse once, then seal per recipient. Nothing of it survives this function.
      const { payload, parts } = parseMail(bytes);
      const outcomes = [];
      for (const recipient of recipients) {
        try {
          const id = randomUUID();
          const sealed = await sealMail(recipient.publicKey, recipient.vaultId, id, payload, parts);
          // The same envelope sender the RCPT check used, so an accepted mail is not refused after DATA.
          const outcome = await api('/mailin/deliver', { addressHash: await addressHash(recipient.address), ...from?.includes('@') ? { senderHash: await senderHash(from) } : {}, id, ephemeralKey: sealed.ephemeralKey, body: sealed.body, parts: sealed.parts });
          outcomes.push(outcome.accept ? 'ok' : outcome.code);
        } catch (error) {
          log(`mailin: deliver: ${error.message}`);
          outcomes.push('error');
        }
      }
      log(`mailin: ${ip}: mail of ${bytes.length} bytes for ${recipients.length} recipient(s): ${outcomes.join(',')}`);
      if (outcomes.includes('ok')) return '250 2.0.0 Ok, sealed and stored';
      if (outcomes.every((code) => code === 'error')) return '451 4.3.0 Temporary local error, try again later';
      return REFUSALS[outcomes.find((code) => REFUSALS[code])] ?? '451 4.3.0 Temporary local error, try again later';
    }

    write(`220 ${hostname} ESMTP JotDrop Mail in`);
    attach();
  }

  if (tlsCert) secureContext();
  await new Promise((ready, failed) => { server.once('error', failed); server.listen(port, () => { server.removeListener('error', failed); ready(); }); });
  return {
    port: server.address().port,
    close: () => new Promise((done) => { for (const socket of sockets) socket.destroy(); server.close(() => done()); }),
  };
}

// Started directly (systemd): settings come from the environment, like server.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { JOTDROP_MAILIN_HOSTNAME, JOTDROP_MAILIN_API, JOTDROP_MAILIN_TOKEN, JOTDROP_MAILIN_TLS_KEY, JOTDROP_MAILIN_TLS_CERT, JOTDROP_MAILIN_PORT } = process.env;
  const mailin = await createMailin({ hostname: JOTDROP_MAILIN_HOSTNAME, apiUrl: JOTDROP_MAILIN_API ?? 'http://127.0.0.1:8787', mailinToken: JOTDROP_MAILIN_TOKEN, tlsKey: JOTDROP_MAILIN_TLS_KEY, tlsCert: JOTDROP_MAILIN_TLS_CERT, port: Number(JOTDROP_MAILIN_PORT ?? 25), log: (line) => console.error(line) });
  console.error(`mailin: listening on port ${mailin.port} as ${JOTDROP_MAILIN_HOSTNAME}`);
}

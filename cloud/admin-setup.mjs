import { randomBytes } from 'node:crypto';
import { base32, hashAdminPassword } from './server.mjs';

// Sets up the owner's dashboard login: asks for the admin password twice (not shown while typing) and makes a new
// authenticator secret. Questions go to stderr and the settings to stdout, so `node cloud/admin-setup.mjs > admin.env`
// writes only the settings. Nothing is written anywhere else; keep the output out of git, chats and logs.
// Usage: node cloud/admin-setup.mjs [admin origin, default https://admin.jotdrop.net]
const origin = process.argv[2] || 'https://admin.jotdrop.net';
let piped;

async function ask(question) {
  const input = process.stdin, output = process.stderr;
  output.write(question);
  // Piped input (scripts, tests): one line per question.
  if (!input.isTTY) {
    piped ??= (async () => { const chunks = []; for await (const chunk of input) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8').split(/\r?\n/); })();
    output.write('\n');
    return (await piped).shift() ?? '';
  }
  return new Promise((done, reject) => {
    let value = '';
    const finish = () => { input.off('data', typed); input.setRawMode(false); input.pause(); output.write('\n'); };
    const typed = (chunk) => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') { finish(); done(value); return; }
        if (character === '\u0003') { finish(); reject(new Error('Cancelled.')); return; }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    input.setRawMode(true); input.setEncoding('utf8'); input.resume(); input.on('data', typed);
  });
}

async function setup() {
  let valid;
  try { valid = new URL(origin).origin === origin && origin.startsWith('https://'); } catch { valid = false; }
  if (!valid) throw new Error('Give the admin origin as https://host, for example https://admin.jotdrop.net.');
  const password = await ask('Admin password (at least 12 characters, not shown): ');
  if (password.length < 12 || password.length > 1024) throw new Error('Use a password of 12 to 1024 characters.');
  if (await ask('Type it again: ') !== password) throw new Error('The passwords are not the same. Nothing was made.');
  const secret = base32(randomBytes(20));
  process.stdout.write([
    `JOTDROP_CLOUD_ADMIN_ORIGIN=${origin}`,
    `JOTDROP_CLOUD_ADMIN_PASSWORD_HASH=${await hashAdminPassword(password)}`,
    `JOTDROP_CLOUD_ADMIN_TOTP_SECRET=${secret}`,
    '',
  ].join('\n'));
  // This repo has no QR code library: add the key by hand in the authenticator app, or open the link on the phone.
  process.stderr.write([
    '',
    'Put the three lines above in the server environment (for example the systemd EnvironmentFile), then restart the service.',
    'Authenticator app: add a time-based key (30 seconds, 6 digits) named "JotDrop Admin" with the secret above, or open:',
    `otpauth://totp/JotDrop%20Admin?secret=${secret}&issuer=JotDrop`,
    'Store the password and the secret in KeePassXC. Running this again makes a new secret; once you replace the lines, the old one stops working.',
    '',
  ].join('\n'));
}

setup().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

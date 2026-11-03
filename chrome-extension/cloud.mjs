// JotDrop Cloud for the web clipper. Bundled with cloud/shared into chrome-extension/cloud-client.js by
// scripts/build-web-clipper.mjs; the popup and options pages use it as `globalThis.JotDropCloud`.
//
// Pairing: the user makes a one-time pairing code in the web app (Devices & recovery) and pastes it here.
// The clipper claims it, which adds the clipper as a device of that cloud. The device token and the vault
// key never leave this browser in readable form: they are sealed with a passphrase of the user's choice and
// kept in chrome.storage.local. "Stay unlocked" keeps an unsealed copy in chrome.storage.session, which lives
// in memory only and is gone when the browser closes. Clips are encrypted here before they are uploaded.
import { CloudClient, validateUrl } from '../cloud/shared/client.mjs';
import { base64ToBytes, bytesToBase64, sealLocal, unsealLocal } from '../cloud/shared/crypto.mjs';

const encoder = new TextEncoder();
const colors = new Set(['default', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'brown', 'gray']);

/** The JotDrop Cloud this store build can reach; the manifest asks for exactly this origin. */
export const CLOUD_ORIGIN = 'https://app.jotdrop.net';
// The same server under its older name: codes made there are claimed at the main address.
const ALIASES = new Set(['https://api.jotdrop.net']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
export const MIN_PASSPHRASE = 12;

/** The cloud address a pairing code is for, or an error a person can act on. */
export function cloudOrigin(value) {
  const origin = validateUrl(value);
  if (origin === CLOUD_ORIGIN || ALIASES.has(origin)) return CLOUD_ORIGIN;
  // A cloud on this computer (development and tests); the manifest already allows localhost.
  if (new URL(origin).protocol === 'http:' && LOOPBACK.has(new URL(origin).hostname)) return origin;
  throw new Error(`This clipper connects to JotDrop Cloud at ${CLOUD_ORIGIN.slice(8)}. This pairing code is for another server.`);
}

/** Reads a pairing code without contacting anyone: `{ code, origin }`, with the code pointed at the main address. */
export function readPairingCode(value) {
  const text = String(value || '').replace(/\s+/g, '');
  let pairing;
  try { pairing = JSON.parse(new TextDecoder().decode(base64ToBytes(text))); } catch { throw new Error('This is not a JotDrop pairing code. Copy it again from the web app.'); }
  if (!pairing || pairing.v !== 1 || typeof pairing.url !== 'string') throw new Error('This is not a JotDrop pairing code. Copy it again from the web app.');
  const origin = cloudOrigin(pairing.url);
  if (origin === pairing.url) return { code: text, origin };
  return { code: bytesToBase64(encoder.encode(JSON.stringify({ ...pairing, url: origin }))), origin };
}

// Same rule as the plugin and the web app: clipped text keeps its #words as text, only chosen tags are tags.
const skipped = /(`{3,}|~{3,})[\s\S]*?\1|`[^`\n]+`|\[\[[^\]\n]*\]\]|\]\([^)\n]*\)|https?:\/\/[^\s<>]+/g;
const hashtag = /(?<![\\\p{L}\p{N}\p{M}_/])#(?=\p{N}*[\p{L}\p{M}_/\p{Extended_Pictographic}-])/gu;
export function neutralizeInlineHashtags(text) {
  let out = '', at = 0;
  for (const match of text.matchAll(skipped)) {
    out += text.slice(at, match.index).replace(hashtag, '\\#') + match[0];
    at = match.index + match[0].length;
  }
  return out + text.slice(at).replace(hashtag, '\\#');
}

function cleanTitle(payload, url) { return String(payload.title || url.href).replace(/[\r\n\x00-\x1f]/g, ' ').trim().slice(0, 500) || url.href; }

export function clipMarkdown(payload) {
  const url = new URL(payload.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS pages can be clipped.');
  const title = cleanTitle(payload, url);
  const selection = String(payload.selection || '').slice(0, 8000);
  const tags = Array.isArray(payload.tags) ? payload.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.replace(/^#/, '').trim()).filter((tag) => tag && !/[\s\x00-\x1f]/.test(tag)).slice(0, 100) : [];
  const color = colors.has(payload.color) ? payload.color : 'default';
  const metadata = ['---', `tags: ${JSON.stringify(tags)}`, `pinned: ${payload.pinned === true}`, `color: ${color}`, '---'];
  const linkTitle = title.replace(/[\\\[\]]/g, '\\$&');
  const href = url.href.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/</g, '%3C').replace(/>/g, '%3E');
  const body = `# ${title}\n\n${selection ? `> ${selection.replace(/\r?\n/g, '\n> ')}\n\n` : ''}[${linkTitle}](<${href}>)\n`;
  return `${metadata.join('\n')}\n\n${neutralizeInlineHashtags(body)}`;
}

/**
 * Named like a clip the Obsidian plugin saves, top level so every app shows it, plus four characters of the
 * capture ID: `notes/2026-11-03 141502 Page title 3f9a.md`. Without them, the same page clipped twice in one
 * second (or by Obsidian and the cloud in the same second) would meet the other file and wait forever.
 */
export function clipPath(payload, captureId, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let title = '';
  try { title = cleanTitle(payload, new URL(payload.url)); } catch { /* clipMarkdown reports the bad URL */ }
  const slug = title.replace(/[#*_`>[\]()]/g, '').replace(/[\\/:*?"<>|]/g, '').replace(/^\.+/, '').trim().slice(0, 40).trim();
  const tag = String(captureId).replace(/[^0-9a-f]/g, '').slice(0, 4);
  return `notes/${[stamp, slug, tag].filter(Boolean).join(' ')}.md`;
}

const memoryArea = () => {
  let data = {};
  return { async get() { return { ...data }; }, async set(value) { Object.assign(data, value); }, async remove(keys) { for (const key of [keys].flat()) delete data[key]; } };
};

/**
 * `storage`: chrome.storage.local (sealed keys, encrypted drafts, settings). `session`: chrome.storage.session or
 * none; it only ever holds the unsealed keys of a clipper the person chose to keep unlocked.
 */
export function createClipperCloud(storage, fetcher = globalThis.fetch, session = undefined, clock = () => new Date()) {
  const area = session ?? memoryArea();
  const draftPrefix = (vaultId) => `cloudDraft:${vaultId}:`;

  async function credentials(password, keepUnlocked = false) {
    const { cloudConnection } = await storage.get(['cloudConnection']);
    if (!cloudConnection) throw new Error('Connect JotDrop Cloud in the clipper settings first.');
    if (!password) {
      const { cloudSession } = session ? await session.get(['cloudSession']) : {};
      // Only the keys sealed right now: after a new pairing, an older unlocked copy no longer counts.
      if (cloudSession?.salt === cloudConnection.salt && cloudSession.credentials) return cloudSession.credentials;
      throw Object.assign(new Error('Enter your cloud unlock passphrase.'), { code: 'locked' });
    }
    let value;
    try { value = await unsealLocal(cloudConnection, password); } catch { throw Object.assign(new Error('Wrong unlock passphrase.'), { code: 'locked' }); }
    if (keepUnlocked && session) await session.set({ cloudSession: { salt: cloudConnection.salt, credentials: value } });
    return value;
  }
  const unlock = async (password, keepUnlocked) => new CloudClient({ ...await credentials(password, keepUnlocked), fetcher });

  async function commit(client, key, prepared, { signal, onProgress, onCaptureCommitted } = {}) {
    try { await client.commitWrite(prepared, { resumable: true, signal, onProgress }); }
    catch (error) {
      signal?.throwIfAborted();
      if (error.status !== 409) throw error;
      const existing = await client.read(prepared.id);
      const expected = JSON.parse(prepared.envelope);
      // A timed-out successful upload can be retried without creating another note.
      if (existing.deleted || existing.envelope !== JSON.stringify(expected)) throw new Error('A different cloud version exists. Your encrypted draft is preserved.');
    }
    await storage.remove(key);
    onCaptureCommitted?.(key.slice(key.lastIndexOf(':') + 1));
  }

  async function drafts(vaultId) {
    const data = await storage.get(null);
    return Object.entries(data).filter(([key]) => vaultId ? key.startsWith(draftPrefix(vaultId)) : key.startsWith('cloudDraft:'));
  }

  return {
    readPairingCode,
    /** Claims a pairing code made in the web app. Clips then go to the cloud unless the person chose Obsidian too. */
    async connect(pairingCode, password, { keepUnlocked = false } = {}) {
      if (typeof password !== 'string' || password.length < MIN_PASSPHRASE) throw new Error(`Choose an unlock passphrase of at least ${MIN_PASSPHRASE} characters.`);
      const { code } = readPairingCode(pairingCode);
      const client = await CloudClient.claim({ pairingCode: code, fetcher });
      const sealed = await sealLocal(client.credentials, password);
      const { destination } = await storage.get(['destination']);
      await storage.set({ cloudConnection: sealed, cloudServer: client.credentials.url, destination: destination === 'both' ? 'both' : 'cloud' });
      await storage.remove('cloudEnabled');
      await area.remove('cloudSession');
      if (keepUnlocked && session) await session.set({ cloudSession: { salt: sealed.salt, credentials: client.credentials } });
      return client.credentials.url;
    },
    /** What the popup and settings show; reads nothing secret. */
    async status() {
      const { cloudConnection, cloudServer } = await storage.get(['cloudConnection', 'cloudServer']);
      const { cloudSession } = session ? await session.get(['cloudSession']) : {};
      return { connected: Boolean(cloudConnection), server: cloudServer || (cloudConnection ? CLOUD_ORIGIN : null), unlocked: Boolean(cloudConnection && cloudSession?.salt === cloudConnection.salt), canStayUnlocked: Boolean(session), drafts: (await drafts()).length };
    },
    async lock() { await area.remove('cloudSession'); },
    async save(payload, password, captureId, options = {}) {
      if (!/^[0-9a-f-]{36}$/.test(captureId)) throw new Error('Invalid capture ID.');
      const client = await unlock(password, options.keepUnlocked);
      const key = `${draftPrefix(client.credentials.vaultId)}${captureId}`;
      const stored = await storage.get([key]);
      if (!stored[key]) {
        const now = clock();
        const prepared = await client.prepareWrite(clipPath(payload, captureId, now), encoder.encode(clipMarkdown(payload)), 0, now.toISOString());
        await storage.set({ [key]: prepared });
      }
      for (const [draftKey, prepared] of await drafts(client.credentials.vaultId)) await commit(client, draftKey, prepared, options);
    },
    async resume(password, options = {}) {
      const client = await unlock(password, options.keepUnlocked);
      let count = 0;
      for (const [draftKey, prepared] of await drafts(client.credentials.vaultId)) { await commit(client, draftKey, prepared, options); count++; }
      return count;
    },
    /**
     * Forgets the cloud in this browser: the sealed keys, an unlocked copy and unsent encrypted drafts. With the
     * keys at hand it first signs this clipper out on the server too, which frees its device place.
     */
    async disconnect(password) {
      const { cloudConnection } = await storage.get(['cloudConnection']);
      let signedOut = false, signOutError = null;
      if (cloudConnection) {
        let client;
        try { client = await unlock(password); } catch (error) { if (password) throw error; }
        // Offline or refused: the keys still go, and the web app can sign the clipper out later.
        if (client) {
          try { await client.revokeDevice(client.credentials.deviceId); signedOut = true; }
          catch (error) { signOutError = error.message || 'The cloud could not be reached.'; }
        }
      }
      const queued = (await drafts()).map(([key]) => key);
      await storage.remove(['cloudConnection', 'cloudServer', 'cloudEnabled', ...queued]);
      const { destination } = await storage.get(['destination']);
      if (destination === 'cloud' || destination === 'both') await storage.set({ destination: 'obsidian' });
      await area.remove('cloudSession');
      return { signedOut, signOutError, droppedDrafts: queued.length };
    },
  };
}

if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  globalThis.JotDropCloud = createClipperCloud(chrome.storage.local, globalThis.fetch.bind(globalThis), chrome.storage.session);
}

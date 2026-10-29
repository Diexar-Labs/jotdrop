import { CloudClient, validateUrl } from '../cloud/shared/client.mjs';
import { base64ToBytes, sealLocal, unsealLocal } from '../cloud/shared/crypto.mjs';

const encoder = new TextEncoder();
const colors = new Set(['default', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'brown', 'gray']);

export function clipMarkdown(payload) {
  const url = new URL(payload.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS pages can be clipped.');
  const title = String(payload.title || url.href).replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 500);
  const selection = String(payload.selection || '').slice(0, 8000);
  const tags = Array.isArray(payload.tags) ? payload.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.replace(/^#/, '').trim()).filter((tag) => tag && !/[\s\x00-\x1f]/.test(tag)).slice(0, 100) : [];
  const color = colors.has(payload.color) ? payload.color : 'default';
  const metadata = ['---', `tags: ${JSON.stringify(tags)}`, `pinned: ${payload.pinned === true}`, `color: ${color}`, '---'];
  const linkTitle = title.replace(/[\\\[\]]/g, '\\$&');
  const href = url.href.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/</g, '%3C').replace(/>/g, '%3E');
  return `${metadata.join('\n')}\n\n# ${title}\n\n${selection ? `> ${selection.replace(/\r?\n/g, '\n> ')}\n\n` : ''}[${linkTitle}](<${href}>)\n`;
}

export function createClipperCloud(storage, fetcher = globalThis.fetch) {
  async function unlock(password) {
    const { cloudConnection } = await storage.get(['cloudConnection']);
    if (!cloudConnection) throw new Error('Connect the clipper in its cloud settings first.');
    return new CloudClient({ ...await unsealLocal(cloudConnection, password), fetcher });
  }

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

  return {
    async connect(pairingCode, password) {
      const client = await CloudClient.claim({ pairingCode, fetcher });
      await storage.set({ cloudConnection: await sealLocal(client.credentials, password), cloudEnabled: true });
      return client.credentials.url;
    },
    async save(payload, password, captureId, options = {}) {
      if (!/^[0-9a-f-]{36}$/.test(captureId)) throw new Error('Invalid capture ID.');
      const client = await unlock(password);
      const data = await storage.get(null);
      const prefix = `cloudDraft:${client.credentials.vaultId}:`;
      const key = `${prefix}${captureId}`;
      if (!data[key]) {
        data[key] = await client.prepareWrite(`notes/Inbox/${captureId}.md`, encoder.encode(clipMarkdown(payload)), 0);
        await storage.set({ [key]: data[key] });
      }
      for (const [draftKey, prepared] of Object.entries(data)) if (draftKey.startsWith(prefix)) await commit(client, draftKey, prepared, options);
    },
    async resume(password, options = {}) {
      const client = await unlock(password);
      const data = await storage.get(null);
      const prefix = `cloudDraft:${client.credentials.vaultId}:`;
      let count = 0;
      for (const [draftKey, prepared] of Object.entries(data)) if (draftKey.startsWith(prefix)) { await commit(client, draftKey, prepared, options); count++; }
      return count;
    },
  };
}

function field(parent, text, id, type = 'text') {
  const label = document.createElement('label');
  label.className = 'field';
  const caption = document.createElement('span');
  caption.textContent = text;
  const input = document.createElement('input');
  input.id = id;
  input.type = type;
  input.autocomplete = type === 'password' ? 'current-password' : 'off';
  label.append(caption, input);
  parent.append(label);
  return input;
}

function installOptions() {
  const section = document.createElement('section');
  const heading = document.createElement('h2');
  heading.textContent = 'Cloud connection (development preview)';
  const explanation = document.createElement('p');
  explanation.textContent = 'Optional: save encrypted clips without Obsidian running. Pair this clipper from your cloud workspace. Use test data only.';
  section.append(heading, explanation);
  const code = field(section, 'One-time pairing code', 'cloudPairCode');
  const password = field(section, 'Device unlock passphrase (at least 12 characters)', 'cloudPairPassword', 'password');
  password.autocomplete = 'new-password';
  const connect = document.createElement('button');
  connect.type = 'button'; connect.className = 'btn-primary'; connect.textContent = 'Pair cloud workspace';
  const disable = document.createElement('button');
  disable.type = 'button'; disable.className = 'btn-secondary'; disable.textContent = 'Use local Obsidian mode';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const originHint = document.createElement('p');
  originHint.className = 'hint';
  originHint.textContent = `For the local server, explicitly allow this extension origin: chrome-extension://${chrome.runtime.id}`;
  section.append(connect, disable, status, originHint);
  document.body.append(section);
  connect.addEventListener('click', async () => {
    connect.disabled = true;
    try {
      if (password.value.length < 12) throw new Error('Choose an unlock passphrase of at least 12 characters.');
      const pairing = JSON.parse(new TextDecoder().decode(base64ToBytes(code.value.trim())));
      const origin = validateUrl(pairing.url);
      const permission = `${origin}/*`;
      if (new URL(origin).protocol === 'https:' && !await chrome.permissions.request({ origins: [permission] })) throw new Error('Cloud server permission was not granted. Local mode is unchanged.');
      await globalThis.JotDropCloud.connect(code.value.trim(), password.value);
      status.textContent = 'Cloud connected. Unlock in the clipper popup when saving. Existing local mode remains available.';
      code.value = ''; password.value = '';
    } catch (error) { status.textContent = error.message || 'Could not pair. Check the code and local server allowlist.'; }
    finally { connect.disabled = false; }
  });
  disable.addEventListener('click', async () => {
    await chrome.storage.local.set({ cloudEnabled: false });
    status.textContent = 'Local Obsidian mode enabled. Encrypted cloud drafts and connection are kept.';
  });
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined') {
  globalThis.JotDropCloud = createClipperCloud(chrome.storage.local);
  if (document.getElementById('saveTest')) installOptions();
  if (document.getElementById('saveBtn')) {
    const container = document.createElement('div');
    container.hidden = true;
    const password = field(container, 'Cloud device unlock passphrase', 'cloudUnlock', 'password');
    const progress = document.createElement('progress');
    progress.id = 'cloudProgress'; progress.hidden = true; progress.setAttribute('aria-label', 'Encrypted upload');
    const pause = document.createElement('button');
    pause.id = 'cloudPause'; pause.type = 'button'; pause.textContent = 'Pause upload'; pause.hidden = true;
    const resume = document.createElement('button');
    resume.id = 'cloudResume'; resume.type = 'button'; resume.textContent = 'Resume saved drafts';
    container.append(progress, pause, resume);
    document.querySelector('.foot').before(container);
    void chrome.storage.local.get(['cloudEnabled']).then(({ cloudEnabled }) => { container.hidden = !cloudEnabled; password.required = Boolean(cloudEnabled); });
  }
}

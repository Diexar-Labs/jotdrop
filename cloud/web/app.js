import { CloudClient } from '/shared/client.mjs';
import { base64ToBytes, bytesToBase64, decryptEnvelope, sealLocal, unsealLocal } from '/shared/crypto.mjs';
import { exportZip } from '/export.mjs';
import { noteSummary } from '/note.mjs';

const $ = (id) => document.getElementById(id);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const files = new Map();
const mediaUrls = new Set();
let client;
let view = 'notes';
let editing;
let editingRevision;
let syncing;
let cursor = 0;
let generation = 0;
const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('jotdrop-cloud-v1', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('values');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(new Error('Browser storage is unavailable. Enable site storage to keep encrypted drafts.'));
});

async function store(action, key, value) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('values', action === 'get' || action === 'entries' ? 'readonly' : 'readwrite');
    const values = transaction.objectStore('values');
    let result;
    if (action === 'entries') {
      result = [];
      const request = values.openCursor();
      request.onsuccess = () => {
        const entry = request.result;
        if (entry) {
          if (String(entry.key).startsWith(key)) result.push([entry.key, entry.value]);
          entry.continue();
        }
      };
    } else {
      const request = action === 'get' ? values.get(key) : action === 'put' ? values.put(value, key) : values.delete(key);
      request.onsuccess = () => { result = request.result; };
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(new Error('Could not save browser data. Keep this window open and download your changes.'));
    transaction.onabort = transaction.onerror;
  });
}

const cachePrefix = () => `cache:${client.credentials.vaultId}:`;
const pendingPrefix = () => `pending:${client.credentials.vaultId}:`;
const aad = (id) => `jotdrop:object:v1:${client.credentials.vaultId}:${id}`;
const errorText = (error) => error?.status === 401 ? 'This device no longer has access. Lock the workspace and reconnect using another device or your recovery code.' : error?.message || 'The operation failed. Your local files have not been changed.';
const message = (text = '') => { $('workspace-message').textContent = text; };

function button(text, action, className) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = text;
  if (className) element.className = className;
  element.addEventListener('click', () => Promise.resolve().then(action).catch((error) => message(errorText(error))));
  return element;
}

function paragraph(text, className) {
  const element = document.createElement('p');
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function noteText(file) { return decoder.decode(base64ToBytes(file.content)); }
function isMarkdown(path) { return /\.md$/i.test(path); }
function noteParts(text, path) {
  return noteSummary(text, path);
}

function download(bytes, filename, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.split('/').pop();
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function mediaType(path) {
  const extension = path.split('.').pop().toLowerCase();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', m4a: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', webm: 'audio/webm', wav: 'audio/wav' })[extension];
}

function render() {
  for (const url of mediaUrls) URL.revokeObjectURL(url);
  mediaUrls.clear();
  $('items').replaceChildren();
  $('items').hidden = view === 'devices';
  $('devices-panel').hidden = view !== 'devices';
  const descriptions = {
    notes: ['Notes', 'Plain Markdown. Your files, your workspace.'],
    files: ['Files', 'Images, recordings, and the files you choose to keep.'],
    trash: ['Trash', 'Deleted files stay recoverable. Restoring adds a new cloud version.'],
    devices: ['Devices & recovery', 'You control which devices can access this workspace.'],
  };
  $('view-title').textContent = descriptions[view][0];
  $('view-description').textContent = descriptions[view][1];
  $('note-count').textContent = String([...files.values()].filter((entry) => !entry.deleted && isMarkdown(entry.file.path)).length);
  if (view === 'devices') return;
  const selectedLabel = $('label-filter').value;
  const labels = new Map();
  for (const entry of files.values()) if (!entry.deleted && isMarkdown(entry.file.path)) for (const label of noteParts(noteText(entry.file), entry.file.path).labels) labels.set(label.toLowerCase(), label);
  $('label-filter').replaceChildren(new Option('All labels', ''), ...[...labels].sort((a, b) => a[1].localeCompare(b[1])).map(([key, label]) => new Option(label, key)));
  $('label-filter').value = labels.has(selectedLabel) ? selectedLabel : '';
  const query = $('search').value.toLowerCase().trim();
  const matching = [...files.values()].filter((entry) => {
    if (view === 'trash' ? !entry.deleted : entry.deleted) return false;
    if (view === 'notes' && !isMarkdown(entry.file.path)) return false;
    if (view === 'files' && isMarkdown(entry.file.path)) return false;
    if ($('label-filter').value && (!isMarkdown(entry.file.path) || !noteParts(noteText(entry.file), entry.file.path).labels.some((label) => label.toLowerCase() === $('label-filter').value))) return false;
    return !query || entry.file.path.toLowerCase().includes(query) || (isMarkdown(entry.file.path) && noteText(entry.file).toLowerCase().includes(query));
  }).sort((a, b) => String(b.file.modifiedAt).localeCompare(String(a.file.modifiedAt)));
  if (!matching.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const heading = document.createElement('h2');
    heading.textContent = query ? 'No matching files' : view === 'trash' ? 'Nothing in the trash' : view === 'files' ? 'A place for your attachments' : 'Room for your next thought';
    empty.append(heading, paragraph(query ? 'Try a different word or filename.' : view === 'notes' ? 'Create a note or upload a Markdown file. Existing notes on your computer are never imported automatically.' : view === 'files' ? 'Upload an image, recording, or document. This local preview accepts files up to 4 MiB each.' : 'Files you move to trash will appear here.'));
    $('items').append(empty);
  }
  for (const entry of matching) {
    const card = document.createElement('article');
    card.className = `note-card${entry.pending ? ' is-pending' : ''}`;
    const title = document.createElement('h2');
    const markdown = isMarkdown(entry.file.path);
    const parts = markdown ? noteParts(noteText(entry.file), entry.file.path) : { title: entry.file.path.split('/').pop() };
    if (markdown) card.classList.add(`note-${parts.color}`);
    title.textContent = `${parts.pinned ? 'Pinned: ' : ''}${parts.title}`;
    card.append(title);
    if (markdown) card.append(paragraph(parts.preview.slice(0, 600), 'note-preview'));
    else {
      const type = mediaType(entry.file.path);
      if (type) {
        const url = URL.createObjectURL(new Blob([base64ToBytes(entry.file.content)], { type }));
        mediaUrls.add(url);
        const media = document.createElement(type.startsWith('image/') ? 'img' : 'audio');
        media.src = url;
        if (media.tagName === 'IMG') { media.alt = entry.file.path.split('/').pop(); media.loading = 'lazy'; }
        else { media.controls = true; media.preload = 'none'; }
        card.append(media);
      }
    }
    card.append(paragraph(entry.pending ? 'Encrypted draft on this browser. Waiting for cloud.' : `Cloud version ${entry.revision}`, 'note-meta'));
    if (entry.conflict) card.append(paragraph('Another device saved a different version. Review both before choosing.', 'message'));
    card.append(paragraph(entry.file.path, 'note-meta'));
    if (markdown) for (const label of parts.labels) card.append(button(label, () => { $('label-filter').value = label.toLowerCase(); render(); }, 'label-chip'));
    if (entry.deleted) card.append(button('Restore', () => restoreEntry(entry)));
    else {
      if (markdown) card.append(button('Open note', () => openEditor(entry)));
      card.append(button('Download', () => download(base64ToBytes(entry.file.content), entry.file.path)));
      if (!markdown) card.append(button('Move to trash', () => deleteEntry(entry), 'danger'));
    }
    if (entry.conflict) card.append(button('Review cloud version', () => reviewConflict(entry)));
    $('items').append(card);
  }
}

async function cacheEntry(entry) {
  const prepared = await client.prepareWrite(entry.file.path, base64ToBytes(entry.file.content), entry.revision, entry.file.modifiedAt);
  await store('put', `${cachePrefix()}${entry.id}`, { prepared, revision: entry.revision, deleted: entry.deleted, updatedAt: entry.updatedAt });
}

async function loadLocal() {
  for (const [, record] of await store('entries', cachePrefix())) {
    const file = await decryptEnvelope(client.credentials.vaultKey, JSON.parse(record.prepared.envelope), aad(record.prepared.id));
    files.set(record.prepared.id, { id: record.prepared.id, file, revision: record.revision, deleted: record.deleted });
  }
  for (const [, record] of await store('entries', pendingPrefix())) {
    const file = await decryptEnvelope(client.credentials.vaultKey, JSON.parse(record.prepared.envelope), aad(record.prepared.id));
    files.set(record.prepared.id, { id: record.prepared.id, file, revision: record.prepared.baseRevision, deleted: record.deleted, pending: true });
  }
}

async function queueFile(path, bytes, expectedRevision) {
  const prepared = await client.prepareWrite(path, bytes, 0);
  const current = files.get(prepared.id);
  if (expectedRevision === undefined && current) throw new Error('That filename already exists. Choose another filename or open the existing note to edit it.');
  if (expectedRevision !== undefined && current?.revision !== expectedRevision) throw new Error('This note changed while you were editing. Download your draft, then reopen the current version before saving.');
  if (current?.conflict) throw new Error('Review the cloud conflict before saving another edit. Download this draft to keep a separate copy.');
  const key = `${pendingPrefix()}${prepared.id}`;
  const prior = await store('get', key);
  prepared.baseRevision = prior?.prepared.baseRevision ?? current?.revision ?? 0;
  const record = { prepared, deleted: false, queueId: crypto.randomUUID() };
  await store('put', key, record);
  files.set(prepared.id, { id: prepared.id, revision: prepared.baseRevision, deleted: false, pending: true, file: { path, content: bytesToBase64(bytes), modifiedAt: new Date().toISOString() } });
  render();
  void sync();
}

async function deleteEntry(entry) {
  if (!confirm(`Move "${entry.file.path}" to trash?`)) return;
  if (syncing) await syncing;
  entry = files.get(entry.id);
  if (!entry) return;
  if (entry.conflict) throw new Error('Resolve the conflicting versions before moving this file to trash.');
  const key = `${pendingPrefix()}${entry.id}`;
  const prior = await store('get', key);
  if (prior && prior.prepared.baseRevision === 0) {
    await store('delete', key);
    files.delete(entry.id);
  } else {
    const prepared = prior?.prepared || await client.prepareWrite(entry.file.path, base64ToBytes(entry.file.content), entry.revision, entry.file.modifiedAt);
    await store('put', key, { prepared, deleted: true, queueId: crypto.randomUUID() });
    files.set(entry.id, { ...entry, deleted: true, pending: true });
  }
  render();
  void sync();
}

async function performSync() {
  if (!client) return;
  const activeClient = client;
  const activeGeneration = generation;
  let changed = false;
  $('sync-status').textContent = 'Syncing encrypted changes...';
  const keyPrefix = pendingPrefix();
  for (const [key, pending] of await store('entries', keyPrefix)) {
    if (activeGeneration !== generation) return;
    if (files.get(pending.prepared.id)?.conflict) continue;
    let result;
    try { result = pending.deleted ? await activeClient.remove(pending.prepared.id, pending.prepared.baseRevision) : await activeClient.commitWrite(pending.prepared); }
    catch (error) {
      if (error.status !== 409) throw error;
      const remote = await activeClient.read(pending.prepared.id);
      const expected = await decryptEnvelope(activeClient.credentials.vaultKey, JSON.parse(pending.prepared.envelope), `jotdrop:object:v1:${activeClient.credentials.vaultId}:${pending.prepared.id}`);
      if (remote.deleted === pending.deleted && remote.file.path === expected.path && remote.file.content === expected.content) result = { revision: remote.revision };
      else {
        const entry = files.get(pending.prepared.id);
        if (entry) { entry.conflict = true; changed = true; }
        continue;
      }
    }
    if (activeGeneration !== generation) return;
    const latest = await store('get', key);
    if (latest?.queueId === pending.queueId) {
      const entry = files.get(pending.prepared.id);
      if (entry) {
        entry.revision = result.revision;
        entry.pending = false;
        changed = true;
        await cacheEntry(entry);
      }
      await store('delete', key);
    } else if (latest) {
      latest.prepared.baseRevision = result.revision;
      await store('put', key, latest);
    }
  }
  let more = true;
  while (more) {
    const result = await activeClient.listChanges(cursor);
    for (const change of result.changes) {
      if (activeGeneration !== generation) return;
      if (await store('get', `${keyPrefix}${change.id}`)) continue;
      const entry = await activeClient.read(change.id);
      if (activeGeneration !== generation) return;
      files.set(change.id, entry);
      changed = true;
      await cacheEntry(entry);
    }
    cursor = result.cursor;
    more = result.hasMore;
  }
  const status = await activeClient.status();
  if (activeGeneration !== generation) return;
  $('storage-usage').textContent = `${(status.usedBytes / 1048576).toFixed(1)} / ${(status.quotaBytes / 1048576).toFixed(0)} MiB encrypted storage`;
  const pending = await store('entries', keyPrefix);
  const conflicts = [...files.values()].filter((entry) => entry.conflict).length;
  $('sync-status').textContent = conflicts ? `${conflicts} conflict(s) need review. Local drafts are preserved.` : pending.length ? `${pending.length} encrypted change(s) waiting to upload.` : `Cloud copy up to date at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
  if (changed) render();
}

async function sync() {
  if (!client || syncing) return syncing;
  const activeGeneration = generation;
  syncing = performSync().catch((error) => {
    if (activeGeneration !== generation) return;
    $('sync-status').textContent = 'Cloud unavailable. Encrypted drafts stay on this browser.';
    message(errorText(error));
    render();
  }).finally(() => { syncing = undefined; });
  return syncing;
}

function openEditor(entry) {
  editing = entry;
  editingRevision = entry?.revision;
  $('note-path').value = entry?.file.path || `notes/${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.md`;
  $('note-path').readOnly = Boolean(entry);
  $('note-content').value = entry ? noteText(entry.file) : '# Untitled\n\n';
  $('editor-message').textContent = 'Changes are saved only when you select Save note.';
  $('history').hidden = true;
  $('history-list').replaceChildren();
  for (const id of ['note-history', 'note-download', 'note-delete']) $(id).hidden = !entry;
  $('editor').showModal();
  $('note-content').focus();
}

function closeEditor() {
  const original = editing ? noteText(editing.file) : '# Untitled\n\n';
  if ($('note-content').value !== original && !confirm('Close without saving these edits?')) return;
  $('editor').close();
  $('note-content').value = '';
  editing = undefined;
}

async function restoreEntry(entry, revision = entry.revision) {
    if (entry.pending) throw new Error('Sync this file before restoring an earlier cloud version.');
  if (!confirm('Restore this version as a new cloud version?')) return;
  await client.restore(entry.id, revision, entry.revision);
  cursor = 0;
  await sync();
}

async function reviewConflict(entry) {
  const remote = await client.read(entry.id);
  download(base64ToBytes(entry.file.content), `local-draft-${entry.file.path.split('/').pop()}`);
  if (!confirm(`Your local draft has been downloaded. Keep the cloud version of "${remote.file.path}" in this workspace? Select Cancel to keep both unresolved.`)) return;
  await cacheEntry(remote);
  await store('delete', `${pendingPrefix()}${entry.id}`);
  files.set(entry.id, remote);
  render();
  await sync();
}

async function renderDevices() {
  const result = await client.devices();
  $('device-list').replaceChildren();
  for (const device of result.devices) {
    const row = document.createElement('div');
    row.className = 'device-row';
    const current = device.id === client.credentials.deviceId;
    row.append(paragraph(`${device.name}${current ? ' (this device)' : ''}${device.revoked ? ' - access revoked' : ''}`));
    if (!device.revoked && !current) row.append(button('Revoke access', async () => {
      if (!confirm(`Revoke future cloud access for "${device.name}"?`)) return;
      await client.revokeDevice(device.id);
      await renderDevices();
    }, 'danger'));
    $('device-list').append(row);
  }
}

async function openWorkspace(connected) {
  client = connected;
  generation++;
  cursor = 0;
  files.clear();
  $('access').hidden = true;
  $('workspace').hidden = false;
  $('access-code').value = '';
  $('new-password').value = '';
  $('confirm-password').value = '';
  $('unlock-password').value = '';
  await loadLocal();
  render();
  await sync();
}

function lock() {
  generation++;
  client = undefined;
  files.clear();
  editing = undefined;
  for (const url of mediaUrls) URL.revokeObjectURL(url);
  mediaUrls.clear();
  $('items').replaceChildren();
  $('device-list').replaceChildren();
  $('note-content').value = '';
  $('pair-code').value = '';
  $('recovery-code').value = '';
  $('editor').close();
  $('workspace').hidden = true;
  $('access').hidden = false;
  $('unlock-form').hidden = false;
  $('connect-form').hidden = true;
  $('unlock-password').focus();
}

$('connect-method').addEventListener('change', () => {
  $('access-code-label').textContent = ({ create: 'Local enrollment token from the server terminal', pair: 'One-time pairing code from another device', recover: 'Workspace recovery code' })[$('connect-method').value];
  $('access-code').value = '';
});
$('connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  $('access-message').textContent = 'Connecting securely...';
  try {
    const password = $('new-password').value;
    if (password !== $('confirm-password').value) throw new Error('The unlock passphrases do not match.');
    const method = $('connect-method').value;
    const options = { url: location.origin, deviceName: $('device-name').value.trim() };
    const code = $('access-code').value.trim();
    let connected, recoveryCode;
    if (method === 'create') ({ client: connected, recoveryCode } = await CloudClient.create({ ...options, enrollmentToken: code }));
    else if (method === 'pair') connected = await CloudClient.claim({ pairingCode: code });
    else connected = await CloudClient.recover({ ...options, recoveryCode: code });
    const sealed = await sealLocal(connected.credentials, password);
    const existing = await store('entries', `pending:${connected.credentials.vaultId}:`);
    if (existing.length && !confirm('This workspace has encrypted drafts on this browser. Continue and sync them using the new device connection?')) return;
    await store('put', 'connection', sealed);
    $('access-message').textContent = '';
    await openWorkspace(connected);
    if (recoveryCode) {
      $('recovery-code').value = recoveryCode;
      $('recovery-saved').checked = false;
      $('finish-recovery').disabled = true;
      $('recovery-dialog').showModal();
    }
  } catch (error) { $('access-message').textContent = errorText(error); }
  finally { submit.disabled = false; }
});
$('unlock-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  event.submitter.disabled = true;
  try {
    const credentials = await unsealLocal(await store('get', 'connection'), $('unlock-password').value);
    await openWorkspace(new CloudClient(credentials));
    $('access-message').textContent = '';
  } catch { $('access-message').textContent = 'Could not unlock this device. Check your passphrase, or reconnect using your recovery code.'; }
  finally { event.submitter.disabled = false; }
});
$('use-another').addEventListener('click', () => {
  $('unlock-form').hidden = true;
  $('connect-form').hidden = false;
  $('access-message').textContent = 'Existing encrypted drafts are kept. Connect the original device again to sync them.';
});
$('lock').addEventListener('click', lock);
$('sync').addEventListener('click', () => { message(); void sync(); });
$('search').addEventListener('input', render);
$('label-filter').addEventListener('change', render);
$('new-note').addEventListener('click', () => openEditor());
$('close-editor').addEventListener('click', closeEditor);
$('editor').addEventListener('cancel', (event) => { event.preventDefault(); closeEditor(); });
$('editor-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  event.submitter.disabled = true;
  try {
    if (!isMarkdown($('note-path').value)) throw new Error('Notes must use a .md filename.');
    await queueFile($('note-path').value, encoder.encode($('note-content').value), editingRevision);
    $('editor').close();
    $('note-content').value = '';
    editing = undefined;
  } catch (error) { $('editor-message').textContent = errorText(error); }
  finally { event.submitter.disabled = false; }
});
$('note-download').addEventListener('click', () => download(encoder.encode($('note-content').value), $('note-path').value, 'text/markdown'));
$('note-delete').addEventListener('click', async () => {
  try { await deleteEntry(editing); $('editor').close(); }
  catch (error) { $('editor-message').textContent = errorText(error); }
});
$('note-history').addEventListener('click', async () => {
  try {
    const result = await client.history(editing.id);
    $('history-list').replaceChildren();
    for (const version of result.versions) {
      const row = document.createElement('div');
      row.className = 'history-row';
      row.append(paragraph(`Version ${version.revision}${version.deleted ? ' (moved to trash)' : ''} - ${new Date(version.updatedAt).toLocaleString()}`));
      row.append(button('Download version', async () => {
        const old = await client.read(editing.id, version.revision);
        download(base64ToBytes(old.file.content), old.file.path);
      }));
      if (version.revision !== editing.revision) row.append(button('Restore version', async () => {
        await restoreEntry(editing, version.revision);
        $('editor').close();
      }));
      $('history-list').append(row);
    }
    $('history').hidden = false;
  } catch (error) { $('editor-message').textContent = errorText(error); }
});
$('upload').addEventListener('change', async () => {
  try {
    for (const file of $('upload').files) {
      if (file.size > 4 * 1024 * 1024) throw new Error(`"${file.name}" exceeds the local preview's 4 MiB limit.`);
      const path = `${isMarkdown(file.name) ? 'notes' : 'attachments'}/${file.name}`;
      if ([...files.values()].some((entry) => entry.file.path === path)) throw new Error(`"${path}" already exists. Rename the upload to avoid overwriting it.`);
      await queueFile(path, new Uint8Array(await file.arrayBuffer()));
    }
  } catch (error) { message(errorText(error)); }
  finally { $('upload').value = ''; }
});
for (const navigation of document.querySelectorAll('[data-view]')) navigation.addEventListener('click', () => {
  view = navigation.dataset.view;
  for (const item of document.querySelectorAll('[data-view]')) item.removeAttribute('aria-current');
  navigation.setAttribute('aria-current', 'page');
  message();
  render();
  if (view === 'devices') void renderDevices().catch((error) => message(errorText(error)));
});
$('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  event.submitter.disabled = true;
  try {
    const result = await client.makePairing($('pair-name').value.trim());
    $('pair-code').value = result.pairingCode;
    message('Pairing code created. Share it privately with your new device.');
  } catch (error) { message(errorText(error)); }
  finally { event.submitter.disabled = false; }
});
$('copy-pair').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('pair-code').value); message('Pairing code copied.'); }
  catch { message('Clipboard unavailable. Select and copy the pairing code manually.'); }
});
$('export-all').addEventListener('click', () => {
  try {
    const active = [...files.values()].filter((entry) => !entry.deleted);
    const archive = exportZip(active.map((entry) => ({ path: entry.file.path, bytes: base64ToBytes(entry.file.content) })));
    download(archive, 'jotdrop-files.zip', 'application/zip');
    message('ZIP downloaded with your original files. The export is not encrypted. Keep it safe.');
  } catch (error) { message(errorText(error)); }
});
$('download-recovery').addEventListener('click', () => download(encoder.encode($('recovery-code').value), 'jotdrop-recovery.txt', 'text/plain'));
$('recovery-dialog').addEventListener('cancel', (event) => event.preventDefault());
$('recovery-saved').addEventListener('change', () => { $('finish-recovery').disabled = !$('recovery-saved').checked; });
$('finish-recovery').addEventListener('click', () => { $('recovery-dialog').close(); $('recovery-code').value = ''; });
window.addEventListener('online', () => { if (client) void sync(); });
window.addEventListener('beforeunload', (event) => {
  const unsaved = $('editor').open && $('note-content').value !== (editing ? noteText(editing.file) : '# Untitled\n\n');
  if (unsaved) { event.preventDefault(); event.returnValue = ''; }
});
setInterval(() => { if (client && !document.hidden) void sync(); }, 30000);
try {
  if (await store('get', 'connection')) { $('connect-form').hidden = true; $('unlock-form').hidden = false; }
} catch (error) { $('access-message').textContent = errorText(error); $('connect-form').querySelector('button[type="submit"]').disabled = true; }

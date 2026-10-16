import { CloudClient } from '/shared/client.mjs';
import { base64ToBytes, bytesToBase64, decryptEnvelope, sealLocal, unsealLocal } from '/shared/crypto.mjs';
import { exportZip } from '/export.mjs';
import { noteSummary, updateMetadata, toggleTask, attachmentPath } from '/note.mjs';

const $ = (id) => document.getElementById(id);
try {
  const theme = localStorage.getItem('jotdrop-theme');
  if (['light', 'dark'].includes(theme)) $('theme').value = theme;
} catch { /* System appearance remains available when site storage is blocked. */ }
document.documentElement.dataset.theme = $('theme').value;
$('theme').addEventListener('change', () => {
  document.documentElement.dataset.theme = $('theme').value;
  try { localStorage.setItem('jotdrop-theme', $('theme').value); } catch { /* Keep the selection for this page. */ }
});
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
let cameraStream;
let cameraRequest = 0;
let photoJob;
let voiceJob;
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

function appendMedia(card, entry, alt = '') {
  const type = mediaType(entry.file.path);
  if (!type || entry.deleted) return;
  const url = URL.createObjectURL(new Blob([base64ToBytes(entry.file.content)], { type }));
  mediaUrls.add(url);
  const media = document.createElement(type.startsWith('image/') ? 'img' : 'audio');
  media.src = url;
  if (media.tagName === 'IMG') { media.alt = alt || entry.file.path.split('/').pop(); media.loading = 'lazy'; }
  else { media.controls = true; media.preload = 'none'; media.setAttribute('aria-label', alt || entry.file.path.split('/').pop()); }
  card.append(media);
}

function render() {
  for (const url of mediaUrls) URL.revokeObjectURL(url);
  mediaUrls.clear();
  $('items').replaceChildren();
  $('items').hidden = view === 'devices';
  $('devices-panel').hidden = view !== 'devices';
  const descriptions = {
    notes: ['Notes', 'Plain Markdown. Your files, your workspace.'],
    archive: ['Archive', 'Kept notes, out of your everyday list.'],
    files: ['Files', 'Images, recordings, and the files you choose to keep.'],
    trash: ['Trash', 'Deleted files stay recoverable. Restoring adds a new cloud version.'],
    devices: ['Devices & recovery', 'You control which devices can access this workspace.'],
  };
  $('view-title').textContent = descriptions[view][0];
  $('view-description').textContent = descriptions[view][1];
  $('note-count').textContent = String([...files.values()].filter((entry) => !entry.deleted && isMarkdown(entry.file.path) && !/^notes\/(Archive|Trash)\//.test(entry.file.path)).length);
  if (view === 'devices') return;
  const selectedLabel = $('label-filter').value;
  const labels = new Map();
  for (const entry of files.values()) if (!entry.deleted && isMarkdown(entry.file.path)) for (const label of noteParts(noteText(entry.file), entry.file.path).labels) labels.set(label.toLowerCase(), label);
  $('label-filter').replaceChildren(new Option('All labels', ''), ...[...labels].sort((a, b) => a[1].localeCompare(b[1])).map(([key, label]) => new Option(label, key)));
  $('label-filter').value = labels.has(selectedLabel) ? selectedLabel : '';
  const query = $('search').value.toLowerCase().trim();
  const matching = [...files.values()].filter((entry) => {
    if (view === 'trash' ? !entry.deleted && !entry.file.path.startsWith('notes/Trash/') : entry.deleted) return false;
    if (view === 'notes' && !isMarkdown(entry.file.path)) return false;
    if (view === 'archive' && (!isMarkdown(entry.file.path) || !entry.file.path.startsWith('notes/Archive/'))) return false;
    if (view === 'notes' && /^notes\/(Archive|Trash)\//.test(entry.file.path)) return false;
    if (view === 'files' && isMarkdown(entry.file.path)) return false;
    if ($('label-filter').value && (!isMarkdown(entry.file.path) || !noteParts(noteText(entry.file), entry.file.path).labels.some((label) => label.toLowerCase() === $('label-filter').value))) return false;
    return !query || entry.file.path.toLowerCase().includes(query) || (isMarkdown(entry.file.path) && noteText(entry.file).toLowerCase().includes(query));
  }).sort((a, b) => {
    const left = isMarkdown(a.file.path) ? noteParts(noteText(a.file), a.file.path) : {};
    const right = isMarkdown(b.file.path) ? noteParts(noteText(b.file), b.file.path) : {};
    const pinned = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
    if (pinned) return pinned;
    if ($('sort').value === 'title') return (left.title || a.file.path).localeCompare(right.title || b.file.path);
    if ($('sort').value === 'manual' && (left.order !== undefined || right.order !== undefined)) return (left.order ?? Infinity) - (right.order ?? Infinity);
    const modified = String(b.file.modifiedAt).localeCompare(String(a.file.modifiedAt));
    return $('sort').value === 'oldest' ? -modified : modified;
  });
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
    if (markdown) {
      card.append(paragraph(parts.preview.slice(0, 600), 'note-preview'));
      const fullText = noteText(entry.file);
      const bodyOffset = fullText.slice(0, fullText.length - parts.body.length).split('\n').length - 1;
      let fence;
      if (!entry.deleted) parts.body.split('\n').forEach((line, bodyIndex) => {
        const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; return; }
        if (fence) return;
        const task = /^\s*[-*+] \[([ xX])\] (.*)\r?$/.exec(line);
        if (!task) return;
        const row = document.createElement('label'); row.className = 'task-row';
        const input = document.createElement('input'); input.type = 'checkbox'; input.checked = task[1] !== ' ';
        input.disabled = entry.conflict || $('editor').open;
        input.addEventListener('change', async () => {
          input.disabled = true;
          try { const latest = files.get(entry.id); if (latest !== entry) throw new Error('This checklist changed. Sync and try again.'); await queueFile(entry.file.path, encoder.encode(toggleTask(noteText(entry.file), bodyOffset + bodyIndex, input.checked)), entry.revision); }
          catch (error) { input.checked = !input.checked; input.disabled = false; message(errorText(error)); }
        });
        row.append(input, document.createTextNode(task[2])); card.append(row);
      });
      if (parts.reminder) card.append(paragraph(`Reminder: ${parts.reminder}${parts.repeat ? ` (${parts.repeat})` : ''}. Scheduled by Android after sync.`, 'note-meta'));
      const available = [...files.values()].filter((item) => !item.deleted && !isMarkdown(item.file.path));
      const targets = [...parts.body.matchAll(/!\[\[([^\]]+)\]\]|!?\[[^\]]*\]\(([^)]+)\)/g)];
      const shown = new Set();
      for (const target of targets) {
        const path = attachmentPath(target[1] || target[2], entry.file.path, available.map((item) => item.file.path));
        const attachment = available.find((item) => item.file.path === path);
        if (attachment && !shown.has(path)) { appendMedia(card, attachment); shown.add(path); }
      }
    } else appendMedia(card, entry);
    card.append(paragraph(entry.pending ? 'Encrypted draft on this browser. Waiting for cloud.' : `Cloud version ${entry.revision}`, 'note-meta'));
    if (entry.conflict) card.append(paragraph('Another device saved a different version. Review both before choosing.', 'message'));
    card.append(paragraph(entry.file.path, 'note-meta'));
    if (markdown) for (const label of parts.labels) card.append(button(label, () => { $('label-filter').value = label.toLowerCase(); render(); }, 'label-chip'));
    if (entry.deleted) card.append(button('Restore', () => restoreEntry(entry)));
    else {
      if (markdown) card.append(button('Open note', () => openEditor(entry)));
      if (markdown) card.append(button(view === 'trash' ? 'Restore note' : view === 'archive' ? 'Unarchive' : 'Archive', () => moveArchive(entry), 'archive-note'));
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
  const activeClient = client, activeGeneration = generation;
  if (!activeClient) throw new Error('Unlock the workspace before saving.');
  const prepared = await activeClient.prepareWrite(path, bytes, 0);
  if (generation !== activeGeneration) throw new Error('Workspace changed before saving. Reopen the original workspace.');
  const current = files.get(prepared.id);
  if (expectedRevision === undefined && current) throw new Error('That filename already exists. Choose another filename or open the existing note to edit it.');
  if (expectedRevision !== undefined && current?.revision !== expectedRevision) throw new Error('This note changed while you were editing. Download your draft, then reopen the current version before saving.');
  if (current?.conflict) throw new Error('Review the cloud conflict before saving another edit. Download this draft to keep a separate copy.');
  const key = `${pendingPrefix()}${prepared.id}`;
  const prior = await store('get', key);
  if (generation !== activeGeneration) throw new Error('Workspace changed before saving. Reopen the original workspace.');
  prepared.baseRevision = prior?.prepared.baseRevision ?? current?.revision ?? 0;
  const record = { prepared, deleted: false, queueId: crypto.randomUUID() };
  await store('put', key, record);
  if (generation !== activeGeneration) return;
  files.set(prepared.id, { id: prepared.id, revision: prepared.baseRevision, deleted: false, pending: true, file: { path, content: bytesToBase64(bytes), modifiedAt: new Date().toISOString() } });
  render();
  void sync();
}

async function deleteEntry(entry, ask = true) {
  if (ask && !confirm(`Move "${entry.file.path}" to trash?`)) return;
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

async function moveArchive(entry) {
  if (syncing) await syncing;
  if (entry !== files.get(entry.id) || entry.pending || entry.conflict || entry.deleted) throw new Error('Sync and resolve this note before moving it.');
  const path = /^notes\/(Archive|Trash)\//.test(entry.file.path) ? entry.file.path.replace(/^notes\/(Archive|Trash)\//, 'notes/') : entry.file.path.replace(/^notes\//, 'notes/Archive/');
  if (path === entry.file.path) throw new Error('Only notes in the notes folder can be archived.');
  if (!confirm(`Move this note to ${path}? The original stays until the new cloud copy is confirmed.`)) return;
  // Copy first, verify the cloud acknowledgement, then trash the original. Never delete on a failed upload.
  const text = noteText(entry.file).replace(/(!?\[[^\]]*\]\()([^)]*)(\))/g, (all, start, target, end) => {
    const attachment = attachmentPath(target, entry.file.path, [...files.values()].filter((item) => !item.deleted).map((item) => item.file.path));
    return attachment?.startsWith('attachments/') ? `${start}${'../'.repeat(path.split('/').length - 1)}${attachment}${end}` : all;
  });
  const destination = [...files.values()].find((item) => item.file.path === path);
  if (destination && (!destination.deleted || destination.pending || destination.conflict)) throw new Error('The destination already exists or needs sync. Both notes are kept; choose a different filename.');
  await queueFile(path, encoder.encode(text), destination?.revision);
  await sync();
  const copy = [...files.values()].find((item) => item.file.path === path);
  if (!copy || copy.pending || copy.conflict) throw new Error('The new copy is still waiting to sync. The original is kept; resolve both copies before retrying.');
  if (entry !== files.get(entry.id)) throw new Error('The original changed during the move. Both copies are kept for review.');
  await deleteEntry(entry, false);
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
  discardVoice();
  resetPhoto();
  editing = entry;
  editingRevision = entry?.revision;
  $('note-path').value = entry?.file.path || `notes/${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.md`;
  $('note-path').readOnly = Boolean(entry);
  $('note-content').value = entry ? noteText(entry.file) : '# Untitled\n\n';
  refreshProperties();
  $('editor-message').textContent = 'Changes are saved only when you select Save note.';
  $('history').hidden = true;
  $('history-list').replaceChildren();
  for (const id of ['note-history', 'note-download', 'note-delete']) $(id).hidden = !entry;
  $('editor').showModal();
  $('note-content').focus();
}

function refreshProperties() {
  const parts = noteParts($('note-content').value, $('note-path').value);
  $('note-labels').value = parts.labels.join('\n');
  $('note-color').value = parts.color;
  $('note-pinned').checked = parts.pinned;
  $('note-order').value = parts.order ?? '';
  $('note-reminder').value = parts.reminder;
  $('note-repeat').value = parts.repeat;
}

for (const [id, key] of [['note-labels', 'jotdrop_labels'], ['note-color', 'color'], ['note-pinned', 'pinned'], ['note-order', 'order'], ['note-reminder', 'reminder'], ['note-repeat', 'reminder_repeat']]) $(id).addEventListener('change', () => {
  try {
    const input = $(id);
    let value = input.type === 'checkbox' ? input.checked : input.value.trim();
    if (key === 'jotdrop_labels') value = [...new Map(value.split('\n').map((label) => label.trim()).filter(Boolean).map((label) => [label.toLowerCase(), label])).values()];
    if (key === 'order' && value !== '') { value = Number(value); if (!Number.isFinite(value)) throw new Error('Manual position must be a finite number.'); }
    if (key === 'reminder_repeat' && value && !/^(daily|monthly|yearly|weekly:[1-7](,[1-7])*|every:[1-9]\d*:(days|weeks|months)|ordinal:[1-5]:[1-7])$/.test(value)) throw new Error('Use daily, weekly:1,3,5, monthly, yearly, every:N:days|weeks|months, or ordinal:K:weekday.');
    const changes = { [key]: value === '' || value === false || Array.isArray(value) && !value.length ? null : value };
    if (key === 'reminder' && !value) for (const field of ['reminder_repeat', 'reminder_until', 'reminder_limit', 'reminder_done']) changes[field] = null;
    if (key === 'reminder' || key === 'reminder_repeat') changes.reminder_done = null;
    $('note-content').value = updateMetadata($('note-content').value, changes);
    $('editor-message').textContent = 'Properties updated in Markdown. Select Save note to keep them.';
    refreshProperties();
  } catch (error) { $('editor-message').textContent = errorText(error); refreshProperties(); }
});
$('note-content').addEventListener('input', refreshProperties);

function discardVoice() {
  if (voiceJob) {
    clearTimeout(voiceJob.timer);
    if (voiceJob.recorder?.state === 'recording') voiceJob.recorder.stop();
    voiceJob.stream?.getTracks().forEach((track) => track.stop());
  }
  voiceJob = undefined;
  $('start-voice').disabled = false;
  for (const id of ['stop-voice', 'retry-voice', 'download-voice']) $(id).hidden = true;
  $('editor-form').querySelector('button[type="submit"]').disabled = Boolean(photoJob);
}

async function keepVoice() {
  const job = voiceJob;
  if (!job?.blob || job.saving) return;
  job.saving = true;
  try {
    if (job.blob.size > 4 * 1024 * 1024) throw new Error('This recording exceeds 4 MiB. Download it before closing this note.');
    await queueFile(job.path, new Uint8Array(await job.blob.arrayBuffer()));
    if (voiceJob !== job || job.generation !== generation || !$('editor').open) return;
    $('note-content').value += `\n\n[Voice memo](${'../'.repeat($('note-path').value.split('/').length - 1)}${job.path})\n`;
    discardVoice();
    $('voice-message').textContent = 'Recording kept as an encrypted attachment. Select Save note to keep its link.';
  } catch (error) {
    if (voiceJob === job) { job.saving = false; $('voice-message').textContent = errorText(error); $('retry-voice').hidden = false; $('download-voice').hidden = false; }
  }
}

$('start-voice').addEventListener('click', async () => {
  if (voiceJob) return;
  const job = { generation, path: `attachments/voice-${crypto.randomUUID()}`, chunks: [], size: 0 };
  voiceJob = job;
  $('start-voice').disabled = true;
  $('editor-form').querySelector('button[type="submit"]').disabled = true;
  try {
    if (!isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Voice recording is unavailable. Use HTTPS or localhost, or upload an existing recording.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (voiceJob !== job || job.generation !== generation || !$('editor').open) { stream.getTracks().forEach((track) => track.stop()); return; }
    job.stream = stream;
    const preferred = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
    if (!preferred) throw new Error('This browser uses an unsupported recording format. Upload an existing recording instead.');
    job.recorder = new MediaRecorder(stream, { mimeType: preferred });
    const mime = job.recorder.mimeType;
    if (!/^(audio|video)\/(webm|ogg|mp4)(;|$)/.test(mime)) throw new Error('This browser uses an unsupported recording format. Upload an existing recording instead.');
    job.path += mime.includes('mp4') ? '.m4a' : mime.includes('ogg') ? '.ogg' : '.webm';
    job.recorder.ondataavailable = ({ data }) => { if (data.size) { job.chunks.push(data); job.size += data.size; if (job.size >= 3 * 1024 * 1024 && job.recorder.state === 'recording') job.recorder.stop(); } };
    job.recorder.onstop = () => {
      clearTimeout(job.timer);
      stream.getTracks().forEach((track) => track.stop());
      if (voiceJob !== job || job.generation !== generation) return;
      $('stop-voice').hidden = true;
      job.blob = new Blob(job.chunks, { type: mime });
      if (!job.blob.size) { discardVoice(); $('voice-message').textContent = 'No audio was captured. Try again or upload a recording.'; return; }
      void keepVoice();
    };
    job.recorder.onerror = () => { $('voice-message').textContent = 'Recording stopped unexpectedly. Keeping captured audio.'; if (job.recorder.state === 'recording') job.recorder.stop(); };
    job.recorder.start(1000);
    job.timer = setTimeout(() => { if (job.recorder.state === 'recording') job.recorder.stop(); }, 120000);
    $('stop-voice').hidden = false;
    $('voice-message').textContent = 'Recording on this device. Stops after two minutes or 3 MiB. Stop & keep before closing.';
  } catch (error) { if (voiceJob === job) { discardVoice(); $('voice-message').textContent = error.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in browser settings or upload a recording.' : errorText(error); } }
});
$('stop-voice').addEventListener('click', () => { if (voiceJob?.recorder?.state === 'recording') voiceJob.recorder.stop(); });
$('retry-voice').addEventListener('click', () => { void keepVoice(); });
$('download-voice').addEventListener('click', async () => { if (voiceJob?.blob) download(new Uint8Array(await voiceJob.blob.arrayBuffer()), voiceJob.path, voiceJob.blob.type); });

function closeEditor() {
  const original = editing ? noteText(editing.file) : '# Untitled\n\n';
  if (($('note-content').value !== original || voiceJob) && !confirm('Close without saving these edits or recording?')) return;
  discardVoice();
  resetPhoto();
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
  if (voiceJob && !confirm('Discard the current recording and lock?')) return;
  discardVoice();
  resetPhoto();
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
$('sort').addEventListener('change', render);
$('new-note').addEventListener('click', () => openEditor());
function stopCamera() {
  cameraRequest++;
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = undefined;
  $('camera-preview').srcObject = null;
  $('camera-preview').hidden = true;
  $('camera-actions').hidden = true;
  $('capture-photo').disabled = true;
}

function cancelRecognition() {
  photoJob?.worker?.terminate();
  clearTimeout(photoJob?.timer);
  photoJob = undefined;
  $('cancel-ocr').hidden = true;
  $('start-camera').disabled = false;
  $('photo-upload').disabled = false;
  $('editor-form').querySelector('button[type="submit"]').disabled = Boolean(voiceJob);
}

function resetPhoto() {
  stopCamera();
  cancelRecognition();
  $('photo-upload').value = '';
  $('photo-tools').open = false;
  $('photo-message').textContent = 'Camera access needs HTTPS or localhost and your permission. Choosing a photo also works without a camera.';
}

async function recognizePhoto(photo) {
  if (photoJob || !$('editor').open || !client) return;
  const job = { generation };
  photoJob = job;
  $('start-camera').disabled = true;
  $('photo-upload').disabled = true;
  $('editor-form').querySelector('button[type="submit"]').disabled = true;
  const current = () => photoJob === job && job.generation === generation && $('editor').open;
  try {
    if (photo.size > 4 * 1024 * 1024) throw new Error('This photo exceeds 4 MiB. Choose a smaller photo; the original has not been uploaded.');
    const bytes = new Uint8Array(await photo.arrayBuffer());
    const extension = bytes[0] === 0x89 && decoder.decode(bytes.slice(1, 4)) === 'PNG' ? 'png' : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'jpg' : decoder.decode(bytes.slice(0, 4)) === 'RIFF' && decoder.decode(bytes.slice(8, 12)) === 'WEBP' ? 'webp' : undefined;
    if (!extension) throw new Error('Choose a valid PNG, JPEG or WebP photo.');
    let bitmap;
    try { bitmap = await createImageBitmap(photo); }
    catch { throw new Error('Choose a valid PNG, JPEG or WebP photo.'); }
    const pixels = bitmap.width * bitmap.height;
    bitmap.close();
    if (pixels > 24_000_000) throw new Error('This photo exceeds 24 megapixels. Choose a smaller photo; the original has not been uploaded.');
    if (!current()) return;
    $('photo-message').textContent = 'Keeping the source photo as an encrypted attachment...';
    const path = `attachments/photo-${crypto.randomUUID()}.${extension}`;
    await queueFile(path, bytes);
    if (!current()) return;
    $('note-content').value += `\n\n![Source photo](../${path})\n`;
    $('photo-message').textContent = 'Loading local text recognition. Your source photo is kept in Files.';
    $('cancel-ocr').hidden = false;
    job.worker = new Worker('/ocr-worker.js', { type: 'module' });
    const finish = (text) => {
      if (!current()) return;
      $('photo-message').textContent = text;
      cancelRecognition();
    };
    const failed = () => finish('Text recognition failed. Your source photo is kept in Files and linked here. Retry by choosing the photo again, or enter text manually.');
    job.worker.onerror = failed;
    job.worker.onmessage = ({ data }) => {
      if (!current()) return;
      if (data.error) { failed(); return; }
      if (typeof data.text === 'string') {
        const text = data.text.trim();
        if (text) $('note-content').value += `\n${text}\n`;
        finish(text ? 'Review the recognized text, correct any mistakes, then select Save note. The source photo is kept.' : 'No text was recognized. The source photo is kept in Files and linked here. Try a clearer photo, or enter text manually.');
      } else if (data.status) $('photo-message').textContent = `Local OCR: ${data.status} ${Math.round((data.progress || 0) * 100)}%. Source photo kept.`;
    };
    job.timer = setTimeout(failed, 120000);
    job.worker.postMessage(photo);
  } catch (error) {
    if (current()) { $('photo-message').textContent = errorText(error); cancelRecognition(); }
  }
}

$('start-camera').addEventListener('click', async () => {
  stopCamera();
  const request = cameraRequest;
  try {
    if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Camera unavailable. Use HTTPS or localhost and a browser with camera support, or choose a photo instead.');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    if (request !== cameraRequest || !$('editor').open) { stream.getTracks().forEach((track) => track.stop()); return; }
    cameraStream = stream;
    $('camera-preview').srcObject = stream;
    $('camera-preview').hidden = false;
    $('camera-actions').hidden = false;
    await $('camera-preview').play();
    if (request === cameraRequest) { $('capture-photo').disabled = false; $('photo-message').textContent = 'Frame the text, then take a photo. The camera stops after capture.'; }
  } catch (error) {
    if (request !== cameraRequest) return;
    stopCamera();
    $('photo-message').textContent = error.name === 'NotAllowedError' ? 'Camera permission was denied. Allow camera access in browser settings or choose a photo instead.' : error.name === 'NotFoundError' ? 'No camera was found. Connect a camera or choose a photo instead.' : errorText(error);
  }
});
$('capture-photo').addEventListener('click', async () => {
  const video = $('camera-preview');
  if (!video.videoWidth || photoJob) return;
  const request = cameraRequest;
  $('capture-photo').disabled = true;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const photo = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (request !== cameraRequest || !$('editor').open) return;
    stopCamera();
    if (!photo) throw new Error('The camera could not create a photo. Choose a photo instead.');
    await recognizePhoto(photo);
  } catch (error) { stopCamera(); $('photo-message').textContent = errorText(error); }
});
$('stop-camera').addEventListener('click', stopCamera);
$('photo-tools').addEventListener('toggle', () => { if (!$('photo-tools').open) stopCamera(); });
$('cancel-ocr').addEventListener('click', () => { cancelRecognition(); $('photo-message').textContent = 'Recognition cancelled. The source photo is kept in Files and linked here. You can still save this note.'; });
$('photo-upload').addEventListener('change', async () => {
  const photo = $('photo-upload').files[0];
  stopCamera();
  if (photo) await recognizePhoto(photo);
  $('photo-upload').value = '';
});
$('close-editor').addEventListener('click', closeEditor);
$('editor').addEventListener('cancel', (event) => { event.preventDefault(); closeEditor(); });
$('editor-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  event.submitter.disabled = true;
  try {
    if (photoJob || voiceJob) throw new Error('Finish text recognition or keep your recording before saving the note.');
    if (!isMarkdown($('note-path').value)) throw new Error('Notes must use a .md filename.');
    await queueFile($('note-path').value, encoder.encode($('note-content').value), editingRevision);
    resetPhoto();
    $('editor').close();
    $('note-content').value = '';
    editing = undefined;
  } catch (error) { $('editor-message').textContent = errorText(error); }
  finally { event.submitter.disabled = false; }
});
$('note-download').addEventListener('click', () => download(encoder.encode($('note-content').value), $('note-path').value, 'text/markdown'));
$('note-delete').addEventListener('click', async () => {
  try { await deleteEntry(editing); resetPhoto(); $('editor').close(); }
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
window.addEventListener('pagehide', () => { resetPhoto(); discardVoice(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopCamera(); if (voiceJob?.recorder?.state === 'recording') voiceJob.recorder.stop(); } });
window.addEventListener('beforeunload', (event) => {
  const unsaved = $('editor').open && (voiceJob || $('note-content').value !== (editing ? noteText(editing.file) : '# Untitled\n\n'));
  if (unsaved) { event.preventDefault(); event.returnValue = ''; }
});
setInterval(() => { if (client && !document.hidden) void sync(); }, 30000);
try {
  if (await store('get', 'connection')) { $('connect-form').hidden = true; $('unlock-form').hidden = false; }
} catch (error) { $('access-message').textContent = errorText(error); $('connect-form').querySelector('button[type="submit"]').disabled = true; }

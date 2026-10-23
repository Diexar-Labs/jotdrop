import { CloudClient } from '/shared/client.mjs';
import { accountInfo, approveDevice, attachAccount, changePassword, checkApproval, completeApproval, confirmLogin, confirmSignup, disableTotp, enableTotp, listApprovals, logIn, newRecoveryCode, rejectDevice, requestApproval, resetWithRecoveryCode, setupTotp, signUp, startOver, startReset } from '/shared/account.mjs';
import { base64ToBytes, bytesToBase64, decodeRecovery, decryptEnvelope, sealLocal, unsealLocal } from '/shared/crypto.mjs';
import { exportZip } from '/export.mjs';
import { noteSummary, updateMetadata, toggleTask, attachmentPath, plainPreviewText } from '/note.mjs';

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
let syncController;
let syncPaused = false;
let cursor = 0;
let generation = 0;
let cameraStream;
let cameraRequest = 0;
let photoJob;
let voiceJob;
// The time machine: `moment` holds the files as they were while an earlier moment is shown.
let moment;
let momentRequest = 0;
const moments = new Map();
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
    } else if (action === 'queue' || action === 'ack') {
      const request = values.get(key);
      request.onsuccess = () => {
        const latest = request.result;
        // Compare and mutate together: a newer draft must survive an older receipt.
        if (action === 'queue') {
          value.prepared.baseRevision = latest?.prepared.baseRevision ?? value.prepared.baseRevision;
          values.put(value, key);
        } else {
          if (latest?.queueId === value.queueId) values.delete(key);
          else if (latest) {
            latest.prepared.baseRevision = value.revision;
            values.put(latest, key);
          }
          values.delete(key.replace('pending:', 'upload:'));
        }
      };
    } else if (action === 'delete' && Array.isArray(key)) {
      for (const item of key) values.delete(item);
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

// Masonry like Keep: each grid child spans as many 8px rows as its height needs, so
// short cards pack under each other while the DOM (and reading) order stays row-wise.
const gridSpans = new ResizeObserver((entries) => {
  for (const { target } of entries) target.style.gridRowEnd = `span ${Math.ceil((target.getBoundingClientRect().height + 16) / 8)}`;
});

function render() {
  for (const url of mediaUrls) URL.revokeObjectURL(url);
  mediaUrls.clear();
  gridSpans.disconnect();
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
  const source = moment ? moment.files : files;
  const selectedLabel = $('label-filter').value;
  const labels = new Map();
  for (const entry of source.values()) if (!entry.deleted && isMarkdown(entry.file.path)) for (const label of noteParts(noteText(entry.file), entry.file.path).labels) labels.set(label.toLowerCase(), label);
  $('label-filter').replaceChildren(new Option('All labels', ''), ...[...labels].sort((a, b) => a[1].localeCompare(b[1])).map(([key, label]) => new Option(label, key)));
  $('label-filter').value = labels.has(selectedLabel) ? selectedLabel : '';
  const query = $('search').value.toLowerCase().trim();
  const matching = [...source.values()].filter((entry) => {
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
  const sections = view === 'notes' && matching.some((entry) => isMarkdown(entry.file.path) && noteParts(noteText(entry.file), entry.file.path).pinned);
  let section;
  for (const entry of matching) {
    const card = document.createElement('article');
    card.className = `note-card${entry.pending ? ' is-pending' : ''}`;
    const title = document.createElement('h3');
    const markdown = isMarkdown(entry.file.path);
    const parts = markdown ? noteParts(noteText(entry.file), entry.file.path) : { title: entry.file.path.split('/').pop() };
    if (markdown) card.classList.add(`note-${parts.color}`);
    if (sections && section !== Boolean(parts.pinned)) {
      section = Boolean(parts.pinned);
      const heading = document.createElement('h2');
      heading.className = 'grid-section';
      heading.textContent = section ? 'Pinned' : 'Others';
      $('items').append(heading);
    }
    title.textContent = markdown ? plainPreviewText(parts.title) : parts.title;
    card.append(title);
    if (markdown) {
      const fullText = noteText(entry.file);
      const bodyOffset = fullText.slice(0, fullText.length - parts.body.length).split('\n').length - 1;
      // Show the body in its own order: text as text, checklist lines only as checkboxes.
      const titleLine = /^\s*#\s+/.test(parts.body) ? parts.body.split('\n').findIndex((line) => line.trim()) : -1;
      let text = [], budget = 600, fence;
      const flush = () => {
        // Media show below the text; a link shows its label.
        const value = plainPreviewText(text.join('\n').replace(/!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\)/g, '').replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1'))
          .replace(/\n{3,}/g, '\n\n').trim().slice(0, budget);
        if (value) { card.append(paragraph(value, 'note-preview')); budget -= value.length; }
        text = [];
      };
      parts.body.split('\n').forEach((line, bodyIndex) => {
        if (bodyIndex === titleLine) return;
        const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; }
        const task = !marker && !fence && !entry.deleted && /^\s*[-*+] \[([ xX])\] (.*)\r?$/.exec(line);
        if (!task) { if (budget > 0) text.push(line.replace(/\r$/, '')); return; }
        flush();
        const row = document.createElement('label'); row.className = 'task-row';
        const input = document.createElement('input'); input.type = 'checkbox'; input.checked = task[1] !== ' ';
        input.disabled = entry.conflict || $('editor').open || Boolean(moment);
        input.addEventListener('change', async () => {
          input.disabled = true;
          try { const latest = files.get(entry.id); if (latest !== entry) throw new Error('This checklist changed. Sync and try again.'); await queueFile(entry.file.path, encoder.encode(toggleTask(noteText(entry.file), bodyOffset + bodyIndex, input.checked)), entry.revision); }
          catch (error) { input.checked = !input.checked; input.disabled = false; message(errorText(error)); }
        });
        row.append(input, document.createTextNode(plainPreviewText(task[2]))); card.append(row);
      });
      flush();
      if (!entry.deleted && !moment) {
        card.classList.add('opens');
        card.addEventListener('click', (event) => { if (!event.target.closest('button, input, label, audio')) openEditor(entry); });
      }
      if (parts.reminder) card.append(paragraph(`Reminder: ${parts.reminder}${parts.repeat ? ` (${parts.repeat})` : ''}. Scheduled by Android after sync.`, 'note-meta'));
      const available = [...source.values()].filter((item) => !item.deleted && !isMarkdown(item.file.path));
      const targets = [...parts.body.matchAll(/!\[\[([^\]]+)\]\]|!?\[[^\]]*\]\(([^)]+)\)/g)];
      const shown = new Set();
      for (const target of targets) {
        const path = attachmentPath(target[1] || target[2], entry.file.path, available.map((item) => item.file.path));
        const attachment = available.find((item) => item.file.path === path);
        if (attachment && !shown.has(path)) { appendMedia(card, attachment); shown.add(path); }
      }
    } else appendMedia(card, entry);
    if (entry.pending) card.append(paragraph('Encrypted draft on this browser. Waiting for cloud.', 'note-meta'));
    if (entry.conflict) card.append(paragraph('Another device saved a different version. Review both before choosing.', 'message'));
    if (markdown) for (const label of parts.labels) card.append(button(label, () => { $('label-filter').value = label.toLowerCase(); render(); }, 'label-chip'));
    if (entry.conflict) card.append(button('Review cloud version', () => reviewConflict(entry)));
    // Like Keep and the plugin: actions and file details show on hover or focus (always on touch).
    // An earlier moment is read-only; the time machine restores it as a whole.
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    if (entry.deleted) actions.append(button('Restore', () => restoreEntry(entry)));
    else {
      if (markdown) actions.append(button('Open note', () => openEditor(entry)));
      if (markdown) actions.append(button(view === 'trash' ? 'Restore note' : view === 'archive' ? 'Unarchive' : 'Archive', () => moveArchive(entry), 'archive-note'));
      actions.append(button('Download', () => download(base64ToBytes(entry.file.content), entry.file.path)));
      if (!markdown) actions.append(button('Move to trash', () => deleteEntry(entry), 'danger'));
    }
    if (!moment) card.append(actions);
    // Path and confirmed revision stay out of sight: the editor shows the filename and version history.
    card.dataset.path = entry.file.path;
    if (!entry.pending) card.dataset.revision = entry.revision;
    $('items').append(card);
  }
  for (const child of $('items').children) gridSpans.observe(child);
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

async function queueFile(path, bytes, expectedRevision, modifiedAt = new Date().toISOString()) {
  const activeClient = client, activeGeneration = generation;
  if (!activeClient) throw new Error('Unlock the workspace before saving.');
  const prepared = await activeClient.prepareWrite(path, bytes, 0, modifiedAt);
  if (generation !== activeGeneration) throw new Error('Workspace changed before saving. Reopen the original workspace.');
  const current = files.get(prepared.id);
  if (expectedRevision === undefined && current) throw new Error('That filename already exists. Choose another filename or open the existing note to edit it.');
  if (expectedRevision !== undefined && current?.revision !== expectedRevision) throw new Error('This note changed while you were editing. Download your draft, then reopen the current version before saving.');
  if (current?.conflict) throw new Error('Review the cloud conflict before saving another edit. Download this draft to keep a separate copy.');
  const key = `${pendingPrefix()}${prepared.id}`;
  prepared.baseRevision = current?.revision ?? 0;
  const record = { prepared, deleted: false, queueId: crypto.randomUUID() };
  await store('queue', key, record);
  if (generation !== activeGeneration) return;
  files.set(prepared.id, { id: prepared.id, revision: prepared.baseRevision, deleted: false, pending: true, file: { path, content: bytesToBase64(bytes), modifiedAt } });
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
  if (prior && prior.prepared.baseRevision === 0 && !await store('get', key.replace('pending:', 'upload:'))) {
    await store('delete', key);
    files.delete(entry.id);
  } else {
    const prepared = prior?.prepared || await client.prepareWrite(entry.file.path, base64ToBytes(entry.file.content), entry.revision, entry.file.modifiedAt);
    await store('queue', key, { prepared, deleted: true, queueId: crypto.randomUUID() });
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

async function performSync(signal) {
  if (!client) return;
  const { credentials, fetcher } = client;
  const activeClient = new CloudClient({ ...credentials, fetcher: (url, options) => fetcher(url, { ...options, signal: AbortSignal.any([signal, options.signal]) }) });
  const activeGeneration = generation;
  let changed = false;
  $('sync-status').textContent = 'Syncing encrypted changes...';
  const keyPrefix = pendingPrefix();
  for (const [key, pending] of await store('entries', keyPrefix)) {
    if (activeGeneration !== generation) return;
    signal.throwIfAborted();
    if (files.get(pending.prepared.id)?.conflict) continue;
    const uploadKey = key.replace('pending:', 'upload:');
    // Freeze the active snapshot independently of edits to the latest queued draft.
    const uploading = await store('get', uploadKey) || pending;
    await store('put', uploadKey, uploading);
    let result;
    try { result = uploading.deleted ? await activeClient.remove(uploading.prepared.id, uploading.prepared.baseRevision) : await activeClient.commitWrite(uploading.prepared, {
      resumable: true, signal,
      onProgress: ({ phase, transferredBytes, totalBytes }) => {
        if (activeGeneration !== generation || signal.aborted) return;
        const progress = $('upload-progress');
        progress.hidden = false;
        progress.max = totalBytes;
        progress.value = transferredBytes;
        $('sync-status').textContent = phase === 'committed' ? 'Cloud version confirmed.' : phase === 'committing' ? 'Encrypted bytes confirmed. Finalizing cloud version...' : `${Math.floor(transferredBytes / 1024)} / ${Math.ceil(totalBytes / 1024)} KiB encrypted bytes confirmed.`;
      },
    }); }
    catch (error) {
      signal.throwIfAborted();
      if (error.status !== 409) throw error;
      let remote;
      try { remote = await activeClient.read(uploading.prepared.id); }
      catch (readError) {
        if (readError.status !== 404) throw readError;
        // The cloud cleared this file after 30 days in the trash: a deletion is done, an edit uploads as a new file next time.
        await store('delete', uploadKey);
        const latest = await store('get', key);
        if (latest?.deleted) { await store('delete', key); files.delete(pending.prepared.id); }
        else if (latest) { latest.prepared.baseRevision = 0; await store('put', key, latest); const entry = files.get(pending.prepared.id); if (entry) entry.revision = 0; }
        changed = true;
        continue;
      }
      const expected = await decryptEnvelope(activeClient.credentials.vaultKey, JSON.parse(uploading.prepared.envelope), `jotdrop:object:v1:${activeClient.credentials.vaultId}:${uploading.prepared.id}`);
      if (remote.deleted === uploading.deleted && remote.file.path === expected.path && remote.file.content === expected.content) result = { revision: remote.revision };
      else {
        const entry = files.get(pending.prepared.id);
        if (entry) { entry.conflict = true; changed = true; }
        continue;
      }
    }
    if (activeGeneration !== generation) return;
    const latest = await store('get', key);
    if (latest?.queueId === uploading.queueId) {
      const entry = files.get(pending.prepared.id);
      if (entry) {
        entry.revision = result.revision;
        entry.pending = false;
        changed = true;
        await cacheEntry(entry);
      }
    }
    await store('ack', key, { queueId: uploading.queueId, revision: result.revision });
  }
  let more = true;
  while (more) {
    signal.throwIfAborted();
    const result = await activeClient.listChanges(cursor);
    for (const change of result.changes) {
      if (activeGeneration !== generation) return;
      // The time machine steps per minute with a change.
      const minute = change.updatedAt.slice(0, 16);
      if (!(moments.get(minute) > change.updatedAt)) moments.set(minute, change.updatedAt);
      if (await store('get', `${keyPrefix}${change.id}`)) continue;
      let entry;
      try { entry = await activeClient.read(change.id); }
      catch (error) {
        if (error.status !== 404) throw error;
        // A full free cloud clears notes that sat in the trash for 30 days.
        if (activeGeneration !== generation) return;
        if (files.delete(change.id)) changed = true;
        await store('delete', `${cachePrefix()}${change.id}`);
        continue;
      }
      if (activeGeneration !== generation) return;
      files.set(change.id, entry);
      changed = true;
      await cacheEntry(entry);
    }
    cursor = result.cursor;
    more = result.hasMore;
  }
  updateTimeline();
  const status = await activeClient.status();
  if (activeGeneration !== generation) return;
  $('storage-usage').textContent = `${(status.usedBytes / 1048576).toFixed(1)} / ${(status.quotaBytes / 1048576).toFixed(0)} MiB encrypted storage`;
  const plan = status.plan;
  $('plan-status').textContent = plan.name === 'plus' ? `JotDrop Plus until ${new Date(plan.plusUntil).toLocaleDateString()}` : `Free plan: ${plan.deviceLimit} devices, ${plan.historyDays} days of history`;
  $('start-trial').hidden = !plan.trialAvailable;
  $('plus-offer').hidden = !plan.checkout || plan.subscribed;
  $('buy-year').textContent = plan.founderPrice ? '€29 per year (founder price)' : '€39 per year';
  $('plus-manage').hidden = !plan.subscribed;
  const pending = await store('entries', keyPrefix);
  const conflicts = [...files.values()].filter((entry) => entry.conflict).length;
  $('sync-status').textContent = conflicts ? `${conflicts} conflict(s) need review. Local drafts are preserved.` : pending.length ? `${pending.length} encrypted change(s) waiting to upload.` : `Cloud copy up to date at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
  if (changed) render();
}

async function sync() {
  if (!client || syncing || syncPaused) return syncing;
  const activeGeneration = generation;
  const controller = new AbortController();
  syncController = controller;
  $('sync').disabled = true;
  $('pause-sync').hidden = false;
  syncing = performSync(controller.signal).catch((error) => {
    if (activeGeneration !== generation) return;
    $('sync-status').textContent = syncPaused ? 'Sync paused. Encrypted drafts stay on this browser. Select Resume sync to continue.' : 'Cloud unavailable. Encrypted drafts stay on this browser.';
    if (!syncPaused) message(errorText(error));
    render();
  }).finally(() => {
    if (syncController !== controller) return;
    syncing = undefined;
    syncController = undefined;
    $('sync').disabled = false;
    $('sync').textContent = syncPaused ? 'Resume sync' : 'Sync now';
    $('pause-sync').hidden = true;
    $('upload-progress').hidden = true;
    if (syncPaused && !$('workspace').hidden) $('sync').focus();
  });
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

// The slider steps through the minutes with a change; its last step is now.
function updateTimeline() {
  const range = $('timeline-range'), atNow = Number(range.value) >= Number(range.max);
  range.max = String(Math.max(moments.size - 1, 0));
  if (atNow) range.value = range.max;
}

const momentSteps = () => [...moments.values()].sort();

async function showMoment() {
  const steps = momentSteps(), index = Number($('timeline-range').value), request = ++momentRequest, activeClient = client;
  if (index >= steps.length - 1) {
    moment = undefined;
    $('timeline-moment').textContent = 'Now';
    $('timeline-restore').hidden = true;
    render();
    return;
  }
  const at = steps[index];
  $('timeline-moment').textContent = `Opening ${new Date(at).toLocaleString()}...`;
  const { objects } = await activeClient.snapshot(at);
  const shown = new Map(), unread = [];
  let locked = 0, cleared = 0;
  for (const object of objects) {
    const current = files.get(object.id);
    if (current && !current.pending && current.revision === object.revision) shown.set(object.id, current);
    else if (object.cleared) cleared++;
    else if (object.locked) locked++;
    else unread.push(object);
  }
  // A few at a time: the server serves a limited number of requests at once.
  for (let start = 0; start < unread.length; start += 8) {
    if (request !== momentRequest) return;
    for (const entry of await Promise.all(unread.slice(start, start + 8).map((object) => activeClient.read(object.id, object.revision)))) shown.set(entry.id, entry);
  }
  if (request !== momentRequest || activeClient !== client) return;
  // A moment comes back whole or not at all.
  moment = { at, objects, files: shown, locked: locked + cleared };
  $('timeline-moment').textContent = `${new Date(at).toLocaleString()}. Read-only.${locked ? ` ${locked} file(s) from then changed more than 30 days ago. JotDrop Plus shows and restores them.` : ''}${cleared ? ` ${cleared} file(s) from then were cleared to make room in the free storage, so this moment cannot be restored.` : ''}`;
  $('timeline-restore').hidden = false;
  $('timeline-restore').disabled = locked + cleared > 0;
  render();
}

function closeMoment() {
  momentRequest++;
  moment = undefined;
  $('timeline').hidden = true;
  $('time-machine').setAttribute('aria-expanded', 'false');
  render();
}

// Every change is a new version: files come back, files made later move to the trash, and nothing is erased.
async function restoreMoment() {
  const target = moment;
  if (!target || target.locked) return;
  const when = new Date(target.at).toLocaleString();
  if (!confirm(`Restore your notes and files to ${when}? Files made after that move to the trash. Every change is a new version, so the time machine can undo this.`)) return;
  // Compare against the newest cloud versions.
  await sync();
  if ([...files.values()].some((entry) => entry.pending || entry.conflict)) throw new Error('Sync and resolve your changes before restoring a moment.');
  const then = new Map(target.objects.map((object) => [object.id, object]));
  let changed = 0;
  try {
    for (const entry of [...files.values()]) {
      const object = then.get(entry.id);
      if (object?.revision === entry.revision) continue;
      if (!object || object.deleted) {
        if (!entry.deleted) { await client.remove(entry.id, entry.revision); changed++; }
      } else { await client.restore(entry.id, object.revision, entry.revision); changed++; }
    }
  } finally {
    // Also after an error: show what did change.
    closeMoment();
    cursor = 0;
    await sync();
  }
  message(`Restored ${changed} file(s) to ${when}.`);
}

async function reviewConflict(entry) {
  const remote = await client.read(entry.id);
  download(base64ToBytes(entry.file.content), `local-draft-${entry.file.path.split('/').pop()}`);
  if (!confirm(`Your local draft has been downloaded. Keep the cloud version of "${remote.file.path}" in this workspace? Select Cancel to keep both unresolved.`)) return;
  const uploadKey = `${pendingPrefix()}${entry.id}`.replace('pending:', 'upload:');
  const uploading = await store('get', uploadKey);
  if (uploading && !uploading.deleted) await client.discardWrite(uploading.prepared);
  await cacheEntry(remote);
  await store('delete', [`${pendingPrefix()}${entry.id}`, uploadKey]);
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
  syncController?.abort();
  if (syncing) await syncing;
  client = connected;
  syncPaused = false;
  $('sync').textContent = 'Sync now';
  generation++;
  cursor = 0;
  files.clear();
  moments.clear();
  closeMoment();
  $('access').hidden = true;
  $('workspace').hidden = false;
  $('access-code').value = '';
  $('new-password').value = '';
  $('confirm-password').value = '';
  $('unlock-password').value = '';
  await loadLocal();
  render();
  // Back from the Stripe payment page.
  if (new URLSearchParams(location.search).get('plus') === 'welcome') {
    history.replaceState(null, '', '/');
    message('Thank you. JotDrop Plus turns on as soon as Stripe confirms your payment.');
  }
  await sync();
}

// A browser that is not remembered signs in as a new device next time, so it gives its device slot back when it closes.
let forgetOnClose = false;
function releaseDevice() {
  if (!client || !forgetOnClose) return;
  forgetOnClose = false;
  const c = client.credentials;
  void fetch(`${c.url}/api/v1/devices/${c.deviceId}`, { method: 'DELETE', keepalive: true, headers: { Authorization: `Bearer ${c.token}`, 'X-JotDrop-Vault': c.vaultId, 'X-JotDrop-Device': c.deviceId } }).catch(() => {});
}
// A page kept for the back button can come back, so it keeps its device.
window.addEventListener('pagehide', (event) => { if (!event.persisted) releaseDevice(); });

function lock() {
  if (voiceJob && !confirm('Discard the current recording and lock?')) return;
  releaseDevice();
  discardVoice();
  resetPhoto();
  syncController?.abort();
  generation++;
  client = undefined;
  files.clear();
  moments.clear();
  closeMoment();
  editing = undefined;
  for (const url of mediaUrls) URL.revokeObjectURL(url);
  mediaUrls.clear();
  $('items').replaceChildren();
  $('device-list').replaceChildren();
  $('note-content').value = '';
  $('pair-code').value = '';
  $('recovery-code').value = '';
  $('editor').close();
  message();
  attaching = undefined;
  $('totp-enable').hidden = true;
  $('totp-secret').value = '';
  $('workspace').hidden = true;
  $('access').hidden = false;
  void store('get', 'connection').then((saved) => (saved ? showUnlock() : showAccess('login-form')), () => showAccess('login-form'));
}

const DEVICE_NAME = 'Web browser';
let codeStep;
let reset;
let attaching;
let totpOn = false;
let approvalRun = 0;
const accessError = (error) => error?.message || 'Something went wrong. Try again.';
// Account forms report the server's own reason (wrong password, wrong code), except a revoked device.
const accountError = (error) => (error?.message && error.message !== 'Device access denied' ? error.message : errorText(error));

function showAccess(id) {
  approvalRun++;
  for (const element of document.querySelectorAll('[data-access]')) element.hidden = element.id !== id;
  $('unlock-form').hidden = true;
  $('device-limit').hidden = true;
  $('access-message').textContent = '';
  $(id).querySelector('input:not([type="checkbox"]):not([type="radio"]), select, textarea')?.focus();
}

function showUnlock() {
  for (const element of document.querySelectorAll('[data-access]')) element.hidden = true;
  $('unlock-form').hidden = false;
  $('unlock-password').focus();
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-show]');
  if (target) showAccess(target.dataset.show);
});

// A remembered browser keeps the connection sealed with the account password, like a device unlock passphrase.
async function finishAccess(connected, { password, remember, recoveryCode }) {
  if (remember) await store('put', 'connection', await sealLocal(connected.credentials, password));
  else await store('delete', 'connection');
  forgetOnClose = !remember;
  codeStep = undefined;
  for (const input of $('access').querySelectorAll('input[type="password"], input[inputmode="numeric"], textarea')) input.value = '';
  $('access-message').textContent = '';
  await openWorkspace(connected);
  if (recoveryCode) showRecoveryCode(recoveryCode);
}

function showRecoveryCode(code, finishLabel = 'Open workspace') {
  $('recovery-code').value = code;
  $('recovery-saved').checked = false;
  $('finish-recovery').disabled = true;
  $('finish-recovery').textContent = finishLabel;
  $('recovery-dialog').showModal();
}

function accessForm(id, action) {
  $(id).addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    $('access-message').textContent = 'Working securely on this device...';
    try { await action(); }
    catch (error) { $('access-message').textContent = accessError(error); }
    finally { submit.disabled = false; }
  });
}

// At the free device limit this browser takes the place of a device the person no longer uses.
// `connect(replaceDeviceId)` repeats the sign-in; the server kept the code, so it still works.
async function withDeviceChoice(connect) {
  try { await connect(undefined); }
  catch (error) {
    if (error.code !== 'device-limit') throw error;
    const box = $('device-limit');
    box.replaceChildren(paragraph(`${error.message} Choose the device this browser replaces:`));
    for (const device of error.devices) {
      const choice = button(`Sign out ${device.name} (last used ${new Date(device.lastSeenAt).toLocaleDateString()})`, async () => {
        choice.disabled = true;
        try { await connect(device.id); box.hidden = true; }
        catch (failure) { $('access-message').textContent = accessError(failure); }
        finally { choice.disabled = false; }
      });
      box.append(choice);
    }
    box.hidden = false;
    $('access-message').textContent = '';
  }
}

function askCode(kind, pending, password, remember) {
  codeStep = { kind, pending, password, remember };
  $('code-label').textContent = pending.secondFactor === 'totp' ? 'Enter the 6-digit code from your authenticator app' : 'Enter the 6-digit code we emailed to you';
  showAccess('code-form');
}

accessForm('login-form', async () => {
  const password = $('login-password').value;
  askCode('login', await logIn({ url: location.origin, email: $('login-email').value.trim(), password, deviceName: DEVICE_NAME }), password, $('login-remember').checked);
});
accessForm('signup-form', async () => {
  const password = $('signup-password').value;
  if (password !== $('signup-confirm').value) throw new Error('The passwords do not match.');
  askCode('signup', await signUp({ url: location.origin, email: $('signup-email').value.trim(), password, deviceName: DEVICE_NAME }), password, $('signup-remember').checked);
});
accessForm('code-form', async () => {
  const step = codeStep, code = $('code-input').value.trim();
  if (!step) throw new Error('Start again from the log in screen.');
  if (step.kind === 'login') await withDeviceChoice(async (replaceDeviceId) => finishAccess(await confirmLogin(step.pending, code, { replaceDeviceId }), step));
  else {
    const { client: connected, recoveryCode } = await confirmSignup(step.pending, code);
    await finishAccess(connected, { ...step, recoveryCode });
  }
});
accessForm('forgot-form', async () => {
  reset = await startReset({ url: location.origin, email: $('forgot-email').value.trim() });
  showAccess('reset-form');
  $('access-message').textContent = 'If this address has an account, we emailed it a code.';
});

const resetRoute = () => document.querySelector('input[name="reset-route"]:checked').value;
for (const radio of document.querySelectorAll('input[name="reset-route"]')) radio.addEventListener('change', () => {
  $('reset-recovery').hidden = resetRoute() !== 'recover';
  $('reset-restart').hidden = resetRoute() !== 'restart';
});
accessForm('reset-form', async () => {
  const newPassword = $('reset-password').value, remember = $('reset-remember').checked, code = $('reset-code').value.trim(), options = { newPassword, deviceName: DEVICE_NAME };
  if (newPassword !== $('reset-confirm').value) throw new Error('The passwords do not match.');
  if (resetRoute() === 'recover') {
    const recoveryCode = $('reset-recovery-code').value.trim();
    await withDeviceChoice(async (replaceDeviceId) => finishAccess(await resetWithRecoveryCode(reset, { ...options, code, recoveryCode, replaceDeviceId }), { password: newPassword, remember }));
  } else if (resetRoute() === 'restart') {
    if (!$('reset-restart-confirm').checked) throw new Error('Tick the box to confirm deleting the old cloud data.');
    const { client: connected, recoveryCode } = await startOver(reset, { ...options, code });
    await finishAccess(connected, { password: newPassword, remember, recoveryCode });
  } else {
    const pending = await requestApproval(reset, code);
    showAccess('approval-wait');
    const run = approvalRun;
    $('approval-words').textContent = pending.words.join('  ');
    $('approval-status').textContent = 'Waiting for approval...';
    const poll = async () => {
      if (run !== approvalRun) return;
      try {
        const approved = await checkApproval(pending);
        if (run !== approvalRun) return;
        if (!approved) { setTimeout(poll, 3000); return; }
        $('approval-status').textContent = 'Approved. Setting your new password...';
        await withDeviceChoice(async (replaceDeviceId) => finishAccess(await completeApproval(approved, { ...options, replaceDeviceId }), { password: newPassword, remember }));
      } catch (error) { $('approval-status').textContent = error?.status === 401 ? 'The request was rejected or has expired. Go back and start again.' : accessError(error); }
    };
    setTimeout(poll, 3000);
  }
});
$('cancel-approval').addEventListener('click', () => showAccess('login-form'));

async function renderApprovals() {
  let approvals = [];
  try { approvals = await listApprovals(client); } catch (error) { if (error.status !== 404) throw error; }
  $('approval-requests').replaceChildren(...approvals.map((approval) => {
    const row = document.createElement('div');
    row.className = 'device-row';
    const words = approval.words.join(' ');
    row.append(paragraph(`A new device asks for access to your notes. Approve only if it shows exactly these words: ${words}`));
    row.append(button('Approve', async () => {
      if (!confirm(`Does the new device show exactly these words?\n\n${words}`)) return;
      await approveDevice(client, approval);
      message('Approved. The new device can now set a new password.');
      await renderApprovals();
    }, 'primary'));
    row.append(button('Reject', async () => { await rejectDevice(client, approval.id); await renderApprovals(); }, 'danger'));
    return row;
  }));
  return approvals.length;
}

async function renderAccount() {
  let account;
  try { account = await accountInfo(client); } catch (error) { if (error.status !== 404) throw error; }
  $('account-status').textContent = account ? `Logged in as ${account.email}.` : 'This cloud has no account yet. New devices connect with a pairing code or your recovery code.';
  $('attach-form').hidden = Boolean(account || attaching);
  $('attach-code-form').hidden = Boolean(account || !attaching);
  $('password-form').hidden = !account;
  $('totp-form').hidden = !account;
  $('new-recovery-password-row').hidden = !account;
  $('new-recovery-password').required = Boolean(account);
  if (account) {
    totpOn = account.totp;
    $('totp-status').textContent = account.totp ? 'On: a new device asks for a code from your app.' : 'Off: a new device asks for a code by email.';
    $('totp-setup').hidden = account.totp;
    $('totp-submit').hidden = !account.totp && $('totp-enable').hidden;
    $('totp-submit').textContent = account.totp ? 'Turn off' : 'Turn on';
  }
  await renderApprovals();
}

function workspaceForm(id, action) {
  $(id).addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    try { await action(); }
    catch (error) { message(accountError(error)); }
    finally { submit.disabled = false; }
  });
}

workspaceForm('attach-form', async () => {
  const password = $('attach-password').value;
  if (password !== $('attach-confirm').value) throw new Error('The passwords do not match.');
  attaching = await attachAccount(client, { email: $('attach-email').value.trim(), password });
  $('attach-password').value = $('attach-confirm').value = '';
  message('We emailed you a code to confirm the address.');
  await renderAccount();
});
workspaceForm('attach-code-form', async () => {
  await confirmSignup(attaching, $('attach-code').value.trim());
  attaching = undefined;
  $('attach-code').value = '';
  message('Account created. You can now log in with your email and password in any browser.');
  await renderAccount();
});
workspaceForm('password-form', async () => {
  const newPassword = $('password-new').value;
  if (newPassword !== $('password-confirm').value) throw new Error('The new passwords do not match.');
  await changePassword(client, { currentPassword: $('password-current').value, newPassword, signOutOtherDevices: $('password-sign-out').checked });
  // A remembered browser would otherwise keep unlocking with the old password.
  if (await store('get', 'connection')) await store('put', 'connection', await sealLocal(client.credentials, newPassword));
  for (const id of ['password-current', 'password-new', 'password-confirm']) $(id).value = '';
  message('Password changed. Your notes did not need to be encrypted again.');
  await renderDevices();
});
workspaceForm('new-recovery-form', async () => {
  const field = $('new-recovery-password');
  const code = await newRecoveryCode(client, field.required ? { password: field.value } : {});
  field.value = '';
  message('New recovery code made. The old code no longer works.');
  showRecoveryCode(code, 'Done');
});
$('totp-setup').addEventListener('click', () => setupTotp(client).then(({ secret }) => {
  $('totp-secret').value = secret;
  $('totp-enable').hidden = false;
  $('totp-setup').hidden = true;
  $('totp-submit').hidden = false;
  $('totp-code').focus();
}, (error) => message(accountError(error))));
workspaceForm('totp-form', async () => {
  const password = $('totp-password').value;
  if (totpOn) await disableTotp(client, { password });
  else await enableTotp(client, { password, code: $('totp-code').value.trim() });
  message(totpOn ? 'Authenticator app turned off. New devices get a code by email.' : 'Authenticator app turned on.');
  for (const id of ['totp-password', 'totp-code', 'totp-secret']) $(id).value = '';
  $('totp-enable').hidden = true;
  await renderAccount();
});

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
    const keepDrafts = async (vaultId) => !(await store('entries', `pending:${vaultId}:`)).length || confirm('This workspace has encrypted drafts on this browser. Continue and sync them using the new device connection?');
    const open = async (connected, recoveryCode, asked = false) => {
      const sealed = await sealLocal(connected.credentials, password);
      if (!asked && !await keepDrafts(connected.credentials.vaultId)) return;
      await store('put', 'connection', sealed);
      $('access-message').textContent = '';
      await openWorkspace(connected);
      if (recoveryCode) showRecoveryCode(recoveryCode);
    };
    if (method === 'create') { const created = await CloudClient.create({ ...options, enrollmentToken: code }); await open(created.client, created.recoveryCode); }
    else if (method === 'pair') await open(await CloudClient.claim({ pairingCode: code }));
    // Ask about drafts first: recovering can sign out another device, which a cancel here must not waste.
    else if (await keepDrafts(decodeRecovery(code).vaultId)) await withDeviceChoice(async (replaceDeviceId) => open(await CloudClient.recover({ ...options, recoveryCode: code, replaceDeviceId }), undefined, true));
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
  showAccess('login-form');
  $('access-message').textContent = 'Existing encrypted drafts are kept. Connect the original device again to sync them.';
});
$('lock').addEventListener('click', lock);
$('start-trial').addEventListener('click', async () => {
  try {
    await client.call('/account/trial', 'POST', {});
    message('JotDrop Plus is on for 14 days. No payment details needed.');
    await sync();
  } catch (error) { message(errorText(error)); }
});
// Stripe shows the payment page and is the seller; Plus turns on when Stripe confirms the payment to the server.
for (const [id, interval] of [['buy-month', 'month'], ['buy-year', 'year']]) $(id).addEventListener('click', async () => {
  try { location.assign((await client.call('/account/checkout', 'POST', { interval })).url); }
  catch (error) { message(errorText(error)); }
});
$('sync').addEventListener('click', () => { syncPaused = false; $('sync').textContent = 'Sync now'; message(); void sync(); });
$('pause-sync').addEventListener('click', () => { syncPaused = true; syncController?.abort(); });
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
      if (version.locked) {
        row.classList.add('locked');
        row.append(paragraph('Replaced more than 30 days ago. JotDrop Plus restores it.'));
        $('history-list').append(row);
        continue;
      }
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
$('time-machine').addEventListener('click', () => {
  if (!$('timeline').hidden) { closeMoment(); return; }
  updateTimeline();
  $('timeline-range').value = $('timeline-range').max;
  $('timeline-moment').textContent = moments.size > 1 ? 'Now' : 'Now. Earlier moments appear here after your next changes.';
  $('timeline-restore').hidden = true;
  $('timeline').hidden = false;
  $('time-machine').setAttribute('aria-expanded', 'true');
  $('timeline-range').focus();
});
$('timeline-range').addEventListener('input', () => {
  const steps = momentSteps(), index = Number($('timeline-range').value);
  $('timeline-moment').textContent = index >= steps.length - 1 ? 'Now' : new Date(steps[index]).toLocaleString();
});
$('timeline-range').addEventListener('change', () => showMoment().catch((error) => message(errorText(error))));
$('timeline-close').addEventListener('click', closeMoment);
$('timeline-restore').addEventListener('click', () => restoreMoment().catch((error) => message(errorText(error))));
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
$('import-notes').addEventListener('change', async () => {
  const picked = [...$('import-notes').files];
  $('import-notes').value = '';
  if (!picked.length) return;
  try {
    const { readImport } = await import('/import.mjs');
    const result = await readImport(picked);
    if (!result.items.length) { message(result.error ? `Import failed: ${result.error}` : 'No notes found. Choose a Google Takeout zip, Evernote .enex files, or Markdown files from Apple Notes or another app.'); return; }
    const source = { keep: 'Google Keep', evernote: 'Evernote', markdown: 'Markdown files' }[result.kind];
    const attachments = new Set(result.items.flatMap((item) => item.attachments)).size;
    if (!confirm(`Import ${result.items.length} notes with ${attachments} attachments from ${source}? Existing notes are never overwritten.`
      + (result.skipped ? ` ${result.skipped} notes in the Keep trash are left out.` : '') + (result.missing ? ` ${result.missing} attachments are not in the export.` : ''))) return;
    await writeImport(result);
  } catch (error) { message(errorText(error)); }
});

/** Like the plugin: a note whose name exists in Notes or Archive counts as imported before; nothing is overwritten. */
async function writeImport({ items, files: sources, failed: unreadable }) {
  const find = (path) => [...files.values()].find((entry) => entry.file.path === path);
  const live = (path) => { const entry = find(path); return entry && !entry.deleted ? entry : undefined; };
  // A deleted file at that path gets a new version on top of the deleted one.
  const save = (path, bytes, modifiedAt) => queueFile(path, bytes, find(path)?.deleted ? find(path).revision : undefined, modifiedAt);
  const names = new Map(), broken = new Set(), written = new Set();
  let imported = 0, existing = 0, failed = unreadable, tooLarge = 0;
  for (const [index, item] of items.entries()) {
    if (index % 25 === 0) message(`Importing notes: ${index} of ${items.length}`);
    try {
      const exists = (name) => live(`notes/${name}`) || live(`notes/Archive/${name}`);
      let name = item.name;
      if (written.has(name)) {
        // Two notes with the same stamp and title in one export: the next gets a number.
        const stem = name.replace(/\.md$/, '');
        for (let n = 2; written.has(name) || exists(name); n++) name = `${stem} ${n}.md`;
      } else if (exists(name)) { existing += 1; continue; }
      for (const source of item.attachments) {
        if (names.has(source) || broken.has(source)) continue;
        try {
          const bytes = await sources.get(source)();
          if (bytes.length > 4 * 1024 * 1024) { tooLarge += 1; broken.add(source); continue; }
          // `[ ] | # ^` would break the ![[…]] embed; same name and bytes reuse the file, otherwise the next number.
          const base = source.slice(source.lastIndexOf('/') + 1).replace(/[[\]|#^]/g, '_');
          const dot = base.lastIndexOf('.') > 0 ? base.lastIndexOf('.') : base.length;
          for (let n = 1; ; n++) {
            const file = n === 1 ? base : `${base.slice(0, dot)} ${n}${base.slice(dot)}`;
            const current = live(`attachments/${file}`);
            if (current && current.file.content !== bytesToBase64(bytes)) continue;
            if (!current) await save(`attachments/${file}`, bytes, new Date(item.editedMs).toISOString());
            names.set(source, file);
            break;
          }
        } catch (error) { console.error('Could not import attachment', source, error); broken.add(source); }
      }
      await save(`notes/${item.archived ? 'Archive/' : ''}${name}`, encoder.encode(item.render(names)), new Date(item.editedMs).toISOString());
      written.add(item.name).add(name);
      imported += 1;
    } catch (error) { console.error('Could not import', item.name, error); failed += 1; }
  }
  message(`Import: ${imported} imported, ${existing} already there, ${failed} could not be imported.`
    + (broken.size ? ` ${broken.size} attachments could not be added${tooLarge ? ` (${tooLarge} over 4 MiB)` : ''}.` : ''));
  await sync();
  void sync();
}
for (const navigation of document.querySelectorAll('[data-view]')) navigation.addEventListener('click', () => {
  view = navigation.dataset.view;
  for (const item of document.querySelectorAll('[data-view]')) item.removeAttribute('aria-current');
  navigation.setAttribute('aria-current', 'page');
  message();
  render();
  if (view === 'devices') void Promise.all([renderDevices(), renderAccount()]).catch((error) => message(errorText(error)));
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
window.addEventListener('pagehide', () => { syncController?.abort(); resetPhoto(); discardVoice(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopCamera(); if (voiceJob?.recorder?.state === 'recording') voiceJob.recorder.stop(); } });
window.addEventListener('beforeunload', (event) => {
  const unsaved = $('editor').open && (voiceJob || $('note-content').value !== (editing ? noteText(editing.file) : '# Untitled\n\n'));
  if (unsaved) { event.preventDefault(); event.returnValue = ''; }
});
setInterval(() => {
  if (!client || document.hidden) return;
  void sync();
  // Someone who forgot their password waits for this device to approve.
  void listApprovals(client).then((approvals) => {
    if (!approvals.length) return;
    if (view === 'devices') void renderApprovals();
    else message('A new device asks for access to your notes. Open Devices & recovery to approve or reject it.');
  }, () => {});
}, 30000);
try {
  if (await store('get', 'connection')) showUnlock();
} catch (error) { $('access-message').textContent = errorText(error); $('connect-form').querySelector('button[type="submit"]').disabled = true; }

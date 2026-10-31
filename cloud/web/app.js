import { CloudClient } from '/shared/client.mjs';
import { accountInfo, approveDevice, attachAccount, availableProviders, changePassword, checkApproval, completeApproval, confirmLogin, confirmSignup, deleteAccount, disableTotp, enableTotp, listApprovals, logIn, newRecoveryCode, personCheckKey, providerApproval, providerRecover, providerSignUp, providerTicket, rejectDevice, requestApproval, resetWithRecoveryCode, setupTotp, signUp, startOver, startProviderSignIn, startReset } from '/shared/account.mjs';
import { base64ToBytes, bytesToBase64, decodeRecovery, decryptEnvelope, encryptEnvelope, isSpacePath, objectId, sealLocal, unsealLocal } from '/shared/crypto.mjs';
import { exportZip } from '/export.mjs';
import { noteSummary, updateMetadata, toggleTask, attachmentPath, plainPreviewText, splitNote, joinNote, noteFilename, manualRank, betweenRank, noteUrls, urlHost, reminderBadge, repeatLabel, changedAgo } from '/note.mjs';

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
// One photo or recording element per card and file, kept across renders: a photo never reloads, so its card never shrinks.
const media = new Map();
const shownMedia = new Set();
// A change that syncs within this time never shows as waiting, so a tick does not reshape its card twice.
const QUIET_PENDING_MS = 3000;
// Playful details from design A (Eric, 27 Oct). A note you just created drops onto the board and gets a "Sealed" stamp
// once the cloud holds it; a pin you just pressed wiggles and a task you just ticked is struck through with a pen.
// Cards are rebuilt on every render, so these remember what just happened until the rebuilt card shows it.
const FRESH_MS = 60_000;
const STAMP_MS = 1800;
const freshNotes = new Map();
const stamps = new Map();
let justPinned;
let justStruck;
let client;
let view = 'notes';
let labelFilter = '';
let localLabels = [];
const selectedTags = new Set();
const selectedIds = new Set();
let selectableIds = new Set();
let editing;
let editingRevision;
let syncing;
let syncController;
let syncPaused = false;
let cursor = 0;
// The plan's maximum per file, from the cloud status; 4 MiB until it is known.
let maxFileBytes = 4 * 1024 * 1024;
const maxFileText = () => `${Math.round(maxFileBytes / 1048576)} MB`;
let generation = 0;
let cameraStream;
let cameraRequest = 0;
let photoJob;
let voiceJob;
// The time machine: `moment` holds the files as they were while an earlier moment is shown.
let moment;
// Card order of the notes shown, for previous/next in the editor.
let navOrder = [];
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
// What this browser keeps of a file: all of it, encrypted with the workspace key. The cloud gets a manifest and pieces.
async function sealFile(path, bytes, revision, modifiedAt = new Date().toISOString()) {
  const id = await objectId(client.credentials.vaultKey, path);
  return { id, baseRevision: revision, envelope: JSON.stringify(await encryptEnvelope(client.credentials.vaultKey, { path, content: bytesToBase64(bytes), modifiedAt }, aad(id))) };
}
// Plus is offered where a free limit is in the way, not as a standing button: at the start nobody notices
// the difference, and the trial works once per account (Eric, 27 Oct). The error says what happened, the offer what helps.
const filePlus = 'JotDrop Plus takes files up to 200 MB.';
let currentPlan, storageShare = 0, plusReason = '', plusQuiet = false;
function plusChoice() {
  if (!currentPlan || currentPlan.name === 'plus') return undefined;
  if (currentPlan.trialAvailable) return 'trial';
  return currentPlan.checkout && !currentPlan.subscribed ? 'buy' : undefined;
}
function showPlusNudge() {
  const nearlyFull = !plusQuiet && storageShare >= .8 ? `Your cloud storage is ${Math.round(storageShare * 100)}% full. JotDrop Plus has 10 GB.` : '';
  const reason = plusReason || nearlyFull, choice = plusChoice();
  $('plus-nudge').hidden = !reason || !choice;
  $('plus-reason').textContent = reason;
  $('start-trial').hidden = choice !== 'trial';
  $('get-plus').hidden = choice !== 'buy';
}
function offerPlus(reason) { plusReason = reason; showPlusNudge(); }
function fileTooLarge(text) { offerPlus(filePlus); return new Error(text); }
const errorText = (error) => {
  if (error?.code === 'storage-full') offerPlus('JotDrop Plus has 10 GB of cloud storage.');
  else if (error?.code === 'plus-required') offerPlus(error.status === 413 ? filePlus : 'JotDrop Plus keeps every version and deleted note.');
  return errorMessage(error);
};
const errorMessage = (error) => error?.status === 401 ?'This device no longer has access. Lock the workspace and reconnect using another device or your recovery code.' : error?.message || 'The operation failed. Your local files have not been changed.';
const message = (text = '') => { $('workspace-message').textContent = text; };

function button(text, action, className) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = text;
  if (className) element.className = className;
  element.addEventListener('click', () => Promise.resolve().then(action).catch((error) => message(errorText(error))));
  return element;
}

// Lucide icons (ISC licence), the same set as the plugin's buttons.
const icons = {
  pin: '<path d="M12 17v5"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.56-2.5 5.56-5.55C21.97 6.01 17.46 2 12 2z"/>',
  tag: '<path d="M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r="1"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  pencil: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/>',
  more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
};

// A paper card sits a little askew, always at the same angle for the same note.
const tiltAngles = [-0.6, -0.35, 0.3, 0.5, -0.15, 0.2];
function tiltFor(path) {
  let hash = 0;
  for (const char of path) hash = (hash * 31 + char.codePointAt(0)) | 0;
  return `${tiltAngles[Math.abs(hash) % tiltAngles.length]}deg`;
}
const strikeLine = '<svg class="strike" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><path pathLength="1" d="M1 6 C 18 2, 30 8, 50 5 S 82 3, 99 6"/></svg>';

function sealedStamp(elapsed) {
  const stamp = document.createElement('span');
  stamp.className = 'card-stamp';
  stamp.setAttribute('aria-hidden', 'true');
  stamp.innerHTML = `<svg viewBox="0 0 24 24">${icons.lock}</svg>Sealed`;
  stamp.style.animationDelay = `-${elapsed}ms`;
  stamp.addEventListener('animationend', () => stamp.remove());
  return stamp;
}

function iconButton(icon, label, action, className = '') {
  const element = button('', action, `icon-button ${className}`.trim());
  element.setAttribute('aria-label', label);
  element.title = label;
  element.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[icon]}</svg>`;
  return element;
}

// One small popup menu at a time, closed by Escape, an outside click or a choice.
let openMenu;
function closeMenu() {
  if (!openMenu) return;
  const { menu, anchor, onKey, onPointer } = openMenu;
  openMenu = undefined;
  menu.remove();
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('pointerdown', onPointer, true);
  if (anchor.isConnected) anchor.focus();
}

function showMenu(anchor, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'card-menu';
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.setAttribute('role', item.checked === undefined ? 'menuitem' : item.radio ? 'menuitemradio' : 'menuitemcheckbox');
    if (item.checked !== undefined) entry.setAttribute('aria-checked', String(item.checked));
    if (item.swatch) { const swatch = document.createElement('span'); swatch.className = `swatch note-${item.swatch}`; entry.append(swatch); }
    entry.append(item.label);
    if (item.checked) { const mark = document.createElement('span'); mark.className = 'menu-check'; mark.textContent = '✓'; mark.setAttribute('aria-hidden', 'true'); entry.append(mark); }
    entry.addEventListener('click', () => { closeMenu(); Promise.resolve().then(item.action).catch((error) => message(errorText(error))); });
    menu.append(entry);
  }
  // Inside an open dialog the menu must live in the dialog, or the modal hides it.
  (anchor.closest('dialog') || document.body).append(menu);
  const box = anchor.getBoundingClientRect(), size = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(box.left, innerWidth - size.width - 8))}px`;
  menu.style.top = `${box.bottom + size.height + 8 <= innerHeight ? box.bottom + 4 : Math.max(8, box.top - size.height - 4)}px`;
  const onKey = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); }
    else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      const entries = [...menu.children], index = entries.indexOf(document.activeElement);
      entries[(index + (event.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length].focus();
      event.preventDefault();
    }
  };
  const onPointer = (event) => { if (!menu.contains(event.target) && !anchor.contains(event.target)) closeMenu(); };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointer, true);
  openMenu = { menu, anchor, onKey, onPointer };
  menu.firstChild?.focus();
}

const colorNames = [['default', 'Default'], ['red', 'Red'], ['orange', 'Orange'], ['yellow', 'Yellow'], ['green', 'Cream'], ['teal', 'Slate blue'], ['blue', 'Blue'], ['purple', 'Purple'], ['pink', 'Pink'], ['brown', 'Brown'], ['gray', 'Gray']];

// Draws the server's QR rows ("1" = dark) as one SVG path, with the quiet zone scanners need.
function qrCode(rows) {
  const svgNs = 'http://www.w3.org/2000/svg', size = rows.length + 8, svg = document.createElementNS(svgNs, 'svg'), path = document.createElementNS(svgNs, 'path');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code for your authenticator app');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const background = document.createElementNS(svgNs, 'rect');
  background.setAttribute('width', size);
  background.setAttribute('height', size);
  background.setAttribute('fill', '#fff');
  path.setAttribute('d', rows.flatMap((row, y) => [...row].map((dark, x) => (dark === '1' ? `M${x + 4} ${y + 4}h1v1h-1z` : ''))).join(''));
  path.setAttribute('fill', '#000');
  svg.append(background, path);
  return svg;
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
function noteTags(entry) {
  const parts = noteParts(noteText(entry.file), entry.file.path);
  return [...parts.tags, ...parts.inlineTags];
}

// Like the plugin and Android: the most used #tags as filter chips, the rest under "+N more";
// a note shows when it has any chosen tag. A chosen chip carries a ✓, not only a colour.
function renderTagFilter(tagCounts) {
  const bar = $('tag-filter');
  const toggle = (key) => { if (!selectedTags.delete(key)) selectedTags.add(key); render(); };
  const top = [...tagCounts].sort((a, b) => b[1].count - a[1].count || a[1].tag.localeCompare(b[1].tag)).slice(0, 8).map(([key]) => key);
  const shown = [...top, ...[...selectedTags].filter((key) => !top.includes(key)).sort()];
  bar.replaceChildren(...shown.map((key) => {
    const chip = button(`#${tagCounts.get(key).tag}`, () => toggle(key), 'filter-chip');
    chip.setAttribute('aria-pressed', String(selectedTags.has(key)));
    if (selectedTags.has(key)) { const mark = document.createElement('span'); mark.textContent = '✓ '; mark.setAttribute('aria-hidden', 'true'); chip.prepend(mark); }
    return chip;
  }));
  if (tagCounts.size > shown.length) {
    const more = button(`+${tagCounts.size - shown.length} more`, () => showMenu(more, [...tagCounts].sort((a, b) => a[1].tag.localeCompare(b[1].tag))
      .map(([key, { tag, count }]) => ({ label: `#${tag} (${count})`, checked: selectedTags.has(key), action: () => toggle(key) }))), 'filter-chip');
    bar.append(more);
  }
  if (selectedTags.size) bar.append(button('Clear filter', () => { selectedTags.clear(); render(); }, 'filter-clear'));
  bar.hidden = !tagCounts.size;
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

// Like the plugin and Android: up to three links as chips with the site's name, the rest as "+N".
const LINK_CHIPS_VISIBLE = 3, CARD_CHIPS_VISIBLE = 4;
function appendLinkChips(card, urls, owner) {
  if (!urls.length) return;
  const row = document.createElement('div');
  row.className = 'link-chips';
  for (const url of urls.slice(0, LINK_CHIPS_VISIBLE)) {
    const chip = document.createElement('a');
    chip.className = 'link-chip';
    chip.href = url;
    chip.target = '_blank';
    chip.rel = 'noopener noreferrer';
    chip.title = url;
    chip.textContent = urlHost(url);
    // A chip opens its link, not the note; while selecting, it selects the card like the rest of it.
    chip.addEventListener('click', (event) => {
      if (selectedIds.size && selectableIds.has(owner)) event.preventDefault();
      else event.stopPropagation();
    });
    row.append(chip);
  }
  if (urls.length > LINK_CHIPS_VISIBLE) {
    const more = document.createElement('span');
    more.className = 'link-more';
    more.textContent = `+${urls.length - LINK_CHIPS_VISIBLE}`;
    more.title = 'More links in this note';
    row.append(more);
  }
  card.append(row);
}

function appendMedia(card, entry, owner, alt = '') {
  const type = mediaType(entry.file.path);
  if (!type || entry.deleted) return;
  const key = `${owner}\n${entry.id}`;
  let kept = media.get(key);
  if (kept?.entry !== entry || kept.alt !== alt) {
    if (kept) URL.revokeObjectURL(kept.url);
    const url = URL.createObjectURL(new Blob([base64ToBytes(entry.file.content)], { type }));
    const element = document.createElement(type.startsWith('image/') ? 'img' : 'audio');
    element.src = url;
    element.dataset.id = entry.id;
    if (element.tagName === 'IMG') { element.alt = alt || entry.file.path.split('/').pop(); element.loading = 'lazy'; }
    else { element.controls = true; element.preload = 'none'; element.setAttribute('aria-label', alt || entry.file.path.split('/').pop()); }
    kept = { entry, alt, url, element };
    media.set(key, kept);
  }
  shownMedia.add(key);
  card.append(kept.element);
}

// Photos and recordings no card shows any more let go of their memory.
function releaseMedia(all = false) {
  for (const [key, kept] of media) if (all || !shownMedia.has(key)) { URL.revokeObjectURL(kept.url); media.delete(key); }
  shownMedia.clear();
}

// The files a note links to that this cloud holds, once each, in the note's own order.
function noteAttachments(entry, parts, available) {
  const paths = available.map((item) => item.file.path), found = [];
  for (const target of parts.body.matchAll(/!\[\[([^\]]+)\]\]|!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const path = attachmentPath(target[1] || target[2], entry.file.path, paths);
    const attachment = available.find((item) => item.file.path === path);
    if (attachment && !found.includes(attachment)) found.push(attachment);
  }
  return found;
}

// Like the plugin's lightbox: a photo opens large, with its note and a download.
let photoShown;
function showPhoto(attachment, note) {
  if (photoShown) URL.revokeObjectURL(photoShown.url);
  const url = URL.createObjectURL(new Blob([base64ToBytes(attachment.file.content)], { type: mediaType(attachment.file.path) }));
  photoShown = { attachment, note, url };
  const name = attachment.file.path.split('/').pop();
  $('photo-title').textContent = name;
  $('photo-large').src = url;
  $('photo-large').alt = name;
  $('photo-open-note').hidden = !note || note.deleted || Boolean(moment) || $('editor').open;
  if (!$('photo-viewer').open) $('photo-viewer').showModal();
}
$('close-photo').addEventListener('click', () => $('photo-viewer').close());
$('photo-download').addEventListener('click', () => download(base64ToBytes(photoShown.attachment.file.content), photoShown.attachment.file.path));
$('photo-open-note').addEventListener('click', () => {
  const note = files.get(photoShown.note.id);
  $('photo-viewer').close();
  if (note && !note.deleted) openEditor(note);
});
$('photo-viewer').addEventListener('close', () => {
  $('photo-large').removeAttribute('src');
  if (photoShown) URL.revokeObjectURL(photoShown.url);
  photoShown = undefined;
});

// The editor shows the note's photos and recordings above the text, like the plugin; a photo opens large.
let editorMediaUrls = [];
function renderNoteMedia(entry) {
  for (const url of editorMediaUrls) URL.revokeObjectURL(url);
  editorMediaUrls = [];
  const strip = $('note-media');
  strip.replaceChildren();
  const markdown = Boolean(entry) && isMarkdown(entry.file.path);
  const available = markdown ? [...files.values()].filter((item) => !item.deleted && !isMarkdown(item.file.path)) : [];
  const shown = markdown ? noteAttachments(entry, noteParts(noteText(entry.file), entry.file.path), available).filter((item) => mediaType(item.file.path)) : [];
  for (const attachment of shown) {
    const type = mediaType(attachment.file.path), name = attachment.file.path.split('/').pop();
    const url = URL.createObjectURL(new Blob([base64ToBytes(attachment.file.content)], { type }));
    editorMediaUrls.push(url);
    if (type.startsWith('image/')) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'note-media-photo';
      open.setAttribute('aria-label', `Show photo ${name}`);
      const image = document.createElement('img');
      image.src = url;
      image.alt = '';
      open.append(image);
      open.addEventListener('click', () => showPhoto(attachment));
      strip.append(open);
    } else {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = url;
      audio.setAttribute('aria-label', name);
      strip.append(audio);
    }
  }
  strip.hidden = !shown.length;
}

// Masonry like Keep: each grid child spans as many 8px rows as its height needs, so
// short cards pack under each other while the DOM (and reading) order stays row-wise.
const gridSpans = new ResizeObserver((entries) => {
  // offsetHeight, not the bounding box: a tilted card is not taller, and straightening it on hover must not move it.
  for (const { target } of entries) target.style.gridRowEnd = `span ${Math.ceil((target.offsetHeight + 16) / 8)}`;
});

function render() {
  closeMenu();
  // Notes changed in two places stay in sight until a version is chosen.
  $('resolve-now').hidden = ![...files.values()].some((entry) => entry.conflict);
  // The rebuilt cards keep what the pointer, the keyboard and the grid had: a tick or a sync never blinks or reflows the screen.
  const shownCards = [...$('items').querySelectorAll('.note-card')];
  const hovered = shownCards.find((card) => card.matches(':hover, .is-hovered'))?.dataset.path;
  const focusedCard = document.activeElement?.closest('#items .note-card');
  const focused = focusedCard && { path: focusedCard.dataset.path, index: [...focusedCard.querySelectorAll('button, input, audio')].indexOf(document.activeElement) };
  const spans = new Map(shownCards.map((card) => [card.dataset.path, card.style.gridRowEnd]));
  let refocus;
  gridSpans.disconnect();
  $('items').replaceChildren();
  $('items').hidden = view === 'devices';
  $('devices-panel').hidden = view !== 'devices';
  $('tag-filter').hidden = true;
  $('selection-bar').hidden = true;
  const labelName = renderLabelList();
  const descriptions = {
    notes: labelFilter ? [labelName, 'Notes with this label.'] : ['Notes', 'psst, only you can read these'],
    archive: ['Archive', 'Kept notes, out of your everyday list.'],
    files: ['Files', 'Images, recordings, and the files you choose to keep.'],
    trash: ['Trash', 'Deleted files stay recoverable. Restoring adds a new cloud version.'],
    devices: ['Devices & recovery', 'You control which devices can access this workspace.'],
  };
  $('view-title').textContent = descriptions[view][0];
  $('view-description').textContent = descriptions[view][1];
  $('note-count').textContent = String([...files.values()].filter((entry) => !entry.deleted && isMarkdown(entry.file.path) && !isSpacePath(entry.file.path) && !/^notes\/(Archive|Trash)\//.test(entry.file.path)).length);
  if (view === 'devices') return releaseMedia();
  const source = moment ? moment.files : files;
  const query = $('search').value.toLowerCase().trim();
  const inView = (entry) => {
    if (isSpacePath(entry.file.path)) return false;
    if (view === 'trash' ? !entry.deleted && !entry.file.path.startsWith('notes/Trash/') : entry.deleted) return false;
    if (view === 'notes' && !isMarkdown(entry.file.path)) return false;
    if (view === 'archive' && (!isMarkdown(entry.file.path) || !entry.file.path.startsWith('notes/Archive/'))) return false;
    if (view === 'notes' && /^notes\/(Archive|Trash)\//.test(entry.file.path)) return false;
    return !(view === 'files' && isMarkdown(entry.file.path));
  };
  // Tags of the notes in this view; a chosen tag that no longer occurs stops filtering.
  const tagCounts = new Map();
  for (const entry of source.values()) if (inView(entry) && isMarkdown(entry.file.path)) for (const tag of noteTags(entry)) {
    const known = tagCounts.get(tag.toLowerCase());
    tagCounts.set(tag.toLowerCase(), { tag: known?.tag || tag, count: (known?.count || 0) + 1 });
  }
  for (const key of selectedTags) if (!tagCounts.has(key)) selectedTags.delete(key);
  renderTagFilter(tagCounts);
  const compare = (a, b) => {
    const left = isMarkdown(a.file.path) ? noteParts(noteText(a.file), a.file.path) : {};
    const right = isMarkdown(b.file.path) ? noteParts(noteText(b.file), b.file.path) : {};
    const pinned = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
    if (pinned) return pinned;
    if ($('sort').value === 'title') return (left.title || a.file.path).localeCompare(right.title || b.file.path);
    // Like the plugin and Android: a card keeps its place until it is dragged; the filename settles a tie.
    if ($('sort').value === 'manual') return manualRank(left.order, a.file.path) - manualRank(right.order, b.file.path) || a.file.path.split('/').pop().localeCompare(b.file.path.split('/').pop());
    const modified = String(b.file.modifiedAt).localeCompare(String(a.file.modifiedAt));
    return $('sort').value === 'oldest' ? -modified : modified;
  };
  const matching = [...source.values()].filter((entry) => {
    if (!inView(entry)) return false;
    if (selectedTags.size && !(isMarkdown(entry.file.path) && noteTags(entry).some((tag) => selectedTags.has(tag.toLowerCase())))) return false;
    if (labelFilter && (!isMarkdown(entry.file.path) || !noteParts(noteText(entry.file), entry.file.path).labels.some((label) => label.toLowerCase() === labelFilter))) return false;
    return !query || entry.file.path.toLowerCase().includes(query) || (isMarkdown(entry.file.path) && noteText(entry.file).toLowerCase().includes(query));
  }).sort(compare);
  // Dragging counts the notes a search or filter hides too, so clearing it never reshuffles them.
  const draggable = $('sort').value === 'manual' && !moment && (view === 'notes' || view === 'archive');
  const viewNotes = draggable ? [...source.values()].filter((entry) => inView(entry) && isMarkdown(entry.file.path)).sort(compare) : [];
  if (!matching.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const heading = document.createElement('h2');
    heading.textContent = query ? 'No matching files' : labelFilter ? 'No notes with this label yet' : view === 'trash' ? 'Nothing in the trash' : view === 'files' ? 'A place for your attachments' : 'Room for your next thought';
    empty.append(heading, paragraph(query ? 'Try a different word or filename.' : labelFilter ? 'Give a note this label with the label button on its card or in the editor.' : view === 'notes' ? 'Create a note or upload a Markdown file. Existing notes on your computer are never imported automatically.' : view === 'files' ? `Upload an image, recording, or document, up to ${maxFileText()} each.` : 'Files you move to trash will appear here.'));
    if (view === 'notes' && !query && !labelFilter) {
      const hint = document.createElement('p');
      hint.className = 'empty-hint';
      // A drawn arrow up to the New note button.
      hint.innerHTML = '<svg viewBox="0 0 64 44" aria-hidden="true"><path d="M58 38C40 40 20 32 12 8"/><path d="M5 17l7-9 8 8"/></svg>';
      hint.append('jot the first one with New note');
      empty.append(hint);
    }
    $('items').append(empty);
  }
  navOrder = matching.filter((entry) => !entry.deleted && isMarkdown(entry.file.path)).map((entry) => entry.id);
  // Like Keep: notes can be chosen together; a note that left this view is no longer chosen.
  selectableIds = new Set(moment || view === 'files' ? [] : matching.filter((entry) => isMarkdown(entry.file.path)).map((entry) => entry.id));
  for (const id of selectedIds) if (!selectableIds.has(id)) selectedIds.delete(id);
  renderSelectionBar();
  const sections = view === 'notes' && matching.some((entry) => isMarkdown(entry.file.path) && noteParts(noteText(entry.file), entry.file.path).pinned);
  let section;
  for (const entry of matching) {
    const card = document.createElement('article');
    const waiting = entry.pending && !(Date.now() - entry.queuedAt < QUIET_PENDING_MS);
    card.className = `note-card${waiting ? ' is-pending' : ''}`;
    const title = document.createElement('h3');
    const markdown = isMarkdown(entry.file.path);
    const parts = markdown ? noteParts(noteText(entry.file), entry.file.path) : { title: entry.file.path.split('/').pop() };
    if (markdown) card.classList.add(`note-${parts.color}`);
    if (markdown && parts.pinned) card.classList.add('is-pinned');
    card.style.setProperty('--tilt', tiltFor(entry.file.path));
    // Only the paper is askew: turned text goes soft, so the words on it stay straight and sharp.
    const paper = document.createElement('span');
    paper.className = 'card-paper';
    // The tape of a pinned note lies on top of everything, also over a cover photo, and turns with the paper.
    const tape = document.createElement('span');
    tape.className = 'card-tape';
    card.append(paper, tape);
    if (sections && section !== Boolean(parts.pinned)) {
      section = Boolean(parts.pinned);
      const heading = document.createElement('h2');
      heading.className = 'grid-section';
      heading.textContent = section ? 'Pinned' : 'Others';
      $('items').append(heading);
    }
    title.textContent = markdown ? plainPreviewText(parts.title) : parts.title;
    // Like the plugin and Android: without a heading the first line is the title, and a list item also stays in the text.
    const bodyLines = markdown ? parts.body.split('\n') : [];
    const firstLine = bodyLines.findIndex((line) => line.trim() && !/^\s*(?:!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)|<!--.*-->)\s*$/.test(line));
    const headed = markdown && /^#\s+.+$/m.test(parts.body);
    if (markdown && !headed && firstLine >= 0) {
      title.textContent = plainPreviewText(bodyLines[firstLine].trim().replace(/^[-*+][ \t]+(?:\[[ xX]\][ \t]*)?/, '').replace(/https?:\/\/[^\s)<>"']+/g, '').trim()) || parts.title;
    }
    card.append(title);
    if (markdown) {
      const fullText = noteText(entry.file);
      const bodyOffset = fullText.slice(0, fullText.length - parts.body.length).split('\n').length - 1;
      // Show the body in its own order: text as text, checklist lines only as checkboxes.
      const titleLine = /^\s*#\s+/.test(parts.body) ? bodyLines.findIndex((line) => line.trim())
        : !headed && firstLine >= 0 && !/^\s*[-*+][ \t]/.test(bodyLines[firstLine]) ? firstLine : -1;
      let text = [], budget = 600, fence;
      const available = [...source.values()].filter((item) => !item.deleted && !isMarkdown(item.file.path));
      const shownAsMedia = (target) => {
        const path = attachmentPath(target, entry.file.path, available.map((item) => item.file.path));
        return Boolean(path && mediaType(path) && available.some((item) => item.file.path === path));
      };
      const flush = () => {
        // Media show below the text, so their links go; any other link shows only its label (Eric: no Markdown signs on a card).
        // A heading keeps its words without the # signs, like in Obsidian and on Android.
        const value = plainPreviewText(text.join('\n').replace(/^\s{0,3}#{1,6}[ \t]+/gm, '').replace(/!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\)/g, '')
          .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_link, label, target) => (!/^https?:/i.test(target) && shownAsMedia(target) ? '' : label))
          .replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_link, name, alias) => alias || name.replace(/#.*$/, ''))
          // A bare web address shows as a link chip below the text, like the plugin and Android.
          .replace(/https?:\/\/[^\s)<>"']+/g, '').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([.,;:!?])/g, '$1'))
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
        // Busy instead of disabled while saving: a disabled box loses keyboard focus.
        let saving = false;
        input.addEventListener('click', (event) => { if (saving) event.preventDefault(); });
        input.addEventListener('change', async () => {
          saving = true;
          justStruck = input.checked ? `${entry.file.path}:${bodyIndex}` : undefined;
          try { const latest = files.get(entry.id); if (latest !== entry) throw new Error('This checklist changed. Sync and try again.'); await queueFile(entry.file.path, encoder.encode(toggleTask(noteText(entry.file), bodyOffset + bodyIndex, input.checked)), entry.revision); }
          catch (error) { input.checked = !input.checked; message(errorText(error)); }
          finally { saving = false; }
        });
        const label = document.createElement('span'); label.className = 'task-text';
        label.append(plainPreviewText(task[2])); label.insertAdjacentHTML('beforeend', strikeLine);
        if (input.checked && justStruck === `${entry.file.path}:${bodyIndex}`) { row.classList.add('just-struck'); justStruck = undefined; }
        row.append(input, label); card.append(row);
      });
      flush();
      if (!entry.deleted && !moment) card.classList.add('opens');
      // Like the plugin and Android: pressing a card for half a second selects it.
      let press, pressed = false;
      card.addEventListener('pointerdown', (event) => {
        pressed = false;
        if (!selectableIds.has(entry.id) || event.button || event.target.closest('button, input, label, audio, a')) return;
        press = setTimeout(() => { pressed = true; toggleSelected(entry.id); }, 500);
      });
      for (const end of ['pointerup', 'pointerleave', 'pointercancel', 'dragstart']) card.addEventListener(end, () => clearTimeout(press));
      card.addEventListener('contextmenu', (event) => { if (pressed) event.preventDefault(); });
      card.addEventListener('click', (event) => {
        if (pressed) { pressed = false; return; }
        if (event.target.closest('button, input, label, audio')) return;
        if (selectedIds.size && selectableIds.has(entry.id)) toggleSelected(entry.id);
        else if (!entry.deleted && !moment) openEditor(entry);
      });
      // Like the plugin: in manual order a card moves by dragging, within its own group (pinned or not).
      if (draggable && !entry.deleted && !entry.conflict) {
        card.draggable = true;
        card.addEventListener('dragstart', (event) => {
          if (selectedIds.size || dragFromControl) { event.preventDefault(); return; }
          dragging = { entry, pinned: Boolean(parts.pinned) };
          card.classList.add('is-dragging');
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', entry.file.path);
        });
        card.addEventListener('dragend', () => { card.classList.remove('is-dragging'); showDrop(null); dragging = null; });
        const before = (event) => event.clientY - card.getBoundingClientRect().top < card.offsetHeight / 2;
        card.addEventListener('dragover', (event) => {
          if (!dragging || dragging.entry === entry || dragging.pinned !== Boolean(parts.pinned)) return showDrop(null);
          event.preventDefault();
          showDrop(card, before(event));
        });
        card.addEventListener('drop', (event) => {
          if (!dragging || dragging.entry === entry || dragging.pinned !== Boolean(parts.pinned)) return;
          event.preventDefault();
          const moved = dragging.entry;
          showDrop(null);
          dragging = null;
          moveCard(moved, entry, before(event), viewNotes).catch((error) => message(errorText(error)));
        });
      }
      if (selectableIds.has(entry.id)) {
        card.dataset.id = entry.id;
        card.append(iconButton('check', 'Select note', () => toggleSelected(entry.id), 'card-select'));
        markSelected(card, selectedIds.has(entry.id));
      }
      // Like the plugin: "Due" or "Overdue" in words with how far off it is, and the repeat beside it.
      const due = reminderBadge(parts.reminder);
      if (due) {
        const badge = paragraph(`${due.label} · ${due.relative}`, `card-reminder${due.overdue ? ' is-overdue' : ''}`);
        badge.title = 'Android sends the reminder after sync.';
        card.append(badge);
        const repeat = parts.reminder && repeatLabel(parts.repeat);
        if (repeat) card.append(paragraph(`🔁 ${repeat}`, 'card-repeat'));
      }
      // Like the plugin and Android: only the first photo shows, as the cover; a voice memo plays on the card.
      let photo = false;
      for (const attachment of noteAttachments(entry, parts, available)) {
        if (mediaType(attachment.file.path)?.startsWith('image/')) { if (photo) continue; photo = true; }
        appendMedia(card, attachment, entry.id);
      }
      // Like Keep: a note's first photo is the cover, edge to edge on top of the card.
      const cover = card.querySelector(':scope > img');
      if (cover) { cover.classList.add('card-cover'); card.prepend(cover); }
    } else appendMedia(card, entry, entry.id);
    if (waiting) card.append(paragraph('Encrypted draft on this browser. Waiting for cloud.', 'note-meta'));
    if (entry.conflict) card.append(paragraph('Another device saved a different version. Review both before choosing.', 'message'));
    if (markdown) appendLinkChips(card, noteUrls(noteText(entry.file)), entry.id);
    if (markdown) {
      // Labels first, then #tags; at most four on a card and the rest as "+N", which opens the note (Eric, 29 Oct).
      const chips = [...parts.labels.map((label) => button(label, () => showLabel(label.toLowerCase()), 'label-chip is-label')),
        ...[...parts.tags, ...parts.inlineTags].map((tag) => button(`#${tag}`, () => { selectedTags.add(tag.toLowerCase()); render(); }, 'label-chip'))];
      card.append(...chips.slice(0, CARD_CHIPS_VISIBLE));
      if (chips.length > CARD_CHIPS_VISIBLE) {
        const more = paragraph(`+${chips.length - CARD_CHIPS_VISIBLE}`, 'chip-more');
        more.title = 'More labels and tags in this note';
        card.append(more);
      }
    }
    // Like Android: when the note last changed.
    if (markdown && entry.file.modifiedAt) {
      const changed = paragraph(changedAgo(entry.file.modifiedAt), 'card-date');
      changed.title = new Date(entry.file.modifiedAt).toLocaleString();
      card.append(changed);
    }
    // Like the plugin: an archived note is a little paler.
    if (view === 'archive') card.classList.add('is-archived');
    if (entry.conflict) card.append(button('Resolve now', () => reviewConflict(entry)));
    // Like Keep and the plugin: actions and file details show on hover or focus (always on touch).
    // An earlier moment is read-only; the time machine restores it as a whole.
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const save = () => download(base64ToBytes(entry.file.content), entry.file.path);
    if (entry.deleted) actions.append(button('Restore', () => restoreEntry(entry)));
    else if (markdown && view !== 'trash') {
      // The plugin's card bar: edit, color, labels, archive and a menu with the rest.
      if (view === 'notes' && !moment) {
        const pin = iconButton('pin', parts.pinned ? 'Unpin' : 'Pin', () => {
          justPinned = { path: entry.file.path, pinned: !parts.pinned };
          return changeNote(entry, { pinned: parts.pinned ? null : true });
        }, 'card-pin');
        pin.setAttribute('aria-pressed', String(Boolean(parts.pinned)));
        if (justPinned?.path === entry.file.path && justPinned.pinned === Boolean(parts.pinned)) {
          pin.classList.add('wiggling');
          if (parts.pinned) card.classList.add('just-pinned');
          justPinned = undefined;
        }
        card.append(pin);
      }
      const color = iconButton('palette', 'Color', () => showMenu(color, colorNames.map(([value, label]) => ({
        label, swatch: value, radio: true, checked: parts.color === value, action: () => changeNote(entry, { color: value === 'default' ? null : value }),
      }))));
      const labels = iconButton('tag', 'Labels', () => showMenu(labels, [
        ...allLabels().map((label) => ({ label, checked: parts.labels.some((own) => own.toLowerCase() === label.toLowerCase()), action: () => toggleLabel(entry, parts.labels, label) })),
        { label: 'New label…', action: () => { const label = prompt('Label name')?.trim(); if (label) return toggleLabel(entry, parts.labels, label); } },
      ]));
      const more = iconButton('more', 'More', () => showMenu(more, [
        { label: 'Download', action: save },
        { label: 'Move to trash', action: () => deleteEntry(entry) },
      ]));
      actions.append(iconButton('pencil', 'Open note', () => openEditor(entry)), color, labels,
        iconButton('archive', view === 'archive' ? 'Unarchive' : 'Archive', () => moveArchive(entry), 'archive-note'), more);
    } else {
      if (markdown) actions.append(button('Open note', () => openEditor(entry)), button('Restore note', () => moveArchive(entry), 'archive-note'));
      actions.append(button('Download', save));
      if (!markdown) actions.append(button('Move to trash', () => deleteEntry(entry), 'danger'));
    }
    if (!moment) card.append(actions);
    // Path and confirmed revision stay out of sight: the editor shows the filename and version history.
    card.dataset.path = entry.file.path;
    if (!entry.pending) card.dataset.revision = entry.revision;
    // Only a card that was not on screen yet fades in; one that was stays as it is.
    if (spans.has(card.dataset.path)) card.classList.add('is-kept');
    const fresh = Date.now() - (freshNotes.get(card.dataset.path) ?? -Infinity) < FRESH_MS;
    if (fresh && !card.classList.contains('is-kept')) card.classList.add('is-dropped');
    // Never before the cloud has it: the stamp says the encrypted note is stored.
    if (fresh && !entry.pending) { freshNotes.delete(card.dataset.path); stamps.set(card.dataset.path, Date.now()); }
    const stamped = Date.now() - (stamps.get(card.dataset.path) ?? -Infinity);
    if (stamped < STAMP_MS) card.append(sealedStamp(stamped));
    else stamps.delete(card.dataset.path);
    if (spans.get(card.dataset.path)) card.style.gridRowEnd = spans.get(card.dataset.path);
    // Until the pointer moves, the card it rests on shows its buttons as before; then real hover takes over.
    if (card.dataset.path === hovered) card.classList.add('is-hovered');
    $('items').append(card);
    if (card.dataset.path === focused?.path) refocus = [...card.querySelectorAll('button, input, audio')][focused.index];
  }
  // Only once every card is back: focusing lays out the page, and a half-built list is shorter, so the browser would scroll up.
  refocus?.focus({ preventScroll: true });
  releaseMedia();
  for (const child of $('items').children) gridSpans.observe(child);
}

document.addEventListener('pointermove', () => { for (const card of $('items').querySelectorAll('.is-hovered')) card.classList.remove('is-hovered'); }, { passive: true });

$('items').addEventListener('click', (event) => {
  const image = event.target.closest('.note-card img');
  if (!image || selectedIds.size) return;
  const source = moment ? moment.files : files;
  const attachment = source.get(image.dataset.id);
  if (!attachment) return;
  event.stopPropagation();
  const path = image.closest('.note-card').dataset.path;
  showPhoto(attachment, isMarkdown(path) ? [...source.values()].find((entry) => entry.file.path === path) : undefined);
}, true);

// Manual order: the card being dragged, and whether the press began on a button or checkbox (that is no drag).
let dragging = null, dragFromControl = false, dropCard = null;
$('items').addEventListener('pointerdown', (event) => { dragFromControl = Boolean(event.target.closest('button, input, label, audio, video, a')); }, true);

function showDrop(card, before) {
  dropCard?.classList.remove('drop-before', 'drop-after');
  dropCard = card;
  card?.classList.add(before ? 'drop-before' : 'drop-after');
}

// Like the plugin: only the moved card gets a new `order`, unless no number fits between its neighbours; then its group is renumbered.
async function moveCard(moved, target, before, viewNotes) {
  const parts = (entry) => noteParts(noteText(entry.file), entry.file.path);
  const pinned = Boolean(parts(moved).pinned);
  const group = viewNotes.filter((entry) => entry !== moved && Boolean(parts(entry).pinned) === pinned);
  let index = group.indexOf(target);
  if (index < 0) return;
  if (!before) index++;
  const rank = (entry) => manualRank(parts(entry).order, entry.file.path);
  const order = betweenRank(index > 0 ? rank(group[index - 1]) : null, index < group.length ? rank(group[index]) : null);
  if (order !== null) return changeNote(moved, { order });
  group.splice(index, 0, moved);
  for (const [position, entry] of group.entries()) if (parts(entry).order !== position) await changeNote(entry, { order: position });
}

// Card actions write the same frontmatter as the editor, on the version shown.
async function changeNote(entry, changes) {
  if (files.get(entry.id) !== entry) throw new Error('This note changed. Sync and try again.');
  await queueFile(entry.file.path, encoder.encode(updateMetadata(noteText(entry.file), changes)), entry.revision);
}

function allLabels() {
  const labels = new Map();
  for (const label of localLabels) labels.set(label.toLowerCase(), label);
  for (const entry of files.values()) if (!entry.deleted && isMarkdown(entry.file.path)) for (const label of noteParts(noteText(entry.file), entry.file.path).labels) labels.set(label.toLowerCase(), label);
  return [...labels.values()].sort((a, b) => a.localeCompare(b));
}

function markSelected(card, on) {
  card.classList.toggle('is-selected', on);
  card.querySelector('.card-select').setAttribute('aria-pressed', String(on));
}

function toggleSelected(id) {
  if (!selectedIds.delete(id)) selectedIds.add(id);
  for (const card of $('items').querySelectorAll('.note-card[data-id]')) if (card.dataset.id === id) markSelected(card, selectedIds.has(id));
  renderSelectionBar();
}

// A change made while a sync runs would otherwise wait for the next 30-second round.
async function syncAgain() {
  if (syncing) await syncing;
  await sync();
}

// One choice for all chosen notes, like the plugin and Android. A note that fails stays chosen and unchanged.
async function runBulk(action, keepSelection = false) {
  const ids = [...selectedIds], failed = [];
  for (const id of ids) {
    try { await action(files.get(id)); } catch { failed.push(id); }
  }
  if (!keepSelection) { selectedIds.clear(); for (const id of failed) selectedIds.add(id); }
  render();
  await syncAgain();
  if (failed.length) message(`${failed.length} of ${ids.length} notes could not be changed. They stay selected; sync and try again.`);
}

function renderSelectionBar() {
  const bar = $('selection-bar');
  $('items').classList.toggle('selecting', selectedIds.size > 0);
  bar.hidden = !selectedIds.size;
  if (!selectedIds.size) return bar.replaceChildren();
  const chosen = [...selectedIds].map((id) => files.get(id));
  const count = selectedIds.size;
  const notes = `${count} ${count === 1 ? 'note' : 'notes'}`;
  const done = button('Done', () => { selectedIds.clear(); render(); });
  const all = button('Select all', () => { for (const id of selectableIds) selectedIds.add(id); render(); });
  bar.replaceChildren(done, paragraph(`${count} selected`, 'selection-count'), all);
  if (view === 'trash') {
    bar.append(button('Restore', () => confirm(`Restore ${notes}?`)
      && runBulk((entry) => (entry.deleted ? restoreEntry(entry, entry.revision, false) : moveArchive(entry, false)))));
    return;
  }
  const labelSets = chosen.map((entry) => noteParts(noteText(entry.file), entry.file.path).labels);
  const everyHas = (label) => labelSets.every((labels) => labels.some((own) => own.toLowerCase() === label.toLowerCase()));
  // Ticking a label gives it to every chosen note; unticking one they all have takes it off.
  const setLabel = (label, add) => runBulk((entry) => {
    const labels = noteParts(noteText(entry.file), entry.file.path).labels.filter((own) => own.toLowerCase() !== label.toLowerCase());
    if (add) labels.push(label);
    return changeNote(entry, { jotdrop_labels: labels.length ? labels : null });
  }, true);
  const colors = new Set(chosen.map((entry) => noteParts(noteText(entry.file), entry.file.path).color));
  const color = button('Color', () => showMenu(color, colorNames.map(([value, label]) => ({
    label, swatch: value, radio: true, checked: colors.size === 1 && colors.has(value), action: () => runBulk((entry) => changeNote(entry, { color: value === 'default' ? null : value }), true),
  }))));
  const labels = button('Labels', () => showMenu(labels, [
    ...allLabels().map((label) => ({ label, checked: everyHas(label), action: () => setLabel(label, !everyHas(label)) })),
    { label: 'New label…', action: () => { const label = prompt('Label name')?.trim(); if (label) return setLabel(label, true); } },
  ]));
  const archive = view === 'archive' ? 'Unarchive' : 'Archive';
  bar.append(color, labels,
    button(archive, () => confirm(`${archive} ${notes}? Each original stays until its new cloud copy is confirmed.`) && runBulk((entry) => moveArchive(entry, false))),
    button('Move to trash', () => confirm(`Move ${notes} to trash?`) && runBulk((entry) => deleteEntry(entry, false)), 'danger'));
}

// Labels live in the sidebar, like Keep: each opens the notes with that label, with their count.
// Returns the name of the label shown, if any.
function renderLabelList() {
  const counts = new Map();
  for (const label of localLabels) counts.set(label.toLowerCase(), { label, count: 0 });
  for (const entry of files.values()) {
    if (entry.deleted || !isMarkdown(entry.file.path) || entry.file.path.startsWith('notes/Trash/')) continue;
    for (const label of noteParts(noteText(entry.file), entry.file.path).labels) {
      const known = counts.get(label.toLowerCase());
      counts.set(label.toLowerCase(), { label: known?.label || label, count: (known?.count || 0) + Number(!entry.file.path.startsWith('notes/Archive/')) });
    }
  }
  if (!counts.has(labelFilter)) labelFilter = '';
  $('label-list').replaceChildren(...[...counts].sort((a, b) => a[1].label.localeCompare(b[1].label)).map(([key, { label, count }]) => {
    const item = button('', () => showLabel(key), 'label-nav');
    item.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons.tag}</svg>`;
    const name = document.createElement('span');
    name.className = 'label-name';
    name.textContent = label;
    item.title = label;
    item.append(name, String(count));
    if (view === 'notes' && labelFilter === key) item.setAttribute('aria-current', 'page');
    return item;
  }));
  for (const item of document.querySelectorAll('[data-view]')) {
    if (item.dataset.view === view && !labelFilter) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  return counts.get(labelFilter)?.label;
}

function showLabel(key) {
  view = 'notes';
  labelFilter = key;
  message();
  render();
}

// A label made in the sidebar stays on this device, encrypted like the cache, until a note has it (as in the plugin).
const labelsKey = () => `labels:${client.credentials.vaultId}`;
async function loadLocalLabels() {
  const prepared = await store('get', labelsKey());
  const file = prepared && await decryptEnvelope(client.credentials.vaultKey, JSON.parse(prepared.envelope), aad(prepared.id));
  localLabels = file ? JSON.parse(decoder.decode(base64ToBytes(file.content))) : [];
}
async function saveLocalLabels(next) {
  await store('put', labelsKey(), await sealFile('local/labels.json', encoder.encode(JSON.stringify(next)), 0));
  localLabels = next;
}

function renderLabelRows() {
  $('label-rows').replaceChildren(...allLabels().map((label) => {
    const row = document.createElement('li');
    const form = document.createElement('form');
    form.className = 'label-row';
    const input = document.createElement('input');
    input.value = label;
    input.maxLength = 100;
    input.setAttribute('aria-label', `New name for ${label}`);
    const rename = document.createElement('button');
    rename.type = 'submit';
    rename.textContent = 'Rename';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Delete';
    remove.setAttribute('aria-label', `Delete ${label}`);
    form.addEventListener('submit', (event) => { event.preventDefault(); void editLabel(label, input.value); });
    remove.addEventListener('click', () => editLabel(label, null));
    form.append(input, rename, remove);
    row.append(form);
    return row;
  }));
}

// Like the plugin: rename or delete a label on every note in Notes and Archive; notes always stay.
async function editLabel(oldName, newName) {
  $('labels-message').textContent = '';
  try {
    if (moment) throw new Error('Go back to now before changing labels.');
    const key = oldName.toLowerCase();
    if (newName !== null) {
      newName = newName.trim();
      if (!newName || /[\x00-\x1f]/.test(newName)) throw new Error('Type a label name.');
      if (newName === oldName) return;
    }
    if (syncing) await syncing;
    const targets = [...files.values()].filter((entry) => !entry.deleted && isMarkdown(entry.file.path) && entry.file.path.startsWith('notes/') && !entry.file.path.startsWith('notes/Trash/')
      && noteParts(noteText(entry.file), entry.file.path).labels.some((label) => label.toLowerCase() === key));
    if (newName === null && !confirm(`Delete the label "${oldName}"? It is removed from ${targets.length} ${targets.length === 1 ? 'note' : 'notes'}. The notes stay.`)) return;
    let failed = 0;
    for (const entry of targets) {
      const next = new Map();
      for (const label of noteParts(noteText(entry.file), entry.file.path).labels) {
        const name = label.toLowerCase() === key ? newName : label;
        if (name && !next.has(name.toLowerCase())) next.set(name.toLowerCase(), name);
      }
      try { await changeNote(entry, { jotdrop_labels: next.size ? [...next.values()] : null }); } catch { failed++; }
    }
    if (localLabels.some((label) => label.toLowerCase() === key)) {
      const kept = localLabels.filter((label) => label.toLowerCase() !== key && label.toLowerCase() !== newName?.toLowerCase());
      await saveLocalLabels(newName ? [...kept, newName] : kept);
    }
    if (labelFilter === key) labelFilter = newName ? newName.toLowerCase() : '';
    render();
    renderLabelRows();
    await syncAgain();
    if (failed) throw new Error(`${failed} ${failed === 1 ? 'note' : 'notes'} could not be changed. Sync and try again.`);
  } catch (error) { $('labels-message').textContent = errorText(error); }
}

function toggleLabel(entry, current, label) {
  const has = current.some((own) => own.toLowerCase() === label.toLowerCase());
  const next = has ? current.filter((own) => own.toLowerCase() !== label.toLowerCase()) : [...current, label];
  return changeNote(entry, { jotdrop_labels: next.length ? next : null });
}

async function cacheEntry(entry) {
  const prepared = await sealFile(entry.file.path, base64ToBytes(entry.file.content), entry.revision, entry.file.modifiedAt);
  await store('put', `${cachePrefix()}${entry.id}`, { prepared, revision: entry.revision, deleted: entry.deleted, updatedAt: entry.updatedAt });
}

async function loadLocal() {
  for (const [, record] of await store('entries', cachePrefix())) {
    const file = await decryptEnvelope(client.credentials.vaultKey, JSON.parse(record.prepared.envelope), aad(record.prepared.id));
    files.set(record.prepared.id, { id: record.prepared.id, file, revision: record.revision, deleted: record.deleted });
  }
  for (const [, record] of await store('entries', pendingPrefix())) {
    // `local` holds the whole file; a draft from before encrypted pieces has it in its envelope.
    const file = await decryptEnvelope(client.credentials.vaultKey, JSON.parse(record.local ?? record.prepared.envelope), aad(record.prepared.id));
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
  const record = { prepared, local: (await sealFile(path, bytes, 0, modifiedAt)).envelope, deleted: false, queueId: crypto.randomUUID() };
  await store('queue', key, record);
  if (generation !== activeGeneration) return;
  files.set(prepared.id, { id: prepared.id, revision: prepared.baseRevision, deleted: false, pending: true, queuedAt: Date.now(), file: { path, content: bytesToBase64(bytes), modifiedAt } });
  render();
  void sync();
  setTimeout(() => { if (generation === activeGeneration && files.get(prepared.id)?.pending) render(); }, QUIET_PENDING_MS);
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
    const prepared = prior?.prepared || await sealFile(entry.file.path, base64ToBytes(entry.file.content), entry.revision, entry.file.modifiedAt);
    await store('queue', key, { prepared, deleted: true, queueId: crypto.randomUUID() });
    files.set(entry.id, { ...entry, deleted: true, pending: true });
  }
  render();
  void sync();
}

async function moveArchive(entry, ask = true) {
  if (syncing) await syncing;
  if (entry !== files.get(entry.id) || entry.pending || entry.conflict || entry.deleted) throw new Error('Sync and resolve this note before moving it.');
  const path = /^notes\/(Archive|Trash)\//.test(entry.file.path) ? entry.file.path.replace(/^notes\/(Archive|Trash)\//, 'notes/') : entry.file.path.replace(/^notes\//, 'notes/Archive/');
  if (path === entry.file.path) throw new Error('Only notes in the notes folder can be archived.');
  if (ask && !confirm(`Move this note to ${path}? The original stays until the new cloud copy is confirmed.`)) return;
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

async function showPlan(activeClient, activeGeneration) {
  const status = await activeClient.status();
  if (activeGeneration !== generation) return;
  $('storage-usage').classList.remove('checking');
  $('storage-usage').textContent = `${(status.usedBytes / 1048576).toFixed(1)} / ${(status.quotaBytes / 1048576).toFixed(0)} MiB encrypted storage`;
  if (status.pieces?.maxFileBytes) maxFileBytes = status.pieces.maxFileBytes;
  const plan = status.plan;
  $('plan-status').textContent = plan.name === 'plus' ? `JotDrop Plus until ${new Date(plan.plusUntil).toLocaleDateString()}` : `Free plan: ${plan.deviceLimit} devices, ${plan.historyDays} days of history`;
  currentPlan = plan;
  storageShare = plan.name === 'plus' ? 0 : status.usedBytes / status.quotaBytes;
  showPlusNudge();
  $('plus-offer').hidden = !plan.checkout || plan.subscribed;
  $('buy-year').textContent = plan.founderPrice ? '€29 per year (founder price)' : '€39 per year';
  $('plus-manage').hidden = !plan.subscribed;
  return status;
}

async function performSync(signal) {
  if (!client) return;
  const { credentials, fetcher } = client;
  const activeClient = new CloudClient({ ...credentials, fetcher: (url, options) => fetcher(url, { ...options, signal: AbortSignal.any([signal, options.signal]) }) });
  const activeGeneration = generation;
  let changed = false;
  $('sync-status').textContent = 'Syncing encrypted changes...';
  $('sync-status').classList.add('checking');
  // Storage and Plus first, so one slow or failing note does not hide them.
  const legacy = (await showPlan(activeClient, activeGeneration))?.pieces?.legacy;
  if (activeGeneration !== generation) return;
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
    // The bar shows only for an upload that takes a while, not for a quick tick.
    const showBar = setTimeout(() => { if (activeGeneration === generation && !signal.aborted && !uploading.deleted) $('upload-progress').hidden = false; }, 1000);
    // The pieces the cloud does not have yet come from this browser's encrypted copy of the file.
    const source = !uploading.deleted && uploading.local ? base64ToBytes((await decryptEnvelope(activeClient.credentials.vaultKey, JSON.parse(uploading.local), aad(uploading.prepared.id))).content) : undefined;
    try { result = uploading.deleted ? await activeClient.remove(uploading.prepared.id, uploading.prepared.baseRevision) : await activeClient.commitWrite(uploading.prepared, {
      resumable: true, signal, source,
      onProgress: ({ phase, transferredBytes, totalBytes }) => {
        if (activeGeneration !== generation || signal.aborted) return;
        const progress = $('upload-progress');
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
      const expected = await decryptEnvelope(activeClient.credentials.vaultKey, JSON.parse(uploading.local ?? uploading.prepared.envelope), `jotdrop:object:v1:${activeClient.credentials.vaultId}:${uploading.prepared.id}`);
      if (remote.deleted === uploading.deleted && remote.file.path === expected.path && remote.file.content === expected.content) result = { revision: remote.revision };
      else {
        const entry = files.get(pending.prepared.id);
        if (entry) { entry.conflict = true; changed = true; }
        continue;
      }
    }
    finally { clearTimeout(showBar); }
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
  let more = true, loaded = 0, toLoad = 0, shownAt = Date.now();
  while (more) {
    signal.throwIfAborted();
    const result = await activeClient.listChanges(cursor);
    const latest = new Map();
    for (const change of result.changes) {
      // The time machine steps per minute with a change.
      const minute = change.updatedAt.slice(0, 16);
      if (!(moments.get(minute) > change.updatedAt)) moments.set(minute, change.updatedAt);
      latest.set(change.id, change);
    }
    // Skip what this browser already has; a trash clear-out (deleted, size 0) keeps the revision, so always read it.
    const reads = [...latest.values()].filter((change) => files.get(change.id)?.revision !== change.revision || (change.deleted && !change.size));
    // Small notes first, so cards appear before large attachments finish.
    reads.sort((a, b) => a.size - b.size);
    toLoad += reads.length;
    for (const change of reads) {
      if (activeGeneration !== generation) return;
      $('sync-status').textContent = `Loading your notes... ${loaded++} / ${toLoad}`;
      if (changed && Date.now() - shownAt >= 1000) { render(); shownAt = Date.now(); }
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
  // Files saved before encrypted pieces move into pieces once, so storage counts their real size.
  if (legacy) {
    const shrinking = ({ done, total }) => { if (activeGeneration === generation) $('sync-status').textContent = `Making your cloud storage smaller... ${done} / ${total}`; };
    shrinking({ done: 0, total: legacy });
    await activeClient.convertLegacy({ signal, onProgress: shrinking });
  }
  await showPlan(activeClient, activeGeneration);
  if (activeGeneration !== generation) return;
  const pending = await store('entries', keyPrefix);
  const conflicts = [...files.values()].filter((entry) => entry.conflict).length;
  $('sync-status').textContent = conflicts ? `${conflicts === 1 ? '1 note was' : `${conflicts} notes were`} changed in two places. Both versions are kept: select Resolve now.` : pending.length ? `${pending.length} encrypted change(s) waiting to upload.` : `Cloud copy up to date at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
  if (changed) render();
}

async function sync() {
  if (!client || syncing || syncPaused) return syncing;
  const activeGeneration = generation;
  const controller = new AbortController();
  syncController = controller;
  $('sync').disabled = true;
  // Only a sync that takes a while can be paused: a quick check every 30 seconds that showed the button
  // and hid it again added a toolbar row on some widths and moved the whole page (Eric, 27 Oct).
  const showPause = setTimeout(() => { if (syncController === controller) $('pause-sync').hidden = false; }, 1000);
  syncing = performSync(controller.signal).catch((error) => {
    if (activeGeneration !== generation) return;
    $('sync-status').textContent = syncPaused ? 'Sync paused. Encrypted drafts stay on this browser. Select Resume sync to continue.' : 'Cloud unavailable. Encrypted drafts stay on this browser.';
    if (!syncPaused) message(errorText(error));
    render();
  }).finally(() => {
    clearTimeout(showPause);
    if (syncController !== controller) return;
    syncing = undefined;
    syncController = undefined;
    $('sync').disabled = false;
    $('sync').textContent = syncPaused ? 'Resume sync' : 'Sync now';
    $('pause-sync').hidden = true;
    $('upload-progress').hidden = true;
    $('sync-status').classList.remove('checking');
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
  pathTyped = false;
  $('note-content').value = entry ? noteText(entry.file) : '';
  renderNoteMedia(entry);
  syncSimple();
  refreshProperties();
  $('editor-message').textContent = 'Changes are saved only when you select Save note.';
  $('history').hidden = true;
  $('history-list').replaceChildren();
  for (const id of ['note-history', 'note-download', 'note-delete']) $(id).hidden = !entry;
  const index = entry ? navOrder.indexOf(entry.id) : -1;
  $('note-prev').hidden = $('note-next').hidden = index < 0 || navOrder.length < 2;
  $('note-prev').disabled = index <= 0;
  $('note-next').disabled = index >= navOrder.length - 1;
  if (!$('editor').open) $('editor').showModal();
  (markdownMode ? $('note-content') : entry ? $('note-body') : $('note-title')).focus();
}

$('editor').addEventListener('close', () => renderNoteMedia());

// The Markdown file in #note-content is the single source; title, text and the controls edit it.
let markdownMode = false;
let pathTyped = false;
$('note-path').addEventListener('input', () => { pathTyped = true; });
try { markdownMode = localStorage.getItem('jotdrop-editor-mode') === 'markdown'; } catch { /* The simple editor is the default. */ }
function setMarkdownMode(on) {
  markdownMode = on;
  $('markdown-mode').setAttribute('aria-pressed', String(on));
  $('markdown-editor').hidden = !on;
  $('simple-editor').hidden = on;
  if (!on) syncSimple();
  try { localStorage.setItem('jotdrop-editor-mode', on ? 'markdown' : 'simple'); } catch { /* Keep the choice for this page. */ }
}
setMarkdownMode(markdownMode);
$('markdown-mode').addEventListener('click', () => setMarkdownMode(!markdownMode));

function syncSimple() {
  const { title, body } = splitNote($('note-content').value);
  $('note-title').value = title;
  $('note-body').value = body;
}
function syncRaw() {
  $('note-content').value = joinNote({ front: splitNote($('note-content').value).front, title: $('note-title').value, body: $('note-body').value });
  refreshProperties();
}
$('note-title').addEventListener('input', syncRaw);
$('note-body').addEventListener('input', syncRaw);
$('note-title').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $('note-body').focus(); } });
$('note-content').addEventListener('input', refreshProperties);
// Voice memos and recognized text are added to the end of the note in either view.
function appendToNote(text) {
  $('note-content').value += text;
  syncSimple();
  refreshProperties();
}

function changeProperties(changes) {
  try {
    if (changes.reminder === null) for (const field of ['reminder_repeat', 'reminder_until', 'reminder_limit', 'reminder_done']) changes[field] = null;
    if ('reminder' in changes || 'reminder_repeat' in changes) changes.reminder_done = null;
    $('note-content').value = updateMetadata($('note-content').value, changes);
    $('editor-message').textContent = 'Changes are saved only when you select Save note.';
  } catch (error) { $('editor-message').textContent = errorText(error); }
  refreshProperties();
}

for (const [value, label] of colorNames) {
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = `swatch note-${value}`;
  swatch.setAttribute('role', 'radio');
  swatch.setAttribute('aria-label', label);
  swatch.title = label;
  swatch.dataset.color = value;
  swatch.addEventListener('click', () => changeProperties({ color: value === 'default' ? null : value }));
  $('note-colors').append(swatch);
}

function chips(container, values, prefix, onRemove) {
  container.replaceChildren(...values.map((value) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.append(`${prefix}${value}`);
    const remove = button('×', () => onRemove(value));
    remove.setAttribute('aria-label', `Remove ${prefix}${value}`);
    chip.append(remove);
    return chip;
  }));
}

let repeatShown;
function refreshProperties() {
  const parts = noteParts($('note-content').value, $('note-path').value);
  $('note-pinned').setAttribute('aria-pressed', String(parts.pinned));
  for (const swatch of $('note-colors').children) swatch.setAttribute('aria-checked', String(swatch.dataset.color === parts.color));
  // The chosen color is also named in text, so it never depends on seeing color.
  $('color-name').textContent = colorNames.find(([value]) => value === parts.color)[1];
  chips($('label-chips'), parts.labels, '', (label) => changeProperties({ jotdrop_labels: parts.labels.filter((own) => own !== label).length ? parts.labels.filter((own) => own !== label) : null }));
  chips($('tag-chips'), parts.tags, '#', (tag) => changeProperties({ tags: parts.tags.filter((own) => own !== tag).length ? parts.tags.filter((own) => own !== tag) : null }));
  $('label-options').replaceChildren(...allLabels().map((label) => new Option(label)));
  $('tag-options').replaceChildren(...allTags().map((tag) => new Option(tag)));
  $('note-order').value = parts.order ?? '';
  $('note-reminder').value = parts.reminder;
  // Re-render the repeat picker only when its value changed, so typing in it keeps focus.
  const key = JSON.stringify([parts.reminder ? 1 : 0, parts.repeat, parts.until, parts.limit]);
  if (key !== repeatShown) { repeatShown = key; renderRepeat(parts); }
}

function allTags() {
  const tags = new Map();
  for (const entry of files.values()) if (!entry.deleted && isMarkdown(entry.file.path)) for (const tag of noteParts(noteText(entry.file), entry.file.path).tags) tags.set(tag.toLowerCase(), tag);
  return [...tags.values()].sort((a, b) => a.localeCompare(b));
}

for (const [id, field] of [['label-input', 'labels'], ['tag-input', 'tags']]) {
  const add = () => {
    let value = $(id).value.trim();
    // Tags are single words, as in Obsidian.
    if (field === 'tags') value = value.replace(/^#/, '').replace(/\s+/g, '-');
    $(id).value = '';
    if (!value) return;
    const parts = noteParts($('note-content').value, $('note-path').value);
    const current = field === 'tags' ? parts.tags : parts.labels;
    if (current.some((own) => own.toLowerCase() === value.toLowerCase())) return;
    changeProperties({ [field === 'tags' ? 'tags' : 'jotdrop_labels']: [...current, value] });
  };
  $(id).addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); add(); } });
  $(id).addEventListener('change', add);
}

$('note-pinned').addEventListener('click', () => changeProperties({ pinned: $('note-pinned').getAttribute('aria-pressed') === 'true' ? null : true }));
$('note-reminder').addEventListener('change', () => changeProperties({ reminder: $('note-reminder').value || null }));
$('clear-reminder').addEventListener('click', () => changeProperties({ reminder: null }));
$('note-order').addEventListener('change', () => {
  const value = $('note-order').value.trim();
  if (value !== '' && !Number.isFinite(Number(value))) { $('editor-message').textContent = 'Manual position must be a finite number.'; refreshProperties(); return; }
  changeProperties({ order: value === '' ? null : Number(value) });
});

// The plugin's repeat picker: type, its details, and when it ends. Writes reminder_repeat/until/limit.
function renderRepeat(parts) {
  const root = $('repeat-editor');
  root.replaceChildren();
  const make = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  const select = (label, options, value, onChange) => {
    const element = make('select');
    element.setAttribute('aria-label', label);
    element.append(...options.map(([optionValue, text]) => new Option(text, optionValue)));
    element.value = value;
    element.addEventListener('change', () => onChange(element.value));
    return element;
  };
  const repeat = parts.repeat;
  const type = !repeat ? 'none' : repeat.split(':')[0];
  const row = make('div', { className: 'repeat-row' });
  const typeLabel = make('label', { textContent: 'Repeat', htmlFor: 'repeat-type' });
  const typeSelect = select('Repeat', [['none', 'None'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly'], ['every', 'Every'], ['ordinal', 'On the']], type, (value) => {
    changeProperties(value === 'none' ? { reminder_repeat: null, reminder_until: null, reminder_limit: null } : { reminder_repeat: { daily: 'daily', weekly: 'weekly:1', monthly: 'monthly', yearly: 'yearly', every: 'every:1:days', ordinal: 'ordinal:1:1' }[value] });
  });
  typeSelect.id = 'repeat-type';
  typeSelect.disabled = !parts.reminder;
  row.append(typeLabel, typeSelect);
  root.append(row);
  if (!parts.reminder) { root.append(paragraph('Set a reminder first to repeat it.', 'editor-hint')); return; }
  const weekdays = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];
  if (type === 'weekly') {
    const chosen = new Set(repeat.slice(7).split(',').map(Number));
    const days = make('div', { className: 'repeat-row' });
    for (const [day, label] of weekdays) {
      const toggle = button(label, () => {
        const next = new Set(chosen);
        if (next.has(day)) next.delete(day); else next.add(day);
        if (next.size) changeProperties({ reminder_repeat: `weekly:${[...next].sort((a, b) => a - b).join(',')}` });
      }, 'weekday');
      toggle.setAttribute('aria-pressed', String(chosen.has(day)));
      days.append(toggle);
    }
    root.append(days);
  } else if (type === 'every') {
    const [, n = '1', unit = 'days'] = repeat.split(':');
    const count = make('input', { type: 'number', min: '1', max: '999', step: '1', value: n });
    count.setAttribute('aria-label', 'Every how many');
    const units = select('Unit', [['days', 'days'], ['weeks', 'weeks'], ['months', 'months']], unit, (value) => changeProperties({ reminder_repeat: `every:${count.value}:${value}` }));
    count.addEventListener('change', () => { const value = Math.trunc(Number(count.value)); if (value >= 1 && value <= 999) changeProperties({ reminder_repeat: `every:${value}:${units.value}` }); else refreshProperties(); });
    const row = make('div', { className: 'repeat-row' });
    row.append(count, units);
    root.append(row);
  } else if (type === 'ordinal') {
    const [, k = '1', day = '1'] = repeat.split(':');
    const which = select('Which week', [['1', '1st'], ['2', '2nd'], ['3', '3rd'], ['4', '4th'], ['5', 'Last']], k, (value) => changeProperties({ reminder_repeat: `ordinal:${value}:${weekday.value}` }));
    const weekday = select('Weekday', weekdays.map(([value, label]) => [String(value), label]), day, (value) => changeProperties({ reminder_repeat: `ordinal:${which.value}:${value}` }));
    const row = make('div', { className: 'repeat-row' });
    row.append(which, weekday);
    root.append(row);
  }
  if (type === 'none') return;
  const ends = make('div', { className: 'repeat-row' });
  const endType = parts.limit ? 'after' : parts.until ? 'until' : 'never';
  ends.append(make('span', { textContent: 'Ends' }), select('Ends', [['never', 'Never'], ['after', 'After a number of times'], ['until', 'On date']], endType, (value) => {
    changeProperties(value === 'never' ? { reminder_until: null, reminder_limit: null } : value === 'after' ? { reminder_until: null, reminder_limit: 10 } : { reminder_limit: null, reminder_until: (parts.reminder || new Date().toISOString()).slice(0, 10) });
  }));
  if (endType === 'after') {
    const times = make('input', { type: 'number', min: '1', max: '9999', step: '1', value: parts.limit });
    times.setAttribute('aria-label', 'Number of times');
    times.addEventListener('change', () => { const value = Math.trunc(Number(times.value)); if (value >= 1) changeProperties({ reminder_limit: value }); else refreshProperties(); });
    ends.append(times);
  } else if (endType === 'until') {
    const date = make('input', { type: 'date', value: parts.until });
    date.setAttribute('aria-label', 'End date');
    date.addEventListener('change', () => { if (date.value) changeProperties({ reminder_until: date.value }); });
    ends.append(date);
  }
  root.append(ends);
}

// Markdown help: the codes most people forget, next to the text they type in.
$('markdown-help-toggle').addEventListener('click', () => {
  const open = $('markdown-help').hidden;
  $('markdown-help').hidden = !open;
  $('markdown-help-toggle').setAttribute('aria-expanded', String(open));
});

// Checklist button, as in the plugin and Android: toggle the line's checkbox or start one.
$('insert-checklist').addEventListener('click', () => {
  const area = markdownMode ? $('note-content') : $('note-body');
  const value = area.value, caret = area.selectionStart ?? value.length;
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1, next = value.indexOf('\n', caret), lineEnd = next < 0 ? value.length : next;
  const line = value.slice(lineStart, lineEnd);
  const updated = /^- \[ \]/.test(line) ? `- [x]${line.slice(5)}` : /^- \[[xX]\]/.test(line) ? `- [ ]${line.slice(5)}` : `- [ ] ${line}`;
  area.value = value.slice(0, lineStart) + updated + value.slice(lineEnd);
  area.selectionStart = area.selectionEnd = caret + (updated.length - line.length);
  area.focus();
  area.dispatchEvent(new Event('input'));
});

// Insert link: a [[wikilink]] to another note, by its name when that is unique (Obsidian's convention).
$('insert-link').addEventListener('click', () => {
  const notes = [...files.values()].filter((entry) => !entry.deleted && isMarkdown(entry.file.path) && entry.file.path !== $('note-path').value);
  const name = (path) => path.split('/').pop().replace(/\.md$/i, '');
  const area = markdownMode ? $('note-content') : $('note-body');
  const start = area.selectionStart ?? area.value.length, end = area.selectionEnd ?? start;
  showMenu($('insert-link'), notes.length ? notes.map((entry) => ({
    label: noteParts(noteText(entry.file), entry.file.path).title,
    action: () => {
      const unique = notes.filter((other) => name(other.file.path) === name(entry.file.path)).length === 1;
      const link = `[[${unique ? name(entry.file.path) : entry.file.path.replace(/\.md$/i, '')}]]`;
      area.value = area.value.slice(0, start) + link + area.value.slice(end);
      area.selectionStart = area.selectionEnd = start + link.length;
      area.focus();
      area.dispatchEvent(new Event('input'));
    },
  })).sort((a, b) => a.label.localeCompare(b.label)) : [{ label: 'No other notes yet', action: () => {} }]);
});

// Previous/next follow the card order, like the plugin; unsaved edits are saved first.
async function navigateEditor(delta) {
  const target = files.get(navOrder[navOrder.indexOf(editing?.id) + delta]);
  if (!target) return;
  if ($('note-content').value !== noteText(editing.file) && !await saveEditor()) return;
  openEditor(files.get(target.id) || target);
}
$('note-prev').addEventListener('click', () => void navigateEditor(-1));
$('note-next').addEventListener('click', () => void navigateEditor(1));
$('editor').addEventListener('keydown', (event) => {
  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !$('note-prev').hidden) { event.preventDefault(); void navigateEditor(event.key === 'ArrowLeft' ? -1 : 1); }
});

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
    if (job.blob.size > maxFileBytes) throw fileTooLarge(`This recording is larger than ${maxFileText()}, your plan's maximum per file. Download it before closing this note.`);
    await queueFile(job.path, new Uint8Array(await job.blob.arrayBuffer()));
    if (voiceJob !== job || job.generation !== generation || !$('editor').open) return;
    appendToNote(`\n\n[Voice memo](${'../'.repeat($('note-path').value.split('/').length - 1)}${job.path})\n`);
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
  const original = editing ? noteText(editing.file) : '';
  if (($('note-content').value !== original || voiceJob) && !confirm('Close without saving these edits or recording?')) return;
  discardVoice();
  resetPhoto();
  $('editor').close();
  $('note-content').value = '';
  editing = undefined;
}

async function restoreEntry(entry, revision = entry.revision, ask = true) {
    if (entry.pending) throw new Error('Sync this file before restoring an earlier cloud version.');
  if (ask && !confirm('Restore this version as a new cloud version?')) return;
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
  if (locked) offerPlus('JotDrop Plus keeps every version.');
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

// A remembered browser stays signed in across reloads, like Keep: the connection is sealed with a key
// this browser keeps but cannot export. Lock workspace forgets it, so the password is needed again.
async function keepSignedIn(credentials) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  await store('put', 'session', { key, iv, data: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(credentials))) });
}
async function signedInCredentials() {
  const saved = await store('get', 'session');
  return saved && JSON.parse(decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: saved.iv }, saved.key, saved.data)));
}

async function openWorkspace(connected) {
  syncController?.abort();
  if (syncing) await syncing;
  const remembered = await store('get', 'connection');
  if (remembered) await keepSignedIn(connected.credentials);
  else await store('delete', 'session');
  // Signed in with Google or GitHub and no password: nothing could unlock a locked browser, so only Log out.
  $('lock').hidden = Boolean(remembered?.provider);
  client = connected;
  syncPaused = false;
  $('sync').textContent = 'Sync now';
  generation++;
  cursor = 0;
  files.clear();
  moments.clear();
  closeMoment();
  $('opening').hidden = true;
  $('access').hidden = true;
  $('workspace').hidden = false;
  $('account-actions').hidden = false;
  const opened = generation;
  accountInfo(connected).then((account) => { if (generation === opened) showAccountEmail(account); }, () => { if (generation === opened) showAccountEmail(null); });
  $('access-code').value = '';
  $('new-password').value = '';
  $('confirm-password').value = '';
  $('unlock-password').value = '';
  await loadLocal();
  await loadLocalLabels();
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

function lock(notice = '') {
  if (voiceJob && !confirm('Discard the current recording and lock?')) return;
  void store('delete', 'session');
  releaseDevice();
  discardVoice();
  resetPhoto();
  syncController?.abort();
  generation++;
  client = undefined;
  files.clear();
  moments.clear();
  closeMoment();
  localLabels = [];
  labelFilter = '';
  $('labels-dialog').close();
  editing = undefined;
  releaseMedia(true);
  $('items').replaceChildren();
  $('device-list').replaceChildren();
  $('note-content').value = '';
  $('pair-code').value = '';
  $('recovery-code').value = '';
  $('editor').close();
  message();
  currentPlan = undefined;
  storageShare = 0;
  plusReason = '';
  plusQuiet = false;
  showPlusNudge();
  attaching = undefined;
  $('totp-enable').hidden = true;
  $('totp-secret').value = '';
  $('totp-qr').replaceChildren();
  $('secure-dialog').close();
  $('workspace').hidden = true;
  $('account-actions').hidden = true;
  showAccountEmail(null);
  $('access').hidden = false;
  void store('get', 'connection').then((saved) => (unlockable(saved) ? showUnlock() : showAccess('login-form')), () => showAccess('login-form'))
    .then(() => { if (notice) $('access-message').textContent = notice; });
}

const DEVICE_NAME = 'Web browser';
let codeStep;
let reset;
// Sign-in with Google or GitHub that this server offers, and the one in progress.
let providerList = [];
let providerSignIn;
const PROVIDER_NAMES = { google: 'Google', github: 'GitHub' };
let attaching;
let totpOn = false;
// The password of a brand-new account, kept only while the authenticator offer after signing up is open.
let secureOffer;
let approvalRun = 0;
const accessError = (error) => error?.message || 'Something went wrong. Try again.';
// Account forms report the server's own reason (wrong password, wrong code), except a revoked device.
const accountError = (error) => (error?.message && error.message !== 'Device access denied' ? error.message : errorText(error));

// Cloudflare Turnstile, only when the server asks for it and only on the form for a new account:
// a person, not a script, makes a new account (Eric, 27 Oct). Nothing loads from Cloudflare anywhere else.
let humanCheck;
function loadHumanCheck() {
  humanCheck ??= personCheckKey(location.origin).then((siteKey) => siteKey && new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.onload = () => {
      $('signup-human').hidden = false;
      resolve(turnstile.render('#signup-human', { sitekey: siteKey, theme: 'auto' }));
    };
    script.onerror = () => { humanCheck = undefined; reject(new Error('The person check could not load. Check your connection and try again.')); };
    document.head.append(script);
  }));
  return humanCheck;
}

function showAccess(id) {
  approvalRun++;
  if (id === 'signup-form') loadHumanCheck().catch((error) => { $('access-message').textContent = error.message; });
  for (const element of document.querySelectorAll('[data-access]')) element.hidden = element.id !== id;
  $('provider-buttons').hidden = !providerList.length || !['login-form', 'signup-form'].includes(id);
  $('unlock-form').hidden = true;
  $('device-limit').hidden = true;
  $('access-message').textContent = '';
  $(id).querySelector('input:not([type="checkbox"]):not([type="radio"]), select, textarea')?.focus();
}

// A remembered connection sealed with a password; one from Google or GitHub only marks "stay signed in".
const unlockable = (saved) => Boolean(saved) && !saved.provider;

function showUnlock() {
  for (const element of document.querySelectorAll('[data-access]')) element.hidden = true;
  $('provider-buttons').hidden = true;
  $('unlock-form').hidden = false;
  $('unlock-password').focus();
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-show]');
  if (target) showAccess(target.dataset.show);
});

// A remembered browser keeps the connection sealed with the account password, like a device unlock passphrase.
// Without a password (Google or GitHub) it only stays signed in.
async function finishAccess(connected, { password, remember, recoveryCode }) {
  if (remember) await store('put', 'connection', password === undefined ? { provider: true } : await sealLocal(connected.credentials, password));
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
        try { await connect(device.id); box.hidden = true; offerPlus('JotDrop Plus has no device limit.'); }
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
  const widget = await loadHumanCheck();
  const human = widget === null ? undefined : turnstile.getResponse(widget);
  if (widget !== null && !human) throw new Error('Confirm that you are a person first.');
  // A token works once: the next try gets a fresh check.
  try { askCode('signup', await signUp({ url: location.origin, email: $('signup-email').value.trim(), password, deviceName: DEVICE_NAME, newsletter: $('signup-newsletter').checked, human }), password, $('signup-remember').checked); }
  finally { if (widget !== null) turnstile.reset(widget); }
});
accessForm('code-form', async () => {
  const step = codeStep, code = $('code-input').value.trim();
  if (!step) throw new Error('Start again from the log in screen.');
  if (step.kind === 'login') await withDeviceChoice(async (replaceDeviceId) => finishAccess(await confirmLogin(step.pending, code, { replaceDeviceId }), step));
  else {
    const { client: connected, recoveryCode } = await confirmSignup(step.pending, code);
    await finishAccess(connected, { ...step, recoveryCode });
    secureOffer = step.password;
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
    waitForApproval(pending, (approved, replaceDeviceId) => completeApproval(approved, { ...options, replaceDeviceId }), { password: newPassword, remember }, 'Approved. Setting your new password...');
  }
});
$('cancel-approval').addEventListener('click', () => showAccess('login-form'));

// Shows the four words and waits until a signed-in device approves; `complete` connects this browser.
function waitForApproval(pending, complete, access, approvedText) {
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
      $('approval-status').textContent = approvedText;
      await withDeviceChoice(async (replaceDeviceId) => finishAccess(await complete(approved, replaceDeviceId), access));
    } catch (error) { $('approval-status').textContent = error?.status === 401 ? 'The request was rejected or has expired. Go back and start again.' : accessError(error); }
  };
  setTimeout(poll, 3000);
}

// Sign in with Google or GitHub: the provider says who you are; the key to your notes comes from your own devices.
const providerReady = availableProviders(location.origin).then((list) => {
  providerList = list;
  for (const choice of document.querySelectorAll('[data-provider]')) choice.hidden = !list.includes(choice.dataset.provider);
  $('provider-buttons').hidden = !list.length || ($('login-form').hidden && $('signup-form').hidden);
}, () => {});
for (const choice of document.querySelectorAll('[data-provider]')) choice.addEventListener('click', async () => {
  try {
    const { verifier, href } = await startProviderSignIn({ url: location.origin, provider: choice.dataset.provider, client: 'web' });
    // Only this tab can use the ticket that comes back.
    sessionStorage.setItem('jotdrop-provider-verifier', verifier);
    location.assign(href);
  } catch (error) { $('access-message').textContent = accessError(error); }
});

// Back from Google or GitHub: the ticket is in the address; it works only with this tab's verifier.
async function providerReturn() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has('oauth') && !params.has('oauth-error')) return false;
  history.replaceState(null, '', '/');
  let verifier = null;
  try { verifier = sessionStorage.getItem('jotdrop-provider-verifier'); sessionStorage.removeItem('jotdrop-provider-verifier'); } catch { verifier = null; }
  await providerReady;
  showAccess('login-form');
  if (params.has('oauth-error')) { $('access-message').textContent = params.get('oauth-error'); return true; }
  if (!verifier) { $('access-message').textContent = 'This sign-in was started in another tab or browser. Start again here.'; return true; }
  providerSignIn = await providerTicket({ url: location.origin, ticket: params.get('oauth'), verifier });
  showAccess('provider-step');
  $('provider-title').textContent = providerSignIn.account ? 'Open your notes on this browser' : 'Create your JotDrop cloud';
  $('provider-text').textContent = `Signed in with ${PROVIDER_NAMES[providerSignIn.provider]} as ${providerSignIn.email}.`;
  $('provider-new').hidden = providerSignIn.account;
  $('provider-existing').hidden = !providerSignIn.account;
  return true;
}

function providerAction(id, action) {
  $(id).addEventListener('click', async () => {
    $(id).disabled = true;
    $('access-message').textContent = 'Working securely on this device...';
    try {
      if (!providerSignIn) throw new Error('Start again with the Google or GitHub button.');
      await action();
    } catch (error) { $('access-message').textContent = accessError(error); }
    finally { $(id).disabled = false; }
  });
}
const providerAccess = () => ({ remember: $('provider-remember').checked });
providerAction('provider-create', async () => {
  const { client: connected, recoveryCode } = await providerSignUp(providerSignIn, { deviceName: DEVICE_NAME, newsletter: $('provider-newsletter').checked });
  providerSignIn = undefined;
  await finishAccess(connected, { ...providerAccess(), recoveryCode });
});
providerAction('provider-recover', async () => {
  const recoveryCode = $('provider-recovery').value.trim();
  await withDeviceChoice(async (replaceDeviceId) => finishAccess(await providerRecover(providerSignIn, { recoveryCode, deviceName: DEVICE_NAME, replaceDeviceId }), providerAccess()));
});
providerAction('provider-approve', async () => {
  const pending = await providerApproval(providerSignIn);
  providerSignIn = undefined;
  waitForApproval(pending, (approved, replaceDeviceId) => completeApproval(approved, { deviceName: DEVICE_NAME, replaceDeviceId }), providerAccess(), 'Approved. Opening your notes...');
});

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
      message('Approved. The new device can now open your notes.');
      await renderApprovals();
    }, 'primary'));
    row.append(button('Reject', async () => { await rejectDevice(client, approval.id); await renderApprovals(); }, 'danger'));
    return row;
  }));
  return approvals.length;
}

// Which account this browser is in, next to Log out: a cloud without an account (pairing only) shows nothing.
function showAccountEmail(account) {
  const label = $('account-email');
  label.textContent = account?.email ?? '';
  label.title = account?.email ? `Logged in as ${account.email}` : '';
  label.hidden = !account?.email;
}

async function renderAccount() {
  let account;
  try { account = await accountInfo(client); } catch (error) { if (error.status !== 404) throw error; }
  showAccountEmail(account);
  const linked = (account?.providers ?? []).map((name) => PROVIDER_NAMES[name] ?? name);
  $('account-status').textContent = account ? `Logged in as ${account.email}.${linked.length ? ` You can also sign in with ${linked.join(' and ')}.` : ''}` : 'This cloud has no account yet. New devices connect with a pairing code or your recovery code.';
  // An account made with Google or GitHub gets a password through "Forgot password".
  const noPassword = Boolean(account && !account.password);
  $('no-password-note').hidden = !noPassword;
  $('new-recovery-form').hidden = noPassword;
  $('attach-form').hidden = Boolean(account || attaching);
  $('attach-code-form').hidden = Boolean(account || !attaching);
  $('password-form').hidden = !account || noPassword;
  $('totp-form').hidden = !account || noPassword;
  $('new-recovery-password-row').hidden = !account;
  $('new-recovery-password').required = Boolean(account);
  $('delete-password-row').hidden = !account || noPassword;
  $('delete-password').required = Boolean(account) && !noPassword;
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
  attaching = await attachAccount(client, { email: $('attach-email').value.trim(), password, newsletter: $('attach-newsletter').checked });
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
workspaceForm('delete-account-form', async () => {
  if ($('delete-confirm').value.trim() !== 'DELETE') throw new Error('Type DELETE to confirm.');
  if (!confirm('Delete your account and everything in your JotDrop Cloud? This cannot be undone.')) return;
  const field = $('delete-password');
  await deleteAccount(client, field.required ? { password: field.value } : {});
  // The cloud is gone: forget this browser's connection and its encrypted copies of it.
  for (const prefix of [cachePrefix(), pendingPrefix()]) for (const [key] of await store('entries', prefix)) await store('delete', key);
  await store('delete', 'connection');
  field.value = $('delete-confirm').value = '';
  lock('Your account and cloud were deleted. The notes on your own devices were not touched.');
});
$('totp-setup').addEventListener('click', () => setupTotp(client).then(({ secret, qr }) => {
  $('totp-secret').value = secret;
  $('totp-qr').replaceChildren(qrCode(qr));
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
  $('totp-qr').replaceChildren();
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
$('lock').addEventListener('click', () => lock());
// Log out forgets this browser: its connection, staying signed in and its device slot. The notes stay in the cloud.
$('log-out').addEventListener('click', async () => {
  try {
    if ((await store('entries', pendingPrefix())).length) throw new Error('Some changes are still waiting to upload. Sync them first, then log out.');
    if (!confirm('Log out of this browser? Your notes stay in the cloud. To come back, log in again.')) return;
    await store('delete', 'connection');
    await store('delete', 'session');
    forgetOnClose = true;
    lock();
  } catch (error) { message(errorText(error)); }
});
async function startTrial() {
  try {
    await client.call('/account/trial', 'POST', {});
    plusReason = '';
    message('JotDrop Plus is on for 14 days. No payment details needed.');
    await sync();
  } catch (error) { message(errorText(error)); }
}
// The buy buttons stay in the menu; this brings them into view.
function showPlusOffer() {
  if ($('editor').open) closeEditor();
  if ($('editor').open) return;
  showSidebar(true);
  $('buy-month').focus();
}
$('start-trial').addEventListener('click', startTrial);
$('get-plus').addEventListener('click', showPlusOffer);
$('plus-not-now').addEventListener('click', () => { plusReason = ''; plusQuiet = true; showPlusNudge(); });
// Stripe shows the payment page and is the seller; Plus turns on when Stripe confirms the payment to the server.
for (const [id, interval] of [['buy-month', 'month'], ['buy-year', 'year']]) $(id).addEventListener('click', async () => {
  try { location.assign((await client.call('/account/checkout', 'POST', { interval })).url); }
  catch (error) { message(errorText(error)); }
});
$('sync').addEventListener('click', () => { syncPaused = false; $('sync').textContent = 'Sync now'; message(); void sync(); });
$('pause-sync').addEventListener('click', () => { syncPaused = true; syncController?.abort(); });
$('search').addEventListener('input', render);
$('sort').addEventListener('change', render);
$('new-note').addEventListener('click', () => openEditor());
// Like the Android main screen: start the camera or the recording in a new note right away.
$('new-photo-text').addEventListener('click', () => { openEditor(); $('photo-tools').open = true; $('start-camera').click(); });
$('new-voice').addEventListener('click', () => { openEditor(); $('start-voice').click(); });
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
    if (photo.size > maxFileBytes) throw fileTooLarge(`This photo is larger than ${maxFileText()}, your plan's maximum per file. Choose a smaller photo; the original has not been uploaded.`);
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
    appendToNote(`\n\n![Source photo](../${path})\n`);
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
        if (text) appendToNote(`\n${text}\n`);
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
async function saveEditor() {
  try {
    if (photoJob || voiceJob) throw new Error('Finish text recognition or keep your recording before saving the note.');
    // A new note is named like in the plugin and Android, unless a filename was typed.
    if (!editing && !pathTyped) {
      const name = noteFilename($('note-content').value);
      let path = `notes/${name}`;
      for (let copy = 2; [...files.values()].some((entry) => entry.file.path === path); copy++) path = `notes/${name.slice(0, -3)} ${copy}.md`;
      $('note-path').value = path;
    }
    if (!isMarkdown($('note-path').value)) throw new Error('Notes must use a .md filename.');
    if (editingRevision === undefined) freshNotes.set($('note-path').value, Date.now());
    await queueFile($('note-path').value, encoder.encode($('note-content').value), editingRevision);
    return true;
  } catch (error) { freshNotes.delete($('note-path').value); $('editor-message').textContent = errorText(error); return false; }
}
$('editor-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  event.submitter.disabled = true;
  try {
    if (!await saveEditor()) return;
    resetPhoto();
    $('editor').close();
    $('note-content').value = '';
    editing = undefined;
  } finally { event.submitter.disabled = false; }
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
    const choice = plusChoice();
    if (choice && result.versions.some((version) => version.locked)) {
      const offer = document.createElement('div');
      offer.className = 'history-plus';
      offer.append(paragraph('JotDrop Plus keeps every version.'), choice === 'trial' ? button('Try JotDrop Plus free for 14 days', startTrial, 'primary') : button('Get JotDrop Plus', showPlusOffer, 'primary'));
      $('history-list').append(offer);
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
$('resolve-now').addEventListener('click', () => {
  const entry = [...files.values()].find((item) => item.conflict);
  if (entry) reviewConflict(entry).catch((error) => message(errorText(error)));
});

$('upload').addEventListener('change', async () => {
  try {
    for (const file of $('upload').files) {
      if (file.size > maxFileBytes) throw fileTooLarge(`"${file.name}" is larger than ${maxFileText()}, your plan's maximum per file.`);
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
          if (bytes.length > maxFileBytes) { tooLarge += 1; broken.add(source); continue; }
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
    + (broken.size ? ` ${broken.size} attachments could not be added${tooLarge ? ` (${tooLarge} over ${maxFileText()})` : ''}.` : ''));
  if (tooLarge) offerPlus(filePlus);
  await sync();
  void sync();
}
for (const navigation of document.querySelectorAll('[data-view]')) navigation.addEventListener('click', () => {
  view = navigation.dataset.view;
  labelFilter = '';
  selectedIds.clear();
  message();
  render();
  if (view === 'devices') void Promise.all([renderDevices(), renderAccount()]).catch((error) => message(errorText(error)));
});
$('edit-labels').addEventListener('click', () => {
  $('labels-message').textContent = '';
  renderLabelRows();
  $('labels-dialog').showModal();
});
$('close-labels').addEventListener('click', () => $('labels-dialog').close());
$('new-label-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('labels-message').textContent = '';
  try {
    const name = $('new-label').value.trim();
    if (!name || /[\x00-\x1f]/.test(name)) throw new Error('Type a label name.');
    if (allLabels().some((label) => label.toLowerCase() === name.toLowerCase())) throw new Error('That label already exists.');
    await saveLocalLabels([...localLabels, name]);
    $('new-label').value = '';
    render();
    renderLabelRows();
  } catch (error) { $('labels-message').textContent = errorText(error); }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && selectedIds.size && !openMenu && !document.querySelector('dialog[open]')) { selectedIds.clear(); render(); }
});
// The sidebar folds away like Keep's menu; this browser remembers the choice.
function showSidebar(open) {
  $('sidebar').hidden = !open;
  $('workspace').classList.toggle('sidebar-hidden', !open);
  $('toggle-sidebar').setAttribute('aria-expanded', String(open));
  // Words and an arrow into or out of the panel, not only a symbol (Eric found the bare menu icon unclear).
  $('toggle-sidebar').querySelector('svg').innerHTML = `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="${open ? 'm16 15-3-3 3-3' : 'm14 9 3 3-3 3'}"/>`;
  $('toggle-sidebar').querySelector('span').textContent = open ? 'Hide menu' : 'Show menu';
}
let sidebarShown = true;
try { sidebarShown = localStorage.getItem('jotdrop-sidebar') !== 'hidden'; } catch { /* Shown by default. */ }
showSidebar(sidebarShown);
$('toggle-sidebar').addEventListener('click', () => {
  const open = $('sidebar').hidden;
  showSidebar(open);
  try { localStorage.setItem('jotdrop-sidebar', open ? 'shown' : 'hidden'); } catch { /* Keep the choice for this page. */ }
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
$('finish-recovery').addEventListener('click', () => {
  $('recovery-dialog').close();
  $('recovery-code').value = '';
  if (secureOffer === undefined) return;
  $('secure-choice').hidden = false;
  $('secure-form').hidden = true;
  $('secure-dialog').showModal();
});
$('secure-later').addEventListener('click', () => $('secure-dialog').close());
$('secure-skip').addEventListener('click', () => $('secure-dialog').close());
$('secure-dialog').addEventListener('close', () => {
  secureOffer = undefined;
  $('secure-secret').value = $('secure-code').value = $('secure-message').textContent = '';
  $('secure-qr').replaceChildren();
});
$('secure-start').addEventListener('click', async () => {
  $('secure-start').disabled = true;
  try {
    const { secret, qr } = await setupTotp(client);
    $('secure-qr').replaceChildren(qrCode(qr));
    $('secure-secret').value = secret;
    $('secure-choice').hidden = true;
    $('secure-form').hidden = false;
    $('secure-code').focus();
  } catch (error) { message(accountError(error)); $('secure-dialog').close(); }
  finally { $('secure-start').disabled = false; }
});
$('secure-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  $('secure-message').textContent = 'Checking the code...';
  try {
    await enableTotp(client, { password: secureOffer, code: $('secure-code').value.trim() });
    $('secure-dialog').close();
    message('Authenticator app turned on. A new device now asks for a code from the app.');
  } catch (error) { $('secure-message').textContent = accountError(error); }
  finally { submit.disabled = false; }
});
window.addEventListener('online', () => { if (client) void sync(); });
window.addEventListener('pagehide', () => { syncController?.abort(); resetPhoto(); discardVoice(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopCamera(); if (voiceJob?.recorder?.state === 'recording') voiceJob.recorder.stop(); } });
window.addEventListener('beforeunload', (event) => {
  const unsaved = $('editor').open && (voiceJob || $('note-content').value !== (editing ? noteText(editing.file) : ''));
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
  const credentials = (await providerReturn().catch((error) => { $('access-message').textContent = accessError(error); return true; })) ? undefined : await signedInCredentials().catch(() => undefined);
  // A connection that no longer opens is forgotten and says why; the password still unlocks this browser.
  if (credentials) await openWorkspace(new CloudClient(credentials)).catch((error) => lock(`This browser could not open your notes by itself: ${errorText(error)} Unlock with your password.`));
  else if ($('provider-step').hidden && unlockable(await store('get', 'connection'))) showUnlock();
} catch (error) { $('access-message').textContent = errorText(error); $('connect-form').querySelector('button[type="submit"]').disabled = true; }
// Not signed in after all: now the login shows, never before (a refresh would otherwise flash it).
finally { $('opening').hidden = true; if ($('workspace').hidden) $('access').hidden = false; }

import { addItem, guestName, openList, readListLinkAddress, reportList, tickItem } from '/shared/list-links.mjs';
import { changedAgo } from '/note.mjs';

// The page for a shared list. What the owner wrote is only ever put on the page as text; ticks and new items go
// back sealed with the key after the #. The only thing this browser keeps is the guest's own name.
const $ = (id) => document.getElementById(id);
const NAME_KEY = 'jotdrop-list-name';
const REFRESH_MS = 15000;
const image = /^\s*!\[/;
let address, list, busy = false;

const when = (at) => changedAgo(new Date(at).toISOString());
const storedName = () => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } };
const name = () => guestName($('list-name').value);

function item(line) {
  if (!line.task) {
    const element = document.createElement('p');
    element.textContent = line.text;
    element.hidden = image.test(line.text);
    return element;
  }
  const row = document.createElement('label');
  row.className = `list-link-task${line.ticked ? ' done' : ''}`;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = line.ticked;
  input.addEventListener('change', () => change(() => tickItem(location.origin, address.id, address.key, list, line, input.checked, { name: name() }), () => { input.checked = !input.checked; }));
  const text = document.createElement('span');
  text.className = 'list-link-text';
  text.textContent = line.text;
  row.append(input, text);
  // Who did it, in words and with a mark, never only in colour: "✓ Anna, 2 min. ago" or "added by Anna, 2 min. ago".
  if (line.mark && (line.ticked || line.mark.added)) {
    const by = document.createElement('span');
    by.className = 'list-link-by';
    by.textContent = line.ticked ? `✓ ${line.mark.by}, ${when(line.mark.at)}` : `added by ${line.mark.by}, ${when(line.mark.at)}`;
    row.append(by);
  }
  return row;
}

function show(opened) {
  list = opened;
  $('list-title').textContent = list.title;
  $('list-title').hidden = !list.title;
  document.title = list.title ? `${list.title} - JotDrop` : 'A list shared with JotDrop';
  $('list-body').replaceChildren(...list.lines.filter((line) => line.task || line.text.trim()).map(item));
  const latest = list.marks.reduce((best, mark) => Math.max(best, mark.at), 0);
  $('list-updated').textContent = latest ? `Updated ${when(latest)}.` : '';
  $('list-until').textContent = list.expiresAt ? `This link ends on ${new Date(list.expiresAt).toLocaleDateString()}.` : '';
  $('list-article').hidden = false;
  $('list-state').hidden = true;
}

function ended(error) {
  const gone = error.status === 404 || error.status === 410;
  $('list-state').textContent = gone ? 'This link has ended. Ask the sender for a new one.' : 'This list does not open. Check that you have the whole link.';
  $('list-state').hidden = false;
  $('list-article').hidden = true;
  if (gone) $('list-report-box').hidden = true;
}

// One change at a time; the newest version comes back with it. A change that does not save is undone on the page.
async function change(action, undo) {
  if (busy) { undo?.(); return; }
  busy = true;
  $('list-message').textContent = '';
  try { show(await action()); }
  catch (error) {
    undo?.();
    if (error.status === 404 || error.status === 410) ended(error);
    else $('list-message').textContent = error.status ? 'Could not save. Try again.' : error.message;
  } finally { busy = false; }
}

// Every 15 seconds while the page is on screen, and as soon as it comes back: what others ticked meanwhile.
async function refresh() {
  if (busy || document.hidden || !list) return;
  try {
    const opened = await openList(location.origin, address.id, address.key, { minRevision: list.revision });
    if (!busy && opened.revision > list.revision) show(opened);
  } catch (error) { if (error.status === 404 || error.status === 410) ended(error); }
}

async function start() {
  try { address = readListLinkAddress(location.href); } catch { $('list-state').textContent = 'This link is not complete. Ask for the whole link again.'; return; }
  $('list-name').value = storedName();
  $('list-name').addEventListener('change', () => { try { localStorage.setItem(NAME_KEY, $('list-name').value.trim()); } catch { /* a browser that keeps nothing */ } });
  $('list-add').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = $('list-item').value;
    void change(() => addItem(location.origin, address.id, address.key, list, text, { name: name() })).then(() => { if (!$('list-message').textContent) $('list-item').value = ''; });
  });
  $('list-report-box').hidden = false;
  $('list-report').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('list-report-message').textContent = 'Sending...';
    try {
      await reportList(location.origin, address.id, { reason: $('list-report-reason').value, details: $('list-report-details').value });
      $('list-report-message').textContent = 'Thanks. We read every report.';
    } catch (error) { $('list-report-message').textContent = error.message; }
  });
  try { show(await openList(location.origin, address.id, address.key)); } catch (error) { ended(error); return; }
  setInterval(refresh, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
}
void start();

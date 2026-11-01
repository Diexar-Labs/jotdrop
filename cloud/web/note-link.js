import { openLink, readLinkAddress, reportLink } from '/shared/links.mjs';

// The page for a shared note. What the sender wrote is only ever put on the page as text.
const $ = (id) => document.getElementById(id);
const task = /^\s*-\s+\[([ xX])\](?:\s+(.*))?$/;

function line(text) {
  const match = task.exec(text);
  const element = document.createElement(match ? 'div' : 'p');
  if (match) {
    const done = match[1] !== ' ';
    element.className = `note-link-task${done ? ' done' : ''}`;
    element.textContent = `${done ? '☑' : '☐'} ${match[2] ?? ''}`;
  } else element.textContent = text;
  return element;
}

async function show() {
  let address;
  try { address = readLinkAddress(location.href); } catch { $('note-state').textContent = 'This link is not complete. Ask for the whole link again.'; return; }
  $('note-report-box').hidden = false;
  $('note-report').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('note-report-message').textContent = 'Sending...';
    try {
      await reportLink(location.origin, address.id, { reason: $('note-report-reason').value, details: $('note-report-details').value });
      $('note-report-message').textContent = 'Thanks. We read every report.';
    } catch (error) { $('note-report-message').textContent = error.message; }
  });
  try {
    const note = await openLink(location.origin, address.id, address.key);
    $('note-title').textContent = note.title;
    $('note-title').hidden = !note.title;
    if (note.title) document.title = `${note.title} - JotDrop`;
    $('note-body').replaceChildren(...note.text.split(/\r?\n/).filter((text) => text.trim()).map(line));
    $('note-until').textContent = note.expiresAt ? `This link ends on ${new Date(note.expiresAt).toLocaleDateString()}.` : '';
    $('note-article').hidden = false;
    $('note-state').hidden = true;
  } catch (error) {
    $('note-state').textContent = error.status === 404 || error.status === 410 ? 'This link has ended. Ask the sender for a new one.' : 'This note does not open. Check that you have the whole link.';
    if (error.status === 404 || error.status === 410) $('note-report-box').hidden = true;
  }
}
void show();

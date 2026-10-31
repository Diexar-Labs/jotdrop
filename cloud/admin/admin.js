// Read-only owner dashboard. Everything goes on the page as text (textContent), never as HTML.
const $ = (id) => document.getElementById(id);
const state = { page: 1, pages: 1 };

async function api(path, body) {
  const response = await fetch(path, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.error || `Request failed (${response.status})`), { status: response.status });
  return value;
}

const bytes = (value) => {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let size = value, unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${unit ? size.toFixed(size < 10 ? 1 : 0) : size} ${units[unit]}`;
};
const day = (iso) => iso ? iso.slice(0, 10) : 'Never';
const when = (iso) => iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : 'Never';
const percent = (part, whole) => whole ? `${Math.round(part / whole * 100)}%` : '0%';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function show(signedIn, message = '') {
  $('login').hidden = signedIn;
  $('dashboard').hidden = !signedIn;
  $('log-out').hidden = !signedIn;
  $('login-message').textContent = message ? `Error: ${message}` : '';
  if (!signedIn) { $('password').value = ''; $('code').value = ''; $('password').focus(); }
}

// A 401 means the session ended (8 hours, or 30 minutes without use); go back to the sign-in form.
function failed(error) {
  if (error.status === 401) show(false, 'Your session ended. Sign in again.');
  else $('dashboard-message').textContent = `Error: ${error.message}`;
}

function tile(label, value, note) {
  const box = element('div');
  box.append(element('dt', label));
  const dd = element('dd', value);
  if (note) dd.append(element('small', note));
  box.append(dd);
  return box;
}

async function loadSummary() {
  const { generatedAt, accounts, founder, storage } = await api('/api/admin/summary');
  $('generated').textContent = `Updated ${when(generatedAt)}`;
  $('tiles').replaceChildren(
    tile('Accounts', String(accounts.total)),
    tile('New, last 7 days', String(accounts.newLast7Days)),
    tile('New, last 30 days', String(accounts.newLast30Days)),
    tile('Plus', String(accounts.plus), `${accounts.paying} paying, rest trial or granted`),
    tile('Free', String(accounts.free)),
    tile('Founder places', founder.limit === null ? `${founder.taken} taken` : `${founder.taken} of ${founder.limit}`, founder.limit === null ? 'No founder price set' : `${founder.limit - founder.taken} left`),
    tile('Stored notes (encrypted)', bytes(storage.storedBytes), `Database file ${bytes(storage.databaseBytes)}`),
    tile('Disk free', bytes(storage.diskFreeBytes), `of ${bytes(storage.diskTotalBytes)} (${percent(storage.diskFreeBytes, storage.diskTotalBytes)} free)`),
  );
}

function row(account) {
  const tr = element('tr');
  const cell = (text, note, className) => { const td = element('td', text, className); if (note) td.append(element('small', note)); tr.append(td); };
  const methods = [account.hasPassword ? 'Password' : 'No password', ...account.providers.map((name) => name === 'github' ? 'GitHub' : name === 'google' ? 'Google' : name)];
  cell(account.email, undefined, 'email');
  cell(day(account.createdAt));
  cell(methods.join(', '), account.hasAuthenticator ? 'Authenticator app on' : undefined);
  cell(account.plan === 'plus' ? 'Plus' : 'Free', account.plan === 'plus' ? `until ${day(account.plusUntil)}${account.subscribed ? ', paying' : ''}` : account.plusUntil ? `Plus ended ${day(account.plusUntil)}` : undefined);
  cell(`${bytes(account.usedBytes)} of ${bytes(account.quotaBytes)}`, `${percent(account.usedBytes, account.quotaBytes)} used${account.spaces ? `, ${account.spaces} shared` : ''}`);
  cell(`${account.activeDevices} active`);
  cell(when(account.lastActiveAt));
  cell(account.newsletter ? 'Yes' : 'No');
  return tr;
}

async function loadAccounts() {
  const [sort, order] = $('sort').value.split(':');
  const query = new URLSearchParams({ q: $('search').value.trim(), sort, order, page: String(state.page) });
  const { accounts, total, page, pageSize } = await api(`/api/admin/accounts?${query}`);
  state.pages = Math.max(1, Math.ceil(total / pageSize));
  $('accounts').replaceChildren(...accounts.map(row));
  const first = total ? (page - 1) * pageSize + 1 : 0;
  $('list-status').textContent = total ? `Showing ${first} to ${first + accounts.length - 1} of ${total} accounts (page ${page} of ${state.pages}).` : 'No accounts match.';
  $('previous').disabled = page <= 1;
  $('next').disabled = page >= state.pages;
}

async function load() {
  $('dashboard-message').textContent = '';
  await loadSummary();
  await loadAccounts();
  show(true);
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter ?? $('login-form').querySelector('button');
  button.disabled = true;
  try {
    await api('/api/admin/login', { password: $('password').value, code: $('code').value.trim() });
    $('password').value = ''; $('code').value = '';
    state.page = 1;
    await load();
  } catch (error) { show(false, error.message); }
  finally { button.disabled = false; }
});

$('log-out').addEventListener('click', async () => {
  try { await api('/api/admin/logout', {}); } catch { /* The session is gone from this page either way. */ }
  $('accounts').replaceChildren(); $('tiles').replaceChildren();
  show(false);
});

$('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  state.page = 1;
  loadAccounts().catch(failed);
});
$('sort').addEventListener('change', () => { state.page = 1; loadAccounts().catch(failed); });
let typing;
$('search').addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => { state.page = 1; loadAccounts().catch(failed); }, 300); });
$('previous').addEventListener('click', () => { state.page = Math.max(1, state.page - 1); loadAccounts().catch(failed); });
$('next').addEventListener('click', () => { state.page = Math.min(state.pages, state.page + 1); loadAccounts().catch(failed); });

load().catch((error) => show(false, error.status === 401 ? '' : error.message));

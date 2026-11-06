// Owner dashboard: reads, plus the two actions after a report. Everything goes on the page as text (textContent), never as HTML.
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

// What each counted refusal means; a kind this page does not know yet shows its own name.
const LIMITS = {
  storage: 'Storage full', devices: 'One device too many', 'file-size': 'File too large', links: 'A second link', 'link-days': 'A link longer than 7 days',
  'shared-spaces': 'A second shared note', 'old-trash': 'Restore a note deleted over 30 days ago', 'old-version': 'Open a version older than 30 days',
  voting: 'Vote on the roadmap', mail: 'Turn on Mail to JotDrop', 'family-invite': 'Invite people without a family plan',
};
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
// What each app calls itself in its X-JotDrop-Client header; an app this page does not know yet shows its own name.
const APPS = { obsidian: 'Obsidian plugin', android: 'Android app', web: 'Web app', joplin: 'Joplin plugin', clipper: 'Web Clipper for Chrome', ios: 'iOS app' };
const appName = (app) => app ? APPS[app] ?? app : 'Not reported';

function table(id, rows, empty) {
  $(id).replaceChildren(...rows);
  $(`${id}-empty`).hidden = rows.length > 0;
  $(`${id}-empty`).textContent = empty;
  $(`${id}-wrap`).hidden = rows.length === 0;
}

function tableRow(cells) {
  const tr = element('tr');
  for (const [text, note, className] of cells) { const td = element('td', text, className); if (note) td.append(element('small', note)); tr.append(td); }
  return tr;
}

// Most accounts over the four weeks first; every cell says accounts and times in words.
function showLimits({ weeks, kinds }) {
  $('limits-head').replaceChildren(Object.assign(element('th', 'Limit'), { scope: 'col' }), ...weeks.map((start, index) => Object.assign(element('th', index === 0 ? `This week (from ${day(start)})` : `Week of ${day(start)}`), { scope: 'col' })));
  const total = (kind) => kind.perWeek.reduce((sum, week) => sum + week.accounts, 0);
  table('limits', [...kinds].sort((a, b) => total(b) - total(a) || a.kind.localeCompare(b.kind)).map((kind) => tableRow([[LIMITS[kind.kind] ?? kind.kind, undefined, 'label'],
    ...kind.perWeek.map((week) => week.times ? [plural(week.accounts, 'account', 'accounts'), plural(week.times, 'time', 'times')] : ['None'])])),
  'No free account ran into a limit in the last four weeks.');
}

function showTrials(trialsEnding) {
  table('trials', trialsEnding.map((trial) => tableRow([[trial.email, undefined, 'email'], [when(trial.trialUntil)], [bytes(trial.usedBytes)], [`${trial.activeDevices} active`], [when(trial.lastActiveAt)], [trial.subscribed ? 'Yes, paying' : 'No']])),
    'No trial ends in the next 7 days.');
}

function showSubscriptions(subscriptions) {
  const interval = { month: 'Monthly', year: 'Yearly' };
  table('subscriptions', subscriptions.map((group) => tableRow([[group.plan === 'family' ? 'Family' : 'Plus'], [interval[group.interval] ?? 'Not known yet', group.interval ? undefined : 'Filled in at the next Stripe check'],
    [group.currency ? group.currency.toUpperCase() : 'Not known yet'], [String(group.count), group.pastDue ? `${group.pastDue} past due` : undefined]])),
  'Nobody pays yet.');
}

// Newest version of each app first; an older version says so in words, next to the newest one seen.
function showApps(apps) {
  table('apps', apps.map((row) => tableRow([[appName(row.app), undefined, 'label'], [row.version ?? (row.app ? 'None' : 'Not reported'), row.behind ? `Older than ${row.newest}` : row.app === 'web' ? 'A reload always brings the current page' : undefined],
    [`${row.devices} signed in`, `${row.usedLast30Days} used in the last 30 days`], [String(row.accounts)], [when(row.lastSeenAt)]])),
  'No device is signed in.');
}

// The nightly backup: the result in words, and LATE when its log has not changed for 26 hours (a night was skipped).
function backupTile({ state, at, detail, logChangedAt }, generatedAt) {
  if (state === 'not-set-up') return tile('Last backup', 'Not set up', 'Set JOTDROP_CLOUD_BACKUP_LOG on the server');
  if (state === 'no-log') return tile('Last backup', 'Unknown', 'The backup log cannot be read');
  const hours = Math.floor((Date.parse(generatedAt) - Date.parse(logChangedAt)) / 3600000), late = hours >= 26;
  const value = state === 'failed' ? 'FAILED' : late ? 'LATE' : state === 'ok' ? 'OK' : 'Unknown';
  const notes = [at ? `Result of ${at} (time of the backup machine)` : 'No result in the log yet', detail ? `Failed step: ${detail}` : '', late ? `Log unchanged for ${hours} hours` : ''];
  return tile('Last backup', value, notes.filter(Boolean).join('. '));
}

async function loadSummary() {
  const { generatedAt, accounts, trials, trialsEnding, limits, subscriptions, family, links, backup, apps, roadmap, storage } = await api('/api/admin/summary');
  $('generated').textContent = `Updated ${when(generatedAt)}`;
  $('tiles').replaceChildren(
    tile('Accounts', String(accounts.total)),
    tile('New, last 7 days', String(accounts.newLast7Days)),
    tile('New, last 30 days', String(accounts.newLast30Days)),
    tile('Plus', String(accounts.plus), `${accounts.paying} paying, rest trial or granted`),
    tile('Free', String(accounts.free)),
    tile('Trials running', String(trials.running), `${trials.total} started, ${trials.paidAfter} of those pay or paid (${percent(trials.paidAfter, trials.total)})`),
    tile('Trials ending, next 7 days', String(trialsEnding.length), `${trialsEnding.filter((trial) => trial.subscribed).length} of those already pay`),
    tile('Family plans', String(family.plans), `${plural(family.members, 'member', 'members')} besides those who pay`),
    tile('Copy links working', String(links.copies.active), `${plural(links.copies.accounts, 'account', 'accounts')}, ${links.copies.newLast7Days} made in the last 7 days`),
    tile('Live lists working', String(links.lists.active), `${plural(links.lists.accounts, 'account', 'accounts')}, ${links.lists.newLast7Days} made in the last 7 days`),
    backupTile(backup, generatedAt),
    tile('Stored notes (encrypted)', bytes(storage.storedBytes), `Database file ${bytes(storage.databaseBytes)}`),
    tile('Disk free', bytes(storage.diskFreeBytes), `of ${bytes(storage.diskTotalBytes)} (${percent(storage.diskFreeBytes, storage.diskTotalBytes)} free)`),
  );
  showLimits(limits);
  showTrials(trialsEnding);
  showSubscriptions(subscriptions);
  showApps(apps);
  // Most votes first; the count is written out, so the order never depends on a colour or a bar.
  $('roadmap').replaceChildren(...[...roadmap].sort((a, b) => b.votes - a.votes).map((item) => {
    const li = element('li', `${item.title}: `);
    li.append(element('strong', `${item.votes} ${item.votes === 1 ? 'vote' : 'votes'}`));
    return li;
  }));
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
  cell(`${account.activeDevices} active`, account.apps.map((entry) => `${appName(entry.app)}${entry.version ? ` ${entry.version}` : ''}`).join(', ') || undefined);
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
  for (const id of ['accounts', 'tiles', 'limits', 'trials', 'subscriptions', 'apps']) $(id).replaceChildren();
  show(false);
});

// Typed in full, because neither can be undone.
for (const [form, field, path, key, word, done] of [
  ['group-form', 'group-id', '/api/admin/delete-group', 'spaceId', 'DELETE GROUP', 'The group is deleted and its people were told.'],
  ['link-form', 'link-id', '/api/admin/delete-link', 'linkId', 'DELETE LINK', 'The link is deleted and its owner was told.'],
  ['list-form', 'list-id', '/api/admin/delete-list', 'listId', 'DELETE LIST', 'The list link is deleted and its owner was told.'],
  ['close-form', 'close-email', '/api/admin/close-account', 'email', 'CLOSE ACCOUNT', 'The account is closed and its owner was told.'],
]) $(form).addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = $(field).value.trim();
  if (prompt(`This cannot be undone. Type ${word} to go on with ${value}.`) !== word) return;
  try {
    await api(path, { [key]: value, confirm: word });
    $(field).value = '';
    $('moderation-message').textContent = done;
    await load();
  } catch (error) { $('moderation-message').textContent = error.message; }
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

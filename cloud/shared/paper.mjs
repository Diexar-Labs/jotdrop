// Paper drawer: scanned papers and notes that expire. The same rules as
// android/app/src/main/kotlin/com/diexar/keepcapture/PaperDrawer.kt and its check.

/** The label every scan and every note with an expiry date gets. */
export const PAPER_DRAWER = 'Paper drawer';

/** How long before `expires` the warning reminder goes off. */
export const WARN_OPTIONS = [
  { key: '1w', label: '1 week before' },
  { key: '1m', label: '1 month before' },
  { key: '2m', label: '2 months before' },
  { key: '3m', label: '3 months before' },
];

/** `expires` as a real calendar date "YYYY-MM-DD", or '' when it is missing or not a date. */
export function validExpires(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === text ? text : '';
}

const pad = (value) => String(value).padStart(2, '0');
/** Today on this device as "YYYY-MM-DD". */
export const localDay = (now = new Date()) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2027-03-12" as "12 Mar 2027". */
export const shortDate = (day) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;

/** The card badge: expired from the day after `expires`. Null without a valid date. Never colour alone: the text says it. */
export function expiresBadge(expires, today = localDay()) {
  const day = validExpires(expires);
  if (!day) return null;
  const expired = day < today;
  return { expired, text: `${expired ? 'Expired' : 'Expires'} ${shortDate(day)}` };
}

/** The reminder ("YYYY-MM-DDT09:00") for a warning `lead` before `expires`, or null. Months keep the day, or the last day of a shorter month. */
export function warnReminder(expires, lead) {
  const day = validExpires(expires);
  if (!day) return null;
  const year = Number(day.slice(0, 4)), month = Number(day.slice(5, 7)) - 1, date = Number(day.slice(8, 10));
  let at;
  if (lead === '1w') at = new Date(Date.UTC(year, month, date - 7));
  else {
    const months = { '1m': 1, '2m': 2, '3m': 3 }[lead];
    if (!months) return null;
    const last = new Date(Date.UTC(year, month - months + 1, 0)).getUTCDate();
    at = new Date(Date.UTC(year, month - months, Math.min(date, last)));
  }
  return `${at.toISOString().slice(0, 10)}T09:00`;
}

/** `labels` with the Paper drawer label added once; a small drawer or any letter case counts as present. */
export function withPaperDrawer(labels = []) {
  return labels.some(isPaperDrawer) ? [...labels] : [...labels, PAPER_DRAWER];
}

/** True for the Paper drawer label or one of its small drawers ("Paper drawer/Work"). */
export function isPaperDrawer(label) {
  const text = String(label ?? '').trim().toLowerCase(), base = PAPER_DRAWER.toLowerCase();
  return text === base || (text.startsWith(`${base}/`) && text.length > base.length + 1);
}

/** The small drawers a new user is offered; more can be added. */
export const SUGGESTED_DRAWERS = ['Personal', 'Work', 'Home'];
/** "Work" as its label "Paper drawer/Work". */
export const drawerLabel = (name) => `${PAPER_DRAWER}/${String(name).trim()}`;
/** The small drawer's own name ("Work"), or '' for the drawer itself or another label. */
export function drawerName(label) {
  const text = String(label ?? '').trim();
  return isPaperDrawer(text) && text.includes('/') ? text.slice(PAPER_DRAWER.length + 1).trim() : '';
}
/** Opening the Paper drawer shows every paper; a small drawer only its own. */
export function inDrawer(labels, selected) {
  if (!isPaperDrawer(selected)) return false;
  const want = String(selected).trim().toLowerCase();
  return labels.some((label) => drawerName(selected) ? String(label).trim().toLowerCase() === want : isPaperDrawer(label));
}

/** The first look at the drawer: what it does for you. Shown when it is empty, and as a tip until closed. */
export const INTRO = {
  title: 'Your paper drawer',
  lead: 'Scan a letter, a policy or a passport and it lands here.',
  points: [
    { icon: 'scan', text: 'The camera finds the edges of the page and straightens it, so every scan comes out as a clean PDF.' },
    { icon: 'search', text: 'Every word on the page is searchable. Type a policy number and the paper turns up.' },
    { icon: 'alarm', text: 'If the paper has an expiry date, JotDrop spots it and offers to remind you a week before.' },
  ],
  phone: 'Scanning works in the JotDrop app on your phone. Your scans show up here too.',
};

/** The default warning before an expiry date. */
export const DEFAULT_WARN = '1w';

const MONTH_NAMES = [
  ['jan', 'january', 'januari', 'enero', 'januar', 'janvier', 'ene'],
  ['feb', 'february', 'februari', 'febrero', 'februar', 'février', 'fevrier', 'fév', 'fev'],
  ['mar', 'march', 'maart', 'mrt', 'marzo', 'märz', 'marz', 'mars'],
  ['apr', 'april', 'abril', 'avril', 'abr', 'avr'],
  ['may', 'mei', 'mayo', 'mai', 'may'],
  ['jun', 'june', 'juni', 'junio', 'juin'],
  ['jul', 'july', 'juli', 'julio', 'juillet', 'juil'],
  ['aug', 'august', 'augustus', 'agosto', 'août', 'aout', 'ago'],
  ['sep', 'sept', 'september', 'septiembre', 'septembre'],
  ['oct', 'october', 'oktober', 'okt', 'octubre', 'octobre'],
  ['nov', 'november', 'noviembre', 'novembre'],
  ['dec', 'december', 'diciembre', 'dezember', 'décembre', 'decembre', 'dic', 'dez', 'déc'],
];
const monthOf = (word) => {
  const w = word.toLowerCase().replace(/\.$/, '');
  const index = MONTH_NAMES.findIndex((names) => names.includes(w));
  return index < 0 ? 0 : index + 1;
};
const KEYWORD = /valid\s+(?:until|thru|through|to)|date\s+of\s+expiry|expir(?:y|es|ation)(?:\s+date)?|exp\.?\s*date|best\s+before|use\s+by|geldig\s+(?:tot|t\/m)|vervaldatum|verloopt(?:\s+op)?|houdbaar\s+tot|te\s+gebruiken\s+tot|\bt\.?h\.?t\.?(?=[\s:])|caducidad|v[áa]lid[oa]\s+hasta|vencimiento|g[üu]ltig\s+bis|ablaufdatum|date\s+d['’]expiration|valable\s+jusqu/i;
const DATE = /(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4}|\d{2})(?!\d)|(\d{1,2})\.?\s+([A-Za-zÀ-ÿ]{3,10})\.?,?\s+(\d{4})/;

/** The first date in `text` as "YYYY-MM-DD", or ''. Day first, unless only a month-first reading makes sense. */
function firstDate(text) {
  const m = DATE.exec(text);
  if (!m) return '';
  let year, month, day;
  if (m[1]) [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if (m[4]) {
    const a = Number(m[4]), b = Number(m[5]);
    year = m[6].length === 2 ? 2000 + Number(m[6]) : Number(m[6]);
    [day, month] = b > 12 && a <= 12 ? [b, a] : [a, b];
  } else [day, month, year] = [Number(m[7]), monthOf(m[8]), Number(m[9])];
  return validExpires(`${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`);
}

const MRZ_VALUE = (c) => (c === '<' ? 0 : /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 55);
const mrzCheck = (field, digit) => String([...field].reduce((sum, c, i) => sum + MRZ_VALUE(c) * [7, 3, 1][i % 3], 0) % 10) === digit;
/** The expiry date in a passport (TD3) or ID card (TD1) machine-readable line, checked against its check digit. */
function mrzExpiry(lines) {
  for (const raw of lines) {
    const line = raw.replace(/\s/g, '').toUpperCase();
    let field, digit;
    if (/^[A-Z0-9<]{44}$/.test(line)) [field, digit] = [line.slice(21, 27), line[27]];
    else if (/^[0-9]{6}[0-9<][MF<][0-9]{6}[0-9][A-Z<]{3}[A-Z0-9<]{11}[0-9<]$/.test(line)) [field, digit] = [line.slice(8, 14), line[14]];
    else continue;
    if (!/^\d{6}$/.test(field) || !mrzCheck(field, digit)) continue;
    const day = validExpires(`20${field.slice(0, 2)}-${field.slice(2, 4)}-${field.slice(4, 6)}`);
    if (day) return day;
  }
  return '';
}

/** The expiry date JotDrop offers after a scan: from a passport line, else the latest date after words like "valid until" or "geldig tot". */
export function findExpiry(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const mrz = mrzExpiry(lines);
  if (mrz) return mrz;
  let best = '';
  lines.forEach((line, i) => {
    const hit = KEYWORD.exec(line);
    if (!hit) return;
    const found = firstDate(line.slice(hit.index + hit[0].length)) || firstDate(lines[i + 1] || '');
    if (found > best) best = found;
  });
  return best;
}

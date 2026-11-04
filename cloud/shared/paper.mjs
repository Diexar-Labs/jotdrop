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

export { findExpiry } from './expiry.mjs';

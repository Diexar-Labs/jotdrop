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

/** `labels` with the Paper drawer label added once (any letter case counts as present). */
export function withPaperDrawer(labels = []) {
  return labels.some((label) => label.toLowerCase() === PAPER_DRAWER.toLowerCase()) ? [...labels] : [...labels, PAPER_DRAWER];
}

/** True for the Paper drawer label, so the sidebar can give it its own drawer icon. */
export const isPaperDrawer = (label) => String(label ?? '').trim().toLowerCase() === PAPER_DRAWER.toLowerCase();

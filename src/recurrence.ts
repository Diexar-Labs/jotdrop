/**
 * Pure recurrence logic for JotDrop recurring reminders.
 *
 * Deliberately free of any Obsidian import so it can be exercised in a plain
 * Node check (`scripts/check-recurrence.cjs`). The scheduler, editor and badge
 * layer all build on this module.
 *
 * Cross-platform contract (mirrored by the Android app):
 * - `reminder` is always a local datetime "YYYY-MM-DDTHH:mm".
 * - ISO weekdays: 1 = Monday … 7 = Sunday.
 * - Advancement is anchored on the current stored `reminder`, never "now", so
 *   the series is a fixed sequence and a device asleep over several periods
 *   advances the same number of steps regardless of when it wakes.
 * - Local calendar arithmetic (JS `Date` with explicit y/m/d/h/m) keeps DST
 *   safe and clamps month ends (Jan 31 → Feb 28/29, Feb 29 → Feb 28).
 */

export type RepeatType =
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "every"
  | "ordinal";

export interface RepeatSpec {
  type: RepeatType;
  /** ISO weekdays (1=Mon..7=Sun), for "weekly". */
  weekdays?: number[];
  /** for "every" */
  every?: { n: number; unit: "days" | "weeks" | "months" };
  /** for "ordinal": k (1-5, 5 = last) and ISO weekday. */
  ordinal?: { k: number; weekday: number };
}

export interface RecurrenceState {
  reminder: string; // next local datetime "YYYY-MM-DDTHH:mm"
  repeat: string; // raw reminder_repeat value
  until: string | null; // YYYY-MM-DD, inclusive
  limit: number | null; // positive integer (total occurrences)
  done: number; // nonnegative occurrences already fired
}

export type AdvanceResult =
  | { kind: "next"; reminder: string; done: number }
  | { kind: "expired" };

/**
 * Parses a `reminder_repeat` string into a structured spec.
 * Returns null for anything that is not a known, valid value.
 */
export function parseRepeat(raw: string | null | undefined): RepeatSpec | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  if (s === "daily") return { type: "daily" };
  if (s === "monthly") return { type: "monthly" };
  if (s === "yearly") return { type: "yearly" };

  let m = s.match(/^weekly:([1-7](?:,[1-7])*)$/);
  if (m) {
    const weekdays = Array.from(new Set(m[1].split(",").map(Number))).sort((a, b) => a - b);
    return { type: "weekly", weekdays };
  }

  m = s.match(/^every:(\d+):(days|weeks|months)$/);
  if (m) {
    const n = Number.parseInt(m[1], 10);
    if (n >= 1 && n <= 10000) return { type: "every", every: { n, unit: m[2] as "days" | "weeks" | "months" } };
    return null;
  }

  m = s.match(/^ordinal:([1-5]):([1-7])$/);
  if (m) {
    return {
      type: "ordinal",
      ordinal: { k: Number.parseInt(m[1], 10), weekday: Number.parseInt(m[2], 10) },
    };
  }

  return null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Parses a local datetime without a timezone; null on invalid. */
export function parseLocalDateTime(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::[0-5]\d)?$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  if (date.getHours() !== h || date.getMinutes() !== mi) return null;
  return date;
}

/** Formats a Date as "YYYY-MM-DDTHH:mm" in local time (never UTC). */
export function formatLocalDateTime(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** "YYYY-MM-DD" in local time. */
export function dateOnlyString(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** ISO weekday, 1=Mon..7=Sun. */
export function isoWeekday(date: Date): number {
  return ((date.getDay() + 6) % 7) + 1;
}

function addDays(date: Date, n: number): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + n,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}

/** Adds n months keeping time-of-day, clamping the day to the month end. */
function addMonthsClamped(date: Date, n: number): Date {
  const target = new Date(date.getFullYear(), date.getMonth() + n, 1, date.getHours(), date.getMinutes(), 0, 0);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  const day = Math.min(date.getDate(), lastDay);
  return new Date(target.getFullYear(), target.getMonth(), day, date.getHours(), date.getMinutes(), 0, 0);
}

function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  k: number,
  hour: number,
  minute: number,
): Date {
  if (k >= 5) {
    const lastDay = new Date(year, month + 1, 0).getDate();
    let d = new Date(year, month, lastDay, hour, minute, 0, 0);
    while (isoWeekday(d) !== weekday) d = addDays(d, -1);
    return d;
  }
  let d = new Date(year, month, 1, hour, minute, 0, 0);
  while (isoWeekday(d) !== weekday) d = addDays(d, 1);
  return addDays(d, (k - 1) * 7);
}

/** Next occurrence strictly after `after`, preserving its time-of-day. */
export function nextOccurrence(spec: RepeatSpec, after: Date): Date {
  switch (spec.type) {
    case "daily":
      return addDays(after, 1);
    case "weekly": {
      const set = new Set(spec.weekdays ?? []);
      let c = addDays(after, 1);
      let guard = 0;
      while (!set.has(isoWeekday(c)) && guard++ < 14) c = addDays(c, 1);
      return c;
    }
    case "monthly":
      return addMonthsClamped(after, 1);
    case "yearly":
      return addMonthsClamped(after, 12);
    case "every": {
      const { n, unit } = spec.every ?? { n: 1, unit: "days" };
      if (unit === "days") return addDays(after, n);
      if (unit === "weeks") return addDays(after, n * 7);
      return addMonthsClamped(after, n);
    }
    case "ordinal": {
      const { k, weekday } = spec.ordinal ?? { k: 1, weekday: 1 };
      let candidate = nthWeekdayOfMonth(
        after.getFullYear(),
        after.getMonth(),
        weekday,
        k,
        after.getHours(),
        after.getMinutes(),
      );
      if (candidate.getTime() <= after.getTime()) {
        const nm = new Date(after.getFullYear(), after.getMonth() + 1, 1);
        candidate = nthWeekdayOfMonth(
          nm.getFullYear(),
          nm.getMonth(),
          weekday,
          k,
          after.getHours(),
          after.getMinutes(),
        );
      }
      return candidate;
    }
  }
}

/**
 * True when the series is already finished and must be cleared without firing:
 * invalid repeat/reminder, `done >= limit`, or the current reminder date is
 * past the inclusive `until` date.
 */
export function isRecurrenceExpired(state: RecurrenceState, now: number): boolean {
  const spec = parseRepeat(state.repeat);
  if (!spec) return true;
  const cur = parseLocalDateTime(state.reminder);
  if (!cur) return true;
  if (state.limit !== null && state.done >= state.limit) return true;
  if (state.until !== null && dateOnlyString(cur) > state.until) return true;
  return false;
}

/**
 * Advances the series after one fire: increments `done`, then returns the next
 * future occurrence (strictly after `now`). Returns "expired" when the limit is
 * reached or the next occurrence falls past the inclusive `until` date.
 */
export function advanceRecurrence(state: RecurrenceState, now: number): AdvanceResult {
  const spec = parseRepeat(state.repeat);
  if (!spec) return { kind: "expired" };
  const cur = parseLocalDateTime(state.reminder);
  if (!cur) return { kind: "expired" };

  const newDone = state.done + 1;
  if (state.limit !== null && newDone >= state.limit) return { kind: "expired" };

  let candidate = nextOccurrence(spec, cur);
  let guard = 0;
  while (candidate.getTime() <= now && guard++ < 10000) {
    candidate = nextOccurrence(spec, candidate);
  }
  if (guard >= 10000) return { kind: "expired" };
  if (state.until !== null && dateOnlyString(candidate) > state.until) return { kind: "expired" };

  return { kind: "next", reminder: formatLocalDateTime(candidate), done: newDone };
}

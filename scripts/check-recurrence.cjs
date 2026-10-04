// Focused regression check for JotDrop recurring reminders (issue #8).
// Exercises the pure recurrence logic in src/recurrence.ts only — no Obsidian
// imports, so it bundles cleanly into a Node check. Run: `node scripts/check-recurrence.cjs`.

// Pin a timezone with a known DST boundary so local calendar arithmetic is
// deterministic; the wall-clock assertions below also hold in any other zone.
process.env.TZ = "Europe/Amsterdam";

const esbuild = require("esbuild");

(async () => {
  const result = await esbuild.build({
    stdin: {
      contents:
        'export { parseRepeat, nextOccurrence, advanceRecurrence, isRecurrenceExpired, parseLocalDateTime, formatLocalDateTime, isoWeekday } from "./src/recurrence.ts"; export { readMeta, updateMeta } from "./src/metadata.ts";',
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    plugins: [{
      name: "obsidian-stub",
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: 'export const getLanguage = () => "en";',
        }));
      },
    }],
  });

  const loaded = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(loaded, loaded.exports, require);
  const {
    parseRepeat,
    nextOccurrence,
    advanceRecurrence,
    isRecurrenceExpired,
    parseLocalDateTime,
    formatLocalDateTime,
    isoWeekday,
    readMeta,
    updateMeta,
  } = loaded.exports;

  const eq = (actual, expected, label) => {
    if (actual !== expected) {
      throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const next = (repeat, reminder) => {
    const spec = parseRepeat(repeat);
    if (!spec) throw new Error(`parseRepeat(${repeat}) returned null`);
    return formatLocalDateTime(nextOccurrence(spec, parseLocalDateTime(reminder)));
  };
  const tzNow = (reminder) => parseLocalDateTime(reminder).getTime();

  const fm = {
    other_property: "keep me",
    reminder: "2026-01-05T09:00",
    reminder_repeat: "weekly:1,3",
    reminder_until: "2026-12-31",
    reminder_limit: 3,
    reminder_done: 1,
    order: -20260105090000.5,
  };
  const file = {};
  const app = {
    metadataCache: { getFileCache: () => ({ frontmatter: fm }) },
    fileManager: { processFrontMatter: async (_file, mutate) => mutate(fm) },
  };
  const meta = readMeta(app, file);
  eq(meta.reminderRepeat, "weekly:1,3", "read repeat from shared frontmatter");
  eq(meta.reminderUntil, "2026-12-31", "read quoted end date from shared frontmatter");
  eq(meta.reminderLimit, 3, "read occurrence limit");
  eq(meta.reminderDone, 1, "read fired count");
  eq(meta.order, -20260105090000.5, "read fractional manual rank");
  await updateMeta(app, file, { reminder: null, order: -20260105090001.5 });
  for (const key of ["reminder", "reminder_repeat", "reminder_until", "reminder_limit", "reminder_done"]) {
    eq(fm[key], undefined, `clearing reminder removes ${key}`);
  }
  eq(fm.order, -20260105090001.5, "order survives reminder clear");
  eq(fm.other_property, "keep me", "unrelated frontmatter survives update");

  fm.reminder = "2026-01-06T09:00";
  fm.reminder_repeat = "daily";
  fm.reminder_done = 2;
  await updateMeta(app, file, { color: "blue" });
  eq(fm.reminder_done, 2, "unrelated metadata edit keeps completed count");
  await updateMeta(app, file, { reminder: "2026-01-06T09:00" });
  eq(fm.reminder_done, 2, "unchanged reminder keeps completed count");
  await updateMeta(app, file, { reminder: "2026-01-07T09:00" });
  eq(fm.reminder_done, undefined, "changing reminder restarts occurrence count");
  fm.reminder_done = 2;
  await updateMeta(app, file, { reminderRepeat: "weekly:1,3" });
  eq(fm.reminder_done, undefined, "changing repeat restarts occurrence count");
  fm.reminder_done = 2;
  await updateMeta(app, file, { reminder: "2026-01-08T09:00", reminderDone: 3 });
  eq(fm.reminder_done, 3, "scheduler advancement keeps its explicit count");

  // ---- parseRepeat ----
  eq(parseRepeat("daily").type, "daily", "daily type");
  eq(parseRepeat("weekly:1,3,5").weekdays.join(","), "1,3,5", "weekly weekdays");
  eq(parseRepeat("weekly:5,1,5").weekdays.join(","), "1,5", "weekly dedupe+sort");
  eq(parseRepeat("every:2:weeks").every.n, 2, "every n");
  eq(parseRepeat("every:2:weeks").every.unit, "weeks", "every unit");
  eq(parseRepeat("every:1000:days").every.n, 1000, "every large n still parses (preserve existing notes)");
  eq(parseRepeat("every:10001:days"), null, "every above Android limit rejected");
  eq(parseRepeat("ordinal:2:2").ordinal.k, 2, "ordinal k");
  eq(parseRepeat("ordinal:2:2").ordinal.weekday, 2, "ordinal weekday");
  eq(parseRepeat("bogus"), null, "invalid repeat");
  eq(parseRepeat("every:0:days"), null, "every n<1 invalid");
  eq(parseRepeat("weekly:0"), null, "weekly day 0 invalid");
  eq(parseRepeat("weekly:8"), null, "weekly day 8 invalid");
  eq(parseRepeat("ordinal:0:3"), null, "ordinal k 0 invalid");
  eq(parseRepeat("ordinal:2:8"), null, "ordinal weekday 8 invalid");
  eq(parseRepeat(""), null, "empty repeat invalid");
  eq(parseRepeat(null), null, "null repeat invalid");

  // ---- ISO weekdays (2026-01-01 is a Thursday) ----
  eq(isoWeekday(parseLocalDateTime("2026-01-01T09:00")), 4, "Jan 1 2026 = Thursday");
  eq(isoWeekday(parseLocalDateTime("2026-01-05T09:00")), 1, "Jan 5 2026 = Monday");
  eq(isoWeekday(parseLocalDateTime("2026-01-11T09:00")), 7, "Jan 11 2026 = Sunday");
  eq(parseLocalDateTime("2026-01-11T09:00Z"), null, "timezone suffix must not be read as local time");

  // ---- nextOccurrence ----
  eq(next("daily", "2026-01-05T09:00"), "2026-01-06T09:00", "daily +1d");
  eq(next("weekly:1,3,5", "2026-01-05T09:00"), "2026-01-07T09:00", "weekly Mon->Wed");
  eq(next("weekly:1,3,5", "2026-01-09T09:00"), "2026-01-12T09:00", "weekly Fri->Mon");
  eq(next("monthly", "2021-01-31T10:00"), "2021-02-28T10:00", "monthly clamp non-leap");
  eq(next("monthly", "2020-01-31T10:00"), "2020-02-29T10:00", "monthly clamp leap");
  eq(next("monthly", "2021-01-15T10:00"), "2021-02-15T10:00", "monthly normal");
  eq(next("yearly", "2020-02-29T09:00"), "2021-02-28T09:00", "yearly Feb29->Feb28");
  eq(next("yearly", "2021-03-01T09:00"), "2022-03-01T09:00", "yearly normal");
  eq(next("every:2:weeks", "2026-01-05T09:00"), "2026-01-19T09:00", "every 2 weeks");
  eq(next("every:3:months", "2025-01-31T09:00"), "2025-04-30T09:00", "every 3 months clamp");
  eq(next("ordinal:2:2", "2026-01-06T09:00"), "2026-01-13T09:00", "ordinal 2nd Tue");
  eq(next("ordinal:2:2", "2026-01-01T09:00"), "2026-01-13T09:00", "ordinal 2nd Tue from Jan 1 (reviewer scenario)");
  eq(next("ordinal:2:2", "2026-01-13T09:00"), "2026-02-10T09:00", "ordinal 2nd Tue next month");
  eq(next("ordinal:5:2", "2026-01-13T09:00"), "2026-01-27T09:00", "ordinal last Tue");

  // Wall-clock time is preserved across a calendar day (DST-safe).
  eq(next("daily", "2026-03-28T09:00"), "2026-03-29T09:00", "daily across DST keeps HH:mm");

  // ---- advanceRecurrence ----
  // Overdue daily (3 days ago): fire once, jump to earliest future occurrence.
  let r = advanceRecurrence(
    { reminder: "2026-01-05T09:00", repeat: "daily", until: null, limit: null, done: 0 },
    tzNow("2026-01-08T00:00"),
  );
  eq(r.kind, "next", "overdue advances");
  eq(r.reminder, "2026-01-08T09:00", "overdue next future occurrence");
  eq(r.done, 1, "overdue done incremented once");

  // Overdue weekly: Fri Jan 9, now Thu Jan 15 -> next Fri Jan 16.
  r = advanceRecurrence(
    { reminder: "2026-01-09T09:00", repeat: "weekly:1,3,5", until: null, limit: null, done: 2 },
    tzNow("2026-01-15T00:00"),
  );
  eq(r.reminder, "2026-01-16T09:00", "overdue weekly next future");
  eq(r.done, 3, "overdue weekly done incremented");

  // Limit reached: done=0, limit=1 -> expire after the one fire.
  r = advanceRecurrence(
    { reminder: "2026-01-05T09:00", repeat: "daily", until: null, limit: 1, done: 0 },
    tzNow("2026-01-06T00:00"),
  );
  eq(r.kind, "expired", "limit reached expires");

  // Until date passed by the next occurrence -> expire.
  r = advanceRecurrence(
    { reminder: "2026-01-05T09:00", repeat: "daily", until: "2026-01-05", limit: null, done: 0 },
    tzNow("2026-01-06T00:00"),
  );
  eq(r.kind, "expired", "until passed expires");

  // Until date inclusive of the next occurrence -> still advances.
  r = advanceRecurrence(
    { reminder: "2026-01-05T09:00", repeat: "daily", until: "2026-01-06", limit: null, done: 0 },
    tzNow("2026-01-05T00:00"),
  );
  eq(r.kind, "next", "until inclusive advances");
  eq(r.reminder, "2026-01-06T09:00", "until inclusive next");

  // Invalid repeat / invalid reminder -> expire.
  r = advanceRecurrence(
    { reminder: "2026-01-05T09:00", repeat: "bogus", until: null, limit: null, done: 0 },
    tzNow("2026-01-06T00:00"),
  );
  eq(r.kind, "expired", "invalid repeat expires");

  // ---- isRecurrenceExpired ----
  eq(isRecurrenceExpired({ reminder: "2026-01-10T09:00", repeat: "daily", until: "2026-01-05", limit: null, done: 0 }, Date.now()), true, "expired: until in past");
  eq(isRecurrenceExpired({ reminder: "2026-01-05T09:00", repeat: "daily", until: null, limit: 2, done: 2 }, Date.now()), true, "expired: done==limit");
  eq(isRecurrenceExpired({ reminder: "2026-01-05T09:00", repeat: "bogus", until: null, limit: null, done: 0 }, Date.now()), true, "expired: invalid repeat");
  eq(isRecurrenceExpired({ reminder: "2026-01-05T09:00", repeat: "daily", until: null, limit: null, done: 0 }, tzNow("2026-01-01T00:00")), false, "not expired future");

  // ---- local parse/format round-trip ----
  eq(formatLocalDateTime(parseLocalDateTime("2026-12-31T23:59")), "2026-12-31T23:59", "round-trip");
  eq(parseLocalDateTime("2026-13-01T00:00"), null, "invalid month");
  eq(parseLocalDateTime("2026-02-30T00:00"), null, "invalid day (Feb 30)");

  console.log("Recurring reminder checks passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

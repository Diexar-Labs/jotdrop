// Sync on hold in the Obsidian plugin (Hand-off/ontwerp-sync-pauzeren-boven-free.md, deel 8): the rules in
// src/syncHold.ts, case by case, the same as android/checks/CloudSyncHoldCheck.kt. When in doubt it syncs.
const esbuild = require("esbuild");
const path = require("path");

const ROOT = path.join(__dirname, "..");

(async () => {
  const result = await esbuild.build({
    stdin: { contents: `export * from "./src/syncHold.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const loaded = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(loaded, loaded.exports, require);
  const { readSyncPlan, onHold, refused, mayAsk, noticeShown, waitUntil, choosing, goingOnHold, startingChoice, RECHECK_MS, REFUSED } = loaded.exports;

  let failures = 0;
  const check = (ok, message) => { if (!ok) { failures++; console.error("FAIL: " + message); } };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const DAY = 86_400_000, NOW = Date.parse("2027-01-12T10:00:00Z");
  const at = (ms) => new Date(ms).toISOString();
  const plan = (extra = {}) => ({ limit: 2, state: "limited", pauseAt: at(NOW - DAY), thisDevice: "paused", changeAt: null, ...extra });

  // Only what the server sends; anything else reads as "everything syncs".
  check(same(readSyncPlan(plan()), plan()), "reads a pause that started");
  check(same(readSyncPlan(plan({ state: "ending", thisDevice: "syncing" })), plan({ state: "ending", thisDevice: "syncing" })), "reads the grace");
  check(readSyncPlan({ ...plan(), state: "all" }) === null, "all syncs is null");
  for (const bad of [undefined, null, "limited", 2, [], {}, plan({ state: "paused" }), plan({ thisDevice: "on hold" }), plan({ limit: 0 }), plan({ limit: -1 }), plan({ limit: 1.5 }), plan({ limit: "2" })]) {
    check(readSyncPlan(bad) === null, `unknown values read as syncing: ${JSON.stringify(bad)}`);
  }
  check(readSyncPlan(plan({ limit: null })).limit === null, "an unknown limit stays unknown");
  check(readSyncPlan(plan({ pauseAt: "tomorrow" })).pauseAt === null, "a date that is no date is dropped");
  check(readSyncPlan(plan({ changeAt: 12 })).changeAt === null, "changeAt must be a date");

  // On hold only when the pause started and names this device.
  check(onHold(plan()) === true, "limited + paused holds");
  check(onHold(plan({ thisDevice: "syncing" })) === false, "limited + syncing syncs");
  check(onHold(plan({ state: "ending" })) === false, "the grace still syncs");
  check(onHold(null) === false && onHold(undefined) === false, "no plan syncs");
  check(onHold(REFUSED) === true, "a refusal holds until /status says more");

  // The refusal: 403 with the code, nothing else.
  check(refused({ status: 403, code: "device-paused" }) === true, "403 device-paused is a refusal");
  check(refused({ status: 403, code: "plus-required" }) === false, "another 403 is not");
  check(refused({ status: 409, code: "device-paused" }) === false, "another status is not");
  check(refused(null) === false && refused(new Error("x")) === false, "no status is not");

  // On hold: ask on a check, or 30 minutes after the last time; a clock turned back is no reason to stay quiet.
  check(mayAsk(false, false, NOW, NOW) === true, "a device that syncs always asks");
  check(mayAsk(true, true, NOW, NOW) === true, "a check asks");
  check(mayAsk(false, true, NOW, NOW + 60_000) === false, "the minute timer on hold stays quiet");
  check(mayAsk(false, true, NOW, NOW + RECHECK_MS - 1) === false, "quiet until 30 minutes");
  check(mayAsk(false, true, NOW, NOW + RECHECK_MS) === true, "asks again after 30 minutes");
  check(mayAsk(false, true, NOW, NOW - 1) === true, "a clock turned back asks");
  check(mayAsk(false, true, 0, NOW) === true, "never asked: asks");

  // The notice before the pause.
  const ending = plan({ state: "ending", pauseAt: at(NOW + 6 * DAY) });
  check(noticeShown(ending, undefined, NOW) === true, "shown in the grace");
  check(noticeShown(ending, ending.pauseAt, NOW) === false, "Not now hides it for that date");
  check(noticeShown(ending, at(NOW + 9 * DAY), NOW) === true, "Not now for another date does not");
  check(noticeShown(ending, ending.pauseAt, NOW + 3 * DAY) === true, "back in the last 3 days");
  check(noticeShown(ending, ending.pauseAt, NOW + 3 * DAY - 1) === false, "not back before the last 3 days");
  check(noticeShown(plan(), undefined, NOW) === false, "not once the pause started");
  check(noticeShown({ ...ending, limit: null }, undefined, NOW) === false, "not without a limit to name");
  check(noticeShown({ ...ending, pauseAt: null }, undefined, NOW) === false, "not without a date to name");

  // From when the choice may change again.
  check(waitUntil(plan({ changeAt: at(NOW + 1000) }), NOW) === at(NOW + 1000), "a wait in the future");
  check(waitUntil(plan({ changeAt: at(NOW - 1000) }), NOW) === null, "a wait that passed");
  check(waitUntil(plan(), NOW) === null && waitUntil(null, NOW) === null, "no wait");

  // The choice: only while the plan limits something.
  check(choosing(plan()) === true && choosing(ending) === true, "choose in the grace and on hold");
  check(choosing(null) === false && choosing(REFUSED) === false, "nothing to choose without a limit");

  // Who goes on hold, and "Sync here instead".
  const devices = [
    { id: "a", name: "Phone", syncing: true },
    { id: "b", name: "Desk", syncing: true },
    { id: "c", name: "Obsidian on Windows", syncing: false },
    { id: "d", name: "Old browser", syncing: false, revoked: true },
    { id: "e", name: "Unknown" },
  ];
  check(same(goingOnHold(devices).map((device) => device.id), ["c"]), "only signed-in devices that do not sync go on hold");
  check(same([...startingChoice(devices, null)].sort(), ["a", "b"]), "the choice starts from the devices that sync");
  check(same([...startingChoice(devices, "c")].sort(), ["a", "b", "c"]), "Sync here instead ticks this device too");
  check(same([...startingChoice(devices, "d")].sort(), ["a", "b"]), "a revoked device is never ticked");

  if (failures) { console.error(`${failures} sync-hold check(s) failed.`); process.exit(1); }
  console.log("PASS: sync on hold rules (Obsidian) match Android and the web app.");
})().catch((error) => { console.error(error); process.exit(1); });

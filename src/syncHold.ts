/**
 * Sync on hold (Hand-off/ontwerp-sync-pauzeren-boven-free.md, deel 8): the account has more devices than its plan syncs,
 * and this device is not one of the chosen ones. It then stops trying: it asks /status when Obsidian opens or comes back
 * to the front, on "Check again" and at most every 30 minutes, and sends nothing else. Notes stay editable here (they
 * are files in the vault) and go up once it syncs again.
 *
 * The same rules as Android's CloudSyncHold.kt and the web app; no Obsidian here, so scripts/check-sync-hold.cjs plays
 * every case.
 */

/**
 * plan.sync from the cloud's /status: how many devices the plan syncs, and whether that limits anything: "ending" (the
 * grace runs until `pauseAt`) or "limited" (the pause has started). `thisDevice` is "syncing" or "paused", during the
 * grace what it will be. `changeAt` is when the choice may change again. "all" (everything syncs) is read as null.
 */
export type SyncPlan = { limit: number | null; state: "ending" | "limited"; pauseAt: string | null; thisDevice: "syncing" | "paused"; changeAt: string | null };
/** A device as /devices lists it, with what the plan pause adds: its app and whether it syncs. */
export type HoldDevice = { id: string; name: string; app?: string; syncing?: boolean; revoked?: boolean; lastSeenAt?: string };

/** The apps /devices names, in the words of the settings (English, like the rest of the cloud screens). */
export const APP_NAMES: Record<string, string> = { android: "Android app", web: "web app", obsidian: "Obsidian", joplin: "Joplin", clipper: "Web Clipper", mcp: "AI agent" };
export const HOLD_APPS = Object.keys(APP_NAMES);

export const RECHECK_MS = 30 * 60 * 1000;
const NOTICE_AGAIN_MS = 3 * 86_400_000;
/** What a refusal says while /status has not said more yet: on hold, the limit unknown. */
export const REFUSED: SyncPlan = { limit: null, state: "limited", pauseAt: null, thisDevice: "paused", changeAt: null };

const time = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

/** Only the values the server sends; anything else, also "all", reads as "everything syncs". */
export function readSyncPlan(raw: unknown): SyncPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const sync = raw as Record<string, unknown>;
  if ((sync.state !== "ending" && sync.state !== "limited") || (sync.thisDevice !== "syncing" && sync.thisDevice !== "paused")) return null;
  const limit = sync.limit;
  if (limit !== null && limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) return null;
  return {
    limit: typeof limit === "number" ? limit : null,
    state: sync.state,
    pauseAt: time(sync.pauseAt) === null ? null : sync.pauseAt as string,
    thisDevice: sync.thisDevice,
    changeAt: time(sync.changeAt) === null ? null : sync.changeAt as string,
  };
}

/** When in doubt it syncs: only a pause that has started and names this device holds it. */
export const onHold = (plan: SyncPlan | null | undefined): boolean => plan?.state === "limited" && plan.thisDevice === "paused";

/** The cloud refused because this device is on hold. */
export const refused = (error: unknown): boolean => (error as { status?: number })?.status === 403 && (error as { code?: string })?.code === "device-paused";

/** On hold, a sync asks the cloud only when it should check (Obsidian opened, Check again) or 30 minutes after the last time; a clock turned back is no reason to stay quiet. */
export const mayAsk = (check: boolean, held: boolean, checkedAt: number, now: number): boolean => check || !held || !(now - checkedAt >= 0 && now - checkedAt < RECHECK_MS);

/** The notice before the pause: hidden after "Not now" for that date, and back in the last 3 days. */
export function noticeShown(plan: SyncPlan | null | undefined, skipped: string | undefined, now: number): boolean {
  if (plan?.state !== "ending" || plan.limit === null) return false;
  const at = time(plan.pauseAt);
  if (at === null) return false;
  return skipped !== plan.pauseAt || at - now <= NOTICE_AGAIN_MS;
}

/** From when the choice may change again, or null when it may change now. */
export function waitUntil(plan: SyncPlan | null | undefined, now: number): string | null {
  const at = time(plan?.changeAt);
  return at !== null && at > now ? plan!.changeAt : null;
}

/** Whether the device list shows who syncs and lets you choose: only while the plan limits something. */
export const choosing = (plan: SyncPlan | null | undefined): plan is SyncPlan => !!plan && plan.limit !== null;

/** The devices that go on hold when the pause starts, for the notice before it: signed in and not chosen. */
export const goingOnHold = (devices: HoldDevice[]): HoldDevice[] => devices.filter((device) => !device.revoked && device.syncing === false);

/** "Sync here instead" ticks this device first, so the person only unticks the device that makes room. */
export function startingChoice(devices: HoldDevice[], here: string | null): Set<string> {
  const picked = new Set(devices.filter((device) => !device.revoked && device.syncing).map((device) => device.id));
  if (here && devices.some((device) => device.id === here && !device.revoked)) picked.add(here);
  return picked;
}

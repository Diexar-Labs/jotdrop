package com.diexar.keepcapture

import java.time.Instant

// Sync on hold (Hand-off/ontwerp-sync-pauzeren-boven-free.md, deel 8), the same decisions as cloud/web/app.js:
// on hold only when the pause has started and names this phone, and when in doubt it syncs.
fun main() {
    val now = Instant.parse("2026-12-01T12:00:00Z").toEpochMilli()
    val day = 86_400_000L
    fun at(offset: Long) = Instant.ofEpochMilli(now + offset).toString()

    // What /status says; anything the server does not send reads as "everything syncs".
    check(CloudSyncHold.plan(2, "all", null, "syncing", null) == null)
    check(CloudSyncHold.plan(null, null, null, null, null) == null)
    check(CloudSyncHold.plan(2, "paused", null, "paused", null) == null)
    check(CloudSyncHold.plan(2, "limited", null, "held", null) == null)
    check(CloudSyncHold.plan(0, "limited", null, "paused", null) == null)
    check(CloudSyncHold.plan(2, "ending", "not a date", "paused", "nor this")!!.let { it.pauseAt == null && it.changeAt == null })
    val limited = CloudSyncHold.plan(2, "limited", at(-day), "paused", null)!!
    val syncing = CloudSyncHold.plan(2, "limited", at(-day), "syncing", null)!!
    val ending = CloudSyncHold.plan(2, "ending", at(7 * day), "paused", null)!!
    val endingHere = CloudSyncHold.plan(2, "ending", at(7 * day), "syncing", null)!!

    // On hold: only a started pause on this device. During the grace everything still syncs.
    check(CloudSyncHold.onHold(limited))
    check(!CloudSyncHold.onHold(syncing))
    check(!CloudSyncHold.onHold(ending))
    check(!CloudSyncHold.onHold(null))
    // A refusal by the cloud, from a phone that had not seen the pause yet: no limit is known then.
    check(CloudSyncHold.onHold(CloudSyncHold.plan(null, "limited", null, "paused", null)))
    check(CloudSyncHold.refused(403, "device-paused"))
    check(!CloudSyncHold.refused(403, "plus-required"))
    check(!CloudSyncHold.refused(401, "device-paused"))
    check(!CloudSyncHold.refused(403, null))

    // Stop trying: on hold only when asked to check, or 30 minutes after the last time.
    check(CloudSyncHold.mayAsk(check = false, held = false, checkedAt = now, now = now))
    check(!CloudSyncHold.mayAsk(check = false, held = true, checkedAt = now - 60_000, now = now))
    check(!CloudSyncHold.mayAsk(check = false, held = true, checkedAt = now - CloudSyncHold.RECHECK_MS + 1, now = now))
    check(CloudSyncHold.mayAsk(check = false, held = true, checkedAt = now - CloudSyncHold.RECHECK_MS, now = now))
    check(CloudSyncHold.mayAsk(check = true, held = true, checkedAt = now - 1, now = now))
    check(CloudSyncHold.mayAsk(check = false, held = true, checkedAt = 0, now = now))
    // A clock set back must not keep it silent for good.
    check(CloudSyncHold.mayAsk(check = false, held = true, checkedAt = now + day, now = now))

    // The notice before the pause: on every device during the grace, hidden after Not now, back in the last 3 days.
    check(CloudSyncHold.noticeShown(ending, null, now))
    check(CloudSyncHold.noticeShown(endingHere, null, now))
    check(!CloudSyncHold.noticeShown(ending, ending.pauseAt, now))
    check(CloudSyncHold.noticeShown(ending, "2026-11-01T00:00:00Z", now))
    check(CloudSyncHold.noticeShown(ending, ending.pauseAt, now + 4 * day))
    check(!CloudSyncHold.noticeShown(ending, ending.pauseAt, now + 4 * day - 1))
    check(!CloudSyncHold.noticeShown(limited, null, now))
    check(!CloudSyncHold.noticeShown(CloudSyncHold.plan(null, "ending", at(day), "paused", null), null, now))
    check(!CloudSyncHold.noticeShown(CloudSyncHold.plan(2, "ending", null, "paused", null), null, now))

    // Changing the choice again, a day after the last change once the pause has started.
    check(CloudSyncHold.waitUntil(CloudSyncHold.plan(2, "limited", at(-day), "paused", at(3_600_000)), now) == Instant.ofEpochMilli(now + 3_600_000))
    check(CloudSyncHold.waitUntil(CloudSyncHold.plan(2, "limited", at(-day), "paused", at(-1)), now) == null)
    check(CloudSyncHold.waitUntil(limited, now) == null)

    // The device list shows who syncs only while the plan limits something.
    check(CloudSyncHold.choosing(limited) && CloudSyncHold.choosing(ending))
    check(!CloudSyncHold.choosing(null))
    check(!CloudSyncHold.choosing(CloudSyncHold.plan(null, "limited", null, "paused", null)))
    println("Sync on hold checks passed")
}

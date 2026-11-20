package com.diexar.keepcapture

import java.time.Instant

/** A device that goes on hold when the pause starts, for the notice before it: [here] is this phone. */
data class CloudHoldDevice(val name: String, val app: String?, val here: Boolean)

/**
 * plan.sync from the cloud's /status (Hand-off/ontwerp-sync-pauzeren-boven-free.md, deel 5): how many devices the plan
 * syncs, and whether that limits anything: "all" (everything syncs), "ending" (the grace runs until [pauseAt]) or
 * "limited" (the pause has started). [thisDevice] is "syncing" or "paused", during the grace what it will be.
 * [changeAt] is when the choice may change again. [goingOnHold] comes from /devices, only during the grace.
 */
data class CloudSyncPlan(val limit: Int?, val state: String, val pauseAt: String?, val thisDevice: String, val changeAt: String?,
    val goingOnHold: List<CloudHoldDevice> = emptyList())

/**
 * Sync on hold (deel 8): the account has more devices than its plan syncs, and this phone is not one of the chosen ones.
 * It then stops trying: it asks /status when the app opens, on Check again and at most every 30 minutes, and sends
 * nothing else. Notes stay editable here (they are plain files) and go up once it syncs again.
 * Plain Kotlin, no Android and no org.json: android/checks/CloudSyncHoldCheck.kt plays every case.
 */
object CloudSyncHold {
    const val RECHECK_MS = 30 * 60 * 1000L
    private const val NOTICE_AGAIN_MS = 3 * 86_400_000L
    /** What a refusal says while /status has not said more yet: on hold, the limit unknown. */
    val REFUSED = CloudSyncPlan(null, "limited", null, "paused", null)

    /** When in doubt it syncs: only a pause that has started and names this device holds it. */
    fun onHold(plan: CloudSyncPlan?): Boolean = plan?.state == "limited" && plan.thisDevice == "paused"

    /** The cloud refused because this device is on hold. */
    fun refused(status: Int, code: String?): Boolean = status == 403 && code == "device-paused"

    /** On hold, a sync asks the cloud only when it should check (app opened, Check again) or 30 minutes after the last time. */
    fun mayAsk(check: Boolean, held: Boolean, checkedAt: Long, now: Long): Boolean = check || !held || now - checkedAt !in 0 until RECHECK_MS

    /** The notice before the pause: hidden after Not now for that date, and back in the last 3 days. */
    fun noticeShown(plan: CloudSyncPlan?, skipped: String?, now: Long): Boolean {
        if (plan?.state != "ending" || plan.limit == null) return false
        val at = time(plan.pauseAt) ?: return false
        return skipped != plan.pauseAt || at.toEpochMilli() - now <= NOTICE_AGAIN_MS
    }

    /** From when the choice may change again, or null when it may change now. */
    fun waitUntil(plan: CloudSyncPlan?, now: Long): Instant? = time(plan?.changeAt)?.takeIf { it.toEpochMilli() > now }

    /** Whether the device list shows who syncs and lets you choose: only while the plan limits something. */
    fun choosing(plan: CloudSyncPlan?): Boolean = plan != null && plan.state != "all" && plan.limit != null

    /** Only the values the server sends; anything else reads as "everything syncs". */
    fun plan(limit: Int?, state: String?, pauseAt: String?, thisDevice: String?, changeAt: String?, goingOnHold: List<CloudHoldDevice> = emptyList()): CloudSyncPlan? {
        if (state !in setOf("ending", "limited") || thisDevice !in setOf("syncing", "paused")) return null
        if (limit != null && limit < 1) return null
        return CloudSyncPlan(limit, state!!, pauseAt?.takeIf { time(it) != null }, thisDevice!!, changeAt?.takeIf { time(it) != null }, goingOnHold)
    }

    private fun time(value: String?): Instant? = value?.let { runCatching { Instant.parse(it) }.getOrNull() }
}

package com.diexar.keepcapture

import java.time.LocalDateTime

/**
 * Standalone self-check voor ReminderRecurrence. Alleen pure java.time-functies
 * (geen NoteMeta/Android), dus draaibaar op een kale JVM via `fun main()`.
 */
fun main() {
    checkParseRepeat()
    checkNextOccurrence()
    checkAdvanceState()
    checkIsExpiredState()
    println("ReminderRecurrence checks passed")
}

private fun checkParseRepeat() {
    require(ReminderRecurrence.parseRepeat("daily") == RepeatRule.Daily)
    require(ReminderRecurrence.parseRepeat("monthly") == RepeatRule.Monthly)
    require(ReminderRecurrence.parseRepeat("yearly") == RepeatRule.Yearly)
    require(ReminderRecurrence.parseRepeat("weekly:1,3,5") == RepeatRule.Weekly(setOf(1, 3, 5)))
    require(ReminderRecurrence.parseRepeat("every:2:weeks") == RepeatRule.Every(2, RepeatUnit.WEEKS))
    require(ReminderRecurrence.parseRepeat("ordinal:2:2") == RepeatRule.Ordinal(2, 2))
    // Strict/hoofdlettergevoelig: ongeldige vormen → null.
    require(ReminderRecurrence.parseRepeat("bogus") == null)
    require(ReminderRecurrence.parseRepeat("Daily") == null)
    require(ReminderRecurrence.parseRepeat("weekly:1,9") == null)
    require(ReminderRecurrence.parseRepeat("every:0:days") == null)
    require(ReminderRecurrence.parseRepeat("every:20000:days") == null)
}

private fun checkNextOccurrence() {
    val daily = ReminderRecurrence.nextOccurrence(LocalDateTime.of(2026, 1, 1, 9, 0), RepeatRule.Daily)
    require(daily == LocalDateTime.of(2026, 1, 2, 9, 0))

    val weekly = ReminderRecurrence.nextOccurrence(LocalDateTime.of(2026, 1, 5, 8, 30), RepeatRule.Weekly(setOf(1, 3, 5)))
    require(weekly == LocalDateTime.of(2026, 1, 7, 8, 30))

    val monthly = ReminderRecurrence.nextOccurrence(LocalDateTime.of(2026, 1, 31, 9, 0), RepeatRule.Monthly)
    require(monthly == LocalDateTime.of(2026, 2, 28, 9, 0))

    val yearly = ReminderRecurrence.nextOccurrence(LocalDateTime.of(2024, 2, 29, 10, 0), RepeatRule.Yearly)
    require(yearly == LocalDateTime.of(2025, 2, 28, 10, 0))

    val every = ReminderRecurrence.nextOccurrence(LocalDateTime.of(2026, 1, 1, 9, 0), RepeatRule.Every(2, RepeatUnit.WEEKS))
    require(every == LocalDateTime.of(2026, 1, 15, 9, 0))

    // Ordinal 2:2 = 2e dinsdag; huidige maand als die nog in de toekomst ligt.
    val o1 = ReminderRecurrence.nextOccurrence(LocalDateTime.of(2026, 1, 1, 9, 0), RepeatRule.Ordinal(2, 2))
    require(o1 == LocalDateTime.of(2026, 1, 13, 9, 0)) { "ordinal same month: $o1" }

    // Huidige-maand-occurrence al voorbij → volgende maand.
    val o2 = ReminderRecurrence.nextOccurrence(LocalDateTime.of(2026, 1, 15, 9, 0), RepeatRule.Ordinal(2, 2))
    require(o2 == LocalDateTime.of(2026, 2, 10, 9, 0)) { "ordinal next month: $o2" }

    // Ordinal K=5 = laatste dinsdag van de maand.
    val o3 = ReminderRecurrence.nextOccurrence(LocalDateTime.of(2026, 1, 1, 9, 0), RepeatRule.Ordinal(5, 2))
    require(o3 == LocalDateTime.of(2026, 1, 27, 9, 0)) { "ordinal last: $o3" }
}

private fun checkAdvanceState() {
    val d = ReminderRecurrence.advanceState("2026-01-01T09:00", "daily", null, null, 0, LocalDateTime.of(2026, 1, 1, 9, 0))
    require(d == AdvanceOutcome("2026-01-02T09:00", 1))

    // Overdue over meerdere periodes: vuur één keer (done+1), spring naar future.
    val w = ReminderRecurrence.advanceState("2026-01-05T08:30", "weekly:1,3,5", null, null, 0, LocalDateTime.of(2026, 1, 10, 0, 0))
    require(w == AdvanceOutcome("2026-01-12T08:30", 1)) { "overdue: $w" }

    // Limit bereikt na één fire.
    val l = ReminderRecurrence.advanceState("2026-01-01T09:00", "daily", null, 1, 0, LocalDateTime.of(2026, 1, 1, 9, 0))
    require(l.reminder == null) { "limit: $l" }

    // Until inclusief: op de until-datum mag nog, erna vervalt de reeks.
    val u1 = ReminderRecurrence.advanceState("2026-01-10T09:00", "daily", "2026-01-11", null, 0, LocalDateTime.of(2026, 1, 10, 9, 0))
    require(u1.reminder == "2026-01-11T09:00") { "until: $u1" }
    val u2 = ReminderRecurrence.advanceState("2026-01-11T09:00", "daily", "2026-01-11", null, 1, LocalDateTime.of(2026, 1, 11, 9, 0))
    require(u2.reminder == null) { "until expire: $u2" }

    // One-shot (geen herhaling) → gewist.
    val os = ReminderRecurrence.advanceState("2026-01-01T09:00", null, null, null, 0, LocalDateTime.of(2026, 1, 1, 9, 0))
    require(os.reminder == null) { "one-shot: $os" }

    // Ongeldige herhaling → gewist.
    val iv = ReminderRecurrence.advanceState("2026-01-01T09:00", "bogus", null, null, 0, LocalDateTime.of(2026, 1, 1, 9, 0))
    require(iv.reminder == null) { "invalid: $iv" }
}

private fun checkIsExpiredState() {
    require(!ReminderRecurrence.isExpiredState("2026-01-09T09:00", "daily", "2026-01-10", null, 0))
    require(ReminderRecurrence.isExpiredState("2026-01-15T09:00", "daily", "2026-01-10", null, 0))
    require(ReminderRecurrence.isExpiredState("2026-01-01T09:00", "daily", null, 3, 3))
    require(ReminderRecurrence.isExpiredState("2026-01-01T09:00", "bogus", null, null, 0))
}

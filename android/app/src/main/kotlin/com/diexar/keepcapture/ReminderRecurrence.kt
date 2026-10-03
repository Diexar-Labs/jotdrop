package com.diexar.keepcapture

import java.time.DateTimeException
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

/**
 * Pure recurrence-engine voor reminders (spiegelt src/recurrence.ts). Geen
 * Android-afhankelijkheden, alleen java.time. `reminder` is altijd de NEXT
 * afvuurtijd in lokale tijd; advancement is geankerd op de opgeslagen waarde
 * (nooit "nu"), zodat lokale DST-overgangen vanzelf kloppen.
 *
 * De kern (`parseRepeat`, `nextOccurrence`, `advanceState`, `isExpiredState`)
 * is NoteMeta-vrij en daarmee bare-JVM-testbaar; `advance`/`isExpired` zijn
 * dunne NoteMeta-wrappers voor de scheduler/engine.
 */
object ReminderRecurrence {

    private val DISPLAY = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm")

    // Eindige veiligheidsgrens: een absurd grote N zou LocalDateTime.plusDays/
    // plusMonths over de rand duwen. De plugin zelf heeft geen bovengrens.
    private const val MAX_INTERVAL = 10000
    private const val MAX_OVERDUE_SKIPS = 10000

    private val WEEKLY = Regex("^weekly:([1-7](?:,[1-7])*)$")
    private val EVERY = Regex("^every:(\\d+):(days|weeks|months)$")
    private val ORDINAL = Regex("^ordinal:([1-5]):([1-7])$")

    fun parseIso(iso: String): LocalDateTime? = try {
        LocalDateTime.parse(iso, DISPLAY)
    } catch (_: DateTimeException) {
        try {
            LocalDateTime.parse(iso)
        } catch (_: DateTimeException) {
            null
        }
    }

    fun formatIso(ldt: LocalDateTime): String = ldt.format(DISPLAY)

    fun clear(meta: NoteMeta): NoteMeta = meta.copy(
        reminder = null,
        reminderRepeat = null,
        reminderUntil = null,
        reminderLimit = null,
        reminderDone = 0,
    )

    /**
     * Parseert `reminder_repeat` strikt (hoofdlettergevoelig + geankerd), exact
     * zoals de plugin. Returns null voor onbekende/ongeldige waardes.
     */
    fun parseRepeat(raw: String?): RepeatRule? {
        val s = raw?.trim().orEmpty()
        if (s.isEmpty()) return null
        when {
            s == "daily" -> return RepeatRule.Daily
            s == "monthly" -> return RepeatRule.Monthly
            s == "yearly" -> return RepeatRule.Yearly
        }
        WEEKLY.matchEntire(s)?.let {
            return RepeatRule.Weekly(it.groupValues[1].split(',').map { d -> d.toInt() }.toSet())
        }
        EVERY.matchEntire(s)?.let {
            val n = it.groupValues[1].toIntOrNull()
            val unit = when (it.groupValues[2]) {
                "days" -> RepeatUnit.DAYS
                "weeks" -> RepeatUnit.WEEKS
                "months" -> RepeatUnit.MONTHS
                else -> null
            }
            if (n != null && unit != null && n in 1..MAX_INTERVAL) {
                return RepeatRule.Every(n, unit)
            }
            return null
        }
        ORDINAL.matchEntire(s)?.let {
            return RepeatRule.Ordinal(it.groupValues[1].toInt(), it.groupValues[2].toInt())
        }
        return null
    }

    /**
     * Rekent één fire af op pure waarden. `reminder == null` in het resultaat
     * betekent: reeks vervallen (ongeldige repeat/reminder, limit bereikt,
     * until gepasseerd, of overdue-lus uitgeput) → caller wist de keys.
     */
    fun advanceState(
        reminder: String?,
        repeat: String?,
        until: String?,
        limit: Int?,
        done: Int,
        now: LocalDateTime,
    ): AdvanceOutcome {
        val rule = parseRepeat(repeat) ?: return AdvanceOutcome(null, 0)
        val current = reminder?.let(::parseIso) ?: return AdvanceOutcome(null, 0)

        val newDone = done + 1
        if (limit != null && newDone >= limit) return AdvanceOutcome(null, 0)

        val untilDate = until?.let { runCatching { LocalDate.parse(it) }.getOrNull() }

        var next = nextOccurrence(current, rule)
        var guard = 0
        while (!next.isAfter(now) && guard < MAX_OVERDUE_SKIPS) {
            next = nextOccurrence(next, rule)
            guard++
        }
        if (!next.isAfter(now)) return AdvanceOutcome(null, 0)
        if (untilDate != null && next.toLocalDate().isAfter(untilDate)) return AdvanceOutcome(null, 0)

        return AdvanceOutcome(formatIso(next), newDone)
    }

    fun advance(meta: NoteMeta, now: LocalDateTime): NoteMeta {
        val out = advanceState(meta.reminder, meta.reminderRepeat, meta.reminderUntil, meta.reminderLimit, meta.reminderDone, now)
        return if (out.reminder == null) clear(meta)
        else meta.copy(reminder = out.reminder, reminderDone = out.done)
    }

    /**
     * True wanneer de reeks gewist moet worden zonder te vuren. Spiegel van TS
     * isRecurrenceExpired.
     */
    fun isExpiredState(reminder: String?, repeat: String?, until: String?, limit: Int?, done: Int): Boolean {
        if (parseRepeat(repeat) == null) return true
        val current = reminder?.let(::parseIso) ?: return true
        if (limit != null && done >= limit) return true
        val untilDate = until?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
        if (untilDate != null && current.toLocalDate().isAfter(untilDate)) return true
        return false
    }

    fun isExpired(meta: NoteMeta): Boolean =
        isExpiredState(meta.reminder, meta.reminderRepeat, meta.reminderUntil, meta.reminderLimit, meta.reminderDone)

    fun nextOccurrence(current: LocalDateTime, rule: RepeatRule): LocalDateTime = when (rule) {
        RepeatRule.Daily -> current.plusDays(1)
        is RepeatRule.Weekly -> {
            var d = current.plusDays(1)
            var guard = 0
            while (d.dayOfWeek.value !in rule.weekdays && guard < 7) {
                d = d.plusDays(1)
                guard++
            }
            d
        }
        RepeatRule.Monthly -> current.plusMonths(1)
        RepeatRule.Yearly -> current.plusYears(1)
        is RepeatRule.Every -> when (rule.unit) {
            RepeatUnit.DAYS -> current.plusDays(rule.n.toLong())
            RepeatUnit.WEEKS -> current.plusWeeks(rule.n.toLong())
            RepeatUnit.MONTHS -> current.plusMonths(rule.n.toLong())
        }
        is RepeatRule.Ordinal -> {
            val candidate = ordinalDateTime(current.year, current.monthValue, rule, current.hour, current.minute)
            if (candidate.isAfter(current)) {
                candidate
            } else {
                val base = current.plusMonths(1)
                ordinalDateTime(base.year, base.monthValue, rule, current.hour, current.minute)
            }
        }
    }

    private fun ordinalDateTime(year: Int, month: Int, rule: RepeatRule.Ordinal, hour: Int, minute: Int): LocalDateTime {
        val candidates = weekdayCandidates(year, month, rule.weekday)
        val idx = (rule.occurrence - 1).coerceAtMost(candidates.size - 1)
        return LocalDateTime.of(year, month, candidates[idx].dayOfMonth, hour, minute)
    }

    private fun weekdayCandidates(year: Int, month: Int, weekday: Int): List<LocalDate> {
        var day = LocalDate.of(year, month, 1)
        val end = day.withDayOfMonth(day.lengthOfMonth())
        val out = mutableListOf<LocalDate>()
        while (!day.isAfter(end)) {
            if (day.dayOfWeek.value == weekday) out.add(day)
            day = day.plusDays(1)
        }
        return out
    }
}

data class AdvanceOutcome(val reminder: String?, val done: Int)

sealed class RepeatRule {
    object Daily : RepeatRule()
    data class Weekly(val weekdays: Set<Int>) : RepeatRule()
    object Monthly : RepeatRule()
    object Yearly : RepeatRule()
    data class Every(val n: Int, val unit: RepeatUnit) : RepeatRule()
    data class Ordinal(val occurrence: Int, val weekday: Int) : RepeatRule()
}

enum class RepeatUnit(val key: String) { DAYS("days"), WEEKS("weeks"), MONTHS("months") }

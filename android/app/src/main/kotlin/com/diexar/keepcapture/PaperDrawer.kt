package com.diexar.keepcapture

import java.time.LocalDate

/**
 * Paper drawer: scanned papers and notes that expire. The same rules as
 * cloud/shared/paper.mjs (web app and Obsidian plugin); checked by checks/PaperDrawerCheck.kt.
 */
object PaperDrawer {
    /** The label every scan and every note with an expiry date gets. */
    const val LABEL = "Paper drawer"

    /** How long before `expires` the warning reminder goes off. */
    val WARN_LEADS = listOf("1w", "1m", "2m", "3m")

    private val DAY = Regex("^(\\d{4})-(\\d{2})-(\\d{2})$")

    /** `expires` as a real calendar date "YYYY-MM-DD", or null. */
    fun validExpires(value: String?): String? {
        val text = value?.trim() ?: return null
        if (!DAY.matches(text)) return null
        return runCatching { LocalDate.parse(text) }.getOrNull()?.toString()?.takeIf { it == text }
    }

    /** Expired from the day after `expires`. */
    fun isExpired(expires: String, today: LocalDate): Boolean = LocalDate.parse(expires).isBefore(today)

    /** The reminder ("YYYY-MM-DDT09:00") for a warning [lead] before [expires], or null. Months keep the day, or the last day of a shorter month. */
    fun warnReminder(expires: String?, lead: String?): String? {
        val day = validExpires(expires)?.let(LocalDate::parse) ?: return null
        val at = when (lead) {
            "1w" -> day.minusDays(7)
            "1m" -> day.minusMonths(1)
            "2m" -> day.minusMonths(2)
            "3m" -> day.minusMonths(3)
            else -> return null
        }
        return "${at}T09:00"
    }

    /** [labels] with the Paper drawer label added once (any letter case counts as present). */
    fun withLabel(labels: List<String>): List<String> =
        if (labels.any { isPaperDrawer(it) }) labels else labels + LABEL

    fun isPaperDrawer(label: String?): Boolean = label?.trim().equals(LABEL, ignoreCase = true)
}

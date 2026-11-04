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

    /** [labels] with the Paper drawer label added once; a small drawer or any letter case counts as present. */
    fun withLabel(labels: List<String>): List<String> =
        if (labels.any { isPaperDrawer(it) }) labels else labels + LABEL

    /** The Paper drawer label or one of its small drawers ("Paper drawer/Work"). */
    fun isPaperDrawer(label: String?): Boolean {
        val text = label?.trim()?.lowercase() ?: return false
        val base = LABEL.lowercase()
        return text == base || (text.startsWith("$base/") && text.length > base.length + 1)
    }

    /** The small drawers a new user is offered; more can be added. */
    val SUGGESTED_DRAWERS = listOf("Personal", "Work", "Home")
    const val DEFAULT_WARN = "1w"

    fun drawerLabel(name: String): String = "$LABEL/${name.trim()}"

    /** The small drawer's own name ("Work"), or "" for the drawer itself or another label. */
    fun drawerName(label: String?): String {
        val text = label?.trim() ?: return ""
        return if (isPaperDrawer(text) && text.contains('/')) text.substring(LABEL.length + 1).trim() else ""
    }

    /** Opening the Paper drawer shows every paper; a small drawer only its own. */
    fun inDrawer(labels: List<String>, selected: String?): Boolean {
        if (selected == null || !isPaperDrawer(selected)) return false
        val want = selected.trim()
        return labels.any { if (drawerName(want).isNotEmpty()) it.trim().equals(want, ignoreCase = true) else isPaperDrawer(it) }
    }

    private val EXTRA = mapOf('ø' to "o", 'æ' to "ae", 'œ' to "oe", 'ł' to "l", 'đ' to "d", 'ß' to "ss", 'ı' to "i", 'þ' to "th")
    private val MARKS = Regex("\\p{M}")

    /** Lower case without accents, so "Gültig" and an OCR'd "Gultig" read the same (as fold in cloud/shared/expiry.mjs). */
    fun fold(text: String): String {
        val plain = MARKS.replace(java.text.Normalizer.normalize(text.lowercase(), java.text.Normalizer.Form.NFD), "")
        return buildString { for (c in plain) append(EXTRA[c] ?: c) }
    }

    private fun escape(text: String): String = text.replace(Regex("[.*+?^\${}()|\\[\\]\\\\]")) { "\\" + it.value }
    private fun phrases(words: List<String>) =
        Regex("(?<![\\p{L}\\p{N}])(?:" + words.joinToString("|") { escape(it).replace(" ", "\\s+") } + ")(?!\\p{L})")
    private val END = phrases(ExpiryWords.END)
    private val PERIOD = phrases(ExpiryWords.PERIOD)
    private val MONTH_OF = ExpiryWords.MONTHS.toMap()
    private val M = "(" + ExpiryWords.MONTHS.joinToString("|") { it.first } + ")(?!\\p{L})\\.?(?:\\s*/\\s*\\p{L}+\\.?)?"

    // Each date form with the order of its groups; the same list and order as FORMS in cloud/shared/expiry.mjs.
    private val FORMS = listOf(
        Regex("(?<!\\d)(\\d{4})\\s*[-/.]\\s*(\\d{1,2})\\s*[-/.]\\s*(\\d{1,2})(?!\\d)") to "ymd",
        Regex("(?<!\\d)(\\d{1,2})\\s*[-/.]\\s*(\\d{1,2})\\s*[-/.]\\s*(\\d{4}|\\d{2})(?!\\d)") to "dmy",
        Regex("(?<!\\d)(\\d{1,2})(?:st|nd|rd|th|er|e)?\\.?\\s*(?:de\\s+|d')?$M,?\\s*(?:de\\s+|del\\s+)?(\\d{4})(?!\\d)") to "dMy",
        Regex("(?<!\\p{L})$M\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)") to "Mdy",
        Regex("(?<!\\d)(\\d{4})\\.?\\s*(?:m\\.\\s*)?$M\\s+(\\d{1,2})(?!\\d)") to "yMd",
        Regex("(?<!\\d)(\\d{4})\\.?\\s*gada\\s+(\\d{1,2})\\.?\\s*$M") to "ydM",
        Regex("(?<!\\p{L})$M\\s+(\\d{4})(?!\\d)") to "My",
        Regex("(?<![\\d/.-])(\\d{1,2})\\s*/\\s*(\\d{4}|\\d{2})(?![\\d/.-])|(?<![\\d/.-])(\\d{1,2})\\s*[-.]\\s*(\\d{4})(?![\\d/.-])") to "my",
    )

    private fun toDay(kind: String, g: List<String>): String {
        fun year4(v: String) = if (v.length == 2) 2000 + v.toInt() else v.toInt()
        val year: Int
        val month: Int
        var day: Int? = null
        when (kind) {
            "ymd" -> { year = g[1].toInt(); month = g[2].toInt(); day = g[3].toInt() }
            "dmy" -> {
                val a = g[1].toInt()
                val b = g[2].toInt()
                year = year4(g[3])
                if (b > 12 && a <= 12) { day = b; month = a } else { day = a; month = b }
            }
            "dMy" -> { day = g[1].toInt(); month = MONTH_OF[g[2]] ?: 0; year = g[3].toInt() }
            "Mdy" -> { month = MONTH_OF[g[1]] ?: 0; day = g[2].toInt(); year = g[3].toInt() }
            "yMd" -> { year = g[1].toInt(); month = MONTH_OF[g[2]] ?: 0; day = g[3].toInt() }
            "ydM" -> { year = g[1].toInt(); day = g[2].toInt(); month = MONTH_OF[g[3]] ?: 0 }
            "My" -> { month = MONTH_OF[g[1]] ?: 0; year = g[2].toInt() }
            else -> if (g[1].isNotEmpty()) { month = g[1].toInt(); year = year4(g[2]) } else { month = g[3].toInt(); year = g[4].toInt() }
        }
        if (month !in 1..12 || year !in 1900..2199) return ""
        val last = java.time.YearMonth.of(year, month).lengthOfMonth()
        val d = day ?: last
        if (d !in 1..last) return ""
        return String.format(java.util.Locale.US, "%04d-%02d-%02d", year, month, d)
    }

    private class Found(val start: Int, val end: Int, val day: String)

    /** The dates in folded [text], in reading order; where two forms overlap, the earlier form in FORMS wins. */
    private fun dates(text: String): List<String> {
        val taken = mutableListOf<Found>()
        for ((pattern, kind) in FORMS) {
            for (m in pattern.findAll(text)) {
                val start = m.range.first
                val end = m.range.last + 1
                if (taken.any { start < it.end && it.start < end }) continue
                val day = toDay(kind, m.groupValues)
                if (day.isNotEmpty()) taken += Found(start, end, day)
            }
        }
        return taken.sortedBy { it.start }.map { it.day }
    }

    private fun mrzValue(c: Char): Int = when {
        c == '<' -> 0
        c.isDigit() -> c - '0'
        else -> c.code - 55
    }
    private fun mrzCheck(field: String, digit: Char): Boolean =
        field.foldIndexed(0) { i, sum, c -> sum + mrzValue(c) * intArrayOf(7, 3, 1)[i % 3] } % 10 == digit - '0'
    private val TD3 = Regex("^[A-Z0-9<]{44}$")
    private val TD1 = Regex("^[0-9]{6}[0-9<][MF<][0-9]{6}[0-9][A-Z<]{3}[A-Z0-9<]{11}[0-9<]$")

    /** The expiry date in a passport (TD3) or ID card (TD1) machine-readable line, checked against its check digit. */
    private fun mrzExpiry(lines: List<String>): String {
        for (raw in lines) {
            val line = raw.filterNot(Char::isWhitespace).uppercase()
            val (field, digit) = when {
                TD3.matches(line) -> line.substring(21, 27) to line[27]
                TD1.matches(line) -> line.substring(8, 14) to line[14]
                else -> continue
            }
            if (!field.all(Char::isDigit) || !digit.isDigit() || !mrzCheck(field, digit)) continue
            val day = toDay("ymd", listOf("", "20" + field.substring(0, 2), field.substring(2, 4), field.substring(4, 6)))
            if (day.isNotEmpty()) return day
        }
        return ""
    }

    /**
     * The expiry date offered after a scan: from a passport or ID card line, else the latest date
     * that follows words that end something ("valid until", "THT", "due date") or close a period.
     */
    fun findExpiry(text: String?): String {
        val raw = (text ?: "").split(Regex("\\r?\\n"))
        mrzExpiry(raw).takeIf { it.isNotEmpty() }?.let { return it }
        val lines = raw.map(::fold)
        var best = ""
        lines.forEachIndexed { i, line ->
            for ((pattern, period) in listOf(END to false, PERIOD to true)) {
                for (hit in pattern.findAll(line)) {
                    var found = dates(line.substring(hit.range.last + 1))
                    if (found.isEmpty()) found = dates(lines.getOrElse(i + 1) { "" })
                    val day = if (period) found.maxOrNull() ?: "" else found.firstOrNull() ?: ""
                    if (day > best) best = day
                }
            }
        }
        return best
    }
}

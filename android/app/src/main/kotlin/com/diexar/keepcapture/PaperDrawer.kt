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

    private val MONTHS = listOf(
        listOf("jan", "january", "januari", "enero", "januar", "janvier", "ene"),
        listOf("feb", "february", "februari", "febrero", "februar", "février", "fevrier", "fév", "fev"),
        listOf("mar", "march", "maart", "mrt", "marzo", "märz", "marz", "mars"),
        listOf("apr", "april", "abril", "avril", "abr", "avr"),
        listOf("may", "mei", "mayo", "mai"),
        listOf("jun", "june", "juni", "junio", "juin"),
        listOf("jul", "july", "juli", "julio", "juillet", "juil"),
        listOf("aug", "august", "augustus", "agosto", "août", "aout", "ago"),
        listOf("sep", "sept", "september", "septiembre", "septembre"),
        listOf("oct", "october", "oktober", "okt", "octubre", "octobre"),
        listOf("nov", "november", "noviembre", "novembre"),
        listOf("dec", "december", "diciembre", "dezember", "décembre", "decembre", "dic", "dez", "déc"),
    )
    private val KEYWORD = Regex(
        "valid\\s+(?:until|thru|through|to)|date\\s+of\\s+expiry|expir(?:y|es|ation)(?:\\s+date)?|exp\\.?\\s*date|best\\s+before|use\\s+by|" +
            "geldig\\s+(?:tot|t/m)|vervaldatum|verloopt(?:\\s+op)?|houdbaar\\s+tot|te\\s+gebruiken\\s+tot|\\bt\\.?h\\.?t\\.?(?=[\\s:])|caducidad|" +
            "v[áa]lid[oa]\\s+hasta|vencimiento|g[üu]ltig\\s+bis|ablaufdatum|date\\s+d['’]expiration|valable\\s+jusqu",
        RegexOption.IGNORE_CASE,
    )
    private val DATE = Regex(
        "(\\d{4})-(\\d{2})-(\\d{2})|(\\d{1,2})\\s*[-/.]\\s*(\\d{1,2})\\s*[-/.]\\s*(\\d{4}|\\d{2})(?!\\d)|" +
            "(\\d{1,2})\\.?\\s+([A-Za-zÀ-ÿ]{3,10})\\.?,?\\s+(\\d{4})",
    )

    /** The first date in [text] as "YYYY-MM-DD", or "". Day first, unless only a month-first reading makes sense. */
    private fun firstDate(text: String): String {
        val g = DATE.find(text)?.groupValues ?: return ""
        val year: Int
        val month: Int
        val day: Int
        when {
            g[1].isNotEmpty() -> { year = g[1].toInt(); month = g[2].toInt(); day = g[3].toInt() }
            g[4].isNotEmpty() -> {
                val a = g[4].toInt()
                val b = g[5].toInt()
                year = if (g[6].length == 2) 2000 + g[6].toInt() else g[6].toInt()
                if (b > 12 && a <= 12) { day = b; month = a } else { day = a; month = b }
            }
            else -> {
                day = g[7].toInt()
                val word = g[8].lowercase().removeSuffix(".")
                month = MONTHS.indexOfFirst { word in it } + 1
                year = g[9].toInt()
            }
        }
        return validExpires(String.format(java.util.Locale.US, "%04d-%02d-%02d", year, month, day)) ?: ""
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
            validExpires("20${field.substring(0, 2)}-${field.substring(2, 4)}-${field.substring(4, 6)}")?.let { return it }
        }
        return ""
    }

    /** The expiry date offered after a scan: from a passport line, else the latest date after words like "valid until" or "geldig tot". */
    fun findExpiry(text: String?): String {
        val lines = (text ?: "").split(Regex("\\r?\\n"))
        mrzExpiry(lines).takeIf { it.isNotEmpty() }?.let { return it }
        var best = ""
        lines.forEachIndexed { i, line ->
            val hit = KEYWORD.find(line) ?: return@forEachIndexed
            val found = firstDate(line.substring(hit.range.last + 1)).ifEmpty { firstDate(lines.getOrElse(i + 1) { "" }) }
            if (found > best) best = found
        }
        return best
    }
}

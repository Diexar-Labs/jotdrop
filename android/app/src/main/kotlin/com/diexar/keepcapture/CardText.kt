package com.diexar.keepcapture

/**
 * Platte kaarttekst zonder Markdown-opmaaktekens. Spiegel van TS `plainPreviewText`
 * in `src/metadata.ts`: fence-regels, scheidingslijnen, tabel-scheidingsrijen en
 * citaat-/callout-tekens weg, tabelcellen met " · ", en nadruk, markering, inline
 * code, `<br>` en escapes weg. Tekst binnen een code-fence blijft staan; links,
 * wikilinks en lijstmarkers ook.
 */
object CardText {
    private val fenceMarker = Regex("^\\s{0,3}(`{3,}|~{3,})")
    private val rule = Regex("^\\s{0,3}([-*_])(?:[ \\t]*\\1){2,}[ \\t]*$")
    private val tableSeparator = Regex("^\\s*\\|?\\s*:?-+:?\\s*(?:\\|\\s*:?-+:?\\s*)+\\|?\\s*$")
    private val quote = Regex("^(?:\\s{0,3}>[ \\t]?)+")
    private val task = Regex("^\\s*[-*+][ \\t]+\\[[ xX]]")
    private val callout = Regex("^\\[![\\w-]+][+-]?[ \\t]*")
    private val tableRow = Regex("^\\s*\\|.*\\|\\s*$")
    private val cell = Regex("(?:\\\\.|[^|\\\\])+")
    private val marks = Regex(
        "\\\\([!-/:-@\\[-`{-~])|(`+)([^`\\n]+?)\\2|(\\*{3}|_{3}|\\*\\*|__|~~|==)(?=\\S)(.*?\\S)\\4|" +
            "(^|[^\\w*])\\*(?=[^\\s*])([^*\\n]*?[^\\s*])\\*(?!\\*)|(^|[^\\w_])_(?=[^\\s_])([^_\\n]*?[^\\s_])_(?!\\w)|<br\\s*/?>",
        RegexOption.IGNORE_CASE,
    )

    fun plain(text: String): String {
        var fence = ""
        val lines = mutableListOf<String>()
        for (line in text.split("\n")) {
            val marker = fenceMarker.find(line)?.groupValues?.get(1)
            if (marker != null) {
                if (fence.isEmpty()) fence = marker
                else if (marker[0] == fence[0] && marker.length >= fence.length) fence = ""
                continue
            }
            if (fence.isNotEmpty()) { lines.add(line); continue }
            if (rule.matches(line) || tableSeparator.matches(line)) continue
            // Een geciteerde checklist houdt zijn `>`: toggleChecklistItem telt hem niet, dus geen vinkje.
            val unquoted = quote.replaceFirst(line, "")
            val plain = callout.replaceFirst(if (unquoted != line && task.containsMatchIn(unquoted)) line else unquoted, "")
            lines.add(
                if (tableRow.matches(plain)) {
                    cell.findAll(plain).map { it.value.trim() }.filter { it.isNotEmpty() }.joinToString(" · ") { stripMarks(it) }
                } else {
                    stripMarks(plain)
                },
            )
        }
        return lines.joinToString("\n")
    }

    private fun stripMarks(text: String): String = marks.replace(text) { m ->
        val g = m.groups
        when {
            g[1] != null -> g[1]!!.value
            g[3] != null -> g[3]!!.value
            g[5] != null -> stripMarks(g[5]!!.value)
            g[7] != null -> g[6]!!.value + stripMarks(g[7]!!.value)
            g[9] != null -> g[8]!!.value + stripMarks(g[9]!!.value)
            else -> " "
        }
    }
}

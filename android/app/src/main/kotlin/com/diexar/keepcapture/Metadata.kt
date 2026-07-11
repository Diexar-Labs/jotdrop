package com.diexar.keepcapture

import androidx.annotation.StringRes
import androidx.compose.ui.graphics.Color

/**
 * Color names shared between plugin and app. Keep this in sync with the plugin
 * in Obsidian Keep Plugin/src/metadata.ts (same set of keys + order).
 *
 * `key` is the stable identifier persisted in note frontmatter.
 * `labelRes` is the localized display label, resolved via stringResource() in UI.
 */
enum class NoteColor(val key: String, @StringRes val labelRes: Int) {
    DEFAULT("default", R.string.color_default),
    RED("red", R.string.color_red),
    ORANGE("orange", R.string.color_orange),
    YELLOW("yellow", R.string.color_yellow),
    // GREEN/TEAL keys remain for backward compat with already-saved notes,
    // but the displayed colors are repainted to cream/slate-blue — no green.
    GREEN("green", R.string.color_green),
    TEAL("teal", R.string.color_teal),
    BLUE("blue", R.string.color_blue),
    PURPLE("purple", R.string.color_purple),
    PINK("pink", R.string.color_pink),
    BROWN("brown", R.string.color_brown),
    GRAY("gray", R.string.color_gray);

    companion object {
        fun fromKey(key: String?): NoteColor =
            entries.firstOrNull { it.key.equals(key, ignoreCase = true) } ?: DEFAULT
    }
}

/**
 * Pastel-paletwaarden die overeenkomen met de plugin (Google Keep-stijl).
 * Lichte set voor light theme; donkere set voor dark theme.
 */
object Palette {
    val light: Map<NoteColor, Color> = mapOf(
        NoteColor.DEFAULT to Color(0xFFFFF8F1),
        NoteColor.RED to Color(0xFFFAB0A8),
        NoteColor.ORANGE to Color(0xFFF6B690),
        NoteColor.YELLOW to Color(0xFFFFEFA8),
        NoteColor.GREEN to Color(0xFFFCE0BD),
        NoteColor.TEAL to Color(0xFFC6D3E0),
        NoteColor.BLUE to Color(0xFFC8DCEC),
        NoteColor.PURPLE to Color(0xFFDDC8EE),
        NoteColor.PINK to Color(0xFFF8C9DC),
        NoteColor.BROWN to Color(0xFFE6D5C3),
        NoteColor.GRAY to Color(0xFFE8E4EC),
    )

    val dark: Map<NoteColor, Color> = mapOf(
        NoteColor.DEFAULT to Color(0xFF2A2438),
        NoteColor.RED to Color(0xFF5E2A2F),
        NoteColor.ORANGE to Color(0xFF63441E),
        NoteColor.YELLOW to Color(0xFF5C4A1A),
        NoteColor.GREEN to Color(0xFF584320),
        NoteColor.TEAL to Color(0xFF334758),
        NoteColor.BLUE to Color(0xFF2E465E),
        NoteColor.PURPLE to Color(0xFF4A2D70),
        NoteColor.PINK to Color(0xFF5E2945),
        NoteColor.BROWN to Color(0xFF453122),
        NoteColor.GRAY to Color(0xFF3B3849),
    )
}

data class NoteMeta(
    val color: NoteColor = NoteColor.DEFAULT,
    val tags: List<String> = emptyList(),
    val pinned: Boolean = false,
    // ISO-string in lokale tijd zonder timezone-suffix, bv. "2026-05-14T14:30".
    // Wordt door ReminderScheduler omgezet naar epoch millis voor AlarmManager.
    val reminder: String? = null,
)

data class ParsedNote(
    val meta: NoteMeta,
    val body: String,
    val frontmatter: String,
)

/**
 * Lichte YAML-parser voor onze beperkte frontmatter (color/tags/pinned).
 * Dekt geen geneste structuren of multiline strings — we hebben dat niet nodig.
 */
object FrontmatterParser {

    // \A ankert op het BEGIN van de string. De oude MULTILINE-variant matchte
    // ook een '---'-paar midden in een notitie (twee horizontal rules!) en
    // substring(match.range.last + 1) gooide dan alle tekst erboven weg —
    // één pin-tap kon zo stilletjes body-tekst vernietigen.
    private val frontmatterRegex = Regex("\\A---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?")

    fun parse(content: String): ParsedNote {
        val match = frontmatterRegex.find(content)
        if (match == null) {
            return ParsedNote(NoteMeta(), content, "")
        }
        val yaml = match.groupValues[1]
        val body = content.substring(match.range.last + 1)
        val meta = parseMeta(yaml)
        return ParsedNote(meta, body, match.value)
    }

    private fun parseMeta(yaml: String): NoteMeta {
        var color = NoteColor.DEFAULT
        var pinned = false
        var reminder: String? = null
        val tags = mutableListOf<String>()
        val seen = mutableSetOf<String>()

        val lines = yaml.split('\n')
        var i = 0
        while (i < lines.size) {
            val raw = lines[i]
            val trimmed = raw.trim()
            if (trimmed.isEmpty() || trimmed.startsWith("#")) {
                i++
                continue
            }

            val colon = trimmed.indexOf(':')
            if (colon < 0) {
                i++
                continue
            }
            val key = trimmed.substring(0, colon).trim()
            val rawValue = trimmed.substring(colon + 1).trim()

            when (key.lowercase()) {
                "color" -> color = NoteColor.fromKey(unquote(rawValue))
                "pinned" -> pinned = parseBool(rawValue)
                "reminder" -> {
                    val v = unquote(rawValue).trim()
                    if (v.isNotEmpty()) reminder = v
                }
                "tags" -> {
                    if (rawValue.isEmpty()) {
                        // Block-style list — kijk naar volgende '- value' regels
                        var j = i + 1
                        while (j < lines.size) {
                            val next = lines[j]
                            val nextTrim = next.trim()
                            if (nextTrim.startsWith("- ")) {
                                val v = unquote(nextTrim.substring(2).trim())
                                if (v.isNotBlank()) addUnique(tags, seen, v)
                                j++
                            } else if (nextTrim.isEmpty()) {
                                j++
                            } else {
                                break
                            }
                        }
                        i = j
                        continue
                    } else if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
                        val inner = rawValue.substring(1, rawValue.length - 1)
                        for (part in splitInlineList(inner)) {
                            val v = unquote(part.trim())
                            if (v.isNotBlank()) addUnique(tags, seen, v)
                        }
                    } else {
                        // Comma- of whitespace-separated string
                        for (part in rawValue.split(Regex("[,\\s]+"))) {
                            val v = unquote(part.trim())
                            if (v.isNotBlank()) addUnique(tags, seen, v)
                        }
                    }
                }
            }
            i++
        }
        return NoteMeta(color = color, tags = tags.toList(), pinned = pinned, reminder = reminder)
    }

    private fun parseBool(value: String): Boolean {
        val v = unquote(value).lowercase()
        return v == "true" || v == "yes" || v == "y" || v == "on" || v == "1"
    }

    private fun unquote(value: String): String {
        if (value.length >= 2) {
            val first = value.first()
            val last = value.last()
            if ((first == '"' && last == '"') || (first == '\'' && last == '\'')) {
                return value.substring(1, value.length - 1)
            }
        }
        return value
    }

    private fun splitInlineList(input: String): List<String> {
        // Split op komma's BUITEN quotes: een tag mag zelf een komma bevatten
        // (FrontmatterWriter schrijft 'tags: ["foo, bar"]'). Naïef splitsen
        // leverde halve tags op die bij elke volgende write verder corrumpeerden.
        val parts = mutableListOf<String>()
        val sb = StringBuilder()
        var quote: Char? = null
        for (ch in input) {
            when {
                quote == null && (ch == '"' || ch == '\'') -> { quote = ch; sb.append(ch) }
                quote == ch -> { quote = null; sb.append(ch) }
                quote == null && ch == ',' -> { parts.add(sb.toString()); sb.setLength(0) }
                else -> sb.append(ch)
            }
        }
        parts.add(sb.toString())
        return parts.map { it.trim() }.filter { it.isNotEmpty() }
    }

    private fun addUnique(target: MutableList<String>, seen: MutableSet<String>, value: String) {
        val clean = value.removePrefix("#").trim()
        if (clean.isEmpty()) return
        val k = clean.lowercase()
        if (seen.add(k)) target.add(clean)
    }
}

/**
 * Schrijft frontmatter bovenaan een notitie. Houdt bestaande velden (anders dan
 * color/tags/pinned) in het frontmatter-blok intact zodat we andere
 * Obsidian-eigenschappen niet verwoesten.
 */
object FrontmatterWriter {

    /**
     * Geeft de volledige nieuwe inhoud terug (frontmatter + body), met de gegeven
     * meta toegepast. Bestaande frontmatter wordt samengevoegd: onbekende keys
     * blijven, gewijzigde keys worden bijgewerkt, en lege waardes worden
     * verwijderd.
     */
    fun apply(content: String, meta: NoteMeta): String {
        val parsed = FrontmatterParser.parse(content)
        val existingLines = if (parsed.frontmatter.isNotEmpty()) {
            extractYamlLines(parsed.frontmatter)
        } else {
            emptyList()
        }

        val newLines = mutableListOf<String>()
        val handled = setOf("color", "tags", "pinned", "reminder")

        // Bewaar onbekende keys in originele volgorde, sla blocks voor handled keys over.
        var i = 0
        while (i < existingLines.size) {
            val line = existingLines[i]
            val trimmed = line.trim()
            if (trimmed.isEmpty() || trimmed.startsWith("#")) {
                newLines.add(line)
                i++
                continue
            }
            val colon = trimmed.indexOf(':')
            if (colon < 0) {
                newLines.add(line)
                i++
                continue
            }
            val key = trimmed.substring(0, colon).trim().lowercase()
            if (key in handled) {
                // Skip deze key plus eventuele block-list eronder.
                i++
                if (trimmed.substring(colon + 1).trim().isEmpty()) {
                    while (i < existingLines.size && existingLines[i].trim().let { it.startsWith("- ") || it.isEmpty() }) {
                        i++
                    }
                }
            } else {
                newLines.add(line)
                i++
            }
        }

        // Voeg onze velden achteraan toe (alleen als niet default/leeg).
        if (meta.pinned) {
            newLines.add("pinned: true")
        }
        if (meta.color != NoteColor.DEFAULT) {
            newLines.add("color: ${meta.color.key}")
        }
        if (meta.tags.isNotEmpty()) {
            val flat = meta.tags.joinToString(", ") { yamlScalar(it) }
            newLines.add("tags: [${flat}]")
        }
        if (!meta.reminder.isNullOrBlank()) {
            newLines.add("reminder: ${yamlScalar(meta.reminder)}")
        }

        val body = parsed.body.removePrefix("\n")
        return if (newLines.isEmpty()) {
            body
        } else {
            buildString {
                append("---\n")
                for (l in newLines) {
                    append(l)
                    append('\n')
                }
                append("---\n")
                append(body)
            }
        }
    }

    private fun extractYamlLines(frontmatterBlock: String): List<String> {
        // frontmatterBlock = "---\n...\n---\n" — pak de middentekst.
        val withoutBoundaries = frontmatterBlock
            .removePrefix("---\n")
            .removePrefix("---\r\n")
            .removeSuffix("---\n")
            .removeSuffix("---\r\n")
            .removeSuffix("---")
        return withoutBoundaries.split('\n').filter { true }.let { list ->
            // Strip eventuele lege trailing regel afkomstig van split.
            if (list.isNotEmpty() && list.last().isBlank()) list.dropLast(1) else list
        }
    }

    private fun yamlScalar(value: String): String {
        // Quote alleen als nodig: bevat speciale tekens, komma's, of begint met #.
        return if (value.any { it in ":,#[]{}\"'" } || value.startsWith("#") || value.startsWith("-")) {
            "\"" + value.replace("\"", "\\\"") + "\""
        } else {
            value
        }
    }
}

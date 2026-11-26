package com.diexar.keepcapture

/**
 * The formatting core, as cloud/shared/format.mjs: pure text functions, the Markdown text stays the source.
 * Positions are UTF-16 indexes, the same as in JavaScript. Lines are split on `\n`; a `\r` at the end belongs to its
 * line. android/checks/FormatCheck.kt plays cloud/shared/format-vectors.json, the cases the web app passes too.
 */
internal object FormatCore {
    data class Block(val kind: String, val fromLine: Int, val toLine: Int, val from: Int, val to: Int)
    data class Table(val align: List<String>, val header: List<String>, val rows: List<List<String>>)

    private val fence = Regex("^ {0,3}(`{3,}|~{3,})")
    // GFM: a table starts at most 3 spaces in; a line in a quote or list item is no table.
    private val indentOk = Regex("^ {0,3}(?![ \\t])")
    private val quoteOrList = Regex("^ {0,3}(?:>|[-*+][ \\t]|\\d{1,9}[.)][ \\t])")
    private val delimiterCell = Regex("^:?-+:?$")
    private val escapedPipe = Regex("\\\\\\|")
    private val lineBreak = Regex("<br\\s*/?>", RegexOption.IGNORE_CASE)

    /** The positions of the `|` signs in a line that no `\` escapes. */
    private fun pipes(line: String): List<Int> {
        val at = mutableListOf<Int>()
        var i = 0
        while (i < line.length) {
            if (line[i] == '\\') i++ else if (line[i] == '|') at += i
            i++
        }
        return at
    }

    private fun withoutCr(line: String) = line.removeSuffix("\r")

    /** JavaScript's String.trim: whitespace and line terminators at both ends. */
    private fun jsTrim(text: String) = text.trim { it.isWhitespace() || it == '﻿' }

    /** The cells of one table line, as source: one `|` at the start and one at the end go, then it splits on every unescaped `|`. */
    fun tableCells(line: String): List<String> {
        var text = jsTrim(withoutCr(line))
        var at = pipes(text)
        if (text.startsWith("|")) { text = text.substring(1); at = at.drop(1).map { it - 1 } }
        if (at.isNotEmpty() && at.last() == text.length - 1) { text = text.dropLast(1); at = at.dropLast(1) }
        val cells = mutableListOf<String>()
        var from = 0
        for (i in at) { cells += text.substring(from, i); from = i + 1 }
        cells += text.substring(from)
        return cells
    }

    private fun delimiterAligns(line: String): List<String>? {
        if (!indentOk.containsMatchIn(line) || pipes(withoutCr(line)).isEmpty()) return null
        val cells = tableCells(line).map(::jsTrim)
        if (!cells.all { delimiterCell.matches(it) }) return null
        return cells.map {
            when {
                it.startsWith(":") && it.endsWith(":") -> "center"
                it.endsWith(":") -> "right"
                it.startsWith(":") -> "left"
                else -> ""
            }
        }
    }

    private fun isHeader(line: String) =
        indentOk.containsMatchIn(line) && !quoteOrList.containsMatchIn(line) && pipes(withoutCr(line)).isNotEmpty()

    /**
     * The text in runs of whole lines: `text`, `code` (a fence with its fence lines; an unclosed fence runs to the end)
     * and `table`, with `to` at the end of the last line, before its `\n`. The runs together cover every line.
     */
    fun blocks(text: String): List<Block> {
        val lines = text.split('\n')
        val starts = IntArray(lines.size)
        var offset = 0
        for ((i, line) in lines.withIndex()) { starts[i] = offset; offset += line.length + 1 }
        val out = mutableListOf<Block>()
        fun add(kind: String, fromLine: Int, toLine: Int) {
            val last = out.lastOrNull()
            val to = starts[toLine] + lines[toLine].length
            if (kind == "text" && last?.kind == "text") out[out.size - 1] = last.copy(toLine = toLine, to = to)
            else out += Block(kind, fromLine, toLine, starts[fromLine], to)
        }
        var i = 0
        while (i < lines.size) {
            val open = fence.find(lines[i])?.groupValues?.get(1)
            if (open != null) {
                var end = i + 1
                while (end < lines.size) {
                    val close = fence.find(lines[end])?.groupValues?.get(1)
                    if (close != null && close[0] == open[0] && close.length >= open.length &&
                        jsTrim(withoutCr(lines[end]).substring(lines[end].indexOf(close) + close.length)).isEmpty()) break
                    end++
                }
                end = minOf(end, lines.size - 1)
                add("code", i, end)
                i = end + 1
                continue
            }
            val aligns = if (i + 1 < lines.size && isHeader(lines[i])) delimiterAligns(lines[i + 1]) else null
            if (aligns != null && aligns.size == tableCells(lines[i]).size) {
                var end = i + 1
                while (end + 1 < lines.size && jsTrim(withoutCr(lines[end + 1])).isNotEmpty() &&
                    pipes(withoutCr(lines[end + 1])).isNotEmpty() && !fence.containsMatchIn(lines[end + 1])) end++
                add("table", i, end)
                i = end + 1
                continue
            }
            add("text", i, i)
            i++
        }
        return out
    }

    /** A table's lines as align, header and rows; short rows are filled with empty cells, extra cells are not shown. */
    fun parseTable(lines: List<String>): Table {
        val header = tableCells(lines[0]).map(::jsTrim)
        val align = delimiterAligns(lines[1]) ?: header.map { "" }
        val rows = lines.drop(2).map { line ->
            val cells = tableCells(line).map(::jsTrim)
            header.indices.map { cells.getOrElse(it) { "" } }
        }
        return Table(align, header, rows)
    }

    /** What a cell shows: `\|` is `|`, `<br>` is a line break. Other Markdown stays for the caller. */
    fun cellText(source: String): String = source.replace(escapedPipe, "|").replace(lineBreak, "\n")

    /** A cell's display text back as source: `|` becomes `\|`, a line break `<br>`, no spaces at the edges. */
    fun cellSource(text: String): String = jsTrim(text).replace("|", "\\|").replace(Regex("\\r?\\n"), "<br>")

    // -----------------------------------------------------------------------------------------------------------
    // The editor (phase 3): the same functions as the second half of format.mjs. Every one reads the text and gives at
    // most one replacement: from/to/insert in positions of the text it was given, the selection in the text after it.
    // JavaScript's \s, \w, . and $ differ from Java's, so they are written out here as JavaScript reads them.

    data class Span(val kind: String, val from: Int, val to: Int, val openTo: Int, val closeFrom: Int, val href: String? = null, val target: String? = null)
    data class Prefix(val kind: String, val indent: Int, val markFrom: Int, val markTo: Int, val level: Int = 0, val number: Long = 0, val delimiter: String = "", val checked: Boolean = false)
    data class Edit(val from: Int, val to: Int, val insert: String, val selFrom: Int, val selTo: Int = selFrom)
    data class EmptyPair(val from: Int, val to: Int, val signs: List<String>, val kinds: List<String>)

    /** JavaScript's \s as a character class body. */
    private const val SP = """\t\n\u000B\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF"""
    private const val DOT = """[^\n\r\u2028\u2029]"""
    private val inlinePattern = java.util.regex.Pattern.compile(
        """\\(?<esc>[!-/:-@\[-`{-~])|(?<ticks>`+)(?<code>[^`\n]+?)\k<ticks>|(?<embed>!?)\[\[(?<target>[^\]\n|]+)(?:\|(?<alias>[^\]\n]+))?\]\]""" +
            """|(?<image>!?)\[(?<label>[^\]\n]+)\]\((?<href>[^()$SP]+)\)|(?<url>https?://[^$SP<>"'`]*[^$SP<>"'`.,;:!?)\]}])""" +
            """|(?<mark>\*{3}|_{3}|\*\*|__|~~|==)(?=[^$SP])(?<marked>$DOT*?[^$SP])\k<mark>""" +
            """|(?<starLead>^|[^\w*])\*(?=[^$SP*])(?<star>[^*\n]*?[^$SP*])\*(?!\*)|(?<underLead>^|[^\w_])_(?=[^${SP}_])(?<under>[^_\n]*?[^${SP}_])_(?!\w)""",
    )
    private val markKind = mapOf("**" to "bold", "__" to "bold", "~~" to "strike", "==" to "highlight")

    private fun isSpace(c: Char) = c in "\t\n\u000B\u000C\r \u00A0\u1680\u2028\u2029\u202F\u205F\u3000\uFEFF" || c in '\u2000'..'\u200A'

    private val wordTypes = setOf(
        Character.UPPERCASE_LETTER, Character.LOWERCASE_LETTER, Character.TITLECASE_LETTER, Character.MODIFIER_LETTER, Character.OTHER_LETTER,
        Character.DECIMAL_DIGIT_NUMBER, Character.LETTER_NUMBER, Character.OTHER_NUMBER,
    ).map { it.toInt() }.toSet()
    private val markTypes = setOf(Character.NON_SPACING_MARK, Character.ENCLOSING_MARK, Character.COMBINING_SPACING_MARK).map { it.toInt() }.toSet()

    /** A letter, digit, `_` or apostrophe; a letter's accent belongs to its word, an emoji's variation selector not. */
    private fun isWord(c: Char?): Boolean {
        if (c == null) return false
        if (c == '_' || c == '\'' || c == '’') return true
        val type = Character.getType(c)
        return type in wordTypes || (type in markTypes && c != '\uFE0E' && c != '\uFE0F')
    }

    private fun scanInline(text: String, offset: Int, out: MutableList<Span>) {
        val match = inlinePattern.matcher(text)
        while (match.find()) {
            val start = offset + match.start()
            val end = offset + match.end()
            fun group(name: String): String? = match.group(name)
            when {
                group("esc") != null -> out += Span("escape", start, end, start + 1, end)
                group("code") != null -> {
                    val ticks = group("ticks")!!.length
                    out += Span("code", start, end, start + ticks, end - ticks)
                }
                group("target") != null -> {
                    // An embed (![[file]]) stays as it is written.
                    val target = group("target")!!
                    if (group("embed")!!.isEmpty()) {
                        out += Span("wikilink", start, end, if (group("alias") == null) start + 2 else start + 3 + target.length, end - 2, target = target)
                    }
                }
                group("href") != null -> {
                    // So does an image (![alt](file)).
                    if (group("image")!!.isEmpty()) {
                        val label = group("label")!!
                        out += Span("link", start, end, start + 1, start + 1 + label.length, href = group("href"))
                        scanInline(label, start + 1, out)
                    }
                }
                group("url") != null -> out += Span("url", start, end, start, end, href = group("url"))
                group("mark") != null -> {
                    val sign = group("mark")!!
                    if (sign.length == 3) {
                        out += Span("bold", start, end, start + 2, end - 2)
                        out += Span("italic", start + 2, end - 2, start + 3, end - 3)
                    } else out += Span(markKind.getValue(sign), start, end, start + 2, end - 2)
                    scanInline(group("marked")!!, start + sign.length, out)
                }
                else -> {
                    val lead = (group("starLead") ?: group("underLead"))!!.length
                    val inner = (group("star") ?: group("under"))!!
                    out += Span("italic", start + lead, end, start + lead + 1, end - 1)
                    scanInline(inner, start + lead + 1, out)
                }
            }
        }
    }

    /** The formatting in one line, outer spans first: bold, italic, strike, highlight, code, link, wikilink, url, escape. */
    fun inlineSpans(line: String): List<Span> {
        val out = mutableListOf<Span>()
        scanInline(line, 0, out)
        return out.sortedWith(compareBy<Span> { it.from }.thenByDescending { it.to })
    }

    private val rule = Regex("""^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*\z""")
    private val heading = Regex("""^( {0,3})(#{1,6})(?:[ \t]+|\z)""")
    private val quote = Regex("""^([ \t]*)>[ \t]?""")
    private val task = Regex("""^([ \t]*)([-*+])[ \t]+\[([ xX])\](?:[ \t]+|\z)""")
    private val bullet = Regex("""^([ \t]*)([-*+])[ \t]+""")
    private val ordered = Regex("""^([ \t]*)(\d{1,9})([.)])[ \t]+""")
    private val leadingIndent = Regex("""^[ \t]*""")

    /** How a line starts: bullet, ordered, task, quote, heading, rule or "" (nothing); the sign runs markFrom to markTo. */
    fun linePrefix(line: String): Prefix {
        val text = withoutCr(line)
        val indent = leadingIndent.find(text)!!.value.length
        if (rule.containsMatchIn(text)) return Prefix("rule", indent, indent, text.length)
        heading.find(text)?.let { return Prefix("heading", indent, it.groupValues[1].length, it.value.length, level = it.groupValues[2].length) }
        quote.find(text)?.let { return Prefix("quote", indent, it.groupValues[1].length, it.value.length) }
        task.find(text)?.let { return Prefix("task", indent, it.groupValues[1].length, it.value.length, checked = it.groupValues[3] != " ") }
        bullet.find(text)?.let { return Prefix("bullet", indent, it.groupValues[1].length, it.value.length) }
        ordered.find(text)?.let {
            return Prefix("ordered", indent, it.groupValues[1].length, it.value.length, number = it.groupValues[2].toLong(), delimiter = it.groupValues[3])
        }
        return Prefix("", indent, indent, indent)
    }

    private val signs = linkedMapOf("bold" to "**", "italic" to "*", "strike" to "~~", "highlight" to "==", "code" to "`")
    private val signKind = mapOf("**" to "bold", "*" to "italic", "~~" to "strike", "==" to "highlight", "`" to "code")
    private fun isPairSign(c: Char?) = c == '*' || c == '~' || c == '=' || c == '`'

    /** The signs of the left half of an empty pair, outer first (`***` is bold around italic), or null. */
    private fun pairSigns(run: String): List<String>? {
        val found = mutableListOf<String>()
        var i = 0
        while (i < run.length) {
            val two = run.substring(i, minOf(i + 2, run.length))
            val sign = when {
                two == "**" || two == "~~" || two == "==" -> two
                run[i] == '*' || run[i] == '`' -> run[i].toString()
                else -> return null
            }
            if (found.any { signKind[it] == signKind[sign] }) return null
            found += sign
            i += sign.length
        }
        return found
    }

    /**
     * An empty pair around the caret: a button pressed before typing (`**¦**`, `***¦***`, `~~¦~~`). The editor hides its
     * signs and shows the buttons as on; what is typed lands between the signs. Signs against a word are no pair.
     */
    fun emptyPair(text: String, selFrom: Int, selTo: Int = selFrom): EmptyPair? {
        if (selFrom != selTo || selFrom < 0 || selFrom > text.length) return null
        var from = selFrom
        var to = selFrom
        while (from > 0 && isPairSign(text[from - 1])) from--
        while (to < text.length && isPairSign(text[to])) to++
        if (from == selFrom || to == selFrom || isWord(text.getOrNull(from - 1)) || isWord(text.getOrNull(to))) return null
        val found = pairSigns(text.substring(from, selFrom)) ?: return null
        if (found.reversed().joinToString("") != text.substring(selFrom, to)) return null
        return EmptyPair(from, to, found, found.map { signKind.getValue(it) })
    }

    /** The text with an empty pair's signs as spaces: the same positions, but `****` is no rule and `~~~~` no fence. */
    fun maskPair(text: String, pair: EmptyPair?): String =
        if (pair == null) text else text.substring(0, pair.from) + " ".repeat(pair.to - pair.from) + text.substring(pair.to)

    /** One replacement that turns [before] into [after]: the common start and end stay out of it. */
    private fun replacement(before: String, after: String, selFrom: Int, selTo: Int = selFrom): Edit? {
        if (before == after) return null
        val max = minOf(before.length, after.length)
        var from = 0
        while (from < max && before[from] == after[from]) from++
        var end = 0
        while (end < max - from && before[before.length - 1 - end] == after[after.length - 1 - end]) end++
        return Edit(from, before.length - end, after.substring(from, after.length - end), selFrom, selTo)
    }

    private data class Change(val from: Int, val to: Int, val insert: String)

    private class Applied(val text: String, private val sorted: List<Change>) {
        /** Where [pos] lands. At an insertion [after] puts it behind the inserted text; in a removed range it goes to its start. */
        fun map(pos: Int, after: Boolean = false): Int {
            var delta = 0
            for (edit in sorted) {
                val insertion = edit.from == edit.to
                if (pos < edit.from || (insertion && pos == edit.from && !after)) break
                if (insertion && pos == edit.from) return pos + delta + edit.insert.length
                if (!insertion && pos <= edit.to) return edit.from + delta + if (pos == edit.to && after) edit.insert.length else 0
                delta += edit.insert.length - (edit.to - edit.from)
            }
            return pos + delta
        }
    }

    private fun applyEdits(text: String, edits: List<Change>): Applied {
        val sorted = edits.filter { it.from != it.to || it.insert.isNotEmpty() }.sortedWith(compareBy<Change> { it.from }.thenBy { it.to })
        val out = StringBuilder()
        var last = 0
        for (edit in sorted) { out.append(text, last, edit.from).append(edit.insert); last = edit.to }
        out.append(text, last, text.length)
        return Applied(out.toString(), sorted)
    }

    private class Lines(text: String) {
        val lines = text.split('\n')
        val starts = IntArray(lines.size).also { starts ->
            var offset = 0
            for ((i, line) in lines.withIndex()) { starts[i] = offset; offset += line.length + 1 }
        }

        /** The line [pos] is on. */
        fun at(pos: Int): Int {
            var lo = 0
            var hi = lines.size - 1
            while (lo < hi) {
                val mid = (lo + hi + 1) shr 1
                if (starts[mid] <= pos) lo = mid else hi = mid - 1
            }
            return lo
        }
    }

    private fun blank(line: String?) = line == null || jsTrim(line).isEmpty()

    /** The kind of run (text, code, table) each line is in. */
    private fun lineKinds(text: String): Array<String> {
        val runs = blocks(text)
        val kinds = Array(runs.last().toLine + 1) { "text" }
        for (run in runs) for (line in run.fromLine..run.toLine) kinds[line] = run.kind
        return kinds
    }

    /** The lines a selection touches; a selection that ends at the very start of a line leaves that line out. */
    private fun touchedLines(table: Lines, from: Int, to: Int): kotlin.Pair<Int, Int> {
        val first = table.at(from)
        var last = table.at(to)
        if (to > from && last > first && to == table.starts[last]) last--
        return first to last
    }

    private fun spansOfLine(table: Lines, index: Int): List<Span> {
        val start = table.starts[index]
        return inlineSpans(table.lines[index]).map { it.copy(from = it.from + start, to = it.to + start, openTo = it.openTo + start, closeFrom = it.closeFrom + start) }
    }

    private val onlySigns = Regex("^[*_~=`]*$")

    /** The span of [kind] that holds the selection (signs included); a caret must be strictly inside. */
    private fun holder(spans: List<Span>, kind: String, a: Int, b: Int, text: String? = null): Span? = spans.firstOrNull { span ->
        span.kind == kind && if (a == b) span.from < a && a < span.to
        else (span.from <= a && b <= span.to) ||
            (a <= span.from && span.to <= b && text != null && onlySigns.matches(text.substring(a, span.from) + text.substring(span.to, b)))
    }

    private class Segment(val a: Int, val b: Int, val spans: List<Span>, val own: Span?)
    private class Plan(val remove: Boolean, val edits: List<Change>, val caret: Int? = null, val a: Int = 0, val b: Int = 0, val step: Int? = null)

    /** The analysis behind an inline button: what it would take away, or where it would add its signs. */
    private fun inlinePlan(text: String, selFrom: Int, selTo: Int, kind: String): Plan? {
        val sign = signs.getValue(kind)
        val table = Lines(text)
        val kinds = lineKinds(text)
        if (selFrom == selTo) {
            val caret = selFrom
            val pair = emptyPair(text, caret)
            if (pair != null) {
                // In an empty pair a button that is on takes its own signs away; another one adds its signs inside.
                val at = pair.kinds.indexOf(kind)
                if (at < 0) return Plan(false, listOf(Change(caret, caret, sign), Change(caret, caret, sign)), caret)
                val offset = pair.signs.take(at).sumOf { it.length }
                val left = pair.from + offset
                val right = pair.to - offset - sign.length
                return Plan(true, listOf(Change(left, left + sign.length, ""), Change(right, right + sign.length, "")), caret)
            }
            val index = table.at(caret)
            if (kinds[index] == "code") return null
            val spans = spansOfLine(table, index)
            val own = holder(spans, kind, caret, caret)
            // At the end of the formatted words the button stops the formatting there, as in a word processor.
            if (own != null && caret == own.closeFrom && own.closeFrom > own.openTo) return Plan(true, emptyList(), caret, step = own.to)
            if (own != null) return Plan(true, listOf(Change(own.from, own.openTo, ""), Change(own.closeFrom, own.to, "")), caret)
            // No signs inside code, a web address or a link to a note.
            if (spans.any { it.kind in setOf("code", "url", "wikilink") && it.from < caret && caret < it.to }) return null
            val lineStart = table.starts[index]
            val lineEnd = lineStart + withoutCr(table.lines[index]).length
            var a = caret
            var b = caret
            // A caret in a word formats that word: selecting is awkward on a phone.
            while (a > lineStart && isWord(text[a - 1])) a--
            while (b < lineEnd && isWord(text[b])) b++
            return Plan(false, listOf(Change(a, a, sign), Change(b, b, sign)), caret)
        }
        val (first, last) = touchedLines(table, selFrom, selTo)
        val segments = mutableListOf<Segment>()
        for (index in first..last) {
            if (kinds[index] == "code") continue
            val lineStart = table.starts[index]
            val line = withoutCr(table.lines[index])
            var a = maxOf(selFrom, lineStart + linePrefix(line).markTo)
            var b = minOf(selTo, lineStart + line.length)
            // Spaces at the edges of the selection do not count.
            while (a < b && isSpace(text[a])) a++
            while (b > a && isSpace(text[b - 1])) b--
            if (a >= b) continue
            val spans = spansOfLine(table, index)
            segments += Segment(a, b, spans, holder(spans, kind, a, b, text))
        }
        if (segments.isEmpty()) return null
        val remove = segments.all { it.own != null }
        val edits = mutableListOf<Change>()
        for (segment in segments) {
            val own = segment.own
            if (remove && own != null) {
                edits += Change(own.from, own.openTo, "")
                edits += Change(own.closeFrom, own.to, "")
            } else if (own == null) {
                // The same formatting inside the selection goes, so it is not doubled.
                for (span in segment.spans) {
                    if (span.kind == kind && segment.a <= span.from && span.to <= segment.b) {
                        edits += Change(span.from, span.openTo, "")
                        edits += Change(span.closeFrom, span.to, "")
                    }
                }
                edits += Change(segment.a, segment.a, sign)
                edits += Change(segment.b, segment.b, sign)
            }
        }
        return Plan(remove, edits, a = segments.first().a, b = segments.last().b)
    }

    private fun inlineFormat(text: String, selFrom: Int, selTo: Int, kind: String): Edit? {
        val plan = inlinePlan(text, selFrom, selTo, kind) ?: return null
        val caret = plan.caret
        // Stepping out changes no text: an empty replacement that only moves the caret.
        if (plan.step != null && caret != null) return Edit(caret, caret, "", plan.step)
        val applied = applyEdits(text, plan.edits)
        if (caret != null) {
            // The caret stays in the same place in the words: behind the opening sign that is added in front of it.
            return replacement(text, applied.text, if (plan.remove) applied.map(caret) else caret + signs.getValue(kind).length)
        }
        return replacement(text, applied.text, applied.map(plan.a, true), applied.map(plan.b, false))
    }

    /** The lines a line button works on: every touched line, blank ones left out when there are several. */
    private fun lineTargets(table: Lines, kinds: Array<String>, selFrom: Int, selTo: Int): List<Int> {
        val (first, last) = touchedLines(table, selFrom, selTo)
        return (first..last).filter { kinds[it] == "text" && !(first != last && blank(table.lines[it])) }
    }

    private fun lineFormat(text: String, selFrom: Int, selTo: Int, command: String): Edit? {
        val table = Lines(text)
        val kinds = lineKinds(text)
        val targets = lineTargets(table, kinds, selFrom, selTo)
        if (targets.isEmpty()) return null
        val prefixes = targets.map { linePrefix(table.lines[it]) }
        val edits = mutableListOf<Change>()
        fun set(index: Int, from: Int, to: Int, insert: String) { edits += Change(table.starts[index] + from, table.starts[index] + to, insert) }
        when (command) {
            "heading" -> {
                // None, then ##, then ###, then none again. Never #: the first # heading is the note's title.
                val level = if (prefixes[0].kind == "heading") prefixes[0].level else 0
                val next = if (level <= 1) 2 else if (level == 2) 3 else 0
                targets.forEachIndexed { i, index ->
                    val prefix = prefixes[i]
                    if (prefix.kind == "heading") set(index, prefix.markFrom, prefix.markTo, if (next > 0) "#".repeat(next) + " " else "")
                    else if (next > 0) set(index, prefix.indent, prefix.indent, "#".repeat(next) + " ")
                }
            }
            "quote" -> {
                val all = prefixes.all { it.kind == "quote" }
                targets.forEachIndexed { i, index ->
                    val prefix = prefixes[i]
                    if (all) set(index, prefix.markFrom, prefix.markTo, "") else if (prefix.kind != "quote") set(index, 0, 0, "> ")
                }
            }
            else -> {
                // A task counts as a bullet: the bullet button takes its sign away instead of turning it into a plain item.
                fun same(prefix: Prefix) = if (command == "bullet") prefix.kind == "bullet" || prefix.kind == "task" else prefix.kind == "ordered"
                val all = prefixes.all(::same)
                var number = 1
                targets.forEachIndexed { i, index ->
                    val prefix = prefixes[i]
                    val list = prefix.kind in setOf("bullet", "task", "ordered")
                    val from = if (list) prefix.markFrom else prefix.indent
                    val to = if (list) prefix.markTo else prefix.indent
                    when {
                        all -> set(index, prefix.markFrom, prefix.markTo, "")
                        command == "bullet" -> if (!same(prefix)) set(index, from, to, "- ")
                        else -> set(index, from, to, "${number++}. ")
                    }
                }
            }
        }
        val applied = applyEdits(text, edits.filter { text.substring(it.from, it.to) != it.insert })
        if (applied.text == text) return null
        if (selFrom == selTo) return replacement(text, applied.text, applied.map(selFrom, true))
        return replacement(text, applied.text, applied.map(selFrom), applied.map(selTo, true))
    }

    /** A block of whole lines (a rule, a table) on the caret's line when that is blank, else under it, with blank lines around. */
    private fun insertBlock(text: String, pos: Int, block: List<String>, caretAfter: Boolean): Edit? {
        val table = Lines(text)
        val lines = table.lines
        val index = table.at(pos)
        val cr = if (lines[index].endsWith("\r")) "\r" else ""
        var at = index + 1
        var remove = 0
        if (blank(lines[index]) && (index == 0 || blank(lines[index - 1]))) { at = index; remove = 1 }
        val before = if (at > 0 && !blank(lines[at - 1])) listOf("") else emptyList()
        val rest = at + remove
        val after = if (rest < lines.size) (if (blank(lines[rest])) emptyList() else listOf("")) else if (caretAfter) listOf("") else emptyList()
        val next = lines.subList(0, at) + (before + block + after).map { it + cr } + lines.subList(rest, lines.size)
        val out = next.joinToString("\n")
        val blockStart = next.subList(0, at + before.size).sumOf { it.length + 1 }
        val lastLine = at + before.size + block.size - 1
        // After a rule the caret goes to the start of the line right under it.
        val caret = if (caretAfter) next.subList(0, lastLine + 1).sumOf { it.length + 1 } else blockStart
        return replacement(text, out, minOf(caret, out.length))
    }

    /** A new table of 3 columns: the header and 2 rows, all cells empty. The selection lands at its start. */
    fun insertTable(text: String, pos: Int): Edit? {
        val row = "|  |  |  |"
        return insertBlock(text, pos, listOf(row, "| --- | --- | --- |", row, row), false)
    }

    /** The formatting buttons: bold, italic, strike, highlight, code, heading, bullet, ordered, quote, rule, table. */
    fun applyFormat(text: String, selFrom: Int, selTo: Int, command: String): Edit? {
        val from = maxOf(0, minOf(selFrom, selTo, text.length))
        val to = minOf(text.length, maxOf(selFrom, selTo))
        if (command in signs) return inlineFormat(text, from, to, command)
        if (command in setOf("heading", "bullet", "ordered", "quote")) return lineFormat(text, from, to, command)
        if (command != "rule" && command != "table") return null
        if (lineKinds(text)[Lines(text).at(to)] != "text") return null
        return if (command == "rule") insertBlock(text, to, listOf("---"), true) else insertTable(text, to)
    }

    /**
     * Which buttons are "on": exactly when pressing them would take formatting away, plus an empty pair's kinds,
     * `checklist` on a task, `table` in a table and `codeblock` in a code block.
     */
    fun activeFormats(text: String, selFrom: Int, selTo: Int): List<String> {
        val from = maxOf(0, minOf(selFrom, selTo, text.length))
        val to = minOf(text.length, maxOf(selFrom, selTo))
        val pair = emptyPair(text, from, to)
        val plain = maskPair(text, pair)
        val table = Lines(plain)
        val kinds = lineKinds(plain)
        val index = table.at(from)
        if (kinds[index] == "code") return listOf("codeblock")
        val on = mutableListOf<String>()
        if (kinds[index] == "table") on += "table"
        for (kind in signs.keys) if (pair?.kinds?.contains(kind) == true || inlinePlan(plain, from, to, kind)?.remove == true) on += kind
        val line = when (linePrefix(table.lines[index]).kind) {
            "heading" -> "heading"
            "bullet" -> "bullet"
            "ordered" -> "ordered"
            "task" -> "checklist"
            "quote" -> "quote"
            else -> null
        }
        if (line != null && kinds[index] == "text") on += line
        return on.sorted()
    }

    /**
     * Backspace with the caret right behind signs the formatted view hides ([hidden]: from the editor's own display).
     * As in a word processor it takes the last visible letter before them, not half a sign that would then show; right
     * behind a heading's hidden `## ` the line becomes plain text; behind hidden signs at the start of a line it joins
     * the line above. In an empty pair the whole pair goes. Null: an ordinary Backspace.
     */
    fun backspaceEdit(text: String, caret: Int, hidden: List<IntRange>): Edit? {
        emptyPair(text, caret)?.let { return Edit(it.from, it.to, "", it.from) }
        var start = caret
        while (true) start = hidden.firstOrNull { it.last + 1 == start && it.first < start }?.first ?: break
        if (start == caret) return null
        fun at(from: Int, to: Int = start) = Edit(from, to, "", caret - (to - from))
        val lineStart = if (start == 0) 0 else text.lastIndexOf('\n', start - 1) + 1
        val next = text.indexOf('\n', lineStart)
        val prefix = linePrefix(text.substring(lineStart, if (next < 0) text.length else next))
        if (prefix.kind == "heading" && start == lineStart + prefix.markFrom && caret >= lineStart + prefix.markTo) {
            return at(lineStart + prefix.markFrom, lineStart + prefix.markTo)
        }
        if (start == lineStart) return if (start == 0) at(caret, caret) else at(if (start >= 2 && text[start - 2] == '\r') start - 2 else start - 1)
        val pairStart = start >= 2 && text[start - 1].isLowSurrogate() && text[start - 2].isHighSurrogate()
        val from = if (pairStart) start - 2 else start - 1
        // The last letter of formatted words: its signs go with it, so no `****` is left to see.
        val left = emptyPair(text.removeRange(from, start), from)
        return if (left != null) at(left.from, left.to + (start - from)) else at(from)
    }

    private val listItem = Regex("""^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))[ \t]+(?:\[([ xX])\](?:[ \t]+|\z))?""")

    /**
     * Enter in a list: the next item gets the same sign (a bullet, the next number, an empty box), and Enter on an empty
     * item takes its sign away. On any text line, Enter inside bold, italic, strike, highlight or code goes on in it:
     * the line is closed before the break and opened again after it; an empty pair moves along. Null: an ordinary Enter.
     */
    fun listEnterEdit(text: String, selFrom: Int, selTo: Int = selFrom): Edit? {
        var from = selFrom
        var to = selTo
        val lineStart = if (from <= 0) 0 else text.lastIndexOf('\n', from - 1) + 1
        val next = text.indexOf('\n', from)
        val lineEnd = if (next < 0) text.length else next
        if (lineStart > lineEnd) return null
        val line = text.substring(lineStart, lineEnd)
        if (to > lineEnd) return null
        if (lineKinds(text)[Lines(text).at(lineStart)] != "text") return null
        // A CRLF line keeps its `\r`, and the new line gets one too.
        val cr = if (line.endsWith("\r")) "\r" else ""
        val contentEnd = lineEnd - cr.length
        from = minOf(from, contentEnd)
        to = minOf(to, contentEnd)
        val list = listItem.find(line)?.takeIf { from >= lineStart + it.value.length }

        // The formatting the caret is in: `at` is where the break goes, before signs right in front of the caret.
        var at = from
        var close = ""
        var open = ""
        var before = ""
        var after = ""
        val pair = if (from == to) emptyPair(text, from) else null
        if (pair != null) at = pair.from
        else if (from == to) {
            val offset = lineStart + linePrefix(line).markTo
            val spans = inlineSpans(text.substring(offset, contentEnd)).filter { it.kind in carried }
                .map { Span(it.kind, it.from + offset, it.to + offset, it.openTo + offset, it.closeFrom + offset) }
            while (true) at = spans.firstOrNull { it.openTo == at && it.from < at }?.from ?: break
            val inside = spans.filter { it.openTo < at && at <= it.closeFrom }
            close = inside.map { text.substring(it.closeFrom, it.to) }.reversed().joinToString("")
            open = inside.joinToString("") { text.substring(it.from, it.openTo) }
            // Formatting cannot start or end on a space: spaces at the break stay outside the signs.
            if (inside.isNotEmpty()) {
                while (at - before.length > lineStart && isSpace(text[at - before.length - 1])) before = "${text[at - before.length - 1]}$before"
                if (at == from) while (at + after.length < contentEnd && isSpace(text[at + after.length])) after += text[at + after.length]
            }
        }
        if (list != null) {
            val plain = maskPair(text, pair)
            val remaining = plain.substring(lineStart + list.value.length, from) + plain.substring(to, contentEnd)
            if (jsTrim(remaining).isEmpty()) {
                // An empty item in a level goes one level back; only on level 0 its sign goes (design kaarten-en-lijsten, part 7).
                val back = if (listLevels(text)[Lines(text).at(lineStart)] > 0) indentEdit(text, from, to, "out") else null
                return back ?: Edit(lineStart, contentEnd, "", lineStart)
            }
        } else if (at == from && close.isEmpty()) return null
        val sign = list?.groups?.let { groups ->
            val number = if (groups[2] != null) "-" else "${groups[3]!!.value.toLong() + 1}${groups[4]!!.value}"
            "${groups[1]!!.value}$number " + if (groups[5] == null) "" else "[ ] "
        } ?: ""
        val start = at - before.length
        val insert = "$close$before$cr\n$sign$after$open${text.substring(at, from)}"
        return Edit(start, to + after.length, insert, start + insert.length)
    }

    /** The formatting that goes on after Enter (Eric, 16 nov), as in format.mjs. */
    private val carried = setOf("bold", "italic", "strike", "highlight", "code")

    // --- Tables (phase 4), as tableEdit in format.mjs ---------------------------------------------------------------

    /** One change to a table; the fields each type reads are as in format.mjs. */
    data class TableOp(val type: String, val row: Int? = null, val column: Int? = null, val text: String? = null,
                       val after: Int? = null, val at: Int? = null, val align: String? = null)

    private fun indentOf(line: String) = line.takeWhile { it == ' ' || it == '\t' }
    private fun crOf(line: String) = if (line.endsWith("\r")) "\r" else ""
    /** A table line in the one form JotDrop writes: `| a | b |`, one space around each cell, indent and `\r` kept. */
    private fun tableLine(like: String, cells: List<String>) = "${indentOf(like)}| ${cells.joinToString(" | ")} |${crOf(like)}"
    private val dash = mapOf("" to "---", "left" to ":---", "center" to ":---:", "right" to "---:")

    /**
     * One change to the table that starts on line [fromLine], rewriting as few lines as possible (sync merges per line).
     * Never realigns the table with padding. Null when nothing changes or the change is not allowed (the header row and
     * the last column cannot go: that is "deleteTable").
     */
    fun tableEdit(text: String, fromLine: Int, op: TableOp?): Edit? {
        val run = blocks(text).firstOrNull { it.kind == "table" && it.fromLine == fromLine } ?: return null
        if (op == null) return null
        val lines = text.split('\n').toMutableList()
        val columns = tableCells(lines[run.fromLine]).size
        val rows = run.toLine - run.fromLine - 1
        fun lineOf(row: Int) = if (row == 0) run.fromLine else run.fromLine + 1 + row
        fun cellsOf(line: String) = tableCells(line).map(::jsTrim).toMutableList()
        fun dashes(line: String) = delimiterAligns(line)!!.map { dash.getValue(it) }.toMutableList()
        fun done(selection: Int = run.from) = replacement(text, lines.joinToString("\n"), selection)
        when (op.type) {
            "setCell" -> {
                val row = op.row ?: return null
                val column = op.column ?: return null
                if (row !in 0..rows || column !in 0 until columns) return null
                val index = lineOf(row)
                val cells = cellsOf(lines[index])
                while (cells.size < columns) cells += ""
                val source = cellSource(op.text ?: "")
                if (cells[column] == source) return null
                // Only this row's line is written again; extra cells past the last column stay.
                cells[column] = source
                lines[index] = tableLine(lines[index], cells)
                return done()
            }
            "addRow" -> {
                val after = maxOf(0, minOf(rows, op.after ?: rows))
                val at = run.fromLine + 2 + after
                val cr = crOf(lines[run.fromLine])
                var row = tableLine(withoutCr(lines[run.fromLine]), List(columns) { "" })
                // A new last line of a CRLF text: the line above gets its `\r`, the new one ends the text without one.
                if (at == lines.size) { if (cr.isNotEmpty() && !lines[at - 1].endsWith("\r")) lines[at - 1] += cr }
                else row += cr
                lines.add(at, row)
                return done()
            }
            "deleteRow" -> {
                val row = op.row ?: return null
                if (row !in 1..rows) return null
                lines.removeAt(lineOf(row))
                return done()
            }
            "addColumn" -> {
                val at = maxOf(0, minOf(columns, op.at ?: columns))
                for (index in run.fromLine..run.toLine) {
                    val delimiter = index == run.fromLine + 1
                    val cells = if (delimiter) dashes(lines[index]) else cellsOf(lines[index])
                    while (cells.size < at) cells += ""
                    cells.add(at, if (delimiter) dash.getValue("") else "")
                    lines[index] = tableLine(lines[index], cells)
                }
                return done()
            }
            "deleteColumn" -> {
                val column = op.column ?: return null
                if (columns <= 1 || column !in 0 until columns) return null
                for (index in run.fromLine..run.toLine) {
                    val cells = if (index == run.fromLine + 1) dashes(lines[index]) else cellsOf(lines[index])
                    if (column < cells.size) cells.removeAt(column)
                    lines[index] = tableLine(lines[index], cells)
                }
                return done()
            }
            "setAlign" -> {
                // Only the delimiter line holds the alignment, so only that line changes.
                val column = op.column ?: return null
                val align = op.align ?: return null
                if (column !in 0 until columns || align !in dash) return null
                val index = run.fromLine + 1
                val aligns = delimiterAligns(lines[index])!!.toMutableList()
                if (aligns[column] == align) return null
                aligns[column] = align
                lines[index] = tableLine(lines[index], aligns.map { dash.getValue(it) })
                return done()
            }
            "deleteTable" -> {
                var from = run.fromLine
                var count = run.toLine - run.fromLine + 1
                val end = from + count
                // At most one blank line stays where the table was; none at the very start or end of the text.
                if (end < lines.size && blank(lines[end]) && (from == 0 || blank(lines[from - 1]))) count++
                else if (end >= lines.size && from > 0 && blank(lines[from - 1])) { from--; count++ }
                repeat(count) { lines.removeAt(from) }
                return done(minOf(run.from, lines.joinToString("\n").length))
            }
            else -> return null
        }
    }

    // --- Lists in levels and ticking a task (design kaarten-en-lijsten, parts 4 and 6) ---------------------------------

    private val listKinds = setOf("task", "bullet", "ordered")

    /** The width of a line's indent in columns: a space is 1, a tab goes on to the next multiple of 4. */
    private fun indentColumns(line: String): Int {
        var column = 0
        for (char in line) {
            if (char == ' ') column++
            else if (char == '\t') column += 4 - column % 4
            else break
        }
        return column
    }

    /** A list line (level 0 and up) or a line of more text under an item (level -1), as in format.mjs. */
    private class ListItem(val level: Int, val column: Int, val parent: Int, val series: Int)

    /**
     * The lists of a text, per line: a list line (task, bullet, numbered) has its level, its column, `parent` (the line
     * of its main item or -1) and its series; a line of more text that belongs to an item has level -1; every other line
     * is null. A series ends at a blank line, a plain text line that is not indented deeper, a heading, a rule, a quote,
     * a table or a code block. The level comes from a stack: a line at column k takes everything at k or further off it.
     */
    private fun listStructure(text: String): List<ListItem?> {
        val lines = text.split('\n')
        val kinds = lineKinds(text)
        val out = ArrayList<ListItem?>(lines.size)
        // Each entry: column, line.
        var stack = ArrayList<IntArray>()
        var series = -1
        for ((index, line) in lines.withIndex()) {
            val kind = if (kinds[index] == "text") linePrefix(line).kind else null
            val column = indentColumns(line)
            if (kind != null && kind in listKinds) {
                if (stack.isEmpty()) series++
                while (stack.isNotEmpty() && stack.last()[0] >= column) stack.removeAt(stack.size - 1)
                out += ListItem(stack.size, column, if (stack.isEmpty()) -1 else stack.last()[1], series)
                stack += intArrayOf(column, index)
                continue
            }
            if (kind == "" && !blank(line) && stack.isNotEmpty() && column > stack[0][0]) {
                while (stack.last()[0] >= column) stack.removeAt(stack.size - 1)
                out += ListItem(-1, column, stack.last()[1], series)
                continue
            }
            stack = ArrayList()
            out += null
        }
        return out
    }

    /** The last line of an item: its own line plus the lines under it that are indented deeper (sub-items, more text). */
    private fun itemEnd(structure: List<ListItem?>, line: Int): Int {
        val item = structure[line]!!
        var end = line
        while (end + 1 < structure.size && structure[end + 1]?.series == item.series && structure[end + 1]!!.column > item.column) end++
        return end
    }

    /**
     * The level of every line: 0 and up for a task, bullet or numbered line, -1 for any other line (design part 4).
     * Tabs, 2 spaces and 4 spaces all read: a tab counts to the next multiple of 4 columns.
     */
    fun listLevels(text: String): List<Int> = listStructure(text).map { it?.level ?: -1 }

    /**
     * Per line the line of the item it belongs to: its own line for a task, bullet or numbered line, the line of its
     * item for more text under an item, -1 for any other line. As listItems in format.mjs.
     */
    fun listItems(text: String): List<Int> {
        val structure = listStructure(text)
        return structure.indices.map { itemOf(structure, it) }
    }

    /** [listLevels] and [listItems] from one reading of the text, for the editor, which asks for both at every key. */
    fun listLevelsAndItems(text: String): kotlin.Pair<List<Int>, List<Int>> {
        val structure = listStructure(text)
        return structure.map { it?.level ?: -1 } to structure.indices.map { itemOf(structure, it) }
    }

    /** A tick as one replacement, plus the line the task is on now. */
    data class Tick(val edit: Edit, val line: Int)

    /** The task on a list line (its linePrefix), or null: a bullet, a numbered line, more text, a line outside a list. */
    private fun taskAt(lines: List<String>, structure: List<ListItem?>, line: Int): Prefix? {
        val item = structure.getOrNull(line) ?: return null
        if (item.level < 0) return null
        return linePrefix(lines[line]).takeIf { it.kind == "task" }
    }

    /** A task line with its box ticked (a small `x`) or empty. */
    private fun boxed(line: String, checked: Boolean): String {
        val box = line.indexOf('[', linePrefix(line).markFrom + 1) + 1
        return line.substring(0, box) + (if (checked) "x" else " ") + line.substring(box + 1)
    }

    /**
     * The lines whose box changes when the task on [line] gets ticked or unticked, as tickedLines in format.mjs (design
     * checklists-77-v2, part 7): the task itself, every task under it that is not that way yet, and for an untick every
     * ticked task it hangs under. Ticking the last open sub-task leaves its main task open.
     */
    private fun tickedLines(lines: List<String>, structure: List<ListItem?>, line: Int, checked: Boolean): List<Int> {
        val out = mutableListOf(line)
        for (index in line + 1..itemEnd(structure, line)) {
            val task = taskAt(lines, structure, index)
            if (task != null && task.checked != checked) out += index
        }
        if (!checked) {
            var up = structure[line]!!.parent
            while (up >= 0) {
                if (taskAt(lines, structure, up)?.checked == true) out += up
                up = structure[up]!!.parent
            }
        }
        return out
    }

    /** The tasks in the item on [line], itself and under it, when it is done: a ticked task with no open task under it. Else 0. */
    private fun doneTasks(lines: List<String>, structure: List<ListItem?>, line: Int): Int {
        if (taskAt(lines, structure, line)?.checked != true) return 0
        var count = 0
        for (index in line..itemEnd(structure, line)) {
            val task = taskAt(lines, structure, index) ?: continue
            if (!task.checked) return 0
            count++
        }
        return count
    }

    /**
     * Ticks or unticks the task on line [line] (ticking writes a small `x`), and with it the tasks under it; unticked,
     * the ticked tasks it hangs under are unticked too (design checklists-77-v2, part 7). With [move] (the setting "Move
     * checked items to the bottom") the task moves along with the lines under it, never past a blank or text line
     * (design kaarten-en-lijsten, part 6): ticked, it goes right under the last sibling below it that is not done;
     * unticked, right above the first sibling above it that is done; else it stays. Done is a ticked task with no open
     * task under it, so a task that was ticked lands in the ticked end of its list ([checkedTail]). A main task that was
     * unticked along moves the same way among its own siblings. Bullets and numbered lines between the tasks stay where
     * they are. The selection stays in its own text: in the task it goes along with it. Null when [line] is no task in
     * a text block. As tickEdit in format.mjs.
     */
    fun tickEdit(text: String, line: Int, move: Boolean, selFrom: Int = 0, selTo: Int = selFrom): Tick? {
        val lines = text.split('\n')
        val structure = listStructure(text)
        val prefix = taskAt(lines, structure, line) ?: return null
        val checked = !prefix.checked
        val changed = tickedLines(lines, structure, line, checked)
        val toggled = lines.toMutableList()
        for (index in changed) toggled[index] = boxed(lines[index], checked)

        var order = lines.indices.toList()
        /** The order with the item on line [index] of the text as it was, and the lines under it, where its box now puts it; null when it stays. */
        fun settled(index: Int): List<Int>? {
            val item = structure[index]!!
            val end = itemEnd(structure, index)
            // More text of the main item between its sub-items splits them into two lists, as in Markdown.
            fun joined(other: Int): Boolean {
                val there = structure.getOrNull(other) ?: return false
                return there.series == item.series && !(there.level < 0 && there.parent == item.parent)
            }
            var first = index
            var last = index
            while (joined(first - 1)) first--
            while (joined(last + 1)) last++
            val siblings = (first..last).filter { it != index && structure[it]!!.parent == item.parent && taskAt(toggled, structure, it) != null }
            val block = order.subList(index, end + 1)
            if (checked) {
                val open = siblings.filter { it > index && doneTasks(toggled, structure, it) == 0 }
                if (open.isEmpty()) return null
                val target = itemEnd(structure, open.last())
                return order.subList(0, index) + order.subList(end + 1, target + 1) + block + order.subList(target + 1, order.size)
            }
            val target = siblings.firstOrNull { it < index && doneTasks(toggled, structure, it) > 0 } ?: return null
            return order.subList(0, target) + block + order.subList(target, index) + order.subList(end + 1, order.size)
        }
        fun arrange(order: List<Int>): MutableList<String> {
            val next = order.map { toggled[it] }.toMutableList()
            val last = lines.size - 1
            if (order[last] != last) {
                // The last line has no `\n` after it: the line that ends the text now takes over its ending, and the old
                // last line gets the ending of the line it swapped with. A CRLF text stays CRLF.
                val moved = order.indexOf(last)
                val middleCr = crOf(toggled[order[last]])
                next[moved] = withoutCr(next[moved]) + middleCr
                next[last] = withoutCr(next[last]) + crOf(toggled[last])
            }
            return next
        }
        // With mixed indents (4 spaces, then 2) a moved item could land under another main item. Then it stays where it is.
        fun fits(tried: List<Int>): Boolean {
            val after = listStructure(arrange(tried).joinToString("\n"))
            return tried.withIndex().all { (index, old) ->
                val was = structure[old]
                val now = after[index]
                if (was == null || now == null) was == null && now == null
                else was.level == now.level && (if (was.parent < 0) now.parent < 0 else now.parent >= 0 && tried[now.parent] == was.parent)
            }
        }
        // The task first, then every main task that was unticked along, from the inside out: each one moves inside the
        // item above it, so the lines of that item are still where the text has them.
        if (move) for (index in changed) {
            val tried = (if (index <= line) settled(index) else null) ?: continue
            if (fits(tried)) order = tried
        }
        val next = arrange(order)
        val at = order.indexOf(line)
        val out = next.joinToString("\n")
        val before = Lines(text)
        val starts = IntArray(next.size)
        var offset = 0
        for ((i, value) in next.withIndex()) { starts[i] = offset; offset += value.length + 1 }
        fun map(position: Int): Int {
            val pos = position.coerceIn(0, text.length)
            val index = before.at(pos)
            val to = order.indexOf(index)
            return starts[to] + minOf(pos - before.starts[index], next[to].length)
        }
        val a = map(selFrom)
        val b = map(selTo)
        return Tick(replacement(text, out, minOf(a, b), maxOf(a, b))!!, at)
    }

    /** The item a line belongs to: the line itself for a list line, its main item for a line of more text, else -1. */
    private fun itemOf(structure: List<ListItem?>, line: Int): Int {
        val item = structure.getOrNull(line) ?: return -1
        return if (item.level >= 0) line else item.parent
    }

    /** The nearest earlier item with the same main item in the same series, or -1. */
    private fun previousSibling(structure: List<ListItem?>, line: Int): Int {
        val item = structure[line]!!
        var index = line - 1
        while (index >= 0 && index != item.parent && structure[index]?.series == item.series) {
            val other = structure[index]!!
            if (other.level >= 0 && other.parent == item.parent) return index
            index--
        }
        return -1
    }

    private val leadingNumber = Regex("^\\d+")

    /**
     * Indent ("in") or outdent ("out") every list item the selection touches, each with the lines under it, as
     * indentEdit in format.mjs (design kaarten-en-lijsten, part 7). Null when nothing can change.
     */
    fun indentEdit(text: String, selFrom: Int, selTo: Int = selFrom, direction: String = "in"): Edit? {
        val from = maxOf(0, minOf(selFrom, selTo, text.length))
        val to = minOf(text.length, maxOf(selFrom, selTo))
        val table = Lines(text)
        val original = table.lines
        var lines = original.toMutableList()
        var structure = listStructure(text)
        val (first, last) = touchedLines(table, from, to)
        val picked = mutableListOf<Int>()
        for (index in first..last) {
            val item = itemOf(structure, index)
            if (item >= 0 && item !in picked) picked += item
        }
        // A picked item under another picked item moves along with that one.
        val roots = picked.filter { line ->
            var up = structure[line]!!.parent
            var free = true
            while (up >= 0) { if (up in picked) { free = false; break }; up = structure[up]!!.parent }
            free
        }
        // One item after the other, from the top, each on the text as the items above it left it.
        for (root in roots) {
            structure = listStructure(lines.joinToString("\n"))
            val item = structure[root]!!
            val end = itemEnd(structure, root)
            val own = indentOf(lines[root])
            val parent: Int
            val indent: String
            if (direction == "in") {
                parent = previousSibling(structure, root)
                if (parent < 0) continue
                var child = -1
                for (index in parent + 1 until root) {
                    val other = structure[index]
                    if (other != null && other.level >= 0 && other.parent == parent) { child = index; break }
                }
                indent = if (child >= 0) indentOf(lines[child]) else "$own\t"
            } else {
                if (item.parent < 0) continue
                parent = structure[item.parent]!!.parent
                indent = indentOf(lines[item.parent])
            }
            val next = lines.toMutableList()
            for (index in root..end) {
                val line = next[index]
                next[index] = if (line.startsWith(own)) indent + line.substring(own.length)
                else indent + " ".repeat(maxOf(0, indentColumns(line) - item.column)) + line.substring(indentOf(line).length)
            }
            // With mixed indents the item could land somewhere else than meant; then it stays as it was.
            val after = listStructure(next.joinToString("\n"))
            val now = after[root]
            if (now == null || now.level != item.level + (if (direction == "in") 1 else -1) || now.parent != parent) continue
            val prefix = linePrefix(next[root])
            if (prefix.kind == "ordered") {
                val before = previousSibling(after, root)
                val previous = if (before >= 0) linePrefix(next[before]) else null
                val number = if (previous?.kind == "ordered") previous.number + 1 else 1L
                next[root] = next[root].substring(0, prefix.markFrom) + leadingNumber.replaceFirst(next[root].substring(prefix.markFrom), number.toString())
            }
            lines = next
        }
        val out = lines.joinToString("\n")
        if (out == text) return null
        // Only the start of a line changes: a position in its words moves along, one in the old indent stays in the new one.
        val starts = IntArray(lines.size)
        var offset = 0
        for ((i, line) in lines.withIndex()) { starts[i] = offset; offset += line.length + 1 }
        fun map(pos: Int): Int {
            val index = table.at(pos)
            val was = original[index]
            val now = lines[index]
            var same = 0
            while (same < minOf(was.length, now.length) && was[was.length - 1 - same] == now[now.length - 1 - same]) same++
            val head = was.length - same
            val column = pos - table.starts[index]
            return starts[index] + if (column >= head) column + now.length - was.length else minOf(column, now.length - same)
        }
        return replacement(text, out, map(from), map(to))
    }

    /** The Checklist button, as checklistEdit in format.mjs (design kaarten-en-lijsten, part 7). Null in a code block or table. */
    fun checklistEdit(text: String, selFrom: Int, selTo: Int = selFrom, move: Boolean = false): Edit? {
        val from = maxOf(0, minOf(selFrom, selTo, text.length))
        val to = minOf(text.length, maxOf(selFrom, selTo))
        val table = Lines(text)
        val kinds = lineKinds(text)
        val (first, last) = touchedLines(table, from, to)
        val targets = (first..last).filter { kinds[it] == "text" && !(first != last && blank(table.lines[it])) }
        if (targets.isEmpty()) return null
        val prefixes = targets.map { linePrefix(table.lines[it]) }
        if (targets.size == 1 && prefixes[0].kind == "task") return tickEdit(text, targets[0], move, from, to)?.edit
        val edits = mutableListOf<Change>()
        val allTasks = prefixes.all { it.kind == "task" }
        val tick = prefixes.any { !it.checked }
        if (allTasks) {
            // Every task that changes takes the tasks under it along, and unticked the ticked ones it hangs under.
            val structure = listStructure(text)
            val boxes = LinkedHashSet<Int>()
            for ((i, index) in targets.withIndex()) if (prefixes[i].checked != tick) boxes += tickedLines(table.lines, structure, index, tick)
            for (index in boxes) {
                val box = table.starts[index] + table.lines[index].indexOf('[', linePrefix(table.lines[index]).markFrom + 1) + 1
                edits += Change(box, box + 1, if (tick) "x" else " ")
            }
        } else for ((i, index) in targets.withIndex()) {
            val prefix = prefixes[i]
            val at = table.starts[index]
            when (prefix.kind) {
                "bullet" -> edits += Change(at + prefix.markTo, at + prefix.markTo, "[ ] ")
                "ordered" -> edits += Change(at + prefix.markFrom, at + prefix.markTo, "- [ ] ")
                "task" -> {}
                else -> edits += Change(at + prefix.indent, at + prefix.indent, "- [ ] ")
            }
        }
        val applied = applyEdits(text, edits)
        if (applied.text == text) return null
        return if (from == to) replacement(text, applied.text, applied.map(from, true))
        else replacement(text, applied.text, applied.map(from), applied.map(to, true))
    }

    // --- Checklists in an open note (design checklists-77, part 7), as the same part of format.mjs -------------------
    // Moving, dragging and deleting an item, the note's menu and pasting several lines. Whole lines move or go; a line
    // that moves changes only at its start (its indent, a number).

    /** A move or a drop as one replacement, plus the line the item is on now. */
    data class Moved(val edit: Edit, val line: Int)

    /** One replacement plus a number: the sub-items that went along, or the tasks that were unticked or deleted. */
    data class Counted(val edit: Edit, val count: Int)

    /** A place a dragged item may land: in front of line [before], on a level from [minLevel] to [maxLevel]. */
    data class Slot(val before: Int, val minLevel: Int, val maxLevel: Int)

    /** A line of an item with another indent: [own], the indent of the item, becomes [indent]; what it has more stays. */
    private fun reindented(line: String, own: String, column: Int, indent: String) =
        if (line.startsWith(own)) indent + line.substring(own.length)
        else indent + " ".repeat(maxOf(0, indentColumns(line) - column)) + line.substring(indentOf(line).length)

    /**
     * The lines in a new order: [order] holds for every new line the old one, and an old line it leaves out is gone.
     * The last line has no `\n` after it, so the line that ends the text now takes over its ending and the old last
     * line, when it stays, gets the ending of that line. A CRLF text stays CRLF.
     */
    private fun arranged(lines: List<String>, changed: List<String>, order: List<Int>): List<String> {
        val next = order.map { changed[it] }.toMutableList()
        val last = lines.size - 1
        val end = next.size - 1
        if (end >= 0 && order[end] != last) {
            val moved = order.indexOf(last)
            val middleCr = crOf(lines[order[end]])
            if (moved >= 0) next[moved] = withoutCr(next[moved]) + middleCr
            next[end] = withoutCr(next[end]) + crOf(lines[last])
        }
        return next
    }

    /**
     * The one replacement that turns the text into the lines [next] (from [arranged]). A position stays in its own
     * words: it goes along with its line, and with a new indent or number at the start of that line. From a line that
     * is gone it goes to the end of the nearest line above that stays; with none above, to the end of the line that is
     * first now. Null when the lines are the text as it was; with [alike], a replacement of nothing that only takes the
     * selection along: two items with the same text traded places.
     */
    private fun linesEdit(text: String, next: List<String>, order: List<Int>, selFrom: Int, selTo: Int, alike: Boolean = false): Edit? {
        val table = Lines(text)
        val place = IntArray(table.lines.size) { -1 }
        for ((index, old) in order.withIndex()) place[old] = index
        val starts = IntArray(next.size)
        var offset = 0
        for ((i, line) in next.withIndex()) { starts[i] = offset; offset += line.length + 1 }
        fun map(position: Int): Int {
            val pos = position.coerceIn(0, text.length)
            var index = table.at(pos)
            if (place[index] < 0) {
                while (index >= 0 && place[index] < 0) index--
                val stays = if (index < 0) 0 else place[index]
                return if (next.isEmpty()) 0 else starts[stays] + withoutCr(next[stays]).length
            }
            val to = place[index]
            val was = withoutCr(table.lines[index])
            val now = withoutCr(next[to])
            val column = pos - table.starts[index]
            if (column > was.length) return starts[to] + next[to].length
            var same = 0
            while (same < minOf(was.length, now.length) && was[was.length - 1 - same] == now[now.length - 1 - same]) same++
            return starts[to] + if (column >= was.length - same) column + now.length - was.length else minOf(column, now.length - same)
        }
        val a = map(selFrom)
        val b = map(selTo)
        val after = next.joinToString("\n")
        if (alike && after == text) return Edit(text.length, text.length, "", minOf(a, b), maxOf(a, b))
        return replacement(text, after, minOf(a, b), maxOf(a, b))
    }

    /** An item that changed level on purpose: its lines [from] to [to] are [shift] levels further, its first line under [parent]. */
    private class Shifted(val from: Int, val to: Int, val shift: Int, val parent: Int)

    /**
     * Whether the lists still are what they were after lines moved: every line has its old level and its old main item,
     * but for the lines of [moved].
     */
    private fun sameLists(structure: List<ListItem?>, after: List<ListItem?>, order: List<Int>, moved: Shifted? = null): Boolean =
        order.withIndex().all { (index, old) ->
            val was = structure[old]
            val now = after[index]
            if (was == null || now == null) was == null && now == null
            else {
                val inside = moved != null && old >= moved.from && old <= moved.to
                val level = if (moved != null && inside && was.level >= 0) was.level + moved.shift else was.level
                val parent = if (moved != null && inside && old == moved.from) moved.parent else was.parent
                now.level == level && (if (parent < 0) now.parent < 0 else now.parent >= 0 && order[now.parent] == parent)
            }
        }

    private val firstNumber = Regex("\\d+")

    /**
     * Moves the item [line] belongs to (a list line, or a line of more text under one) one place "up" or "down": it
     * trades places with the sibling right above or under it, each with the lines under it, as moveItemEdit in
     * format.mjs. Two numbered items trade their numbers too; siblings on different columns trade their indents. Past a
     * sibling with the same text the note stays as it is: the replacement is empty and only the selection and the line
     * go along, so the item can go on from there. Null for the first or last of its siblings, outside a list, and when
     * more text of the main item stands between the two.
     */
    fun moveItemEdit(text: String, line: Int, direction: String, selFrom: Int = 0, selTo: Int = selFrom): Moved? {
        val lines = text.split('\n')
        val structure = listStructure(text)
        val own = itemOf(structure, line)
        if (own < 0) return null
        val item = structure[own]!!
        val end = itemEnd(structure, own)
        val other: Int
        if (direction == "up") {
            other = previousSibling(structure, own)
            if (other < 0 || itemEnd(structure, other) + 1 != own) return null
        } else {
            other = end + 1
            val under = structure.getOrNull(other)
            if (under == null || under.level < 0 || under.parent != item.parent) return null
        }
        val top = if (direction == "up") other else own
        val low = if (direction == "up") own else other
        val topEnd = low - 1
        val lowEnd = itemEnd(structure, low)
        val topColumn = structure[top]!!.column
        val lowColumn = structure[low]!!.column
        val changed = lines.toMutableList()
        if (topColumn != lowColumn) {
            val topIndent = indentOf(lines[top])
            val lowIndent = indentOf(lines[low])
            for (index in top..topEnd) changed[index] = reindented(lines[index], topIndent, topColumn, lowIndent)
            for (index in low..lowEnd) changed[index] = reindented(lines[index], lowIndent, lowColumn, topIndent)
        }
        if (linePrefix(lines[top]).kind == "ordered" && linePrefix(lines[low]).kind == "ordered") {
            fun digits(index: Int) = firstNumber.find(lines[index])!!.value
            val topLine = firstNumber.replaceFirst(changed[top], digits(low))
            val lowLine = firstNumber.replaceFirst(changed[low], digits(top))
            changed[top] = topLine
            changed[low] = lowLine
        }
        val order = lines.indices.map { index ->
            if (index < top || index > lowEnd) index else if (index <= top + lowEnd - low) index + low - top else index - (lowEnd - low + 1)
        }
        val next = arranged(lines, changed, order)
        if (!sameLists(structure, listStructure(next.joinToString("\n")), order)) return null
        val edit = linesEdit(text, next, order, selFrom, selTo, alike = true) ?: return null
        return Moved(edit, if (direction == "up") top else top + lowEnd - low + 1)
    }

    /** A place of [dropPlan]: a [Slot] plus [gap], its line in the text without the item. */
    private class DropSlot(val before: Int, val minLevel: Int, val maxLevel: Int, val gap: Int)

    /** What dropSlots and dropItemEdit share: the item and its last line, the text without it and every place it may land. */
    private class DropPlan(val lines: List<String>, val structure: List<ListItem?>, val item: ListItem, val end: Int,
                           val rest: List<String>, val without: List<ListItem?>, val slots: List<DropSlot>)

    private fun dropPlan(text: String, line: Int): DropPlan? {
        val lines = text.split('\n')
        val structure = listStructure(text)
        val item = structure.getOrNull(line) ?: return null
        if (item.level < 0) return null
        val end = itemEnd(structure, line)
        val size = end - line + 1
        // A table cuts the note in pieces; an item stays in its own piece.
        var first = 0
        var last = lines.size
        for (run in blocks(text)) {
            if (run.kind != "table") continue
            if (run.toLine < line) first = run.toLine + 1
            else if (run.fromLine > end) { last = run.fromLine; break }
        }
        val rest = lines.subList(0, line) + lines.subList(end + 1, lines.size)
        val without = listStructure(rest.joinToString("\n"))
        val slots = mutableListOf<DropSlot>()
        for (gap in 0..rest.size) {
            val before = if (gap <= line) gap else gap + size
            if (before < first || before > last) continue
            val above = if (gap > 0) without[gap - 1] else null
            val below = if (gap < rest.size) without[gap] else null
            val upper = if (above == null) -1 else if (above.level >= 0) gap - 1 else above.parent
            var minLevel = if (below != null && below.level >= 0) below.level else 0
            var maxLevel = if (upper >= 0) without[upper]!!.level + 1 else 0
            // Before or after a list line, never in the middle of the text of an item.
            val open = if (below != null) below.level >= 0 else above != null
            if (gap == line) {
                // Its own place always counts, if only to let go there.
                if (!open || minLevel > item.level || maxLevel < item.level) { minLevel = item.level; maxLevel = item.level }
            } else if (!open) continue
            slots += DropSlot(before, minLevel, maxLevel, gap)
        }
        return DropPlan(lines, structure, item, end, rest, without, slots)
    }

    /**
     * The places where the list item on line [line] may land when it is dragged, with the lines under it, as dropSlots
     * in format.mjs. It lands in front of line `before` (the number of lines: at the very end), at most one level
     * deeper than the item above that place and at least as deep as the list line under it. Before or after a list
     * line, also in another list of the note; not in plain text, in a code block or past a table. Its own place is in
     * the list too. Empty when [line] is no list line.
     */
    fun dropSlots(text: String, line: Int): List<Slot> =
        dropPlan(text, line)?.slots?.map { Slot(it.before, it.minLevel, it.maxLevel) } ?: emptyList()

    /**
     * Drops the list item on line [line], with the lines under it, in front of line [before] on [level]: one of the
     * places of [dropSlots], as dropItemEdit in format.mjs. Its indent becomes that of its new siblings, or one tab
     * more than its new main item when it is the first under it. Dropped past items with the same text the note stays as
     * it is: the replacement is empty and only the selection and the line go along, as in [moveItemEdit]. Null when the
     * place is none of dropSlots, on its own place and level, and when with mixed indents a line would end up on
     * another level than meant.
     */
    fun dropItemEdit(text: String, line: Int, before: Int, level: Int, selFrom: Int = 0, selTo: Int = selFrom): Moved? {
        val plan = dropPlan(text, line) ?: return null
        val slot = plan.slots.firstOrNull { it.before == before } ?: return null
        if (level < slot.minLevel || level > slot.maxLevel) return null
        val lines = plan.lines
        val item = plan.item
        val end = plan.end
        val rest = plan.rest
        val without = plan.without
        val gap = slot.gap
        if (gap == line && level == item.level) return null
        val below = if (gap < rest.size) without[gap] else null
        val above = if (gap > 0) without[gap - 1] else null
        val indent: String
        val parent: Int
        if (below != null && below.level == level) {
            indent = indentOf(rest[gap])
            parent = below.parent
        } else {
            var upper = if (above == null) -1 else if (above.level >= 0) gap - 1 else above.parent
            if (upper >= 0 && without[upper]!!.level + 1 == level) {
                indent = indentOf(rest[upper]) + "\t"
                parent = upper
            } else {
                while (upper >= 0 && without[upper]!!.level > level) upper = without[upper]!!.parent
                if (upper < 0) return null
                indent = indentOf(rest[upper])
                parent = without[upper]!!.parent
            }
        }
        val size = end - line + 1
        val own = indentOf(lines[line])
        val changed = lines.toMutableList()
        for (index in line..end) changed[index] = reindented(lines[index], own, item.column, indent)
        // The line each line of the text without the item was in the whole text.
        fun old(index: Int) = if (index < line) index else index + size
        val order = mutableListOf<Int>()
        for (index in 0..rest.size) {
            if (index == gap) for (inner in line..end) order += inner
            if (index < rest.size) order += old(index)
        }
        val next = arranged(lines, changed, order)
        val moved = Shifted(line, end, level - item.level, if (parent < 0) -1 else old(parent))
        if (!sameLists(plan.structure, listStructure(next.joinToString("\n")), order, moved)) return null
        val edit = linesEdit(text, next, order, selFrom, selTo, alike = true) ?: return null
        return Moved(edit, gap)
    }

    /** The text without the lines marked in [gone], as one replacement (see [linesEdit] for the selection). */
    private fun removeLines(text: String, lines: List<String>, gone: BooleanArray, selFrom: Int, selTo: Int): Edit? {
        val order = lines.indices.filter { !gone[it] }
        return linesEdit(text, arranged(lines, lines, order), order, selFrom, selTo)
    }

    /**
     * Deletes the item [line] belongs to (a list line, or a line of more text under one) with everything under it, as
     * deleteItemEdit in format.mjs. The count is the number of list lines that went along (its sub-items, at any
     * depth). A selection in the item goes to the end of the line above it (for the first line of the text: to the
     * end of the line that comes in its place). Null outside a list.
     */
    fun deleteItemEdit(text: String, line: Int, selFrom: Int = 0, selTo: Int = selFrom): Counted? {
        val lines = text.split('\n')
        val structure = listStructure(text)
        val own = itemOf(structure, line)
        if (own < 0) return null
        val end = itemEnd(structure, own)
        val gone = BooleanArray(lines.size)
        var count = 0
        for (index in own..end) {
            gone[index] = true
            if (index > own && structure[index]!!.level >= 0) count++
        }
        val edit = removeLines(text, lines, gone, selFrom, selTo) ?: return null
        return Counted(edit, count)
    }

    /** An item as [itemSpan] gives it: its own [line], its last line [end], the list lines under it, and its place among its siblings. */
    data class ItemSpan(val line: Int, val end: Int, val count: Int, val place: Int, val of: Int)

    /**
     * The item [line] belongs to (a list line, or a line of more text under one), as itemSpan in format.mjs: its own
     * line, the last line under it, the number of list lines under it (its sub-items, at any depth, as
     * [deleteItemEdit] counts them), and the how-manieth it is among the items with the same main item in its list
     * (1 and up) of how many. Null outside a list.
     */
    fun itemSpan(text: String, line: Int): ItemSpan? {
        val structure = listStructure(text)
        val own = itemOf(structure, line)
        if (own < 0) return null
        val item = structure[own]!!
        val end = itemEnd(structure, own)
        val count = (own + 1..end).count { structure[it]!!.level >= 0 }
        var place = 0
        var of = 0
        for ((index, other) in structure.withIndex()) {
            if (other == null || other.level < 0 || other.series != item.series || other.parent != item.parent) continue
            of++
            if (index <= own) place++
        }
        return ItemSpan(own, end, count, place, of)
    }

    /**
     * "Uncheck all items": every ticked task gets an empty box, nothing moves. The count is the number of tasks it
     * unticked; null when no task is ticked. Tasks in a code block or quote are no tasks.
     */
    fun uncheckAllEdit(text: String, selFrom: Int = 0, selTo: Int = selFrom): Counted? {
        val table = Lines(text)
        val kinds = lineKinds(text)
        val edits = mutableListOf<Change>()
        for ((index, line) in table.lines.withIndex()) {
            if (kinds[index] != "text") continue
            val prefix = linePrefix(line)
            if (prefix.kind != "task" || !prefix.checked) continue
            val box = table.starts[index] + line.indexOf('[', prefix.markFrom + 1) + 1
            edits += Change(box, box + 1, " ")
        }
        if (edits.isEmpty()) return null
        val from = maxOf(0, minOf(selFrom, selTo, text.length))
        val to = minOf(text.length, maxOf(selFrom, selTo))
        val edit = replacement(text, applyEdits(text, edits).text, from, to) ?: return null
        return Counted(edit, edits.size)
    }

    /**
     * "Delete checked items": every ticked task goes, with everything under it, as deleteCheckedEdit in format.mjs. A
     * ticked task with an open task somewhere under it stays; the ticked tasks under it are judged on their own. The
     * count is the number of ticked tasks that went; null when none goes.
     */
    fun deleteCheckedEdit(text: String, selFrom: Int = 0, selTo: Int = selFrom): Counted? {
        val lines = text.split('\n')
        val structure = listStructure(text)
        val gone = BooleanArray(lines.size)
        /** The task on a line of a list, or null for a bullet, a numbered line and more text. */
        fun task(index: Int): Prefix? = if (structure[index]!!.level >= 0) linePrefix(lines[index]).takeIf { it.kind == "task" } else null
        var count = 0
        var index = 0
        while (index < lines.size) {
            val end = if (structure[index] != null && task(index)?.checked == true) itemEnd(structure, index) else -1
            if (end < 0 || (index + 1..end).any { task(it)?.checked == false }) { index++; continue }
            for (under in index..end) {
                gone[under] = true
                if (task(under) != null) count++
            }
            index = end + 1
        }
        if (count == 0) return null
        val edit = removeLines(text, lines, gone, selFrom, selTo) ?: return null
        return Counted(edit, count)
    }

    private val pastedBreak = Regex("\r\n?|\n")
    // How a pasted line starts: its indent, then a bullet or number of its own, with the box when it is a task.
    private val pastedSign = Regex("""^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[([ xX])\](?:[ \t]+|\z))?)?""")

    /**
     * Pasting text of more than one line in a list item ([pasted] in place of [selFrom] to [selTo]), as pasteLinesEdit
     * in format.mjs: every pasted line becomes an item of its own, with the indent and sign of the item it lands in. A
     * pasted line loses its own indent, bullet or number; one that is a task keeps its tick. Blank lines are left out.
     * Null (an ordinary paste) when [pasted] has no line break or only blank lines, outside a list item, in front of
     * the item's own text, or when the selection runs past the end of the line.
     */
    fun pasteLinesEdit(text: String, selFrom: Int, selTo: Int, pasted: String): Edit? {
        if (pasted.none { it == '\r' || it == '\n' }) return null
        val a = maxOf(0, minOf(selFrom, selTo, text.length))
        val b = minOf(text.length, maxOf(selFrom, selTo))
        val lineStart = if (a == 0) 0 else text.lastIndexOf('\n', a - 1) + 1
        val next = text.indexOf('\n', a)
        val lineEnd = if (next < 0) text.length else next
        val line = text.substring(lineStart, lineEnd)
        val cr = crOf(line)
        if (b > lineEnd - cr.length) return null
        val list = listItem.find(withoutCr(line)) ?: return null
        if (a < lineStart + list.value.length || linePrefix(line).kind !in listKinds) return null
        if (lineKinds(text)[Lines(text).at(lineStart)] != "text") return null
        // Each pasted line with words on it: the tick of its own box (or null) and its words.
        val rows = pastedBreak.split(pasted).mapNotNull { row ->
            val sign = pastedSign.find(row)!!
            val words = row.substring(sign.value.length)
            if (jsTrim(words).isEmpty()) null else sign.groups[1]?.value to words
        }
        if (rows.isEmpty()) return null
        val groups = list.groups
        val boxed = groups[5] != null
        val edits = mutableListOf<Change>()
        var insert = rows[0].second
        val firstTick = rows[0].first
        if (a == lineStart + list.value.length && firstTick != null) {
            // At the start of the item the first line brings its tick: into the item's box, or with a box of its own.
            val box = lineStart + list.value.lastIndexOf('[') + 1
            if (boxed) edits += Change(box, box + 1, firstTick) else insert = "[$firstTick] $insert"
        }
        for ((index, row) in rows.drop(1).withIndex()) {
            val sign = groups[2]?.value ?: "${groups[3]!!.value.toLong() + index + 1}${groups[4]!!.value}"
            val box = if (row.first != null) "[${row.first}] " else if (boxed) "[ ] " else ""
            insert += "$cr\n${groups[1]!!.value}$sign $box${row.second}"
        }
        edits += Change(a, b, insert)
        return replacement(text, applyEdits(text, edits).text, a + insert.length)
    }

    // --- The ticked end of a list and "+ List item" (design checklists-77-v2, part 6), as the same part of format.mjs ---

    /** The ticked end of a list: its first and last line and the tasks in it (sub-tasks too; all of them are ticked). */
    data class Tail(val from: Int, val to: Int, val count: Int)

    /**
     * The ticked end of every list that has one: the main items at the end of a list that are done (a ticked task with
     * no open task under it), with the lines under them. A main item that is no task, or a ticked one with an open task
     * under it, is not done: what stands above it is not at the end. With "Move checked items to the bottom" a tick puts
     * a task here ([tickEdit]), and the editor can show these lines as a part of their own that folds.
     */
    fun checkedTail(text: String): List<Tail> {
        val lines = text.split('\n')
        val structure = listStructure(text)
        val tails = mutableListOf<Tail>()
        // The ticked end that is being read: the series it is in, its first and last line, its tasks.
        var tail: IntArray? = null
        fun close() { tail?.let { tails += Tail(it[1], it[2], it[3]) }; tail = null }
        for ((index, item) in structure.withIndex()) {
            if (item == null || item.level != 0) continue
            if (tail != null && tail!![0] != item.series) close()
            val count = doneTasks(lines, structure, index)
            val reading = tail
            if (count == 0) tail = null
            else if (reading != null) { reading[2] = itemEnd(structure, index); reading[3] += count }
            else tail = intArrayOf(item.series, index, itemEnd(structure, index), count)
        }
        close()
        return tails
    }

    /**
     * "+ List item": a new empty task at the bottom of the open tasks of the list [line] is in (any line of it): in
     * front of the ticked end of that list ([checkedTail]), or after its last line when it has none. It is a main item,
     * with the indent and the sign of the main item above it (of the first ticked one when nothing stands above); a
     * numbered item gives a `-`. One replacement that only puts the line in, with the caret behind its box, plus the
     * line the new task is on. A CRLF text stays CRLF. Null when [line] is not in a list.
     */
    fun addItemEdit(text: String, line: Int): Moved? {
        val table = Lines(text)
        val lines = table.lines
        val structure = listStructure(text)
        val item = structure.getOrNull(line) ?: return null
        var first = line
        var last = line
        while (structure.getOrNull(first - 1)?.series == item.series) first--
        while (structure.getOrNull(last + 1)?.series == item.series) last++
        val at = checkedTail(text).firstOrNull { it.to == last }?.from ?: (last + 1)
        var like = if (at > first) at - 1 else at
        while (structure[like]!!.level != 0) like--
        val prefix = linePrefix(lines[like])
        val task = "${indentOf(lines[like])}${if (prefix.kind == "ordered") '-' else lines[like][prefix.markFrom]} [ ] "
        if (at < lines.size) {
            // In front of a line: the new line ends as the lines of this text end.
            val from = table.starts[at]
            return Moved(Edit(from, from, "$task${crOf(lines[if (at > 0) at - 1 else 0])}\n", from + task.length), at)
        }
        // A new last line: the line above gets the `\r` of a CRLF text, the new one ends the text without one.
        val cr = if (lines.size > 1) crOf(lines[at - 2]) else ""
        return Moved(Edit(text.length, text.length, "$cr\n$task", text.length + cr.length + 1 + task.length), at)
    }
}

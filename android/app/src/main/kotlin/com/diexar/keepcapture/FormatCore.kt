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
}

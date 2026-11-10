package com.diexar.keepcapture

enum class MdKind { PARAGRAPH, HEADING, BULLET, CODE, SPACE }

/** A piece of text with one look. */
data class MdSpan(val text: String, val bold: Boolean = false, val italic: Boolean = false, val code: Boolean = false)

/** One line of the answer: level is the heading size (1 to 6) or how far a bullet is indented (0 to 3). */
data class MdBlock(val kind: MdKind, val level: Int, val spans: List<MdSpan>)

/**
 * The little Markdown that Ask JotDrop's answer shows nicely (10 Nov 2026: the answer showed **AI testnotitie** with
 * its stars): bold, italic, `code`, # headings, - or * bullets (with [ ] and [x]) and ``` code blocks.
 * Nothing else is interpreted: no HTML, and links stay as typed, so nothing opens by itself.
 * Plain Kotlin on purpose, so the JVM check can run it; the screen turns the blocks into styled text.
 * The note that "Save as a new note" makes keeps the raw text, because a note is Markdown.
 */
object AiMarkdown {
    private val HEADING = Regex("^(#{1,6})[ \\t]+(.*?)[ \\t]*$")
    private val BULLET = Regex("^([ \\t]*)[-*+][ \\t]+(.*)$")
    private val TASK = Regex("^\\[([ xX])][ \\t]+(.*)$")
    private val FENCE = Regex("^[ \\t]*```")
    private const val OPEN_BOX = "☐"
    private const val DONE_BOX = "☑"

    fun parse(text: String): List<MdBlock> {
        val out = ArrayList<MdBlock>()
        var inCode = false
        for (line in text.replace("\r\n", "\n").replace('\r', '\n').split('\n')) {
            if (FENCE.containsMatchIn(line)) { inCode = !inCode; continue }
            if (inCode) { out.add(MdBlock(MdKind.CODE, 0, listOf(MdSpan(line, code = true)))); continue }
            if (line.isBlank()) {
                if (out.isNotEmpty() && out.last().kind != MdKind.SPACE) out.add(MdBlock(MdKind.SPACE, 0, emptyList()))
                continue
            }
            val heading = HEADING.find(line)
            if (heading != null) {
                out.add(MdBlock(MdKind.HEADING, heading.groupValues[1].length, inline(heading.groupValues[2]).map { it.copy(bold = true) }))
                continue
            }
            val bullet = BULLET.find(line)
            if (bullet != null) {
                val level = (bullet.groupValues[1].replace("\t", "  ").length / 2).coerceAtMost(3)
                val task = TASK.find(bullet.groupValues[2])
                val content = if (task != null) (if (task.groupValues[1] == " ") OPEN_BOX else DONE_BOX) + " " + task.groupValues[2] else bullet.groupValues[2]
                out.add(MdBlock(MdKind.BULLET, level, inline(content)))
                continue
            }
            out.add(MdBlock(MdKind.PARAGRAPH, 0, inline(line.trim())))
        }
        while (out.isNotEmpty() && out.last().kind == MdKind.SPACE) out.removeAt(out.size - 1)
        return out
    }

    /** The answer without its marks, one line per block. */
    fun plain(text: String): String = parse(text).joinToString("\n") { block -> block.spans.joinToString("") { it.text } }

    private fun inline(text: String): List<MdSpan> = ArrayList<MdSpan>().also { run(text, false, false, it) }

    private fun run(s: String, bold: Boolean, italic: Boolean, out: MutableList<MdSpan>) {
        val plain = StringBuilder()
        fun flush() {
            if (plain.isNotEmpty()) { out.add(MdSpan(plain.toString(), bold, italic)); plain.setLength(0) }
        }
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '`') {
                val j = s.indexOf('`', i + 1)
                if (j > i + 1) {
                    flush()
                    out.add(MdSpan(s.substring(i + 1, j), bold, italic, code = true))
                    i = j + 1
                    continue
                }
            } else if (c == '*' || c == '_') {
                val double = i + 1 < s.length && s[i + 1] == c
                val mark = if (double) "$c$c" else c.toString()
                val end = closing(s, i, mark)
                if (end > 0) {
                    flush()
                    run(s.substring(i + mark.length, end), bold || double, italic || !double, out)
                    i = end + mark.length
                    continue
                }
            }
            plain.append(c)
            i++
        }
        flush()
    }

    /**
     * Where the mark opened at `open` closes, or -1. A mark opens after a non-letter and before a non-space, and
     * closes after a non-space and before a non-letter, so snake_case_names, 2*3*4 and "a * b" stay as typed.
     */
    private fun closing(s: String, open: Int, mark: String): Int {
        if (open > 0 && s[open - 1].isLetterOrDigit()) return -1
        val after = open + mark.length
        if (after >= s.length || s[after].isWhitespace()) return -1
        var from = after + 1
        while (from < s.length) {
            val k = s.indexOf(mark, from)
            if (k < 0) return -1
            // Looking for a single mark: step over a doubled one (bold inside italic).
            if (mark.length == 1 && k + 1 < s.length && s[k + 1] == mark[0]) { from = k + 2; continue }
            val next = k + mark.length
            if (!s[k - 1].isWhitespace() && (next >= s.length || !s[next].isLetterOrDigit())) return k
            from = k + 1
        }
        return -1
    }
}

package com.diexar.keepcapture

/** What changed between two versions of a note, the same way as cloud/shared/diff.mjs. Runs here: the server cannot read notes. */
object CloudVersionDiff {
    enum class Kind { SAME, ADDED, REMOVED, GAP }
    data class Line(val kind: Kind, val text: String = "", val count: Int = 0)

    private const val MAX_CELLS = 4_000_000L

    /** Null when a note is too long to compare on a phone. */
    fun lines(before: String, after: String): List<Line>? {
        val a = before.replace("\r\n", "\n").split('\n')
        val b = after.replace("\r\n", "\n").split('\n')
        var start = 0
        while (start < a.size && start < b.size && a[start] == b[start]) start++
        var endA = a.size
        var endB = b.size
        while (endA > start && endB > start && a[endA - 1] == b[endB - 1]) { endA--; endB-- }
        val rows = endA - start
        val columns = endB - start
        if ((rows + 1L) * (columns + 1L) > MAX_CELLS) return null
        val width = columns + 1
        val lengths = IntArray((rows + 1) * width)
        for (row in rows - 1 downTo 0) for (column in columns - 1 downTo 0) {
            lengths[row * width + column] = if (a[start + row] == b[start + column]) lengths[(row + 1) * width + column + 1] + 1
            else maxOf(lengths[(row + 1) * width + column], lengths[row * width + column + 1])
        }
        val out = a.take(start).mapTo(mutableListOf()) { Line(Kind.SAME, it) }
        var row = 0
        var column = 0
        while (row < rows || column < columns) {
            if (row < rows && column < columns && a[start + row] == b[start + column]) {
                out += Line(Kind.SAME, a[start + row]); row++; column++
            } else if (row < rows && (column == columns || lengths[(row + 1) * width + column] >= lengths[row * width + column + 1])) {
                out += Line(Kind.REMOVED, a[start + row]); row++
            } else {
                out += Line(Kind.ADDED, b[start + column]); column++
            }
        }
        a.drop(endA).mapTo(out) { Line(Kind.SAME, it) }
        return out
    }

    /** Keeps a few lines around each change and folds the rest. */
    fun fold(lines: List<Line>, around: Int = 2): List<Line> {
        val keep = HashSet<Int>()
        lines.forEachIndexed { index, line -> if (line.kind != Kind.SAME) for (near in index - around..index + around) keep += near }
        val folded = mutableListOf<Line>()
        var gap = 0
        lines.forEachIndexed { index, line ->
            if (index in keep) {
                if (gap > 0) folded += Line(Kind.GAP, count = gap)
                gap = 0
                folded += line
            } else gap++
        }
        if (gap > 0) folded += Line(Kind.GAP, count = gap)
        return folded
    }
}

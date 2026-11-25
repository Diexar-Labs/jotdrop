package com.diexar.keepcapture

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * A note changed on two devices merges when the changes do not overlap, the same rules as cloud/shared/merge.mjs.
 * The note splits into frontmatter fields and the text below them. Against the version both devices last shared
 * (`base`), a field that only one side changed takes that side; the same value on both sides is one change, however
 * each device writes it (`[a, b]` or a block list, quotes, 10 or 10.0). The text merges per line the same way. Two
 * additions at one place both stay, the cloud's first. A line that moved is followed: a change the other device made
 * to it travels along, a line both devices moved stays once, where the cloud has it, and a line both devices changed
 * the same way stays once too when one of them moved it as well. A task is the same task whatever its tick: when the
 * lines do not merge, or leave a task twice, the ticks are merged on their own first and the lines after that.
 * Anything else (one line changed two ways, a line changed and removed), a missing `base` and any frontmatter this
 * simple reading does not understand give null: then the sync keeps both versions as before.
 */
object CloudNoteMerge {
    class Field(val lines: List<String>, val value: String)
    class Note(val fields: LinkedHashMap<String, Field>, val body: String)
    /** `lines` goes in place of the base lines from `start` up to `end`. */
    private class Change(val start: Int, val end: Int, val lines: List<String>)
    /** The three texts the way the merge per line reads their moves right, the lines both sides moved, and whether what comes of them is whole. */
    private class Followed(val base: List<String>, val local: List<String>, val cloud: List<String>, val both: Set<String>, val whole: (List<String>) -> Boolean)
    /** The lines of a merge per line, or none; `sure` when no task can stand in them twice. */
    private class Merged(val lines: List<String>?, val sure: Boolean)
    /** A task that stands once in a text: its line, the place of its tick in that line, and the tick. */
    private class Task(val index: Int, val at: Int, val tick: Char)

    /** A changed stretch of text bigger than this (base lines times changed lines) is not compared: both versions stay. */
    private const val MERGE_CELLS = 1000000L

    private val number = Regex("^-?\\d+(\\.\\d+)?([eE][+-]?\\d+)?$")
    private val keyPattern = Regex("^[A-Za-z0-9_][A-Za-z0-9_.-]*$")
    private val item = Regex("^\\s*- ")

    private fun utf8(bytes: ByteArray): String? = try {
        Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes)).toString()
    } catch (_: CharacterCodingException) { null }

    /** One scalar as JotDrop reads it: quotes off, and numbers by value. Null when it needs real YAML. */
    private fun scalar(raw: String): String? {
        val value = raw.trim()
        if (value.length >= 2 && value[0] in "\"'" && value.last() in "\"'") {
            val inner = value.substring(1, value.length - 1)
            return if (value[0] != value.last() || inner.any { it in "\"'\\" }) null else "s:$inner"
        }
        if (value.isNotEmpty() && value[0] in "[]{}|>&*!%@`\"'#" || value.contains(" #") || value.contains(": ")) return null
        return if (number.matches(value)) "n:${value.toDouble()}" else "s:$value"
    }

    /** The fields and the text below them, or null when the frontmatter is more than flat keys and lists. */
    fun split(text: String): Note? {
        if ('\r' in text) return null
        val lines = text.split('\n')
        if (lines[0] != "---") return Note(linkedMapOf(), text)
        val end = lines.subList(1, lines.size).indexOf("---").let { if (it < 0) -1 else it + 1 }
        if (end < 0 || end == lines.size - 1) return null
        val fields = linkedMapOf<String, Field>()
        var i = 1
        while (i < end) {
            val line = lines[i]
            val colon = line.indexOf(':')
            val key = if (colon > 0) line.substring(0, colon) else ""
            if (!keyPattern.matches(key) || key in fields) return null
            val rest = line.substring(colon + 1)
            if (rest.isNotEmpty() && !rest.startsWith(" ")) return null
            val own = mutableListOf(line)
            val value: String?
            if (rest.isBlank()) {
                val items = mutableListOf<String?>()
                i++
                while (i < end && item.containsMatchIn(lines[i])) { own += lines[i]; items += scalar(lines[i].replaceFirst(item, "")); i++ }
                if (i < end && lines[i].firstOrNull()?.isWhitespace() == true) return null
                value = if (items.isEmpty()) "s:" else if (null in items) null else list(items.filterNotNull())
            } else {
                i++
                val flow = rest.trim()
                value = if (flow.startsWith("[") && flow.endsWith("]")) {
                    val inner = flow.substring(1, flow.length - 1)
                    val items = if (inner.isBlank()) emptyList() else inner.split(',').map(::scalar)
                    if (null in items) null else list(items.filterNotNull())
                } else scalar(rest)
            }
            fields[key] = Field(own, value ?: return null)
        }
        return Note(fields, lines.subList(end + 1, lines.size).joinToString("\n"))
    }

    private fun list(items: List<String>) = "l:" + items.joinToString("\u0000", "[", "]")

    /** What one side changed, in order. Null when too much changed. */
    private fun changes(base: List<String>, side: List<String>): List<Change>? {
        var start = 0
        var baseEnd = base.size
        var sideEnd = side.size
        while (start < baseEnd && start < sideEnd && base[start] == side[start]) start++
        while (baseEnd > start && sideEnd > start && base[baseEnd - 1] == side[sideEnd - 1]) { baseEnd--; sideEnd-- }
        val rows = baseEnd - start
        val columns = sideEnd - start
        val width = columns + 1
        if ((rows + 1L) * width > MERGE_CELLS) return null
        // Lines in common from base line r and side line c onward. On a tie a base line counts as removed first.
        val common = IntArray((rows + 1) * width)
        for (r in rows - 1 downTo 0) for (c in columns - 1 downTo 0) {
            common[r * width + c] = if (base[start + r] == side[start + c]) common[(r + 1) * width + c + 1] + 1
                else maxOf(common[(r + 1) * width + c], common[r * width + c + 1])
        }
        val found = mutableListOf<Change>()
        var r = 0
        var c = 0
        var fromRow = 0
        var fromColumn = 0
        while (true) {
            val same = r < rows && c < columns && base[start + r] == side[start + c]
            if (same || (r == rows && c == columns)) {
                // As many lines in as out: each line changed by itself, so two devices ticking neighbours do not collide.
                if (r - fromRow == c - fromColumn) for (i in 0 until r - fromRow) found += Change(start + fromRow + i, start + fromRow + i + 1, listOf(side[start + fromColumn + i]))
                else found += Change(start + fromRow, start + r, side.subList(start + fromColumn, start + c))
                if (!same) return found
                fromRow = ++r
                fromColumn = ++c
            } else if (c == columns || (r < rows && common[(r + 1) * width + c] >= common[r * width + c + 1])) r++
            else c++
        }
    }

    /** Only spaces and tabs (and a Windows line end): such a line says nothing and is never followed as it moves. */
    private fun blank(line: String) = line.all { it == ' ' || it == '\t' || it == '\r' }

    /** How often each line is there. */
    private fun tally(lines: List<String>) = lines.groupingBy { it }.eachCount()

    /**
     * To the merge per line a moved line is gone in one place and new in another: a tick on the other device collides
     * with it, and two devices that move the same line leave it twice. This tells a move apart and gives the three texts
     * back the way the merge per line reads them right, with the lines both sides moved and a check that what comes of
     * them is whole. Null when no line moved like that.
     * A line moved on one side and changed where it stood on the other (that line alone, into a text the note did not
     * have and that side has once): the change travels along to the new place. A line both sides moved: once, where the
     * cloud has it. Moved is a line that says something and stands once in the note, before and after.
     * A line both sides made into the same text, one where it stood and the other at another place (two devices tick a
     * task, one of them with "Move checked items to the bottom"): that text is what the two share, so one side moved it.
     */
    private fun followMoves(base: List<String>, local: List<String>, cloud: List<String>, own: List<Change>, other: List<Change>): Followed? {
        fun adds(found: List<Change>) = found.flatMapTo(HashSet()) { it.lines }
        val ownPut = adds(own)
        val otherPut = adds(other)
        // The base lines a side took out while it has the same line somewhere else.
        fun taken(found: List<Change>, added: Set<String>) = found.flatMap { change -> (change.start until change.end).filter { base[it] in added && !blank(base[it]) } }
        val mine = taken(own, ownPut)
        val theirs = taken(other, otherPut)
        // The base lines a side changed one line for one line: base line number -> the new text.
        fun single(found: List<Change>) = found.filter { it.end == it.start + 1 && it.lines.size == 1 }.associate { it.start to it.lines[0] }
        val ownSingle = single(own)
        val otherSingle = single(other)
        // A line one side changed where it stood into a text the other side put in, without changing that line one for one itself.
        fun elsewhere(changed: Map<Int, String>, single: Map<Int, String>, added: Set<String>) = changed.any { (i, line) -> line in added && i !in single }
        if (mine.isEmpty() && theirs.isEmpty() && !elsewhere(ownSingle, otherSingle, otherPut) && !elsewhere(otherSingle, ownSingle, ownPut)) return null
        val before = tally(base)
        val here = tally(local)
        val there = tally(cloud)
        fun moved(lines: List<Int>, after: Map<String, Int>) = lines.filterTo(HashSet()) { before[base[it]] == 1 && after[base[it]] == 1 }
        val movedHere = moved(mine, here)
        val movedThere = moved(theirs, there)
        // What a side made of a base line it changed alone: base line number -> the new text.
        fun alone(changed: Map<Int, String>, after: Map<String, Int>) = changed.filterValues { !blank(it) && it !in before && after[it] == 1 }
        val ownAlone = alone(ownSingle, here)
        val otherAlone = alone(otherSingle, there)
        // Per text what a line becomes there: null (the line goes) or its changed text. A moved line stands once, so its text names it.
        val inBase = HashMap<String, String?>()
        val inLocal = HashMap<String, String?>()
        val inCloud = HashMap<String, String?>()
        val both = HashSet<String>()
        for (i in movedHere) {
            if (i in movedThere) { both += base[i]; inBase[base[i]] = null; inLocal[base[i]] = null }
            else otherAlone[i]?.let { inBase[base[i]] = it; inLocal[base[i]] = it }
        }
        for (i in movedThere) if (i !in movedHere) ownAlone[i]?.let { inBase[base[i]] = it; inCloud[base[i]] = it }
        // The same change on both sides. `changed` is what one side made of its lines where they stood; the other side
        // (`single` and `after`) did not change that line one for one, has it no more, and has the new text once.
        val same = mutableListOf<Pair<String, String>>()
        fun agreed(changed: Map<Int, String>, single: Map<Int, String>, after: Map<String, Int>) {
            for ((i, line) in changed) if (i !in single && !blank(base[i]) && before[base[i]] == 1 && base[i] !in after && after[line] == 1) same += base[i] to line
        }
        agreed(otherAlone, ownSingle, here)
        agreed(ownAlone, otherSingle, there)
        // Each side has that text once, so one line at most became it: named for two lines, it is followed for neither.
        val named = tally(inBase.values.filterNotNull() + same.map { it.second })
        // The lines that can only be there once: a text both sides made of a line, and what both have once of the note.
        val once = HashSet<String>()
        for ((line, text) in same) if (named[text] == 1) { inBase[line] = text; once += text }
        if (inBase.isEmpty()) return null
        for ((line, count) in before) if (count == 1 && !blank(line) && here[line] == 1 && there[line] == 1) once += line
        // Following compares the texts again, and that can read a line differently. So what comes of it must be whole:
        // every line a side put in, and once each line that can only be there once. Else both versions stay.
        val whole = { lines: List<String> ->
            val counts = tally(lines)
            once.all { counts[it] == 1 } && listOf(here, there).all { side -> side.all { (line, count) -> (counts[line] ?: 0) >= count - (before[line] ?: 0) } }
        }
        fun put(lines: List<String>, swaps: Map<String, String?>) = if (swaps.isEmpty()) lines else lines.mapNotNull { if (swaps.containsKey(it)) swaps[it] else it }
        return Followed(put(base, inBase), put(local, inLocal), put(cloud, inCloud), both, whole)
    }

    /** The base lines with both sides' changes, or null when they touch the same lines differently. */
    private fun combine(base: List<String>, own: List<Change>, other: List<Change>): List<String>? {
        val lines = mutableListOf<String>()
        var at = 0
        var last: Change? = null
        for (change in (other + own).sortedWith(compareBy<Change> { it.start }.thenBy { it.end })) {
            if (last != null && change.start == last.start && change.end == last.end && change.lines == last.lines) continue
            if (change.start < at) return null
            lines += base.subList(at, change.start)
            lines += change.lines
            at = change.end
            last = change
        }
        lines += base.subList(at, base.size)
        return lines
    }

    // A task line in three parts: up to its tick, the tick, and from the `]` on.
    private val task = Regex("([ \\t]*[-*+][ \\t]+\\[)([ xX])(\\](?:[ \\t][\\s\\S]*)?)")

    /** The task a line is, whatever its tick: the line with an empty box. Null for any other line. */
    private fun taskName(match: MatchResult) = match.groupValues[1] + " " + match.groupValues[3]
    private fun taskOf(line: String): String? = task.matchEntire(line)?.let(::taskName)

    /**
     * Whether the changes put a task in twice: only then can the merge per line leave a task twice. A change both sides
     * made alike is made once. Every day no task is put in twice, and then no line of the note is counted for it.
     */
    private fun putTwice(own: List<Change>, other: List<Change>): Boolean {
        fun mark(change: Change) = "${change.start} ${change.end} ${change.lines.joinToString("\n")}"
        val made = other.mapTo(HashSet(), ::mark)
        val put = HashSet<String>()
        fun again(line: String) = taskOf(line)?.let { !put.add(it) } ?: false
        return other.any { it.lines.any(::again) } || own.any { mark(it) !in made && it.lines.any(::again) }
    }

    /**
     * The lines with both sides' changes and the moves followed, or none when they touch the same lines differently.
     * Sure when no task can stand in them twice: no move was followed and no task was put in twice.
     */
    private fun perLine(base: List<String>, local: List<String>, cloud: List<String>): Merged {
        val own = changes(base, local) ?: return Merged(null, false)
        val other = changes(base, cloud) ?: return Merged(null, false)
        var lines = combine(base, own, other)
        var sure = !putTwice(own, other)
        val moves = followMoves(base, local, cloud, own, other)
        // Per line it collides on a move, or a line both sides moved is in twice: then the moves are followed. A line
        // that stood once never comes out twice; when following cannot be done either, or leaves the note less than
        // whole, both versions stay.
        if (moves != null && (lines == null || lines.count { it in moves.both } > moves.both.size)) {
            val near = changes(moves.base, moves.local)
            val far = changes(moves.base, moves.cloud)
            lines = if (near != null && far != null) combine(moves.base, near, far) else null
            if (lines != null && !moves.whole(lines)) lines = null
            sure = false
        }
        return Merged(lines, sure)
    }

    /**
     * The tick two sides leave a task with. The cloud's, when this side left the tick alone or the cloud put it in or
     * took it out; else this side's: then the cloud changed its letter at most (`x` or `X`). When both put it in, the
     * cloud's letter stays.
     */
    private fun mergedTick(old: Char, mine: Char, theirs: Char) = if (mine == old || (theirs == ' ') != (old == ' ')) theirs else mine

    /**
     * A task is the same task whatever its tick (design checklists-77-v2, part 8). Of the tasks that stand once in each
     * of the three texts (the same indent, sign and words; only the tick may differ): [once] tells whether each of them
     * stands once in the lines given, and [ticked] gives the three texts with their ticks merged, or null when no tick
     * differs. The merged tick is written into all three texts, so the merge per line after it only has to follow where
     * the line went.
     */
    private class SameTasks(private val texts: List<List<String>>) {
        private val found = texts.map { lines ->
            val tasks = HashMap<String, Task?>()
            for ((index, line) in lines.withIndex()) {
                val match = task.matchEntire(line) ?: continue
                val name = taskName(match)
                tasks[name] = if (tasks.containsKey(name)) null else Task(index, match.groupValues[1].length, match.groupValues[2][0])
            }
            tasks
        }
        private val same = found[0].keys.filter { name -> found.all { it[name] != null } }

        fun once(lines: List<String>): Boolean {
            val counts = tally(lines.mapNotNull(::taskOf))
            return same.all { counts[it] == 1 }
        }

        fun ticked(): List<List<String>>? {
            val next = texts.map { it.toMutableList() }
            var changed = false
            for (name in same) {
                val places = found.map { it.getValue(name)!! }
                val tick = mergedTick(places[0].tick, places[1].tick, places[2].tick)
                for ((text, place) in places.withIndex()) {
                    if (place.tick == tick) continue
                    val line = next[text][place.index]
                    next[text][place.index] = line.substring(0, place.at) + tick + line.substring(place.at + 1)
                    changed = true
                }
            }
            return if (changed) next else null
        }
    }

    /** The text with both sides' changes, or null when they touch the same lines differently. */
    private fun mergeLines(old: String, mine: String, theirs: String): String? {
        val texts = listOf(old, mine, theirs).map { it.split('\n') }
        val first = perLine(texts[0], texts[1], texts[2])
        if (first.lines != null && first.sure) return first.lines.joinToString("\n")
        // Both versions, or maybe a task twice: the ticks first, then the lines again. A task that stood once in all
        // three never comes out twice: when that cannot be had, both versions stay.
        val tasks = SameTasks(texts)
        if (first.lines != null && tasks.once(first.lines)) return first.lines.joinToString("\n")
        val ticked = tasks.ticked() ?: return null
        val again = perLine(ticked[0], ticked[1], ticked[2]).lines ?: return null
        return if (tasks.once(again)) again.joinToString("\n") else null
    }

    /**
     * The same merge per line for a text without frontmatter: [mine] and [theirs] both come from [base]. For Undo in the
     * editor (design checklists-77, 6.5), where the body is taken apart from the frontmatter already.
     */
    fun mergeText(base: String, mine: String, theirs: String): String? = mergeLines(base, mine, theirs)

    /** The merged note's bytes, or null when the two versions really disagree. */
    fun merge(base: ByteArray?, local: ByteArray, cloud: ByteArray): ByteArray? {
        val mine = split(utf8(local) ?: return null) ?: return null
        val theirs = split(utf8(cloud) ?: return null) ?: return null
        val shared = base?.let(::utf8)?.let(::split)
        fun pick(own: String?, other: String?, old: String?): Boolean? = when {
            own == other -> true
            shared != null && own == old -> true
            shared != null && other == old -> false
            else -> null
        }
        val body = when (pick(mine.body, theirs.body, shared?.body)) {
            true -> theirs.body
            false -> mine.body
            null -> mergeLines(shared?.body ?: return null, mine.body, theirs.body) ?: return null
        }
        val lines = mutableListOf<String>()
        for (key in LinkedHashSet(theirs.fields.keys + mine.fields.keys)) {
            val own = mine.fields[key]
            val other = theirs.fields[key]
            val fromCloud = pick(own?.value, other?.value, shared?.fields?.get(key)?.value) ?: return null
            (if (fromCloud) other else own)?.let { lines += it.lines }
        }
        val head = if (lines.isEmpty()) "" else lines.joinToString("\n", "---\n", "\n---\n")
        return (head + body).toByteArray(Charsets.UTF_8)
    }
}

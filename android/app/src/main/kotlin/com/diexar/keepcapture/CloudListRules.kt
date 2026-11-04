package com.diexar.keepcapture

/**
 * A list anyone with the link can tick, without an account: which of a guest's changes count and how they go into
 * your note, the same rules as cloud/shared/list-links.mjs. A guest may change ticks and add task lines; changed or
 * removed text goes back as it was. Text is always LF. No Android or JSON dependencies, so the JVM check can run it
 * against cloud/shared/list-link-vectors.json.
 */
object CloudListRules {
    /** Who ticked or added a line: `line` is the line with its box empty and `n` which one among equal lines. */
    data class Mark(val line: String, val n: Int, val by: String, val at: Long, val added: Boolean)
    /** A line of the list as a page shows it; task lines carry `key`, `n`, `ticked` and the last `mark`. */
    data class Line(val index: Int, val line: String, val task: Boolean, val text: String, val key: String? = null, val n: Int = 0, val ticked: Boolean = false, val mark: Mark? = null)
    class Reconciled(val text: String, val marks: List<Mark>, val noteChanged: Boolean, val linkChanged: Boolean)
    class Task(val key: String, val ticked: Boolean)

    const val MAX_ITEM_LENGTH = 500
    const val MAX_NAME_LENGTH = 40
    const val DEFAULT_NAME = "Someone"
    /** A longer changed stretch (base lines times link lines) is not compared: the guest change is then refused as a whole. */
    private const val DIFF_CELLS = 4_000_000L

    // The same spaces as JavaScript's \s, without the line ends that a split line cannot hold.
    private const val SPACE = "[\\t\\u000B\\f \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]"
    private val task = Regex("($SPACE*[-*+] \\[)([ xX])(\\] .*)")
    private val control = Regex("[\\x00-\\x1f\\x7f]")
    private val lineEnd = Regex("\\r\\n?")

    fun listAad(id: String) = "jotdrop:list-link:v1:$id"
    fun ownerAad(vaultId: String, id: String) = "jotdrop:list-link-owner:v1:$vaultId:$id"
    /** Proof that a writer has the key. The server only keeps its hash, so the key itself never leaves the link. */
    fun writeProof(key: String): String = CloudCrypto.sha256Hex("jotdrop:list-link-write:v1:$key".toByteArray(Charsets.UTF_8))
    fun proofHash(key: String): String = CloudCrypto.sha256Hex(writeProof(key).toByteArray(Charsets.UTF_8))

    fun normalize(text: String): String = text.replace(lineEnd, "\n")

    /** The line with its box empty as `key` (so a tick does not change it) and whether it is ticked, or null for a line that is not a task. */
    fun taskLine(line: String): Task? = task.matchEntire(line)?.let { Task("${it.groupValues[1]} ${it.groupValues[3]}", it.groupValues[2] != " ") }
    private fun setTick(line: String, ticked: Boolean): String = task.matchEntire(line)?.let { "${it.groupValues[1]}${if (ticked) "x" else " "}${it.groupValues[3]}" } ?: line
    fun hasChecklist(text: String): Boolean = normalize(text).split('\n').any { task.matches(it) }

    /** A name as it goes into the list: 1 to 40 characters without control characters; empty means "Someone". */
    fun guestName(value: String): String {
        val name = value.trim()
        if (name.isEmpty()) return DEFAULT_NAME
        require(name.length <= MAX_NAME_LENGTH && !control.containsMatchIn(name)) { "Enter a name of 1 to 40 characters." }
        return name
    }
    fun validName(value: String): String = try { guestName(value) } catch (_: IllegalArgumentException) { DEFAULT_NAME }

    private fun validItemText(text: String) = text.isNotBlank() && text.length <= MAX_ITEM_LENGTH && !control.containsMatchIn(text)
    // A line a guest may have added: any task line whose text would pass as a new item.
    private fun allowedNewLine(line: String) = taskLine(line) != null && validItemText(line.substring(line.indexOf("] ") + 2))

    /** Every line with what the page needs: task lines get `key`, `n` (which one of equal lines), `ticked` and the last `mark`. */
    fun listLines(text: String, marks: List<Mark> = emptyList()): List<Line> {
        val seen = HashMap<String, Int>()
        return normalize(text).split('\n').mapIndexed { index, line ->
            val item = taskLine(line) ?: return@mapIndexed Line(index, line, false, line)
            val n = seen[item.key] ?: 0
            seen[item.key] = n + 1
            Line(index, line, true, line.substring(line.indexOf("] ") + 2), item.key, n, item.ticked, marks.firstOrNull { it.line == item.key && it.n == n })
        }
    }

    /** Marks that still point at a line of `text`, with `changes` put in place of older marks on the same lines. */
    fun updateMarks(marks: List<Mark>, text: String, changes: List<Mark> = emptyList()): List<Mark> {
        val lines = listLines(text)
        val replaced = marks.filter { mark -> changes.none { it.line == mark.line && it.n == mark.n } }
        return (replaced + changes).filter { mark -> lines.any { it.task && it.key == mark.line && it.n == mark.n } }
    }

    // The task lines of a text by line and place among equals, so the same item is found again after lines moved.
    private fun same(line: Line) = "${line.n}\n${line.key}"
    private fun tasks(text: String): LinkedHashMap<String, Line> = listLines(text).filter { it.task }.associateByTo(LinkedHashMap()) { same(it) }
    private fun <T> slice(list: List<T>, from: Int, to: Int): List<T> = if (from < to) list.subList(from, to) else emptyList()

    // Which line of `next` each line of `base` comes back as, by key, or -1. Null when too big to compare.
    private fun align(base: List<String>, next: List<String>): IntArray? {
        var start = 0
        var baseEnd = base.size
        var nextEnd = next.size
        while (start < baseEnd && start < nextEnd && base[start] == next[start]) start++
        while (baseEnd > start && nextEnd > start && base[baseEnd - 1] == next[nextEnd - 1]) { baseEnd--; nextEnd-- }
        val rows = baseEnd - start
        val columns = nextEnd - start
        val width = columns + 1
        if ((rows + 1L) * width > DIFF_CELLS) return null
        val common = IntArray((rows + 1) * width)
        for (r in rows - 1 downTo 0) for (c in columns - 1 downTo 0) {
            common[r * width + c] = if (base[start + r] == next[start + c]) common[(r + 1) * width + c + 1] + 1 else maxOf(common[(r + 1) * width + c], common[r * width + c + 1])
        }
        val matchBase = IntArray(base.size) { i -> if (i < start) i else if (i >= baseEnd) i - base.size + next.size else -1 }
        var r = 0
        var c = 0
        while (r < rows && c < columns) {
            if (base[start + r] == next[start + c]) { matchBase[start + r] = start + c; r++; c++ }
            else if (common[(r + 1) * width + c] >= common[r * width + c + 1]) r++
            else c++
        }
        return matchBase
    }

    /**
     * What of a guest's version counts: every base line comes back in order, with at most its tick changed, and new lines
     * are task lines a guest could have added. Anything else is put back as it was: changed text (a base line gone and
     * other lines in its place), a removed or moved line, a line that is not a task. The ticks and allowed new lines
     * elsewhere still count. Returns the accepted text.
     */
    fun allowedGuestChange(base: String, next: String): String {
        val baseLines = normalize(base).split('\n')
        val nextLines = normalize(next).split('\n')
        fun key(line: String) = taskLine(line)?.key ?: line
        val matchBase = align(baseLines.map(::key), nextLines.map(::key)) ?: return baseLines.joinToString("\n")
        val removed = HashMap<String, Int>()
        baseLines.forEachIndexed { i, line -> if (matchBase[i] < 0) removed[key(line)] = (removed[key(line)] ?: 0) + 1 }
        val result = ArrayList<String>()
        var from = 0
        var fromNext = 0
        for (i in 0..baseLines.size) {
            val target = if (i < baseLines.size) matchBase[i] else nextLines.size
            if (target < 0) continue
            // Between two lines that came back: base lines that did not go back in, and whatever stood in their place does not
            // count. Where nothing was lost, task lines are new, unless a lost line turned up here: that one was moved, not added.
            val lost = slice(baseLines, from, i)
            if (lost.isNotEmpty()) result += lost
            else for (line in slice(nextLines, fromNext, target)) {
                val moved = removed[key(line)] ?: 0
                if (moved > 0) removed[key(line)] = moved - 1
                else if (allowedNewLine(line)) result += line
            }
            if (i < baseLines.size) result += if (taskLine(baseLines[i]) != null) nextLines[target] else baseLines[i]
            from = i + 1
            fromNext = target + 1
        }
        return result.joinToString("\n")
    }

    /**
     * What guests did between `base` and `accepted`, done to your own text: a tick they changed goes on the same line of
     * yours (a line you removed or rewrote no longer takes it), and a line they added goes in after the task line above
     * it in theirs, or before your first task line, unless your text has it already. So the same change done twice
     * changes nothing the second time, and your own edits stay as they are.
     */
    fun applyGuestChanges(base: String, accepted: String, mine: String): String {
        val was = tasks(base)
        val theirs = listLines(accepted)
        val lines = normalize(mine).split('\n').toMutableList()
        var own = tasks(lines.joinToString("\n"))
        theirs.forEachIndexed { i, line ->
            if (!line.task) return@forEachIndexed
            val old = was[same(line)]
            val have = own[same(line)]
            if (old != null && have != null && old.ticked != line.ticked) { lines[have.index] = setTick(have.line, line.ticked); return@forEachIndexed }
            if (old != null || have != null) return@forEachIndexed
            val above = theirs.subList(0, i).asReversed().firstOrNull { it.task && own.containsKey(same(it)) }
            val first = own.values.firstOrNull()
            var at = if (above != null) own.getValue(same(above)).index + 1 else first?.index ?: lines.size
            if (above == null && first == null) while (at > 0 && lines[at - 1] == "") at--
            lines.add(at, line.line)
            own = tasks(lines.joinToString("\n"))
        }
        return lines.joinToString("\n")
    }

    /**
     * Your note and the link brought together. `base` is the text an owner last wrote to the link. Guests' ticks and
     * new lines go into your note; what you ticked or added yourself gets a mark under your name, unless a guest
     * already did the same.
     */
    fun reconcile(base: String, note: String, linkText: String, linkMarks: List<Mark>, ownerName: String = "Owner", now: Long): Reconciled {
        val mine = normalize(note)
        val old = normalize(base)
        val theirs = normalize(linkText)
        val accepted = allowedGuestChange(old, theirs)
        val text = applyGuestChanges(old, accepted, mine)
        val was = tasks(old)
        val guests = tasks(accepted)
        val by = validName(ownerName)
        val own = tasks(mine).values.filter { line -> was[same(line)]?.ticked != line.ticked && guests[same(line)]?.ticked != line.ticked }
            .map { line -> Mark(requireNotNull(line.key), line.n, by, now, !was.containsKey(same(line))) }
        return Reconciled(text, updateMarks(linkMarks, text, own), text != mine, text != theirs)
    }
}

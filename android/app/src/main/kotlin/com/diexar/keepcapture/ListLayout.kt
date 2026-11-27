package com.diexar.keepcapture

/** How many levels of a list are drawn apart; a deeper item stands at the last of them (design checklists-77, 6.3). */
internal const val LIST_LEVELS_DRAWN = 8

/** Each level of a list stands this much further to the right, in sp (design checklists-77, 6.3). */
internal const val LEVEL_STEP = 24f

/** A list with a task in it stands this far to the right, in sp: the room of the handles (design checklists-77, part 5). */
internal const val TASK_SHIFT = 20f

/**
 * A line of a list as the formatted view places it (design checklists-77, parts 5 and 6.3).
 * [kind] is "task", "bullet" or "ordered", or "more" for more text under an item. [level] is the level that is drawn.
 * [marker] is what stands in front of the words (a box, a bullet, the number, each with its spaces): wrapped lines hang
 * at its width. [item] is the line of the item the line belongs to. [shifted]: the list has a task in it, so all of it
 * stands a little to the right and leaves the margin to the handles.
 */
internal data class ListRow(val kind: String, val level: Int, val marker: String, val item: Int, val shifted: Boolean)

/** Per line of [text] its [ListRow], or null for a line outside a list. Empty when the text has no list at all. */
internal fun listRows(text: String): List<ListRow?> {
    val (levels, items) = FormatCore.listLevelsAndItems(text)
    if (items.all { it < 0 }) return emptyList()
    val lines = text.split('\n')
    val rows = arrayOfNulls<ListRow>(lines.size)
    var from = 0
    while (from < lines.size) {
        if (items[from] < 0) { from++; continue }
        // A run of list lines without a line between them is one list.
        var to = from
        while (to + 1 < lines.size && items[to + 1] >= 0) to++
        val prefixes = (from..to).map { FormatCore.linePrefix(lines[it]) }
        val shifted = (from..to).any { levels[it] >= 0 && prefixes[it - from].kind == "task" }
        for (index in from..to) {
            val line = lines[index]
            val prefix = prefixes[index - from]
            val level = minOf(levels[items[index]], LIST_LEVELS_DRAWN - 1)
            val marker = if (levels[index] < 0) null else when (prefix.kind) {
                "task" -> (if (prefix.checked) "☑" else "☐") + line.substring(line.indexOf('[', prefix.markFrom) + 3, prefix.markTo)
                "bullet" -> "•" + line.substring(prefix.markFrom + 1, prefix.markTo)
                else -> line.substring(prefix.markFrom, prefix.markTo)
            }
            rows[index] = if (marker == null) ListRow("more", level, "", items[index], shifted) else ListRow(prefix.kind, level, marker, index, shifted)
        }
        from = to + 1
    }
    return rows.asList()
}

/** Whether [text] has a task in a list: then the note's menu offers its checklist items (design checklists-77, 6.4). */
internal fun hasTask(text: String): Boolean = '[' in text && listRows(text).any { it?.kind == "task" }

/**
 * The last line of [text] when the note ends in a list with a task in it, else -1: "+ List item" then stands under the
 * note (design checklists-77-v2, 6.1). A note that ends in plain text is told from its last line alone.
 */
internal fun endsInTaskList(text: String): Int {
    val last = text.substring(text.lastIndexOf('\n') + 1)
    if (last.isBlank() || (FormatCore.linePrefix(last.removeSuffix("\r")).kind == "" && last[0] != ' ' && last[0] != '\t')) return -1
    val rows = listRows(text)
    return if (rows.lastOrNull()?.shifted == true) rows.size - 1 else -1
}

/** While an item is dragged, the finger going this far sideways, in dp, is one level in or out (design checklists-77, 6.1). */
internal const val DRAG_LEVEL_STEP = 28f

/** Where a dragged item lands: in front of line [before] (the number of lines: after the text), on [level]. */
internal data class DropTarget(val before: Int, val level: Int)

/**
 * Where an item that is dragged lands (design checklists-77, 6.1). [slots] are its places (FormatCore.dropSlots),
 * [line] to [end] its own lines, [level] its own level and [lines] the number of lines of the text. [y] is the height
 * of the finger; [top] and [bottom] give those of a line. The place nearest to the finger wins. A place is the gap in
 * front of its line (under the last line for the place after the text); the item's own place is all of its own lines,
 * so a finger that stays on the item moves nothing. The item keeps its own level where the place takes it, else the
 * nearest level the place takes. [steps] is how many levels the finger went sideways since the drag began: they count
 * from there, so one step always changes the level when the place has room for it (the handle stands at the screen's
 * edge, and a finger cannot go far to that side). Null when there is no place.
 */
internal fun dropTarget(
    slots: List<FormatCore.Slot>, line: Int, end: Int, level: Int, lines: Int, y: Float, steps: Int,
    top: (Int) -> Float, bottom: (Int) -> Float,
): DropTarget? {
    var best: FormatCore.Slot? = null
    var nearest = Float.MAX_VALUE
    for (slot in slots) {
        val distance = if (slot.before == line) maxOf(top(line) - y, y - bottom(end), 0f)
            else kotlin.math.abs(y - if (slot.before < lines) top(slot.before) else bottom(lines - 1))
        if (distance < nearest) { nearest = distance; best = slot }
    }
    val slot = best ?: return null
    return DropTarget(slot.before, (level.coerceIn(slot.minLevel, slot.maxLevel) + steps).coerceIn(slot.minLevel, slot.maxLevel))
}

/** A line an item is dragged past takes this long to make room, and an item that is let go this long to reach its place. */
internal const val SLIDE_MS = 120f

/**
 * The room the lines of a text make for an item that is dragged (design checklists-77-v2, 5.1 and 5.2). The text does
 * not change during a drag: the lines between the item's own place ([line] to [end], of [lines] lines) and the place
 * where it would land are only drawn a block further, [height] pixels, each on its way there for [SLIDE_MS].
 */
internal class RoomMade(val line: Int, val end: Int, val lines: Int, val height: Float) {
    private val shift = FloatArray(lines)

    // The lines that stand off their place or are on their way to one: none while [from] is past [until].
    var from = Int.MAX_VALUE
        private set
    var until = -1
        private set

    /** How far line [index] stands from its own place now. */
    fun of(index: Int): Float = if (index < from || index > until) 0f else shift[index]

    /**
     * One frame, [seconds] long: every line between the item's own place and line [before], in front of which it would
     * land (null: nowhere), goes toward a block further, the others back to their own place. True when a line moved.
     */
    fun slide(before: Int?, seconds: Float): Boolean {
        val step = height * seconds * 1000f / SLIDE_MS
        var first = 0
        var last = -1
        var far = 0f
        if (before != null && before < line) { first = before; last = line - 1; far = height }
        else if (before != null && before > end + 1) { first = end + 1; last = before - 1; far = -height }
        val low = if (last >= first) minOf(from, first) else from
        val high = if (last >= first) maxOf(until, last) else until
        var moved = false
        var nextFrom = Int.MAX_VALUE
        var nextUntil = -1
        var index = low
        while (index <= high) {
            val goal = if (index in first..last) far else 0f
            val now = shift[index]
            if (now != goal) {
                shift[index] = if (now < goal) minOf(goal, now + step) else maxOf(goal, now - step)
                moved = true
            }
            if (shift[index] != 0f || goal != 0f) {
                if (index < nextFrom) nextFrom = index
                nextUntil = index
            }
            index++
        }
        from = nextFrom
        until = nextUntil
        return moved
    }

    /**
     * The finger let go. Where every line stands now, for the lines as they are numbered once the item has landed in
     * front of line [before] (null: it went back to its own place): the same order as FormatCore.dropItemEdit makes.
     * [top] gives the top of a line as it is laid out now and [itemTop] is where the item itself stands.
     */
    fun settling(before: Int?, top: (Int) -> Float, itemTop: Float): Settling {
        val size = end - line + 1
        val first = if (before == null) line else if (before <= line) before else before - size
        val low = minOf(from, line, first)
        val high = maxOf(until, end, first + size - 1)
        val was = FloatArray(high - low + 1) { Float.NaN }
        for (index in low..high) {
            if (index in line..end) continue
            val now = when {
                before == null -> index
                before <= line && index >= before && index < line -> index + size
                before > end && index > end && index < before -> index - size
                else -> index
            }
            was[now - low] = top(index) + of(index)
        }
        return Settling(first, first + size - 1, low, was, itemTop)
    }
}

/**
 * An item that was let go, and the lines around it, on their way to their places in the text as it is after the drop.
 * [line] to [end] are the item's lines in that text. [was] holds where line [low] and on stood when the finger let go
 * (no number for the item's own lines) and [itemTop] where the item stood.
 */
internal class Settling(val line: Int, val end: Int, val low: Int, private val was: FloatArray, private val itemTop: Float) {
    // How far every line and the item stand from their place in the new layout: known once that is there.
    private var off: FloatArray? = null
    private var itemOff = 0f

    /** The new text is laid out, with [top] the top of each of its lines: from here the ways to go are known. */
    fun resolve(top: (Int) -> Float) {
        if (off != null) return
        off = FloatArray(was.size) { if (was[it].isNaN()) 0f else was[it] - top(low + it) }
        itemOff = itemTop - top(line)
    }

    /** How far line [index] stands from its place with [left] of the way to go (1 when the finger let go, then down to 0). */
    fun of(index: Int, left: Float): Float {
        val far = off ?: return 0f
        return if (index < low || index >= low + far.size) 0f else far[index - low] * left
    }

    /** The same for the item itself. */
    fun ofItem(left: Float): Float = itemOff * left
}

/**
 * The places of [dropTarget] for the item on line [line] of a piece of the body (a body with a table is shown in
 * pieces), in the piece's own line numbers. [whole] is the whole body and [above] the number of its lines above the
 * piece, which has [lines] lines. The core keeps an item between the tables around it; the ticked end of a list is a
 * piece too (design checklists-77-v2, 6.1), and there the item stays in the piece it is shown in: [place] says how that
 * piece lies. At the top of the ticked items an item lands as a main item only, or it would hang under the open task
 * above them. In front of the first line of a piece under ticked items it would join those, so that is no place.
 */
internal fun dropSlotsIn(whole: String, above: Int, line: Int, lines: Int, place: PiecePlace = PiecePlace.FREE): List<FormatCore.Slot> =
    FormatCore.dropSlots(whole, above + line).mapNotNull { slot ->
        val before = slot.before - above
        when {
            before < 0 || before > lines -> null
            before == 0 && place == PiecePlace.UNDER_CHECKED -> null
            before == 0 && place == PiecePlace.CHECKED -> slot.copy(before = 0, maxLevel = 0)
            else -> slot.copy(before = before)
        }
    }

/**
 * How far an item that is dragged is drawn from its own place when the body is shown in pieces (design
 * checklists-77-v2, part 6): it stops at the edge of the piece it is shown in. The other pieces draw themselves, so an
 * item that went on would stand through their text. [off] is how far the finger took it, [itemTop] and [itemBottom]
 * are where its own lines stand, [pieceTop] and [pieceBottom] the top of the piece's first line and the bottom of its
 * last. Where the item lands is not decided here.
 */
internal fun keptInPiece(off: Float, itemTop: Float, itemBottom: Float, pieceTop: Float, pieceBottom: Float): Float =
    maxOf(minOf(off, pieceBottom - itemBottom), pieceTop - itemTop)

/**
 * Whether the task on [line] shows its cross (design checklists-77-v3, 2.2): it is the task with the caret ([caret], -1
 * when there is none), and it is not in an item that is lifted off the note. [lifted] are the lines of that item with
 * all that hangs under it, from the finger on its handle until its frame is gone. The frame's edge would run through
 * the cross, and a finger that holds the handle cannot use it.
 */
internal fun crossShown(line: Int, caret: Int, lifted: IntRange?): Boolean = line == caret && (lifted == null || line !in lifted)

/**
 * Whether Move up or Move down ([direction] "up" or "down") would take the item [line] belongs to past the header of
 * the ticked items (design checklists-77-v2, 6.1): the item it would trade places with is in the ticked end of the
 * list and the item itself is not, or the other way round. False too when the item has no such neighbour.
 */
internal fun crossesChecked(text: String, line: Int, direction: String): Boolean {
    val moved = FormatCore.moveItemEdit(text, line, direction) ?: return false
    val span = FormatCore.itemSpan(text, line) ?: return false
    val other = if (direction == "up") moved.line else span.end + 1
    val tails = FormatCore.checkedTail(text)
    fun ticked(at: Int) = tails.any { at >= it.from && at <= it.to }
    return ticked(span.line) != ticked(other)
}

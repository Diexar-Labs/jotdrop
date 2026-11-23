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

/**
 * The places of [dropTarget] for the item on line [line] of a piece of the body (a body with a table is shown in
 * pieces), in the piece's own line numbers. [whole] is the whole body and [above] the number of its lines above the
 * piece. The core keeps an item between the tables around it, which is the piece it is shown in.
 */
internal fun dropSlotsIn(whole: String, above: Int, line: Int): List<FormatCore.Slot> =
    FormatCore.dropSlots(whole, above + line).map { it.copy(before = it.before - above) }

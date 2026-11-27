package com.diexar.keepcapture

private val listMarker = Regex("^([ \\t]*)([-*+])[ \\t]+(?:\\[([ xX])\\](?:[ \\t]+|$))?")
private val checklistItem = Regex("(?m)^(\\s*-\\s+\\[)([ xX])(\\](?:\\s|$))")
private val codeFence = Regex("^[ \\t]*(`{3,}|~{3,})(.*)$")

/** A card row: its source line, the how-manieth checklist item it is, and its list level (-1: no list line). */
internal data class PreviewTaskRow(val text: String, val checklistIndex: Int?, val level: Int = -1)

internal fun sameChecklistPreview(left: String, right: String): Boolean {
    fun identity(text: String) = checklistItem.replace(text) { it.groupValues[1] + " " + it.groupValues[3] }
    return identity(left) == identity(right)
}

/** Keep the writer's source indices; only the displayed prefix is ever limited. */
internal fun previewTaskRows(text: String): List<PreviewTaskRow> {
    val indices = checklistItem.findAll(text).mapIndexed { index, match ->
        val marker = match.range.first + match.groupValues[1].indexOf('-')
        text.take(marker).count { it == '\n' } to index
    }.toMap()
    val levels = FormatCore.listLevels(text)
    return text.lines().mapIndexed { line, value -> PreviewTaskRow(value, indices[line], levels.getOrElse(line) { -1 }) }
}

/** Toggle exactly the Nth Markdown checklist item, or null when it does not exist. */
internal fun toggleChecklistText(text: String, targetIndex: Int): String? {
    if (targetIndex < 0) return null
    var currentIndex = 0
    var toggled = false
    val updated = checklistItem.replace(text) { match ->
        if (currentIndex++ != targetIndex) match.value
        else {
            toggled = true
            val state = match.groupValues[2]
            match.groupValues[1] + (if (state == " ") "x" else " ") + match.groupValues[3]
        }
    }
    return updated.takeIf { toggled }
}

/**
 * Ticks the Nth checklist item, counted as [toggleChecklistText] counts them, through the shared core: with [move] the
 * task moves below the open tasks of its list (design kaarten-en-lijsten, part 6). A line the core sees as no task (in
 * a code block, say) gets the old toggle, without moving.
 */
internal fun tickChecklistText(text: String, targetIndex: Int, move: Boolean): String? {
    if (targetIndex < 0) return null
    val match = checklistItem.findAll(text).elementAtOrNull(targetIndex) ?: return null
    val marker = match.range.first + match.groupValues[1].indexOf('-')
    val tick = FormatCore.tickEdit(text, text.substring(0, marker).count { it == '\n' }, move)
        ?: return toggleChecklistText(text, targetIndex)
    return text.replaceRange(tick.edit.from, tick.edit.to, tick.edit.insert)
}

/** The rewritten note plus anything typed below [marker] while it waited (7 nov: tasks were lost otherwise). */
internal fun keepTextAfterMarker(latest: String, marker: String, rewritten: String): String {
    val added = latest.substringAfter(marker, "").trim()
    return if (added.isEmpty()) rewritten else "$rewritten\n\n$added"
}

private fun nextFence(line: String, fence: String?): String? {
    val match = codeFence.matchEntire(line) ?: return fence
    val marker = match.groupValues[1]
    if (fence == null) return marker
    return if (marker[0] == fence[0] && marker.length >= fence.length && match.groupValues[2].isBlank()) null else fence
}

/**
 * An Enter in a list as one replacement, and where the caret goes. That is mostly right behind what was put in; an
 * empty item that goes a level back keeps the caret behind its marker (seen on Eric's phone, 22 Nov: it stood in front
 * of the box, and the next letter broke the task).
 */
internal data class ListEnterEdit(val from: Int, val to: Int, val insert: String, val caret: Int = from + insert.length)

/** Enter in a list, by the shared formatting core (the same cases as the web app), numbered lists included. */
internal fun listEnterEdit(text: String, start: Int, end: Int = start): ListEnterEdit? =
    FormatCore.listEnterEdit(text, start, end)?.let { ListEnterEdit(it.from, it.to, it.insert, it.selFrom) }

/**
 * The keyboard pressed Enter: [next] has exactly one new line break, just before its collapsed
 * cursor, and nothing else changed outside the line the cursor was on. That line may differ a
 * little, because keyboards often replace the word being typed (autocorrect, a suggestion) in the
 * same update as the line break. Returns the new text and cursor, or null when this was not a
 * plain Enter on a list line. [enter] is what Enter does there: among the ticked items that is
 * [checkedEnterEdit].
 */
internal fun listEnterAfterChange(
    current: String,
    next: String,
    nextCursor: Int,
    enter: (String, Int) -> ListEnterEdit? = { text, at -> listEnterEdit(text, at, at) },
): Pair<String, Int>? {
    val at = nextCursor - 1
    if (at < 0 || at >= next.length || next[at] != '\n') return null
    val base = next.removeRange(at, at + 1)
    if (base.count { it == '\n' } != current.count { it == '\n' }) return null
    val lineStart = base.lastIndexOf('\n', at - 1) + 1
    val lineEnd = base.indexOf('\n', at).let { if (it < 0) base.length else it }
    val tail = base.length - lineEnd
    if (tail > current.length || lineStart > current.length - tail) return null
    if (!current.regionMatches(0, base, 0, lineStart)) return null
    if (!current.regionMatches(current.length - tail, base, lineEnd, tail)) return null
    val edit = enter(base, at) ?: return null
    return base.replaceRange(edit.from, edit.to, edit.insert) to edit.caret
}

/**
 * Enter among the ticked items of a list (design checklists-77-v2, 6.1): the ticked item is not split. A new empty
 * task comes at the bottom of the open tasks of that list, as "+ List item" makes one, with the caret in it. Null when
 * the caret at [at] is in no list.
 */
internal fun checkedEnterEdit(text: String, at: Int): ListEnterEdit? =
    FormatCore.addItemEdit(text, lineOf(text, at))?.edit?.let { ListEnterEdit(it.from, it.to, it.insert, it.selFrom) }

/**
 * Enter on an empty item that stands right above the ticked items of its list, when those are shown as a part of their
 * own (design checklists-77-v2, part 6; Eric, 26 Nov): the list is left at its end. Anywhere else Enter takes the sign
 * of an empty item away and leaves an empty line there, but here that line would cut the ticked items off as a list of
 * their own. So the empty item goes, and the caret comes on a new empty line under the ticked items. A CRLF text stays
 * CRLF. Null when the caret at [at] is in no such item.
 */
internal fun leaveAboveChecked(text: String, at: Int): ListEnterEdit? {
    val line = lineOf(text, at)
    val tail = FormatCore.checkedTail(text).firstOrNull { it.from == line + 1 } ?: return null
    val starts = lineStarts(text)
    // Only where the core's own Enter takes the sign away and leaves the caret at the start of the line: an empty
    // item on the main level, the caret behind its sign.
    val plain = FormatCore.listEnterEdit(text, at, at) ?: return null
    val from = starts[line]
    val ticked = starts[line + 1]
    if (plain.from != from || plain.insert.isNotEmpty() || plain.selFrom != from) return null
    val to = if (tail.to + 1 < starts.size) starts[tail.to + 1] - 1 else text.length
    val kept = text.substring(ticked, to)
    if (to == text.length) {
        // The ticked items end the text: their last line gets the `\r` of a CRLF text, the new one ends the text without.
        val cr = if (ticked >= 2 && text[ticked - 2] == '\r' && !kept.endsWith("\r")) "\r" else ""
        return ListEnterEdit(from, to, "$kept$cr\n")
    }
    val cr = if (kept.endsWith("\r")) "\r" else ""
    return ListEnterEdit(from, to, "$kept\n$cr", from + kept.length + 1)
}

/**
 * [text] with an empty line under it, to type on: a tap in the room under ticked items that end the note asks for it
 * (design checklists-77-v2, part 6; Eric, 26 Nov). The line above it gets the `\r` of a CRLF text. Saving takes an
 * empty line at the end of a note away again, so one that is not typed on leaves nothing in the note.
 */
internal fun withLineUnder(text: String): String {
    val before = text.lastIndexOf('\n')
    return text + (if (before > 0 && text[before - 1] == '\r' && !text.endsWith("\r")) "\r" else "") + "\n"
}

/**
 * Whether [next] is [current] after a Backspace at the start of the item on the first line of the ticked items, which
 * start at [from] in both (design checklists-77-v2, 6.1): there is no line above it in that part to join, and its box
 * must stay. The caret stood in front of the item's words, or right behind its box.
 */
internal fun backspaceAtChecked(current: String, caret: Int, next: String, from: Int): Boolean {
    if (next.length >= current.length || caret < from || caret > current.length) return false
    val end = current.indexOf('\n', from).let { if (it < 0) current.length else it }
    return caret <= minOf(end, from + FormatCore.linePrefix(current.substring(from, end).removeSuffix("\r")).markTo)
}

/**
 * What a Backspace next to the sign of a list item becomes (design checklists-77-v3, 4.3 and 4.4). [joined]: the item
 * joined the line above it or lost its sign, which is a step of its own for Undo. Else the keyboard took several
 * characters at once and they stop in front of the sign: that is typing.
 */
internal class SignBackspace(val text: String, val caret: Int, val joined: Boolean)

/**
 * The keyboard took the [removed] characters in front of the caret at [caret] of [text] away, in the formatted view of
 * a note's body; [hidden] are the signs that view hides. With the caret right behind the sign of a list item, or in it,
 * the item joins the line above it or loses its sign (FormatCore.itemBackspaceEdit), however many characters the
 * keyboard wanted. With the caret further in the item, what goes stops in front of the sign: a keyboard that takes a
 * whole word at once never takes half a box along, and the next Backspace is the one above. Null: an ordinary Backspace.
 */
internal fun signBackspace(text: String, caret: Int, removed: Int, hidden: List<IntRange>): SignBackspace? {
    FormatCore.itemBackspaceEdit(text, caret, hidden)?.let { return SignBackspace(text.replaceRange(it.from, it.to, it.insert), it.selFrom, true) }
    val lineStart = text.lastIndexOf('\n', caret - 1) + 1
    val lineEnd = text.indexOf('\n', lineStart).let { if (it < 0) text.length else it }
    val prefix = FormatCore.linePrefix(text.substring(lineStart, lineEnd))
    val signEnd = lineStart + prefix.markTo
    if (caret - removed >= signEnd || (prefix.kind != "task" && prefix.kind != "bullet" && prefix.kind != "ordered")) return null
    if (FormatCore.listLevels(text).getOrElse(lineOf(text, lineStart)) { -1 } < 0) return null
    return SignBackspace(text.removeRange(signEnd, caret), signEnd, false)
}

/**
 * A lowercase letter typed as the first thing in a list item (after "- ", "- [ ] " or "1. ") becomes a capital, like the
 * first letter of a sentence (issue #44, point 9). The keyboard cannot do it: it sees a marker before the cursor, not a
 * sentence start. Only one typed character counts; pasted text, a dictated phrase and a word taken from a suggestion
 * stay as they came, and so does an edit anywhere else in the item. Null when [next] needs no change.
 */
internal fun capitalizeListItemStart(current: String, next: String): String? {
    val diff = textDiff(current, next)
    if (diff.endB - diff.start != 1 || diff.endA - diff.start > 1) return null
    val typed = next[diff.start]
    if (!typed.isLowerCase()) return null
    val lineStart = next.lastIndexOf('\n', diff.start - 1) + 1
    val lineEnd = next.indexOf('\n', diff.start).let { if (it < 0) next.length else it }
    var fence: String? = null
    for (line in next.substring(0, lineStart).split('\n')) fence = nextFence(line, fence)
    if (fence != null) return null
    val prefix = FormatCore.linePrefix(next.substring(lineStart, lineEnd))
    if (prefix.kind != "bullet" && prefix.kind != "task" && prefix.kind != "ordered") return null
    if (diff.start != lineStart + prefix.markTo) return null
    val capital = typed.uppercase()
    // A letter with no single-letter capital (the German sharp s becomes two letters) is left alone.
    if (capital.length != 1 || capital[0] == typed) return null
    return next.replaceRange(diff.start, diff.start + 1, capital)
}

/** Where [b] differs from [a]: the part a[start, endA) became b[start, endB). */
internal data class TextDiff(val start: Int, val endA: Int, val endB: Int) {
    val size get() = (endA - start) + (endB - start)
}

internal fun textDiff(a: String, b: String): TextDiff {
    val max = minOf(a.length, b.length)
    var prefix = 0
    while (prefix < max && a[prefix] == b[prefix]) prefix++
    var suffix = 0
    while (suffix < max - prefix && a[a.length - 1 - suffix] == b[b.length - 1 - suffix]) suffix++
    return TextDiff(prefix, a.length - suffix, b.length - suffix)
}

/** A change replayed on the text on screen; [map] moves a cursor position from the field's text to [text]. */
internal class Replayed(val text: String, val map: (Int) -> Int)

/**
 * The text field may still be editing [raw], the text we just replaced with [shown] (a list marker
 * after Enter), when its next update arrives: it only takes over [shown] after the next frame.
 * Typing fast, or a busy phone, then sends [next] built on [raw], and taking it as it is drops the
 * marker. When [next] is closer to [raw] than to [shown], this replays that change on [shown].
 * Null when [next] is built on [shown], or when the change touches the part we replaced. One such change is replayed
 * all the same: a Backspace ([staleBackspace], with [shownCaret] and [nextCaret] the carets of [shown] and [next]).
 */
internal fun replayStale(raw: String, shown: String, next: String, shownCaret: Int = -1, nextCaret: Int = -1): Replayed? {
    val stale = textDiff(raw, next)
    if (stale.size >= textDiff(shown, next).size) return null
    val ours = textDiff(raw, shown)
    val after = stale.start >= ours.endA
    if (!after && stale.endA > ours.start) return staleBackspace(raw, shown, next, shownCaret, nextCaret)
    val insert = next.substring(stale.start, stale.endB)
    val shift = shown.length - raw.length
    val text = if (after) shown.replaceRange(stale.start + shift, stale.endA + shift, insert)
        else shown.replaceRange(stale.start, stale.endA, insert)
    val moved = if (after) 0 else next.length - raw.length
    val oursStart = ours.start + moved
    val oursEnd = ours.endA + moved
    return Replayed(text) { at ->
        when {
            at < oursStart -> at
            at >= oursEnd -> at + shift
            else -> oursStart + (ours.endB - ours.start)
        }
    }
}

/**
 * A Backspace the field made in the part of [raw] that the editor replaced (design checklists-77-v3, 4.4): an item
 * joined the line above it, and the field, which still has the item's sign, goes on taking that sign away while the
 * key is held. Such a change cannot be replayed by its place, and taken as it is it would put the item back with half
 * a sign. It is replayed as what it is: as many characters in front of the caret of [shown] go, where the editor's own
 * rules for a Backspace see it again. Null when [next] is not [raw] without the characters right behind [nextCaret].
 */
private fun staleBackspace(raw: String, shown: String, next: String, shownCaret: Int, nextCaret: Int): Replayed? {
    val taken = raw.length - next.length
    if (taken < 1 || nextCaret < 0 || nextCaret + taken > raw.length || shownCaret < 0 || shownCaret > shown.length) return null
    if (next != raw.removeRange(nextCaret, nextCaret + taken)) return null
    val at = maxOf(0, shownCaret - taken)
    return Replayed(shown.removeRange(at, shownCaret)) { at }
}

/** Remembers the text the field still has after we replaced it, for a short while. */
internal class StaleField(private val clock: () -> Long = System::currentTimeMillis) {
    private var raw: String? = null
    private var shown: String? = null
    private var at = 0L

    /** [caret] and [nextCaret]: the carets of [current] and [next], or -1 where there is a selection. */
    fun replay(current: String, next: String, caret: Int = -1, nextCaret: Int = -1): Replayed? {
        val before = raw ?: return null
        if (shown != current || clock() - at > 1500) {
            raw = null
            return null
        }
        return replayStale(before, current, next, caret, nextCaret)
    }

    /** The field sent [fieldText] and the editor shows [shownText]. */
    fun settle(fieldText: String, shownText: String) {
        if (fieldText == shownText) {
            raw = null
        } else {
            raw = fieldText
            shown = shownText
            at = clock()
        }
    }
}

/** Display only: one bullet replaces one marker, leaving every source offset intact. */
internal fun renderListBullets(text: String): String {
    var fence: String? = null
    return text.split('\n').joinToString("\n") { line ->
        val marker = if (fence == null) listMarker.find(line) else null
        fence = nextFence(line, fence)
        if (marker != null && marker.groups[3] == null) {
            val offset = marker.groupValues[1].length
            line.replaceRange(offset, offset + 1, "\u2022")
        } else line
    }
}

/**
 * Text of more than one line that came into a list item in one go, a paste mostly (design checklists-77, 6.6): [next]
 * is [current] with its selection ([selFrom] to [selTo]) replaced by text that has a line break in it, the caret right
 * behind it at [nextCaret]. Every line of it becomes an item of its own (FormatCore.pasteLinesEdit). The new text and
 * caret, or null when [next] is no such change or the core leaves it an ordinary paste. Ask this after the list
 * Enter: a word a keyboard finishes in the same update as Enter is typing, not a paste. With [checked] the item is
 * among the ticked items of a list, and every task it becomes is ticked (design checklists-77-v2, 6.1).
 */
internal fun pastedLines(current: String, selFrom: Int, selTo: Int, next: String, nextCaret: Int, checked: Boolean = false): Pair<String, Int>? {
    if (selFrom < 0 || selTo < selFrom || selTo > current.length || nextCaret > next.length) return null
    val size = nextCaret - selFrom
    if (size < 2 || next.length - current.length != size - (selTo - selFrom)) return null
    val pasted = next.substring(selFrom, nextCaret)
    if (pasted.none { it == '\n' || it == '\r' }) return null
    if (!current.regionMatches(0, next, 0, selFrom) || !current.regionMatches(selTo, next, nextCaret, current.length - selTo)) return null
    val edit = FormatCore.pasteLinesEdit(current, selFrom, selTo, pasted) ?: return null
    val text = current.replaceRange(edit.from, edit.to, edit.insert)
    if (!checked) return text to edit.selFrom
    // The lines the paste made, the item it landed in included: an empty box among them gets its tick.
    val first = lineOf(current, selFrom)
    val lines = text.split('\n').toMutableList()
    for (index in first..first + lines.size - current.count { it == '\n' } - 1) {
        val prefix = FormatCore.linePrefix(lines[index].removeSuffix("\r"))
        if (prefix.kind != "task" || prefix.checked) continue
        val box = lines[index].indexOf('[', prefix.markFrom) + 1
        lines[index] = lines[index].substring(0, box) + "x" + lines[index].substring(box + 1)
    }
    return lines.joinToString("\n") to edit.selFrom
}

/** Where a place in the text is after [edit] was made by something else than its own selection: it stays in its own text. */
internal fun FormatCore.Edit.moved(at: Int): Int = when {
    at <= from -> at
    at >= to -> at + insert.length - (to - from)
    else -> from + minOf(at - from, insert.length)
}

/** The number of the line that holds place [at] of [text]. */
internal fun lineOf(text: String, at: Int): Int {
    var line = 0
    for (index in 0 until at.coerceIn(0, text.length)) if (text[index] == '\n') line++
    return line
}

/** Where every line of [text] starts. */
internal fun lineStarts(text: String): IntArray {
    val starts = IntArray(text.count { it == '\n' } + 1)
    var line = 1
    for ((index, char) in text.withIndex()) if (char == '\n') starts[line++] = index + 1
    return starts
}

/** Where line [line] of [text] starts; the end of the text for a line it does not have. */
internal fun lineStartOf(text: String, line: Int): Int {
    var at = 0
    repeat(line) {
        val next = text.indexOf('\n', at)
        if (next < 0) return text.length
        at = next + 1
    }
    return at
}

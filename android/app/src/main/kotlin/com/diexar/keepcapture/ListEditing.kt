package com.diexar.keepcapture

private val listMarker = Regex("^([ \\t]*)([-*+])[ \\t]+(?:\\[([ xX])\\](?:[ \\t]+|$))?")
private val codeFence = Regex("^[ \\t]*(`{3,}|~{3,})(.*)$")

private fun nextFence(line: String, fence: String?): String? {
    val match = codeFence.matchEntire(line) ?: return fence
    val marker = match.groupValues[1]
    if (fence == null) return marker
    return if (marker[0] == fence[0] && marker.length >= fence.length && match.groupValues[2].isBlank()) null else fence
}

internal data class ListEnterEdit(val from: Int, val to: Int, val insert: String)

internal fun listEnterEdit(text: String, start: Int, end: Int = start): ListEnterEdit? {
    val lineStart = text.substring(0, start).lastIndexOf('\n') + 1
    val lineEnd = text.indexOf('\n', start).let { if (it < 0) text.length else it }
    val marker = listMarker.find(text.substring(lineStart, lineEnd)) ?: return null
    if (start < lineStart + marker.value.length || end > lineEnd) return null
    var fence: String? = null
    for (line in text.substring(0, lineStart).split('\n')) fence = nextFence(line, fence)
    if (fence != null) return null
    val remaining = text.substring(lineStart + marker.value.length, start) + text.substring(end, lineEnd)
    if (remaining.isBlank()) return ListEnterEdit(lineStart, lineEnd, "")
    val checkbox = if (marker.groups[3] == null) "" else "[ ] "
    return ListEnterEdit(start, end, "\n${marker.groupValues[1]}- $checkbox")
}

/**
 * The keyboard pressed Enter: [next] has exactly one new line break, just before its collapsed
 * cursor, and nothing else changed outside the line the cursor was on. That line may differ a
 * little, because keyboards often replace the word being typed (autocorrect, a suggestion) in the
 * same update as the line break. Returns the new text and cursor, or null when this was not a
 * plain Enter on a list line.
 */
internal fun listEnterAfterChange(
    current: String,
    next: String,
    nextCursor: Int,
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
    val edit = listEnterEdit(base, at, at) ?: return null
    return base.replaceRange(edit.from, edit.to, edit.insert) to edit.from + edit.insert.length
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
 * Null when [next] is built on [shown], or when the change touches the part we replaced.
 */
internal fun replayStale(raw: String, shown: String, next: String): Replayed? {
    val stale = textDiff(raw, next)
    if (stale.size >= textDiff(shown, next).size) return null
    val ours = textDiff(raw, shown)
    val after = stale.start >= ours.endA
    if (!after && stale.endA > ours.start) return null
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

/** Remembers the text the field still has after we replaced it, for a short while. */
internal class StaleField(private val clock: () -> Long = System::currentTimeMillis) {
    private var raw: String? = null
    private var shown: String? = null
    private var at = 0L

    fun replay(current: String, next: String): Replayed? {
        val before = raw ?: return null
        if (shown != current || clock() - at > 1500) {
            raw = null
            return null
        }
        return replayStale(before, current, next)
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

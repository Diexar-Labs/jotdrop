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

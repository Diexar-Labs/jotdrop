package com.diexar.keepcapture

/**
 * The changes Ask JotDrop asks for, as note text: the same rules as cloud/web/ai-web.mjs, so a note changed by the
 * AI on the phone looks the same as one changed in the web app (scripts/check-ai-android.mjs compares the two).
 * Pure functions; AiExecutor saves through Storage like any other edit.
 */
object AiNoteEdits {
    private val FRONT = Regex("^---\\r?\\n[\\s\\S]*?\\r?\\n---(?:\\r?\\n|\\z)")
    private val TITLE = Regex("^#[ \\t]+(.*?)[ \\t]*(?:\\r?\\n|\\z)(?:[ \\t]*\\r?\\n)?")
    private val NEW_HEADING = Regex("^#[ \\t]+(.*?)[ \\t]*(?:\\n|\\z)")
    private val LINE_BREAKS = Regex("[\\r\\n]+")
    private val OWN_BOX = Regex("^(?:[-*]\\s*)?\\[[ xX]?\\]\\s*")
    private val OWN_BULLET = Regex("^[-*]\\s+")
    private val TRAILING_NEWLINES = Regex("(?:\\r?\\n)+\\z")
    private val ENDS_WITH_TASK = Regex("(?:^|\\n)\\s*[-*] \\[[ xX]\\][^\\n]*\\z")

    data class Parts(val front: String, val title: String, val body: String)

    /** Front matter, the title heading and the rest, like splitNote in the web app. */
    fun splitNote(text: String): Parts {
        val front = FRONT.find(text)?.value.orEmpty()
        val rest = text.substring(front.length)
        val heading = TITLE.find(rest) ?: return Parts(front, "", rest)
        return Parts(front, heading.groupValues[1], rest.substring(heading.value.length))
    }

    fun oneLine(text: String?): String = LINE_BREAKS.replace(text.orEmpty(), " ").trim()

    // The AI sometimes writes the checkbox itself; JotDrop writes it once.
    private fun task(item: String) = "- [ ] " + OWN_BULLET.replace(OWN_BOX.replace(oneLine(item), ""), "")

    /** A new note's text in the form the editor writes, without front matter: a title, text, then the checklist. */
    fun newNoteBody(title: String, text: String?, items: List<String>?): String {
        val blocks = mutableListOf<String>()
        if (!text.isNullOrBlank()) blocks.add(text.trim())
        if (!items.isNullOrEmpty()) blocks.add(items.joinToString("\n", transform = ::task))
        return "# ${oneLine(title)}\n" + if (blocks.isNotEmpty()) "\n${blocks.joinToString("\n\n")}\n" else ""
    }

    /** The note's file text with text and checklist items added at the end. Items follow a list directly. */
    fun appendedText(fileText: String, text: String?, items: List<String>?): String {
        val newline = if (fileText.contains("\r\n")) "\r\n" else "\n"
        var result = TRAILING_NEWLINES.replace(fileText, "")
        fun add(block: String, tight: Boolean) {
            val lines = block.split(Regex("\\r?\\n")).joinToString(newline)
            result = if (result.isNotEmpty()) result + (if (tight) newline else newline + newline) + lines else lines
        }
        val hasText = !text.isNullOrBlank()
        if (hasText) add(text!!.trim(), false)
        if (!items.isNullOrEmpty()) add(items.joinToString("\n", transform = ::task), !hasText && ENDS_WITH_TASK.containsMatchIn(result.replace("\r", "")))
        return result + newline
    }

    /** The note's file text with a new text: front matter and title stay. A repeated title heading is dropped. */
    fun replacedText(fileText: String, newText: String): String {
        val (front, title) = splitNote(fileText)
        val body = draftBody(title, newText)
        return front + (if (title.isNotEmpty()) "# $title\n\n" else "") + (if (body.isNotEmpty()) "$body\n" else "")
    }

    /** New text for a note body under its title: without a repeated title heading at the top. */
    fun draftBody(title: String, newText: String): String {
        val body = newText.replace("\r\n", "\n").trim()
        val heading = NEW_HEADING.find(body)
        return if (title.isNotEmpty() && heading != null && heading.groupValues[1].trim().lowercase() == title.trim().lowercase()) body.substring(heading.value.length).trim() else body
    }

    /** Labels without empty ones and without doubles in another letter case. */
    fun cleanLabels(labels: List<String>): List<String> {
        val unique = LinkedHashMap<String, String>()
        for (label in labels) { val name = oneLine(label); if (name.isNotEmpty()) unique.putIfAbsent(name.lowercase(), name) }
        return unique.values.toList()
    }

    /** What the confirmation shows for a text change: every line with ' ', '+' or '−' in front (never color alone). */
    @Suppress("UNCHECKED_CAST")
    fun changeLines(change: AiChange): List<Pair<Char, String>>? {
        val before = change.note.text.replace("\r\n", "\n").replace(Regex("\\n+\\z"), "")
        val after = when (change.tool) {
            "append_to_note" -> appendedText(before, change.input["text"] as? String, change.input["items"] as? List<String>).removeSuffix("\n")
            "replace_note_text" -> (change.input["text"] as String).replace("\r\n", "\n").trim()
            else -> return null
        }
        val lines = CloudVersionDiff.lines(before, after)
            ?: (before.split('\n').map { CloudVersionDiff.Line(CloudVersionDiff.Kind.REMOVED, it) } + after.split('\n').map { CloudVersionDiff.Line(CloudVersionDiff.Kind.ADDED, it) })
        return lines.map { line -> (when (line.kind) { CloudVersionDiff.Kind.ADDED -> '+'; CloudVersionDiff.Kind.REMOVED -> '-'; else -> ' ' }) to line.text }
    }

    /** The fixed request behind an editor or card button. */
    fun editorRequest(kind: String, title: String): String {
        val name = oneLine(title).ifEmpty { "Untitled" }
        return when (kind) {
            "rewrite" -> "Rewrite the note \"$name\" so it reads clearly: fix spelling and grammar, keep the meaning, the facts and the language. Answer with only the new text of the note, without a title or comments."
            "checklist" -> "Turn the note \"$name\" into a checklist of action points, one per line, each starting with \"- [ ] \". Answer with only the checklist, without a title or comments."
            "summarize" -> "Summarize the note \"$name\" in a few short lines, in the language of the note. Answer with only the summary, without a title or comments."
            else -> throw IllegalArgumentException("Unknown request.")
        }
    }

    /**
     * The fixed request behind "Merge with AI" (Find duplicates), word for word mergeRequest in cloud/web/app.js. The
     * notes are named by id only: a title is data, never part of the request.
     */
    fun mergeRequest(older: String, newer: String): String =
        "Two notes may be duplicates. The older one has id $older, the newer one has id $newer. Write one text that keeps everything from both notes and does not repeat itself, in the language of the notes. Replace the text of the newer note (id $newer) with that text. Do not change the older note."
}

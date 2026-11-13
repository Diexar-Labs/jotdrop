package com.diexar.keepcapture

import java.text.Normalizer

/**
 * A note as Ask JotDrop reads it: text is the note without front matter and title. reminder and expires (version 2,
 * "This week") are the front matter's values, as the web app's aiNotes hands them over.
 */
data class AiNote(
    val id: String,
    val title: String,
    val text: String,
    val labels: List<String> = emptyList(),
    val updatedAt: String? = null,
    val shared: Boolean = false,
    val reminder: String? = null,
    val expires: String? = null,
)

/** A note chosen to go with a question, cut to fit. */
data class AiPicked(val id: String, val title: String, val text: String, val truncated: Boolean)

data class AiSelection(val notes: List<AiPicked>, val chars: Int, val left: Int)

data class AiMatch(val id: String, val title: String, val snippet: String, val labels: List<String>, val updatedAt: String?) {
    fun json(): Map<String, Any?> = linkedMapOf("id" to id, "title" to title, "snippet" to snippet, "labels" to labels, "updatedAt" to updatedAt)
}

/**
 * Which notes go with a question, chosen on this device, the same as cloud/shared/ai/context.mjs: words from the
 * question (a word counts only from its start: "kopen" does not find "verkopen"), a title match counts three
 * times a text match, newest first on a tie. At most 20 notes and 30,000
 * characters; a long note is cut with "[...]". Notes from shared spaces and list links stay home unless the user
 * switches them on; notes the user picks go first.
 */
object AiContext {
    const val MAX_NOTES = 20
    const val MAX_CHARS = 30000
    const val MAX_NOTE_CHARS = 6000
    private const val MIN_PIECE = 200
    private const val SNIPPET = 200
    private const val CUT = "\n[...]"
    private val MARKS = Regex("\\p{M}")
    private val SPLIT = Regex("[^\\p{L}\\p{N}]+")
    private val DIGITS = Regex("^\\p{N}+$")
    private val LETTER_OR_NUMBER = Regex("[\\p{L}\\p{N}]")
    // Any white space, like JavaScript's \s. No Unicode flag: Android's ICU regex does not take it.
    private val SPACES = Regex("[\\s\\p{Z}\\uFEFF]+")

    // Common words in the app's languages that say nothing about which note is meant.
    private val COMMON = ("the and for what was were who how when where which with from that this have has are you your about did does " +
        "wat was wie hoe waar wanneer welke met van voor bij het een die dat mijn heb heeft zijn " +
        "als ook maar niet nog dan naar over wel toch zou zal alle deze dit mij jij wij zij hun onze werd wordt worden geen " +
        "que qué los las una con por para del como cómo der die das und mit von für ist les des une pour avec est").split(' ').map(::fold).toSet()

    private fun fold(text: String): String = MARKS.replace(Normalizer.normalize(text.lowercase(), Normalizer.Form.NFD), "")

    /** The words of a question that can pick a note: three letters or more, or a number, without common words. */
    fun words(question: String): List<String> = fold(question).split(SPLIT)
        .filter { (it.length >= 3 || (it.isNotEmpty() && DIGITS.matches(it))) && it !in COMMON }
        .distinct()

    /**
     * True when the term begins a word of the text: "boodschap" finds "boodschappen", "kopen" does not find
     * "verkopen" (10 Nov 2026). A word begins at the start or after anything that is not a letter or a number.
     * The same as startsWord in cloud/shared/ai/context.mjs; ai-vectors.json holds the cases.
     */
    private fun startsWord(haystack: String, term: String): Boolean {
        var at = haystack.indexOf(term)
        while (at >= 0) {
            if (at == 0) return true
            if (!LETTER_OR_NUMBER.matches(String(Character.toChars(Character.codePointBefore(haystack, at))))) return true
            at = haystack.indexOf(term, at + 1)
        }
        return false
    }

    private fun score(note: AiNote, terms: List<String>): Int {
        val title = fold(note.title)
        val text = fold(note.text)
        return terms.sumOf { (if (startsWord(title, it)) 3 else 0) + (if (startsWord(text, it)) 1 else 0) }
    }

    private fun ranked(notes: List<AiNote>, question: String, includeShared: Boolean): List<AiNote> {
        val terms = words(question)
        if (terms.isEmpty()) return emptyList()
        return notes.mapIndexed { index, note -> Triple(note, index, if (includeShared || !note.shared) score(note, terms) else 0) }
            .filter { it.third > 0 }
            .sortedWith(compareByDescending<Triple<AiNote, Int, Int>> { it.third }
                .thenComparator { a, b -> (b.first.updatedAt ?: "").compareTo(a.first.updatedAt ?: "") }
                .thenBy { it.second })
            .map { it.first }
    }

    /** Cut a text to a length, with the mark that something was left out. */
    fun cut(text: String, length: Int): Pair<String, Boolean> =
        if (text.length <= length) text to false else text.substring(0, maxOf(0, length - CUT.length)) + CUT to true

    fun selectNotes(
        notes: List<AiNote>, question: String, maxNotes: Int = MAX_NOTES, maxChars: Int = MAX_CHARS,
        includeShared: Boolean = false, pinned: List<String> = emptyList(),
    ): AiSelection {
        val byId = notes.associateBy { it.id }
        val candidates = pinned.mapNotNull { byId[it] } + ranked(notes, question, includeShared).filter { it.id !in pinned }
        val chosen = mutableListOf<AiPicked>()
        var chars = 0
        for (note in candidates) {
            val room = minOf(MAX_NOTE_CHARS, maxChars - chars) - note.title.length
            if (chosen.size >= maxNotes || room < minOf(MIN_PIECE, note.text.length)) break
            val (piece, truncated) = cut(note.text, room)
            chosen.add(AiPicked(note.id, note.title, piece, truncated))
            chars += note.title.length + piece.length
        }
        return AiSelection(chosen, chars, candidates.size - chosen.size)
    }

    /** Search for the assistant's search_notes tool: id, title, the first characters, labels and date. */
    fun searchNotes(notes: List<AiNote>, query: String, limit: Int = 10, includeShared: Boolean = false): List<AiMatch> =
        ranked(notes, query, includeShared).take(limit).map { note ->
            AiMatch(note.id, note.title, cut(SPACES.replace(note.text, " ").trim(), SNIPPET).first, note.labels, note.updatedAt)
        }

    private fun escapeAttribute(value: String) = value.replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;")
    // A note's text cannot open or close a note element of its own.
    private val NOTE_TAG = Regex("(?i)<(/?)(note)")
    private fun escapeBody(value: String) = NOTE_TAG.replace(value) { "&lt;${it.groupValues[1]}${it.groupValues[2]}" }

    /** Notes as data for the AI: one <note> element each. */
    fun formatNotes(notes: List<Triple<String, String, String>>): String =
        notes.joinToString("\n") { (id, title, text) -> "<note id=\"${escapeAttribute(id)}\">\nTitle: ${escapeBody(title)}\n${escapeBody(text)}\n</note>" }
}

/** The system prompt from cloud/shared/ai/prompt.json, with the places for language, date, time zone and labels. */
object AiPrompt {
    fun system(promptJson: String, language: String?, date: String, timeZone: String?, labels: List<String>): String {
        val lines = AiJson.parse(promptJson).obj().items("system").map { it as String }
        val values = mapOf(
            "language" to (language?.takeIf { it.isNotBlank() } ?: "the language the user writes in"),
            "date" to date,
            "timeZone" to (timeZone?.takeIf { it.isNotBlank() } ?: "UTC"),
            "labels" to (if (labels.isEmpty()) "no labels yet" else labels.joinToString(", ")),
        )
        return Regex("\\{\\{(\\w+)\\}\\}").replace(lines.joinToString("\n")) { values[it.groupValues[1]] ?: "" }
    }
}

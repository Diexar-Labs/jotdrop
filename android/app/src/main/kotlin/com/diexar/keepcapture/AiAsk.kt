package com.diexar.keepcapture

import java.text.Normalizer

/**
 * What goes along with a request from the ask screen.
 * notes: what the AI may search and read with its tools (unticked notes are not in it).
 * chosen: the notes sent with the request itself, exactly as the screen lists them ticked.
 * shown: the notes on the screen's list, ticked or not.
 * missing: the request is about one note (card menu) and that note could not be read: nothing should be sent.
 */
data class AiPlan(val notes: List<AiNote>, val chosen: List<AiPicked>, val shown: List<AiNote>, val missing: Boolean)

/**
 * The ask screen's choice of notes, decided at the moment it is needed, from the notes as they are then
 * (10 Nov 2026: "Summarize with AI" used a choice made before the notes were read, and sent only the request).
 * Android only for now: the web app still picks with cloud/shared/ai/context.mjs as it is.
 */
object AiAsk {
    const val SHORT = 60
    private val MARKS = Regex("\\p{M}")
    private val SPLIT = Regex("[^\\p{L}\\p{N}]+")
    private val SPACES = Regex("[\\s\\p{Z}\\uFEFF]+")

    private fun fold(text: String): String = MARKS.replace(Normalizer.normalize(text.lowercase(), Normalizer.Form.NFD), "")
    private fun set(words: String) = words.split(' ').filter { it.isNotEmpty() }.map(::fold).toSet()

    // Words that say what to do, or what kind of thing to make, and nothing about which note is meant.
    private val INSTRUCTION = set(
        "make create new note notes text title titled called named write add put list checklist item items please can could would want need " +
            "tell show give find search help change rewrite summarize summary set remind reminder label labels into onto some all everything " +
            "maak maken nieuwe nieuw notitie notities tekst titel genaamd heet schrijf voeg toe zet lijst lijstje graag alsjeblieft kun kan wil moet " +
            "vertel laat zien geef zoek vind verander herschrijf samenvatting vat samen herinnering alle alles iets erin erbij " +
            "mach mache erstelle erstellen neue neuen neues neu notiz notizen titel schreib schreibe füge hinzu setze liste checkliste bitte kannst " +
            "möchte zeig zeige gib such suche finde hilf ändere zusammenfassung erinnerung etwas " +
            "haz crea crear nueva nuevo nota notas texto título llamada escribe añade pon lista favor puedes quiero dime muestra busca encuentra " +
            "ayuda cambia resume resumen recordatorio etiqueta todo todas todos algo " +
            "fais crée créer nouvelle nouveau texte titre intitulée appelée écris ajoute mets stp svp peux veux dis montre cherche trouve aide " +
            "rappel étiquette tout tous toutes " +
            "fai creare nuova nuovo testo titolo chiamata scrivi aggiungi metti favore puoi voglio dimmi mostra cerca trova aiuta riassumi " +
            "riassunto promemoria etichetta tutto tutti tutte qualcosa",
    )
    private val NEW = set("new nieuw nieuwe neu neue neuen neues nuevo nueva nouveau nouvelle nouvel nuovo nuova")
    private val MAKE = set("make create write start maak schrijf begin mach mache erstelle schreib schreibe haz crea escribe fais crée écris fai scrivi")
    private val ARTICLE = set("a an een ein eine einen un una uno une")
    private val THING = set("note notes notitie notities notiz notizen nota notas list lists lijst lijstje liste lista checklist checkliste todo")
    private val MINE = set("my our mijn onze ons mein meine meinen meiner unsere unser mi mis nuestra nuestro mon ma mes notre mio mia miei mie nostra nostro")

    private fun isThing(word: String) = word in THING || word.endsWith("lijst") || word.endsWith("liste")

    /**
     * True for a request to make something new ("Make a new note ...", "Maak een lijst ..."), in the app's six
     * languages: a word for new, or a word for make followed by "a", before the kind of thing, and no "my" in between.
     */
    fun isCreate(request: String): Boolean {
        val words = fold(request).split(SPLIT).filter { it.isNotEmpty() }
        val thing = words.indexOfFirst(::isThing)
        if (thing < 0) return false
        val before = words.subList(0, thing)
        if (before.any { it in MINE }) return false
        return before.any { it in NEW } || before.indices.any { before[it] in MAKE && words.getOrNull(it + 1) in ARTICLE }
    }

    /** The words of a request that can pick a note: those of AiContext.words, without the words that only say what to do. */
    fun matchText(request: String): String = AiContext.words(request).filter { it !in INSTRUCTION }.joinToString(" ")

    fun plan(
        notes: List<AiNote>, request: String, excluded: Set<String> = emptySet(), pinned: String? = null, target: Boolean = false,
        summarize: Boolean = false, includeShared: Boolean = false, maxNotes: Int = AiContext.MAX_NOTES,
    ): AiPlan {
        if (target && pinned == null) return AiPlan(emptyList(), emptyList(), emptyList(), missing = true)
        if (summarize) {
            val own = notes.filter { it.id == pinned }
            val picked = AiContext.selectNotes(own, "", pinned = listOfNotNull(pinned)).notes
            return AiPlan(own, picked, own, missing = false)
        }
        // Something new needs no notes up front; the AI can still search for one.
        val question = if (pinned == null && isCreate(request)) "" else matchText(request)
        // Chosen from all notes, so that an unticked note leaves its place empty instead of letting another one in unseen.
        val candidates = AiContext.selectNotes(notes, question, maxNotes = maxNotes, includeShared = includeShared, pinned = listOfNotNull(pinned)).notes
        val byId = notes.associateBy { it.id }
        val shown = candidates.mapNotNull { byId[it.id] } + notes.filter { it.id in excluded && candidates.none { c -> c.id == it.id } }
        return AiPlan(notes.filter { it.id !in excluded }, candidates.filter { it.id !in excluded }, shown, missing = false)
    }

    /** A title as one short line: the first line, at most SHORT characters, with … when cut. */
    fun shortTitle(text: String, max: Int = SHORT): String {
        val line = text.lineSequence().map { SPACES.replace(it, " ").trim() }.firstOrNull { it.isNotEmpty() }.orEmpty()
        return if (line.length <= max) line else line.take(max).trimEnd() + "…"
    }

    private val WIKI_EMBED = Regex("^!\\[\\[[^\\]]+]]$")
    private val MD_IMAGE = Regex("^!\\[[^\\]]*]\\([^)]+\\)$")

    /**
     * The first line of a note's text, short, for the list of what goes along. Lines that only embed a picture
     * (![[file.webp]] or ![alt](file.png)) are skipped, like Storage.extractTitle does.
     */
    fun firstLine(note: AiNote): String {
        val line = note.text.lineSequence().map { SPACES.replace(it, " ").trim() }
            .firstOrNull { it.isNotEmpty() && !WIKI_EMBED.matches(it) && !MD_IMAGE.matches(it) }.orEmpty()
        return shortTitle(line, 80)
    }
}

package com.diexar.keepcapture

import java.text.Normalizer
import kotlin.math.floor

/** A pair of notes that look like duplicates: a is the older note, b the newer one, drop the one to offer for the trash. */
data class SimilarPair(val a: String, val b: String, val kind: String, val score: Double, val drop: String) {
    fun json(): Map<String, Any?> = linkedMapOf("a" to a, "b" to b, "kind" to kind, "score" to score, "drop" to drop)
}

data class SimilarResult(val pairs: List<SimilarPair>, val complete: Boolean)

/**
 * Duplicate notes, found on this phone without AI and without a network (Ask JotDrop v2, part E). The same as
 * cloud/shared/similar.mjs; cloud/shared/similar-vectors.json holds the cases both must pass.
 *
 * A note's text is without front matter and title. Three kinds of pair:
 *   same    the text is equal after folding case and accents and collapsing white space
 *   near    at least 0.8 of the word triples of the two notes are shared (Jaccard)
 *   inside  not near, but at least 0.9 of the shorter note's triples sit in the other note; the shorter note is
 *           the one to offer for the trash, never the longer one (Opus check, 13 Nov 2026).
 * Not looked at: shared notes (groups, live list links) and texts shorter than 40 characters. The trash is never
 * handed in. A time limit stops the search with complete = false instead of hanging.
 */
object Similar {
    const val MIN_CHARS = 40
    const val NEAR_JACCARD = 0.8
    const val NEAR_CONTAINED = 0.9
    const val TIME_LIMIT_MS = 4000L
    private const val MAX_POSTING = 200
    private const val MAX_PAIRS = 500
    private const val CANDIDATE_SHARE = 0.5
    private val MARKS = Regex("\\p{M}")
    // Any white space, like JavaScript's \s. No Unicode flag: Android's ICU regex does not take it.
    private val SPACES = Regex("[\\s\\p{Z}\\uFEFF]+")
    private val SPLIT = Regex("[^\\p{L}\\p{N}]+")
    private val KIND_ORDER = mapOf("same" to 0, "near" to 1, "inside" to 2)

    private fun fold(text: String): String = MARKS.replace(Normalizer.normalize(text.lowercase(), Normalizer.Form.NFD), "")
    fun normalizeText(text: String): String = SPACES.replace(fold(text), " ").trim { it == ' ' }

    private fun triples(text: String): Set<String> {
        val words = text.split(SPLIT).filter { it.isNotEmpty() }
        if (words.size < 3) return setOf(words.joinToString(" "))
        val found = LinkedHashSet<String>()
        for (i in 0 until words.size - 2) found.add("${words[i]} ${words[i + 1]} ${words[i + 2]}")
        return found
    }

    /** The key under which "Keep both" remembers a pair, the same for either order and the same as pairKey() in similar.mjs. */
    fun pairKey(first: String, second: String): String = listOf(first, second).sorted().joinToString("\n")

    private fun round2(value: Double) = floor(value * 100 + 0.5) / 100

    private class Item(val note: AiNote, val text: String) { var grams: Set<String> = emptySet() }
    private class Found(val pair: SimilarPair, val newer: AiNote)

    private fun older(left: Item, right: Item): Pair<Item, Item> {
        val a = left.note.updatedAt ?: ""
        val b = right.note.updatedAt ?: ""
        if (a != b) return if (a < b) left to right else right to left
        return if (left.note.id <= right.note.id) left to right else right to left
    }

    fun findDuplicates(
        notes: List<AiNote>, dismissed: Collection<String> = emptyList(),
        timeLimitMs: Long = TIME_LIMIT_MS, now: () -> Long = System::currentTimeMillis,
    ): SimilarResult {
        val skip = dismissed.toHashSet()
        val started = now()
        val items = notes.filter { !it.shared }.map { Item(it, normalizeText(it.text)) }.filter { it.text.length >= MIN_CHARS }
        val found = mutableListOf<Found>()
        var complete = true
        fun add(left: Item, right: Item, kind: String, score: Double, shorter: Item? = null) {
            if (pairKey(left.note.id, right.note.id) in skip) return
            if (found.size >= MAX_PAIRS) { complete = false; return }
            val (first, second) = older(left, right)
            found.add(Found(SimilarPair(first.note.id, second.note.id, kind, score, (shorter ?: first).note.id), second.note))
        }

        // Equal text: one group each.
        val groups = LinkedHashMap<String, MutableList<Item>>()
        for (item in items) groups.getOrPut(item.text) { mutableListOf() }.add(item)
        for (group in groups.values) for (i in group.indices) for (j in i + 1 until group.size) add(group[i], group[j], "same", 1.0)

        // Near and inside: only different texts, found through the triples they have in common.
        for (item in items) item.grams = triples(item.text)
        val postings = HashMap<String, MutableList<Int>>()
        items.forEachIndexed { index, item -> for (gram in item.grams) postings.getOrPut(gram) { mutableListOf() }.add(index) }
        var i = 0
        while (i < items.size && complete) {
            if (i % 25 == 0 && now() - started > timeLimitMs) { complete = false; break }
            val counts = LinkedHashMap<Int, Int>()
            for (gram in items[i].grams) {
                val list = postings.getValue(gram)
                if (list.size > MAX_POSTING) continue
                for (j in list) if (j > i) counts[j] = (counts[j] ?: 0) + 1
            }
            for ((j, counted) in counts) {
                val left = items[i]
                val right = items[j]
                if (left.text == right.text) continue
                val small = minOf(left.grams.size, right.grams.size)
                if (counted < small * CANDIDATE_SHARE) continue
                val (few, many) = if (left.grams.size <= right.grams.size) left.grams to right.grams else right.grams to left.grams
                val shared = few.count { it in many }
                val jaccard = shared.toDouble() / (left.grams.size + right.grams.size - shared)
                val contained = shared.toDouble() / small
                if (jaccard >= NEAR_JACCARD) add(left, right, "near", round2(contained))
                else if (contained >= NEAR_CONTAINED) add(left, right, "inside", round2(contained), if (left.grams.size <= right.grams.size) left else right)
            }
            i++
        }
        val sorted = found.sortedWith(Comparator { x, y ->
            (KIND_ORDER.getValue(x.pair.kind) - KIND_ORDER.getValue(y.pair.kind)).takeIf { it != 0 }
                ?: y.pair.score.compareTo(x.pair.score).takeIf { it != 0 }
                ?: (y.newer.updatedAt ?: "").compareTo(x.newer.updatedAt ?: "").takeIf { it != 0 }
                ?: x.pair.a.compareTo(y.pair.a).takeIf { it != 0 }
                ?: x.pair.b.compareTo(y.pair.b)
        })
        return SimilarResult(sorted.map { it.pair }, complete)
    }
}

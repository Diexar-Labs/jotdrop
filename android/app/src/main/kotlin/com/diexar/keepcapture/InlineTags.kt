package com.diexar.keepcapture

/**
 * Inline `#tags` zoals Obsidian ze indexeert: na regelbegin of witruimte,
 * buiten code, met minstens één niet-cijfer. `\#tag` (geneutraliseerde
 * gedeelde inhoud), koppen (`# Titel`) en link-ankers tellen niet mee.
 */
object InlineTags {
    private val code = Regex("```[\\s\\S]*?```|~~~[\\s\\S]*?~~~|`[^`\\n]+`")
    private val tag = Regex("(?:^|(?<=\\s))#([\\p{L}\\p{N}_/-]+)", RegexOption.MULTILINE)

    private val skipped = Regex("(`{3,}|~{3,})[\\s\\S]*?\\1|`[^`\\n]+`|\\[\\[[^\\]\\n]*]]|]\\([^)\\n]*\\)|https?://[^\\s<>]+")
    private val hashtag = Regex("(?<![\\\\\\p{L}\\p{N}\\p{M}_/])#(?=\\p{N}*[\\p{L}\\p{M}_/\\p{So}-])")

    /**
     * Escapet `#tag` als `\#tag` zodat gedeelde tekst geen tags wordt. Spiegel van TS
     * `neutralizeInlineHashtags`: overal buiten code-fences, inline code, wikilinks,
     * link-doelen en kale URL's; een tag mag elke letter bevatten, nooit alleen cijfers.
     */
    fun neutralize(text: String): String {
        val out = StringBuilder()
        var at = 0
        for (m in skipped.findAll(text)) {
            out.append(hashtag.replace(text.substring(at, m.range.first), "\\\\#")).append(m.value)
            at = m.range.last + 1
        }
        return out.append(hashtag.replace(text.substring(at), "\\\\#")).toString()
    }

    fun find(body: String, known: List<String> = emptyList()): List<String> {
        val seen = known.mapTo(mutableSetOf()) { it.lowercase() }
        return tag.findAll(code.replace(body, " "))
            .map { it.groupValues[1] }
            .filter { name -> name.any { !it.isDigit() } && seen.add(name.lowercase()) }
            .toList()
    }
}

package com.diexar.keepcapture

/**
 * Inline `#tags` zoals Obsidian ze indexeert: na regelbegin of witruimte,
 * buiten code, met minstens één niet-cijfer. `\#tag` (geneutraliseerde
 * gedeelde inhoud), koppen (`# Titel`) en link-ankers tellen niet mee.
 */
object InlineTags {
    private val code = Regex("```[\\s\\S]*?```|~~~[\\s\\S]*?~~~|`[^`\\n]+`")
    private val tag = Regex("(?:^|(?<=\\s))#([\\p{L}\\p{N}_/-]+)", RegexOption.MULTILINE)

    fun find(body: String, known: List<String> = emptyList()): List<String> {
        val seen = known.mapTo(mutableSetOf()) { it.lowercase() }
        return tag.findAll(code.replace(body, " "))
            .map { it.groupValues[1] }
            .filter { name -> name.any { !it.isDigit() } && seen.add(name.lowercase()) }
            .toList()
    }
}

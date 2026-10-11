package com.diexar.keepcapture

/**
 * Collection names are independent of Obsidian tags; spaces are preserved.
 */
object LabelNames {
    fun applyChanges(current: List<String>, added: Set<String>, removed: Set<String>): List<String> =
        (current.filterNot { label -> removed.any { it.equals(label, true) } } + added)
            .distinctBy { it.lowercase() }

    fun matchesSelection(tags: List<String>, selectedTags: Set<String>): Boolean =
        selectedTags.isEmpty() || tags.any { tag -> selectedTags.any { it.equals(tag, true) } }

    /**
     * Normalize a raw label for storage. Returns null if the result violates
     * Obsidian tag rules.
     */
    fun normalized(input: String): String? {
        val trimmed = input.trim()
        return if (validate(trimmed)) trimmed else null
    }

    /**
     * Reject empty names and control characters, which cannot be safe one-line names.
     */
    fun validate(label: String): Boolean {
        return label.isNotBlank() && label.none { it.isISOControl() }
    }
}

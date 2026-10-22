package com.diexar.keepcapture

fun main() {
    fun tags(body: String, known: List<String> = emptyList()) = InlineTags.find(body, known)
    check(tags("#idea and #project/alpha\n#2026-plan") == listOf("idea", "project/alpha", "2026-plan"))
    check(tags("Café #réunion #日本") == listOf("réunion", "日本"))
    // Not tags in Obsidian: escaped shared text, headings, numbers only, anchors, mid-word and code.
    check(tags("\\#fyp # Heading ## Sub #123 page#anchor [[Note#Part]] https://x.y/#top") == emptyList<String>())
    check(tags("`#inline` and\n```\n#fenced\n```\n~~~\n#tilde\n~~~\nafter #real") == listOf("real"))
    // Case-insensitive duplicates and tags already in frontmatter are listed once.
    check(tags("#Work #work #home", known = listOf("HOME")) == listOf("Work"))
    println("Inline tag checks passed")
}

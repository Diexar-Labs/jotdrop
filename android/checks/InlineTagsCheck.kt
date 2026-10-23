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

    // Shared text is neutralized by the same rules as the plugin (scripts/check-hashtags.cjs).
    fun neutral(text: String) = InlineTags.neutralize(text)
    check(neutral("Trending #fyp") == "Trending \\#fyp")
    check(neutral("#émigré #2024plan #ok issue #16 (#x) a#b \\#done") == "\\#émigré \\#2024plan \\#ok issue #16 (\\#x) a#b \\#done")
    check(neutral("# Title\n## Sub") == "# Title\n## Sub")
    check(neutral("https://x.com/a?b=#frag [s](#heading) [[Note#Part]] [[#Part]] `#c`") == "https://x.com/a?b=#frag [s](#heading) [[Note#Part]] [[#Part]] `#c`")
    check(neutral("````\n```\n#in\n```\n````\n#out") == "````\n```\n#in\n```\n````\n\\#out")
    check(neutral("~~~\n#in\n~~~ #out") == "~~~\n#in\n~~~ \\#out")
    check(neutral("Emoji #🎉party") == "Emoji \\#🎉party")
    println("Inline tag checks passed")

    // Cards show plain text, like the plugin (scripts/check-list-preview.cjs).
    val marked = listOf(
        "**Bold** and *italic* and _under_ and __strong__ and ~~gone~~ and ==mark==",
        "**Note:** use `npm run build` and ***both***",
        "snake_case_name and 2 * 3 * 4 and a == b stay",
        "\\# not a heading, \\*star\\*, \\<tag\\>, 1986\\.",
        "> quoted **text**",
        "> [!note] Callout title",
        "> - [ ] **quoted** task",
        "---",
        "* * *",
        "| Name | Qty |",
        "| --- | :-: |",
        "| Milk | 2 \\| 3 |",
        "```js",
        "const x = **y**;",
        "```",
        "- [ ] **buy** milk",
        "* bullet *emph*",
        "line<br>break",
        "[[Wiki|alias]] and [label](https://x.y)",
    ).joinToString("\n")
    val plain = listOf(
        "Bold and italic and under and strong and gone and mark",
        "Note: use npm run build and both",
        "snake_case_name and 2 * 3 * 4 and a == b stay",
        "# not a heading, *star*, <tag>, 1986.",
        "quoted text",
        "Callout title",
        "> - [ ] quoted task",
        "Name · Qty",
        "Milk · 2 | 3",
        "const x = **y**;",
        "- [ ] buy milk",
        "* bullet emph",
        "line break",
        "[[Wiki|alias]] and [label](https://x.y)",
    ).joinToString("\n")
    val actual = CardText.plain(marked)
    check(actual == plain) { "plain card text mismatch:\n$actual" }
    println("Card text checks passed")
}

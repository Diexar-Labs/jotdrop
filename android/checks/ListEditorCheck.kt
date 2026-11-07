package com.diexar.keepcapture

fun main() {
    fun enter(text: String, expected: String, start: Int = text.length, end: Int = start) {
        val edit = checkNotNull(listEnterEdit(text, start, end)) { "Expected a list edit: $text" }
        check(text.replaceRange(edit.from, edit.to, edit.insert) == expected) { "Wrong list edit: $text" }
    }
    enter("- alpha", "- alpha\n- ")
    enter("* alpha", "* alpha\n- ")
    enter("  - [x] alpha", "  - [x] alpha\n  - [ ] ")
    enter("\t* alpha", "\t* alpha\n\t- ")
    enter("- [X] alpha", "- [X] alpha\n- [ ] ")
    enter("- ", "")
    enter("  - [ ] ", "")
    enter("- [x]", "")
    enter("- alpha\n  * \nnext", "- alpha\n\nnext", 12)
    enter("- alpha beta", "- alpha\n-  beta", 7)
    enter("- [x] alpha beta", "- [x] alpha\n- [ ]  beta", 11)
    enter("- alpha beta", "- al\n- beta", 4, 8)
    enter("- alpha\n- beta", "- alpha\n- \n- beta", 7)
    enter("```\n- code\n```\n- note", "```\n- code\n```\n- note\n- ")
    for (text in listOf("plain", "-no list", "---", "*em*", "```\n- code", "~~~text\n- code", "````\n```\n- code")) {
        check(listEnterEdit(text, text.length) == null) { "Unexpected list edit: $text" }
    }
    check(listEnterEdit("- alpha", 1) == null)
    check(listEnterEdit("- alpha\n- beta", 4, 12) == null)
    // Keyboard swaps the typed word in the same update as Enter (autocorrect, a suggestion).
    fun changed(current: String, next: String, cursor: Int, expected: String?, expectedCursor: Int = -1) {
        val result = listEnterAfterChange(current, next, cursor)
        check(result?.first == expected) { "Wrong change edit: $current -> $next gave $result" }
        if (expected != null && expectedCursor >= 0) check(result?.second == expectedCursor) { "Wrong cursor: $next" }
    }
    changed("- [ ] mlk", "- [ ] milk\n", 11, "- [ ] milk\n- [ ] ", 17)
    changed("- [ ] milk\n- [ ] bred", "- [ ] milk\n- [ ] bread\n", 23, "- [ ] milk\n- [ ] bread\n- [ ] ")
    changed("- [ ] mlk\n- [ ] eggs", "- [ ] milk\n\n- [ ] eggs", 11, "- [ ] milk\n- [ ] \n- [ ] eggs", 17)
    changed("  - [x] teh", "  - [x] the \n", 13, "  - [x] the \n  - [ ] ")
    changed("- alpha", "- alpha\n", 8, "- alpha\n- ")
    changed("- [ ] ", "- [ ] \n", 7, "")
    changed("plain", "plains\n", 7, null)
    changed("- a\nb", "- a\n", 4, null)
    changed("- a\n- b", "- x\n- b\n", 8, null)
    changed("- [ ] mlk", "- [ ] milk\nmore\n", 16, null)
    changed("- [ ] milk", "- [ ] milk", 10, null)
    changed("```\n- mlk", "```\n- milk\n", 11, null)
    // The field still edits the text from before the list edit (seen on the emulator, 5 Nov):
    // Enter, an echo of the old text, then "jam" typed fast, all on the old text.
    run {
        var now = 0L
        val stale = StaleField { now }
        var shown = "- [ ] eggs"
        fun type(field: String, cursor: Int = field.length): Int {
            val replayed = stale.replay(shown, field)
            val next = replayed?.text ?: field
            val nextCursor = replayed?.map?.invoke(cursor) ?: cursor
            val edit = if (next == shown + "\n") listEnterEdit(shown, shown.length) else null
            val result = if (edit == null) next else shown.replaceRange(edit.from, edit.to, edit.insert)
            val resultCursor = if (edit == null) nextCursor else edit.from + edit.insert.length
            stale.settle(field, result)
            shown = result
            return resultCursor
        }
        type("- [ ] eggs\n")
        check(shown == "- [ ] eggs\n- [ ] ") { "Enter: $shown" }
        type("- [ ] eggs\n")
        check(shown == "- [ ] eggs\n- [ ] ") { "Echo: $shown" }
        type("- [ ] eggs\nj")
        type("- [ ] eggs\nja")
        val cursor = type("- [ ] eggs\njam")
        check(shown == "- [ ] eggs\n- [ ] jam" && cursor == shown.length) { "Fast typing: $shown at $cursor" }
        // Enter again on the old text: the list goes on.
        type("- [ ] eggs\njam\n")
        check(shown == "- [ ] eggs\n- [ ] jam\n- [ ] ") { "Enter on old text: $shown" }
        // The field caught up: changes on the shown text are taken as they are.
        type("- [ ] eggs\n- [ ] jam\n- [ ] t")
        check(shown == "- [ ] eggs\n- [ ] jam\n- [ ] t") { "Caught up: $shown" }
        type("- [ ] eggs\n- [ ] jam\n- [ ] ")
        check(shown == "- [ ] eggs\n- [ ] jam\n- [ ] ") { "Backspace: $shown" }
        // An empty item ends the list; a fast letter after that stays without a marker.
        type("- [ ] eggs\n- [ ] jam\n- [ ] \n")
        check(shown == "- [ ] eggs\n- [ ] jam\n") { "End list: $shown" }
        type("- [ ] eggs\n- [ ] jam\n- [ ] \nx")
        check(shown == "- [ ] eggs\n- [ ] jam\nx") { "After end: $shown" }
        // After a while the old text is forgotten.
        stale.settle("old", "new")
        now += 2000
        check(stale.replay("new", "oldx") == null)
    }
    check(replayStale("- a\n", "- a\n- ", "x- a\n")?.text == "x- a\n- ") { "Change before ours" }
    check(replayStale("- a\n", "- a\n- ", "- a\n- ") == null) { "Built on shown text" }
    val source = "- alpha\n  * beta\n- [x] task\n```\n- code\n```\n+ gamma"
    val rendered = renderListBullets(source)
    check(rendered == "\u2022 alpha\n  \u2022 beta\n- [x] task\n```\n- code\n```\n\u2022 gamma")
    check(source.length == rendered.length) { "Visual transformation must preserve every source offset" }
    check(toggleChecklistText("- [ ] milk\n- [x] eggs", 0) == "- [x] milk\n- [x] eggs")
    check(toggleChecklistText("- [ ] milk\n- [x] eggs", 1) == "- [ ] milk\n- [ ] eggs")
    check(toggleChecklistText("- [ ] milk", 1) == null)
    check(toggleChecklistText("- [ ] milk", -1) == null)
    val pending = "<!-- jotdrop-preview: pending -->"
    check(keepTextAfterMarker("# u\n\n$pending\n\n- [x] a\n- [ ] b\n", pending, "# T\n\n[T](u)") == "# T\n\n[T](u)\n\n- [x] a\n- [ ] b")
    check(keepTextAfterMarker("# u\n\n$pending", pending, "# T") == "# T")
    check(keepTextAfterMarker("# u", pending, "# T") == "# T")
    println("Android list editor checks passed")
}

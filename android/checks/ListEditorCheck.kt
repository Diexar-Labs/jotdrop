package com.diexar.keepcapture

fun main() {
    check(sameChecklistPreview("- [ ] first\n- [x] second", "- [x] first\n- [ ] second"))
    check(!sameChecklistPreview("- [ ] first\n- [ ] second", "- [ ] inserted\n- [ ] first\n- [ ] second"))
    for (count in listOf(0, 1, 5, 6, 10, 11, 100)) {
        val text = (1..count).joinToString("\n") { "- [ ] task $it" }
        val rows = previewTaskRows(text)
        check(rows.count { it.checklistIndex != null } == count)
        check(rows.filter { it.checklistIndex != null }.take(5).map { it.checklistIndex } == (0 until minOf(5, count)).toList())
        if (count >= 10) check(toggleChecklistText(text, rows[9].checklistIndex!!)!!.lines()[9] == "- [x] task 10")
    }
    check(previewTaskRows("Intro\n> - [ ] quote\n* [ ] bullet\n- [x] real").last().checklistIndex == 0)
    // Card rows carry their list level (design kaarten-en-lijsten, part 7): -1 is no list line.
    check(previewTaskRows("- a\n\t- [ ] b\n\t\t- c\n    - d\ntext").map { it.level } == listOf(0, 1, 2, 1, -1))
    // A tick from the card or the widget: the Nth task as before, through the core, moved only with the setting (part 6).
    check(tickChecklistText("- [ ] a\n- [ ] b", 0, false) == "- [x] a\n- [ ] b")
    check(tickChecklistText("- [ ] a\n- [ ] b", 0, true) == "- [ ] b\n- [x] a")
    check(tickChecklistText("- [x] a\n- [x] b", 1, true) == "- [ ] b\n- [x] a")
    check(tickChecklistText("- [ ] a\r\n- [ ] b", 0, true) == "- [ ] b\r\n- [x] a")
    check(tickChecklistText("- [ ] a\ntext\n- [ ] b", 0, true) == "- [x] a\ntext\n- [ ] b")
    // The tasks under it go along, and an untick takes the ticked task above it along (design checklists-77-v2, part 7).
    check(tickChecklistText("- [ ] a\n\t- [ ] sub\n- [ ] b", 0, true) == "- [ ] b\n- [x] a\n\t- [x] sub")
    check(tickChecklistText("- [ ] a\n\t- [ ] sub\n- [ ] b", 0, false) == "- [x] a\n\t- [x] sub\n- [ ] b")
    check(tickChecklistText("- [x] a\n\t- [x] sub\n\t- [x] other", 1, false) == "- [ ] a\n\t- [ ] sub\n\t- [x] other")
    // A task the card counts but the core does not (in a code block) still ticks, without moving.
    check(tickChecklistText("```\n- [ ] code\n```\n- [ ] a\n- [ ] b", 0, true) == "```\n- [x] code\n```\n- [ ] a\n- [ ] b")
    check(tickChecklistText("- [ ] a", 1, true) == null)
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
    // An empty item in a level goes one level back first (design kaarten-en-lijsten, part 7), as in check-list-editor.cjs.
    enter("- alpha\n  * \nnext", "- alpha\n* \nnext", 12)
    enter("- alpha beta", "- alpha\n-  beta", 7)
    enter("- [x] alpha beta", "- [x] alpha\n- [ ]  beta", 11)
    enter("- alpha beta", "- al\n- beta", 4, 8)
    enter("- alpha\n- beta", "- alpha\n- \n- beta", 7)
    enter("```\n- code\n```\n- note", "```\n- code\n```\n- note\n- ")
    for (text in listOf("plain", "-no list", "---", "*em*", "```\n- code", "~~~text\n- code", "````\n```\n- code")) {
        check(listEnterEdit(text, text.length) == null) { "Unexpected list edit: $text" }
    }
    check(listEnterEdit("- alpha", 1) == null)
    // The caret: right behind what Enter put in, and behind the marker of an empty item that went a level back.
    check(listEnterEdit("- alpha", 7)?.caret == 10) { "Caret after Enter" }
    check(listEnterEdit("- alpha\n\t- [ ] ", 15)?.caret == 14) { "Caret after an empty task went a level back: ${listEnterEdit("- alpha\n\t- [ ] ", 15)}" }
    check(listEnterEdit("- alpha\n  * \nnext", 12)?.caret == 10) { "Caret after an empty bullet went a level back" }
    check(listEnterEdit("- alpha\n- ", 10)?.caret == 8) { "Caret after an empty item on level 0 left the list" }
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
    changed("- a\n\t- [ ] ", "- a\n\t- [ ] \n", 12, "- a\n- [ ] ", 10)
    changed("plain", "plains\n", 7, null)
    changed("- a\nb", "- a\n", 4, null)
    changed("- a\n- b", "- x\n- b\n", 8, null)
    changed("- [ ] mlk", "- [ ] milk\nmore\n", 16, null)
    changed("- [ ] milk", "- [ ] milk", 10, null)
    changed("```\n- mlk", "```\n- milk\n", 11, null)
    // The first letter typed in a list item becomes a capital; nothing else is touched (issue #44, point 9).
    fun capital(current: String, next: String, expected: String?) {
        val result = capitalizeListItemStart(current, next)
        check(result == expected) { "Wrong capital: $current -> $next gave $result" }
    }
    capital("- ", "- a", "- A")
    capital("* ", "* a", "* A")
    capital("- [ ] ", "- [ ] b", "- [ ] B")
    capital("- [x] ", "- [x] b", "- [x] B")
    capital("  - ", "  - m", "  - M")
    capital("\t* ", "\t* m", "\t* M")
    capital("1. ", "1. t", "1. T")
    capital("2) ", "2) t", "2) T")
    capital("Intro\n- ", "Intro\n- k", "Intro\n- K")
    capital("- one\n- ", "- one\n- k", "- one\n- K")
    capital("- ", "- é", "- É")
    capital("```\nx\n```\n- ", "```\nx\n```\n- d", "```\nx\n```\n- D")
    capital("- ", "- ß", null)
    capital("- ", "- 1", null)
    capital("- ", "- #", null)
    capital("- ", "- A", null)
    capital("- a", "- ab", null)
    capital("- hello", "- hello world", null)
    capital("- ", "- ab", null)
    capital("- ", "- ", null)
    capital("- abc", "- bc", null)
    capital("plain ", "plain t", null)
    capital("", "t", null)
    capital("- [ ", "- [ x", null)
    capital("```\n- ", "```\n- c", null)
    capital("~~~\ntext\n- ", "~~~\ntext\n- c", null)
    capital("> - ", "> - q", null)
    capital("# ", "# h", null)
    // Backspace next to the sign of a list item, as a keyboard sends it (design checklists-77-v3, 4.3 and 4.4): the
    // characters it took in front of the caret, one or a whole word at once.
    run {
        val list = "- [ ] Milk\n- [ ] Bread"
        fun back(text: String, caret: Int, removed: Int = 1, hidden: List<IntRange> = emptyList()) =
            signBackspace(text, caret, removed, hidden)?.let { Triple(it.text, it.caret, it.joined) }
        // Right behind the sign the item joins the line above it, and an empty one is gone: one step, never half a sign.
        check(back(list, 17) == Triple("- [ ] MilkBread", 10, true)) { "A task joins the task above it: ${back(list, 17)}" }
        check(back("- [ ] Milk\n- [ ] ", 17) == Triple("- [ ] Milk", 10, true)) { "An empty task is gone: ${back("- [ ] Milk\n- [ ] ", 17)}" }
        check(back("1. a\n2. b", 8) == Triple("1. ab", 4, true) && back("- a\n- b", 6) == Triple("- ab", 3, true)) { "A numbered line and a bullet join too" }
        check(back("# List\n- [ ] Bread", 13) == Triple("# List\nBread", 7, true)) { "The first line of a list only loses its sign: ${back("# List\n- [ ] Bread", 13)}" }
        // However many characters the keyboard wanted there.
        check(back(list, 17, 6) == Triple("- [ ] MilkBread", 10, true) && back(list, 17, 17) == Triple("- [ ] MilkBread", 10, true)) { "A whole word taken at the sign joins as well" }
        // The caret in the sign, with the signs the formatted view hides: between the box and its space, in front of the box.
        val hidden = listOf(11 until 13, 14 until 16)
        check(back(list, 16, 1, hidden) == Triple("- [ ] MilkBread", 10, true) && back(list, 11, 1, hidden) == Triple("- [ ] MilkBread", 10, true)) { "The caret in the sign: ${back(list, 16, 1, hidden)}" }
        // Bold words right behind the box: the caret stands behind their hidden signs, which stay in front of it.
        val bold = "- [ ] Milk\n- [ ] **Bread**"
        check(back(bold, 19, 1, hidden + listOf(17 until 19, 24 until 26)) == Triple("- [ ] Milk**Bread**", 12, true)) { "Hidden signs behind the box: ${back(bold, 19, 1, hidden + listOf(17 until 19, 24 until 26))}" }
        check(back(bold, 19, 1) == null) { "Signs that are not hidden are words: the caret is not behind the box" }
        // Further in the item: a letter or the word itself is the keyboard's own, more than that stops in front of the sign.
        check(back(list, 22) == null && back(list, 22, 5) == null && back(list, 19, 2) == null) { "Letters and a word are the keyboard's own" }
        check(back(list, 22, 6) == Triple("- [ ] Milk\n- [ ] ", 17, false)) { "A word and more stops in front of the sign: ${back(list, 22, 6)}" }
        check(back(list, 22, 20) == Triple("- [ ] Milk\n- [ ] ", 17, false)) { "Also when it would reach into the line above: ${back(list, 22, 20)}" }
        check(back(list, 19, 3) == Triple("- [ ] Milk\n- [ ] ead", 17, false) && back("- a\n- bc", 8, 4) == Triple("- a\n- ", 6, false)) { "From the middle of a word, and in a bullet" }
        // Holding Backspace: the words go, then the item joins, then the line above goes on.
        var held = SignBackspace(list, 22, false)
        val seen = mutableListOf<String>()
        while (held.caret > 0) {
            held = signBackspace(held.text, held.caret, 1, emptyList()) ?: SignBackspace(held.text.removeRange(held.caret - 1, held.caret), held.caret - 1, false)
            seen += held.text
        }
        check(seen.take(7) == listOf("- [ ] Milk\n- [ ] Brea", "- [ ] Milk\n- [ ] Bre", "- [ ] Milk\n- [ ] Br", "- [ ] Milk\n- [ ] B", "- [ ] Milk\n- [ ] ", "- [ ] Milk", "- [ ] Mil")) { "Holding Backspace: ${seen.take(7)}" }
        check(seen.last() == "" && seen.none { it.endsWith("- [ ]") || it.endsWith("- [") || it.endsWith("-") || it.endsWith("- ") && it != "- " }) { "No half sign on the way: $seen" }
        // Not a list: plain text, a quote, a code block.
        check(back("one\ntwo", 4) == null && back("one\ntwo", 7, 5) == null && back("> - [ ] a\n> - [ ] b", 18) == null && back("```\n- [ ] a\n- [ ] bc\n```", 20, 4) == null) { "Outside a list Backspace is the keyboard's own" }
    }
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
    // Backspace held down on a busy phone (design checklists-77-v3, 4.4): the item joined the line above it, and the
    // field, which still has the item's sign, goes on taking that sign away. Each such Backspace is one in the line the
    // caret is in now; taken as it came it would put the item back with half a sign.
    run {
        var now = 0L
        val stale = StaleField { now }
        var shown = "- [ ] Milk\n- [ ] Bread"
        var caret = 17
        // What the editor makes of a change of the field, as the body's pipeline does it.
        fun field(text: String, cursor: Int) {
            val replayed = stale.replay(shown, text, caret, cursor)
            val next = replayed?.text ?: text
            val nextCaret = replayed?.map?.invoke(cursor) ?: cursor
            val removed = caret - nextCaret
            val back = if (removed >= 1 && next == shown.removeRange(caret - removed, caret)) signBackspace(shown, caret, removed, emptyList()) else null
            stale.settle(text, back?.text ?: next)
            shown = back?.text ?: next
            caret = back?.caret ?: nextCaret
        }
        field("- [ ] Milk\n- [ ]Bread", 16)
        check(shown == "- [ ] MilkBread" && caret == 10) { "Backspace behind the box: $shown at $caret" }
        field("- [ ] Milk\n- [ Bread", 15)
        check(shown == "- [ ] MilBread" && caret == 9) { "The next one on the old text takes a letter of the line above: $shown at $caret" }
        field("- [ ] Milk\n- [Bread", 14)
        field("- [ ] Milk\n-Bread", 12)
        check(shown == "- [ ] Bread" && caret == 6) { "On and on, also two at once: $shown at $caret" }
        // The caret is behind the sign of the first line now: that sign goes whole, and then there is nothing to take.
        field("- [ ] Milk\nBread", 11)
        check(shown == "Bread" && caret == 0) { "The first line loses its whole sign: $shown at $caret" }
        field("- [ ] MilkBread", 10)
        check(shown == "Bread" && caret == 0) { "At the start of the note nothing goes: $shown at $caret" }
        // The field caught up: a change on the shown text is taken as it is.
        field("xBread", 1)
        check(shown == "xBread" && caret == 1) { "Caught up: $shown at $caret" }
        // A letter typed fast after the join lands where the caret is.
        shown = "- [ ] Milk\n- [ ] Bread"
        caret = 17
        stale.settle(shown, shown)
        field("- [ ] Milk\n- [ ]Bread", 16)
        field("- [ ] Milk\n- [ ]xBread", 17)
        check(shown == "- [ ] MilkxBread" && caret == 11) { "A letter typed on the old text: $shown at $caret" }
        // Only a Backspace is replayed that way: another change in the part that was replaced is not.
        check(replayStale("- [ ] Milk\n- [ ]Bread", "- [ ] MilkBread", "- [ ] Milk\n- [x]Bread", 10, 15) == null) { "A replacement in the part that went" }
        check(replayStale("- [ ] Milk\n- [ ]Bread", "- [ ] MilkBread", "- [ ] Milk\n- [ Bread") == null) { "Without the carets nothing is replayed there" }
        // Shorter than the old text, but not that text without what stood in front of the caret: a letter over a selection.
        check(replayStale("- [ ] Milk\n- [ ]Bread", "- [ ] MilkBread", "- [ ] Milk\n- [xBread", 10, 15) == null) { "A letter over two characters of the part that went" }
        check(replayStale("- [ ] Milk\n- [ ]Bread", "- [ ] MilkBread", "- [ ] Milk\n- [ Bread", 10, 11) == null) { "A character that went somewhere else than in front of the caret" }
        // The field's caret is known, but the text on screen has a selection: there is no place to take a character from.
        check(replayStale("- [ ] Milk\n- [ ]Bread", "- [ ] MilkBread", "- [ ] Milk\n- [ Bread", -1, 15) == null) { "A selection in the text on screen" }
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
    // Lists in levels in the open note (design checklists-77, parts 5 and 6.3): where each line of a list stands. A row
    // reads kind:level:item:shifted:marker.
    run {
        fun rows(text: String) = listRows(text).map { row -> row?.let { "${it.kind}:${it.level}:${it.item}:${if (it.shifted) 1 else 0}:${it.marker}" } }
        check(listRows("plain\n\n# Head\n```\n- [ ] code\n```").isEmpty()) { "A text without a list has no rows" }
        // A list with a task stands to the right as a whole, bullets and numbers in it too.
        check(rows("- [ ] a\n\t- [x] b\n- c\n1. d") == listOf("task:0:0:1:☐ ", "task:1:1:1:☑ ", "bullet:0:2:1:• ", "ordered:0:3:1:1. ")) { "Mixed list: ${rows("- [ ] a\n\t- [x] b\n- c\n1. d")}" }
        // A list without a task stays where it was; each list decides for itself.
        check(rows("- a\n  - b\n\n- [ ] c") == listOf("bullet:0:0:0:• ", "bullet:1:1:0:• ", null, "task:0:3:1:☐ ")) { "Two lists: ${rows("- a\n  - b\n\n- [ ] c")}" }
        // More text under an item belongs to that item and stands on its level.
        check(rows("- [ ] a\n  more\n\t- b\n\t  deeper\ntext") == listOf("task:0:0:1:☐ ", "more:0:0:1:", "bullet:1:2:1:• ", "more:1:2:1:", null)) { "More text: ${rows("- [ ] a\n  more\n\t- b\n\t  deeper\ntext")}" }
        // The marker is what stands in front of the words, with the spaces as written; a box without words ends the line.
        check(rows("- [ ]  two\n- [x]\n10) ten\n*   wide").map { it!!.substringAfterLast(':') } == listOf("☐  ", "☑", "10) ", "•   ")) { "Markers: ${rows("- [ ]  two\n- [x]\n10) ten\n*   wide")}" }
        check(rows("- [ ] a\r\n- [x]\r\n\t- b\r") == listOf("task:0:0:1:☐ ", "task:0:1:1:☑", "bullet:1:2:1:• ")) { "CRLF: ${rows("- [ ] a\r\n- [x]\r\n\t- b\r")}" }
        // Eight levels are drawn apart; a deeper item stands at the eighth.
        val deep = (0..10).joinToString("\n") { "\t".repeat(it) + "- [ ] level $it" }
        check(listRows(deep).map { it!!.level } == listOf(0, 1, 2, 3, 4, 5, 6, 7, 7, 7, 7)) { "Deep list: ${listRows(deep).map { it!!.level }}" }
        check(LIST_LEVELS_DRAWN == 8 && LEVEL_STEP == 24f && TASK_SHIFT == 20f) { "The sizes of the design" }
        // The one reading the rows use gives what the two functions of the shared core give.
        for (text in listOf(deep, "- [ ] a\n  more\n\t- b\n\t  deeper\ntext", "plain", "- a\r\n\r\n1. b\r\n   c", "")) {
            check(FormatCore.listLevelsAndItems(text) == (FormatCore.listLevels(text) to FormatCore.listItems(text))) { "Levels and items in one reading: $text" }
        }
    }
    // Where a dragged item lands (design checklists-77, 6.1): the place nearest to the finger, the item's own lines as
    // its own place, and the level it has plus the steps the finger went sideways, within what the place takes.
    run {
        // Every line is 10 high: line n runs from 10 n to 10 n + 10.
        val top = { line: Int -> line * 10f }
        val bottom = { line: Int -> line * 10f + 10f }
        val flat = "- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d"
        fun land(text: String, line: Int, y: Float, steps: Int = 0): DropTarget? {
            val span = FormatCore.itemSpan(text, line)!!
            return dropTarget(FormatCore.dropSlots(text, line), line, span.end, FormatCore.listLevels(text)[line], text.split('\n').size, y, steps, top, bottom)
        }
        // A finger on the item itself moves nothing, wherever on it.
        for (y in listOf(10f, 15f, 19.9f)) check(land(flat, 1, y) == DropTarget(1, 0)) { "A finger on the item: ${land(flat, 1, y)}" }
        // Less than half a line above it: still its own place. Past the middle of the line above: in front of that line.
        check(land(flat, 1, 5.1f) == DropTarget(1, 0)) { "Just above the item: ${land(flat, 1, 5.1f)}" }
        check(land(flat, 1, 4.9f) == DropTarget(0, 0)) { "Past the middle of the line above: ${land(flat, 1, 4.9f)}" }
        // Past the middle of the line under it: behind that line, which is in front of the line after it.
        check(land(flat, 1, 24.9f) == DropTarget(1, 0)) { "Just under the item: ${land(flat, 1, 24.9f)}" }
        check(land(flat, 1, 25.1f) == DropTarget(3, 0)) { "Past the middle of the line under it: ${land(flat, 1, 25.1f)}" }
        // Far under the text: after the last line.
        check(land(flat, 1, 500f) == DropTarget(4, 0)) { "Under the text: ${land(flat, 1, 500f)}" }
        check(land(flat, 1, -500f) == DropTarget(0, 0)) { "Above the text: ${land(flat, 1, -500f)}" }
        // Sideways: one step in makes it a sub-item of the item above, where the place takes that; never further than it takes.
        check(land(flat, 1, 15f, 1) == DropTarget(1, 1)) { "A step in on its own place: ${land(flat, 1, 15f, 1)}" }
        check(land(flat, 1, 15f, 5) == DropTarget(1, 1)) { "Five steps in: ${land(flat, 1, 15f, 5)}" }
        check(land(flat, 1, 15f, -3) == DropTarget(1, 0)) { "Steps out on level 0: ${land(flat, 1, 15f, -3)}" }
        check(land(flat, 0, 5f, 2) == DropTarget(0, 0)) { "The first item cannot go in: ${land(flat, 0, 5f, 2)}" }
        // A sub-item keeps its level where the place takes it, and goes out with a step to the left.
        val nested = "- [ ] a\n\t- [ ] a1\n\t- [ ] a2\n- [ ] b"
        check(land(nested, 2, 12f) == DropTarget(1, 1)) { "A sub-item among sub-items: ${land(nested, 2, 12f)}" }
        check(land(nested, 2, 25f, -1) == DropTarget(2, 0)) { "A sub-item a step out on its own place: ${land(nested, 2, 25f, -1)}" }
        check(land(nested, 2, 2f) == DropTarget(0, 0)) { "A sub-item above the first item becomes a main item: ${land(nested, 2, 2f)}" }
        // An item with sub-items: all of its lines are its own place, and no place lies in them.
        check(land(nested, 0, 25f) == DropTarget(0, 0)) { "A finger on the sub-items of the item on its way: ${land(nested, 0, 25f)}" }
        check(land(nested, 0, 39f) == DropTarget(4, 0)) { "An item with sub-items past the last line: ${land(nested, 0, 39f)}" }
        // A deep item where only levels 0 and 1 fit: it lands on 1, and one step out is level 0, not three steps.
        val deep = "- [ ] a\n\t- [ ] b\n\t\t- [ ] c\n\t\t\t- [ ] d\n- [ ] e"
        check(land(deep, 3, 48f) == DropTarget(5, 1)) { "A deep item after the last one: ${land(deep, 3, 48f)}" }
        check(land(deep, 3, 48f, -1) == DropTarget(5, 0)) { "A deep item after the last one, a step out: ${land(deep, 3, 48f, -1)}" }
        check(land(deep, 3, 48f, 1) == DropTarget(5, 1)) { "A deep item after the last one, a step in: ${land(deep, 3, 48f, 1)}" }
        // A main item between a main item and its sub-item can only be a sub-item there.
        check(land(nested, 3, 11f) == DropTarget(1, 1)) { "Between an item and its sub-item: ${land(nested, 3, 11f)}" }
        // Two lists with text between them: an item goes to the other list, never into the text.
        val two = "- [ ] a\n- [ ] b\n\ntext\n\n- [ ] c"
        check(land(two, 0, 34f) == DropTarget(2, 0)) { "In the text between two lists, nearer to the first: ${land(two, 0, 34f)}" }
        check(land(two, 0, 41f) == DropTarget(5, 0)) { "In the text between two lists, nearer to the second: ${land(two, 0, 41f)}" }
        check(dropTarget(emptyList(), 0, 0, 0, 1, 5f, 0, top, bottom) == null) { "No place, no landing" }
    }
    // The room lines make for an item that is dragged (design checklists-77-v2, 5.1 and 5.2): the lines between its own
    // place and where it would land go a block further in SLIDE_MS, and when the finger lets go every line is found
    // again on the line it has after the drop.
    run {
        // Six lines of 10 high; the item is line 2 alone.
        val top = { line: Int -> line * 10f }
        val room = RoomMade(2, 2, 6, 10f)
        // In hundredths of a pixel: the time of a frame is no round number.
        fun near(a: Float, b: Float) = kotlin.math.abs(a - b) < 0.01f
        fun shifts() = (0 until 6).map { Math.round(room.of(it) * 100f) / 100f }
        check(!room.slide(null, 1f) && shifts().all { it == 0f } && room.from > room.until) { "No place, no room made: ${shifts()}" }
        check(!room.slide(2, 1f) && shifts().all { it == 0f }) { "Its own place makes no room: ${shifts()}" }
        // In front of line 0: lines 0 and 1 go a block down, half of the way in half the time, and never further.
        check(room.slide(0, SLIDE_MS / 2000f) && shifts() == listOf(5f, 5f, 0f, 0f, 0f, 0f)) { "Half the way down: ${shifts()}" }
        check(room.from == 0 && room.until == 1) { "The lines that are away: ${room.from} to ${room.until}" }
        check(room.slide(0, 1f) && shifts() == listOf(10f, 10f, 0f, 0f, 0f, 0f) && !room.slide(0, 1f)) { "All the way down: ${shifts()}" }
        // On to behind line 4: lines 0 and 1 go back while lines 3 and 4 come up.
        check(room.slide(5, SLIDE_MS / 4000f) && shifts() == listOf(7.5f, 7.5f, 0f, -2.5f, -2.5f, 0f)) { "Turning round: ${shifts()}" }
        check(room.from == 0 && room.until == 4) { "Both sides are away: ${room.from} to ${room.until}" }
        check(room.slide(5, 1f) && shifts() == listOf(0f, 0f, 0f, -10f, -10f, 0f) && room.from == 3 && room.until == 4) { "All the way up: ${shifts()}" }
        check(room.slide(6, 1f) && shifts() == listOf(0f, 0f, 0f, -10f, -10f, -10f)) { "After the text: ${shifts()}" }
        check(room.slide(null, 1f) && shifts().all { it == 0f } && room.from > room.until && !room.slide(null, 1f)) { "Back again: ${shifts()}" }
        // Let go while lines further on are still on their way back (the finger came back from the end of the list): those
        // keep their own number, and have the rest of their way to go.
        val late = RoomMade(0, 0, 4, 10f)
        late.slide(4, 1f)
        late.slide(2, SLIDE_MS / 2000f)
        val left = late.settling(2, top, 12f)
        left.resolve(top)
        check(left.line == 1 && left.end == 1 && (0..3).map { Math.round(left.of(it, 1f) * 100f) / 100f } == listOf(0f, 0f, -5f, -5f) && near(left.ofItem(1f), 2f)) { "Let go while lines go back: item on ${left.line}, ${(0..3).map { left.of(it, 1f) }}" }

        // Every item of a note to every place it has: once the lines have made all their room, the note as it is drawn
        // has the order FormatCore.dropItemEdit gives it, so nothing jumps when the text changes.
        val note = "- [ ] a\n\t- [ ] a1\n\t- [ ] a2\n- [ ] b\n\ntext\n\n- [ ] c\n\t- [ ] c1\n- [ ] d\n- [ ] d"
        val lines = note.split('\n')
        var tried = 0
        for (line in lines.indices) for (slot in FormatCore.dropSlots(note, line)) for (level in slot.minLevel..slot.maxLevel) {
            val name = "line $line in front of ${slot.before} on level $level"
            val end = FormatCore.itemSpan(note, line)!!.end
            val moved = FormatCore.dropItemEdit(note, line, slot.before, level) ?: continue
            val after = note.replaceRange(moved.edit.from, moved.edit.to, moved.edit.insert).split('\n')
            val made = RoomMade(line, end, lines.size, (end - line + 1) * 10f)
            made.slide(slot.before, 1f)
            val order = IntArray(lines.size) { -1 }
            for (index in lines.indices) {
                val now = if (index in line..end) moved.line + index - line else index + (made.of(index) / 10f).toInt()
                check(now in lines.indices && order[now] < 0) { "$name: two lines on one place" }
                order[now] = index
            }
            check(order.map { lines[it].trim() } == after.map { it.trim() }) { "$name: drawn ${order.map { lines[it].trim() }}, the text has ${after.map { it.trim() }}" }
            // Let go there: the item is on its new lines and every line stands where the new text has it.
            val there = made.settling(slot.before, top, 123f)
            there.resolve(top)
            check(there.line == moved.line && there.end == moved.line + end - line) { "$name: the item's lines after the drop: ${there.line} to ${there.end}" }
            check(lines.indices.all { there.of(it, 1f) == 0f }) { "$name: a line is off its place: ${lines.indices.map { there.of(it, 1f) }}" }
            check(near(there.ofItem(1f), 123f - top(moved.line)) && near(there.ofItem(0.5f), there.ofItem(1f) / 2) && there.ofItem(0f) == 0f) { "$name: the item's way: ${there.ofItem(1f)}" }
            // Let go when the lines are half on their way: each has the other half to go.
            val half = RoomMade(line, end, lines.size, (end - line + 1) * 10f)
            half.slide(slot.before, SLIDE_MS / 2000f)
            val halfway = half.settling(slot.before, top, top(moved.line))
            check(lines.indices.all { halfway.of(it, 1f) == 0f }) { "$name: a way to go before the new text is laid out" }
            halfway.resolve(top)
            for (index in lines.indices) {
                if (index in line..end) continue
                val now = order.indexOf(index)
                check(near(halfway.of(now, 1f), -made.of(index) / 2) && near(halfway.of(now, 0.5f), -made.of(index) / 4) && halfway.of(now, 0f) == 0f) { "$name: line $index half on its way has ${halfway.of(now, 1f)} to go" }
            }
            check((there.line..there.end).all { halfway.of(it, 1f) == 0f } && halfway.ofItem(1f) == 0f) { "$name: the item's own lines" }
            // Broken off there: the item goes back to its own place and so do the lines.
            val back = half.settling(null, top, 55f)
            back.resolve(top)
            check(back.line == line && back.end == end && near(back.ofItem(1f), 55f - top(line))) { "$name: back to its own place: ${back.line} to ${back.end}" }
            check(lines.indices.all { near(back.of(it, 1f), half.of(it)) }) { "$name: the lines on their way back: ${lines.indices.map { back.of(it, 1f) }}" }
            tried++
        }
        check(tried >= 40) { "Only $tried drops were tried" }
    }
    // A body with a table is shown in pieces: the places of an item are those of the whole body that lie in its piece,
    // in the piece's own lines.
    run {
        val whole = "- [ ] a\n- [ ] b\n\n| x |\n|---|\n\n- [ ] c\n\t- [ ] d\n- [ ] e"
        fun slots(above: Int, line: Int) = dropSlotsIn(whole, above, line, if (above == 0) 3 else 4).map { "${it.before}:${it.minLevel}:${it.maxLevel}" }
        // The piece above the table: lines 0 to 2 (the last one is empty).
        check(slots(0, 0) == listOf("0:0:0", "2:0:1")) { "Above the table: ${slots(0, 0)}" }
        // The piece under it starts on line 5 of the body: its lines 1, 2 and 3 are the list.
        // At its own place the last item can go under the sub-item above it: two levels in.
        check(slots(5, 3) == listOf("1:0:0", "2:1:1", "3:0:2")) { "Under the table: ${slots(5, 3)}" }
        // An item with a sub-item: the place in front of the next item is its own (its own line).
        check(slots(5, 1) == listOf("1:0:0", "4:0:1")) { "Under the table, an item with a sub-item: ${slots(5, 1)}" }
        check(dropSlotsIn(whole, 5, 0, 4).isEmpty()) { "A line that is no list line has no places" }
        // The core keeps an item between the tables around it, so every place lies in the piece the item is shown in.
        for (line in listOf(6, 7, 8)) check(FormatCore.dropSlots(whole, line).all { it.before in 5..9 }) { "An item under the table stays under it: line $line" }
        for (line in listOf(0, 1)) check(FormatCore.dropSlots(whole, line).all { it.before in 0..3 }) { "An item above the table stays above it: line $line" }
        // Without a table the piece is the body.
        val plain = "- [ ] a\n- [ ] b"
        check(dropSlotsIn(plain, 0, 0, 2) == FormatCore.dropSlots(plain, 0)) { "One piece" }
    }
    // Pasting several lines in a list item (design checklists-77, 6.6): the editor sees a change, finds the pasted text
    // in it and makes an item of every line. A word a keyboard finishes along with Enter is no paste.
    run {
        fun paste(text: String, from: Int, to: Int, pasted: String): Pair<String, Int>? {
            val next = text.replaceRange(from, to, pasted)
            return pastedLines(text, from, to, next, from + pasted.length)
        }
        check(paste("- [ ] a", 7, 7, "b\nc") == ("- [ ] ab\n- [ ] c" to 16)) { "Two lines at the end of a task: ${paste("- [ ] a", 7, 7, "b\nc")}" }
        // The core leaves blank lines out, also the one a paste starts with: its first words go on in the item.
        check(paste("- [ ] a\n- [ ] z", 7, 7, "\nb\nc") == ("- [ ] ab\n- [ ] c\n- [ ] z" to 16)) { "Lines that start with a line break: ${paste("- [ ] a\n- [ ] z", 7, 7, "\nb\nc")}" }
        // What comes in place of a selection.
        check(paste("- one two", 2, 5, "x\ny") == ("- x\n- y two" to 7)) { "In place of a selection: ${paste("- one two", 2, 5, "x\ny")}" }
        // The same letters before and after the caret do not blur where the paste is: the selection says it.
        check(paste("- [ ] ab", 6, 6, "a\nx") == ("- [ ] a\n- [ ] xab" to 15)) { "A paste that starts as the text goes on: ${paste("- [ ] ab", 6, 6, "a\nx")}" }
        // Outside a list, without a line break, and one letter: an ordinary change.
        check(paste("plain", 5, 5, "a\nb") == null) { "Outside a list" }
        check(paste("- [ ] a", 7, 7, "bc") == null) { "No line break" }
        check(paste("- [ ] a", 7, 7, "\n") == null) { "Enter alone is the list Enter's" }
        // Not a change at the selection: something else changed too.
        check(pastedLines("- [ ] a", 7, 7, "- [ ] xb\nc", 10) == null) { "The text before the caret changed" }
        check(pastedLines("- [ ] a\nend", 7, 7, "- [ ] ab\nc\nEND", 10) == null) { "The text behind the caret changed" }
        check(pastedLines("- [ ] a", 7, 7, "- [ ] ab\nc", 9) == null) { "The caret is not behind the pasted text" }
        check(pastedLines("- [ ] a", 9, 9, "- [ ] ab\nc", 10) == null) { "A selection outside the text" }
    }
    // A place in the text after a replacement that was not made for it, the line of a place and the start of a line.
    run {
        val edit = FormatCore.Edit(4, 6, "abcd", 0)
        check(listOf(0, 4, 5, 6, 9).map { edit.moved(it) } == listOf(0, 4, 5, 8, 11)) { "A place after a replacement: ${listOf(0, 4, 5, 6, 9).map { edit.moved(it) }}" }
        check(FormatCore.Edit(4, 9, "x", 0).moved(8) == 5) { "A place in text that went" }
        val text = "one\ntwo\n\nfour"
        check(listOf(-1, 0, 3, 4, 7, 8, 9, 13, 99).map { lineOf(text, it) } == listOf(0, 0, 0, 1, 1, 2, 3, 3, 3)) { "The line of a place: ${listOf(-1, 0, 3, 4, 7, 8, 9, 13, 99).map { lineOf(text, it) }}" }
        check((0..5).map { lineStartOf(text, it) } == listOf(0, 4, 8, 9, 13, 13)) { "The start of a line: ${(0..5).map { lineStartOf(text, it) }}" }
        for (line in 0..3) check(lineOf(text, lineStartOf(text, line)) == line) { "Line $line and back" }
        check(lineStarts(text).toList() == listOf(0, 4, 8, 9) && lineStarts("").toList() == listOf(0) && lineStarts("a\n").toList() == listOf(0, 2)) { "Where the lines start: ${lineStarts(text).toList()}" }
    }
    // The note's menu offers its checklist items only when the note has a task in a list.
    check(hasTask("text\n- a\n\t- [x] b") && hasTask("* [ ] star") && !hasTask("- a\n1. b") && !hasTask("```\n- [ ] code\n```") && !hasTask("> - [ ] quote") && !hasTask("see [link](https://example.com)") && !hasTask("- a bullet with a [link](https://example.com)\n1. b")) { "Which notes have a task" }
    checkedParts()
    println("Android list editor checks passed")
}

/**
 * The ticked end of a list as a part of its own (design checklists-77-v2, part 6): the pieces the body is shown in, the
 * field that keeps the focus when they are laid out again, where an item may be dragged, and the three rules that keep
 * the part ticked.
 */
private fun checkedParts() {
    fun shown(text: String, checked: Boolean = true) = bodyPieces(text, checked).map { it.kind + ":" + text.substring(it.from, it.to) }
    val list = "- [ ] a\n- [ ] b\n- [x] c\n- [x] d"
    check(shown(list) == listOf("text:- [ ] a\n- [ ] b", "checked:- [x] c\n- [x] d")) { "A list with ticked tasks at its end: ${shown(list)}" }
    check(shown(list, false) == listOf("text:$list")) { "Without the setting the body is one piece: ${shown(list, false)}" }
    check(shown("intro\n- [ ] a\n- [x] c\n\nend") == listOf("text:intro\n- [ ] a", "checked:- [x] c", "text:\nend")) { "Text above and below: ${shown("intro\n- [ ] a\n- [x] c\n\nend")}" }
    check(shown("- [x] a\n- [x] b") == listOf("checked:- [x] a\n- [x] b")) { "Only ticked tasks: ${shown("- [x] a\n- [x] b")}" }
    check(shown("- [ ] a\n- [x] b\n\n- [x] c\n- [ ] d\n- [x] e") == listOf("text:- [ ] a", "checked:- [x] b", "text:\n- [x] c\n- [ ] d", "checked:- [x] e")) { "Two lists: ${shown("- [ ] a\n- [x] b\n\n- [x] c\n- [ ] d\n- [x] e")}" }
    check(shown("- [ ] a\n- [x] b\n\t- [x] s") == listOf("text:- [ ] a", "checked:- [x] b\n\t- [x] s")) { "A ticked task with its sub-task" }
    check(shown("- [ ] a\n- [x] b\n\t- [ ] s") == listOf("text:- [ ] a\n- [x] b\n\t- [ ] s")) { "A ticked task with an open sub-task is not done" }
    check(shown("- [ ] a\n- [x] b\n") == listOf("text:- [ ] a", "checked:- [x] b", "text:")) { "An empty last line is a place to type: ${shown("- [ ] a\n- [x] b\n")}" }
    check(bodyPieces("", true) == listOf(BodyPiece("text", 0, 0)) && bodyPieces("") == listOf(BodyPiece("text", 0, 0)) && shown("plain") == listOf("text:plain")) { "A body is always a piece: ${bodyPieces("")}" }
    val table = "| a | b |\n|---|---|\n| 1 | 2 |"
    check(shown("- [ ] a\n- [x] b\n\n$table\n\n- [x] c") == listOf("text:- [ ] a", "checked:- [x] b", "text:", "table:$table", "text:", "checked:- [x] c")) { "Around a table: ${shown("- [ ] a\n- [x] b\n\n$table\n\n- [x] c")}" }

    // Whatever the note holds: the pieces are the whole text with one line break between two, and the checked ones are
    // exactly the ticked ends the core finds.
    val lines = listOf("- [ ] a", "- [x] b", "\t- [x] s", "\t- [ ] o", "text", "", "- bullet", "1. one", "* [X] star", "    - [x] deep", table, "```\n- [x] code\n```")
    val random = java.util.Random(77)
    val notes = (0 until 4000).map { (0 until random.nextInt(9)).joinToString("\n") { lines[random.nextInt(lines.size)] } }
    var withChecked = 0
    for (note in notes) {
        val pieces = bodyPieces(note, true)
        check(pieces.joinToString("\n") { note.substring(it.from, it.to) } == note) { "The pieces are not the note: $note" }
        val starts = lineStarts(note)
        val tails = FormatCore.checkedTail(note).map { tail -> starts[tail.from] to (if (tail.to + 1 < starts.size) starts[tail.to + 1] - 1 else note.length) }
        check(pieces.filter { it.kind == "checked" }.map { it.from to it.to } == tails) { "The checked pieces are not the ticked ends: $note" }
        check(pieces.filter { it.kind == "table" } == bodyPieces(note).filter { it.kind == "table" }) { "The tables are not where they were: $note" }
        // The first ticked item is a main item, so a place at the top of the ticked items always takes one: the editor
        // only has to keep an item there from hanging under the open task above (dropSlotsIn).
        for (piece in pieces.filter { it.kind == "checked" }) {
            val above = lineOf(note, piece.from)
            for (line in above..lineOf(note, piece.to)) check(FormatCore.dropSlots(note, line).filter { it.before == above }.all { it.minLevel == 0 }) { "A place at the top of ticked items that takes no main item: $note, line $line" }
        }
        if (tails.isNotEmpty()) withChecked++
    }
    check(withChecked > 500) { "Too few notes with ticked ends to tell: $withChecked" }

    // The field with the focus keeps its piece's id, and the piece that holds the caret gets it when they are laid out again.
    run {
        val layout = PieceLayout()
        val text = "- [ ] a\n- [ ] b\n- [x] c"
        var pieces = layout.update(text, 0, true, 0, 0)
        check(pieces == listOf(BodyPiece("text", 0, 15, 0), BodyPiece("checked", 16, 23, 1))) { "Laid out the first time: $pieces" }
        // Typing in the open tasks: the pieces only move along.
        layout.focused = 0
        val typed = "- [ ] ax\n- [ ] b\n- [x] c"
        pieces = layout.update(typed, 0, true, 8, 0)
        check(pieces == listOf(BodyPiece("text", 0, 16, 0), BodyPiece("checked", 17, 24, 1))) { "After a letter: $pieces" }
        // A box ticked by typing stays in the field it was typed in.
        val hand = "- [ ] ax\n- [x] b\n- [x] c"
        pieces = layout.update(hand, 0, true, 8, 0)
        check(pieces.map { it.kind to hand.substring(it.from, it.to) } == listOf("text" to "- [ ] ax\n- [x] b", "checked" to "- [x] c")) { "A tick that was typed: $pieces" }
        // A tick on the task with the caret is no typing: the ticked items are cut out again, and the field goes along with the caret.
        val tick = FormatCore.tickEdit(hand, 0, true, 8, 8)!!
        val ticked = hand.replaceRange(tick.edit.from, tick.edit.to, tick.edit.insert)
        pieces = layout.update(ticked, 0, true, tick.edit.selFrom, 1)
        check(pieces.map { it.kind to it.id } == listOf("checked" to 0) && ticked.lines().all { it.startsWith("- [x] ") }) { "After the last open task was ticked: $pieces in $ticked" }
    }
    run {
        val layout = PieceLayout()
        val text = "- [ ] a\n- [ ] b\n- [x] c"
        layout.update(text, 0, true, 0, 0)
        layout.focused = 0
        // The caret is in `a`, which is ticked and moves under `b`: the field with the focus shows the ticked items now.
        val tick = FormatCore.tickEdit(text, 0, true, 7, 7)!!
        val ticked = text.replaceRange(tick.edit.from, tick.edit.to, tick.edit.insert)
        check(ticked == "- [ ] b\n- [x] a\n- [x] c") { "The tick: $ticked" }
        var pieces = layout.update(ticked, 0, true, tick.edit.selFrom, 1)
        check(pieces.map { it.kind to it.id } == listOf("text" to 1, "checked" to 0)) { "The focus went along with its task: $pieces" }
        // Enter there makes a task with the open ones and the caret goes to it: so does the field.
        val enter = checkedEnterEdit(ticked, tick.edit.selFrom)!!
        val entered = ticked.replaceRange(enter.from, enter.to, enter.insert)
        check(entered == "- [ ] b\n- [ ] \n- [x] a\n- [x] c" && enter.caret == 14) { "Enter among the ticked items: $entered, caret ${enter.caret}" }
        pieces = layout.update(entered, 0, true, enter.caret, 2)
        check(pieces.map { it.kind to it.id } == listOf("text" to 0, "checked" to 1)) { "The focus went to the new task: $pieces" }
        // Without a focus the pieces are numbered as they stand.
        layout.focused = -1
        pieces = layout.update(entered, 1, true, 0, 2)
        check(pieces.map { it.id } == listOf(0, 1)) { "Without a focus: $pieces" }
    }
    run {
        // A table typed by hand stays text while its field has the focus, also when a task in that field is ticked.
        val layout = PieceLayout()
        val text = "intro\n- [ ] a\n- [x] c"
        layout.update(text, 0, true, 0, 0)
        layout.focused = 0
        val typed = "$table\nintro\n- [ ] a\n- [x] c"
        var pieces = layout.update(typed, 0, true, table.length, 0)
        check(pieces.map { it.kind } == listOf("text", "checked")) { "A table that is typed: $pieces" }
        val tick = FormatCore.tickEdit(typed, 4, true)!!
        val ticked = typed.replaceRange(tick.edit.from, tick.edit.to, tick.edit.insert)
        pieces = layout.update(ticked, 0, true, table.length, 1)
        check(pieces.map { it.kind to ticked.substring(it.from, it.to) } == listOf("text" to "$table\nintro", "checked" to "- [x] a\n- [x] c")) { "A tick next to a typed table: $pieces" }
        layout.focused = -1
        pieces = layout.update(ticked, 1, true, 0, 1)
        check(pieces.map { it.kind } == listOf("table", "text", "checked")) { "The focus left: $pieces" }
    }
    run {
        // With the Markdown switch on the body is one text, in the field that had the focus; that field has it again
        // when the body is shown in pieces.
        val layout = PieceLayout()
        val text = "- [ ] a\n- [x] c"
        layout.update(text, 0, true, 0, 0)
        layout.focused = 1
        check(layout.whole(text) == listOf(BodyPiece("text", 0, text.length, 1))) { "The whole body in the field with the focus: ${layout.whole(text)}" }
        check(layout.update(text, 0, true, 2, 0).map { it.kind to it.id } == listOf("text" to 1, "checked" to 0)) { "In pieces again, the caret in the open task" }
        check(layout.whole(text).single().id == 1 && layout.update(text, 0, true, 10, 0).map { it.kind to it.id } == listOf("text" to 0, "checked" to 1)) { "In pieces again, the caret in the ticked task" }
        layout.focused = -1
        check(layout.whole(text) == listOf(BodyPiece("text", 0, text.length, 0))) { "The whole body without a focus" }
    }
    run {
        // The caret in a table (Undo of a change in a cell puts it there) is in no field: the field that had the focus
        // keeps it, as the field that stands where it stood among the fields.
        val layout = PieceLayout()
        val text = "above\n\n$table\n\nbelow\n- [x] c"
        var pieces = layout.update(text, 0, true, 0, 0)
        check(pieces.map { it.kind } == listOf("text", "table", "text", "checked")) { "Text, a table, text and ticked items: $pieces" }
        layout.focused = pieces[2].id
        val changed = text.replace("| 1 | 2 |", "| 9 | 2 |")
        pieces = layout.update(changed, 0, true, changed.indexOf("| 9") + 2, 1)
        check(pieces.map { it.kind } == listOf("text", "table", "text", "checked") && pieces[2].id == layout.focused && pieces.filter { it.kind != "table" }.map { it.id }.toSet().size == 3) { "The caret in a table: $pieces, focus ${layout.focused}" }
    }
    // Any run of changes: the pieces are the note, no two fields share an id, and the caret's piece has the focus.
    run {
        val layout = PieceLayout()
        var acts = 0
        for ((round, note) in notes.withIndex()) {
            val caret = if (note.isEmpty()) 0 else random.nextInt(note.length + 1)
            // Laid out again for sure: the change was not typed, or the key is new.
            val again = random.nextInt(3) == 0
            if (again) acts++
            if (round % 7 == 0) layout.focused = -1
            val pieces = layout.update(note, round / 50, true, caret, acts)
            check(pieces.joinToString("\n") { note.substring(it.from, it.to) } == note) { "The pieces are not the note after a change: $note" }
            val fields = pieces.filter { it.kind != "table" }
            check(fields.map { it.id }.toSet().size == fields.size) { "Two fields with one id: $pieces" }
            val holder = fields.firstOrNull { caret >= it.from && caret <= it.to }
            if ((again || round % 50 == 0) && layout.focused >= 0 && holder != null) check(holder.id == layout.focused) { "The caret's piece lost the focus: $pieces, caret $caret, focus ${layout.focused}" }
            if (layout.focused < 0 && fields.isNotEmpty()) layout.focused = fields[random.nextInt(fields.size)].id
        }
    }

    // An item stays on its side of the header when it is dragged, and when it is moved with a button or a key.
    val slots = { whole: String, above: Int, line: Int, count: Int, place: PiecePlace -> dropSlotsIn(whole, above, line, count, place) }
    check(slots(list, 0, 0, 2, PiecePlace.FREE).map { it.before } == listOf(0, 2)) { "An open task lands among the open tasks: ${slots(list, 0, 0, 2, PiecePlace.FREE)}" }
    check(slots(list, 0, 1, 2, PiecePlace.FREE).map { it.before } == listOf(0, 1)) { "The last open task: ${slots(list, 0, 1, 2, PiecePlace.FREE)}" }
    check(slots(list, 2, 0, 2, PiecePlace.CHECKED) == listOf(FormatCore.Slot(0, 0, 0), FormatCore.Slot(2, 0, 1))) { "The first ticked task: ${slots(list, 2, 0, 2, PiecePlace.CHECKED)}" }
    check(slots(list, 2, 1, 2, PiecePlace.CHECKED) == listOf(FormatCore.Slot(0, 0, 0), FormatCore.Slot(1, 0, 1))) { "The last ticked task: ${slots(list, 2, 1, 2, PiecePlace.CHECKED)}" }
    val under = "- [x] c\n\n- [ ] e\n- [ ] f"
    check(slots(under, 1, 1, 3, PiecePlace.UNDER_CHECKED).map { it.before } == listOf(1, 3)) { "Under ticked items: ${slots(under, 1, 1, 3, PiecePlace.UNDER_CHECKED)}" }
    check(slots(under, 1, 1, 3, PiecePlace.FREE).map { it.before } == listOf(0, 1, 3)) { "The same piece when nothing is ticked above it: ${slots(under, 1, 1, 3, PiecePlace.FREE)}" }
    check(dropSlotsIn(list, 0, 0, 4).map { it.before } == FormatCore.dropSlots(list, 0).map { it.before }) { "A body in one piece keeps every place" }
    check(crossesChecked(list, 1, "down") && crossesChecked(list, 2, "up")) { "Past the header" }
    check(listOf(0 to "down", 0 to "up", 1 to "up", 2 to "down", 3 to "up", 3 to "down").none { (line, direction) -> crossesChecked(list, line, direction) }) { "On its own side of the header" }
    check(!crossesChecked("text\n- [ ] a", 0, "down") && !crossesChecked("- [ ] a\n- [ ] b", 0, "down")) { "No ticked items, nothing to cross" }

    // The three rules among the ticked items.
    check(checkedEnterEdit("plain", 2) == null) { "Enter outside a list" }
    val completed = listEnterAfterChange("- [ ] a\n- [x] chees", "- [ ] a\n- [x] cheese\n", 21) { text, at -> checkedEnterEdit(text, at) }
    check(completed == ("- [ ] a\n- [ ] \n- [x] cheese" to 14)) { "Enter along with a word the keyboard finished: $completed" }
    val ticked = "- [ ] a\n- [x] c\n- [x] d"
    check(backspaceAtChecked(ticked, 14, ticked.removeRange(13, 14), 8) && backspaceAtChecked(ticked, 10, ticked.removeRange(9, 10), 8)) { "Backspace at the start of the first ticked task" }
    check(!backspaceAtChecked(ticked, 15, ticked.removeRange(14, 15), 8) && !backspaceAtChecked(ticked, 22, ticked.removeRange(21, 22), 8) && !backspaceAtChecked(ticked, 14, ticked, 8)) { "Backspace elsewhere among the ticked tasks" }
    fun paste(text: String, at: Int, pasted: String, checked: Boolean) = pastedLines(text, at, at, text.replaceRange(at, at, pasted), at + pasted.length, checked)
    check(paste("- [x] a", 7, "b\nc", true) == ("- [x] ab\n- [x] c" to 16)) { "Lines pasted in a ticked task: ${paste("- [x] a", 7, "b\nc", true)}" }
    check(paste("- [x] a", 7, "b\nc", false) == ("- [x] ab\n- [ ] c" to 16)) { "The same paste among the open tasks: ${paste("- [x] a", 7, "b\nc", false)}" }
    check(paste("- [x] a", 6, "- [ ] x\ny", true) == ("- [x] x\n- [x] ya" to 15)) { "A pasted open task among the ticked ones: ${paste("- [x] a", 6, "- [ ] x\ny", true)}" }
    check(paste("- [ ] o\r\n- [x] a\r\n- [x] z", 16, "b\nc", true) == ("- [ ] o\r\n- [x] ab\r\n- [x] c\r\n- [x] z" to 26)) { "A paste in a note with Windows line endings: ${paste("- [ ] o\r\n- [x] a\r\n- [x] z", 16, "b\nc", true)}" }

    // "+ List item" under the note: only when it ends in a list with a task.
    check(listOf("- [ ] a\n- [ ] b", "text\n- [ ] a", "- [ ] a\n\tmore", "- a\n\t- [x] s").map { endsInTaskList(it) } == listOf(1, 1, 1, 1)) { "Notes that end in a task list" }
    check(listOf("", "text", "- [ ] a\ntext", "- [ ] a\n", "- a\n- b", "1. one", "```\n- [ ] code\n```", "- [ ] a\n\n  text").all { endsInTaskList(it) == -1 }) { "Notes that do not" }

    // Enter on an empty item right above the ticked items leaves the list at its end: the item goes, the caret comes on
    // a new line under them (Eric, 26 Nov).
    fun leave(text: String, at: Int): Pair<String, Int>? = leaveAboveChecked(text, at)?.let { text.replaceRange(it.from, it.to, it.insert) to it.caret }
    check(leave("- [ ] a\n- [ ] \n- [x] c\n- [x] d", 14) == ("- [ ] a\n- [x] c\n- [x] d\n" to 24)) { "The ticked items end the note: ${leave("- [ ] a\n- [ ] \n- [x] c\n- [x] d", 14)}" }
    check(leave("- [ ] a\n- [ ] \n- [x] c\n\nend", 14) == ("- [ ] a\n- [x] c\n\n\nend" to 16)) { "Text under the ticked items: ${leave("- [ ] a\n- [ ] \n- [x] c\n\nend", 14)}" }
    check(leave("- [ ] \n- [x] c\n\t- [x] s", 6) == ("- [x] c\n\t- [x] s\n" to 17)) { "The only open task, a sub-task under the ticked one: ${leave("- [ ] \n- [x] c\n\t- [x] s", 6)}" }
    check(leave("- \n- [x] c", 2) == ("- [x] c\n" to 8) && leave("1. \n- [x] c", 3) == ("- [x] c\n" to 8)) { "An empty bullet and an empty numbered item: ${leave("- \n- [x] c", 2)}" }
    check(leave("- [ ] a\r\n- [ ] \r\n- [x] c", 15) == ("- [ ] a\r\n- [x] c\r\n" to 18)) { "Windows line endings, at the end: ${leave("- [ ] a\r\n- [ ] \r\n- [x] c", 15)}" }
    check(leave("- [ ] \r\n- [x] c\r\n\r\nend", 6) == ("- [x] c\r\n\r\n\r\nend" to 9)) { "Windows line endings, text under it: ${leave("- [ ] \r\n- [x] c\r\n\r\nend", 6)}" }
    // The pieces after it: the caret is in the text under the ticked items.
    leave("- [ ] a\n- [ ] \n- [x] c\n- [x] d", 14)!!.let { (text, caret) ->
        val pieces = bodyPieces(text, true)
        check(pieces.map { it.kind } == listOf("text", "checked", "text") && pieces.last().from == caret && pieces.last().to == caret) { "The caret's place after leaving: $pieces, caret $caret" }
    }
    // Not there: a task with words, a task that is not right above the ticked items, one with an item under it, one in
    // a level (it goes a level back first), a caret in front of the sign, a list without ticked items, the ticked items.
    check(listOf("- [ ] a\n- [x] c" to 7, "- [ ] \n- [ ] b\n- [x] c" to 6, "- [ ] \n\t- [x] s\n- [x] c" to 6, "- [ ] a\n\t- [ ] \n- [x] c" to 15,
        "- [ ] \n- [x] c" to 0, "- [ ] a\n- [ ] " to 14, "- [ ] a\n- [x] c" to 15, "- [ ] \n\n- [x] c" to 6, "plain\n- [x] c" to 5, "- [ ] \ntext" to 6)
        .all { (text, at) -> leaveAboveChecked(text, at) == null }) { "Enter that does not leave the list above the ticked items" }
    // Whatever the note holds: where it applies, the empty item is gone, nothing else changed, and the ticked items are
    // still the ticked end of their list.
    val withEmpty = lines + listOf("- [ ] ", "- [ ] ", "- ", "\t- [ ] ")
    var left = 0
    for (note in (0 until 4000).map { (0 until random.nextInt(9)).joinToString("\n") { withEmpty[random.nextInt(withEmpty.size)] } }) {
        val starts = lineStarts(note)
        for (line in starts.indices) {
            val end = if (line + 1 < starts.size) starts[line + 1] - 1 else note.length
            val (after, caret) = leave(note, end) ?: continue
            left++
            val before = note.split('\n')
            val now = after.split('\n')
            val tail = FormatCore.checkedTail(note).first { it.from == line + 1 }
            check(now == before.take(line) + before.subList(tail.from, tail.to + 1) + listOf("") + before.drop(tail.to + 1)) { "Leaving the list changed more than it should: $note at line $line gave $after" }
            check(lineOf(after, caret) == tail.to && caret == lineStarts(after)[tail.to]) { "The caret after leaving: $caret in $after" }
            // A ticked task that stood above the empty item joins them now.
            check(FormatCore.checkedTail(after).any { it.from <= line && it.to == tail.to - 1 && it.count >= tail.count }) { "The ticked items are no ticked end any more: $after" }
        }
    }
    check(left > 100) { "Too few notes with an empty item above ticked items to tell: $left" }

    // A tap in the room under ticked items that end the note: an empty line to type on.
    check(withLineUnder("- [x] a") == "- [x] a\n" && withLineUnder("- [ ] o\r\n- [x] a") == "- [ ] o\r\n- [x] a\r\n" && withLineUnder("") == "\n" && withLineUnder("- [ ] o\n- [x] a") == "- [ ] o\n- [x] a\n") { "A line under the note" }
    check(bodyPieces(withLineUnder(list), true).map { it.kind } == listOf("text", "checked", "text")) { "The line under the note is a piece to type in" }

    // An item that is dragged is drawn inside its own piece: it stops at the piece's first and last line.
    check(keptInPiece(30f, 100f, 140f, 0f, 200f) == 30f && keptInPiece(-30f, 100f, 140f, 0f, 200f) == -30f) { "Inside the piece the item follows the finger" }
    check(keptInPiece(90f, 100f, 140f, 0f, 200f) == 60f && keptInPiece(-250f, 100f, 140f, 0f, 200f) == -100f) { "At the edge of the piece it stops" }
    check(keptInPiece(50f, 0f, 200f, 0f, 200f) == 0f && keptInPiece(-50f, 0f, 200f, 0f, 200f) == 0f) { "An item that fills its piece stays" }
}

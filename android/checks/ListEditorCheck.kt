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
    check(tickChecklistText("- [ ] a\n\t- [ ] sub\n- [ ] b", 0, true) == "- [ ] b\n- [x] a\n\t- [ ] sub")
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
    // Undo of a list action in the editor (design checklists-77, 6.5): the body from before comes back, or the action
    // is taken back in what was typed since, or nothing happens.
    run {
        val before = "- [ ] a\n- [ ] b\n- [ ] c\nslot"
        val indented = "- [ ] a\n\t- [ ] b\n- [ ] c\nslot"
        // Nothing typed since: the body from before, with the selection from before.
        check(undoListAction(before, 3, 5, indented, indented, 9, 9) == Undone(before, 3, 5)) { "Undo right away" }
        // Typed on another line: the typing stays, the caret stays behind its letter.
        val typed = "- [ ] aQ\n\t- [ ] b\n- [ ] c\nslot"
        check(undoListAction(before, 0, 0, indented, typed, 8, 8) == Undone("- [ ] aQ\n- [ ] b\n- [ ] c\nslot", 8, 8)) { "Undo keeps typing: ${undoListAction(before, 0, 0, indented, typed, 8, 8)}" }
        // A caret behind the change moves along with its text.
        check(undoListAction(before, 0, 0, indented, typed, typed.length, typed.length)?.selFrom == typed.length - 1) { "Caret behind the change" }
        // Typed on the line the action changed: refused, nothing is written over.
        check(undoListAction(before, 0, 0, indented, "- [ ] a\n\t- [ ] bQ\n- [ ] c\nslot", 0, 0) == null) { "Undo on a changed line must be refused" }
        // A deleted item comes back between the lines typed in around it.
        check(undoListAction(before, 0, 0, "- [ ] a\n- [ ] c\nslot", "- [ ] a!\n- [ ] c?\nslot", 0, 0)?.text == "- [ ] a!\n- [ ] b\n- [ ] c?\nslot") { "Undo of a delete: ${undoListAction(before, 0, 0, "- [ ] a\n- [ ] c\nslot", "- [ ] a!\n- [ ] c?\nslot", 0, 0)}" }
        // A moved item goes back while a line was added below.
        val moved = "- [ ] a\n- [ ] c\n- [ ] b\nslot"
        check(undoListAction(before, 0, 0, moved, "$moved\nnew", 0, 0)?.text == "$before\nnew") { "Undo of a move: ${undoListAction(before, 0, 0, moved, "$moved\nnew", 0, 0)}" }
        // Typed in the item that was dragged, or ticked it: it goes back with that, and the caret stays behind its letter.
        val dragged = "- [ ] c\n- [ ] a\n- [ ] b\nslot"
        check(undoListAction(before, 0, 0, dragged, "- [ ] cQ\n- [ ] a\n- [ ] b\nslot", 8, 8) == Undone("- [ ] a\n- [ ] b\n- [ ] cQ\nslot", 24, 24)) {
            "Undo of a drag after typing in the item: ${undoListAction(before, 0, 0, dragged, "- [ ] cQ\n- [ ] a\n- [ ] b\nslot", 8, 8)}"
        }
        check(undoListAction(before, 0, 0, dragged, "- [x] c\n- [ ] a\n- [ ] b\nslot", 7, 7)?.text == "- [ ] a\n- [ ] b\n- [x] c\nslot") { "Undo of a drag after a tick on the item" }
        // Moved again with Move down (which shows no strip of its own): the item is back where it was, once.
        check(undoListAction(before, 0, 0, dragged, "- [ ] a\n- [ ] c\n- [ ] b\nslot", 15, 15) == Undone(before, 23, 23)) {
            "Undo of a drag after Move down: ${undoListAction(before, 0, 0, dragged, "- [ ] a\n- [ ] c\n- [ ] b\nslot", 15, 15)}"
        }
        // A caret in a line that moved with the item stays in that line; a selection over two lines keeps both ends.
        val nested = "- [ ] a\n- [ ] b\n\t- [ ] b1\n- [ ] c\nslot"
        val nestedDragged = "- [ ] b\n\t- [ ] b1\n- [ ] a\n- [ ] c\nslot"
        check(undoListAction(nested, 0, 0, nestedDragged, "- [ ] b\n\t- [ ] b1\n- [ ] a\n- [ ] c!\nslot", 17, 17) == Undone("- [ ] a\n- [ ] b\n\t- [ ] b1\n- [ ] c!\nslot", 25, 25)) {
            "Caret in a sub-item that goes back: ${undoListAction(nested, 0, 0, nestedDragged, "- [ ] b\n\t- [ ] b1\n- [ ] a\n- [ ] c!\nslot", 17, 17)}"
        }
        // Two equal lines cannot be told apart, now or after Undo: the caret keeps its place in the text, as it did.
        check(undoListAction("- [x] a\n- [ ] a", 0, 0, "- [ ] a\n- [ ] a", "- [ ] a\n- [ ] a\nx", 7, 7) == Undone("- [x] a\n- [ ] a\nx", 7, 7)) { "Caret in one of two equal lines" }
        check(undoListAction("- [x] a\n- [ ] b\n- [x] a", 0, 0, "- [ ] a\n- [ ] b\n- [ ] a", "- [ ] a\n- [ ] b!\n- [x] a", 24, 24) == Undone("- [x] a\n- [ ] b!\n- [x] a", 24, 24)) {
            "Caret in a line that is there twice after Undo: ${undoListAction("- [x] a\n- [ ] b\n- [x] a", 0, 0, "- [ ] a\n- [ ] b\n- [ ] a", "- [ ] a\n- [ ] b!\n- [x] a", 24, 24)}"
        }
        // An empty line with the caret, under an item that comes back: the caret stays on its empty line.
        check(undoListAction("- [ ] a\n\n- [ ] b", 0, 0, "\n- [ ] b", "\n- [ ] b!", 0, 0) == Undone("- [ ] a\n\n- [ ] b!", 8, 8)) {
            "Caret on an empty line: ${undoListAction("- [ ] a\n\n- [ ] b", 0, 0, "\n- [ ] b", "\n- [ ] b!", 0, 0)}"
        }
        // Uncheck all: a task ticked again by hand is the same change as Undo makes; words typed in a task are not.
        val ticked = "- [x] a\n- [x] b"
        val cleared = "- [ ] a\n- [ ] b"
        check(undoListAction(ticked, 0, 0, cleared, "- [x] a\n- [ ] b", 0, 0)?.text == ticked) { "Undo of Uncheck all after a tick" }
        check(undoListAction(ticked, 0, 0, cleared, "- [ ] a!\n- [ ] b", 0, 0) == null) { "Undo of Uncheck all on a changed task must be refused" }
        // A tick back is as long as the tick: a caret between two of them holds its place.
        check(undoListAction(ticked, 0, 0, cleared, "$cleared\nx", 9, 9) == Undone("$ticked\nx", 9, 9)) { "Caret between two ticks: ${undoListAction(ticked, 0, 0, cleared, "$cleared\nx", 9, 9)}" }
        // A task ticked again with "Move checked items to the bottom" on went down as well: the other ticks come back
        // and that task stays where it went, with the caret in it.
        val sorted = "- [ ] c\n- [x] a\n- [x] b"
        val open = "- [ ] c\n- [ ] a\n- [ ] b"
        check(undoListAction(sorted, 0, 0, open, "- [ ] c\n- [ ] b\n- [x] a", 23, 23) == Undone("- [ ] c\n- [x] b\n- [x] a", 23, 23)) {
            "Undo of Uncheck all after a tick that moved the task: ${undoListAction(sorted, 0, 0, open, "- [ ] c\n- [ ] b\n- [x] a", 23, 23)}"
        }
        // CRLF lines merge as they are.
        check(undoListAction("- a\r\n- b\r\n", 0, 0, "- a\r\n\t- b\r\n", "- a!\r\n\t- b\r\n", 0, 0)?.text == "- a!\r\n- b\r\n") { "Undo with CRLF" }
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
    // A body with a table is shown in pieces: the places of an item are those of the whole body that lie in its piece,
    // in the piece's own lines.
    run {
        val whole = "- [ ] a\n- [ ] b\n\n| x |\n|---|\n\n- [ ] c\n\t- [ ] d\n- [ ] e"
        fun slots(above: Int, line: Int) = dropSlotsIn(whole, above, line).map { "${it.before}:${it.minLevel}:${it.maxLevel}" }
        // The piece above the table: lines 0 to 2 (the last one is empty).
        check(slots(0, 0) == listOf("0:0:0", "2:0:1")) { "Above the table: ${slots(0, 0)}" }
        // The piece under it starts on line 5 of the body: its lines 1, 2 and 3 are the list.
        // At its own place the last item can go under the sub-item above it: two levels in.
        check(slots(5, 3) == listOf("1:0:0", "2:1:1", "3:0:2")) { "Under the table: ${slots(5, 3)}" }
        // An item with a sub-item: the place in front of the next item is its own (its own line).
        check(slots(5, 1) == listOf("1:0:0", "4:0:1")) { "Under the table, an item with a sub-item: ${slots(5, 1)}" }
        check(dropSlotsIn(whole, 5, 0).isEmpty()) { "A line that is no list line has no places" }
        // The core keeps an item between the tables around it, so every place lies in the piece the item is shown in.
        for (line in listOf(6, 7, 8)) check(FormatCore.dropSlots(whole, line).all { it.before in 5..9 }) { "An item under the table stays under it: line $line" }
        for (line in listOf(0, 1)) check(FormatCore.dropSlots(whole, line).all { it.before in 0..3 }) { "An item above the table stays above it: line $line" }
        // Without a table the piece is the body.
        val plain = "- [ ] a\n- [ ] b"
        check(dropSlotsIn(plain, 0, 0) == FormatCore.dropSlots(plain, 0)) { "One piece" }
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
    }
    // The note's menu offers its checklist items only when the note has a task in a list.
    check(hasTask("text\n- a\n\t- [x] b") && hasTask("* [ ] star") && !hasTask("- a\n1. b") && !hasTask("```\n- [ ] code\n```") && !hasTask("> - [ ] quote") && !hasTask("see [link](https://example.com)") && !hasTask("- a bullet with a [link](https://example.com)\n1. b")) { "Which notes have a task" }
    println("Android list editor checks passed")
}

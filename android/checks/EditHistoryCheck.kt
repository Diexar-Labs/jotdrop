package com.diexar.keepcapture

import kotlin.random.Random

/** A note as the editor holds it, with its history: every change goes through [write], as in the editor. */
private class Note(var title: String = "", var body: String = "") {
    var now = 0L
    val history = EditHistory(title, body) { now }
    var caret = body.length

    fun write(next: String, kind: EditKind, nextCaret: Int = caret) {
        history.record(EditField.BODY, body, next, kind, caret, caret, nextCaret, nextCaret)
        body = next
        caret = nextCaret
    }

    /** Types [text] at the caret, a letter at a time, [gap] ms apart. */
    fun type(text: String, gap: Long = 100) {
        for (letter in text) {
            now += gap
            write(body.substring(0, caret) + letter + body.substring(caret), EditKind.TYPING, caret + 1)
        }
    }

    fun backspace(count: Int = 1, gap: Long = 100) {
        repeat(count) {
            now += gap
            write(body.removeRange(caret - 1, caret), EditKind.TYPING, caret - 1)
        }
    }

    fun moveTo(at: Int) {
        caret = at
        history.moved()
    }

    fun retitle(next: String) {
        history.record(EditField.TITLE, title, next, EditKind.TYPING)
        title = next
    }

    fun take(applied: EditApplied?): Boolean {
        if (applied == null) return false
        title = applied.title
        body = applied.body
        if (applied.selFrom >= 0) caret = applied.selFrom
        return true
    }

    fun undo() = take(history.undo(title, body))
    fun redo() = take(history.redo(title, body))
}

fun main() {
    // Typing is grouped by a pause (design checklists-77-v2, 4.2, as measured in Keep): "abc", a wait, "def gh".
    run {
        val note = Note()
        note.type("abc")
        note.now += 2500
        note.type("def gh")
        check(note.undo() && note.body == "abc" && note.caret == 3) { "The second group goes first: ${note.body} ${note.caret}" }
        check(note.undo() && note.body == "" && note.caret == 0) { "Then the first: ${note.body}" }
        check(!note.undo() && !note.history.canUndo) { "Nothing more to take back" }
        check(note.redo() && note.body == "abc" && note.caret == 3) { "Redo of the first group: ${note.body} ${note.caret}" }
        check(note.redo() && note.body == "abcdef gh" && note.caret == 9) { "Redo of the second: ${note.body}" }
        check(!note.redo()) { "Nothing more to do again" }
    }
    // A pause of just a second still joins; a little longer does not.
    run {
        val note = Note()
        note.type("a")
        note.type("b", gap = 1000)
        note.type("c", gap = 1001)
        check(note.undo() && note.body == "ab" && note.undo() && note.body == "") { "The pause is one second: ${note.body}" }
    }
    // Enter is a step of its own, and so is a Backspace that joins two lines.
    run {
        val note = Note()
        note.type("milk\nbread")
        check(note.undo() && note.body == "milk\n") { "Typing after Enter: ${note.body}" }
        check(note.undo() && note.body == "milk") { "Enter itself: ${note.body}" }
        check(note.undo() && note.body == "") { "Typing before Enter: ${note.body}" }
        repeat(3) { note.redo() }
        note.backspace(6)
        check(note.body == "milk")
        check(note.undo() && note.body == "milk\n") { "A Backspace over the line break is one step: ${note.body}" }
        check(note.undo() && note.body == "milk\nbread") { "Deleting 'bread' is one step: ${note.body}" }
    }
    // The caret going elsewhere ends a group, and so does typing somewhere else.
    run {
        val note = Note()
        note.type("one")
        note.moveTo(0)
        note.type("X")
        check(note.undo() && note.body == "one" && note.caret == 0) { "Typed after the caret moved: ${note.body}" }
        check(note.undo() && note.body == "") { "The word before it" }
        val far = Note(body = "start  end")
        far.caret = 5
        far.type("a")
        far.caret = far.body.length
        far.type("b")
        check(far.undo() && far.body == "starta  end") { "Typing in another place is another step: ${far.body}" }
        check(far.undo() && far.body == "start  end")
    }
    // The switch between typing and deleting starts a new step.
    run {
        val note = Note()
        note.type("helo")
        note.backspace(1)
        note.type("lo")
        check(note.body == "hello")
        check(note.undo() && note.body == "hel") { "The typing after the Backspace: ${note.body}" }
        check(note.undo() && note.body == "helo") { "The Backspace: ${note.body}" }
        check(note.undo() && note.body == "") { "The typing before it: ${note.body}" }
    }
    // Deleting to the left and to the right of the same place is one step; the caret comes back where it was.
    run {
        val note = Note(body = "abcdef")
        note.caret = 4
        note.backspace(2)
        note.now += 100
        note.write("abf", EditKind.TYPING, 2)
        check(note.undo() && note.body == "abcdef" && note.caret == 4) { "Backspace and Delete together: ${note.body} ${note.caret}" }
        check(note.redo() && note.body == "abf" && note.caret == 2) { "And again: ${note.body} ${note.caret}" }
    }
    // What the keyboard does in one go (a word it corrects or finishes) belongs to the group it falls in.
    run {
        val note = Note()
        note.type("teh")
        note.now += 100
        note.write("the ", EditKind.TYPING, 4)
        note.type("cat")
        check(note.undo() && note.body == "") { "An autocorrection splits no group: ${note.body}" }
        val deleting = Note(body = "one two")
        deleting.backspace(2)
        deleting.now += 100
        deleting.write("one TW", EditKind.TYPING, 6)
        check(deleting.undo() && deleting.body == "one two") { "A replacement while deleting: ${deleting.body}" }
    }
    // A long group ends where a new word starts, so one Undo takes back about a line at most.
    run {
        val note = Note()
        val text = "the quick brown fox jumps over the lazy dog and runs on"
        note.type(text, gap = 10)
        check(note.undo() && note.body == "the quick brown fox jumps over ") { "The first group ends at a word: '${note.body}'" }
        check(note.undo() && note.body == "") { "And is one step" }
        // A word of any length stays whole.
        val long = Note()
        long.type("a".repeat(80), gap = 10)
        check(long.undo() && long.body == "") { "A long word is one step" }
    }
    // A button, a tick or a drag is a step of its own, between the typing around it.
    run {
        val note = Note()
        note.type("- [ ] a")
        note.write("- [x] a", EditKind.STEP)
        note.type("b")
        check(note.undo() && note.body == "- [x] a")
        check(note.undo() && note.body == "- [ ] a")
        check(note.undo() && note.body == "")
        check(note.redo() && note.redo() && note.body == "- [x] a") { "The tick again: ${note.body}" }
    }
    // An empty pair the editor takes away itself belongs to the step before it: a button and then a tap elsewhere
    // leave nothing to take back.
    run {
        val note = Note(body = "word")
        note.write("word****", EditKind.STEP, 6)
        note.write("word", EditKind.CLEANUP, 2)
        check(!note.history.canUndo) { "A pair that came and went is no step" }
        note.type("x")
        note.caret = note.body.length
        note.write(note.body + "****", EditKind.STEP, note.body.length + 2)
        note.type("b")
        note.backspace(1)
        note.write(note.body.removeSuffix("****"), EditKind.CLEANUP, 0)
        check(note.body == "woxrd") { note.body }
        check(note.undo() && note.body == "woxrd**b**") { "The cleanup goes back with the Backspace: ${note.body}" }
        check(note.redo() && note.body == "woxrd") { "And comes again with it: ${note.body}" }
    }
    // A cleanup somewhere else than the last step is joined to it: one Undo takes both back, one Redo does both again.
    run {
        val note = Note(body = "abc\n")
        note.caret = 0
        note.type("X")
        note.write("Xabc", EditKind.CLEANUP)
        check(note.undo() && note.body == "abc\n" && note.caret == 0) { "Both go back: '${note.body}'" }
        check(!note.history.canUndo)
        check(note.redo() && note.body == "Xabc") { "Both come again: '${note.body}'" }
        check(!note.history.canRedo)
        // A cleanup with no step before it stands on its own.
        val alone = Note(body = "a****")
        alone.write("a", EditKind.CLEANUP)
        check(alone.undo() && alone.body == "a****" && !alone.history.canUndo)
    }
    // A new change after Undo empties Redo.
    run {
        val note = Note()
        note.type("one")
        note.now += 2000
        note.type("two")
        note.undo()
        check(note.history.canRedo)
        note.now += 2000
        note.type("3")
        check(!note.history.canRedo && note.body == "one3") { "Redo is gone after a change" }
        check(note.undo() && note.body == "one" && note.undo() && note.body == "")
    }
    // The title is on the same stack as the body.
    run {
        val note = Note()
        note.retitle("L")
        note.retitle("Li")
        note.retitle("List")
        note.type("milk")
        note.retitle("Lists")
        check(note.undo() && note.title == "List" && note.body == "milk")
        check(note.undo() && note.body == "" && note.title == "List")
        val shown = note.history.undo(note.title, note.body)!!
        check(shown.title == "" && shown.field == EditField.TITLE && shown.selFrom < 0) { "The title's typing is one step and leaves the body's caret alone" }
    }
    // Backspace at the sign of a list item (design checklists-77-v3, 4.3): the item joins the line above it in one step
    // of its own, between the letters that went before it and the ones that go after it. Undo brings the item back with
    // the caret behind its sign, and Redo joins it again.
    run {
        val note = Note(body = "- [ ] Milk\n- [ ] ab")
        note.backspace(2)
        val join = signBackspace(note.body, note.caret, 1, emptyList())!!
        check(join.joined && join.text == "- [ ] Milk" && join.caret == 10) { "The empty item joins: ${join.text} ${join.caret}" }
        note.now += 100
        note.write(join.text, EditKind.STEP, join.caret)
        note.backspace(2)
        check(note.body == "- [ ] Mi") { "Backspace goes on in the line above: ${note.body}" }
        check(note.undo() && note.body == "- [ ] Milk" && note.caret == 10) { "First the letters of the line above come back: ${note.body} ${note.caret}" }
        check(note.undo() && note.body == "- [ ] Milk\n- [ ] " && note.caret == 17) { "Then the item, the caret behind its sign: ${note.body} ${note.caret}" }
        check(note.undo() && note.body == "- [ ] Milk\n- [ ] ab" && !note.undo()) { "Then its own letters: ${note.body}" }
        check(note.redo() && note.redo() && note.body == "- [ ] Milk" && note.caret == 10) { "Redo joins it again: ${note.body} ${note.caret}" }
    }
    // What Undo and Redo show: the field and the place of the change.
    run {
        val note = Note(body = "- [ ] a\n- [ ] b\n- [ ] c")
        note.caret = 3
        note.write("- [ ] a\n- [ ] c\n- [ ] b", EditKind.STEP)
        val back = note.history.undo(note.title, note.body)!!
        check(back.field == EditField.BODY && back.from == 14 && back.to == 23 && back.selFrom == 3) { "Undo shows what came back: ${back.from} ${back.to}" }
        val again = note.history.redo(back.title, back.body)!!
        check(again.body == "- [ ] a\n- [ ] c\n- [ ] b" && again.from == 14 && again.to == 23) { "Redo shows what it did" }
        // What is shown is the text that is there after it: what came back, or what was put in again.
        val cut = Note(body = "one two three")
        cut.write("one three", EditKind.STEP)
        val restored = cut.history.undo(cut.title, cut.body)!!
        check(restored.from == 5 && restored.to == 9) { "Undo of a delete shows the text that came back: ${restored.from} ${restored.to}" }
        val gone = cut.history.redo(restored.title, restored.body)!!
        check(gone.from == 5 && gone.to == 5) { "Redo of a delete shows where it went: ${gone.from} ${gone.to}" }
        // With a cleanup joined to it, the step itself is what is shown, both ways.
        val joined = Note(body = "abc  ")
        joined.caret = 0
        joined.type("X")
        joined.write("Xabc", EditKind.CLEANUP)
        val one = joined.history.undo(joined.title, joined.body)!!
        check(one.from == 0 && one.to == 0) { "Undo shows the step, not its cleanup: ${one.from} ${one.to}" }
        val two = joined.history.redo(one.title, one.body)!!
        check(two.body == "Xabc" && two.from == 0 && two.to == 1) { "Redo shows the step, not its cleanup: ${two.from} ${two.to}" }
        // A selection only ever counts for the body.
        val titled = Note()
        titled.history.record(EditField.TITLE, "", "List", EditKind.STEP, 0, 0, 4, 4)
        check(titled.history.undo("List", "")!!.selFrom < 0 && titled.history.redo("", "")!!.selFrom < 0) { "A step of the title moves no caret in the body" }
    }
    // A note that changed without the history knowing (a tick on the card, the sync): the steps go, nothing happens.
    run {
        val note = Note()
        note.type("abc")
        check(note.history.undo("", "abc!") == null && !note.history.canUndo && !note.history.canRedo) { "Undo on another text does nothing" }
        check(note.history.holds("", "abc!")) { "And the history follows the note" }
        val redo = Note()
        redo.type("abc")
        redo.undo()
        check(redo.history.redo("", "x") == null && !redo.history.canRedo) { "Redo on another text does nothing" }
        // A change on a text the history does not know starts a new stack with that change.
        val lost = Note()
        lost.type("abc")
        lost.history.record(EditField.BODY, "other", "other!", EditKind.STEP)
        val back = lost.history.undo("", "other!")
        check(back?.body == "other" && !lost.history.canUndo) { "Only the new step is left" }
    }
    // 500 steps: the oldest go.
    run {
        val note = Note()
        repeat(600) { note.write(note.body + "x", EditKind.STEP) }
        var steps = 0
        while (note.undo()) steps++
        check(steps == 500 && note.body.length == 100) { "At most 500 steps: $steps, ${note.body.length} letters left" }
    }
    // 2 million characters: the oldest go, and a step too big for the stack alone is not kept.
    run {
        val note = Note()
        val big = "y".repeat(600_000)
        repeat(4) { note.write(note.body + big, EditKind.STEP) }
        var steps = 0
        while (note.undo()) steps++
        check(steps == 3) { "The oldest big step went: $steps" }
        val huge = Note()
        huge.write("z".repeat(2_000_001), EditKind.STEP)
        check(!huge.history.canUndo) { "A step over the limit is not kept" }
    }
    // Saving trims the note; the history takes that as a cleanup, so it still fits the note that is read back.
    run {
        val note = Note()
        note.retitle("Shop ")
        note.type("milk")
        note.now += 2000
        note.type("\n")
        note.history.settle("Shop", "milk")
        check(note.history.holds("Shop", "milk")) { "The history holds the note as it is read back" }
        note.title = "Shop"; note.body = "milk"
        check(note.undo() && note.body == "" && note.title == "Shop") { "The Enter the save trimmed is no step: '${note.body}'" }
        check(note.undo() && note.title == "") { "The title goes back whole: '${note.title}'" }
        check(note.redo() && note.title == "Shop" && note.redo() && note.body == "milk" && !note.history.canRedo) { "And comes again as it was saved" }
        // A trim far from the last step is joined to it.
        val far = Note(body = "abc")
        far.type("\n")
        far.moveTo(0)
        far.type("Y")
        far.history.settle("", "Yabc")
        far.body = "Yabc"
        check(far.undo() && far.body == "abc\n") { "The step and the trim go back together: '${far.body}'" }
        check(far.redo() && far.body == "Yabc") { "And come again together: '${far.body}'" }
        // The title's trim belongs to the title's typing, also with typing in the body after it.
        val both = Note()
        both.retitle("Shop ")
        both.type("milk")
        both.history.settle("Shop", "milk")
        both.title = "Shop"
        check(both.undo() && both.body == "" && both.title == "Shop" && both.undo() && both.title == "") { "The title's trim is part of its typing" }
    }
    // The stacks of the notes edited last (4.3): kept by name, only for the text they left, twenty of them.
    run {
        val first = EditHistories.of("note-a", "", "")
        first.record(EditField.BODY, "", "abc", EditKind.STEP)
        EditHistories.keep("note-a", first)
        check(EditHistories.of("note-a", "", "abc") === first) { "The same note with the same text gets its stack back" }
        check(EditHistories.of("note-a", "", "abc!") !== first) { "A note that changed elsewhere gets a new one" }
        check(EditHistories.of("note-a", "", "abc") !== first) { "And the old one is gone for good" }
        val fresh = EditHistories.of("new:1", "", "")
        fresh.record(EditField.BODY, "", "x", EditKind.STEP)
        EditHistories.keep("new:1", fresh)
        EditHistories.rename("new:1", "note-b")
        check(EditHistories.of("note-b", "", "x") === fresh && EditHistories.of("new:1", "", "x") !== fresh) { "A new note keeps its stack under its own name" }
        // A stack with nothing in it takes no place.
        EditHistories.keep("empty", EditHistories.of("empty", "", ""))
        for (number in 1..19) {
            val history = EditHistories.of("n$number", "", "")
            history.record(EditField.BODY, "", "$number", EditKind.STEP)
            EditHistories.keep("n$number", history)
        }
        check(EditHistories.of("note-b", "", "x") === fresh) { "Twenty notes are kept" }
        val more = EditHistories.of("n20", "", "")
        more.record(EditField.BODY, "", "20", EditKind.STEP)
        EditHistories.keep("n20", more)
        check(EditHistories.of("n1", "", "1").canUndo.not()) { "The note used longest ago went" }
        check(EditHistories.of("note-b", "", "x") === fresh) { "A note that was just used stays" }
    }
    // Any run of changes: every Undo and Redo lands on a text the note had, Undo and Redo are each other's opposite,
    // and all the way back is where the note started.
    run {
        val random = Random(77)
        val letters = "ab \n*"
        repeat(3000) { round ->
            val start = (0 until random.nextInt(12)).joinToString("") { letters[random.nextInt(letters.length)].toString() }
            val note = Note(body = start)
            note.caret = random.nextInt(start.length + 1)
            // The title and the body each on their own: a cleanup joins the last step of its own text.
            val titles = hashSetOf("")
            val bodies = hashSetOf(start)
            fun known() = note.title in titles && note.body in bodies
            fun fail(what: String): Nothing = error("Round $round: $what")
            repeat(random.nextInt(40)) {
                note.now += listOf(50L, 200L, 1500L)[random.nextInt(3)]
                when (random.nextInt(11)) {
                    0, 1, 2 -> note.write(note.body.substring(0, note.caret) + letters[random.nextInt(letters.length)] + note.body.substring(note.caret), EditKind.TYPING, note.caret + 1)
                    3 -> if (note.caret > 0) note.write(note.body.removeRange(note.caret - 1, note.caret), EditKind.TYPING, note.caret - 1)
                    4 -> note.moveTo(random.nextInt(note.body.length + 1))
                    5, 6 -> {
                        val from = random.nextInt(note.body.length + 1)
                        val to = from + random.nextInt(note.body.length - from + 1)
                        val next = note.body.replaceRange(from, to, (0 until random.nextInt(4)).joinToString("") { letters[random.nextInt(letters.length)].toString() })
                        note.write(next, listOf(EditKind.STEP, EditKind.CLEANUP, EditKind.TYPING)[random.nextInt(3)], minOf(from, next.length))
                    }
                    7 -> note.retitle(note.title + "t")
                    8 -> {
                        val before = note.title to note.body
                        if (note.undo()) {
                            if (!known()) fail("Undo made a text the note never had: '${note.body}'")
                            if (!note.redo() || (note.title to note.body) != before) fail("Redo is not the opposite of Undo")
                            note.undo()
                        }
                    }
                    9 -> if (note.redo() && !known()) fail("Redo made a text the note never had: '${note.body}'")
                    else -> {
                        note.title = note.title.trim()
                        note.body = note.body.trim('\n')
                        note.caret = minOf(note.caret, note.body.length)
                        note.history.settle(note.title, note.body)
                    }
                }
                if (!note.history.holds(note.title, note.body)) fail("The history lost the note")
                titles += note.title
                bodies += note.body
            }
            while (note.undo()) if (!known()) fail("Undo made a text the note never had: '${note.body}'")
            if (note.title != "" || note.body != start) fail("All the way back is not the start: '${note.title}' '${note.body}' for '$start'")
            while (note.redo()) if (!known()) fail("Redo made a text the note never had")
        }
    }
    println("Android edit history checks passed")
}

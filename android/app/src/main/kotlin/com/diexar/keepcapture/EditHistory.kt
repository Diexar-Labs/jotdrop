package com.diexar.keepcapture

/** Which text of a note a step changed. */
internal enum class EditField { TITLE, BODY }

/**
 * What a change of a note's text was (design checklists-77-v2, 4.2). TYPING joins the typing right before it into one
 * step. A STEP stands on its own: a button, a tick, a drag, Enter, a paste of several lines. A CLEANUP is what the
 * editor tidies up itself (an empty formatting pair, what saving trims): it goes back together with the step before it.
 */
internal enum class EditKind { TYPING, STEP, CLEANUP }

/**
 * The note after Undo or Redo: both texts, the selection of the body ([selFrom] under 0: it stays where it is), and
 * what changed, to show it: [field] from [from] to [to].
 */
internal class EditApplied(val title: String, val body: String, val selFrom: Int, val selTo: Int, val field: EditField, val from: Int, val to: Int)

/**
 * Undo and Redo for one note (design checklists-77-v2, part 4): every change of its title and body as a step, the
 * typing in groups. Plain Kotlin, in memory only.
 *
 * [title] and [body] are the texts as the last step left them. A step is only ever taken back or done again on exactly
 * those texts: when the note is something else (changed on the card, by the sync, by anything that did not come
 * through here) the steps are dropped and nothing happens.
 */
internal class EditHistory(title: String = "", body: String = "", private val clock: () -> Long = System::currentTimeMillis) {
    var title = title
        private set
    var body = body
        private set

    /**
     * One replacement: at [from], [removed] became [inserted]. A selection under 0 is not known (the title, a cleanup).
     * [joined]: it goes back and comes again together with the step under it. [open]: typing can still join it.
     */
    private class Step(val field: EditField, var from: Int, var removed: String, var inserted: String, val selFrom: Int, val selTo: Int) {
        var nextFrom = -1
        var nextTo = -1
        var joined = false
        var open = false
        /** True for typing, false for deleting, null while it only replaced. */
        var grows: Boolean? = null
        val size get() = removed.length + inserted.length
    }

    private val undone = ArrayDeque<Step>()
    private val done = ArrayDeque<Step>()
    private var typedAt = 0L

    val canUndo get() = done.isNotEmpty()
    val canRedo get() = undone.isNotEmpty()

    /** Whether the steps fit a note with these texts. */
    fun holds(title: String, body: String) = this.title == title && this.body == body

    private fun text(field: EditField) = if (field == EditField.TITLE) title else body

    private fun forget(title: String, body: String) {
        done.clear()
        undone.clear()
        this.title = title
        this.body = body
    }

    /** The caret went elsewhere: what is typed next is a new step. */
    fun moved() {
        done.lastOrNull()?.open = false
    }

    /**
     * [field] went from [before] to [after]. [selFrom] and [selTo] are the selection before the change, [nextFrom] and
     * [nextTo] after it; under 0 when there is none to keep.
     */
    fun record(field: EditField, before: String, after: String, kind: EditKind, selFrom: Int = -1, selTo: Int = selFrom, nextFrom: Int = -1, nextTo: Int = nextFrom) {
        if (before == after) return
        // Something changed the note without telling: the steps no longer fit it.
        if (text(field) != before) forget(if (field == EditField.TITLE) before else title, if (field == EditField.BODY) before else body)
        if (field == EditField.TITLE) title = after else body = after
        undone.clear()
        val diff = textDiff(before, after)
        val removed = before.substring(diff.start, diff.endA)
        val inserted = after.substring(diff.start, diff.endB)
        val step = Step(field, diff.start, removed, inserted, selFrom, selTo).also { it.nextFrom = nextFrom; it.nextTo = nextTo }
        // The title and the body are two texts: a step of the other one on top does not stand between this change and
        // the last step of its own text.
        val top = done.lastOrNull { it.field == field }
        val touches = top != null && diff.start <= top.from + top.inserted.length && diff.endA >= top.from
        // Enter, and a Backspace that joins two lines, are steps of their own.
        val typing = kind == EditKind.TYPING && '\n' !in removed && '\n' !in inserted
        val now = clock()
        when {
            kind == EditKind.CLEANUP && top != null && touches -> merge(top, step)
            kind == EditKind.CLEANUP -> { step.joined = done.isNotEmpty(); push(step) }
            typing && top != null && touches && top.open && now - typedAt <= PAUSE_MS && joins(top, step) -> {
                merge(top, step)
                top.open = true
            }
            else -> {
                if (typing) {
                    step.open = true
                    step.grows = grows(step)
                }
                push(step)
            }
        }
        if (typing) typedAt = now
    }

    private fun grows(step: Step): Boolean? = if (step.inserted.isEmpty()) false else if (step.removed.isEmpty()) true else null

    // Typing joins typing and deleting joins deleting; what the keyboard replaces in one go (a word it finishes or
    // corrects) belongs to either. A long group ends where a new word starts.
    private fun joins(top: Step, step: Step): Boolean {
        val grows = grows(step)
        if (grows != null && top.grows != null && grows != top.grows) return false
        if (grows == true && top.inserted.length > GROUP_WORDS_ABOVE && top.inserted.last().isWhitespace() && !step.inserted.first().isWhitespace()) return false
        return true
    }

    /** [step] was made right on what [top] put in the text: the two become one replacement. One that changes nothing goes. */
    private fun merge(top: Step, step: Step) {
        val before = maxOf(0, top.from - step.from)
        val after = maxOf(0, step.from + step.removed.length - (top.from + top.inserted.length))
        val from = minOf(top.from, step.from)
        val shown = step.removed.take(before) + top.inserted + step.removed.takeLast(after)
        top.removed = step.removed.take(before) + top.removed + step.removed.takeLast(after)
        top.inserted = shown.replaceRange(step.from - from, step.from - from + step.removed.length, step.inserted)
        top.from = from
        if (step.nextFrom >= 0) { top.nextFrom = step.nextFrom; top.nextTo = step.nextTo }
        if (top.grows == null) top.grows = grows(step)
        top.open = false
        if (top.removed == top.inserted) done.remove(top)
    }

    private fun push(step: Step) {
        done.lastOrNull()?.open = false
        done.addLast(step)
        // The oldest steps go first. A step that stood joined to one that went is then the oldest itself.
        var size = done.sumOf { it.size }
        while (done.size > MAX_STEPS || (size > MAX_CHARS && done.isNotEmpty())) size -= done.removeFirst().size
    }

    /**
     * Takes the last step back, with the cleanups joined to it. [title] and [body] are the note as it is now. Null when
     * there is nothing to take back, or when the note is not what the steps left: then they are dropped.
     */
    fun undo(title: String, body: String): EditApplied? = replay(title, body, done, undone, back = true)

    /** Does the step that was taken back last again. */
    fun redo(title: String, body: String): EditApplied? = replay(title, body, undone, done, back = false)

    private fun replay(title: String, body: String, source: ArrayDeque<Step>, target: ArrayDeque<Step>, back: Boolean): EditApplied? {
        if (!holds(title, body)) { forget(title, body); return null }
        if (source.isEmpty()) return null
        var newTitle = title
        var newBody = body
        var selFrom = -1
        var selTo = -1
        var shown: Step? = null
        val steps = mutableListOf<Step>()
        while (source.isNotEmpty()) {
            // Back: the cleanups on top first, down to the step they are joined to. Again: that step, then its cleanups.
            if (!back && steps.isNotEmpty() && !source.last().joined) break
            val step = source.removeLast()
            steps += step
            val text = if (step.field == EditField.TITLE) newTitle else newBody
            val old = if (back) step.inserted else step.removed
            val new = if (back) step.removed else step.inserted
            if (!text.regionMatches(step.from, old, 0, old.length)) { forget(title, body); return null }
            val next = text.replaceRange(step.from, step.from + old.length, new)
            if (step.field == EditField.TITLE) newTitle = next else newBody = next
            val caret = if (back) step.selFrom else step.nextFrom
            if (step.field == EditField.BODY && caret >= 0) { selFrom = caret; selTo = if (back) step.selTo else step.nextTo }
            if (shown == null || back) shown = step
            if (back && !step.joined) break
        }
        for (step in steps) { step.open = false; target.addLast(step) }
        this.title = newTitle
        this.body = newBody
        val real = shown!!
        val length = (if (back) real.removed else real.inserted).length
        return EditApplied(newTitle, newBody, selFrom.coerceAtMost(newBody.length), selTo.coerceAtMost(newBody.length), real.field, real.from, real.from + length)
    }

    /**
     * The note was saved and will be read back as [title] and [body] (saving trims the edges of both): what differs
     * from the texts as they are goes on the stack as a cleanup, so the steps still fit the note when it is opened again.
     */
    fun settle(title: String, body: String) {
        record(EditField.TITLE, this.title, title, EditKind.CLEANUP)
        record(EditField.BODY, this.body, body, EditKind.CLEANUP)
    }

    private companion object {
        /** Typing after a pause this long is a new step (Keep groups by a pause too). */
        const val PAUSE_MS = 1000L
        /** A group of typing longer than this ends at the next new word, so one Undo takes back about a line at most. */
        const val GROUP_WORDS_ABOVE = 30
        const val MAX_STEPS = 500
        const val MAX_CHARS = 2_000_000
    }
}

/**
 * The stacks of the notes that were edited last, for as long as the app is in memory (design checklists-77-v2, 4.3):
 * Undo still works after a note is closed and opened again, after going to another note and back, and after turning
 * the phone. Never on disk, never on the server.
 */
internal object EditHistories {
    private const val KEPT = 20
    private val notes = object : LinkedHashMap<String, EditHistory>(KEPT, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, EditHistory>) = size > KEPT
    }

    /** The stack of note [key] when it left the note with exactly this [title] and [body]; a new one otherwise. */
    fun of(key: String, title: String, body: String): EditHistory {
        notes[key]?.let { if (it.holds(title, body)) return it }
        notes.remove(key)
        return EditHistory(title, body)
    }

    /** [history] belongs to note [key] and was just used. One with nothing in it takes no place. */
    fun keep(key: String, history: EditHistory) {
        if (history.canUndo || history.canRedo) notes[key] = history else notes.remove(key)
    }

    /** A new note got its place in the folder: its stack goes on under that name. */
    fun rename(from: String, to: String) {
        notes.remove(from)?.let { notes[to] = it }
    }
}

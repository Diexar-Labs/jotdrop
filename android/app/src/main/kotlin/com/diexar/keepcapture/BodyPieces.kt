package com.diexar.keepcapture

/**
 * The body in the formatted view when it is shown in pieces: pieces of whole lines, with one `\n` between two pieces.
 * The body text stays the only source; the pieces are only how it is shown. A table is a piece of its own (design
 * opmaak-editor 7.2), and with "Move checked items to the bottom" so is the ticked end of a list (design
 * checklists-77-v2, part 6), which stands under a header and folds. A body with neither is one text piece and keeps
 * the one field it always had.
 *
 * [kind] is "text" (text, with code), "table" or "checked". [id] tells the fields of the text and checked pieces
 * apart: the field with the focus keeps its id when the pieces are laid out again (see [PieceLayout]).
 */
internal data class BodyPiece(val kind: String, val from: Int, val to: Int, val id: Int = 0)

/** The pieces of [text]; with [checked] the ticked end of every list (FormatCore.checkedTail) is a piece of its own. */
internal fun bodyPieces(text: String, checked: Boolean = false): List<BodyPiece> {
    val out = mutableListOf<BodyPiece>()
    for (block in FormatCore.blocks(text)) {
        val kind = if (block.kind == "table") "table" else "text"
        val last = out.lastOrNull()
        if (kind == "text" && last?.kind == "text") out[out.size - 1] = last.copy(to = block.to)
        else out += BodyPiece(kind, block.from, block.to)
    }
    // The core gives every text a block, an empty one too: there is always a piece, so always a field to type in.
    return if (checked) cutAtChecked(out, text) else out
}

/** [pieces] with every ticked end of a list in [text] cut out of its text piece as a piece of its own. */
private fun cutAtChecked(pieces: List<BodyPiece>, text: String): List<BodyPiece> {
    val tails = FormatCore.checkedTail(text)
    if (tails.isEmpty()) return pieces
    val starts = lineStarts(text)
    fun end(line: Int) = if (line + 1 < starts.size) starts[line + 1] - 1 else text.length
    val out = mutableListOf<BodyPiece>()
    var next = 0
    for (piece in pieces) {
        var from = piece.from
        while (next < tails.size && starts[tails[next].from] < from) next++
        while (piece.kind == "text" && next < tails.size && starts[tails[next].from] <= piece.to) {
            val first = starts[tails[next].from]
            val last = minOf(end(tails[next].to), piece.to)
            if (first > from) out += BodyPiece("text", from, first - 1)
            out += BodyPiece("checked", first, last)
            from = last + 1
            next++
        }
        if (from == piece.from) out += piece else if (from <= piece.to) out += BodyPiece("text", from, piece.to)
    }
    return out
}

/** Whether [after] can be [before] with only its part between [from] and [to] changed. */
internal fun changedOnlyIn(before: String, after: String, from: Int, to: Int): Boolean =
    from in 0..to && to <= before.length && after.length >= from + (before.length - to) &&
        after.regionMatches(0, before, 0, from) && after.regionMatches(after.length - (before.length - to), before, to, before.length - to)

/**
 * The pieces as the editor shows them. They stay as they are while a text piece has the focus and what is typed
 * changes only that piece, so typing never splits the field under the caret (a table typed by hand turns into a grid
 * when the focus leaves, a task ticked by hand joins the ticked end then). What is not typed (a tick, a drop, Undo)
 * cuts the ticked ends out again at once; the tables wait for the focus as before.
 *
 * The field with the focus is told by its piece's id ([focused], -1 for none). Laid out again, the piece that holds
 * the caret gets that id: the same field then shows it, and the keyboard stays where it is.
 */
internal class PieceLayout {
    private var text: String? = null
    private var key: Any? = null
    private var acts = 0
    // The text and the tables, and those with the ticked ends cut out.
    private var base: List<BodyPiece> = emptyList()
    private var pieces: List<BodyPiece> = emptyList()
    var focused = -1

    /**
     * The pieces of [next]. A new [key] lays everything out again. [checked]: the ticked ends are pieces. [caret] is
     * where the selection starts, and [acts] counts the changes that were not typed.
     */
    fun update(next: String, key: Any, checked: Boolean = false, caret: Int = 0, acts: Int = 0): List<BodyPiece> {
        val before = text
        if (before == next && key == this.key) return pieces
        val typed = acts == this.acts
        val same = before != null && key == this.key
        val at = if (focused < 0) -1 else pieces.indexOfFirst { it.kind != "table" && it.id == focused }
        val piece = pieces.getOrNull(at)
        val delta = next.length - (before?.length ?: 0)
        fun moved(all: List<BodyPiece>, index: Int) = all.mapIndexed { i, it ->
            when {
                i < index -> it
                i == index -> it.copy(to = it.to + delta)
                else -> it.copy(from = it.from + delta, to = it.to + delta)
            }
        }
        val whole = if (piece == null) -1 else base.indexOfFirst { it.kind == "text" && it.from <= piece.from && it.to >= piece.to }
        val inBase = same && whole >= 0 && changedOnlyIn(before!!, next, base[whole].from, base[whole].to)
        if (same && piece != null && typed && changedOnlyIn(before!!, next, piece.from, piece.to)) {
            pieces = moved(pieces, at)
            if (inBase) base = moved(base, whole)
        } else {
            val turn = pieces.take(maxOf(at, 0)).count { it.kind != "table" }
            base = if (inBase) moved(base, whole) else bodyPieces(next)
            pieces = numbered(if (checked) cutAtChecked(base, next) else base, caret, if (at < 0) -1 else turn)
        }
        text = next
        this.key = key
        this.acts = acts
        return pieces
    }

    /**
     * A body that is not shown in pieces (it shows its Markdown signs, or is too long to format): one text piece, for
     * the field with the focus when there is one. So that field stays when the body is shown in pieces again.
     */
    fun whole(next: String): List<BodyPiece> {
        text = null
        base = listOf(BodyPiece("text", 0, next.length))
        pieces = listOf(BodyPiece("text", 0, next.length, maxOf(focused, 0)))
        return pieces
    }

    /**
     * Gives every text and checked piece its id. The piece that holds [caret] gets the id of the field with the focus;
     * when the caret is in none of them (in a table), the piece that stands where that field stood among them ([turn])
     * keeps it, as it always did. No other piece gets that id, so the focus never lands on a piece by chance.
     */
    private fun numbered(found: List<BodyPiece>, caret: Int, turn: Int): List<BodyPiece> {
        var holder = if (focused < 0) -1 else found.indexOfFirst { it.kind != "table" && caret >= it.from && caret <= it.to }
        if (holder < 0 && turn >= 0) {
            var seen = 0
            holder = found.indexOfFirst { it.kind != "table" && seen++ == turn }
        }
        var id = 0
        return found.mapIndexed { index, piece ->
            if (piece.kind == "table") piece
            else if (index == holder) piece.copy(id = focused)
            else {
                if (id == focused) id++
                piece.copy(id = id++)
            }
        }
    }
}

/**
 * How a text or checked piece lies among the others, for an item that is dragged in it (design checklists-77-v2, 6.1:
 * an item is not dragged past the header of the ticked items). FREE: nothing to mind. CHECKED: the piece is the ticked
 * end of a list. UNDER_CHECKED: such a piece stands right above this one.
 */
internal enum class PiecePlace { FREE, CHECKED, UNDER_CHECKED }

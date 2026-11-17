package com.diexar.keepcapture

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntSize
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp

/**
 * The body in the formatted view when it holds a table (design opmaak-editor 7.2): pieces of whole lines, text (with
 * code) and tables, with one `\n` between two pieces. The body text stays the only source; the pieces are only how it
 * is shown. A body without a table is one text piece and keeps the one field it always had.
 */
internal data class BodyPiece(val kind: String, val from: Int, val to: Int)

internal fun bodyPieces(text: String): List<BodyPiece> {
    val out = mutableListOf<BodyPiece>()
    for (block in FormatCore.blocks(text)) {
        val kind = if (block.kind == "table") "table" else "text"
        val last = out.lastOrNull()
        if (kind == "text" && last?.kind == "text") out[out.size - 1] = last.copy(to = block.to)
        else out += BodyPiece(kind, block.from, block.to)
    }
    return out
}

/** Whether [after] can be [before] with only its part between [from] and [to] changed. */
internal fun changedOnlyIn(before: String, after: String, from: Int, to: Int): Boolean =
    from in 0..to && to <= before.length && after.length >= from + (before.length - to) &&
        after.regionMatches(0, before, 0, from) && after.regionMatches(after.length - (before.length - to), before, to, before.length - to)

/**
 * The pieces stay as they are while a text piece has the focus, so typing never splits the field under the caret
 * (a table typed by hand turns into a grid when the focus leaves). Any other change lays the body out again.
 */
internal class PieceLayout {
    private var text: String? = null
    private var key: Any? = null
    private var pieces: List<BodyPiece> = emptyList()
    /** The text piece that has the focus, or -1. */
    var focused = -1

    fun update(next: String, key: Any): List<BodyPiece> {
        val before = text
        if (before == next && key == this.key) return pieces
        val piece = pieces.getOrNull(focused)
        pieces = if (before != null && key == this.key && piece?.kind == "text" && changedOnlyIn(before, next, piece.from, piece.to)) {
            val delta = next.length - before.length
            pieces.mapIndexed { i, it ->
                when {
                    i < focused -> it
                    i == focused -> it.copy(to = it.to + delta)
                    else -> it.copy(from = it.from + delta, to = it.to + delta)
                }
            }
        } else bodyPieces(next)
        text = next
        this.key = key
        return pieces
    }
}

/** The cell that has the focus, for the table bar: [format] applies Bold, Italic or Highlight to the text in it. */
internal data class TableCell(
    val table: Int, val row: Int, val column: Int, val rows: Int, val columns: Int,
    val align: String, val active: List<String>, val format: (String) -> Unit,
)

/** A cell of the [table]-th table in the body that should get the focus (after a new table, row or column). */
internal data class TableFocus(val table: Int, val row: Int, val column: Int)

/**
 * The [index]-th table of the body as a grid (design 5.4): the header bold with a line under it, light lines, every
 * other row a little darker, each column as wide as its text (56 to 220 dp, longer text wraps in the cell). A wide
 * table scrolls sideways in its own frame with the first column standing still; the page itself never scrolls sideways.
 *
 * A cell is a small field of its own. Every change goes into the body at once as one setCell (tableEdit, only that
 * row's line), so saving, closing or going to the next note never loses a cell that is still open. "Next" on the
 * keyboard (or Enter) goes to the next cell; in the last cell it makes a new row. Read-only ([editable] false): a tap
 * opens the note for editing.
 */
@Composable
internal fun TableGrid(
    index: Int,
    source: String,
    foreground: Color,
    background: Color,
    editable: Boolean,
    focus: TableFocus?,
    onFocusDone: () -> Unit,
    onEdit: (FormatCore.TableOp) -> Unit,
    onCell: (TableCell?) -> Unit,
    onTap: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val table = remember(source) { FormatCore.parseTable(source.split('\n')) }
    val rows = table.rows.size + 1
    val columns = table.header.size
    val requesters = remember { HashMap<Long, FocusRequester>() }
    fun requester(row: Int, column: Int) = requesters.getOrPut(row.toLong() shl 32 or column.toLong()) { FocusRequester() }
    var pending by remember { mutableStateOf<kotlin.Pair<Int, Int>?>(null) }
    LaunchedEffect(focus) {
        if (focus != null && focus.table == index) {
            pending = focus.row.coerceIn(0, rows - 1) to focus.column.coerceIn(0, columns - 1)
            onFocusDone()
        }
    }
    // A new row or column is only there after the body is laid out again, so the focus waits for it.
    LaunchedEffect(pending, rows, columns) {
        val (row, column) = pending ?: return@LaunchedEffect
        if (row >= rows || column >= columns) return@LaunchedEffect
        repeat(3) {
            withFrameNanos {}
            if (runCatching { requester(row, column).requestFocus() }.isSuccess) { pending = null; return@LaunchedEffect }
        }
        pending = null
    }
    val currentRows by rememberUpdatedState(rows)
    val currentColumns by rememberUpdatedState(columns)
    fun next(row: Int, column: Int) {
        val at = row * currentColumns + column + 1
        if (at >= currentRows * currentColumns) {
            onEdit(FormatCore.TableOp("addRow", after = currentRows - 1))
            pending = currentRows to 0
        } else pending = at / currentColumns to at % currentColumns
    }

    val shape = RoundedCornerShape(8.dp)
    val scroll = rememberScrollState()
    Box(
        modifier = modifier
            .clip(shape)
            .background(background)
            .border(1.dp, foreground.copy(alpha = 0.2f), shape)
            .then(if (editable) Modifier else Modifier.clickable(onClick = onTap))
            .horizontalScroll(scroll),
    ) {
        Layout(content = {
            for (row in 0 until rows) for (column in 0 until columns) key(row, column) {
                val cellSource = if (row == 0) table.header[column] else table.rows[row - 1][column]
                TableCellBox(
                    source = cellSource,
                    row = row,
                    column = column,
                    align = table.align.getOrElse(column) { "" },
                    shape = Triple(rows, columns, table.align),
                    foreground = foreground,
                    background = background,
                    editable = editable,
                    requester = requester(row, column),
                    onCommit = { text -> onEdit(FormatCore.TableOp("setCell", row = row, column = column, text = text)) },
                    onNext = { next(row, column) },
                    onFocus = { cell -> onCell(cell?.let { TableCell(index, row, column, rows, columns, table.align.getOrElse(column) { "" }, it.first, it.second) }) },
                )
            }
        }) { measurables, _ ->
            val minWidth = 56.dp.roundToPx()
            val maxWidth = 220.dp.roundToPx()
            val widths = IntArray(columns) { column ->
                (0 until rows).maxOf { measurables[it * columns + column].maxIntrinsicWidth(Constraints.Infinity) }.coerceIn(minWidth, maxWidth)
            }
            val heights = IntArray(rows) { row -> (0 until columns).maxOf { measurables[row * columns + it].minIntrinsicHeight(widths[it]) } }
            val placeables = measurables.mapIndexed { i, cell -> cell.measure(Constraints.fixed(widths[i % columns], heights[i / columns])) }
            val width = widths.sum()
            layout(width, heights.sum()) {
                // The first column stands still: placed where the visible part of the frame starts, over the others.
                val fixed = if (columns > 1) scroll.value.coerceIn(0, maxOf(0, width - widths[0])) else 0
                var y = 0
                for (row in 0 until rows) {
                    var x = 0
                    for (column in 0 until columns) {
                        val cell = placeables[row * columns + column]
                        if (column == 0) cell.place(fixed, y, zIndex = 1f) else cell.place(x, y)
                        x += widths[column]
                    }
                    y += heights[row]
                }
            }
        }
    }
}

/** One cell; [onFocus] gets its active formats and its format function while it has the focus, null when it loses it. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TableCellBox(
    source: String,
    row: Int,
    column: Int,
    align: String,
    shape: Any,
    foreground: Color,
    background: Color,
    editable: Boolean,
    requester: FocusRequester,
    onCommit: (String) -> Unit,
    onNext: () -> Unit,
    onFocus: (kotlin.Pair<List<String>, (String) -> Unit>?) -> Unit,
) {
    val label = if (row == 0) stringResource(R.string.table_cell_header, column + 1) else stringResource(R.string.table_cell, row, column + 1)
    val style = MaterialTheme.typography.bodyMedium.merge(
        TextStyle(
            color = foreground,
            fontWeight = if (row == 0) FontWeight.Bold else null,
            textAlign = when (align) { "center" -> TextAlign.Center; "right" -> TextAlign.End; else -> TextAlign.Start },
        ),
    )
    val tint = when {
        row == 0 -> foreground.copy(alpha = 0.08f)
        row % 2 == 0 -> foreground.copy(alpha = 0.04f)
        else -> Color.Transparent
    }
    val line = foreground.copy(alpha = if (row == 0) 0.45f else 0.15f)
    val frame = Modifier
        .background(background)
        .background(tint)
        .drawBehind {
            val stroke = if (row == 0) 2.dp.toPx() else 1.dp.toPx()
            drawLine(line, Offset(0f, size.height - stroke / 2), Offset(size.width, size.height - stroke / 2), stroke)
            drawLine(foreground.copy(alpha = 0.12f), Offset(size.width - 0.5f, 0f), Offset(size.width - 0.5f, size.height), 1.dp.toPx())
        }
        .padding(horizontal = 8.dp, vertical = 6.dp)
    if (!editable) {
        Box(frame) { Text(formatBody(FormatCore.cellText(source), true, foreground), style = style) }
        return
    }

    // While the cell has the focus it shows its own value; [mine] is the source that value stands for. When the source
    // changes under it (a row taken away), the cell shows the new source again.
    var local by remember { mutableStateOf(TextFieldValue("")) }
    var mine by remember { mutableStateOf<String?>(null) }
    var focused by remember { mutableStateOf(false) }
    val currentSource by rememberUpdatedState(source)
    val commit by rememberUpdatedState(onCommit)
    val report by rememberUpdatedState(onFocus)
    fun shownValue(): TextFieldValue = if (focused && currentSource == mine) local
        else FormatCore.cellText(currentSource).let { TextFieldValue(it, TextRange(if (focused) it.length else 0)) }
    val shown = shownValue()
    fun take(value: TextFieldValue) {
        local = value
        val text = value.withoutEmptyPair().text
        mine = FormatCore.cellSource(text)
        if (mine != currentSource) commit(text)
    }
    val format: (String) -> Unit = { command -> shownValue().withFormat(command)?.let(::take) }
    val active = if (focused) FormatCore.activeFormats(shown.text, shown.selection.min, shown.selection.max) else emptyList()
    // Told again when the table around the cell changes, so the table bar shows its alignment and what can go.
    LaunchedEffect(focused, active, shape) { if (focused) report(active to format) }
    DisposableEffect(Unit) { onDispose { if (focused) report(null) } }
    val pair = FormatCore.emptyPair(shown.text, shown.selection.min, shown.selection.max)
    // The cell with the focus stays whole above the table bar and the keyboard, with some room around it, as the
    // caret does in the text (on the phone the field's own scrolling left half the row under the bar).
    val cellView = remember { BringIntoViewRequester() }
    var cellSize by remember { mutableStateOf(IntSize.Zero) }
    val margin = with(LocalDensity.current) { 24.dp.toPx() }
    val keyboard = WindowInsets.ime.getBottom(LocalDensity.current)
    LaunchedEffect(focused, shown.text, cellSize, keyboard) {
        if (focused && cellSize != IntSize.Zero) {
            cellView.bringIntoView(Rect(0f, -margin, cellSize.width.toFloat(), cellSize.height + margin))
        }
    }
    Box(frame.bringIntoViewRequester(cellView).onSizeChanged { cellSize = it }) {
        BasicTextField(
            value = shown,
            onValueChange = { field ->
                val shown = shownValue()
                var next = shown.backspacing(field, true)
                // Enter goes to the next cell; a pasted line break becomes a space.
                val enter = next.text.length == shown.text.length + 1 && next.selection.collapsed && next.selection.start > 0 &&
                    next.text[next.selection.start - 1] == '\n' && next.text.removeRange(next.selection.start - 1, next.selection.start) == shown.text
                if (enter) next = shown
                else if (next.text.contains('\n')) next = next.copy(text = next.text.replace("\r\n", " ").replace('\n', ' '))
                take(next)
                if (enter) onNext()
            },
            modifier = Modifier
                .focusRequester(requester)
                .onFocusChanged { state ->
                    if (state.isFocused == focused) return@onFocusChanged
                    focused = state.isFocused
                    if (focused) {
                        mine = currentSource
                        local = FormatCore.cellText(currentSource).let { TextFieldValue(it, TextRange(it.length)) }
                    } else report(null)
                }
                .semantics { contentDescription = label },
            textStyle = style,
            cursorBrush = SolidColor(foreground),
            visualTransformation = FormatTransformation(true, foreground, pair?.from ?: -1, pair?.to ?: -1),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Next),
            keyboardActions = KeyboardActions(onNext = { onNext() }),
        )
    }
}

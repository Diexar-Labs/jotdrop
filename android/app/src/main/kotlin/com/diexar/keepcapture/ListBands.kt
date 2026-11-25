package com.diexar.keepcapture

import android.graphics.Paint
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.style.ResolvedTextDirection
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt

/** An item that landed on a new place keeps its frame this long, fading (design checklists-77-v2, 5.1). */
internal const val GLOW_MS = 600f

/** What lifts an item off the note (its own background, its shadow) fades this fast once it is on its place. */
internal const val SETTLE_MS = 150f

/**
 * The lines of a text as it is laid out, as heights: a line of the note can take several lines on the screen.
 * [starts] holds where each line of the note starts in the text as shown.
 */
internal class LineHeights(val layout: TextLayoutResult, val starts: IntArray) {
    private val length = layout.layoutInput.text.length
    val lines get() = starts.size

    /** False while the layout is a frame behind the text. */
    val fits = starts.isEmpty() || starts.last() <= length

    private fun first(line: Int) = layout.getLineForOffset(starts[line].coerceIn(0, length))
    private fun last(line: Int) = layout.getLineForOffset((if (line + 1 < starts.size) starts[line + 1] - 1 else length).coerceIn(0, length))

    fun top(line: Int): Float = layout.getLineTop(first(line))
    fun bottom(line: Int): Float = layout.getLineBottom(last(line))

    /** The bottom of the first line on the screen: next to it stand the box, the dots and the cross. */
    fun firstBottom(line: Int): Float = layout.getLineBottom(first(line))

    /** The first line that ends under height [y]; the number of lines when there is none. */
    fun under(y: Float): Int {
        var low = 0
        var high = starts.size
        while (low < high) {
            val middle = (low + high) / 2
            if (bottom(middle) > y) high = middle else low = middle + 1
        }
        return low
    }
}

/** What the grips stand on, as the last composition has it. */
internal class GripsShown(
    val heights: LineHeights, val starts: IntArray, val boxes: List<TaskBox>, val byLine: Map<Int, TaskBox>, val layout: TextLayoutResult,
    val whole: String, val above: Int, val mayRtl: Boolean, val actions: ItemActions, val onTick: (Int) -> Unit,
    val foreground: Color, val background: Color, val scroll: GripScroll?,
    // The line with the caret, or -1: a task has its cross there, in the other margin.
    val caret: Int,
    // In pixels: the room between the screen's edge and the text, where the dots and the cross stand in it, a level of
    // a list, and half a screen (the dots near what is in sight are drawn). [pad] is how far the frame around an item
    // reaches out of the text: its dots stand in it.
    val margin: Float, val dotsAt: Float, val crossAt: Float, val levelStep: Float, val half: Float, val pad: Float,
) {
    fun rtl(box: TaskBox) = mayRtl && box.at < layout.layoutInput.text.length && layout.getBidiRunDirection(box.at) == ResolvedTextDirection.Rtl
}

/**
 * An item on its way: its own lines in this text ([line] to [end]), the places it may land, and where the finger is.
 * The text stays as it is until the finger lets go; the lines between the item's own place and where it would land
 * make room by being drawn a block further ([room]).
 */
internal class ItemDrag(
    val line: Int, val end: Int, val level: Int, val slots: List<FormatCore.Slot>, val rtl: Boolean,
    val whole: String, val lines: Int, val startX: Float, val startY: Float,
    // The finger's height in the text's own measure when it came down on the handle, and the item's height.
    val grab: Float, val height: Float,
) {
    // The finger, on the whole screen: the note can scroll under it.
    var x by mutableFloatStateOf(startX)
    var y by mutableFloatStateOf(startY)

    /** Where the item would land now. */
    var to by mutableStateOf<DropTarget?>(null)

    // Whether the note may scroll along up and down: not yet for an item that was picked up next to that edge.
    var scrollsUp = false
    var scrollsDown = false

    val room = RoomMade(line, end, lines, height)
}

/**
 * An item the finger let go of: it glides to its place, the lines around it to theirs, and on a new place it keeps its
 * frame a moment, so the eye finds it among lines that look alike (design checklists-77-v2, 5.1). The text is the new
 * one already ([whole], of [lines] lines), and [places] has the item's lines in it and where everything stood. [x] is
 * how far the item stood to the side; [moved] is false for an item that goes back to its own place.
 */
internal class Landing(val whole: String, val lines: Int, val places: Settling, val x: Float, val moved: Boolean) {
    /** When the finger let go, on the clock of the frames. */
    val since = System.nanoTime()

    /** Milliseconds since then, as of the frame that is drawn. */
    var at by mutableFloatStateOf(0f)

    val total get() = SLIDE_MS + if (moved) GLOW_MS else SETTLE_MS

    /** What is left of the way: 1 when the finger let go, 0 once everything is on its place. It slows down as it gets there. */
    val left: Float get() {
        val done = (at / SLIDE_MS).coerceIn(0f, 1f)
        return (1f - done) * (1f - done)
    }

    /** How much of the frame and of the item's own background is left, each from 1 to 0. */
    val frame get() = (1f - (at - SLIDE_MS) / (if (moved) GLOW_MS else SETTLE_MS)).coerceIn(0f, 1f)
    val lifted get() = (1f - (at - SLIDE_MS) / SETTLE_MS).coerceIn(0f, 1f)
}

/**
 * The part of the grips that is drawn with the text itself (design checklists-77-v2, 5.2): the dots of the handles,
 * the cross, and, while an item is dragged, the text in bands. The text does not change during a drag. The field draws its own
 * content several times, each time cut to some lines and moved: the lines the item passed a block further, the item
 * itself last, under the finger, on a background of its own. So the lines make room and the item follows the finger
 * while the keyboard, the caret and the handles' places stay what they were.
 *
 * [modifier] goes on what draws the text (inside the text field, so the caret and a selection move with their lines);
 * ListGrips, laid over the text, tells this what is there and what the finger does.
 */
internal class ItemBands {
    var shown by mutableStateOf<GripsShown?>(null)

    /** The text as it is laid out now. The field tells it while it is measured: the composition has it a frame later. */
    var layout: TextLayoutResult? = null

    var drag by mutableStateOf<ItemDrag?>(null)
    var landing by mutableStateOf<Landing?>(null)

    /** The lines of the item under a finger that is on its handle and has not moved yet. */
    var held by mutableStateOf<IntRange?>(null)

    /**
     * True from the moment a finger has an item until every line is on its place again. What the text field lays over
     * its text by itself (the drop under the caret, the handles of a selection) cannot go along with a line that is
     * drawn elsewhere and is not shown then. It goes when the finger comes down, before anything moves: taking it away
     * composes the field again, and with hundreds of tasks that is a slow frame (measured 25 Nov).
     */
    val busy by derivedStateOf { held != null || drag != null || landing?.let { it.at < SLIDE_MS } == true }

    /** Which half screen of the text is in sight: the dots from a screen above it to a screen below it are drawn. */
    var band by mutableIntStateOf(0)

    /** Where the text stands on the screen. */
    var origin: LayoutCoordinates? = null

    /** The frame in which a line last moved: drawing follows it. */
    var clock by mutableLongStateOf(0L)

    private var measured: LineHeights? = null

    /** The heights of [now]'s lines in the layout of this frame. */
    fun heights(now: GripsShown): LineHeights {
        val laid = layout ?: return now.heights
        if (laid === now.layout) return now.heights
        measured?.takeIf { it.layout === laid && it.starts === now.starts }?.let { return it }
        return LineHeights(laid, now.starts).also { measured = it }
    }

    fun clear() {
        shown = null
        drag = null
        landing = null
        held = null
    }

    val modifier: Modifier = Modifier.drawWithContent { draw() }

    private val lift = Paint(Paint.ANTI_ALIAS_FLAG)

    private fun ContentDrawScope.draw() {
        val now = shown
        val heights = now?.let { heights(it) }?.takeIf { it.fits }
        if (now == null || heights == null) {
            drawContent()
            return
        }
        val dragging = drag?.takeIf { it.whole == now.whole && it.lines == heights.lines }
        val landed = if (dragging != null) null else landing?.takeIf { it.whole == now.whole && it.lines == heights.lines }
        if (dragging == null && landed == null) {
            drawContent()
            // The dots of the handles near what is on the screen, the cross, and the frame around an item under a finger.
            val grip = held?.takeIf { it.last < heights.lines }
            val from = (band - 2) * now.half
            val to = (band + 5) * now.half
            for (box in now.boxes) {
                if (box.line >= heights.lines) continue
                val top = heights.top(box.line)
                if (top < from) continue
                if (top > to) break
                grips(now, heights, box, grip?.first == box.line)
            }
            if (grip != null) frame(now, heights.top(grip.first), heights.bottom(grip.last), 1f)
            return
        }

        // Drawing follows the frames of the drag, and the note as it scrolls under the finger.
        clock
        now.scroll?.state?.value
        val base = origin?.takeIf { it.isAttached }?.positionInRoot()?.y
        // Only what is in sight is drawn again in every frame: a long list costs no more than a short one.
        val slack = 48.dp.toPx()
        val sightTop = if (now.scroll == null || base == null) Float.NEGATIVE_INFINITY else now.scroll.top - base - slack
        val sightBottom = if (now.scroll == null || base == null) Float.POSITIVE_INFINITY else now.scroll.bottom - base + slack

        val first: Int
        val last: Int
        val blockX: Float
        val blockY: Float
        val glow: Float
        val lifted: Float
        val reach: Float
        if (dragging != null) {
            first = dragging.line
            last = dragging.end
            val to = dragging.to
            val levels = if (to == null) 0 else minOf(to.level, LIST_LEVELS_DRAWN - 1) - minOf(dragging.level, LIST_LEVELS_DRAWN - 1)
            blockX = levels * now.levelStep * if (dragging.rtl) -1f else 1f
            blockY = if (base == null) 0f else dragging.y - base - dragging.grab
            glow = 1f
            lifted = 1f
            reach = dragging.height
        } else {
            landed!!.places.resolve(heights::top)
            first = landed.places.line
            last = landed.places.end
            blockX = landed.x * landed.left
            blockY = landed.places.ofItem(landed.left)
            glow = landed.frame
            lifted = landed.lifted
            reach = heights.bottom(last) - heights.top(first)
        }
        // On whole pixels: the letters stay sharp.
        fun offOf(index: Int): Float = (dragging?.room?.of(index) ?: landed!!.places.of(index, landed.left)).roundToInt().toFloat()

        val left = -now.margin
        val right = size.width + now.margin
        // A line stands at most a block from its place.
        var index = heights.under(sightTop - reach)
        while (index < heights.lines && heights.top(index) < sightBottom + reach) {
            if (index in first..last) { index = last + 1; continue }
            val off = offOf(index)
            var end = index
            while (end + 1 < heights.lines && end + 1 !in first..last && heights.top(end + 1) < sightBottom + reach && offOf(end + 1) == off) end++
            val top = maxOf(heights.top(index), sightTop - off)
            val bottom = minOf(heights.bottom(end), sightBottom - off)
            if (bottom > top) withTransform({ translate(0f, off); clipRect(left, top, right, bottom) }) {
                this@draw.drawContent()
                for (line in index..end) now.byLine[line]?.let { grips(now, heights, it, false) }
            }
            index = end + 1
        }

        // The item itself, last: over the lines it passes.
        val top = heights.top(first)
        val bottom = heights.bottom(last)
        withTransform({ translate(blockX, blockY.roundToInt().toFloat()) }) {
            if (lifted > 0f) drawIntoCanvas { canvas ->
                val pad = now.pad
                val corner = 8.dp.toPx()
                lift.color = now.background.copy(alpha = lifted).toArgb()
                lift.setShadowLayer(10.dp.toPx(), 0f, 3.dp.toPx(), Color.Black.copy(alpha = 0.28f * lifted).toArgb())
                canvas.nativeCanvas.drawRoundRect(-pad, top, size.width + pad, bottom, corner, corner, lift)
            }
            clipRect(left, top, right, bottom) {
                this@draw.drawContent()
                for (line in first..last) now.byLine[line]?.let { grips(now, heights, it, line == first && dragging != null) }
            }
            if (glow > 0f) frame(now, top, bottom, glow)
        }
    }

    /** The frame around an item: a light fill and a line, as wide as the text and a little more. */
    private fun DrawScope.frame(now: GripsShown, top: Float, bottom: Float, strength: Float) {
        val corner = CornerRadius(8.dp.toPx())
        val area = Size(size.width + 2 * now.pad, bottom - top)
        drawRoundRect(now.foreground.copy(alpha = 0.07f * strength), Offset(-now.pad, top), area, corner)
        drawRoundRect(now.foreground.copy(alpha = 0.55f * strength), Offset(-now.pad, top), area, corner, style = Stroke(1.5.dp.toPx()))
    }

    /** What stands in the margins next to the task [box]: the dots of its handle, and the cross when the caret is in it. */
    private fun DrawScope.grips(now: GripsShown, heights: LineHeights, box: TaskBox, picked: Boolean) {
        dots(now, heights, box, picked)
        if (box.line == now.caret) cross(now, heights, box)
    }

    /** The cross of the task [box], in the other margin next to its first line on the screen. */
    private fun DrawScope.cross(now: GripsShown, heights: LineHeights, box: TaskBox) {
        val x = if (now.rtl(box)) now.crossAt - now.margin else size.width + now.margin - now.crossAt
        val y = (heights.top(box.line) + heights.firstBottom(box.line)) / 2
        val arm = 5.5.dp.toPx()
        val stroke = 2.dp.toPx()
        val color = now.foreground.copy(alpha = 0.8f)
        drawLine(color, Offset(x - arm, y - arm), Offset(x + arm, y + arm), stroke, StrokeCap.Round)
        drawLine(color, Offset(x - arm, y + arm), Offset(x + arm, y - arm), stroke, StrokeCap.Round)
    }

    /** The six dots of the handle of the task [box], in the margin next to its first line on the screen. */
    private fun DrawScope.dots(now: GripsShown, heights: LineHeights, box: TaskBox, picked: Boolean) {
        val top = heights.top(box.line)
        val x = if (now.rtl(box)) size.width + now.margin - now.dotsAt else now.dotsAt - now.margin
        val y = (top + heights.firstBottom(box.line)) / 2
        val gap = 3.dp.toPx()
        // The item on its way or under a finger shows its dots full, the others stay calm (a shape, not only a color).
        val color = now.foreground.copy(alpha = if (picked) 1f else 0.45f)
        val radius = (if (picked) 2f else 1.5f).dp.toPx()
        for (column in -1..1 step 2) for (row in -1..1) drawCircle(color, radius, Offset(x + column * gap, y + row * 2 * gap))
    }
}

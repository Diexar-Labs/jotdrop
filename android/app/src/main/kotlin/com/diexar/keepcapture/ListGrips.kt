package com.diexar.keepcapture

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitVerticalTouchSlopOrCancellation
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.platform.ViewConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.ResolvedTextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The note's scrolling and the part of the screen that shows the note, for a drag that nears its edge (design
 * checklists-77, 6.1). [top] and [bottom] are heights on the whole screen.
 */
internal class GripScroll(val state: ScrollState) {
    var top = 0f
    var bottom = 0f
}

/**
 * What the grips and keys of a list item ask of the editor (design checklists-77, part 6). Every line counts in the
 * whole body. [act] is an action a screen reader offers on a task ("up", "down", "in", "out" or "delete"), [moveKey]
 * Alt with an arrow from a keyboard ("up" or "down", for the item with the caret; false when the caret is in no list).
 * The others say whether the body changed.
 */
internal class ItemActions(
    val drop: (line: Int, before: Int, level: Int) -> Boolean,
    val delete: (line: Int) -> Boolean,
    val act: (line: Int, action: String) -> Boolean,
    val moveKey: (direction: String) -> Boolean,
)

/** The body's text starts this far from the screen's edge: the column's 16 dp and the field's own 16 dp. */
private val BODY_MARGIN = 32.dp

/** The six dots stand this far from the screen's edge: a drag that starts nearer to it can be the phone's Back (part 18). */
private val HANDLE_DOTS_AT = 26.dp

/** A finger that rests this long on a handle gets the buzz of picking up before it moves: some people wait for one. */
private const val HANDLE_REST_MS = 150L

/** A box's place to tap: this wide, and it ends this far past the box (see TaskBoxes). */
internal val BOX_REACH = 40.dp
private val BOX_SLACK = 4.dp

/** The left of the place to tap of the box at [at], in the measure of the text as it is laid out. */
internal fun boxReachLeft(layout: TextLayoutResult, at: Int, density: Density): Float {
    val glyph = layout.getBoundingBox(at)
    return with(density) {
        if (layout.getBidiRunDirection(at) == ResolvedTextDirection.Rtl) glyph.left - BOX_SLACK.toPx() else glyph.right + BOX_SLACK.toPx() - BOX_REACH.toPx()
    }
}

/** The cross's place to touch, against the other edge of the screen. */
private val CROSS_REACH = 36.dp

/** Near the top or bottom of the note's view a drag scrolls the note, at most this fast per second. */
private val DRAG_SCROLL_EDGE = 56.dp
private val DRAG_SCROLL_SPEED = 900.dp

/**
 * The lines of a text as it is laid out, as heights: a line of the note can take several lines on the screen.
 * [starts] holds where each line of the note starts in the text as shown.
 */
internal class LineHeights(private val layout: TextLayoutResult, private val starts: IntArray) {
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
}

/** An item on its way: its own lines in this text, what is under it, the places it may land and where the finger is. */
private class ItemDrag(
    val line: Int, val end: Int, val count: Int, val level: Int,
    val slots: List<FormatCore.Slot>, val label: String, val rtl: Boolean, val whole: String, val startX: Float,
) {
    // The finger, on the whole screen: the note can scroll under it.
    var x by mutableFloatStateOf(startX)
    var y by mutableFloatStateOf(0f)
    var startY = 0f
    var last: DropTarget? = null

    // Whether the note may scroll along up and down: not yet for an item that was picked up next to that edge.
    var scrollsUp = false
    var scrollsDown = false
}

/** What the grips stand on, as it is now. */
private class GripsShown(
    val heights: LineHeights, val byLine: Map<Int, TaskBox>, val layout: TextLayoutResult, val metrics: ListMetrics,
    val whole: String, val above: Int, val mayRtl: Boolean, val actions: ItemActions, val onTick: (Int) -> Unit,
) {
    fun rtl(box: TaskBox) = mayRtl && box.at < layout.layoutInput.text.length && layout.getBidiRunDirection(box.at) == ResolvedTextDirection.Rtl
}

// Hebrew, Arabic and the scripts next to them, with their presentation forms.
private fun CharSequence.hasRightToLeft() = any { it.code in 0x0590..0x08FF || it.code in 0xFB1D..0xFDFF || it.code in 0xFE70..0xFEFF }

/**
 * The grips on the tasks of an open note, laid over its text (design checklists-77, parts 5 and 6): a handle of six
 * dots in the margin in front of every task, and a cross in the other margin on the task with the caret. The text
 * stays one text; a grip makes one replacement through the shared core.
 *
 * This layer lies next to the text field, over it, never in it: a finger on a handle or on the cross is then no touch
 * of the text. In the field, a finger that rests on a handle before it drags was a long press too, and the field
 * picked a word and showed its magnifier under the drag (seen on Eric's phone, 22 Nov).
 *
 * A finger that comes on a handle has the item at once, and that shows: the item's own lines get a frame and the
 * dots stand full. A short buzz follows when the finger rests there or starts to drag. Some people hold still first
 * and wait for such a sign (seen in a finger test, 23 Nov); nobody has to. Dragging starts as soon as the finger moves
 * up or down. A small card with the item's first words follows the finger, and a thick line with a dot shows where it
 * lands: the text itself stays put until the finger lets go. The line's start shows the level; going sideways picks
 * another one where the place takes it. A drag that starts sideways is left alone: at the screen's edge that is the
 * phone's Back. Near the top or bottom of the view the note scrolls along.
 *
 * [boxes] are the tasks, [starts] where each line of this text starts in the text as shown and [layout] how it is laid
 * out. [whole] is the whole body and [above] the number of its lines above this text (a body with a table is shown in
 * pieces). [caret] is the line with the caret, or -1: no cross (the read view has no caret). A screen reader does not
 * see the handles (it cannot drag): the box has the same moves as actions.
 */
@Composable
internal fun ListGrips(
    boxes: List<TaskBox>,
    starts: IntArray,
    layout: TextLayoutResult?,
    metrics: ListMetrics,
    whole: String,
    above: Int,
    caret: Int,
    foreground: Color,
    scroll: GripScroll?,
    actions: ItemActions,
    onTick: (Int) -> Unit,
) {
    if (layout == null || boxes.isEmpty() || starts.isEmpty()) return
    val density = LocalDensity.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    // On a phone that reads right to left every line starts at the right; else only a line of such words can.
    val mirrored = LocalLayoutDirection.current == LayoutDirection.Rtl
    val mayRtl = remember(layout, mirrored) { mirrored || layout.layoutInput.text.hasRightToLeft() }
    val byLine = remember(boxes) { boxes.associateBy { it.line } }
    val shown by rememberUpdatedState(GripsShown(remember(layout, starts) { LineHeights(layout, starts) }, byLine, layout, metrics, whole, above, mayRtl, actions, onTick))
    val margin = with(density) { BODY_MARGIN.roundToPx() }
    // The handle's place to touch: from the screen's edge to where the box of a task that is not a sub-item starts
    // (design checklists-77, part 5). A finger aimed at the dots comes down up to there (measured 23 Nov).
    val reach = margin + metrics.toPx(TASK_SHIFT).roundToInt()
    val boxReach = with(density) { BOX_REACH.toPx() }
    val crossReach = with(density) { CROSS_REACH.roundToPx() }
    val half = with(density) { LocalConfiguration.current.screenHeightDp.dp.toPx() } / 2
    val levelStep = with(density) { DRAG_LEVEL_STEP.dp.toPx() }
    val configuration = LocalViewConfiguration.current
    val exact = remember(configuration) {
        object : ViewConfiguration by configuration { override val minimumTouchTargetSize get() = DpSize.Zero }
    }
    val origin = remember { arrayOfNulls<LayoutCoordinates>(1) }
    var width by remember { mutableIntStateOf(0) }
    var band by remember { mutableIntStateOf(0) }
    var drag by remember { mutableStateOf<ItemDrag?>(null) }
    // The lines of the item under a finger that is on its handle and has not moved yet.
    var held by remember { mutableStateOf<IntRange?>(null) }

    /** The lines of the item on [line], with all that hangs under it. */
    fun itemLines(line: Int): IntRange? {
        val now = shown
        val span = FormatCore.itemSpan(now.whole, now.above + line) ?: return null
        return line..(span.end - now.above).coerceIn(line, now.heights.lines - 1)
    }

    /** Whether [at], in this text's own measure, is on the place to tap of the box on [line] (see TaskBoxes). */
    fun onBox(line: Int, at: Offset): Boolean {
        val now = shown
        val box = now.byLine[line] ?: return false
        if (!now.heights.fits || line >= now.heights.lines || box.at >= now.layout.layoutInput.text.length) return false
        val left = boxReachLeft(now.layout, box.at, density)
        return at.x >= left && at.x <= left + boxReach && at.y >= now.heights.top(line) && at.y <= now.heights.firstBottom(line)
    }

    /** The finger of [dragging] in this text's own measure, or null when the text is not on the screen. */
    fun finger(dragging: ItemDrag): Offset? {
        // The note scrolled under a finger that holds still: asked again then.
        scroll?.state?.value
        val base = origin[0]?.takeIf { it.isAttached } ?: return null
        return Offset(dragging.x, dragging.y) - base.positionInRoot()
    }

    fun target(dragging: ItemDrag): DropTarget? {
        val now = shown
        if (!now.heights.fits || now.whole != dragging.whole) return null
        val at = finger(dragging) ?: return null
        val side = (dragging.x - dragging.startX) / levelStep
        return dropTarget(dragging.slots, dragging.line, dragging.end, dragging.level, now.heights.lines, at.y,
            (if (dragging.rtl) -side else side).roundToInt(), now.heights::top, now.heights::bottom)
    }

    fun begin(line: Int, at: Offset): Boolean {
        val now = shown
        val box = now.byLine[line] ?: return false
        val span = FormatCore.itemSpan(now.whole, now.above + line) ?: return false
        val level = FormatCore.listLevels(now.whole).getOrElse(now.above + line) { -1 }
        val slots = dropSlotsIn(now.whole, now.above, line)
        if (level < 0 || slots.isEmpty()) return false
        val end = (span.end - now.above).coerceIn(line, now.heights.lines - 1)
        drag = ItemDrag(line, end, span.count, level, slots, box.label, now.rtl(box), now.whole, at.x).also { it.y = at.y; it.startY = at.y }
        return true
    }

    fun move(at: Offset) {
        val dragging = drag ?: return
        dragging.x = at.x
        dragging.y = at.y
        // A light tick when the place it lands changes.
        val to = target(dragging)
        if (to != dragging.last) {
            if (dragging.last != null) haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
            dragging.last = to
        }
    }

    fun end(dropped: Boolean) {
        val dragging = drag ?: return
        val to = if (dropped) target(dragging) else null
        drag = null
        if (to != null && (to.before != dragging.line || to.level != dragging.level)) {
            shown.actions.drop(shown.above + dragging.line, shown.above + to.before, to.level)
        }
    }

    // Near the top or the bottom of the note's view the note scrolls along, faster the nearer the finger is to the edge.
    // An item that is picked up next to an edge does not scroll the note at once (with a keyboard on the screen nearly
    // half of the view is edge): only when the finger goes on toward that edge, or comes back to it.
    LaunchedEffect(drag, scroll) {
        val dragging = drag ?: return@LaunchedEffect
        val view = scroll ?: return@LaunchedEffect
        val edge = with(density) { DRAG_SCROLL_EDGE.toPx() }
        val speed = with(density) { DRAG_SCROLL_SPEED.toPx() }
        val nudge = with(density) { 8.dp.toPx() }
        var before = withFrameNanos { it }
        while (true) {
            val now = withFrameNanos { it }
            val seconds = (now - before) / 1e9f
            before = now
            if (dragging.y >= view.top + edge || dragging.y < dragging.startY - nudge) dragging.scrollsUp = true
            if (dragging.y <= view.bottom - edge || dragging.y > dragging.startY + nudge) dragging.scrollsDown = true
            val over = when {
                dragging.scrollsUp && dragging.y < view.top + edge -> dragging.y - (view.top + edge)
                dragging.scrollsDown && dragging.y > view.bottom - edge -> dragging.y - (view.bottom - edge)
                else -> 0f
            }
            if (over != 0f) view.state.dispatchRawDelta((over / edge).coerceIn(-1f, 1f) * speed * seconds)
        }
    }

    Box(
        Modifier
            .fillMaxSize()
            .onGloballyPositioned {
                origin[0] = it
                width = it.size.width
                band = kotlin.math.floor(-it.positionInWindow().y / half).toInt()
            },
    ) {
        // The frame around the item on its way, or under a finger that has not moved yet, and the line where it lands.
        Canvas(Modifier.fillMaxSize()) {
            val dragging = drag
            val to = dragging?.let { target(it) }
            val heights = shown.heights
            val lines = if (dragging == null) held?.takeIf { heights.fits && it.last < heights.lines } else if (to == null) null else dragging.line..dragging.end
            if (lines == null) return@Canvas
            val pad = 12.dp.toPx()
            val top = heights.top(lines.first)
            val corner = CornerRadius(8.dp.toPx())
            val frame = Size(size.width + 2 * pad, heights.bottom(lines.last) - top)
            drawRoundRect(foreground.copy(alpha = 0.07f), Offset(-pad, top), frame, corner)
            drawRoundRect(foreground.copy(alpha = 0.55f), Offset(-pad, top), frame, corner, style = Stroke(1.5.dp.toPx()))
            if (dragging == null || to == null) return@Canvas
            val y = if (to.before < heights.lines) heights.top(to.before) else heights.bottom(heights.lines - 1)
            val inset = shown.metrics.toPx(TASK_SHIFT) + shown.metrics.toPx(LEVEL_STEP) * minOf(to.level, LIST_LEVELS_DRAWN - 1)
            val from = if (dragging.rtl) size.width - inset else inset
            drawLine(foreground, Offset(from, y), Offset(if (dragging.rtl) 0f else size.width, y), strokeWidth = 3.dp.toPx(), cap = StrokeCap.Round)
            drawCircle(foreground, radius = 5.dp.toPx(), center = Offset(from, y))
        }
        // Unbounded: the grips stand in the margins, outside the text. Their places to touch are exactly as wide as the
        // design has them: Compose would stretch a small one to 48 dp, and the cross would then reach 10 dp into the
        // text, where a tap at the end of a line belongs to the caret. Every place here is counted from the left of the
        // text as it is laid out, so this layer itself is never mirrored: the code above picks the side.
        CompositionLocalProvider(LocalViewConfiguration provides exact, LocalLayoutDirection provides LayoutDirection.Ltr) {
        Box(Modifier.fillMaxSize().wrapContentSize(Alignment.TopStart, unbounded = true)) {
            // A handle for each task near what is on the screen (as the boxes: a screen above to a screen below). Next
            // to any other line the margin stays as it was.
            val heights = shown.heights
            val from = (band - 2) * half
            val to = (band + 5) * half
            if (heights.fits) for (box in boxes) {
                if (box.line >= heights.lines) continue
                val top = heights.top(box.line)
                // The item on its way keeps its handle however far the note scrolls: the drag lives in it.
                if ((top < from || top > to) && drag?.line != box.line) continue
                key(box.line) {
                    val line = box.line
                    val rtl = shown.rtl(box)
                    val first = heights.firstBottom(line) - top
                    val coordinates = remember { arrayOfNulls<LayoutCoordinates>(1) }
                    fun onScreen(at: Offset) = coordinates[0]?.takeIf { it.isAttached }?.localToRoot(at) ?: at
                    Box(
                        Modifier
                            .offset { IntOffset(if (rtl) width + margin - reach else -margin, top.roundToInt()) }
                            // As high as the task, the lines it wraps to included; the dots stand next to its first line.
                            .size(with(density) { reach.toDp() }, with(density) { (heights.bottom(line) - top).toDp() })
                            .onGloballyPositioned { coordinates[0] = it }
                            .drawBehind {
                                // The item on its way or under a finger shows its dots full, the others stay calm (a shape, not only a color).
                                val picked = drag?.line == line || held?.first == line
                                val x = if (rtl) size.width - HANDLE_DOTS_AT.toPx() else HANDLE_DOTS_AT.toPx()
                                val gap = 3.dp.toPx()
                                for (column in listOf(-1, 1)) for (row in -1..1) {
                                    drawCircle(foreground.copy(alpha = if (picked) 1f else 0.45f), radius = (if (picked) 2f else 1.5f).dp.toPx(), center = Offset(x + column * gap, first / 2 + row * 2 * gap))
                                }
                            }
                            .pointerInput(Unit) {
                                awaitEachGesture {
                                    val down = awaitFirstDown(requireUnconsumed = true)
                                    down.consume()
                                    // The sign that the finger has the item, before it moves: the frame at once, the buzz when it rests.
                                    var buzzed = false
                                    held = itemLines(line)
                                    val rest = scope.launch {
                                        delay(HANDLE_REST_MS)
                                        buzzed = true
                                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                    }
                                    val start = try {
                                        awaitVerticalTouchSlopOrCancellation(down.id) { change, _ -> change.consume() }
                                    } finally {
                                        rest.cancel()
                                        held = null
                                    }
                                    if (start == null) {
                                        // The handle lies over a part of the box's own place to tap: a tap there still ticks the box.
                                        val up = currentEvent.changes.firstOrNull { it.id == down.id }
                                        val base = origin[0]?.takeIf { it.isAttached }
                                        if (up != null && !up.pressed && base != null &&
                                            up.uptimeMillis - down.uptimeMillis < viewConfiguration.longPressTimeoutMillis &&
                                            (up.position - down.position).getDistance() < viewConfiguration.touchSlop &&
                                            onBox(line, onScreen(up.position) - base.positionInRoot())
                                        ) shown.onTick(line)
                                        return@awaitEachGesture
                                    }
                                    if (!begin(line, onScreen(start.position))) return@awaitEachGesture
                                    if (!buzzed) haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                    val dropped = drag(start.id) { change ->
                                        move(onScreen(change.position))
                                        change.consume()
                                    }
                                    end(dropped)
                                }
                            },
                    )
                }
            }
            // The cross on the task with the caret, in the margin on the other side.
            val crossed = shown.byLine[caret]
            if (crossed != null && shown.heights.fits && caret < shown.heights.lines) {
                val top = shown.heights.top(caret)
                val line = shown.heights.firstBottom(caret) - top
                val high = maxOf(line, with(density) { 40.dp.toPx() })
                val rtl = shown.rtl(crossed)
                val name = stringResource(R.string.list_delete_item_named, crossed.label)
                Box(
                    Modifier
                        .offset { IntOffset(if (rtl) -margin else width + margin - crossReach, (top + (line - high) / 2).roundToInt()) }
                        .size(CROSS_REACH, with(density) { high.toDp() })
                        .clickable(role = Role.Button) { shown.actions.delete(shown.above + caret) }
                        .semantics { contentDescription = name }
                        .drawBehind {
                            val arm = 5.5.dp.toPx()
                            val stroke = 2.dp.toPx()
                            val color = foreground.copy(alpha = 0.8f)
                            drawLine(color, center + Offset(-arm, -arm), center + Offset(arm, arm), stroke, StrokeCap.Round)
                            drawLine(color, center + Offset(-arm, arm), center + Offset(arm, -arm), stroke, StrokeCap.Round)
                        },
                )
            }
            // The card that follows the finger: the first words of the item, and how many sub-items go along.
            drag?.let { dragging ->
                val ink = if (foreground.luminance() > 0.5f) Color.Black else Color.White
                val shape = RoundedCornerShape(8.dp)
                Row(
                    modifier = Modifier
                        .offset {
                            val at = finger(dragging) ?: Offset.Zero
                            val x = if (dragging.rtl) at.x - 224.dp.toPx() else at.x + 24.dp.toPx()
                            // Above the finger, but never over the top of the note's view: there it would be cut off.
                            val base = origin[0]?.takeIf { it.isAttached }?.positionInRoot()?.y
                            val top = if (scroll == null || base == null) Float.NEGATIVE_INFINITY else scroll.top - base + 4.dp.toPx()
                            IntOffset(x.roundToInt(), maxOf(at.y - 60.dp.toPx(), top).roundToInt())
                        }
                        .shadow(6.dp, shape)
                        .background(foreground, shape)
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(dragging.label.ifEmpty { "☐" }, color = ink, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 160.dp))
                    if (dragging.count > 0) Text("+${dragging.count}", color = ink, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                }
            }
        }
        }
    }
}

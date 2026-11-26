package com.diexar.keepcapture

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitVerticalTouchSlopOrCancellation
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
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
import androidx.compose.ui.text.style.ResolvedTextDirection
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
    var top by mutableFloatStateOf(0f)
    var bottom by mutableFloatStateOf(0f)
}

/**
 * What the grips and keys of a list item ask of the editor (design checklists-77, part 6). Every line counts in the
 * whole body. [drop] gives the body as it is after the drop, or null when nothing was dropped. [act] is an action a
 * screen reader offers on a task ("up", "down", "in", "out" or "delete"), [moveKey] Alt with an arrow from a keyboard
 * ("up" or "down", for the item with the caret; false when the caret is in no list). Those say whether the body changed.
 */
internal class ItemActions(
    val drop: (line: Int, before: Int, level: Int) -> String?,
    val delete: (line: Int) -> Boolean,
    val act: (line: Int, action: String) -> Boolean,
    val moveKey: (direction: String) -> Boolean,
)

/** The body's text starts this far from the screen's edge: the column's 16 dp and the field's own 16 dp. */
private val BODY_MARGIN = 32.dp

/** The six dots stand this far from the screen's edge: a drag that starts nearer to it can be the phone's Back (part 18). */
private val HANDLE_DOTS_AT = 26.dp

/** With the Markdown switch on a list stands at the margin's edge, so the handle is the margin itself and the dots stand in its middle. */
private val HANDLE_DOTS_RAW = 16.dp

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
 * up or down. The item then follows the finger with all that hangs under it, and the lines it passes make room (design
 * checklists-77-v2, part 5): the text itself stays put until the finger lets go, it is only drawn elsewhere (see
 * [ItemBands], which draws all of this with the text: [bands] is shared with the text field). Going sideways picks
 * another level where the place takes it, and the item stands that much further in. A drag that starts sideways is
 * left alone: at the screen's edge that is the phone's Back. Near the top or bottom of the view the note scrolls along.
 * Let go, the item glides into the gap and keeps its frame a moment.
 *
 * [boxes] are the tasks, [starts] where each line of this text starts in the text as shown and [layout] how it is laid
 * out. [whole] is the whole body and [above] the number of its lines above this text (a body with a table is shown in
 * pieces; [place] says how this piece lies when the ticked end of a list is one: an item is not dragged past the header
 * of the ticked items, and with [bounded] it is not drawn outside its own piece either). [caret] is the line with the
 * caret, or -1: no cross (the read view has no caret). With [raw] the text shows its Markdown signs: a list is not moved
 * aside there, so the handle is as wide as the margin, and a tap on it ticks nothing. A screen reader does not see the
 * handles (it cannot drag): the box has the same moves as actions.
 */
@Composable
internal fun ListGrips(
    bands: ItemBands,
    boxes: List<TaskBox>,
    starts: IntArray,
    layout: TextLayoutResult?,
    metrics: ListMetrics,
    whole: String,
    above: Int,
    caret: Int,
    foreground: Color,
    background: Color,
    scroll: GripScroll?,
    actions: ItemActions,
    raw: Boolean = false,
    place: PiecePlace = PiecePlace.FREE,
    bounded: Boolean = false,
    onTick: (Int) -> Unit,
) {
    DisposableEffect(bands) { onDispose { bands.clear() } }
    if (layout == null || boxes.isEmpty() || starts.isEmpty()) {
        bands.clear()
        return
    }
    val density = LocalDensity.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    // On a phone that reads right to left every line starts at the right; else only a line of such words can.
    val mirrored = LocalLayoutDirection.current == LayoutDirection.Rtl
    val mayRtl = remember(layout, mirrored) { mirrored || layout.layoutInput.text.hasRightToLeft() }
    val byLine = remember(boxes) { boxes.associateBy { it.line } }
    val margin = with(density) { BODY_MARGIN.roundToPx() }
    // The handle's place to touch: from the screen's edge to where the box of a task that is not a sub-item starts
    // (design checklists-77, part 5). A finger aimed at the dots comes down up to there (measured 23 Nov).
    val reach = if (raw) margin else margin + metrics.toPx(TASK_SHIFT).roundToInt()
    val boxReach = with(density) { BOX_REACH.toPx() }
    val crossReach = with(density) { CROSS_REACH.roundToPx() }
    val half = with(density) { LocalConfiguration.current.screenHeightDp.dp.toPx() } / 2
    val levelStep = with(density) { DRAG_LEVEL_STEP.dp.toPx() }
    val configuration = LocalViewConfiguration.current
    val exact = remember(configuration) {
        object : ViewConfiguration by configuration { override val minimumTouchTargetSize get() = DpSize.Zero }
    }
    var width by remember { mutableIntStateOf(0) }
    val heights = remember(layout, starts) { LineHeights(layout, starts) }
    bands.shown = GripsShown(
        heights, starts, boxes, byLine, layout, whole, above, mayRtl, actions, onTick, foreground, background, scroll,
        caret = caret,
        place = place,
        bounded = bounded,
        margin = margin.toFloat(),
        dotsAt = with(density) { (if (raw) HANDLE_DOTS_RAW else HANDLE_DOTS_AT).toPx() },
        crossAt = crossReach / 2f,
        levelStep = metrics.toPx(LEVEL_STEP),
        half = half,
        pad = with(density) { (if (raw) 24.dp else 12.dp).toPx() },
    )

    /** The lines of the item on [line], with all that hangs under it. */
    fun itemLines(line: Int): IntRange? {
        val now = bands.shown ?: return null
        val span = FormatCore.itemSpan(now.whole, now.above + line) ?: return null
        return line..(span.end - now.above).coerceIn(line, bands.heights(now).lines - 1)
    }

    /** Whether [at], in this text's own measure, is on the place to tap of the box on [line] (see TaskBoxes). */
    fun onBox(line: Int, at: Offset): Boolean {
        val now = bands.shown ?: return false
        val box = now.byLine[line] ?: return false
        val lines = bands.heights(now)
        if (raw || !lines.fits || line >= lines.lines || box.at >= lines.layout.layoutInput.text.length) return false
        val left = boxReachLeft(lines.layout, box.at, density)
        return at.x >= left && at.x <= left + boxReach && at.y >= lines.top(line) && at.y <= lines.firstBottom(line)
    }

    /** Where the item of [dragging] would land now, or null when the text is not what it was or not on the screen. */
    fun target(dragging: ItemDrag): DropTarget? {
        val now = bands.shown ?: return null
        val lines = bands.heights(now)
        if (!lines.fits || now.whole != dragging.whole || lines.lines != dragging.lines) return null
        val base = bands.origin?.takeIf { it.isAttached } ?: return null
        val side = (dragging.x - dragging.startX) / levelStep
        return dropTarget(dragging.slots, dragging.line, dragging.end, dragging.level, lines.lines, dragging.y - base.positionInRoot().y,
            (if (dragging.rtl) -side else side).roundToInt(), lines::top, lines::bottom)
    }

    /**
     * The finger on the handle of [line] starts to drag: it came down at [pressed] and is at [at] now, both on the whole
     * screen. The item hangs where the finger took it, so it is under the finger from the first frame.
     */
    fun begin(line: Int, at: Offset, pressed: Offset): ItemDrag? {
        val now = bands.shown ?: return null
        val lines = bands.heights(now)
        // One item at a time.
        if (bands.drag != null || !lines.fits || line >= lines.lines) return null
        val box = now.byLine[line] ?: return null
        val span = FormatCore.itemSpan(now.whole, now.above + line) ?: return null
        val level = FormatCore.listLevels(now.whole).getOrElse(now.above + line) { -1 }
        val slots = dropSlotsIn(now.whole, now.above, line, lines.lines, now.place)
        val base = bands.origin?.takeIf { it.isAttached }
        if (level < 0 || slots.isEmpty() || base == null) return null
        val end = (span.end - now.above).coerceIn(line, lines.lines - 1)
        bands.landing = null
        return ItemDrag(line, end, level, slots, now.rtl(box), now.whole, lines.lines, at.x, at.y, pressed.y - base.positionInRoot().y, lines.bottom(end) - lines.top(line))
            .also { bands.drag = it }
    }

    /**
     * The finger let go of [dragging], or the drag was broken off. The item is dropped at once: the text is the new one
     * from here on, and what glides after that is only how it is drawn (see [Landing]). So a note that is closed in
     * that moment has the item where it was dropped.
     */
    fun end(dragging: ItemDrag, dropped: Boolean) {
        if (bands.drag !== dragging) return
        val now = bands.shown
        val lines = now?.let { bands.heights(it) }
        val base = bands.origin?.takeIf { it.isAttached }
        val to = if (dropped) target(dragging) else null
        bands.drag = null
        if (now == null || lines == null || base == null || !lines.fits || now.whole != dragging.whole || lines.lines != dragging.lines) return
        // Where the item stands now, as it is drawn.
        val top = lines.top(dragging.line) + bands.blockOff(now, lines, dragging, base.positionInRoot().y)
        val levels = if (to == null) 0 else minOf(to.level, LIST_LEVELS_DRAWN - 1) - minOf(dragging.level, LIST_LEVELS_DRAWN - 1)
        val after = if (to != null && (to.before != dragging.line || to.level != dragging.level)) now.actions.drop(now.above + dragging.line, now.above + to.before, to.level) else null
        // On its new place the item stands on its new level by itself; an item that goes back comes from the side.
        bands.landing = Landing(after ?: dragging.whole, dragging.lines, dragging.room.settling(to?.before.takeIf { after != null }, lines::top, top),
            if (after != null) 0f else levels * now.levelStep * if (dragging.rtl) -1f else 1f, after != null)
    }

    // A drag, frame by frame: the lines between the item's own place and where it would land make room. Near the top or
    // the bottom of the note's view the note scrolls along, faster the nearer the finger is to the edge. An item that
    // is picked up next to an edge does not scroll the note at once (with a keyboard on the screen nearly half of the
    // view is edge): only when the finger goes on toward that edge, or comes back to it.
    LaunchedEffect(bands.drag, scroll) {
        val dragging = bands.drag ?: return@LaunchedEffect
        val edge = with(density) { DRAG_SCROLL_EDGE.toPx() }
        val speed = with(density) { DRAG_SCROLL_SPEED.toPx() }
        val nudge = with(density) { 8.dp.toPx() }
        var before = withFrameNanos { it }
        while (true) {
            val now = withFrameNanos { it }
            val seconds = (now - before) / 1e9f
            before = now
            if (scroll != null) {
                if (dragging.y >= scroll.top + edge || dragging.y < dragging.startY - nudge) dragging.scrollsUp = true
                if (dragging.y <= scroll.bottom - edge || dragging.y > dragging.startY + nudge) dragging.scrollsDown = true
                val over = when {
                    dragging.scrollsUp && dragging.y < scroll.top + edge -> dragging.y - (scroll.top + edge)
                    dragging.scrollsDown && dragging.y > scroll.bottom - edge -> dragging.y - (scroll.bottom - edge)
                    else -> 0f
                }
                if (over != 0f) scroll.state.dispatchRawDelta((over / edge).coerceIn(-1f, 1f) * speed * seconds)
            }
            // Where it lands follows the finger, and the note as it scrolls under a finger that holds still.
            val to = target(dragging)
            if (to != dragging.to) {
                // A light tick when the place it lands changes.
                if (dragging.to != null) haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                dragging.to = to
            }
            if (dragging.room.slide(to?.before, seconds)) bands.clock = now
        }
    }

    // An item that was let go, frame by frame, until it is on its place and its frame is gone.
    LaunchedEffect(bands.landing) {
        val landing = bands.landing ?: return@LaunchedEffect
        while (landing.at < landing.total) landing.at = ((withFrameNanos { it } - landing.since) / 1e6f).coerceAtLeast(0f)
        if (bands.landing === landing) bands.landing = null
    }

    Box(
        Modifier
            .fillMaxSize()
            .onGloballyPositioned {
                bands.origin = it
                width = it.size.width
                bands.band = kotlin.math.floor(-it.positionInWindow().y / half).toInt()
            },
    ) {
        // Unbounded: the grips stand in the margins, outside the text. Their places to touch are exactly as wide as the
        // design has them: Compose would stretch a small one to 48 dp, and the cross would then reach 10 dp into the
        // text, where a tap at the end of a line belongs to the caret. Every place here is counted from the left of the
        // text as it is laid out, so this layer itself is never mirrored: the code above picks the side.
        CompositionLocalProvider(LocalViewConfiguration provides exact, LocalLayoutDirection provides LayoutDirection.Ltr) {
        Box(Modifier.fillMaxSize().wrapContentSize(Alignment.TopStart, unbounded = true)) {
            // A handle for each task near what is on the screen (as the boxes: a screen above to a screen below). Next
            // to any other line the margin stays as it was. The handle is only a place to touch: its dots are drawn
            // with the text, so they go along with their line while an item is dragged past it.
            val from = (bands.band - 2) * half
            val to = (bands.band + 5) * half
            if (heights.fits) for (box in boxes) {
                if (box.line >= heights.lines) continue
                val top = heights.top(box.line)
                // The item on its way keeps its handle however far the note scrolls: the drag lives in it.
                if ((top < from || top > to) && bands.drag?.line != box.line) continue
                key(box.line) {
                    val line = box.line
                    val rtl = bands.shown?.rtl(box) == true
                    val coordinates = remember { arrayOfNulls<LayoutCoordinates>(1) }
                    fun onScreen(at: Offset) = coordinates[0]?.takeIf { it.isAttached }?.localToRoot(at) ?: at
                    Box(
                        Modifier
                            .offset { IntOffset(if (rtl) width + margin - reach else -margin, top.roundToInt()) }
                            // As high as the task, the lines it wraps to included; the dots stand next to its first line.
                            .size(with(density) { reach.toDp() }, with(density) { (heights.bottom(line) - top).toDp() })
                            .onGloballyPositioned { coordinates[0] = it }
                            .pointerInput(raw) {
                                awaitEachGesture {
                                    val down = awaitFirstDown(requireUnconsumed = true)
                                    down.consume()
                                    val pressed = onScreen(down.position)
                                    // The sign that the finger has the item, before it moves: the frame at once, the buzz when it rests.
                                    var buzzed = false
                                    bands.held = itemLines(line)
                                    val rest = scope.launch {
                                        delay(HANDLE_REST_MS)
                                        buzzed = true
                                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                    }
                                    val start = try {
                                        awaitVerticalTouchSlopOrCancellation(down.id) { change, _ -> change.consume() }
                                    } finally {
                                        rest.cancel()
                                        bands.held = null
                                    }
                                    if (start == null) {
                                        // The handle lies over a part of the box's own place to tap: a tap there still ticks the box.
                                        val up = currentEvent.changes.firstOrNull { it.id == down.id }
                                        val base = bands.origin?.takeIf { it.isAttached }
                                        if (up != null && !up.pressed && base != null &&
                                            up.uptimeMillis - down.uptimeMillis < viewConfiguration.longPressTimeoutMillis &&
                                            (up.position - down.position).getDistance() < viewConfiguration.touchSlop &&
                                            onBox(line, onScreen(up.position) - base.positionInRoot())
                                        ) bands.shown?.onTick?.invoke(line)
                                        return@awaitEachGesture
                                    }
                                    val dragging = begin(line, onScreen(start.position), pressed) ?: return@awaitEachGesture
                                    if (!buzzed) haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                    // Also when the gesture is taken away halfway: the item then goes back, it never stays lifted.
                                    var dropped = false
                                    try {
                                        dropped = drag(start.id) { change ->
                                            val at = onScreen(change.position)
                                            dragging.x = at.x
                                            dragging.y = at.y
                                            change.consume()
                                        }
                                    } finally {
                                        end(dragging, dropped)
                                    }
                                }
                            },
                    )
                }
            }
            // The cross on the task with the caret, in the margin on the other side. As the handles it is only a place to
            // touch here: its strokes are drawn with the text, so the cross goes along with its line.
            val crossed = byLine[caret]
            if (crossed != null && heights.fits && caret < heights.lines) {
                val top = heights.top(caret)
                val line = heights.firstBottom(caret) - top
                val high = maxOf(line, with(density) { 40.dp.toPx() })
                val rtl = bands.shown?.rtl(crossed) == true
                val name = stringResource(R.string.list_delete_item_named, crossed.label)
                Box(
                    Modifier
                        .offset { IntOffset(if (rtl) -margin else width + margin - crossReach, (top + (line - high) / 2).roundToInt()) }
                        .size(CROSS_REACH, with(density) { high.toDp() })
                        .clickable(role = Role.Button) { bands.shown?.let { it.actions.delete(it.above + caret) } }
                        .semantics { contentDescription = name },
                )
            }
        }
        }
    }
}

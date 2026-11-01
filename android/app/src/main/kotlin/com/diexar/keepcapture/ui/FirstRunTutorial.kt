package com.diexar.keepcapture.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.toRect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import com.diexar.keepcapture.R

/** What each balloon points at, in the order of the tour (Eric, 1 Nov: as short as possible). */
enum class TutorialTarget(val text: Int) {
    NEW_NOTE(R.string.tutorial_new_note),
    VOICE_MEMO(R.string.tutorial_voice_memo),
    PHOTO(R.string.tutorial_photo),
    PIN(R.string.tutorial_pin),
}

/**
 * A shadow over the screen with one balloon at a time. [anchors] holds where the real buttons are, in root coordinates.
 * New users often have no cards yet: the pin balloon then points at an example card that exists only here.
 */
@Composable
fun FirstRunTutorial(anchors: Map<TutorialTarget, Rect>, step: Int, onStep: (Int) -> Unit, onFinish: () -> Unit) {
    val target = TutorialTarget.entries[step]
    val last = step == TutorialTarget.entries.lastIndex
    val next = { if (last) onFinish() else onStep(step + 1) }
    var examplePin by remember { mutableStateOf<Rect?>(null) }
    val useExample = target == TutorialTarget.PIN && anchors[target] == null
    val density = LocalDensity.current
    val spot = (if (useExample) examplePin else anchors[target])?.inflate(with(density) { 6.dp.toPx() })
    BackHandler(onBack = onFinish)
    BoxWithConstraints(Modifier.fillMaxSize().pointerInput(step) { detectTapGestures { next() } }) {
        // The shadow, with a hole so the real button shows through.
        Canvas(Modifier.fillMaxSize()) {
            val shadow = Path().apply {
                fillType = PathFillType.EvenOdd
                addRect(size.toRect())
                if (spot != null && !useExample) addRoundRect(RoundRect(spot, CornerRadius(16.dp.toPx())))
            }
            drawPath(shadow, Color.Black.copy(alpha = 0.72f))
        }
        if (useExample) ExampleCard(Modifier.align(Alignment.Center)) { examplePin = it }
        if (spot != null) {
            // A ring, so the spot is told by its shape and not only by being lighter.
            Canvas(Modifier.fillMaxSize()) {
                drawRoundRect(PlayfulAmber, spot.topLeft, spot.size, CornerRadius(16.dp.toPx()), Stroke(4.dp.toPx()))
                drawRoundRect(PlayfulInk, spot.topLeft, spot.size, CornerRadius(16.dp.toPx()), Stroke(1.dp.toPx()))
            }
            val margin = with(density) { 16.dp.roundToPx() }
            val gap = with(density) { 22.dp.roundToPx() }
            val balloonWidth = minOf(constraints.maxWidth - 2 * margin, with(density) { 300.dp.roundToPx() })
            val x = (spot.center.x.toInt() - balloonWidth / 2).coerceIn(margin, constraints.maxWidth - balloonWidth - margin)
            val above = spot.center.y > constraints.maxHeight / 3
            val tailX = spot.center.x - x
            Balloon(
                text = stringResource(target.text),
                progress = stringResource(R.string.tutorial_progress, step + 1, TutorialTarget.entries.size),
                tailX = tailX,
                tailUp = !above,
                last = last,
                onNext = next,
                onSkip = onFinish,
                modifier = Modifier.layout { measurable, outer ->
                    val balloon = measurable.measure(Constraints(minWidth = balloonWidth, maxWidth = balloonWidth, maxHeight = outer.maxHeight))
                    val y = if (above) spot.top.toInt() - gap - balloon.height else spot.bottom.toInt() + gap
                    layout(outer.maxWidth, outer.maxHeight) {
                        balloon.place(x, y.coerceIn(margin, (outer.maxHeight - balloon.height - margin).coerceAtLeast(margin)))
                    }
                },
            )
        }
    }
}

@Composable
private fun Balloon(text: String, progress: String, tailX: Float, tailUp: Boolean, last: Boolean, onNext: () -> Unit, onSkip: () -> Unit, modifier: Modifier) {
    val paper = MaterialTheme.colorScheme.surface
    val edge = MaterialTheme.colorScheme.onSurface
    Column(
        modifier = modifier
            .drawBehind {
                val half = 11.dp.toPx()
                val tip = (tailX).coerceIn(half + 14.dp.toPx(), size.width - half - 14.dp.toPx())
                val base = if (tailUp) 1f else size.height - 1f
                val point = if (tailUp) -14.dp.toPx() else size.height + 14.dp.toPx()
                val body = Path().apply { addRoundRect(RoundRect(size.toRect(), CornerRadius(14.dp.toPx()))) }
                val tail = Path().apply { moveTo(tip - half, base); lineTo(tip, point); lineTo(tip + half, base); close() }
                val shape = Path().apply { op(body, tail, PathOperation.Union) }
                translate(3.dp.toPx(), 3.dp.toPx()) { drawPath(shape, edge) }
                drawPath(shape, paper)
                drawPath(shape, edge, style = Stroke(1.5.dp.toPx()))
            }
            .padding(start = 16.dp, top = 14.dp, end = 8.dp, bottom = 6.dp),
    ) {
        Text(
            text,
            style = MaterialTheme.typography.bodyLarge,
            color = edge,
            modifier = Modifier.padding(end = 8.dp).semantics { liveRegion = LiveRegionMode.Polite },
        )
        Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.End) {
            Text(progress, style = MaterialTheme.typography.labelMedium, color = edge)
            Spacer(Modifier.weight(1f))
            // On the last balloon "Got it" does the same as skipping.
            if (!last) TextButton(onClick = onSkip, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.tutorial_skip)) }
            Button(onClick = onNext, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(if (last) R.string.tutorial_done else R.string.tutorial_next)) }
        }
    }
}

/** Not a note: no file is written. */
@Composable
private fun ExampleCard(modifier: Modifier, onPin: (Rect) -> Unit) {
    val shape = RoundedCornerShape(12.dp)
    Box(modifier.width(220.dp).background(MaterialTheme.colorScheme.surface, shape).border(1.dp, MaterialTheme.colorScheme.onSurface, shape).padding(16.dp)) {
        Text(
            stringResource(R.string.tutorial_sample),
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.padding(end = 32.dp),
        )
        Icon(
            Icons.Outlined.PushPin,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.align(Alignment.TopEnd).size(24.dp).onGloballyPositioned { onPin(it.boundsInRoot()) },
        )
    }
}

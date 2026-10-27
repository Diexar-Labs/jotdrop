package com.diexar.keepcapture.ui

import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.diexar.keepcapture.R
import kotlinx.coroutines.delay

// Playful details from design A (Eric, 27 Oct), as on the website and in the plugin: paper cards a little askew
// (only the paper, so the text stays sharp), a folded corner like the logo, tape on pinned notes, a pen line through
// done tasks, a new note dropped onto the board and stamped "Sealed" once the cloud holds it.

val PlayfulAmber = Color(0xFFF4C458)
val PlayfulInk = Color(0xFF14213D)
// Caveat for the odd handwritten line (SIL Open Font License, bundled).
val Handwriting = FontFamily(Font(R.font.caveat, FontWeight.SemiBold))

const val FRESH_MS = 60_000L
// A new card waits until the cards around it have made room (they slide for 220 ms), then drops.
const val DROP_DELAY_MS = 240
const val DROP_MS = 560
const val PIN_MS = 450
const val STAMP_MS = 1800

private val TiltAngles = floatArrayOf(-0.6f, -0.35f, 0.3f, 0.5f, -0.15f, 0.2f)

/** A card's angle in degrees, always the same for the same note. */
fun tiltFor(key: String): Float {
    var hash = 0
    for (char in key) hash = hash * 31 + char.code
    return TiltAngles[((hash % TiltAngles.size) + TiltAngles.size) % TiltAngles.size]
}

/** Android's "Remove animations": nothing moves, but a confirmation still shows. */
@Composable
fun reducedMotion(): Boolean {
    val resolver = LocalContext.current.contentResolver
    return remember(resolver) { Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }
}

/** The paper behind a card: askew by [tilt] degrees, with its edge and a folded bottom-right corner. */
fun DrawScope.drawPaper(fill: Brush, edge: Color, edgeWidth: Float, page: Color, fold: Color, tilt: Float) {
    val corner = CornerRadius(10.dp.toPx())
    rotate(tilt) {
        drawRoundRect(fill, cornerRadius = corner)
        drawRoundRect(edge, topLeft = Offset(edgeWidth / 2, edgeWidth / 2), size = size.copy(size.width - edgeWidth, size.height - edgeWidth), cornerRadius = corner, style = Stroke(edgeWidth))
        val w = size.width
        val h = size.height
        val f = 16.dp.toPx()
        // The corner folded over: the cut-off part shows the page, the flap is a darker shade of the card.
        drawPath(Path().apply { moveTo(w + 1, h - f - 1); lineTo(w + 1, h + 1); lineTo(w - f - 1, h + 1); close() }, page)
        drawPath(Path().apply { moveTo(w - f, h); lineTo(w - f, h - f); lineTo(w, h - f); close() }, fold)
        drawPath(Path().apply { moveTo(w - f, h); lineTo(w - f, h - f); lineTo(w, h - f) }, edge, style = Stroke(1.dp.toPx()))
    }
}

/** A strip of tape on a pinned card, on top of everything on it and turned with its paper; [tape] is how far it has stuck on (1 = resting). */
fun DrawScope.drawTape(tilt: Float, tape: Float) {
    val tw = 78.dp.toPx()
    val th = 20.dp.toPx()
    val notch = tw * 0.06f
    rotate(tilt) {
        translate(size.width / 2, 1.dp.toPx()) {
            rotate(-4f - 8f * (1 - tape), pivot = Offset.Zero) {
                scale(1f + 0.5f * (1 - tape), pivot = Offset.Zero) {
                    val strip = Path().apply {
                        moveTo(-tw / 2, -th / 2); lineTo(tw / 2, -th / 2); lineTo(tw / 2 - notch, 0f); lineTo(tw / 2, th / 2)
                        lineTo(-tw / 2, th / 2); lineTo(-tw / 2 + notch, 0f); close()
                    }
                    drawPath(strip, PlayfulAmber.copy(alpha = 0.62f * tape.coerceIn(0f, 1f)))
                }
            }
        }
    }
}

/** Rotation of a pin that wiggles, at [progress] 0..1. */
fun wiggle(progress: Float): Float {
    val keys = floatArrayOf(0f, -16f, 11f, -6f, 0f)
    val at = progress.coerceIn(0f, 1f) * (keys.size - 1)
    val index = at.toInt().coerceAtMost(keys.size - 2)
    return keys[index] + (keys[index + 1] - keys[index]) * (at - index)
}

/** The text of each ticked task in a card's preview (after its ☑, up to the line end), by checklist index. */
fun tickedTasks(text: AnnotatedString): Map<Int, IntRange> =
    text.getStringAnnotations("CHECKLIST", 0, text.length)
        .filter { text.text.getOrNull(it.start) == '☑' }
        .associate { annotation ->
            val end = text.text.indexOf('\n', annotation.end).let { if (it < 0) text.length else it }
            annotation.item.toInt() to (annotation.end until end)
        }

/** A pen line through each ticked task; [progress] says how far the pen has drawn it (1 = done). */
fun DrawScope.drawPenLines(layout: TextLayoutResult, tasks: Map<Int, IntRange>, color: Color, progress: (Int) -> Float) {
    val visibleEnd = layout.getLineEnd(layout.lineCount - 1, visibleEnd = true)
    for ((index, range) in tasks) {
        val start = range.first + (layout.layoutInput.text.text.drop(range.first).takeWhile { it == ' ' || it == '\t' }.length)
        if (start >= visibleEnd || start > range.last) continue
        val end = minOf(range.last + 1, visibleEnd)
        val pen = progress(index)
        for (line in layout.getLineForOffset(start)..layout.getLineForOffset(end - 1)) {
            val left = if (line == layout.getLineForOffset(start)) layout.getHorizontalPosition(start, true) else layout.getLineLeft(line)
            val right = if (line == layout.getLineForOffset(end - 1)) layout.getHorizontalPosition(end, true) else layout.getLineRight(line)
            if (right <= left) continue
            val y = (layout.getLineTop(line) + layout.getLineBottom(line)) / 2
            val width = right - left + 4.dp.toPx()
            val lift = 2.dp.toPx()
            // The same slightly wavy stroke as on the website (viewBox 100 x 10).
            val path = Path().apply {
                moveTo(left - 2.dp.toPx(), y + lift * 0.2f)
                relativeCubicTo(width * 0.17f, -lift, width * 0.29f, lift * 0.5f, width * 0.49f, -lift * 0.25f)
                relativeCubicTo(width * 0.2f, -lift * 0.5f, width * 0.32f, -lift * 0.5f, width * 0.49f, lift * 0.25f)
            }
            if (pen < 1f) {
                val measure = PathMeasure().apply { setPath(path, false) }
                val part = Path()
                measure.getSegment(0f, measure.length * pen.coerceIn(0f, 1f), part, true)
                drawPath(part, color, style = Stroke(1.8.dp.toPx(), cap = StrokeCap.Round))
            } else {
                drawPath(path, color, style = Stroke(1.8.dp.toPx(), cap = StrokeCap.Round))
            }
        }
    }
}

/** "Sealed": pressed on a new note for a moment, once the cloud has stored it. With no animations it simply shows. */
@Composable
fun SealedStamp(sealedAt: Long, ink: Color, paper: Color, label: String, modifier: Modifier = Modifier) {
    val reduced = reducedMotion()
    val elapsed = (System.currentTimeMillis() - sealedAt).coerceAtLeast(0L)
    val progress = remember(sealedAt) { Animatable((elapsed.toFloat() / STAMP_MS).coerceIn(0f, 1f)) }
    var shown by remember(sealedAt) { mutableStateOf(elapsed < STAMP_MS) }
    LaunchedEffect(sealedAt) {
        val remaining = (STAMP_MS - elapsed).toInt().coerceAtLeast(0)
        if (reduced) delay(remaining.toLong()) else progress.animateTo(1f, tween(remaining, easing = LinearEasing))
        shown = false
    }
    if (!shown) return
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .graphicsLayer {
                val p = progress.value
                alpha = if (reduced) 1f else when { p < 0.18f -> p / 0.18f; p < 0.8f -> 1f; else -> (1f - p) / 0.2f }
                val grow = if (reduced) 1f else when { p < 0.18f -> 1.6f - 0.64f * (p / 0.18f); p < 0.26f -> 0.96f + 0.04f * ((p - 0.18f) / 0.08f); else -> 1f }
                scaleX = grow
                scaleY = grow
                rotationZ = -7f
            }
            .background(paper, RoundedCornerShape(6.dp))
            .border(2.dp, ink, RoundedCornerShape(6.dp))
            .padding(horizontal = 8.dp, vertical = 2.dp),
    ) {
        Icon(Icons.Filled.Lock, contentDescription = null, tint = ink, modifier = Modifier.size(12.dp))
        Spacer(Modifier.size(4.dp))
        Text(label.uppercase(), color = ink, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.08.em)
    }
}

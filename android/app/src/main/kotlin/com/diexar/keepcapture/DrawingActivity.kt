package com.diexar.keepcapture

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas as AndroidCanvas
import android.graphics.Color as AndroidColor
import android.graphics.Paint
import android.graphics.Path as AndroidPath
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Redo
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DeleteSweep
import androidx.compose.material.icons.filled.Draw
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke as DrawStroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.diexar.keepcapture.ui.JotDropTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.hypot

/**
 * Draw with a finger or a pen (Eric, 2 Nov: drawing for everyone, everywhere). The result is a PNG with its
 * lines inside (see [DrawingFormat]), so it shows as a picture everywhere and opens here again to draw on.
 * The PNG goes to the cache and its path comes back as [RESULT_FILE].
 * With [EXTRA_SOURCE] (an existing drawing) its lines open to draw on; the result is still a new file.
 */
class DrawingActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val source = intent.getStringExtra(EXTRA_SOURCE)?.let(Uri::parse)
        val initial = source?.let { uri -> runCatching { contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()?.let(DrawingFormat::read) }
        setContent {
            JotDropTheme {
                DrawingScreen(initial, onCancel = { setResult(Activity.RESULT_CANCELED); finish() }) { drawing ->
                    val png = withContext(Dispatchers.Default) { render(drawing) }
                    withContext(Dispatchers.IO) {
                        // Always a new file, also after editing: the note then points to it, the earlier picture stays as it was,
                        // and no screen can keep showing an old copy of the same file.
                        val stamp = SimpleDateFormat("yyyy-MM-dd HHmmss", Locale.US).format(Date())
                        val file = File(File(cacheDir, "drawings").apply { mkdirs() }, "drawing-$stamp.png")
                        file.writeBytes(png)
                        setResult(Activity.RESULT_OK, Intent().putExtra(RESULT_FILE, file.absolutePath))
                    }
                    finish()
                }
            }
        }
    }

    companion object {
        /** An existing drawing (content Uri) whose lines open to draw on. */
        const val EXTRA_SOURCE = "source"
        /** Path of the new PNG in the cache. */
        const val RESULT_FILE = "file"

        /** White background, round line ends, the lines as stored; then the lines go inside the PNG. */
        fun render(drawing: DrawingFormat.Drawing): ByteArray {
            val bitmap = Bitmap.createBitmap(drawing.width, drawing.height, Bitmap.Config.ARGB_8888)
            val canvas = AndroidCanvas(bitmap)
            canvas.drawColor(AndroidColor.WHITE)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
            for (stroke in drawing.strokes) {
                paint.color = AndroidColor.parseColor(stroke.color)
                paint.strokeWidth = stroke.size
                val p = stroke.points
                if (p.size == 2) {
                    paint.style = Paint.Style.FILL
                    canvas.drawCircle(p[0], p[1], stroke.size / 2f, paint)
                    paint.style = Paint.Style.STROKE
                    continue
                }
                val path = AndroidPath().apply { moveTo(p[0], p[1]); var i = 2; while (i < p.size) { lineTo(p[i], p[i + 1]); i += 2 } }
                canvas.drawPath(path, paint)
            }
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            bitmap.recycle()
            return DrawingFormat.withDrawing(out.toByteArray(), drawing)
        }
    }
}

/** Colours with a name, so the choice never depends on seeing the colour (Eric is colour blind). */
private val PENS = listOf(
    R.string.drawing_color_black to "#1f2937",
    R.string.drawing_color_blue to "#2563eb",
    R.string.drawing_color_red to "#dc2626",
    R.string.drawing_color_green to "#16a34a",
    R.string.drawing_color_orange to "#ea580c",
    R.string.drawing_color_purple to "#7c3aed",
)
private val SIZES = listOf(R.string.drawing_size_thin to 6f, R.string.drawing_size_medium to 14f, R.string.drawing_size_thick to 30f)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DrawingScreen(initial: DrawingFormat.Drawing?, onCancel: () -> Unit, onSave: suspend (DrawingFormat.Drawing) -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    val width = initial?.width ?: DrawingFormat.WIDTH
    val height = initial?.height ?: DrawingFormat.HEIGHT
    val strokes = remember { mutableStateListOf<DrawingFormat.Stroke>().apply { initial?.let { addAll(it.strokes) } } }
    val undo = remember { mutableStateListOf<List<DrawingFormat.Stroke>>() }
    val redo = remember { mutableStateListOf<List<DrawingFormat.Stroke>>() }
    var current by remember { mutableStateOf<List<Float>>(emptyList()) }
    var color by remember { mutableStateOf(PENS.first().second) }
    var size by remember { mutableStateOf(SIZES[1].second) }
    var erasing by remember { mutableStateOf(false) }
    var canvasSize by remember { mutableStateOf(IntSize.Zero) }
    var saving by remember { mutableStateOf(false) }
    var askDiscard by remember { mutableStateOf(false) }
    var askClear by remember { mutableStateOf(false) }
    val dirty = undo.isNotEmpty()

    fun record(change: () -> Unit) { undo.add(strokes.toList()); redo.clear(); change() }
    fun close() { if (dirty) askDiscard = true else onCancel() }
    BackHandler(onBack = ::close)

    Scaffold(topBar = {
        TopAppBar(title = { Text(stringResource(R.string.drawing_title)) },
            navigationIcon = { IconButton(onClick = ::close) { Icon(Icons.Filled.Close, stringResource(R.string.action_close)) } },
            actions = {
                Button(onClick = {
                    if (saving) return@Button
                    saving = true
                    scope.launch {
                        try { onSave(DrawingFormat.Drawing(width, height, strokes.toList())) }
                        catch (e: Exception) { saving = false; Toast.makeText(context, context.getString(R.string.toast_error, e.message ?: e.javaClass.simpleName), Toast.LENGTH_LONG).show() }
                    }
                }, enabled = !saving && strokes.isNotEmpty(), modifier = Modifier.padding(end = 8.dp)) { Text(stringResource(R.string.drawing_save)) }
            })
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            // The paper: always white, the same as the saved picture.
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Canvas(
                    Modifier
                        .aspectRatio(width.toFloat() / height)
                        .background(Color.White, RoundedCornerShape(8.dp))
                        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(8.dp))
                        .onSizeChanged { canvasSize = it }
                        .semantics { contentDescription = context.getString(R.string.drawing_canvas) }
                        .pointerInput(erasing, color, size) {
                            awaitEachGesture {
                                val down = awaitFirstDown()
                                val scale = width / this.size.width.toFloat()
                                fun at(offset: Offset) = listOf(offset.x * scale, offset.y * scale)
                                if (erasing) {
                                    var erased = false
                                    fun erase(offset: Offset) {
                                        val (x, y) = at(offset)
                                        val hit = strokes.filter { stroke -> stroke.points.chunked(2).any { (px, py) -> hypot(px - x, py - y) <= stroke.size / 2 + 24f } }
                                        if (hit.isEmpty()) return
                                        if (!erased) { undo.add(strokes.toList()); redo.clear(); erased = true }
                                        strokes.removeAll(hit)
                                    }
                                    erase(down.position)
                                    while (true) {
                                        val event = awaitPointerEvent()
                                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                        if (!change.pressed) break
                                        erase(change.position); change.consume()
                                    }
                                } else {
                                    current = at(down.position)
                                    down.consume()
                                    while (true) {
                                        val event = awaitPointerEvent()
                                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                        if (!change.pressed) break
                                        val next = at(change.position)
                                        // Skip points closer than a pixel; keeps the file small without losing shape.
                                        if (hypot(next[0] - current[current.size - 2], next[1] - current[current.size - 1]) >= 1.5f) current = current + next
                                        change.consume()
                                    }
                                    val finished = current
                                    current = emptyList()
                                    if (finished.isNotEmpty()) record { strokes.add(DrawingFormat.Stroke(color, size, finished)) }
                                }
                            }
                        },
                ) {
                    val scale = if (canvasSize.width > 0) canvasSize.width / width.toFloat() else 1f
                    fun drawLine(points: List<Float>, hex: String, stroke: Float) {
                        val paint = Color(AndroidColor.parseColor(hex))
                        if (points.size == 2) { drawCircle(paint, stroke * scale / 2f, Offset(points[0] * scale, points[1] * scale)); return }
                        val path = Path().apply { moveTo(points[0] * scale, points[1] * scale); var i = 2; while (i < points.size) { lineTo(points[i] * scale, points[i + 1] * scale); i += 2 } }
                        drawPath(path, paint, style = DrawStroke(width = stroke * scale, cap = StrokeCap.Round, join = StrokeJoin.Round))
                    }
                    for (stroke in strokes) drawLine(stroke.points, stroke.color, stroke.size)
                    if (current.isNotEmpty()) drawLine(current, color, size)
                }
            }
            // Colours: a dot, its name and a check mark on the chosen one.
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for ((name, hex) in PENS) {
                    val chosen = !erasing && color == hex
                    val label = stringResource(name)
                    FilterChip(selected = chosen, onClick = { color = hex; erasing = false }, label = { Text(label) },
                        leadingIcon = {
                            Box(Modifier.size(20.dp).background(Color(AndroidColor.parseColor(hex)), CircleShape), contentAlignment = Alignment.Center) {
                                if (chosen) Icon(Icons.Filled.Check, null, Modifier.size(14.dp), tint = Color.White)
                            }
                        },
                        modifier = Modifier.semantics { selected = chosen })
                }
            }
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                for ((name, value) in SIZES) FilterChip(selected = !erasing && size == value, onClick = { size = value; erasing = false }, label = { Text(stringResource(name)) },
                    leadingIcon = { Icon(Icons.Filled.Draw, null, Modifier.size(18.dp)) })
                FilterChip(selected = erasing, onClick = { erasing = !erasing }, label = { Text(stringResource(R.string.drawing_eraser)) },
                    leadingIcon = { if (erasing) Icon(Icons.Filled.Check, null, Modifier.size(18.dp)) })
            }
            Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Row {
                    IconButton(onClick = { redo.add(strokes.toList()); strokes.clear(); strokes.addAll(undo.removeAt(undo.size - 1)) }, enabled = undo.isNotEmpty()) {
                        Icon(Icons.AutoMirrored.Filled.Undo, stringResource(R.string.drawing_undo))
                    }
                    IconButton(onClick = { undo.add(strokes.toList()); strokes.clear(); strokes.addAll(redo.removeAt(redo.size - 1)) }, enabled = redo.isNotEmpty()) {
                        Icon(Icons.AutoMirrored.Filled.Redo, stringResource(R.string.drawing_redo))
                    }
                }
                TextButton(onClick = { askClear = true }, enabled = strokes.isNotEmpty()) {
                    Icon(Icons.Filled.DeleteSweep, null); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.drawing_clear))
                }
            }
        }
    }
    if (askDiscard) AlertDialog(onDismissRequest = { askDiscard = false }, title = { Text(stringResource(R.string.drawing_discard_title)) },
        confirmButton = { TextButton(onClick = { askDiscard = false; onCancel() }) { Text(stringResource(R.string.drawing_discard)) } },
        dismissButton = { TextButton(onClick = { askDiscard = false }) { Text(stringResource(R.string.drawing_keep_drawing)) } })
    if (askClear) AlertDialog(onDismissRequest = { askClear = false }, title = { Text(stringResource(R.string.drawing_clear_title)) },
        confirmButton = { TextButton(onClick = { askClear = false; record { strokes.clear() } }) { Text(stringResource(R.string.drawing_clear)) } },
        dismissButton = { TextButton(onClick = { askClear = false }) { Text(stringResource(R.string.action_cancel)) } })
}

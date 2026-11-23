package com.diexar.keepcapture

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.ParagraphStyle
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextGeometricTransform
import androidx.compose.ui.text.style.TextIndent
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/** Above this many characters the note shows raw, for speed (as the web editor). */
internal const val FORMAT_RAW_ABOVE = 50_000

/**
 * What the formatted view needs to place lists (design checklists-77, parts 5 and 6.3): the height of a task's line
 * (unspecified: as every other line), and the screen's own measure. The sizes of a list are in sp, so they grow with
 * the phone's font size, but they add up in pixels: with a big font size Android does not scale every sp alike, and a
 * sum made in sp put the lines that wrap left of their own words (seen at font size 2.0, 22 Nov). [toPx] is an sp
 * size in pixels, [toSp] a pixel size as the text unit a paragraph takes, [measure] the width in pixels of a marker (a
 * box, a bullet, a number, each with its spaces) as it is drawn.
 */
internal class ListMetrics(val taskLine: TextUnit, val toPx: (Float) -> Float, val toSp: (Float) -> TextUnit, private val measure: (String) -> Float) {
    private val widths = HashMap<String, Float>()
    fun width(marker: String): Float = widths.getOrPut(marker) { measure(marker) }
}

/**
 * The note body in the formatted view (design opmaak-editor, part 5.2 and 7.1): bold is bold and a heading is big, and
 * the Markdown signs are never shown (Eric, 16 Nov: not at the caret and not in a selection either; the Markdown switch
 * is for seeing them).
 *
 * The text stays the source, character for character: the mapping is the identity, so the cursor, the keyboard, the
 * list Enter and the stale-input replay work on the same positions as before. A hidden sign stays in the field as a
 * character that takes no room (a tiny, transparent letter). A sign that becomes one other sign (`-` a bullet, `[` a
 * box, `>` a bar) is swapped one for one, so the length never changes.
 *
 * [pairFrom]..[pairTo]: an empty pair at the caret (a button pressed before typing), hidden as well and read as spaces
 * meanwhile, so `****` is no rule and `~~~~` no code fence. -1 when there is none.
 *
 * With [lists] a list stands in paragraphs of its own (see [layoutBody]). Then one character without width follows the
 * note; every place in the note still has its own number.
 */
internal data class FormatTransformation(
    val formatted: Boolean,
    val foreground: Color,
    val pairFrom: Int = -1,
    val pairTo: Int = -1,
    val lists: ListMetrics? = null,
) : VisualTransformation {
    private var last: kotlin.Pair<String, Laid>? = null

    /** The body as drawn. The field asks for it and so does the editor (for the boxes): it is laid out once. */
    fun laid(source: String): Laid =
        last?.takeIf { it.first == source }?.second ?: run {
            val laid = if (!formatted || source.length > FORMAT_RAW_ABOVE) Laid(AnnotatedString(renderListBullets(source)), emptyList(), emptyList(), false, IntArray(0))
                else layoutBody(source, foreground, pairFrom, pairTo, true, lists)
            last = source to laid
            laid
        }

    override fun filter(text: AnnotatedString): TransformedText {
        val laid = laid(text.text)
        return TransformedText(laid.text, if (laid.tail) TailMapping(text.length) else OffsetMapping.Identity)
    }
}

/** The identity, for a shown text with one more character at its end than the source. */
private class TailMapping(private val length: Int) : OffsetMapping {
    override fun originalToTransformed(offset: Int) = offset
    override fun transformedToOriginal(offset: Int) = minOf(offset, length)
}

/**
 * The body as drawn: its text, the signs it hides, its task boxes, whether one more character follows the note, and
 * where each line starts (for the grips on a task's line; empty when the note shows raw).
 */
internal class Laid(val text: AnnotatedString, val hidden: List<IntRange>, val boxes: List<TaskBox>, val tail: Boolean, val starts: IntArray)

private val hiddenStyle = SpanStyle(fontSize = 0.01.sp, color = Color.Transparent, letterSpacing = 0.sp)

// As on the card: one and a half times the text, so it is easy to see and to hit.
internal val boxStyle = SpanStyle(fontSize = 1.5.em)

/**
 * The space a line break shows as where a paragraph ends (see [layoutBody]): wider than any screen. A tap to the right
 * of the line is then nearer to the place in front of it, the end of the line, than to the place behind it, which is
 * the start of the next line. It is at the end of its line, where a space hangs over the edge and wraps nothing.
 * Stretched, not spaced out: from Android 15 on the room letter spacing adds at a line's end is taken off the line's
 * width again, and the last word of the paragraph then ran out of the screen instead of wrapping (seen 22 Nov).
 */
private val edgeStyle = SpanStyle(textGeometricTransform = TextGeometricTransform(scaleX = 1000f))

/** Follows the note when a list stands in paragraphs: a character without width, so the last line is a line of text. */
private const val TAIL = "​"

internal fun formatBody(source: String, formatted: Boolean, foreground: Color, pairFrom: Int = -1, pairTo: Int = -1): AnnotatedString =
    if (!formatted || source.length > FORMAT_RAW_ABOVE) AnnotatedString(renderListBullets(source))
    else layoutBody(source, foreground, pairFrom, pairTo, false, null).text

/**
 * The ranges the formatted view of the body hides (signs that take no room), for Backspace: see [deletingIntoSigns].
 * The spaces and tabs in front of a list line are among them.
 */
internal fun hiddenSigns(source: String): List<IntRange> =
    if (source.length > FORMAT_RAW_ABOVE) emptyList() else layoutBody(source, Color.Black, -1, -1, true, null).hidden

/** A task's box in an open note: its line, where the box stands in the text, and what TalkBack reads. */
internal data class TaskBox(val line: Int, val at: Int, val checked: Boolean, val label: String)

/** The boxes [layoutBody] draws, as places to tap (#77). */
internal fun taskBoxes(source: String): List<TaskBox> =
    if (source.length > FORMAT_RAW_ABOVE || '[' !in source) emptyList() else layoutBody(source, Color.Black, -1, -1, false, null).boxes

/**
 * [body]: the text is a note's body, where a list line stands where its level puts it and the spaces and tabs in front
 * of it take no room (a table's cell is no body). With [lists] the lists of a body also get their paragraphs.
 */
private fun layoutBody(source: String, foreground: Color, pairFrom: Int, pairTo: Int, body: Boolean, lists: ListMetrics?): Laid {
    val dark = foreground.luminance() > 0.5f
    val muted = foreground.copy(alpha = 0.55f)
    val link = SpanStyle(textDecoration = TextDecoration.Underline, fontWeight = FontWeight.Medium)
    val codeStyle = SpanStyle(fontFamily = FontFamily.Monospace, background = foreground.copy(alpha = 0.08f))
    val markStyle = SpanStyle(background = if (dark) Color(0xFF6B5413) else Color(0xFFFDE68A))
    val inlineStyle = mapOf(
        "bold" to SpanStyle(fontWeight = FontWeight.Bold),
        "italic" to SpanStyle(fontStyle = FontStyle.Italic),
        "strike" to SpanStyle(textDecoration = TextDecoration.LineThrough),
        "highlight" to markStyle,
        "code" to codeStyle,
        "link" to link,
        "wikilink" to link,
        "url" to link,
    )

    val hasPair = pairFrom in 0..pairTo && pairTo <= source.length
    val text = if (hasPair) source.substring(0, pairFrom) + " ".repeat(pairTo - pairFrom) + source.substring(pairTo) else source
    val shown = source.toCharArray()
    val styles = mutableListOf<AnnotatedString.Range<SpanStyle>>()
    val hidden = mutableListOf<IntRange>()
    val boxes = mutableListOf<TaskBox>()
    fun style(style: SpanStyle, from: Int, to: Int) { if (to > from) styles += AnnotatedString.Range(style, from, to) }
    fun hide(from: Int, to: Int) { if (to > from) hidden += from until to }
    if (hasPair) hide(pairFrom, pairTo)

    val starts = IntArray(text.count { it == '\n' } + 1)
    run {
        var line = 1
        for ((i, char) in text.withIndex()) if (char == '\n') starts[line++] = i + 1
    }
    val lines = text.split('\n')
    val rows = if (body) listRows(text) else emptyList()
    for (block in FormatCore.blocks(text)) {
        for (number in block.fromLine..block.toLine) {
            val lineStart = starts[number]
            val line = lines[number].removeSuffix("\r")
            val lineEnd = lineStart + line.length
            when (block.kind) {
                // Code is shown as it is written, in a fixed-width letter; a table stays text until it gets its grid.
                "code" -> {
                    style(codeStyle, lineStart, lineEnd)
                    if (number == block.fromLine || (number == block.toLine && line.trimStart().let { it.startsWith("```") || it.startsWith("~~~") })) style(SpanStyle(color = muted), lineStart, lineEnd)
                    continue
                }
                "table" -> continue
            }
            val prefix = FormatCore.linePrefix(line)
            val at = { offset: Int -> lineStart + offset }
            // A list line stands where its level puts it (design checklists-77, 6.3), so the spaces and tabs in front of
            // it take no room. A tab would still jump to its next stop, however small its letter: it shows as a space.
            if (rows.getOrNull(number) != null) {
                hide(lineStart, at(prefix.indent))
                for (i in lineStart until at(prefix.indent)) if (shown[i] == '\t') shown[i] = ' '
            }
            when (prefix.kind) {
                "heading" -> {
                    hide(at(prefix.markFrom), at(prefix.markTo))
                    val size = when (prefix.level) { 1 -> 1.3.em; 2 -> 1.25.em; else -> 1.1.em }
                    style(SpanStyle(fontSize = size, fontWeight = FontWeight.Bold), at(prefix.markTo), lineEnd)
                }
                "quote" -> {
                    shown[at(prefix.markFrom)] = '▎'
                    style(SpanStyle(color = muted, fontWeight = FontWeight.Bold), at(prefix.markFrom), at(prefix.markFrom) + 1)
                    style(SpanStyle(fontStyle = FontStyle.Italic), at(prefix.markTo), lineEnd)
                }
                "rule" -> {
                    for (i in at(prefix.markFrom) until lineEnd) shown[i] = '─'
                    style(SpanStyle(color = muted), at(prefix.markFrom), lineEnd)
                    continue
                }
                "bullet" -> shown[at(prefix.markFrom)] = '•'
                "task" -> {
                    // `- [ ] ` becomes ☐ or ☑: the dash and brackets hide, the box takes the place of the `[`.
                    val open = line.indexOf('[', prefix.markFrom)
                    hide(at(prefix.markFrom), at(open))
                    shown[at(open)] = if (prefix.checked) '☑' else '☐'
                    style(boxStyle, at(open), at(open) + 1)
                    hide(at(open) + 1, at(open) + 3)
                    if (prefix.checked) style(SpanStyle(textDecoration = TextDecoration.LineThrough, color = muted), at(prefix.markTo), lineEnd)
                    boxes += TaskBox(number, at(open), prefix.checked, line.substring(prefix.markTo).trim())
                }
                "ordered" -> style(SpanStyle(color = muted), at(prefix.markFrom), at(prefix.markTo))
            }
            // Inline signs after the line's own sign, so a bullet star is never read as italic.
            val offset = lineStart + prefix.markTo
            for (span in FormatCore.inlineSpans(line.substring(prefix.markTo))) {
                hide(offset + span.from, offset + span.openTo)
                hide(offset + span.closeFrom, offset + span.to)
                inlineStyle[span.kind]?.let { style(it, offset + span.openTo, offset + span.closeFrom) }
            }
        }
    }

    val paragraphs = if (lists == null) emptyList() else listParagraphs(rows, starts, text.length, lists) { _, row -> row.marker }
    showEdges(paragraphs, text, shown, styles)
    // Hidden signs last: a later style wins, so nothing a span adds (a bigger heading letter) gives them room again.
    for (range in hidden) style(hiddenStyle, range.first, range.last + 1)
    val tail = paragraphs.isNotEmpty()
    return Laid(AnnotatedString(String(shown) + if (tail) TAIL else "", spanStyles = styles, paragraphStyles = paragraphs), hidden, boxes, tail, starts)
}

/**
 * Lists in paragraphs of their own (design checklists-77, parts 5 and 6.3): each level stands further to the right, a
 * list with a task leaves the margin to the handles, a long line goes on under its own words, and a task's line is
 * higher. Lines that stand the same way share a paragraph, so a long list is still a few paragraphs. [rows] says what
 * each line is, [starts] where it starts in the text of [length] characters, and [marker] what stands in front of the
 * words of a list line as it is shown.
 */
private fun listParagraphs(rows: List<ListRow?>, starts: IntArray, length: Int, lists: ListMetrics, marker: (Int, ListRow) -> String): List<AnnotatedString.Range<ParagraphStyle>> {
    val paragraphs = mutableListOf<AnnotatedString.Range<ParagraphStyle>>()
    if (rows.isEmpty()) return paragraphs
    // In pixels: where the line starts, and where its words start (lines that wrap go on there).
    val first = FloatArray(rows.size)
    val rest = FloatArray(rows.size)
    val shift = lists.toPx(TASK_SHIFT)
    val step = lists.toPx(LEVEL_STEP)
    for ((number, row) in rows.withIndex()) {
        if (row == null) continue
        if (row.kind == "more") { first[number] = rest[row.item]; rest[number] = rest[row.item]; continue }
        first[number] = (if (row.shifted) shift else 0f) + step * row.level
        rest[number] = first[number] + lists.width(marker(number, row))
    }
    fun same(a: Int, b: Int) = first[a] == first[b] && rest[a] == rest[b] && (rows[a]!!.kind == "task") == (rows[b]!!.kind == "task")
    var number = 0
    while (number < rows.size) {
        if (rows[number] == null) { number++; continue }
        var end = number
        while (end + 1 < rows.size && rows[end + 1] != null && same(number, end + 1)) end++
        // The note's last line takes the character after the note along, so that one starts no line of its own.
        val to = if (end + 1 < rows.size) starts[end + 1] else length + 1
        paragraphs += AnnotatedString.Range(
            ParagraphStyle(
                textIndent = TextIndent(lists.toSp(first[number]), lists.toSp(rest[number])),
                lineHeight = if (rows[number]!!.kind == "task") lists.taskLine else TextUnit.Unspecified,
            ),
            starts[number], to,
        )
        number = end + 1
    }
    return paragraphs
}

/**
 * A paragraph starts on a new line by itself, so a line break right in front of a paragraph's edge would give an empty
 * line more. It shows as a space there (the text keeps its line break): see [edgeStyle].
 */
private fun showEdges(paragraphs: List<AnnotatedString.Range<ParagraphStyle>>, text: String, shown: CharArray, styles: MutableList<AnnotatedString.Range<SpanStyle>>) {
    for (edge in paragraphs.flatMapTo(HashSet()) { listOf(it.start, it.end) }) {
        if (edge !in 1..text.length || text[edge - 1] != '\n') continue
        shown[edge - 1] = ' '
        styles += AnnotatedString.Range(edgeStyle, edge - 1, edge)
    }
}

/** The read view of a note with its lists placed as in the open note: the text as shown, and where each line starts in it. */
internal class LaidPreview(val text: AnnotatedString, val starts: IntArray)

// What stands in front of the words of a list line in the read view: its box, bullet or number, with the spaces behind it.
private val previewMarker = Regex("^(?:[☐☑][ \\t]*|•[ \\t]+|\\d{1,9}\\.[ \\t]+)")

/**
 * The read view of a note with links ([preview], from renderPreviewAnnotated on [source]) with its lists in the same
 * paragraphs as the open note (design checklists-77, part 5): the handle of a task then has its margin there too. The
 * read view writes every line of the note on a line of its own; the spaces and tabs in front of a list line take no
 * room, as in the open note. Without [lists], or when the lines do not match, the read view stays as it came.
 */
internal fun previewInParagraphs(preview: AnnotatedString, source: String, lists: ListMetrics?): LaidPreview {
    val shownLines = preview.text.split('\n')
    val starts = IntArray(shownLines.size)
    var offset = 0
    for ((number, line) in shownLines.withIndex()) { starts[number] = offset; offset += line.length + 1 }
    val rows = if (lists == null || source.length > FORMAT_RAW_ABOVE) emptyList() else listRows(source)
    if (lists == null || rows.size != shownLines.size) return LaidPreview(preview, starts)
    val shown = preview.text.toCharArray()
    val styles = mutableListOf<AnnotatedString.Range<SpanStyle>>()
    val hidden = mutableListOf<AnnotatedString.Range<SpanStyle>>()
    val indents = IntArray(rows.size)
    for ((number, row) in rows.withIndex()) {
        if (row == null) continue
        val line = shownLines[number]
        val indent = line.indexOfFirst { it != ' ' && it != '\t' }.let { if (it < 0) line.length else it }
        indents[number] = indent
        for (index in starts[number] until starts[number] + indent) if (shown[index] == '\t') shown[index] = ' '
        if (indent > 0) hidden += AnnotatedString.Range(hiddenStyle, starts[number], starts[number] + indent)
    }
    val paragraphs = listParagraphs(rows, starts, shown.size, lists) { number, _ ->
        previewMarker.find(shownLines[number].substring(indents[number]))?.value.orEmpty()
    }
    showEdges(paragraphs, preview.text, shown, styles)
    val builder = AnnotatedString.Builder(String(shown) + TAIL)
    for (range in preview.spanStyles + styles + hidden) builder.addStyle(range.item, range.start, range.end)
    for (range in preview.getStringAnnotations(0, preview.length)) builder.addStringAnnotation(range.tag, range.item, range.start, range.end)
    for (range in paragraphs) builder.addStyle(range.item, range.start, range.end)
    return LaidPreview(builder.toAnnotatedString(), starts)
}

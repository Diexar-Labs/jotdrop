package com.diexar.keepcapture

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/** Above this many characters the note shows raw, for speed (as the web editor). */
internal const val FORMAT_RAW_ABOVE = 50_000

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
 */
internal data class FormatTransformation(
    val formatted: Boolean,
    val foreground: Color,
    val pairFrom: Int = -1,
    val pairTo: Int = -1,
) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText =
        TransformedText(formatBody(text.text, formatted, foreground, pairFrom, pairTo), OffsetMapping.Identity)
}

private val hiddenStyle = SpanStyle(fontSize = 0.01.sp, color = Color.Transparent, letterSpacing = 0.sp)

internal fun formatBody(source: String, formatted: Boolean, foreground: Color, pairFrom: Int = -1, pairTo: Int = -1): AnnotatedString =
    if (!formatted || source.length > FORMAT_RAW_ABOVE) AnnotatedString(renderListBullets(source))
    else layoutBody(source, foreground, pairFrom, pairTo).first

/** The ranges the formatted view hides (signs that take no room), for Backspace: see [deletingIntoSigns]. */
internal fun hiddenSigns(source: String): List<IntRange> =
    if (source.length > FORMAT_RAW_ABOVE) emptyList() else layoutBody(source, Color.Black, -1, -1).second

private fun layoutBody(source: String, foreground: Color, pairFrom: Int, pairTo: Int): kotlin.Pair<AnnotatedString, List<IntRange>> {
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
    fun style(style: SpanStyle, from: Int, to: Int) { if (to > from) styles += AnnotatedString.Range(style, from, to) }
    fun hide(from: Int, to: Int) { if (to > from) hidden += from until to }
    if (hasPair) hide(pairFrom, pairTo)

    val starts = IntArray(text.count { it == '\n' } + 1)
    run {
        var line = 1
        for ((i, char) in text.withIndex()) if (char == '\n') starts[line++] = i + 1
    }
    val lines = text.split('\n')
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
                    hide(at(open) + 1, at(open) + 3)
                    if (prefix.checked) style(SpanStyle(textDecoration = TextDecoration.LineThrough, color = muted), at(prefix.markTo), lineEnd)
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
    // Hidden signs last: a later style wins, so nothing a span adds (a bigger heading letter) gives them room again.
    for (range in hidden) style(hiddenStyle, range.first, range.last + 1)
    return AnnotatedString(String(shown), spanStyles = styles) to hidden
}

package com.diexar.keepcapture

import java.io.ByteArrayOutputStream
import java.util.Locale
import java.util.zip.CRC32

/**
 * A JotDrop drawing is an ordinary PNG, so Obsidian, Joplin and every browser show it as a picture.
 * Its lines travel inside the same file, in a PNG tEXt chunk with the keyword "jotdrop-drawing",
 * so JotDrop can open it again to draw on. Format v1, the same in the app, the web app and the plugins:
 *
 *     {"v":1,"w":1080,"h":1440,"strokes":[{"c":"#1f2937","s":10,"p":[x1,y1,x2,y2,...]}]}
 *
 * w and h are the size of the PNG in pixels; points and stroke sizes are pixels of that PNG;
 * c is a #rrggbb colour. The background is white. Plain JVM code, so a check runs without a phone.
 */
object DrawingFormat {
    const val KEYWORD = "jotdrop-drawing"
    const val WIDTH = 1080
    const val HEIGHT = 1440
    private val SIGNATURE = byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10)

    data class Stroke(val color: String, val size: Float, val points: List<Float>)
    data class Drawing(val width: Int, val height: Int, val strokes: List<Stroke>)

    fun isDrawingName(name: String) = name.startsWith("drawing-", ignoreCase = true) && name.endsWith(".png", ignoreCase = true)

    fun encode(drawing: Drawing): String = buildString {
        append("{\"v\":1,\"w\":").append(drawing.width).append(",\"h\":").append(drawing.height).append(",\"strokes\":[")
        drawing.strokes.forEachIndexed { index, stroke ->
            if (index > 0) append(',')
            append("{\"c\":\"").append(cleanColor(stroke.color)).append("\",\"s\":").append(number(stroke.size)).append(",\"p\":[")
            stroke.points.forEachIndexed { i, value -> if (i > 0) append(','); append(number(value)) }
            append("]}")
        }
        append("]}")
    }

    /** Null for anything that is not a v1 drawing; a broken stroke is left out rather than failing the whole drawing. */
    fun decode(text: String): Drawing? {
        val root = try { Json(text).value() } catch (_: Exception) { return null } as? Map<*, *> ?: return null
        if ((root["v"] as? Double)?.toInt() != 1) return null
        val width = (root["w"] as? Double)?.toInt()?.takeIf { it in 1..8192 } ?: return null
        val height = (root["h"] as? Double)?.toInt()?.takeIf { it in 1..8192 } ?: return null
        val strokes = (root["strokes"] as? List<*>).orEmpty().mapNotNull { item ->
            val stroke = item as? Map<*, *> ?: return@mapNotNull null
            val color = (stroke["c"] as? String)?.takeIf { COLOR.matches(it) } ?: return@mapNotNull null
            val size = (stroke["s"] as? Double)?.toFloat()?.takeIf { it > 0f && it <= 400f } ?: return@mapNotNull null
            val points = (stroke["p"] as? List<*>)?.map { (it as? Double)?.toFloat() ?: return@mapNotNull null } ?: return@mapNotNull null
            if (points.isEmpty() || points.size % 2 != 0) null else Stroke(color.lowercase(Locale.ROOT), size, points)
        }
        return Drawing(width, height, strokes)
    }

    /** The PNG with this drawing's lines in it; an older jotdrop-drawing chunk is replaced. */
    fun withDrawing(png: ByteArray, drawing: Drawing): ByteArray {
        val chunks = chunks(png) ?: throw IllegalArgumentException("Not a PNG")
        val out = ByteArrayOutputStream(png.size + 4096)
        out.write(SIGNATURE)
        for (chunk in chunks) {
            if (chunk.type == "tEXt" && keywordOf(chunk.data) == KEYWORD) continue
            writeChunk(out, chunk.type, chunk.data)
            if (chunk.type == "IHDR") writeChunk(out, "tEXt", (KEYWORD + "\u0000" + encode(drawing)).toByteArray(Charsets.ISO_8859_1))
        }
        return out.toByteArray()
    }

    /** The lines inside a PNG made by JotDrop, or null for any other picture. */
    fun read(png: ByteArray): Drawing? {
        val chunk = chunks(png)?.firstOrNull { it.type == "tEXt" && keywordOf(it.data) == KEYWORD } ?: return null
        return decode(String(chunk.data, KEYWORD.length + 1, chunk.data.size - KEYWORD.length - 1, Charsets.ISO_8859_1))
    }

    private class Chunk(val type: String, val data: ByteArray)

    private fun chunks(png: ByteArray): List<Chunk>? {
        if (png.size < 8 || !png.copyOfRange(0, 8).contentEquals(SIGNATURE)) return null
        val list = mutableListOf<Chunk>()
        var at = 8
        while (at + 12 <= png.size) {
            val length = ((png[at].toInt() and 0xff) shl 24) or ((png[at + 1].toInt() and 0xff) shl 16) or ((png[at + 2].toInt() and 0xff) shl 8) or (png[at + 3].toInt() and 0xff)
            if (length < 0 || at + 12 + length > png.size) return null
            val type = String(png, at + 4, 4, Charsets.ISO_8859_1)
            list += Chunk(type, png.copyOfRange(at + 8, at + 8 + length))
            at += 12 + length
            if (type == "IEND") break
        }
        return list.takeIf { it.firstOrNull()?.type == "IHDR" && it.lastOrNull()?.type == "IEND" }
    }

    private fun keywordOf(data: ByteArray): String? {
        val end = data.indexOf(0)
        return if (end <= 0) null else String(data, 0, end, Charsets.ISO_8859_1)
    }

    private fun writeChunk(out: ByteArrayOutputStream, type: String, data: ByteArray) {
        val typeBytes = type.toByteArray(Charsets.ISO_8859_1)
        fun int(value: Int) { out.write(value ushr 24); out.write(value ushr 16 and 0xff); out.write(value ushr 8 and 0xff); out.write(value and 0xff) }
        int(data.size)
        out.write(typeBytes)
        out.write(data)
        val crc = CRC32().apply { update(typeBytes); update(data) }
        int(crc.value.toInt())
    }

    private val COLOR = Regex("^#[0-9a-fA-F]{6}$")
    private fun cleanColor(color: String) = if (COLOR.matches(color)) color.lowercase(Locale.ROOT) else "#000000"
    private fun number(value: Float): String {
        val rounded = Math.round(value * 10f) / 10f
        return if (rounded == rounded.toInt().toFloat()) rounded.toInt().toString() else String.format(Locale.ROOT, "%.1f", rounded)
    }

    /** Just enough JSON for this format: objects, arrays, strings, numbers. */
    private class Json(private val text: String) {
        private var at = 0
        fun value(): Any? {
            skip()
            return when (val c = text[at]) {
                '{' -> { at++; val map = LinkedHashMap<String, Any?>(); skip(); if (text[at] == '}') { at++; return map }
                    while (true) { skip(); val key = string(); skip(); expect(':'); map[key] = value(); skip(); if (text[at] == ',') at++ else { expect('}'); return map } } }
                '[' -> { at++; val list = ArrayList<Any?>(); skip(); if (text[at] == ']') { at++; return list }
                    while (true) { list += value(); skip(); if (text[at] == ',') at++ else { expect(']'); return list } } }
                '"' -> string()
                else -> if (c == '-' || c.isDigit()) number() else throw IllegalArgumentException("Unexpected $c")
            }
        }
        private fun string(): String {
            expect('"')
            val end = text.indexOf('"', at)
            require(end >= 0 && text.substring(at, end).indexOf('\\') < 0)
            return text.substring(at, end).also { at = end + 1 }
        }
        private fun number(): Double {
            val start = at
            while (at < text.length && (text[at].isDigit() || text[at] in "-+.eE")) at++
            return text.substring(start, at).toDouble()
        }
        private fun skip() { while (at < text.length && text[at].isWhitespace()) at++ }
        private fun expect(c: Char) { require(text[at] == c) { "Expected $c" }; at++ }
    }
}

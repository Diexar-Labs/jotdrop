package com.diexar.keepcapture

import java.io.ByteArrayInputStream
import java.io.File
import javax.imageio.ImageIO

// A drawing stays a valid picture and keeps its lines, also after saving it again.
fun main(args: Array<String>) {
    val plain = File(args[0]).readBytes()
    val drawing = DrawingFormat.Drawing(1080, 1440, listOf(
        DrawingFormat.Stroke("#1F2937", 10f, listOf(10f, 20f, 30.25f, 40.5f, 50f, 60f)),
        DrawingFormat.Stroke("#dc2626", 4.5f, listOf(500f, 500f)),
    ))

    // The text form rounds to tenths and writes colours in lower case.
    val text = DrawingFormat.encode(drawing)
    check(text == """{"v":1,"w":1080,"h":1440,"strokes":[{"c":"#1f2937","s":10,"p":[10,20,30.3,40.5,50,60]},{"c":"#dc2626","s":4.5,"p":[500,500]}]}""") { text }
    val back = DrawingFormat.decode(text)!!
    check(back.width == 1080 && back.height == 1440 && back.strokes.size == 2)
    check(back.strokes[0].color == "#1f2937" && back.strokes[0].points == listOf(10f, 20f, 30.3f, 40.5f, 50f, 60f))

    // Inside a PNG: still a readable picture, the lines come back, and saving again keeps one copy.
    check(DrawingFormat.read(plain) == null) { "a plain picture has no drawing" }
    val once = DrawingFormat.withDrawing(plain, drawing)
    check(ImageIO.read(ByteArrayInputStream(once)) != null) { "the PNG must stay valid" }
    check(DrawingFormat.read(once) == back)
    val changed = drawing.copy(strokes = drawing.strokes.take(1))
    val twice = DrawingFormat.withDrawing(once, changed)
    check(ImageIO.read(ByteArrayInputStream(twice)) != null)
    check(DrawingFormat.read(twice)!!.strokes.size == 1)
    check(String(twice, Charsets.ISO_8859_1).split(DrawingFormat.KEYWORD).size == 2) { "only one drawing chunk" }

    // Anything else is not a drawing, and a broken stroke does not sink the rest.
    for (junk in listOf("", "[]", "{\"v\":2,\"w\":1,\"h\":1,\"strokes\":[]}", "{\"v\":1,\"w\":0,\"h\":1,\"strokes\":[]}", "not json")) check(DrawingFormat.decode(junk) == null) { junk }
    val partly = DrawingFormat.decode("""{"v":1,"w":10,"h":10,"strokes":[{"c":"red","s":1,"p":[1,1]},{"c":"#00ff00","s":2,"p":[1]},{"c":"#00FF00","s":2,"p":[1,2]}]}""")!!
    check(partly.strokes == listOf(DrawingFormat.Stroke("#00ff00", 2f, listOf(1f, 2f))))
    check(runCatching { DrawingFormat.withDrawing(byteArrayOf(1, 2, 3), drawing) }.isFailure)
    check(DrawingFormat.isDrawingName("drawing-2026-11-02 140501.png") && !DrawingFormat.isDrawingName("diexar-2026.png"))
    println("Drawing format checks passed: round trip, PNG stays valid, saved twice keeps one copy, junk refused")
}

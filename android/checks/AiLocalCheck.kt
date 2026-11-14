package com.diexar.keepcapture

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import java.security.MessageDigest
import kotlin.random.Random

/**
 * Ask JotDrop on this phone (phase 9) without a phone: the model list, the download (redirects, carrying on, a
 * server that ignores the range, a broken connection, a wrong hash, too little room, a foreign host, Stop), and the
 * engine with a fake model (graphics chip first, the processor as fallback and remembered, closing when idle, a
 * new file) and the provider (one request without tools, photos as files, recordings in pieces of 30 seconds, the
 * time limit, through AiAssistant), and the sound for the model (16 kHz mono, pieces cut at a quiet moment, WAV).
 */
private var passed = 0

private fun ok(condition: Boolean, what: String) { check(condition) { "FAIL: $what" }; passed++ }

private suspend fun code(what: String, block: suspend () -> Unit): String? = try { block(); null } catch (error: AiError) { error.code }.also { passed++ }

private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

private const val START = "https://huggingface.co/litert-community/test/resolve/abc/test.litertlm"
private const val CDN = "https://us.aws.cdn.hf.co/xet-bridge-us/test?Signature=x"

/** A file server in memory: huggingface.co redirects to the CDN, which serves [bytes] (or [served]) from a byte on. */
private class FakeServer(val bytes: ByteArray, var served: ByteArray = bytes) : AiRangeFetcher {
    val asked = mutableListOf<Pair<String, Long>>()
    var ignoreRange = false
    var breakAfter = -1
    var shortBy = 0
    var redirectTo = CDN
    var status = 0
    var onRead: (Int) -> Unit = {}

    override fun open(url: String, from: Long): AiRangeResponse {
        asked.add(url to from)
        if (url == START) return AiRangeResponse(302, redirectTo, null, 0, ByteArrayInputStream(ByteArray(0)))
        if (status != 0) return AiRangeResponse(status, null, null, 0, ByteArrayInputStream(ByteArray(0)))
        val start = if (ignoreRange) 0 else from.toInt()
        val body = served.copyOfRange(start, served.size - shortBy)
        var read = 0
        val stream = object : InputStream() {
            val inner = ByteArrayInputStream(body)
            override fun read(): Int = throw UnsupportedOperationException()
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                if (breakAfter in 0..read) throw IOException("connection reset")
                onRead(read)
                val n = inner.read(buffer, offset, minOf(length, 64 * 1024))
                if (n > 0) read += n
                return n
            }
        }
        // The length the server announces; an early end sends less than that.
        val announced = (served.size - start).toLong()
        return if (from > 0 && !ignoreRange) AiRangeResponse(206, null, "bytes $from-${served.size - 1}/${served.size}", announced, stream)
        else AiRangeResponse(200, null, null, announced, stream)
    }
}

private fun model(bytes: ByteArray, hash: String = sha(bytes)) = AiLocalModel("test", "Test", "test.litertlm", bytes.size.toLong(), hash, START)

private fun models() {
    ok(AiLocalModels.E2B.bytes == 2_588_147_712L && AiLocalModels.E2B.sha256.startsWith("181938105e0e") && AiLocalModels.E2B.sha256.endsWith("a63c"), "E2B size and hash")
    ok(AiLocalModels.E4B.bytes == 3_659_530_240L && AiLocalModels.E4B.sha256.length == 64, "E4B size and hash")
    for (model in AiLocalModels.ALL) {
        ok(AiLocalModels.allowed(model.url) && model.url.endsWith("/" + model.file) && !model.url.contains("/resolve/main/"), "${model.id} pinned to a revision on Hugging Face")
        ok(AiLocalModels.byId(model.id) == model, "${model.id} by id")
    }
    val gib = 1024L * 1024 * 1024
    ok(AiLocalModels.default(11 * gib + gib / 4) == AiLocalModels.E2B, "a 12 GB phone gets E2B")
    ok(AiLocalModels.default(15 * gib) == AiLocalModels.E4B, "a 16 GB phone gets E4B")
    ok(AiLocalModels.default(7 * gib + gib / 2) == AiLocalModels.E2B, "an 8 GB phone gets E2B")
    ok(AiLocalModels.tooLittleMemory(5 * gib + gib / 2) && !AiLocalModels.tooLittleMemory(7 * gib), "little memory below 6 GiB")
    ok(AiLocalModels.byId("") == null && AiLocalModels.byId("claude-haiku-5-5") == null, "an unknown id is no model")
    for (url in listOf("https://huggingface.co/x", "https://cdn-lfs.huggingface.co/x", "https://cas-bridge.xethub.hf.co/x", "https://us.aws.cdn.hf.co/x?a=b")) ok(AiLocalModels.allowed(url), "allowed $url")
    for (url in listOf("http://huggingface.co/x", "https://evilhf.co/x", "https://huggingface.co.evil.example/x", "https://hf.co.example/x", "ftp://huggingface.co/x", "not a url", "https://example.com/huggingface.co"))
        ok(!AiLocalModels.allowed(url), "refused $url")
    ok(AiModelDownload.rangeStart("bytes 100-199/200") == 100L && AiModelDownload.rangeStart("bytes */200") == -1L && AiModelDownload.rangeStart(null) == -1L, "Content-Range start")
}

private suspend fun downloads(root: File) {
    val bytes = Random(9).nextBytes(1_000_000)
    val plenty: (File) -> Long = { Long.MAX_VALUE }
    var case = 0
    fun dir() = File(root, "d${case++}").also { it.mkdirs() }

    // A fresh download: redirect followed, the whole file, checked, under its real name.
    run {
        val dir = dir(); val server = FakeServer(bytes); val shown = mutableListOf<Long>(); var checked = false
        val file = AiModelDownload.download(model(bytes), dir, server, plenty, { done, _ -> shown.add(done) }, { checked = true })
        ok(file.readBytes().contentEquals(bytes) && file.name == "test.litertlm", "fresh download complete")
        ok(!AiModelDownload.partFile(dir, model(bytes)).exists() && checked && shown.last() == bytes.size.toLong(), "part renamed, checked, progress at the end")
        ok(server.asked == listOf(START to 0L, CDN to 0L), "redirect followed from byte 0")
        ok(AiModelDownload.ready(dir, model(bytes)) == file, "ready after download")
        // Again: nothing is fetched.
        AiModelDownload.download(model(bytes), dir, server, plenty)
        ok(server.asked.size == 2, "a ready model is not fetched again")
        AiModelDownload.delete(dir, model(bytes))
        ok(AiModelDownload.ready(dir, model(bytes)) == null && !file.exists(), "delete")
    }
    // Carry on where it stopped: a Range from the bytes already there.
    run {
        val dir = dir(); val server = FakeServer(bytes)
        AiModelDownload.partFile(dir, model(bytes)).writeBytes(bytes.copyOf(400_000))
        ok(AiModelDownload.partial(dir, model(bytes)) == 400_000L, "partial bytes")
        val file = AiModelDownload.download(model(bytes), dir, server, plenty)
        ok(file.readBytes().contentEquals(bytes) && server.asked.last() == CDN to 400_000L, "carried on from byte 400000")
    }
    // A server that ignores the range sends it all: start over, no doubled bytes.
    run {
        val dir = dir(); val server = FakeServer(bytes).apply { ignoreRange = true }
        AiModelDownload.partFile(dir, model(bytes)).writeBytes(bytes.copyOf(300_000))
        ok(AiModelDownload.download(model(bytes), dir, server, plenty).readBytes().contentEquals(bytes), "range ignored: started over")
    }
    // A broken connection keeps what came in; the next try carries on.
    run {
        val dir = dir(); val server = FakeServer(bytes).apply { breakAfter = 500_000 }
        ok(code("broken") { AiModelDownload.download(model(bytes), dir, server, plenty) } == "network", "broken connection is network")
        val kept = AiModelDownload.partial(dir, model(bytes))
        ok(kept in 500_000L until bytes.size.toLong(), "broken connection keeps the bytes ($kept)")
        server.breakAfter = -1
        ok(AiModelDownload.download(model(bytes), dir, server, plenty).readBytes().contentEquals(bytes) && server.asked.last() == CDN to kept, "carried on after a break")
    }
    // A connection that ends early, without an error.
    run {
        val dir = dir(); val server = FakeServer(bytes).apply { shortBy = 1000 }
        ok(code("short") { AiModelDownload.download(model(bytes), dir, server, plenty) } == "network", "early end is network")
        server.shortBy = 0
        ok(AiModelDownload.download(model(bytes), dir, server, plenty).readBytes().contentEquals(bytes), "carried on after an early end")
    }
    // A wrong file of the right size: gone, nothing under the real name.
    run {
        val dir = dir(); val wrong = bytes.copyOf().also { it[123] = (it[123] + 1).toByte() }
        ok(code("hash") { AiModelDownload.download(model(bytes), dir, FakeServer(bytes, wrong), plenty) } == "model_hash", "wrong hash")
        ok(dir.listFiles()!!.isEmpty(), "wrong file removed")
    }
    // Too little room: nothing is asked.
    run {
        val dir = dir(); val server = FakeServer(bytes)
        ok(code("room") { AiModelDownload.download(model(bytes), dir, server, { AiModelDownload.SPARE }) } == "model_space" && server.asked.isEmpty(), "too little room, nothing fetched")
        ok(AiModelDownload.missingRoom(model(bytes), 0, AiModelDownload.SPARE + bytes.size) == null, "exactly enough room")
        ok(AiModelDownload.missingRoom(model(bytes), 400_000, AiModelDownload.SPARE + 600_000) == null, "room counts what is there")
    }
    // A redirect to another host, plain http, or a server error.
    run {
        val dir = dir()
        ok(code("host") { AiModelDownload.download(model(bytes), dir, FakeServer(bytes).apply { redirectTo = "https://example.com/model" }, plenty) } == "server", "foreign host refused")
        ok(code("http") { AiModelDownload.download(model(bytes), dir, FakeServer(bytes).apply { redirectTo = "http://us.aws.cdn.hf.co/x" }, plenty) } == "server", "plain http refused")
        ok(code("503") { AiModelDownload.download(model(bytes), dir, FakeServer(bytes).apply { status = 503 }, plenty) } == "server", "server error")
        ok(code("bigger") { AiModelDownload.download(model(bytes), dir, FakeServer(bytes, bytes + byteArrayOf(1)), plenty) } == "server", "a file of another size")
        ok(dir.listFiles()!!.none { it.length() > 0 && it.name == "test.litertlm" }, "nothing under the real name")
    }
    // Stop: the part stays for Continue.
    run {
        val dir = dir()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val server = FakeServer(bytes)
        val job = scope.launch { AiModelDownload.download(model(bytes), dir, server, plenty) }
        server.onRead = { read -> if (read >= 300_000) job.cancel() }
        job.join()
        val kept = AiModelDownload.partial(dir, model(bytes))
        ok(job.isCancelled && kept in 300_000L until bytes.size.toLong() && AiModelDownload.ready(dir, model(bytes)) == null, "Stop keeps the part ($kept)")
        scope.cancel()
    }
    // A part longer than the model is from something else: started over.
    run {
        val dir = dir()
        AiModelDownload.partFile(dir, model(bytes)).writeBytes(ByteArray(bytes.size + 5))
        ok(AiModelDownload.download(model(bytes), dir, FakeServer(bytes), plenty).readBytes().contentEquals(bytes), "too long part started over")
    }
}

/** A fake model: [fails] are the backends that do not load; it answers [answer] after [takes] ms. */
private class FakeLoader(val fails: Set<String> = emptySet(), var answer: String = "  It works.  ", var takes: Long = 0, var loadTakes: Long = 0) : AiLocalLoader {
    val loads = mutableListOf<Pair<String, String>>()
    var closed = 0
    var cancelled = 0
    var asked: Pair<String, String>? = null
    val media = mutableListOf<List<AiLocalMedia>>()
    // What each file held when the model got it (the provider deletes them afterwards).
    val seen = mutableListOf<ByteArray>()
    var answers: MutableList<String>? = null
    override fun load(path: String, backend: String): AiLocalRunner {
        loads.add(path to backend)
        // Loading blocks and cannot be interrupted, as LiteRT-LM's.
        if (loadTakes > 0) Thread.sleep(loadTakes)
        if (backend in fails) throw IllegalStateException("$backend not available")
        return object : AiLocalRunner {
            override suspend fun generate(system: String, prompt: String, media: List<AiLocalMedia>): String {
                asked = system to prompt
                this@FakeLoader.media.add(media)
                media.forEach { seen.add(File(it.path).readBytes()) }
                try { delay(takes) } catch (error: CancellationException) { cancelled++; throw error }
                return answers?.removeFirstOrNull() ?: answer
            }
            override fun close() { closed++ }
        }
    }
}

private suspend fun engines() {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    var stored: String? = null
    fun engine(loader: FakeLoader, idle: Long = 60_000) = AiLocalEngine(loader, { stored }, { stored = it }, scope, idle)

    // The graphics chip works: loaded once, kept, remembered.
    run {
        val loader = FakeLoader(); val engine = engine(loader); var loading = 0
        repeat(2) { engine.use("/m/a", { loading++ }) { it.generate("s", "p") } }
        ok(loader.loads == listOf("/m/a" to "gpu") && loading == 1 && engine.backend == "gpu" && stored == "gpu", "gpu loaded once and remembered")
        engine.use("/m/b") { it.generate("s", "p") }
        ok(loader.closed == 1 && loader.loads.last() == "/m/b" to "gpu", "another file closes the first")
        engine.close()
        ok(loader.closed == 2 && engine.backend == null, "close")
    }
    // The graphics chip fails: the processor, remembered; the next time straight to the processor.
    run {
        stored = null
        val loader = FakeLoader(fails = setOf("gpu"))
        engine(loader).use("/m/a") { it.generate("s", "p") }
        ok(loader.loads == listOf("/m/a" to "gpu", "/m/a" to "cpu") && stored == "cpu", "gpu fails, cpu works")
        val again = FakeLoader()
        engine(again).use("/m/a") { it.generate("s", "p") }
        ok(again.loads == listOf("/m/a" to "cpu"), "cpu remembered")
    }
    // The app died while loading on the graphics chip: straight to the processor.
    run {
        stored = AiLocalEngine.TRYING_GPU
        val loader = FakeLoader()
        engine(loader).use("/m/a") { it.generate("s", "p") }
        ok(loader.loads == listOf("/m/a" to "cpu") && stored == "cpu", "after a crash on the gpu: cpu")
    }
    // Neither works.
    run {
        stored = null
        ok(code("none") { engine(FakeLoader(fails = setOf("gpu", "cpu"))).use("/m/a") { it.generate("s", "p") } } == "local_load", "nothing loads: local_load")
    }
    // Idle: closed after the time, not before.
    run {
        stored = null
        val loader = FakeLoader(); val engine = engine(loader, idle = 200)
        engine.use("/m/a") { it.generate("s", "p") }
        delay(50)
        engine.use("/m/a") { it.generate("s", "p") }
        delay(100)
        ok(loader.closed == 0, "not closed while in use")
        delay(400)
        ok(loader.closed == 1 && engine.backend == null && loader.loads.size == 1, "closed when idle")
    }
    // Stop while loading: the load finishes, the model is kept (not lost with its memory) and closed when idle.
    run {
        stored = null
        val loader = FakeLoader(loadTakes = 300); val engine = engine(loader, idle = 300)
        val asking = scope.launch { engine.use("/m/a") { it.generate("s", "p") } }
        delay(100)
        asking.cancel()
        asking.join()
        ok(asking.isCancelled && engine.backend == "gpu" && loader.asked == null, "Stop while loading: the model is kept, nothing asked")
        engine.use("/m/a") { it.generate("s", "p") }
        ok(loader.loads.size == 1, "the kept model is used next time, not loaded again")
        delay(600)
        ok(loader.closed == 1 && engine.backend == null, "and closed when idle")
    }
    scope.cancel()
}

/** Files in a temporary folder: a photo as its bytes, a recording as [pieces] files (or [problem]). */
private class FakeFiles(val dir: File) : AiLocalFiles {
    val made = mutableListOf<File>()
    var pieces = 1
    var problem: AiError? = null
    var askedMax = 0
    override fun image(part: AiPart): File = File.createTempFile("img", ".jpg", dir).apply { writeBytes(part.bytes) }.also { made.add(it) }
    override fun audio(part: AiPart, maxSeconds: Int): List<File> {
        askedMax = maxSeconds
        problem?.let { throw it }
        return (1..pieces).map { n -> File.createTempFile("piece", ".wav", dir).apply { writeBytes(byteArrayOf(n.toByte())) }.also { made.add(it) } }
    }
}

private suspend fun providers(root: File) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val loader = FakeLoader()
    val engine = AiLocalEngine(loader, { "gpu" }, { }, scope)
    val files = FakeFiles(File(root, "files").also { it.mkdirs() })
    val states = mutableListOf<Boolean>()
    val provider = AiLocalProvider(engine, AiLocalModels.E2B, "/m/e2b", files) { states.add(it) }
    ok(provider.id == "phone" && provider.model == "gemma-4-E2B-it", "provider id and model")
    ok(provider.capabilities.of("image") == true && provider.capabilities.of("pdf") == false && provider.capabilities.of("audio") == false &&
        provider.capabilities.of("transcribe") == true, "reads photos and writes out recordings; no PDFs, no recording as a question")
    ok(AiParts.capabilities("phone", null) == provider.capabilities, "AiParts knows the phone the same way (the screen asks it)")
    ok(AiParts.explain("phone", "pdf") == "The model on this phone cannot read PDFs. Gemini, OpenAI, Claude and OpenRouter can.", "a PDF on the phone: said in words")

    val answer = provider.complete("Summarize.", listOf(AiMessage.User("Note text")), emptyList(), 5000)
    ok(answer.text == "It works." && answer.stop == "end" && answer.toolCalls.isEmpty() && loader.asked == ("Summarize." to "Note text") && loader.media.last().isEmpty(), "one request, answer trimmed")
    ok(states == listOf(true, false), "loading: true while the model loads, false once it answers")
    loader.answer = "   "
    ok(provider.complete("s", listOf(AiMessage.User("p")), emptyList(), 5000).text == "", "an empty answer stays empty")
    loader.answer = "Fine."

    val tool = AiTool("search_notes", "read", "Search", emptyMap<String, Any?>())
    ok(code("tools") { provider.complete("s", listOf(AiMessage.User("p")), listOf(tool), 5000) } == "local_unsupported", "tools: not yet")
    // A photo goes to the model as a file, which is gone afterwards.
    val photo = byteArrayOf(1, 2, 3)
    val read = provider.complete(AiParts.PHOTO_SYSTEM, listOf(AiMessage.User("Write out the text.", listOf(AiPart("image", "image/jpeg", "a.jpg", photo)))), emptyList(), 5000)
    ok(read.text == "Fine." && loader.media.last().map { it.kind } == listOf("image") && loader.seen.last().contentEquals(photo), "a photo goes as a file")
    ok(files.made.isNotEmpty() && files.made.none { it.exists() }, "the photo's file is deleted after the answer")
    ok(code("pdf") { provider.complete("s", listOf(AiMessage.User("p", listOf(AiPart("pdf", "application/pdf", "a.pdf", ByteArray(3))))), emptyList(), 5000) } == "unsupported_input", "a PDF: unsupported_input")
    ok(code("audio") { provider.complete("s", listOf(AiMessage.User("p", listOf(AiPart("audio", "audio/mp4", "a.m4a", ByteArray(3))))), emptyList(), 5000) } == "unsupported_input", "a recording as a question: unsupported_input")

    // A recording: each piece on its own, with the fixed request, the answers joined; the pieces are gone afterwards.
    files.made.clear()
    files.pieces = 3
    loader.answers = mutableListOf(" First part. ", "", "Third part.")
    val heard = provider.transcribe(AiPart("audio", "audio/mp4", "memo.m4a", ByteArray(10)), "nl-NL", 5000)
    ok(heard.text == "First part. Third part." && loader.asked == (AiLocalPrompt.TRANSCRIBE_SYSTEM to AiLocalPrompt.TRANSCRIBE), "a recording in pieces, joined, empty pieces left out")
    ok(loader.media.takeLast(3).map { m -> m.map { it.kind } } == List(3) { listOf("audio") } && loader.seen.takeLast(3).map { it[0].toInt() } == listOf(1, 2, 3), "each piece once, in order")
    ok(files.askedMax == AiLocalAudio.MAX_SECONDS && files.made.size == 3 && files.made.none { it.exists() }, "at most 5 minutes; the pieces are deleted after")
    loader.answers = null
    files.problem = AiError("too_large", "memo.m4a is longer than 5 minutes.")
    ok(code("long") { provider.transcribe(AiPart("audio", "audio/mp4", "memo.m4a", ByteArray(10)), null, 5000) } == "too_large", "a recording that is too long: too_large")
    files.problem = null
    files.pieces = 1
    ok(code("talk") { provider.complete("s", listOf(AiMessage.User("p"), AiMessage.Assistant("a", emptyList()), AiMessage.User("q")), emptyList(), 5000) } == "local_unsupported", "a conversation: not yet")

    // The time limit stops the answer itself.
    loader.takes = 5000
    val before = loader.cancelled
    ok(code("slow") { provider.complete("s", listOf(AiMessage.User("p")), emptyList(), 100) } == "timeout" && loader.cancelled == before + 1, "time limit cancels the answer")
    loader.takes = 0

    // Through Ask JotDrop's own code: a fixed request works, a free question with tools says why not.
    var given = 0L
    val once = AiAssistant.once("Summarize", emptyList(), provider = { provider }, secrets = emptyList(), timeoutMs = AiLocalModels.TIMEOUT_MS) { ai, time ->
        given = time; ai.complete("s", listOf(AiMessage.User("p")), emptyList(), time)
    }
    ok(once.stop == "done" && once.answer == "Fine." && given == AiLocalModels.TIMEOUT_MS && once.timeoutMs == AiLocalModels.TIMEOUT_MS, "AiAssistant.once with the phone, with the phone's time")
    val editor = AiAssistant.run("Summarize the note", listOf(AiNote("n1", "Plan", "Text")), emptyList(), emptyList(), AiLocalPrompt.system("Dutch", "2026-11-14 Saturday", "Europe/Madrid"),
        provider = { provider }, executor = emptyMap(), confirm = { false }, timeoutMs = AiLocalModels.TIMEOUT_MS, maxChars = AiLocalModels.MAX_CHARS,
        chosen = AiContext.selectNotes(listOf(AiNote("n1", "Plan", "Text")), "", maxChars = AiLocalModels.MAX_CHARS, pinned = listOf("n1")).notes)
    ok(editor.stop == "done" && editor.answer == "Fine." && editor.sent.map { it.id } == listOf("n1") && loader.asked?.first?.contains("nothing leaves it") == true, "AiAssistant.run without tools: a fixed action with the note")
    val free = AiAssistant.run("What is on my list?", emptyList(), emptyList(), listOf(tool), "system", provider = { provider }, executor = emptyMap(), confirm = { false })
    ok(free.stop == "error" && free.error?.code == "local_unsupported", "AiAssistant.run with tools: local_unsupported")
    val missing = AiAssistant.once("Summarize", emptyList(), provider = { throw AiError("model_missing") }, secrets = emptyList()) { ai, time -> ai.complete("s", emptyList(), emptyList(), time) }
    ok(missing.stop == "error" && missing.error?.code == "model_missing", "no model yet: model_missing")
    // The phone's limits: the note list and the week take less text at once.
    val notes = (1..4).map { AiNote("n$it", "Note $it", "word ".repeat(1000)) }
    val plan = AiAsk.plan(notes, "word", maxChars = AiLocalModels.MAX_CHARS)
    ok(plan.chosen.sumOf { it.title.length + it.text.length } <= AiLocalModels.MAX_CHARS && plan.chosen.size == 2 && plan.chosen.last().truncated &&
        AiAsk.plan(notes, "word").chosen.size == 4, "the list of what goes along keeps to the phone's limit")
    val long = AiNote("n9", "Long", "x".repeat(AiContext.MAX_NOTE_CHARS + 500))
    ok(AiAsk.plan(listOf(long), "", pinned = "n9", target = true, summarize = true, maxChars = AiLocalModels.MAX_CHARS).chosen.single().truncated,
        "a long note is cut (the phone's screen then says it is too long, so Replace never loses text)")
    scope.cancel()
}

/** The sound for the model: rate and channels, the pieces and the WAV header. */
private fun audio() {
    val rate = AiLocalAudio.RATE
    // Already 16 kHz mono: unchanged, also over several chunks.
    val same = AiLocalAudio.Resampler(rate, 1)
    val input = ShortArray(1000) { (it * 7 - 3000).toShort() }
    val through = same.feed(input.copyOfRange(0, 333)) + same.feed(input.copyOfRange(333, 1000))
    ok(through.contentEquals(input), "16 kHz mono stays as it is")
    // 48 kHz stereo: a third of the frames, both channels averaged.
    val stereo = AiLocalAudio.Resampler(48_000, 2)
    val frames = 48_000
    val pcm = ShortArray(frames * 2) { if (it % 2 == 0) 1000 else 3000 }
    val out = (0 until 4).map { stereo.feed(pcm.copyOfRange(it * frames / 2, (it + 1) * frames / 2)) }.reduce { a, b -> a + b }
    ok(out.size in 15_999..16_001 && out.all { it.toInt() == 2000 }, "48 kHz stereo: one second becomes 16,000 samples, channels averaged (${out.size})")
    // 22.05 kHz: a rising line stays a rising line across chunks.
    val odd = AiLocalAudio.Resampler(22_050, 1)
    val ramp = ShortArray(22_050) { it.toShort() }
    val rose = odd.feed(ramp.copyOfRange(0, 10_001)) + odd.feed(ramp.copyOfRange(10_001, 22_050))
    ok(rose.size in 15_999..16_001 && (1 until rose.size).all { rose[it] > rose[it - 1] }, "22.05 kHz: the right length, no jump between chunks")

    // Pieces: short stays one piece; long is cut at the quiet moment in the last 5 seconds of each 30.
    ok(AiLocalAudio.pieces(ShortArray(rate * 20)) == listOf(0 to rate * 20), "20 seconds: one piece")
    val loud = ShortArray(rate * 70) { if (it % 2 == 0) 8000 else -8000 }
    val quiet = rate * 27
    for (i in quiet until quiet + rate / 10) loud[i] = 0
    val cut = AiLocalAudio.pieces(loud)
    ok(cut.first() == 0 to quiet + rate / 20 && cut.zipWithNext().all { (a, b) -> a.second == b.first } && cut.last().second == loud.size, "70 seconds: cut in the quiet moment, no gaps")
    ok(cut.all { it.second - it.first <= rate * AiLocalAudio.PIECE_SECONDS } && cut.size == 3, "every piece at most 30 seconds")
    ok(AiLocalAudio.pieces(ShortArray(rate * 30)).size == 1 && AiLocalAudio.pieces(ShortArray(0)).isEmpty(), "exactly 30 seconds: one piece; nothing: no piece")

    // WAV: a 44-byte header for 16-bit mono at 16 kHz, then the samples, little-endian.
    val wav = AiLocalAudio.wav(shortArrayOf(1, -2, 3, 4), 1, 3)
    val head = java.nio.ByteBuffer.wrap(wav).order(java.nio.ByteOrder.LITTLE_ENDIAN)
    ok(String(wav, 0, 4) == "RIFF" && String(wav, 8, 8) == "WAVEfmt " && String(wav, 36, 4) == "data", "WAV header")
    ok(head.getInt(4) == 36 + 4 && head.getShort(22).toInt() == 1 && head.getInt(24) == rate && head.getShort(34).toInt() == 16 && head.getInt(40) == 4, "WAV sizes, mono, 16 kHz, 16 bit")
    ok(wav.size == 48 && head.getShort(44).toInt() == -2 && head.getShort(46).toInt() == 3, "WAV samples")
}

fun main() = runBlocking {
    models()
    val root = Files.createTempDirectory("jotdrop-ai-local").toFile()
    try { downloads(root) } finally { root.deleteRecursively() }
    engines()
    val files = Files.createTempDirectory("jotdrop-ai-local-files").toFile()
    try { providers(files) } finally { files.deleteRecursively() }
    audio()
    println("PASS: Ask JotDrop on this phone: models, download, engine, provider and sound ($passed checks)")
}

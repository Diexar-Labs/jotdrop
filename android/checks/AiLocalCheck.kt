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
 * new file) and the provider (only one request without tools or files, the time limit, through AiAssistant).
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
    ok(AiLocalModels.default(11 * gib + gib / 4) == AiLocalModels.E4B, "a 12 GB phone gets E4B")
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
private class FakeLoader(val fails: Set<String> = emptySet(), var answer: String = "  It works.  ", var takes: Long = 0) : AiLocalLoader {
    val loads = mutableListOf<Pair<String, String>>()
    var closed = 0
    var cancelled = 0
    var asked: Pair<String, String>? = null
    override fun load(path: String, backend: String): AiLocalRunner {
        loads.add(path to backend)
        if (backend in fails) throw IllegalStateException("$backend not available")
        return object : AiLocalRunner {
            override suspend fun generate(system: String, prompt: String): String {
                asked = system to prompt
                try { delay(takes) } catch (error: CancellationException) { cancelled++; throw error }
                return answer
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
    scope.cancel()
}

private suspend fun providers() {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val loader = FakeLoader()
    val engine = AiLocalEngine(loader, { "gpu" }, { }, scope)
    val provider = AiLocalProvider(engine, AiLocalModels.E2B, "/m/e2b")
    ok(provider.id == "phone" && provider.model == "gemma-4-E2B-it" && provider.capabilities.of("image") == false && provider.capabilities.of("audio") == false, "provider id, model, no files yet")

    val answer = provider.complete("Summarize.", listOf(AiMessage.User("Note text")), emptyList(), 5000)
    ok(answer.text == "It works." && answer.stop == "end" && answer.toolCalls.isEmpty() && loader.asked == ("Summarize." to "Note text"), "one request, answer trimmed")
    loader.answer = "   "
    ok(provider.complete("s", listOf(AiMessage.User("p")), emptyList(), 5000).text == "", "an empty answer stays empty")
    loader.answer = "Fine."

    val tool = AiTool("search_notes", "read", "Search", emptyMap<String, Any?>())
    ok(code("tools") { provider.complete("s", listOf(AiMessage.User("p")), listOf(tool), 5000) } == "local_unsupported", "tools: not yet")
    ok(code("files") { provider.complete("s", listOf(AiMessage.User("p", listOf(AiPart("image", "image/png", "a.png", ByteArray(3))))), emptyList(), 5000) } == "local_unsupported", "files: not yet")
    ok(code("talk") { provider.complete("s", listOf(AiMessage.User("p"), AiMessage.Assistant("a", emptyList()), AiMessage.User("q")), emptyList(), 5000) } == "local_unsupported", "a conversation: not yet")

    // The time limit stops the answer itself.
    loader.takes = 5000
    val before = loader.cancelled
    ok(code("slow") { provider.complete("s", listOf(AiMessage.User("p")), emptyList(), 100) } == "timeout" && loader.cancelled == before + 1, "time limit cancels the answer")
    loader.takes = 0

    // Through Ask JotDrop's own code: a fixed request works, a free question with tools says why not.
    val once = AiAssistant.once("Summarize", emptyList(), provider = { provider }, secrets = emptyList()) { ai, time -> ai.complete("s", listOf(AiMessage.User("p")), emptyList(), time) }
    ok(once.stop == "done" && once.answer == "Fine.", "AiAssistant.once with the phone")
    val free = AiAssistant.run("What is on my list?", emptyList(), emptyList(), listOf(tool), "system", provider = { provider }, executor = emptyMap(), confirm = { false })
    ok(free.stop == "error" && free.error?.code == "local_unsupported", "AiAssistant.run with tools: local_unsupported")
    val missing = AiAssistant.once("Summarize", emptyList(), provider = { throw AiError("model_missing") }, secrets = emptyList()) { ai, time -> ai.complete("s", emptyList(), emptyList(), time) }
    ok(missing.stop == "error" && missing.error?.code == "model_missing", "no model yet: model_missing")
    scope.cancel()
}

fun main() = runBlocking {
    models()
    val root = Files.createTempDirectory("jotdrop-ai-local").toFile()
    try { downloads(root) } finally { root.deleteRecursively() }
    engines()
    providers()
    println("PASS: Ask JotDrop on this phone: models, download, engine and provider ($passed checks)")
}

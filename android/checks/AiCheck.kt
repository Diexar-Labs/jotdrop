package com.diexar.keepcapture

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.runBlocking
import java.io.File
import java.io.OutputStream
import java.util.Base64

/**
 * Holds Android's Ask JotDrop to the shared one: every case of cloud/shared/ai/ai-vectors.json (requests per
 * provider, answers, errors, model lists, addresses, note choice, hiding keys, whole conversations), the tool list
 * and prompt from tools.json and prompt.json, and note edits computed by cloud/web/ai-web.mjs
 * (scripts/check-ai-android.mjs writes those and runs this). Version 2 (files, transcription, receipts): every case
 * of ai-vectors-v2.json, and the file table and receipt lines as cloud/web/ai-web.mjs makes them.
 * Arguments: ai-vectors.json, tools.json, prompt.json, edits.json, ai-vectors-v2.json.
 */
private var passed = 0

private fun same(actual: Any?, expected: Any?, what: String) {
    check(normal(actual) == normal(expected)) { "$what differs:\n  got      ${AiJson.stringify(normal(actual))}\n  expected ${AiJson.stringify(normal(expected))}" }
    passed++
}

// Numbers compare as numbers, whatever their Kotlin type.
private fun normal(value: Any?): Any? = when (value) {
    is Map<*, *> -> value.entries.associate { (key, item) -> key.toString() to normal(item) }
    is List<*> -> value.map(::normal)
    is Int -> value.toLong()
    is Double -> if (value == Math.floor(value) && value.isFinite()) value.toLong() else value
    else -> value
}

@Suppress("UNCHECKED_CAST")
private fun config(json: Map<String, Any?>?) = AiConfig(json.str("provider") ?: "", json.str("key") ?: "", json.str("model") ?: "", json.str("baseUrl") ?: "", json?.get("inputs") as? List<String>)

// A file from the vectors: data is base64, or size gives that many zero bytes (fakeData in the JavaScript tests).
private fun part(json: Map<String, Any?>): AiPart = AiPart(json.str("kind") ?: "", json.str("mime") ?: "", json.str("name") ?: "",
    json.num("size")?.let { ByteArray(it.toInt()) } ?: Base64.getDecoder().decode(json.str("data") ?: ""))

@Suppress("UNCHECKED_CAST")
private fun message(json: Map<String, Any?>): AiMessage = when (json["role"]) {
    "user" -> AiMessage.User(json.str("text") ?: "", json.items("parts").map { part(it.obj()!!) })
    "tool" -> AiMessage.Tool(json.items("results").map { val r = it.obj(); AiToolResult(r.str("id")!!, r.str("name")!!, r.str("content")!!, r?.get("isError") == true) })
    else -> AiMessage.Assistant(json.str("text") ?: "", json.items("toolCalls").map(::toolCall), json["raw"])
}

private fun toolCall(value: Any?): AiToolCall { val c = value.obj(); return AiToolCall(c.str("id")!!, c.str("name")!!, c.child("input"), c.str("error")) }

private fun callJson(call: AiToolCall): Map<String, Any?> = linkedMapOf<String, Any?>("id" to call.id, "name" to call.name, "input" to call.input).also { if (call.error != null) it["error"] = call.error }

private fun note(value: Any?): AiNote {
    val n = value.obj()
    @Suppress("UNCHECKED_CAST")
    return AiNote(n.str("id")!!, n.str("title") ?: "", n.str("text") ?: "", (n?.get("labels") as? List<String>) ?: emptyList(), n.str("updatedAt"), n?.get("shared") == true, n.str("reminder"), n.str("expires"))
}

private fun fetcherFor(replies: MutableList<Map<String, Any?>>, urls: MutableList<String>) = AiFetcher { request, _ ->
    urls.add(request.url)
    val next = replies.removeFirstOrNull() ?: error("Unexpected call to ${request.url}")
    AiHttpResponse((next["status"] as? Number)?.toInt() ?: 200, next.str("text") ?: AiJson.stringify(next["body"]))
}

/**
 * Android's ask screen (10 Nov 2026, Eric's phone test of 0.28.51): what goes along is decided in one place, at the
 * moment of sending, and is exactly what the screen shows.
 */
private suspend fun askScreen(tools: List<AiTool>, promptJson: String) {
    val shopping = AiNote("n1", "Shopping list", "- [ ] eggs\nPut the new text here", updatedAt = "2026-11-01T10:00:00.000Z")
    val boiler = AiNote("n2", "Boiler", "Make a note of the new pressure. Put the list of parts in the text.", updatedAt = "2026-11-02T10:00:00.000Z")
    val pin = AiNote("n3", "Wifi at oma's", "The code is 1234", updatedAt = "2026-11-03T10:00:00.000Z")
    val notes = listOf(shopping, boiler, pin)
    fun ids(plan: AiPlan) = plan.chosen.map { it.id }

    // Bug A: "Summarize with AI" from a card sent only the request. The card's note goes, and only that one.
    val summary = AiAsk.plan(notes, AiNoteEdits.editorRequest("summarize", pin.title), pinned = "n3", target = true, summarize = true)
    same(ids(summary), listOf("n3"), "summarize: the card's note goes along")
    same(summary.notes.map { it.id }, listOf("n3"), "summarize: the AI sees no other note")
    same(summary.missing, false, "summarize: found")
    // The card's note could not be read: nothing goes out, and the screen says so.
    val lost = AiAsk.plan(notes, "Summarize the note", pinned = null, target = true, summarize = true)
    same(lost.missing, true, "summarize without the note: missing")
    same(ids(lost), emptyList<String>(), "summarize without the note: nothing chosen")
    same(AiAsk.plan(notes, "What is in it?", pinned = null, target = true, summarize = false).missing, true, "ask about a note that is gone: missing")
    // "Ask JotDrop about this note…": that note first, whatever the question says.
    same(ids(AiAsk.plan(notes, "boiler pressure", pinned = "n3", target = true, summarize = false)).first(), "n3", "ask about a note: it goes first")

    // A request to make something new takes no notes along: the AI can still search when it needs one.
    for (request in listOf(
        "Make a new note titled AI proef with the text hallo",
        "Create a checklist for the trip",
        "Maak een nieuwe notitie met de tekst hallo",
        "Maak een lijst voor de verhuizing",
        "Erstelle eine neue Notiz mit dem Text hallo",
        "Crea una nota nueva con el texto hola",
        "Crée une nouvelle note avec le texte bonjour",
        "Crea una nuova nota con il testo ciao",
    )) {
        same(AiAsk.isCreate(request), true, "create: $request")
        same(ids(AiAsk.plan(notes, request)), emptyList<String>(), "create sends no notes: $request")
    }
    // Changing a note of your own is not making a new one.
    for (request in listOf("Make my shopping list shorter", "Put milk and bread on my shopping list", "Maak mijn boodschappenlijst korter")) same(AiAsk.isCreate(request), false, "not create: $request")
    // Words that say what to do (put, new, text, list, note, make) pick no note; the words about the thing do.
    same(ids(AiAsk.plan(notes, "Put milk and bread on my shopping list")), listOf("n1"), "instruction words pick no note")
    same(ids(AiAsk.plan(notes, "Make a note with the new text")), emptyList<String>(), "only instruction words: nothing goes")
    same(ids(AiAsk.plan(notes, "What was the wifi code at oma's?")), listOf("n3"), "a question still finds its note")

    // Unticking a note: the count goes down, no other note takes its place, and the AI cannot search it.
    val tea = (1..3).map { AiNote("t$it", "Tea $it", "tea", updatedAt = "2026-11-0${it}T10:00:00.000Z") }
    val all = AiAsk.plan(tea, "tea", maxNotes = 2)
    same(ids(all), listOf("t3", "t2"), "two of three fit")
    val untick = AiAsk.plan(tea, "tea", excluded = setOf("t3"), maxNotes = 2)
    same(ids(untick), listOf("t2"), "unticked: one goes, the third does not slip in")
    same(untick.shown.map { it.id }, listOf("t3", "t2"), "unticked: still on the list, to tick again")
    same(untick.notes.map { it.id }, listOf("t1", "t2"), "unticked: the AI cannot search it")
    same(ids(AiAsk.plan(tea, "tea", excluded = setOf("t1", "t2", "t3"))), emptyList<String>(), "untick all: nothing goes")

    // The request carries exactly the notes the screen showed, no more.
    val sent = AiAssistant.run(
        request = "tea", notes = untick.notes, labels = emptyList(), tools = tools,
        system = AiPrompt.system(promptJson, "English", "2026-11-10", "Europe/Madrid", emptyList()),
        provider = { object : AiProvider {
            override val id = "fake"
            override val model = "fake"
            override suspend fun complete(system: String, messages: List<AiMessage>, tools: List<AiTool>, timeoutMs: Long) = AiAnswer("ok", emptyList(), "end", 1, 1, null)
        } },
        executor = emptyMap(), confirm = { false }, chosen = untick.chosen,
    )
    same(sent.sent.map { it.id }, listOf("t2"), "sent: exactly what the screen showed")
    check(!(sent.messages.first() as AiMessage.User).text.contains("Tea 1")) { "sent: a note that was not shown went along" }
    passed++

    // On screen a note is one short line, whatever its first line is; the report names notes the same way.
    val long = "word ".repeat(80).trim()
    check(AiAsk.shortTitle(long).length <= AiAsk.SHORT + 1 && AiAsk.shortTitle(long).endsWith("…")) { "short title: ${AiAsk.shortTitle(long)}" }
    passed++
    same(AiAsk.shortTitle("  First line\nsecond line"), "First line", "short title: first line")
    same(AiAsk.firstLine(AiNote("x", "T", "\n\n  - [ ] eggs and more\nmilk")), "- [ ] eggs and more", "first line of the text")
    same(AiAsk.firstLine(AiNote("x", "T", "")), "", "first line of an empty note")
    same(AiAsk.firstLine(AiNote("x", "T", "![[0eec0ddc568e.webp]]\nbuy milk")), "buy milk", "first line: a wiki embed is skipped")
    same(AiAsk.firstLine(AiNote("x", "T", "\n  ![chart](img/chart.png)  \n\n![[b.png]]\nsecond")), "second", "first line: markdown images and embeds are skipped")
    same(AiAsk.firstLine(AiNote("x", "T", "![[only.webp]]\n![[two.webp]]")), "", "first line: only embeds gives no line")
    same(AiAsk.firstLine(AiNote("x", "T", "see ![[inline.webp]] here")), "see ![[inline.webp]] here", "first line: an embed inside text stays")
}

/**
 * 10 Nov 2026, Eric's phone: the answer showed **AI testnotitie** with its stars. Simple Markdown is shown as
 * bold, italic, code, headings and bullets; nothing else is interpreted (no HTML, no links that open by themselves).
 */
private fun markdown() {
    fun blocks(text: String) = AiMarkdown.parse(text).map { listOf(it.kind.name, it.level, it.spans.map { s -> s.text + (if (s.bold) "|b" else "") + (if (s.italic) "|i" else "") + (if (s.code) "|c" else "") }) }
    @Suppress("UNCHECKED_CAST") fun spans(text: String) = blocks(text).single()[2] as List<String>

    same(spans("Plain text"), listOf("Plain text"), "markdown: plain")
    same(spans("A **bold** word"), listOf("A ", "bold|b", " word"), "markdown: bold")
    same(spans("A __bold__ word"), listOf("A ", "bold|b", " word"), "markdown: bold with underscores")
    same(spans("An *italic* word"), listOf("An ", "italic|i", " word"), "markdown: italic")
    same(spans("An _italic_ word"), listOf("An ", "italic|i", " word"), "markdown: italic with underscores")
    same(spans("Use `code` here"), listOf("Use ", "code|c", " here"), "markdown: code")
    same(spans("**bold and *both* here**"), listOf("bold and |b", "both|b|i", " here|b"), "markdown: italic inside bold")
    same(spans("`**not bold**`"), listOf("**not bold**|c"), "markdown: code keeps its stars")
    same(spans("snake_case_name and 2*3*4"), listOf("snake_case_name and 2*3*4"), "markdown: underscores in words and spaced stars stay")
    same(spans("a * b * c and ** x"), listOf("a * b * c and ** x"), "markdown: stars with spaces stay")
    same(spans("Unclosed **bold and `code"), listOf("Unclosed **bold and `code"), "markdown: unclosed marks stay as typed")
    same(spans("<b>html</b> [link](http://x.y)"), listOf("<b>html</b> [link](http://x.y)"), "markdown: no HTML and no links")
    same(spans("**AI testnotitie**"), listOf("AI testnotitie|b"), "markdown: the case from the phone")

    fun b(kind: MdKind, level: Int, vararg parts: String) = listOf(kind.name, level, parts.toList())
    same(blocks("# Title\n## Smaller\n###### Last\n####### seven"), listOf(
        b(MdKind.HEADING, 1, "Title|b"), b(MdKind.HEADING, 2, "Smaller|b"), b(MdKind.HEADING, 6, "Last|b"), b(MdKind.PARAGRAPH, 0, "####### seven"),
    ), "markdown: headings")
    same(blocks("-no space\n- one\n* two *x*\n+ three\n  - nested\n- [ ] open\n- [x] done"), listOf(
        b(MdKind.PARAGRAPH, 0, "-no space"), b(MdKind.BULLET, 0, "one"), b(MdKind.BULLET, 0, "two ", "x|i"), b(MdKind.BULLET, 0, "three"),
        b(MdKind.BULLET, 1, "nested"), b(MdKind.BULLET, 0, "☐ open"), b(MdKind.BULLET, 0, "☑ done"),
    ), "markdown: bullets and tasks")
    same(blocks("Line one\n\n\n\nLine two\n"), listOf(b(MdKind.PARAGRAPH, 0, "Line one"), b(MdKind.SPACE, 0), b(MdKind.PARAGRAPH, 0, "Line two")), "markdown: blank lines become one space")
    same(blocks("```kotlin\nval a = **1**\n\n  indented\n```\nafter"), listOf(
        b(MdKind.CODE, 0, "val a = **1**|c"), b(MdKind.CODE, 0, "|c"), b(MdKind.CODE, 0, "  indented|c"), b(MdKind.PARAGRAPH, 0, "after"),
    ), "markdown: code block keeps every line as typed")
    same(blocks("```\nnever closed"), listOf(b(MdKind.CODE, 0, "never closed|c")), "markdown: unclosed code block")
    same(blocks("1. first\r\n2. second\r\n"), listOf(b(MdKind.PARAGRAPH, 0, "1. first"), b(MdKind.PARAGRAPH, 0, "2. second")), "markdown: numbers stay as typed, CRLF ok")
    same(blocks("").size, 0, "markdown: empty")
    // The plain text of the blocks is the answer without its marks, nothing is lost or added.
    same(AiMarkdown.plain("# T\n**a** and *b*\n- c"), "T\na and b\nc", "markdown: plain text")
}

private fun caps(json: Map<String, Any?>?): AiCaps? = json?.let {
    fun one(name: String): Boolean? = it[name] as? Boolean
    AiCaps(one("image"), one("pdf"), one("audio"), one("transcribe"))
}

private fun capsJson(caps: AiCaps) = listOf("image" to caps.image, "pdf" to caps.pdf, "audio" to caps.audio, "transcribe" to caps.transcribe)
    .associate { (name, value) -> name to (value ?: "unknown") }

private fun failure(what: String, block: () -> Unit): AiError = try { block(); error("$what: no error") } catch (failure: AiError) { failure }

private suspend fun failing(what: String, block: suspend () -> Unit): AiError = try { block(); error("$what: no error") } catch (failure: AiError) { failure }

private fun receiptJson(data: AiReceiptData?): Map<String, Any?>? = data?.let {
    listOf("title" to it.title, "shop" to it.shop, "amount" to it.amount, "currency" to it.currency, "bought" to it.bought, "warrantyUntil" to it.warrantyUntil)
        .filter { (_, value) -> value != null }.toMap()
}

private fun receiptData(json: Map<String, Any?>?) = AiReceiptData(json.str("title"), json.str("shop"), json.str("amount"), json.str("currency"), json.str("bought"), json.str("warrantyUntil"))

private class Counting : OutputStream() {
    var count = 0L
    override fun write(b: Int) { count++ }
    override fun write(b: ByteArray, off: Int, len: Int) { count += len }
}

private fun fake(answer: suspend () -> AiAnswer): () -> AiProvider = { object : AiProvider {
    override val id = "fake"
    override val model = "fake"
    override suspend fun complete(system: String, messages: List<AiMessage>, tools: List<AiTool>, timeoutMs: Long) = answer()
} }

/** Version 2: files to the AI service, writing out recordings, receipts (ai-vectors-v2.json), plus edits from ai-web.mjs. */
@Suppress("UNCHECKED_CAST")
private suspend fun version2(vectors: Map<String, Any?>, edits: Map<String, Any?>, tools: List<AiTool>, promptJson: String) {
    // 12 Nov 2026: the OpenRouter model list is public, so the key is checked at /key (cloud/shared/ai/providers.mjs keyRequest).
    for (case in vectors.items("keyRequests").map { it.obj()!! }) {
        val name = case.str("name")!!
        val request = AiProviders.keyRequest(config(case.child("config")))
        val expect = case.child("expect")
        if (expect == null) { same(request == null, true, "$name: no key request"); continue }
        same(request?.url, expect["url"], "$name: key url")
        same(request?.method, "GET", "$name: key method")
        same(request?.headers, expect["headers"], "$name: key headers")
    }

    for (case in vectors.items("partRequests").map { it.obj()!! }) {
        val name = case.str("name")!!
        val input = case.child("input")!!
        val build = { AiProviders.buildRequest(config(case.child("config")), input.str("system")!!, input.items("messages").map { message(it.obj()!!) }, emptyList()) }
        if (case["error"] != null) {
            val error = failure(name) { build() }
            same(error.code, case["error"], "$name: error")
            check(error.detail.length > 10) { "$name: the detail must say what cannot go" }
            continue
        }
        val request = build()
        val expect = case.child("expect")!!
        same(request.url, expect["url"], "$name: url")
        same(request.method, expect["method"], "$name: method")
        same(request.headers, expect["headers"], "$name: headers")
        same(AiJson.parse(request.body!!.text()), expect["body"], "$name: body")
    }

    for (case in vectors.items("partErrors").map { it.obj()!! }) {
        val name = case.str("name")!!
        val config = config(case.child("config"))
        val reply = linkedMapOf<String, Any?>("status" to case["status"], "body" to case["body"])
        val provider = AiProviders.create(config, fetcherFor(mutableListOf(reply), mutableListOf()))
        val error = failing(name) { provider.complete("S", listOf(AiMessage.User("Hi", case.items("parts").map { part(it.obj()!!) })), emptyList(), 1000) }
        same(error.code, case.child("expect").str("code"), "$name: code")
        check(config.key.isEmpty() || !error.detail.contains(config.key)) { "$name: the key is in the error" }
    }

    for (case in vectors.items("capabilities").map { it.obj()!! }) {
        val model = case["model"]
        same(capsJson(AiParts.capabilities(case.str("provider")!!, model.obj()?.get("inputs") as? List<String>)), case["expect"], "capabilities ${case["provider"]} ${AiJson.stringify(model)}")
    }
    for (case in vectors.items("explain").map { it.obj()!! }) same(AiParts.explain(case.str("provider")!!, case.str("kind")!!, case.str("use")!!), case["expect"], "explain ${case["provider"]} ${case["kind"]} ${case["use"]}")

    val limits = vectors.child("limits")!!
    same(AiParts.LIMITS, limits["constants"], "limits")
    // K6 (plan for phase 3): Android holds a file as bytes, so base64 with a line break cannot happen on the phone.
    // Exactly this one case is skipped; a new case Android cannot play makes the check fail instead of falling away.
    val skipped = mutableListOf<String>()
    for (case in limits.items("checks").map { it.obj()!! }) {
        val name = case.str("name")!!
        if (case.items("parts").any { (it.obj().str("data") ?: "").contains('\n') }) { skipped.add(name); continue }
        val parts = case.items("parts").map { part(it.obj()!!) }
        val given = caps(case.child("caps")) ?: AiCaps(true, true, true, null)
        if (case["error"] != null) same(failure(name) { AiParts.checkParts(parts, given) }.code, case["error"], "limits $name")
        else same(mapOf("bytes" to AiParts.checkParts(parts, given)), case["expect"], "limits $name")
    }
    same(skipped, listOf("base64 with a line break is the app's mistake"), "limits: the only case Android cannot play")
    same(AiParts.checkParts(emptyList(), null), 0L, "limits: no files")
    val passport = failure("passport") { AiParts.checkParts(listOf(AiPart("image", "image/jpeg", "Passport.jpg", ByteArray(AiParts.LIMITS.getValue("image").toInt() + 3))), null) }
    check(passport.code == "too_large" && passport.detail.contains("Passport.jpg") && passport.detail.contains("4 MiB")) { "limits: the reason names the file: ${passport.detail}" }
    passed++

    for (case in vectors.items("transcribe").map { it.obj()!! }) {
        val name = case.str("name")!!
        val build = { AiProviders.transcribeRequest(config(case.child("config")), part(case.child("audio")!!), case.str("language"), case.str("boundary")) }
        if (case["error"] != null) { same(failure(name) { build() }.code, case["error"], "$name: error"); continue }
        val request = build()
        val expect = case.child("expect")!!
        same(request.url, expect["url"], "$name: url")
        same(request.method, expect["method"], "$name: method")
        same(request.headers, expect["headers"], "$name: headers")
        expect["body"]?.let { same(AiJson.parse(request.body!!.text()), it, "$name: body") }
        expect["bodyText"]?.let { same(String(request.body!!.bytes(), Charsets.ISO_8859_1), it, "$name: body bytes") }
        expect["bodyBase64"]?.let { same(Base64.getEncoder().encodeToString(request.body!!.bytes()), it, "$name: body bytes") }
        same(request.body!!.length, request.body!!.bytes().size, "$name: body length")
    }
    // A fresh boundary every time, in the form of the shared code.
    val audio = AiPart("audio", "audio/mp4", "a.m4a", "fake m4a".toByteArray())
    val openAi = AiConfig("openai", "sk-proj-test-key-0002")
    val marks = List(2) { AiProviders.transcribeRequest(openAi, audio, null).headers.getValue("Content-Type").substringAfter("boundary=") }
    check(marks.all { Regex("^jotdrop-[0-9a-f]{32}$").matches(it) } && marks[0] != marks[1]) { "transcribe: boundary $marks" }
    passed++

    for (case in vectors.items("transcribeResponses").map { it.obj()!! }) {
        val name = case.str("name")!!
        if (case["error"] != null) { same(failure(name) { AiProviders.parseTranscription(case.str("provider")!!, case["json"]) }.code, case["error"], "$name: error"); continue }
        val heard = AiProviders.parseTranscription(case.str("provider")!!, case["json"])
        val usage = linkedMapOf<String, Any?>("input" to heard.input, "output" to heard.output).also { if (heard.seconds != null) it["seconds"] = heard.seconds }
        same(mapOf("text" to heard.text, "usage" to usage), case["expect"], name)
    }

    // A provider writes out a recording through the app's fetcher; Claude refuses before anything goes out.
    val seen = mutableListOf<String>()
    val reply = linkedMapOf<String, Any?>("body" to mapOf("text" to "Hallo", "usage" to mapOf("type" to "tokens", "input_tokens" to 3, "output_tokens" to 1)))
    val heard = AiProviders.create(openAi, fetcherFor(mutableListOf(reply), seen)).transcribe(audio, "nl", 1000)
    same(listOf(heard.text, heard.input, heard.output, seen), listOf("Hallo", 3, 1, listOf("https://api.openai.com/v1/audio/transcriptions")), "provider.transcribe")
    val claude = failing("claude transcribe") { AiProviders.create(AiConfig("anthropic", "sk-ant-api03-test-key-0001"), fetcherFor(mutableListOf(), seen)).transcribe(audio, null, 1000) }
    same(listOf(claude.code, claude.detail, seen.size), listOf("unsupported_input", "Claude cannot listen to recordings. Gemini and OpenAI can.", 1), "provider.transcribe refuses first")
    same(AiProviders.create(openAi, fetcherFor(mutableListOf(), seen)).capabilities?.let(::capsJson), mapOf("image" to true, "pdf" to true, "audio" to false, "transcribe" to true), "provider capabilities")
    same(AiProviders.TRANSCRIBE_MODEL, "gpt-transcribe", "transcription model")

    // K2: the body goes out in pieces. A recording of 14 MiB is written once, as base64, without a copy of the whole.
    val big = AiBody(listOf("{\"data\":\"", AiBase64(ByteArray(AiParts.LIMITS.getValue("audio").toInt())), "\"}"))
    val counting = Counting()
    big.writeTo(counting)
    same(counting.count, big.length, "body: a 14 MiB recording writes exactly its length")
    same(big.length, 11L + (AiParts.LIMITS.getValue("audio") + 2) / 3 * 4, "body: length of base64")
    val small = AiJson.body(linkedMapOf("url" to AiBase64(byteArrayOf(1, 2, 3, 4), "data:image/png;base64,"), "text" to "héllo"))
    same(small.length, small.bytes().size, "body: length of a data URL")
    same(small.text(), "{\"url\":\"data:image/png;base64,AQIDBA==\",\"text\":\"héllo\"}", "body: a data URL in the JSON")
    same(AiJson.stringify(mapOf("url" to AiBase64(byteArrayOf(1, 2, 3, 4), "data:image/png;base64,"))), "{\"url\":\"data:image/png;base64,AQIDBA==\"}", "stringify: base64 as text")
    same(AiJson.body(mapOf("a" to listOf(1, "x"))).pieces.size, 1, "body: without files one piece of text")
    for (size in listOf(0, 1, 2, 3, 49151, 49152, 49153, 100000)) {
        val bytes = ByteArray(size) { (it * 7).toByte() }
        same(AiBody(listOf(AiBase64(bytes))).text(), Base64.getEncoder().encodeToString(bytes), "body: base64 in blocks, $size bytes")
    }

    val receipts = vectors.child("receipts")!!
    same(AiReceipt.KEEP_YEARS, listOf(1, 2, 3, 5, 7), "receipt: years")
    for (case in receipts.items("requests").map { it.obj()!! }) {
        val (system, text) = AiReceipt.request(case.str("language"))
        same(mapOf("system" to system, "text" to text), case["expect"], "receipt request ${case["language"]}")
    }
    for (case in receipts.items("parse").map { it.obj()!! }) same(receiptJson(AiReceipt.parse(case.str("answer")!!)), case["expect"], "receipt: ${case["name"]}")
    for (case in receipts.items("keepUntil").map { it.obj()!! }) {
        val years = case["years"] as Number
        // A year count that is not whole cannot be passed in Kotlin; the shared code gives "" for it.
        if (years !is Long) { same(case["expect"], "", "keep until ${case["bought"]} + $years"); continue }
        same(AiReceipt.keepUntil(case.str("bought")!!, years.toInt()), case["expect"], "keep until ${case["bought"]} + $years")
    }
    val safe = AiReceipt.parse("{\"title\":\"x\\n- [ ] new task\",\"shop\":\"y\\r\\n# Heading\",\"amount\":\"1\\n2\"}")!!
    check(listOfNotNull(safe.title, safe.shop, safe.amount).none { it.contains('\n') || it.contains('\r') }) { "receipt: a field has a line of its own" }
    passed++
    same(AiReceipt.parse(""), null, "receipt: empty answer")

    for (case in vectors.items("conversations").map { it.obj()!! }) {
        val name = case.str("name")!!
        val executed = mutableListOf<String>()
        val asked = mutableListOf<String>()
        val answers = case.items("confirm").map { it == true }.toMutableList()
        val urls = mutableListOf<String>()
        val replies = case.items("http").map { it.obj()!! }.toMutableList()
        val script = case.items("script").map { it.obj()!! }.toMutableList()
        val requests = mutableListOf<List<AiMessage>>()
        val parts = case.items("parts").map { part(it.obj()!!) }
        val provider: () -> AiProvider = if (case["script"] != null) {
            { object : AiProvider {
                override val id = "fake"
                override val model = "fake"
                override suspend fun complete(system: String, messages: List<AiMessage>, tools: List<AiTool>, timeoutMs: Long): AiAnswer {
                    requests.add(messages.toList())
                    val step = script.removeFirstOrNull() ?: emptyMap()
                    val calls = step.items("toolCalls").map(::toolCall)
                    return AiAnswer(step.str("text") ?: "", calls, if (calls.isNotEmpty()) "tool" else "end", 10, 2, null)
                }
            } }
        } else {
            { AiProviders.create(config(case.child("config")), fetcherFor(replies, urls)) }
        }
        val run: (String) -> suspend (Map<String, Any?>) -> Any? = { tool -> { _ -> executed.add(tool); if (tool == "create_note") mapOf("id" to "new-1") else "Done." } }
        val stopAtConfirm = case["stopAtConfirm"] == true
        val expect = case.child("expect")!!
        val report = coroutineScope {
            val running = async {
                AiAssistant.run(
                    request = case.str("request")!!,
                    notes = case.items("notes").map(::note),
                    labels = emptyList(),
                    tools = tools,
                    system = AiPrompt.system(promptJson, "English", "2026-11-11", "Europe/Madrid", emptyList()),
                    provider = provider,
                    executor = listOf("create_note", "append_to_note", "replace_note_text", "set_labels", "set_reminder", "set_expiry", "open_note").associateWith(run),
                    confirm = { change ->
                        asked.add(change.tool)
                        // K5: Stop on Android cancels the coroutine; a confirmation that is waiting ends with it.
                        if (stopAtConfirm) { currentCoroutineContext().cancel(); awaitCancellation() }
                        answers.removeFirstOrNull() ?: false
                    },
                    parts = parts,
                )
            }
            try { running.await() } catch (_: CancellationException) { null }
        }
        if (stopAtConfirm) {
            // K5: stop, actions and rounds of this case belong to the JavaScript signal; here the run ends with the
            // cancellation, nothing ran, and the confirmation was asked.
            check(report == null) { "$name: the run must end with the cancellation" }
            passed++
            same(executed, expect["executed"], "$name: executed")
            same(asked, expect["asked"], "$name: asked")
            continue
        }
        checkNotNull(report) { "$name: no report" }
        same(report.stop, expect["stop"], "$name: stop")
        same(report.answer, expect["answer"], "$name: answer")
        same(report.actions.map { listOf(it.tool, it.status) }, expect.items("actions").map { (it as List<Any?>).take(2) }, "$name: actions")
        expect.items("actions").forEachIndexed { index, item -> (item as List<Any?>).getOrNull(2)?.let { same(report.actions[index].reason, it, "$name: reason $index") } }
        same(executed, expect["executed"], "$name: executed")
        same(asked, expect["asked"], "$name: asked")
        same(report.sent.map { it.id }, expect["sent"], "$name: sent")
        same(report.rounds, expect["rounds"], "$name: rounds")
        same(report.files.map { mapOf("name" to it.name, "kind" to it.kind, "bytes" to it.bytes) }, expect["files"], "$name: files")
        expect["error"]?.let { same(report.error?.code, it, "$name: error") }
        expect["fetches"]?.let { same(urls, it, "$name: fetches") }
        expect["timeoutMs"]?.let { same(report.timeoutMs, it, "$name: time allowed") }
        expect["partsInRequests"]?.let { want ->
            same(requests.map { messages -> messages.indices.filter { (messages[it] as? AiMessage.User)?.parts?.isNotEmpty() == true } }, want, "$name: files per request")
            // The first message carries exactly what the app handed in, nothing more.
            if (parts.isNotEmpty()) check((requests.first().first() as AiMessage.User).parts == parts) { "$name: other files in the first message" }
            passed++
        }
    }
    // A set time wins over the 180 seconds for files.
    val quick = AiAssistant.run(request = "x", notes = emptyList(), labels = emptyList(), tools = tools, system = "S", provider = fake { AiAnswer("ok", emptyList(), "end", 1, 1, null) },
        executor = emptyMap(), confirm = { false }, parts = listOf(AiPart("image", "image/jpeg", "a.jpg", byteArrayOf(1))), timeoutMs = 5000)
    same(quick.timeoutMs, 5000, "a set time wins")
    same(AiAssistant.FILE_TIMEOUT_MS, 180000, "time with files")

    // once: one request without tools for the fixed file actions (aiOnce in app.js).
    val photo = AiPart("image", "image/jpeg", "Note.jpg", byteArrayOf(1, 2, 3))
    val good = AiAssistant.once("Read", listOf(photo), fake { AiAnswer("Milk", emptyList(), "end", 5, 1, null) }, emptyList()) { ai, time -> ai.complete(AiParts.PHOTO_SYSTEM, listOf(AiMessage.User("Read", listOf(photo))), emptyList(), time) }
    same(listOf(good.stop, good.answer, good.rounds, good.input, good.output, good.timeoutMs, good.files.map { listOf(it.name, it.kind, it.bytes) }),
        listOf("done", "Milk", 1, 5, 1, 180000, listOf(listOf("Note.jpg", "image", 3))), "once: a good answer")
    val held = AiAssistant.once("Read", listOf(photo), fake { throw AiError("unsupported_input", "This address cannot read photos.") }, emptyList()) { ai, time -> ai.complete("S", emptyList(), emptyList(), time) }
    same(listOf(held.stop, held.rounds, held.error?.code), listOf("error", 0, "unsupported_input"), "once: JotDrop held the file back, nothing went out")
    val key = "sk-proj-test-key-0002"
    val said = AiAssistant.once("Read", listOf(photo), fake { throw AiError("auth", "Incorrect API key provided: $key", 401) }, listOf(key)) { ai, time -> ai.complete("S", emptyList(), emptyList(), time) }
    same(listOf(said.stop, said.rounds, said.error?.code), listOf("error", 1, "auth"), "once: the service said no")
    check(said.error?.detail?.contains(key) == false) { "once: the key is in the report" }
    passed++
    same(AiAssistant.once("Read", emptyList(), { throw AiError("no_key") }, emptyList()) { ai, time -> ai.complete("S", emptyList(), emptyList(), time) }.stop, "off", "once: no key")
    val nay = AiAssistant.once("Read", emptyList(), fake { AiAnswer("No.", emptyList(), "refusal", 1, 1, null) }, emptyList()) { ai, time -> ai.complete("S", emptyList(), emptyList(), time) }
    same(listOf(nay.stop, nay.answer), listOf("refusal", "No."), "once: a refusal")
    same(AiAssistant.once("Read", emptyList(), fake { throw AiError("refusal") }, emptyList()) { ai, time -> ai.complete("S", emptyList(), emptyList(), time) }.let { listOf(it.stop, it.error) }, listOf("refusal", null), "once: a refused recording")
    same(AiAssistant.once("Read", emptyList(), fake { throw AiError("timeout") }, emptyList()) { ai, time -> ai.complete("S", emptyList(), emptyList(), time) }.stop, "timeout", "once: too slow")
    val minute = AiAssistant.once("Hear", emptyList(), fake { AiAnswer("x", emptyList(), "end", 0, 0, null) }, emptyList()) { _, _ -> AiTranscript("Hi", 0, 0, 12.5).answer() }
    same(listOf(minute.answer, minute.seconds), listOf("Hi", 12.5), "once: seconds of a recording")

    // The file table, the fixed requests and the receipt lines, as the web app makes them.
    for (case in edits.items("files").map { it.obj()!! }) same(AiParts.fileKind(case.str("name")!!)?.let { (kind, mime) -> mapOf("kind" to kind, "mime" to mime) }, case["expect"], "file ${case["name"]}")
    edits.child("fileRequests")!!.let {
        same(AiParts.fileRequest("photo"), it["photo"], "file request photo")
        same(AiParts.fileRequest("transcribe"), it["transcribe"], "file request transcribe")
        same(AiParts.PHOTO_SYSTEM, it["photoSystem"], "photo system text")
    }
    for (case in edits.items("receiptLines").map { it.obj()!! }) same(AiReceipt.lines(receiptData(case.child("data"))), case["expect"], "receipt lines ${AiJson.stringify(case["data"])}")
    for (case in edits.items("receiptNote").map { it.obj()!! }) same(AiReceipt.noteText(case.str("file")!!, case.str("title")!!, case.str("lines")!!), case["expect"], "receipt note ${AiJson.stringify(case["file"])} ${AiJson.stringify(case["title"])}")

    // A photo goes as a JPEG of at most 2048 pixels on its long side, never larger than it was (photoData in app.js).
    same(AiParts.photoSize(4096, 2048).toList(), listOf(2048, 1024), "photo 4096x2048")
    same(AiParts.photoSize(800, 600).toList(), listOf(800, 600), "photo 800x600")
    same(AiParts.photoSize(1, 5000).toList(), listOf(1, 2048), "photo 1x5000")
}

@Suppress("UNCHECKED_CAST")
/**
 * Version 2, part E and F: duplicate notes and "This week" as cloud/shared/similar.mjs and digest.mjs make them,
 * for every case of similar-vectors.json and digest-vectors.json and the extra cases scripts/check-ai-android.mjs
 * adds (limits, a clock that ticks, a few hundred generated notes).
 */
private fun overview(edits: Map<String, Any?>) {
    for (case in edits.items("similar").map { it.obj()!! }) {
        var tick = 0L
        val step = case.num("tick")?.toLong()
        @Suppress("UNCHECKED_CAST")
        val result = Similar.findDuplicates(case.items("notes").map(::note), (case["dismissed"] as? List<String>) ?: emptyList(),
            timeLimitMs = case.num("timeLimitMs")?.toLong() ?: Similar.TIME_LIMIT_MS, now = if (step != null) ({ tick += step; tick }) else ({ 0L }))
        same(mapOf("pairs" to result.pairs.map { it.json() }, "complete" to result.complete), case["expect"], "similar ${case["name"]}")
    }
    for (case in edits.items("pairKeys").map { it.obj()!! }) same(Similar.pairKey(case.str("a")!!, case.str("b")!!), case["expect"], "pair key ${case["a"]} ${case["b"]}")
    for (case in edits.items("normalize").map { it.obj()!! }) same(Similar.normalizeText(case.str("text")!!), case["expect"], "normalize ${AiJson.stringify(case["text"])}")
    for (case in edits.items("digest").map { it.obj()!! }) {
        val digest = Digest.weekDigest(case.items("notes").map(::note), java.time.Instant.parse(case.str("now")!!).toEpochMilli(), case.str("timeZone"), case["includeShared"] == true)
        same(mapOf("notes" to digest.notes.map { it.json() }, "left" to digest.left, "truncated" to digest.truncated,
            "counts" to mapOf("changed" to digest.counts.changed, "reminders" to digest.counts.reminders, "expiring" to digest.counts.expiring), "text" to digest.text),
            case["expect"], "digest ${case["name"]}")
    }
    for (case in edits.items("wallClock").map { it.obj()!! }) same(Digest.wallClock(java.time.Instant.parse(case.str("now")!!).toEpochMilli(), case.str("timeZone")), case["expect"], "wall clock ${case["now"]} ${case["timeZone"]}")
    for (case in edits.items("merge").map { it.obj()!! }) same(AiNoteEdits.mergeRequest(case.str("older")!!, case.str("newer")!!), case["expect"], "merge request ${case["older"]}")
    for (case in edits.items("digestRequest").map { it.obj()!! }) {
        val (system, text) = Digest.request(case.str("language"), case.str("date") ?: "", case.str("timeZone"), case.str("text") ?: "")
        same(mapOf("system" to system, "text" to text), case["expect"], "digest request ${case["language"]}")
    }
}

fun main(arguments: Array<String>) = runBlocking {
    val vectors = AiJson.parse(File(arguments[0]).readText()).obj()!!
    val tools = AiTools.load(File(arguments[1]).readText())
    val promptJson = File(arguments[2]).readText()
    val edits = AiJson.parse(File(arguments[3]).readText()).obj()!!
    val vectorsV2 = AiJson.parse(File(arguments[4]).readText()).obj()!!
    val oneTool = vectors.child("tool")!!.let { AiTool(it.str("name")!!, it.str("mode")!!, it.str("description")!!, it.child("input_schema")!!) }

    // The catalogue: nine tools, nothing that deletes, archives, shares or sends.
    same(tools.map { it.name }, listOf("search_notes", "read_note", "create_note", "append_to_note", "replace_note_text", "set_labels", "set_reminder", "set_expiry", "open_note"), "tool names")
    same(tools.map { it.mode }, listOf("read", "read", "create", "confirm", "confirm", "confirm", "confirm", "confirm", "read"), "tool modes")

    for (case in vectors.items("requests").map { it.obj()!! }) {
        val input = case.child("input")!!
        val request = AiProviders.buildRequest(config(case.child("config")), input.str("system")!!, input.items("messages").map { message(it.obj()!!) }, listOf(oneTool))
        val expect = case.child("expect")!!
        same(request.url, expect["url"], "${case["name"]}: url")
        same(request.method, expect["method"], "${case["name"]}: method")
        same(request.headers, expect["headers"], "${case["name"]}: headers")
        same(AiJson.parse(request.body!!.text()), expect["body"], "${case["name"]}: body")
    }

    for (case in vectors.items("responses").map { it.obj()!! }) {
        val answer = AiProviders.parseResponse(case.str("provider")!!, case["json"])
        val expect = case.child("expect")!!
        same(answer.text, expect["text"], "${case["name"]}: text")
        same(answer.toolCalls.map(::callJson), expect["toolCalls"], "${case["name"]}: tool calls")
        same(answer.stop, expect["stop"], "${case["name"]}: stop")
        same(mapOf("input" to answer.input, "output" to answer.output), expect["usage"], "${case["name"]}: usage")
        same(answer.raw, expect["raw"], "${case["name"]}: raw")
    }

    for (case in vectors.items("errors").map { it.obj()!! }) {
        val config = config(case.child("config"))
        val reply = linkedMapOf<String, Any?>("status" to case["status"]).also { if (case["text"] != null) it["text"] = case["text"] else it["body"] = case["body"] }
        val error = try {
            AiProviders.create(config, fetcherFor(mutableListOf(reply), mutableListOf())).complete("S", listOf(AiMessage.User("Hi")), tools, 1000)
            error("${case["name"]}: no error")
        } catch (failure: AiError) { failure }
        same(error.code, case.child("expect").str("code"), "${case["name"]}: code")
        check(config.key.isEmpty() || !error.detail.contains(config.key)) { "${case["name"]}: the key is in the error" }
    }

    for (case in vectors.items("models").map { it.obj()!! }) {
        val models = AiProviders.parseModels(case.str("provider")!!, case["json"])
        same(models.map { mapOf("id" to it.id, "name" to it.name, "tools" to it.tools) }, case["expect"], "models ${case["name"]}")
        same(AiProviders.pickDefaultModel(case.str("provider")!!, models), case["default"], "default model ${case["name"]}")
    }

    for (case in vectors.items("modelRequests").map { it.obj()!! }) {
        val request = AiProviders.modelsRequest(config(case.child("config")))
        same(request.url, case.child("expect").str("url"), "model list url ${case.child("config").str("provider")}")
        same(request.headers, case.child("expect").child("headers"), "model list headers ${case.child("config").str("provider")}")
        same(request.method, "GET", "model list method")
    }

    for (case in vectors.items("addresses").map { it.obj()!! }) same(AiProviders.checkAddress(case.str("baseUrl")!!), case["ok"], "address ${case["baseUrl"]}")

    for (case in vectors.items("context").map { it.obj()!! }) {
        val options = case.child("options")
        val picked = AiContext.selectNotes(case.items("notes").map(::note), case.str("question")!!,
            maxNotes = options.num("maxNotes")?.toInt() ?: AiContext.MAX_NOTES, includeShared = options?.get("includeShared") == true,
            pinned = (options?.get("pinned") as? List<String>) ?: emptyList())
        same(picked.notes.map { it.id }, case.child("expect")!!["ids"], "context ${case["name"]}: ids")
        same(picked.left, case.child("expect")!!["left"], "context ${case["name"]}: left")
    }

    for (case in vectors.items("redact").map { it.obj()!! }) same(AiRedact.redact(case.str("input"), (case["secrets"] as? List<String>) ?: emptyList()), case["expect"], "redact ${case["input"]}")

    for (case in vectors.items("conversations").map { it.obj()!! }) {
        val name = case.str("name")!!
        val executed = mutableListOf<String>()
        val asked = mutableListOf<String>()
        val answers = case.items("confirm").map { it == true }.toMutableList()
        val urls = mutableListOf<String>()
        val replies = case.items("http").map { it.obj()!! }.toMutableList()
        val script = case.items("script").map { it.obj()!! }.toMutableList()
        val provider: () -> AiProvider = if (case["script"] != null) {
            { object : AiProvider {
                override val id = "fake"
                override val model = "fake"
                override suspend fun complete(system: String, messages: List<AiMessage>, tools: List<AiTool>, timeoutMs: Long): AiAnswer {
                    val step = script.removeFirstOrNull() ?: emptyMap()
                    val calls = step.items("toolCalls").map(::toolCall)
                    return AiAnswer(step.str("text") ?: "", calls, step.str("stop") ?: if (calls.isNotEmpty()) "tool" else "end", 100, 20, null)
                }
            } }
        } else {
            { AiProviders.create(config(case.child("config")), fetcherFor(replies, urls)) }
        }
        val run: (String) -> suspend (Map<String, Any?>) -> Any? = { tool -> { input -> executed.add(tool); if (tool == "create_note") mapOf("id" to "new-1", "title" to input["title"]) else "Done." } }
        val key = case.child("config").str("key")?.trim().orEmpty()
        val report = AiAssistant.run(
            request = case.str("request")!!,
            notes = case.items("notes").map(::note),
            labels = (case["labels"] as? List<String>) ?: emptyList(),
            tools = tools,
            system = AiPrompt.system(promptJson, "English", "2026-11-09", "Europe/Madrid", (case["labels"] as? List<String>) ?: emptyList()),
            provider = provider,
            executor = listOf("create_note", "append_to_note", "replace_note_text", "set_labels", "set_reminder", "set_expiry", "open_note").associateWith(run),
            confirm = { change -> asked.add(change.tool); answers.removeFirstOrNull() ?: false },
            secrets = listOf(key),
        )
        val expect = case.child("expect")!!
        same(report.stop, expect["stop"], "$name: stop")
        same(report.answer, expect["answer"], "$name: answer")
        same(report.actions.map { listOf(it.tool, it.status) }, expect.items("actions").map { (it as List<Any?>).take(2) }, "$name: actions")
        expect.items("actions").forEachIndexed { index, item -> (item as List<Any?>).getOrNull(2)?.let { same(report.actions[index].reason, it, "$name: reason $index") } }
        same(executed, expect["executed"], "$name: executed")
        same(asked, expect["asked"], "$name: asked")
        same(report.sent.map { it.id }, expect["sent"], "$name: sent")
        same(report.rounds, expect["rounds"], "$name: rounds")
        expect["sources"]?.let { same(report.sources.map { s -> s.id }, it, "$name: sources") }
        expect["error"]?.let { same(report.error?.code, it, "$name: error") }
        expect["fetches"]?.let { same(urls, it, "$name: fetches") }
        if (key.isNotEmpty()) check(!AiRedact.redact("${report.error?.detail} ${report.answer}").contains(key) && report.error?.detail?.contains(key) != true) { "$name: the key is in the report" }
    }

    // Note edits and the prompt, as the web app makes them.
    for (case in edits.items("newNote").map { it.obj()!! }) same(AiNoteEdits.newNoteBody(case.str("title")!!, case.str("text"), case["items"] as? List<String>), case["expect"], "new note ${case["title"]}")
    for (case in edits.items("append").map { it.obj()!! }) same(AiNoteEdits.appendedText(case.str("file")!!, case.str("text"), case["items"] as? List<String>), case["expect"], "append to ${AiJson.stringify(case["file"])}")
    for (case in edits.items("replace").map { it.obj()!! }) same(AiNoteEdits.replacedText(case.str("file")!!, case.str("text")!!), case["expect"], "replace ${AiJson.stringify(case["file"])}")
    for (case in edits.items("split").map { it.obj()!! }) {
        val parts = AiNoteEdits.splitNote(case.str("file")!!)
        same(mapOf("front" to parts.front, "title" to parts.title, "body" to parts.body), case["expect"], "split ${AiJson.stringify(case["file"])}")
    }
    for (case in edits.items("labels").map { it.obj()!! }) same(AiNoteEdits.cleanLabels(case["labels"] as List<String>), case["expect"], "labels ${case["labels"]}")
    for (case in edits.items("editor").map { it.obj()!! }) same(AiNoteEdits.editorRequest(case.str("kind")!!, case.str("title")!!), case["expect"], "editor ${case["kind"]}")
    for (case in edits.items("search").map { it.obj()!! }) {
        val found = AiContext.searchNotes(case.items("notes").map(::note), case.str("query")!!)
        same(found.map { it.json() }, case["expect"], "search ${case["query"]}")
    }
    for (case in edits.items("select").map { it.obj()!! }) {
        val picked = AiContext.selectNotes(case.items("notes").map(::note), case.str("question")!!, maxChars = case.num("maxChars")?.toInt() ?: AiContext.MAX_CHARS)
        same(mapOf("notes" to picked.notes.map { mapOf("id" to it.id, "title" to it.title, "text" to it.text, "truncated" to it.truncated) }, "chars" to picked.chars, "left" to picked.left), case["expect"], "select ${case["question"]}")
        same(AiContext.formatNotes(picked.notes.map { Triple(it.id, it.title, it.text) }), case["formatted"], "format ${case["question"]}")
    }
    edits.child("prompt")!!.let { same(AiPrompt.system(promptJson, it.str("language"), it.str("date")!!, it.str("timeZone"), it["labels"] as List<String>), it["expect"], "system prompt") }
    edits.child("promptDefaults")!!.let { same(AiPrompt.system(promptJson, null, it.str("date")!!, null, emptyList()), it["expect"], "system prompt defaults") }

    askScreen(tools, promptJson)
    markdown()
    version2(vectorsV2, edits, tools, promptJson)
    overview(edits)

    // The limits from the design.
    same(AiAssistant.MAX_ROUNDS, 6, "max rounds")
    same(AiAssistant.TIMEOUT_MS, 60000, "timeout")
    check(passed > 454) { "fewer checks than version 1 had: $passed" }
    println("PASS: Ask JotDrop on Android matches the shared vectors, version 1 and 2 ($passed checks)")
}

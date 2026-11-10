package com.diexar.keepcapture

import kotlinx.coroutines.runBlocking
import java.io.File

/**
 * Holds Android's Ask JotDrop to the shared one: every case of cloud/shared/ai/ai-vectors.json (requests per
 * provider, answers, errors, model lists, addresses, note choice, hiding keys, whole conversations), the tool list
 * and prompt from tools.json and prompt.json, and note edits computed by cloud/web/ai-web.mjs
 * (scripts/check-ai-android.mjs writes those and runs this).
 * Arguments: ai-vectors.json, tools.json, prompt.json, edits.json.
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

private fun config(json: Map<String, Any?>?) = AiConfig(json.str("provider") ?: "", json.str("key") ?: "", json.str("model") ?: "", json.str("baseUrl") ?: "")

@Suppress("UNCHECKED_CAST")
private fun message(json: Map<String, Any?>): AiMessage = when (json["role"]) {
    "user" -> AiMessage.User(json.str("text") ?: "")
    "tool" -> AiMessage.Tool(json.items("results").map { val r = it.obj(); AiToolResult(r.str("id")!!, r.str("name")!!, r.str("content")!!, r?.get("isError") == true) })
    else -> AiMessage.Assistant(json.str("text") ?: "", json.items("toolCalls").map(::toolCall), json["raw"])
}

private fun toolCall(value: Any?): AiToolCall { val c = value.obj(); return AiToolCall(c.str("id")!!, c.str("name")!!, c.child("input"), c.str("error")) }

private fun callJson(call: AiToolCall): Map<String, Any?> = linkedMapOf<String, Any?>("id" to call.id, "name" to call.name, "input" to call.input).also { if (call.error != null) it["error"] = call.error }

private fun note(value: Any?): AiNote {
    val n = value.obj()
    @Suppress("UNCHECKED_CAST")
    return AiNote(n.str("id")!!, n.str("title") ?: "", n.str("text") ?: "", (n?.get("labels") as? List<String>) ?: emptyList(), n.str("updatedAt"), n?.get("shared") == true)
}

private fun fetcherFor(replies: MutableList<Map<String, Any?>>, urls: MutableList<String>) = AiFetcher { request, _ ->
    urls.add(request.url)
    val next = replies.removeFirstOrNull() ?: error("Unexpected call to ${request.url}")
    AiHttpResponse((next["status"] as? Number)?.toInt() ?: 200, next.str("text") ?: AiJson.stringify(next["body"]))
}

@Suppress("UNCHECKED_CAST")
fun main(arguments: Array<String>) = runBlocking {
    val vectors = AiJson.parse(File(arguments[0]).readText()).obj()!!
    val tools = AiTools.load(File(arguments[1]).readText())
    val promptJson = File(arguments[2]).readText()
    val edits = AiJson.parse(File(arguments[3]).readText()).obj()!!
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
        same(AiJson.parse(request.body!!), expect["body"], "${case["name"]}: body")
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

    // The limits from the design.
    same(AiAssistant.MAX_ROUNDS, 6, "max rounds")
    same(AiAssistant.TIMEOUT_MS, 60000, "timeout")
    println("PASS: Ask JotDrop on Android matches the shared vectors ($passed checks)")
}

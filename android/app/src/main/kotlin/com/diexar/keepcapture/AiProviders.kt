package com.diexar.keepcapture

import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.net.URI
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.Base64

/**
 * The AI services Ask JotDrop talks to, straight from this phone with the user's own key; never through our
 * server. The same request and answer forms as cloud/shared/ai/providers.mjs (checked against ai-vectors.json and
 * ai-vectors-v2.json): Anthropic's Messages API, OpenAI's Chat Completions (also OpenRouter and any
 * OpenAI-compatible address) and Gemini's generateContent. No streaming. Version 2: files the user points at go
 * along with the first message, and a recording can be written out (transcribeRequest).
 */
data class AiSpec(
    val id: String, val name: String, val form: String, val needsKey: Boolean, val base: String?, val defaultModel: String?,
    val headers: Map<String, String> = emptyMap(),
)

/**
 * inputs: the model's input list (OpenRouter's architecture.input_modalities), for the vectors only. The app does
 * not store it and gives none, like the web app: on OpenRouter photos and recordings are then "unknown: try it".
 */
data class AiConfig(val provider: String, val key: String = "", val model: String = "", val baseUrl: String = "", val inputs: List<String>? = null)

/** Bytes that go out as base64, with an optional text in front ("data:image/jpeg;base64,"). The text is ASCII. */
class AiBase64(val bytes: ByteArray, val prefix: String = "") {
    val length: Long get() = prefix.length + (bytes.size + 2L) / 3 * 4
}

/**
 * A request body in pieces (String, ByteArray or AiBase64), written straight to the connection: base64 is made in
 * blocks while it is written, so a file is in memory once. Without files a body is one piece of text.
 */
class AiBody(val pieces: List<Any>) {
    init { require(pieces.all { it is String || it is ByteArray || it is AiBase64 }) { "A body piece is text, bytes or base64." } }

    val length: Long = pieces.sumOf { piece ->
        when (piece) { is String -> utf8Length(piece); is ByteArray -> piece.size.toLong(); else -> (piece as AiBase64).length }
    }

    fun writeTo(out: OutputStream) {
        for (piece in pieces) when (piece) {
            is String -> out.write(piece.toByteArray(Charsets.UTF_8))
            is ByteArray -> out.write(piece)
            is AiBase64 -> {
                out.write(piece.prefix.toByteArray(Charsets.US_ASCII))
                val encoder = Base64.getEncoder()
                var at = 0
                while (at < piece.bytes.size) {
                    val count = minOf(BLOCK, piece.bytes.size - at)
                    val encoded = encoder.encode(ByteBuffer.wrap(piece.bytes, at, count))
                    out.write(encoded.array(), encoded.arrayOffset(), encoded.remaining())
                    at += count
                }
            }
        }
    }

    /** The whole body at once: for the check and for small bodies only. */
    fun bytes(): ByteArray = ByteArrayOutputStream(length.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()).also(::writeTo).toByteArray()

    fun text(): String = String(bytes(), Charsets.UTF_8)

    companion object {
        // 48 KiB of input, a multiple of 3, so the blocks join without padding in between.
        private const val BLOCK = 48 * 1024

        fun text(value: String) = AiBody(listOf(value))

        private fun utf8Length(text: String): Long {
            var count = 0L
            var i = 0
            while (i < text.length) {
                val c = text[i]
                count += when {
                    c.code < 0x80 -> 1
                    c.code < 0x800 -> 2
                    Character.isHighSurrogate(c) && i + 1 < text.length && Character.isLowSurrogate(text[i + 1]) -> { i++; 4 }
                    // A lone surrogate: Java's UTF-8 encoder writes "?".
                    Character.isSurrogate(c) -> 1
                    else -> 3
                }
                i++
            }
            return count
        }
    }
}

data class AiRequest(val url: String, val method: String, val headers: Map<String, String>, val body: AiBody?)

data class AiHttpResponse(val status: Int, val text: String) { val ok get() = status in 200..299 }

data class AiToolCall(val id: String, val name: String, val input: Map<String, Any?>?, val error: String? = null)

data class AiToolResult(val id: String, val name: String, val content: String, val isError: Boolean = false)

/** A message in JotDrop's own form, the same for every provider. raw: the provider's own content, sent back as it came. */
sealed class AiMessage {
    /** parts: files the user pointed at; without them the request is byte for byte the one of version 1. */
    data class User(val text: String, val parts: List<AiPart> = emptyList()) : AiMessage()
    data class Assistant(val text: String, val toolCalls: List<AiToolCall>, val raw: Any? = null) : AiMessage()
    data class Tool(val results: List<AiToolResult>) : AiMessage()
}

/** One round's answer. stop: end, tool, length or refusal. seconds: a written-out recording billed by its length. */
data class AiAnswer(val text: String, val toolCalls: List<AiToolCall>, val stop: String, val input: Long, val output: Long, val raw: Any?, val seconds: Double? = null)

/** A recording written out: the text, and tokens or (OpenAI) seconds. */
data class AiTranscript(val text: String, val input: Long, val output: Long, val seconds: Double? = null) {
    /** In the form of an answer, for AiAssistant.once. */
    fun answer() = AiAnswer(text, emptyList(), "end", input, output, null, seconds)
}

data class AiModel(val id: String, val name: String, val tools: Boolean?, val price: Double = 0.0)

/** An error for the user: a fixed code (the app shows its own words for it) and a short detail with keys hidden. */
class AiError(val code: String, detail: String = "", val status: Int = 0) : Exception(code) {
    val detail: String = detail.take(300)
}

/** Sends one request; the app's is HttpURLConnection (AiHttp), the check's plays back vectors. */
fun interface AiFetcher {
    /** Throws java.net.SocketTimeoutException when [timeoutMs] runs out, any other exception when the service cannot be reached. */
    suspend fun fetch(request: AiRequest, timeoutMs: Long): AiHttpResponse
}

interface AiProvider {
    val id: String
    val model: String
    /** What it can read; null for a provider that does not say (a test): then only the limits are checked. */
    val capabilities: AiCaps? get() = null
    suspend fun complete(system: String, messages: List<AiMessage>, tools: List<AiTool>, timeoutMs: Long): AiAnswer
    suspend fun transcribe(audio: AiPart, language: String?, timeoutMs: Long): AiTranscript = throw AiError("unsupported_input", "This AI service cannot write out recordings.")
}

object AiProviders {
    const val ANTHROPIC_VERSION = "2026-10-21"
    private const val MAX_TOKENS = 16000L

    val SPECS: Map<String, AiSpec> = listOf(
        AiSpec("anthropic", "Claude (Anthropic)", "anthropic", true, "https://api.anthropic.com", "claude-haiku-5-5"),
        AiSpec("openai", "OpenAI", "openai", true, "https://api.openai.com/v1", "gpt-6-luna"),
        AiSpec("gemini", "Gemini (Google)", "gemini", true, "https://generativelanguage.googleapis.com/v1beta", "gemini-3.5-flash-lite"),
        AiSpec("openrouter", "OpenRouter", "openai", true, "https://openrouter.ai/api/v1", null, mapOf("HTTP-Referer" to "https://jotdrop.net", "X-Title" to "JotDrop")),
        AiSpec("ollama", "Local model (Ollama)", "openai", false, "http://127.0.0.1:11434/v1", null),
        AiSpec("custom", "Own address (OpenAI-compatible)", "openai", false, null, null),
    ).associateBy { it.id }

    private val LOCAL_HOSTS = Regex("(?i)^(localhost|127\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|\\[::1\\])$")

    /** An own address may be https anywhere, or http on this device only. */
    fun checkAddress(address: String): Boolean = try {
        val uri = URI(address)
        val host = uri.host ?: ""
        uri.isAbsolute && host.isNotEmpty() && (uri.scheme.equals("https", true) || (uri.scheme.equals("http", true) && LOCAL_HOSTS.matches(host)))
    } catch (_: Exception) { false }

    private class Target(val spec: AiSpec, val key: String, val base: String, val model: String?)

    // The provider, key, model and address for a configuration, or the reason AI cannot run. Nothing goes out here.
    private fun resolve(config: AiConfig, needModel: Boolean = true): Target {
        val spec = SPECS[config.provider] ?: throw AiError("no_provider")
        val key = config.key.trim()
        if (spec.needsKey && key.isEmpty()) throw AiError("no_key")
        var base = spec.base
        if (base == null) {
            if (!checkAddress(config.baseUrl.trim())) throw AiError("bad_address")
            base = config.baseUrl.trim().trimEnd('/')
            if (!base.endsWith("/v1")) base += "/v1"
        }
        val model = config.model.trim().ifEmpty { spec.defaultModel }
        if (needModel && model.isNullOrEmpty()) throw AiError("no_model")
        return Target(spec, key, base, model)
    }

    private fun headersFor(target: Target, json: Boolean): Map<String, String> {
        val headers = LinkedHashMap<String, String>()
        if (json) headers["Content-Type"] = "application/json"
        when (target.spec.form) {
            "anthropic" -> { headers["x-api-key"] = target.key; headers["anthropic-version"] = ANTHROPIC_VERSION; headers["anthropic-dangerous-direct-browser-access"] = "true" }
            "gemini" -> headers["x-goog-api-key"] = target.key
            else -> { if (target.key.isNotEmpty()) headers["Authorization"] = "Bearer ${target.key}"; headers.putAll(target.spec.headers) }
        }
        return headers
    }

    // Gemini's function declarations take an OpenAPI subset without additionalProperties.
    private fun openApi(schema: Any?): Any? = when (schema) {
        is List<*> -> schema.map(::openApi)
        is Map<*, *> -> LinkedHashMap<String, Any?>().also { out -> for ((key, value) in schema) if (key != "additionalProperties") out[key as String] = openApi(value) }
        else -> schema
    }

    private fun isGeminiOwnId(id: String) = !id.startsWith("gemini_")

    private fun callJson(call: AiToolCall) = call.input ?: emptyMap<String, Any?>()

    // Version 2: files first, the text last (Anthropic advises it, and it does no harm elsewhere).
    private fun hasParts(message: AiMessage) = message is AiMessage.User && message.parts.isNotEmpty()
    private fun dataUrl(part: AiPart) = AiBase64(part.bytes, "data:${part.mime};base64,")
    private val FILE_NAME_MARKS = Regex("[\\x00-\\x1f\\x7f\"\\\\]+")
    private fun fileName(part: AiPart) = FILE_NAME_MARKS.replace(part.name, " ").trim().take(100).ifEmpty { "document.pdf" }
    private val AUDIO_FORMAT = mapOf("audio/mp4" to "m4a", "audio/m4a" to "m4a", "audio/x-m4a" to "m4a", "audio/aac" to "aac", "audio/webm" to "webm", "audio/ogg" to "ogg", "audio/mpeg" to "mp3", "audio/wav" to "wav", "audio/x-wav" to "wav")
    // Gemini's lists (11 Nov 2026): no GIF among the pictures; recordings as audio/m4a, not audio/mp4.
    private val GEMINI_IMAGES = setOf("image/jpeg", "image/png", "image/webp")
    private val GEMINI_AUDIO = mapOf("audio/mp4" to "audio/m4a", "audio/x-m4a" to "audio/m4a", "audio/x-wav" to "audio/wav")

    private fun anthropicPart(part: AiPart): Map<String, Any?> = when (part.kind) {
        "image" -> linkedMapOf("type" to "image", "source" to linkedMapOf("type" to "base64", "media_type" to part.mime, "data" to AiBase64(part.bytes)))
        "pdf" -> linkedMapOf("type" to "document", "source" to linkedMapOf("type" to "base64", "media_type" to "application/pdf", "data" to AiBase64(part.bytes)))
        else -> throw AiError("unsupported_input", AiParts.explain("anthropic", part.kind))
    }

    private fun openAiPart(part: AiPart): Map<String, Any?> = when (part.kind) {
        "image" -> linkedMapOf("type" to "image_url", "image_url" to linkedMapOf("url" to dataUrl(part)))
        "pdf" -> linkedMapOf("type" to "file", "file" to linkedMapOf("filename" to fileName(part), "file_data" to dataUrl(part)))
        else -> linkedMapOf("type" to "input_audio", "input_audio" to linkedMapOf("data" to AiBase64(part.bytes), "format" to AUDIO_FORMAT[part.mime]))
    }

    private fun geminiPart(part: AiPart): Map<String, Any?> {
        if (part.kind == "image" && part.mime !in GEMINI_IMAGES) throw AiError("unsupported_input", "Gemini cannot read GIF pictures. Use a JPEG, PNG or WebP picture.")
        return linkedMapOf("inlineData" to linkedMapOf("mimeType" to (GEMINI_AUDIO[part.mime] ?: part.mime), "data" to AiBase64(part.bytes)))
    }

    private fun anthropicMessages(messages: List<AiMessage>): List<Any?> = messages.map { message ->
        when (message) {
            is AiMessage.User -> if (hasParts(message)) linkedMapOf("role" to "user", "content" to message.parts.map(::anthropicPart) + linkedMapOf("type" to "text", "text" to message.text))
                else linkedMapOf("role" to "user", "content" to message.text)
            is AiMessage.Tool -> linkedMapOf("role" to "user", "content" to message.results.map { r ->
                linkedMapOf<String, Any?>("type" to "tool_result", "tool_use_id" to r.id, "content" to r.content).also { if (r.isError) it["is_error"] = true }
            })
            is AiMessage.Assistant -> linkedMapOf("role" to "assistant", "content" to (message.raw ?: (
                (if (message.text.isNotEmpty()) listOf(linkedMapOf("type" to "text", "text" to message.text)) else emptyList()) +
                    message.toolCalls.map { c -> linkedMapOf("type" to "tool_use", "id" to c.id, "name" to c.name, "input" to callJson(c)) })))
        }
    }

    private fun openAiMessages(system: String, messages: List<AiMessage>): List<Any?> =
        listOf(linkedMapOf("role" to "system", "content" to system)) + messages.flatMap { message ->
            when (message) {
                is AiMessage.User -> listOf(linkedMapOf("role" to "user", "content" to
                    if (hasParts(message)) message.parts.map(::openAiPart) + linkedMapOf("type" to "text", "text" to message.text) else message.text))
                is AiMessage.Tool -> message.results.map { r -> linkedMapOf("role" to "tool", "tool_call_id" to r.id, "content" to r.content) }
                is AiMessage.Assistant -> {
                    val raw = message.raw.obj()
                    if (raw != null) listOf(LinkedHashMap<String, Any?>().apply { put("role", "assistant"); putAll(raw) })
                    else {
                        val calls = message.toolCalls.map { c -> linkedMapOf("id" to c.id, "type" to "function", "function" to linkedMapOf("name" to c.name, "arguments" to AiJson.stringify(callJson(c)))) }
                        listOf(LinkedHashMap<String, Any?>().apply {
                            put("role", "assistant"); put("content", message.text.ifEmpty { null })
                            if (calls.isNotEmpty()) put("tool_calls", calls)
                        })
                    }
                }
            }
        }

    private fun geminiContents(messages: List<AiMessage>): List<Any?> = messages.map { message ->
        when (message) {
            is AiMessage.User -> linkedMapOf("role" to "user", "parts" to message.parts.map(::geminiPart) + linkedMapOf("text" to message.text))
            is AiMessage.Tool -> linkedMapOf("role" to "user", "parts" to message.results.map { r ->
                val response = LinkedHashMap<String, Any?>()
                if (isGeminiOwnId(r.id)) response["id"] = r.id
                response["name"] = r.name
                response["response"] = if (r.isError) linkedMapOf("error" to r.content) else linkedMapOf("content" to r.content)
                linkedMapOf("functionResponse" to response)
            })
            is AiMessage.Assistant -> linkedMapOf("role" to "model", "parts" to (message.raw ?: (
                (if (message.text.isNotEmpty()) listOf(linkedMapOf("text" to message.text)) else emptyList()) +
                    message.toolCalls.map { c ->
                        val call = LinkedHashMap<String, Any?>()
                        if (isGeminiOwnId(c.id)) call["id"] = c.id
                        call["name"] = c.name; call["args"] = callJson(c)
                        linkedMapOf("functionCall" to call)
                    })))
        }
    }

    // encodeURIComponent: a model id goes into the Gemini path as one segment.
    private fun encodeSegment(value: String): String = buildString {
        for (byte in value.toByteArray(Charsets.UTF_8)) {
            val char = (byte.toInt() and 0xff).toChar()
            if (char.isLetterOrDigit() && char.code < 128 || char in "-_.!~*'()") append(char) else append("%%%02X".format(byte.toInt() and 0xff))
        }
    }

    /** The HTTP request for one round. Throws AiError when AI cannot run. */
    fun buildRequest(config: AiConfig, system: String, messages: List<AiMessage>, tools: List<AiTool>): AiRequest {
        val target = resolve(config)
        val model = target.model!!
        val parts = messages.filterIsInstance<AiMessage.User>().flatMap { it.parts }
        checkFiles(target, config, parts, "ask")
        val body = LinkedHashMap<String, Any?>()
        val url = when (target.spec.form) {
            "anthropic" -> {
                body["model"] = model; body["max_tokens"] = MAX_TOKENS; body["system"] = system; body["messages"] = anthropicMessages(messages)
                if (tools.isNotEmpty()) body["tools"] = tools.map { it.json() }
                "${target.base}/v1/messages"
            }
            "gemini" -> {
                body["systemInstruction"] = linkedMapOf("parts" to listOf(linkedMapOf("text" to system)))
                body["contents"] = geminiContents(messages)
                if (tools.isNotEmpty()) body["tools"] = listOf(linkedMapOf("functionDeclarations" to tools.map { linkedMapOf("name" to it.name, "description" to it.description, "parameters" to openApi(it.inputSchema)) }))
                "${target.base}/models/${encodeSegment(model.removePrefix("models/"))}:generateContent"
            }
            else -> {
                body["model"] = model; body["messages"] = openAiMessages(system, messages)
                if (tools.isNotEmpty()) body["tools"] = tools.map { linkedMapOf("type" to "function", "function" to linkedMapOf("name" to it.name, "description" to it.description, "parameters" to it.inputSchema)) }
                // Without file input of its own, OpenRouter turns a PDF into text; its default for that is the paid
                // OCR (read 11 Nov 2026). JotDrop asks for the free conversion; a model that reads files gets the PDF.
                if (target.spec.id == "openrouter" && parts.any { it.kind == "pdf" } && config.inputs?.contains("file") != true)
                    body["plugins"] = listOf(linkedMapOf("id" to "file-parser", "pdf" to linkedMapOf("engine" to "cloudflare-ai")))
                "${target.base}/chat/completions"
            }
        }
        return AiRequest(url, "POST", headersFor(target, true), AiJson.body(body))
    }

    private fun capsFor(target: Target, config: AiConfig) = AiParts.capabilities(target.spec.id, config.inputs)

    // What cannot go stops here, before anything goes out: a kind the service cannot read, then the limits.
    private fun checkFiles(target: Target, config: AiConfig, parts: List<AiPart>, use: String) {
        if (parts.isEmpty()) return
        val caps = capsFor(target, config)
        for (part in parts) {
            val field = if (part.kind == "audio" && use == "transcribe") "transcribe" else part.kind
            if (caps.of(field) == false) throw AiError("unsupported_input", AiParts.explain(target.spec.id, part.kind, use))
        }
        AiParts.checkParts(parts, if (use == "transcribe") AiCaps(null, null, caps.transcribe, null) else caps)
    }

    // Writing out a recording (version 2). OpenAI has its own address and model for it (read 11 Nov 2026); Gemini
    // and OpenRouter get the recording with this instruction and no tools.
    const val TRANSCRIBE_MODEL = "gpt-transcribe"
    const val TRANSCRIBE_PROMPT = "Write out this recording word for word, in the language that is spoken. Return only the text."
    private val OPENAI_AUDIO = mapOf("audio/mp4" to "m4a", "audio/m4a" to "m4a", "audio/x-m4a" to "m4a", "audio/webm" to "webm", "audio/mpeg" to "mp3", "audio/wav" to "wav", "audio/x-wav" to "wav")
    private val LANGUAGE = Regex("(?i)^([a-z]{2})(?:[-_]|$)")
    private val random = SecureRandom()

    private fun freshBoundary(): String = "jotdrop-" + ByteArray(16).also(random::nextBytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }

    /**
     * The HTTP request that writes out a recording. For OpenAI multipart/form-data in three pieces: the head, the
     * recording's own bytes (no copy) and the tail. language: the app's language as a hint ("nl" or "nl-NL"), left
     * out when it is not a two-letter code.
     */
    fun transcribeRequest(config: AiConfig, audio: AiPart, language: String?, boundary: String? = null): AiRequest {
        val target = resolve(config)
        val model = target.model!!
        val id = target.spec.id
        if (audio.kind != "audio") throw AiError("unsupported_input", "Only a recording can be written out.")
        checkFiles(target, config, listOf(audio), "transcribe")
        if (id == "openai") {
            val ext = OPENAI_AUDIO[audio.mime] ?: throw AiError("unsupported_input", "OpenAI cannot write out ${AUDIO_FORMAT[audio.mime] ?: "these"} recordings. Gemini can.")
            val code = LANGUAGE.find(language?.trim().orEmpty())?.groupValues?.get(1)?.lowercase()
            val mark = boundary ?: freshBoundary()
            val fields = listOf("model" to TRANSCRIBE_MODEL) + (if (code != null) listOf("languages[]" to code) else emptyList())
            val head = fields.joinToString("") { (name, value) -> "--$mark\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n$value\r\n" } +
                "--$mark\r\nContent-Disposition: form-data; name=\"file\"; filename=\"recording.$ext\"\r\nContent-Type: ${audio.mime}\r\n\r\n"
            val headers = LinkedHashMap(headersFor(target, false)).apply { put("Content-Type", "multipart/form-data; boundary=$mark") }
            return AiRequest("${target.base}/audio/transcriptions", "POST", headers, AiBody(listOf(head, audio.bytes, "\r\n--$mark--\r\n")))
        }
        if (target.spec.form == "gemini") {
            val body = linkedMapOf("contents" to listOf(linkedMapOf("role" to "user", "parts" to listOf(geminiPart(audio), linkedMapOf("text" to TRANSCRIBE_PROMPT)))))
            return AiRequest("${target.base}/models/${encodeSegment(model.removePrefix("models/"))}:generateContent", "POST", headersFor(target, true), AiJson.body(body))
        }
        if (id == "openrouter") {
            val body = linkedMapOf("model" to model, "messages" to listOf(linkedMapOf("role" to "user", "content" to listOf(openAiPart(audio), linkedMapOf("type" to "text", "text" to TRANSCRIBE_PROMPT)))))
            return AiRequest("${target.base}/chat/completions", "POST", headersFor(target, true), AiJson.body(body))
        }
        throw AiError("unsupported_input", AiParts.explain(id, "audio", "transcribe"))
    }

    /** A transcription answer: the text, and tokens or seconds. A refused recording is AiError("refusal"). */
    fun parseTranscription(provider: String, json: Any?): AiTranscript {
        if (provider == "openai") {
            val root = json.obj()
            val text = root?.get("text") as? String ?: throw AiError("bad_response")
            val usage = root.child("usage")
            return if (usage.str("type") == "duration") AiTranscript(text.trim(), 0, 0, (usage?.get("seconds") as? Number)?.toDouble()?.takeIf { !it.isNaN() } ?: 0.0)
                else AiTranscript(text.trim(), usage.num("input_tokens") ?: 0, usage.num("output_tokens") ?: 0)
        }
        val answer = parseResponse(provider, json)
        if (answer.stop == "refusal") throw AiError("refusal")
        return AiTranscript(answer.text.trim(), answer.input, answer.output)
    }

    /** The request for the provider's model list. */
    fun modelsRequest(config: AiConfig): AiRequest {
        val target = resolve(config, needModel = false)
        val path = when (target.spec.form) { "anthropic" -> "/v1/models?limit=1000"; "gemini" -> "/models?pageSize=1000"; else -> "/models" }
        return AiRequest("${target.base}$path", "GET", headersFor(target, false), null)
    }

    private val REFUSED = setOf("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY")

    /** One round's answer in JotDrop's form. */
    fun parseResponse(provider: String, json: Any?): AiAnswer {
        val root = json.obj()
        when (SPECS[provider]?.form) {
            "anthropic" -> {
                val content = root.items("content")
                val blocks = content.mapNotNull { it.obj() }
                val toolCalls = blocks.filter { it["type"] == "tool_use" }.map { AiToolCall(it.str("id") ?: "", it.str("name") ?: "", it.child("input") ?: emptyMap()) }
                val stop = when (root.str("stop_reason")) { "refusal" -> "refusal"; "max_tokens" -> "length"; "tool_use" -> "tool"; else -> if (toolCalls.isNotEmpty()) "tool" else "end" }
                val usage = root.child("usage")
                return AiAnswer(blocks.filter { it["type"] == "text" }.joinToString("") { it.str("text") ?: "" }, toolCalls, stop, usage.num("input_tokens") ?: 0, usage.num("output_tokens") ?: 0, content)
            }
            "gemini" -> {
                val candidate = root.items("candidates").firstOrNull().obj()
                val parts = candidate.child("content").items("parts")
                val toolCalls = parts.mapIndexedNotNull { index, part ->
                    val call = part.obj().child("functionCall") ?: return@mapIndexedNotNull null
                    val id = call.str("id") ?: "gemini_$index"
                    val args = call["args"]
                    if (args == null || args is Map<*, *>) AiToolCall(id, call.str("name") ?: "", args.obj() ?: emptyMap())
                    else AiToolCall(id, call.str("name") ?: "", null, "invalid_arguments")
                }
                val reason = candidate.str("finishReason")
                val stop = if (candidate == null || reason in REFUSED) "refusal" else if (reason == "MAX_TOKENS") "length" else if (toolCalls.isNotEmpty()) "tool" else "end"
                if (candidate == null && root?.get("promptFeedback") == null) throw AiError("bad_response")
                val usage = root.child("usageMetadata")
                val text = parts.mapNotNull { it.obj() }.filter { it["text"] is String && it["thought"] != true }.joinToString("") { it["text"] as String }
                return AiAnswer(text, toolCalls, stop, usage.num("promptTokenCount") ?: 0, usage.num("candidatesTokenCount") ?: 0, parts)
            }
        }
        val choice = root.items("choices").firstOrNull().obj() ?: throw AiError("bad_response")
        val message = choice.child("message") ?: emptyMap()
        val toolCalls = message.items("tool_calls").mapIndexed { index, item ->
            val call = item.obj()
            val function = call.child("function")
            val name = function.str("name") ?: ""
            val id = call.str("id") ?: "call_$index"
            val args = function?.get("arguments")
            val input: Any? = when (args) {
                is String -> AiJson.parseOrNull(args.ifEmpty { "{}" })
                null -> emptyMap<String, Any?>()
                else -> args
            }
            input.obj()?.let { AiToolCall(id, name, it) } ?: AiToolCall(id, name, null, "invalid_arguments")
        }
        val finish = choice.str("finish_reason")
        val stop = if (finish == "content_filter") "refusal" else if (finish == "length") "length" else if (toolCalls.isNotEmpty()) "tool" else "end"
        // OpenRouter asks reasoning models to get their reasoning_details back unchanged; OpenAI does not take the field.
        val raw = LinkedHashMap<String, Any?>()
        raw["content"] = message["content"]
        if (message["tool_calls"] != null) raw["tool_calls"] = message["tool_calls"]
        if (provider == "openrouter" && message["reasoning_details"] != null) raw["reasoning_details"] = message["reasoning_details"]
        val usage = root.child("usage")
        return AiAnswer(message["content"] as? String ?: "", toolCalls, stop, usage.num("prompt_tokens") ?: 0, usage.num("completion_tokens") ?: 0, raw)
    }

    private val NOT_CHAT = Regex("(?i)embed|tts|whisper|transcri|dall-e|image|moderation|realtime|audio|live|search")

    private fun price(value: Any?): Double = when (value) { null -> 0.0; is Number -> value.toDouble(); is String -> value.trim().ifEmpty { "0" }.toDoubleOrNull() ?: Double.NaN; else -> Double.NaN }

    /** The provider's model list; tools is null when the list does not say. */
    fun parseModels(provider: String, json: Any?): List<AiModel> {
        val root = json.obj()
        val form = SPECS[provider]?.form
        if (form == "anthropic") return root.items("data").mapNotNull { it.obj() }.map { m -> val id = m.str("id") ?: ""; AiModel(id, m.str("display_name")?.ifEmpty { null } ?: id, true) }
        if (form == "gemini") return root.items("models").mapNotNull { it.obj() }.filter { m -> "generateContent" in m.items("supportedGenerationMethods") }.map { m ->
            val id = (m.str("name") ?: "").removePrefix("models/")
            AiModel(id, m.str("displayName")?.ifEmpty { null } ?: id, true)
        }
        if (provider == "openrouter") return root.items("data").mapNotNull { it.obj() }.map { m ->
            val id = m.str("id") ?: ""
            val pricing = m.child("pricing")
            AiModel(id, m.str("name")?.ifEmpty { null } ?: id, "tools" in m.items("supported_parameters"), price(pricing?.get("prompt")) + price(pricing?.get("completion")))
        }
        return root.items("data").mapNotNull { it.obj() }.filter { m -> provider != "openai" || !NOT_CHAT.containsMatchIn(m.str("id") ?: "") }.map { m -> val id = m.str("id") ?: ""; AiModel(id, id, null) }
    }

    /** The model to start with: the fixed default when the list has it; on OpenRouter the cheapest paid one with tools. */
    fun pickDefaultModel(provider: String, models: List<AiModel>): String? {
        val spec = SPECS[provider]
        if (spec?.defaultModel != null && models.any { it.id == spec.defaultModel }) return spec.defaultModel
        if (provider == "openrouter") return models.filter { it.tools == true && it.price > 0 }.sortedBy { it.price }.firstOrNull()?.id
        return if (spec?.defaultModel != null) models.firstOrNull()?.id else null
    }

    private fun readError(status: Int, json: Map<String, Any?>?, text: String, secrets: List<String>): AiError {
        val rawInfo = json?.get("error")
        val info = rawInfo.obj() ?: emptyMap()
        val message = if (rawInfo is String) rawInfo else info.str("message") ?: (if (json != null) "" else text)
        val reasons = info.items("details").map { it.obj().str("reason") }
        val detail = AiRedact.redact(message, secrets)
        if ("API_KEY_INVALID" in reasons || (status == 400 && Regex("(?i)api key").containsMatchIn(message))) return AiError("auth", detail, status)
        if (status == 401 || status == 403) return AiError("auth", detail, status)
        if (status == 402 || info["code"] == "insufficient_quota" || info["type"] == "insufficient_quota") return AiError("quota", detail, status)
        if (status == 429) return AiError("rate", detail, status)
        if (status == 404) return AiError("model", detail, status)
        if (status >= 500) return AiError("server", detail, status)
        return AiError("bad_request", detail, status)
    }

    /**
     * One request and its JSON answer. Throws AiError: network, timeout, an error from the service, or
     * bad_response when the answer is not JSON. Coroutine cancellation passes through.
     */
    suspend fun send(fetcher: AiFetcher, request: AiRequest, timeoutMs: Long, secrets: List<String>): Any? {
        val response = try {
            fetcher.fetch(request, timeoutMs)
        } catch (error: java.net.SocketTimeoutException) {
            throw AiError("timeout")
        } catch (error: kotlinx.coroutines.CancellationException) {
            throw error
        } catch (error: Exception) {
            throw AiError("network", AiRedact.redact(error, secrets))
        }
        val parsed = AiJson.parseOrNull(response.text)
        val json = if (parsed === AiJson.MISSING) null else parsed
        val error = json.obj()?.get("error")
        // OpenRouter can put an error inside a 200 answer.
        if (!response.ok || error is Map<*, *>) {
            val status = if (response.ok) (error.obj()?.get("code")?.toString()?.toDoubleOrNull()?.toInt()?.takeIf { it != 0 } ?: 400) else response.status
            throw readError(status, json.obj(), response.text, secrets)
        }
        if (parsed === AiJson.MISSING) throw AiError("bad_response", AiRedact.redact(response.text, secrets))
        return json
    }

    /** A provider for one configuration. Throws AiError (no_provider, no_key, no_model, bad_address) before anything goes out. */
    fun create(config: AiConfig, fetcher: AiFetcher): AiProvider {
        val target = resolve(config)
        val secrets = listOf(target.key)
        val caps = capsFor(target, config)
        return object : AiProvider {
            override val id = config.provider
            override val model = target.model!!
            override val capabilities = caps
            override suspend fun complete(system: String, messages: List<AiMessage>, tools: List<AiTool>, timeoutMs: Long): AiAnswer {
                val request = buildRequest(config, system, messages, tools)
                try {
                    return parseResponse(config.provider, send(fetcher, request, timeoutMs, secrets))
                } catch (error: AiError) {
                    // A service that may or may not read a kind of file (an own address, an OpenRouter model not in
                    // the list) says no with a plain 400, or with a 404 that names the input: tell the user what it is.
                    val unknown = messages.filterIsInstance<AiMessage.User>().flatMap { it.parts }.any { it.kind in AiParts.KINDS && caps.of(it.kind) == null }
                    if (unknown && (error.code == "bad_request" || (error.code == "model" && NAMES_INPUT.containsMatchIn(error.detail)))) throw AiError("unsupported_input", error.detail, error.status)
                    throw error
                }
            }
            override suspend fun transcribe(audio: AiPart, language: String?, timeoutMs: Long): AiTranscript =
                parseTranscription(config.provider, send(fetcher, transcribeRequest(config, audio, language), timeoutMs, secrets))
        }
    }

    private val NAMES_INPUT = Regex("(?i)support|image|audio|file|pdf|vision|modalit|input")

    /** The provider's models, for Settings. */
    suspend fun listModels(config: AiConfig, fetcher: AiFetcher, timeoutMs: Long = 20000): List<AiModel> =
        parseModels(config.provider, send(fetcher, modelsRequest(config), timeoutMs, listOf(config.key.trim())))
}

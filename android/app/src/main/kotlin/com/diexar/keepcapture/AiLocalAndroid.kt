package com.diexar.keepcapture

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.MessageCallback
import com.google.ai.edge.litertlm.SamplerConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Where a model download stands, for the settings screen. phase: idle, running, checking (the hash), failed (with
 * an AiError code) or done. It lives with the app, so leaving the screen does not stop it; closing the app does,
 * and the next "Continue" carries on.
 */
data class AiDownloadState(val model: String = "", val phase: String = "idle", val done: Long = 0, val total: Long = 0, val error: String? = null)

/** The model on this phone, Android's side: the folder, the download, LiteRT-LM and the one engine of the app. */
object AiLocal {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val state = MutableStateFlow(AiDownloadState())
    val download: StateFlow<AiDownloadState> get() = state
    private var job: Job? = null
    @Volatile private var engine: AiLocalEngine? = null

    /** In the no-backup folder: a backup has room for 25 MB, and the sync never looks here. */
    fun dir(context: Context) = File(context.noBackupFilesDir, "ai-models")
    private fun backendFile(context: Context) = File(dir(context), "backend")

    /** LiteRT-LM comes for 64-bit ARM and x86 only. */
    val supported: Boolean get() = Build.SUPPORTED_ABIS.any { it == "arm64-v8a" || it == "x86_64" }

    fun totalMemory(context: Context): Long =
        ActivityManager.MemoryInfo().also { context.getSystemService(ActivityManager::class.java).getMemoryInfo(it) }.totalMem

    /** The model the user chose (or the phone's default) and its file when it is downloaded. */
    fun chosen(context: Context, id: String) = AiLocalModels.byId(id) ?: AiLocalModels.default(totalMemory(context))
    fun ready(context: Context, model: AiLocalModel) = AiModelDownload.ready(dir(context), model)

    fun engine(context: Context): AiLocalEngine = engine ?: synchronized(this) {
        engine ?: AiLocalEngine(
            AiLiteRtLoader(context.applicationContext.cacheDir.absolutePath),
            readBackend = { runCatching { backendFile(context).readText().trim() }.getOrNull() },
            writeBackend = { value -> runCatching { dir(context).mkdirs(); backendFile(context).writeText(value) } },
            scope = scope,
        ).also { engine = it }
    }

    /** The provider for Ask JotDrop; AiError("model_missing") when the model is not downloaded (yet). */
    fun provider(context: Context, settings: AiSettings, loading: () -> Unit = {}): AiProvider {
        val model = chosen(context, settings.model)
        val file = ready(context, model) ?: throw AiError("model_missing")
        return AiLocalProvider(engine(context), model, file.absolutePath, loading)
    }

    fun start(context: Context, model: AiLocalModel) {
        if (job?.isActive == true) return
        val app = context.applicationContext
        state.value = AiDownloadState(model.id, "running", AiModelDownload.partial(dir(app), model), model.bytes)
        job = scope.launch {
            state.value = try {
                AiModelDownload.download(model, dir(app), AiModelHttp,
                    progress = { done, total -> state.value = AiDownloadState(model.id, "running", done, total) },
                    checking = { state.value = AiDownloadState(model.id, "checking", model.bytes, model.bytes) })
                AiDownloadState(model.id, "done", model.bytes, model.bytes)
            } catch (error: CancellationException) {
                AiDownloadState(model.id, "idle", AiModelDownload.partial(dir(app), model), model.bytes)
            } catch (error: AiError) {
                AiDownloadState(model.id, "failed", AiModelDownload.partial(dir(app), model), model.bytes, error.code)
            }
        }
    }

    fun stop() { job?.cancel() }

    /** The model and any unfinished download gone; the next model tries the graphics chip again. */
    suspend fun delete(context: Context, model: AiLocalModel) {
        job?.let { it.cancel(); it.join() }
        engine?.close()
        withContext(Dispatchers.IO) { AiModelDownload.delete(dir(context), model); backendFile(context).delete() }
        state.value = AiDownloadState()
    }
}

/**
 * The model download over HttpURLConnection: no automatic redirects (AiModelDownload follows them itself and
 * checks each host), no caches, a Range header to carry on.
 */
object AiModelHttp : AiRangeFetcher {
    override fun open(url: String, from: Long): AiRangeResponse {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.instanceFollowRedirects = false
        connection.useCaches = false
        connection.connectTimeout = 20_000
        connection.readTimeout = 60_000
        connection.setRequestProperty("Accept-Encoding", "identity")
        connection.setRequestProperty("User-Agent", "JotDrop-Android")
        if (from > 0) connection.setRequestProperty("Range", "bytes=$from-")
        val status = connection.responseCode
        val body = (if (status < 400) connection.inputStream else connection.errorStream) ?: java.io.ByteArrayInputStream(ByteArray(0))
        return AiRangeResponse(status, connection.getHeaderField("Location"), connection.getHeaderField("Content-Range"),
            connection.contentLengthLong, body) { connection.disconnect() }
    }
}

/** LiteRT-LM: text only for now (no vision or audio part loaded), 4096 tokens. */
class AiLiteRtLoader(private val cacheDir: String) : AiLocalLoader {
    companion object { const val MAX_TOKENS = 4096 }

    override fun load(path: String, backend: String): AiLocalRunner {
        val engine = Engine(EngineConfig(modelPath = path, backend = if (backend == "gpu") Backend.GPU() else Backend.CPU(),
            maxNumTokens = MAX_TOKENS, cacheDir = cacheDir))
        try { engine.initialize() } catch (error: Throwable) { runCatching { engine.close() }; throw error }
        return object : AiLocalRunner {
            override suspend fun generate(system: String, prompt: String): String = withContext(Dispatchers.IO) {
                val conversation = engine.createConversation(ConversationConfig(systemInstruction = Contents.of(system),
                    samplerConfig = SamplerConfig(topK = 40, topP = 0.95, temperature = 0.3)))
                val text = StringBuilder()
                val finished = CompletableDeferred<Throwable?>()
                conversation.sendMessageAsync(Contents.of(prompt), object : MessageCallback {
                    override fun onMessage(message: Message) {
                        synchronized(text) { for (part in message.contents.contents) if (part is Content.Text) text.append(part.text) }
                    }
                    override fun onDone() { finished.complete(null) }
                    override fun onError(throwable: Throwable) { finished.complete(throwable) }
                })
                var quiet = true
                try {
                    finished.await()?.let { throw AiError("local_failed", it.javaClass.simpleName) }
                    synchronized(text) { text.toString() }
                } catch (error: CancellationException) {
                    // Stop: the model ends its answer; the conversation closes only once it has, never under it.
                    runCatching { conversation.cancelProcess() }
                    quiet = withContext(NonCancellable) { withTimeoutOrNull(10_000) { finished.await(); true } } == true
                    throw error
                } finally {
                    if (quiet) runCatching { conversation.close() }
                }
            }

            override fun close() = engine.close()
        }
    }
}

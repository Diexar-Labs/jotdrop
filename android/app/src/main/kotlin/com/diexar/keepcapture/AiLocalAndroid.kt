package com.diexar.keepcapture

import android.app.ActivityManager
import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.Build
import android.os.SystemClock
import android.util.Log
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
    fun provider(context: Context, settings: AiSettings, loading: (Boolean) -> Unit = {}): AiProvider {
        val model = chosen(context, settings.model)
        val file = ready(context, model) ?: throw AiError("model_missing")
        return AiLocalProvider(engine(context), model, file.absolutePath, AiLocalFilesAndroid(context.applicationContext), loading)
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

/**
 * LiteRT-LM with its vision part (on the same chip as the text) and its audio part (on the processor, as in the
 * trial), 8192 tokens: the trial on Eric's phone ran E4B so. Only counts and times go to the log, never text.
 */
class AiLiteRtLoader(private val cacheDir: String) : AiLocalLoader {
    companion object { const val MAX_TOKENS = 8192 }

    override fun load(path: String, backend: String): AiLocalRunner {
        val started = SystemClock.elapsedRealtime()
        val main = { if (backend == "gpu") Backend.GPU() else Backend.CPU() }
        val engine = Engine(EngineConfig(modelPath = path, backend = main(), visionBackend = main(), audioBackend = Backend.CPU(),
            maxNumTokens = MAX_TOKENS, cacheDir = cacheDir))
        try { engine.initialize() } catch (error: Throwable) { runCatching { engine.close() }; throw error }
        Log.i("AskJotDrop", "Phone model loaded on $backend in ${SystemClock.elapsedRealtime() - started} ms")
        return object : AiLocalRunner {
            override suspend fun generate(system: String, prompt: String, media: List<AiLocalMedia>): String = withContext(Dispatchers.IO) {
                val asked = SystemClock.elapsedRealtime()
                val conversation = engine.createConversation(ConversationConfig(systemInstruction = Contents.of(system),
                    samplerConfig = SamplerConfig(topK = 40, topP = 0.95, temperature = 0.3)))
                val text = StringBuilder()
                var first = 0L
                val finished = CompletableDeferred<Throwable?>()
                val contents = media.map { if (it.kind == "audio") Content.AudioFile(it.path) else Content.ImageFile(it.path) } + Content.Text(prompt)
                conversation.sendMessageAsync(Contents.of(contents), object : MessageCallback {
                    override fun onMessage(message: Message) {
                        synchronized(text) {
                            if (first == 0L) first = SystemClock.elapsedRealtime()
                            for (part in message.contents.contents) if (part is Content.Text) text.append(part.text)
                        }
                    }
                    override fun onDone() { finished.complete(null) }
                    override fun onError(throwable: Throwable) { finished.complete(throwable) }
                })
                var quiet = true
                try {
                    finished.await()?.let { throw AiError("local_failed", it.javaClass.simpleName) }
                    synchronized(text) {
                        val now = SystemClock.elapsedRealtime()
                        Log.i("AskJotDrop", "Phone model answered on $backend: ${media.size} files, ${prompt.length} chars in, ${text.length} chars out, " +
                            "first words after ${if (first > 0) first - asked else -1} ms, done after ${now - asked} ms")
                        text.toString()
                    }
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

/**
 * The files the model reads, in the cache folder "ai-local" (the provider deletes them after each answer): a photo as the
 * JPEG Ask JotDrop already made, a recording decoded by Android (m4a, webm, ogg, mp3, wav, aac), made 16 kHz mono
 * and cut in pieces of WAV.
 */
class AiLocalFilesAndroid(private val context: Context) : AiLocalFiles {
    private fun folder() = File(context.cacheDir, "ai-local").apply { mkdirs() }
    private fun file(ending: String) = File.createTempFile("ai-", ending, folder())

    override fun image(part: AiPart): File = file(".jpg").apply { writeBytes(part.bytes) }

    override fun audio(part: AiPart, maxSeconds: Int): List<File> {
        val name = AiParts.label(part.name)
        val source = file(".audio").apply { writeBytes(part.bytes) }
        val extractor = MediaExtractor()
        var codec: MediaCodec? = null
        try {
            try { extractor.setDataSource(source.absolutePath) } catch (_: Exception) { throw AiError("unsupported_input", "$name: Android cannot read this recording.") }
            val track = (0 until extractor.trackCount).firstOrNull { extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true }
                ?: throw AiError("unsupported_input", "$name: Android cannot read this recording.")
            val format = extractor.getTrackFormat(track)
            val minutes = maxSeconds / 60
            if (format.containsKey(MediaFormat.KEY_DURATION) && format.getLong(MediaFormat.KEY_DURATION) > maxSeconds * 1_000_000L) {
                throw AiError("too_large", "$name is longer than $minutes minutes, the most the model on this phone writes out at once.")
            }
            extractor.selectTrack(track)
            val decoder = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!).also { codec = it }
            decoder.configure(format, null, null, 0)
            decoder.start()
            var samples = ShortArray(AiLocalAudio.RATE * 60)
            var size = 0
            var resampler: AiLocalAudio.Resampler? = null
            val info = MediaCodec.BufferInfo()
            var inputDone = false
            while (true) {
                if (!inputDone) {
                    val index = decoder.dequeueInputBuffer(10_000)
                    if (index >= 0) {
                        val read = extractor.readSampleData(decoder.getInputBuffer(index)!!, 0)
                        if (read < 0) { decoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputDone = true }
                        else { decoder.queueInputBuffer(index, 0, read, extractor.sampleTime, 0); extractor.advance() }
                    }
                }
                val out = decoder.dequeueOutputBuffer(info, 10_000)
                if (out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) resampler = null
                if (out < 0) continue
                if (resampler == null) {
                    val now = decoder.outputFormat
                    if (now.containsKey(MediaFormat.KEY_PCM_ENCODING) && now.getInteger(MediaFormat.KEY_PCM_ENCODING) != android.media.AudioFormat.ENCODING_PCM_16BIT) {
                        throw AiError("unsupported_input", "$name: Android cannot read this recording.")
                    }
                    resampler = AiLocalAudio.Resampler(now.getInteger(MediaFormat.KEY_SAMPLE_RATE), now.getInteger(MediaFormat.KEY_CHANNEL_COUNT))
                }
                val buffer = decoder.getOutputBuffer(out)!!
                buffer.position(info.offset)
                buffer.limit(info.offset + info.size)
                val pcm = ShortArray(info.size / 2)
                buffer.order(java.nio.ByteOrder.nativeOrder()).asShortBuffer().get(pcm)
                decoder.releaseOutputBuffer(out, false)
                val mono = resampler.feed(pcm)
                if (size + mono.size > maxSeconds * AiLocalAudio.RATE) {
                    throw AiError("too_large", "$name is longer than $minutes minutes, the most the model on this phone writes out at once.")
                }
                if (size + mono.size > samples.size) samples = samples.copyOf(maxOf(samples.size * 2, size + mono.size))
                mono.copyInto(samples, size)
                size += mono.size
                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
            }
            if (size == 0) throw AiError("bad_request", "$name is empty.")
            val pieces = AiLocalAudio.pieces(samples, size).map { (from, to) -> file(".wav").apply { writeBytes(AiLocalAudio.wav(samples, from, to)) } }
            Log.i("AskJotDrop", "Recording for the phone model: ${size / AiLocalAudio.RATE} s in ${pieces.size} pieces")
            return pieces
        } catch (error: AiError) {
            throw error
        } catch (error: Exception) {
            throw AiError("unsupported_input", "$name: Android cannot read this recording.")
        } finally {
            runCatching { codec?.stop() }
            runCatching { codec?.release() }
            extractor.release()
            source.delete()
        }
    }
}

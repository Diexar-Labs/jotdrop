package com.diexar.keepcapture

import android.content.Context
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URI
import java.security.KeyStore
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Reading notes for Ask JotDrop: four at a time, so the storage provider is not flooded. */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
private val READERS = Dispatchers.IO.limitedParallelism(4)

/**
 * What the user chose in Settings. The key stays on this phone and is not in a backup. [synced] is for "Use this
 * key on all my devices" (AiKeySync): the server's time of the shared key this phone follows, 0 when its key is its
 * own. The switch for shared notes is never shared.
 */
data class AiSettings(val provider: String = "", val key: String = "", val model: String = "", val baseUrl: String = "", val includeShared: Boolean = false, val synced: Long = 0) {
    val on get() = provider.isNotEmpty()
    fun config() = AiConfig(provider, key, model, baseUrl)
    override fun toString() = "AiSettings($provider, key hidden, synced=$synced)"
}

/**
 * The AI settings, sealed with a key in the Android Keystore (alias jotdrop-ai-key-v1, AES-GCM) in the no-backup
 * folder, like CloudPreviewStore. Never in SharedPreferences: those are in the backup.
 */
class AiSecretStore(context: Context) {
    companion object {
        private val lock = Any()
        private const val ALIAS = "jotdrop-ai-key-v1"
        private const val AAD = "jotdrop:android:ai-settings:v1"
        /** The providers Android offers: the four fixed ones and an own https address (Ollama behind https, Mistral, ...). */
        val PROVIDERS = listOf("anthropic", "openai", "gemini", "openrouter", "custom")
    }
    private val file = AtomicFile(File(File(context.noBackupFilesDir, "ai").also { check(it.mkdirs() || it.isDirectory) }, "settings"))

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").also { it.load(null) }
        if (store.containsAlias(ALIAS)) return store.getKey(ALIAS, null) as SecretKey
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
            generateKey()
        }
    }

    fun load(): AiSettings = synchronized(lock) {
        val sealed = try { file.readFully() } catch (_: FileNotFoundException) { return AiSettings() }
        val stored = runCatching {
            val envelope = CloudClient.parseEnvelope(String(sealed, Charsets.UTF_8))
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, CloudCrypto.decode(envelope.iv)))
            cipher.updateAAD(AAD.toByteArray(Charsets.UTF_8))
            AiJson.parse(String(cipher.doFinal(CloudCrypto.decode(envelope.ciphertext)), Charsets.UTF_8)).obj()
        }.getOrNull() ?: return AiSettings()
        val provider = stored.str("provider")?.takeIf { it in PROVIDERS } ?: return AiSettings()
        val spec = AiProviders.SPECS.getValue(provider)
        val key = if (spec.needsKey || provider == "custom") stored.str("key").orEmpty().trim() else ""
        AiSettings(provider, key, stored.str("model").orEmpty().trim(), if (provider == "custom") stored.str("baseUrl").orEmpty().trim() else "",
            stored["includeShared"] == true, if (key.isNotEmpty()) AiKeySync.validTime(stored["synced"]) else 0)
    }

    fun save(settings: AiSettings) = synchronized(lock) {
        val json = AiJson.stringify(linkedMapOf("provider" to settings.provider, "key" to settings.key.trim(), "model" to settings.model.trim(),
            "baseUrl" to settings.baseUrl.trim(), "includeShared" to settings.includeShared, "synced" to settings.synced.coerceAtLeast(0)))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(AAD.toByteArray(Charsets.UTF_8))
        val sealed = CloudClient.envelopeJson(CloudEnvelope(CloudCrypto.encode(cipher.iv), CloudCrypto.encode(cipher.doFinal(json.toByteArray(Charsets.UTF_8)))))
        val output = file.startWrite()
        try { output.write(sealed.toString().toByteArray(Charsets.UTF_8)); file.finishWrite(output) } catch (error: Exception) { file.failWrite(output); throw error }
    }

    /** Ask JotDrop off: settings and key gone from this phone. */
    fun clear() = synchronized(lock) { file.delete() }
}

/**
 * Requests to the AI service with HttpURLConnection, like CloudClient: no redirects (a key must not follow one to
 * another host), no caches, at most 2 MB back, and a deadline for the whole request. Cancelling the coroutine
 * (the user taps Stop) closes the connection.
 */
object AiHttp : AiFetcher {
    private const val MAX_BYTES = 2 * 1024 * 1024
    private val deadlines = Executors.newSingleThreadScheduledExecutor { runnable -> Thread(runnable, "JotDropAiDeadline").apply { isDaemon = true } }

    override suspend fun fetch(request: AiRequest, timeoutMs: Long): AiHttpResponse = coroutineScope {
        val url = URI(request.url)
        // The app blocks plain http everywhere (scripts/check-transport-safety.cjs); an own address must be https.
        require(url.scheme == "https") { "Only https addresses." }
        val connection = url.toURL().openConnection() as HttpURLConnection
        // A blocking read does not see a cancelled coroutine; this closes the connection when the user taps Stop.
        val watcher = launch(start = CoroutineStart.UNDISPATCHED) { try { awaitCancellation() } finally { connection.disconnect() } }
        try { withContext(Dispatchers.IO) {
            val timedOut = AtomicBoolean(false)
            val timer = deadlines.schedule({ timedOut.set(true); connection.disconnect() }, timeoutMs.coerceAtLeast(1), TimeUnit.MILLISECONDS)
            try {
                connection.instanceFollowRedirects = false
                connection.useCaches = false
                connection.connectTimeout = minOf(15000L, timeoutMs).toInt().coerceAtLeast(1)
                connection.readTimeout = timeoutMs.coerceIn(1, Int.MAX_VALUE.toLong()).toInt()
                connection.requestMethod = request.method
                for ((name, value) in request.headers) connection.setRequestProperty(name, value)
                // The body in pieces with a fixed length (not chunked: an own address does not always take that);
                // a file's base64 is made while it is written, so the file is in memory once.
                request.body?.let { body ->
                    connection.doOutput = true
                    connection.setFixedLengthStreamingMode(body.length)
                    connection.outputStream.use { body.writeTo(it) }
                }
                val status = connection.responseCode
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val output = ByteArrayOutputStream()
                stream?.use { input ->
                    val buffer = ByteArray(8192)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        if (output.size() + count > MAX_BYTES) throw IllegalStateException("The answer is too large.")
                        output.write(buffer, 0, count)
                    }
                }
                AiHttpResponse(status, output.toString(Charsets.UTF_8.name()))
            } catch (error: Exception) {
                if (timedOut.get()) throw SocketTimeoutException("The AI service took too long.")
                throw error
            } finally {
                timer.cancel(false)
                connection.disconnect()
            }
        } } finally { watcher.cancel() }
    }
}

/** A file of a note that can go along to the AI service: kind and type from AiParts.fileKind, size -1 when not known. */
data class AiFileRef(val name: String, val kind: String, val mime: String, val uri: Uri, val size: Long)

/**
 * Ask JotDrop version 2: the files of a note, read only when the user points at one. A recording or PDF goes as it
 * is, within the limit of its kind; a photo is made small first (long side at most 2048 pixels, JPEG on white).
 * No log lines with file names or contents.
 */
object AiFiles {
    private const val MIB = 1024L * 1024L

    /** The files the note embeds that can go along; a drawing, another note, or a file that is gone falls away. */
    fun of(context: Context, noteText: String, spaceId: String?): List<AiFileRef> =
        Storage.findEmbeddedAttachmentBasenames(noteText).distinct().mapNotNull { name ->
            val (kind, mime) = AiParts.fileKind(name) ?: return@mapNotNull null
            val uri = Storage.findAttachmentUri(context, name, spaceId) ?: return@mapNotNull null
            AiFileRef(name, kind, mime, uri, Storage.attachmentSize(uri).takeIf { it >= 0 } ?: Storage.fileSize(context, uri))
        }

    /** The file as a part for the request. Throws AiError: too_large, or bad_request when it cannot be read. */
    suspend fun part(context: Context, ref: AiFileRef): AiPart = withContext(Dispatchers.IO) {
        if (ref.kind == "image") return@withContext AiPart("image", "image/jpeg", ref.name.substringBeforeLast('.') + ".jpg", photo(context, ref.uri))
        val limit = AiParts.LIMITS.getValue(ref.kind)
        val bytes = Storage.readAttachmentBytes(context, ref.uri, limit).getOrElse { error ->
            if (error is Storage.FileTooLargeException) throw AiError("too_large", "${AiParts.label(ref.name)} is larger than ${limit / MIB} MiB.")
            throw AiError("bad_request", "${AiParts.label(ref.name)} could not be read.")
        }
        AiPart(ref.kind, ref.mime, ref.name, bytes)
    }

    private const val LONG_SIDE = 2048

    /**
     * A photo made small, as JPEG bytes: decoded at a power of two that keeps the long side at 2048 or more, turned
     * the way its EXIF says, drawn on white (JPEG has no transparency) at AiParts.photoSize, then quality 85, 70 or
     * 50 until it is at most 4 MiB.
     */
    fun photo(context: Context, uri: Uri): ByteArray {
        val resolver = context.contentResolver
        val unreadable = AiError("bad_request", "Android cannot read this photo.")
        val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { android.graphics.BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw unreadable
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= LONG_SIDE) sample *= 2
        val decoded = try {
            resolver.openInputStream(uri)?.use { android.graphics.BitmapFactory.decodeStream(it, null, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample }) }
        } catch (_: OutOfMemoryError) { null } ?: throw unreadable
        val orientation = runCatching {
            resolver.openInputStream(uri)?.use { android.media.ExifInterface(it).getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, android.media.ExifInterface.ORIENTATION_NORMAL) }
        }.getOrNull() ?: android.media.ExifInterface.ORIENTATION_NORMAL
        val turned = try {
            turn(decoded, orientation)
        } catch (error: OutOfMemoryError) { decoded.recycle(); throw unreadable }
        val (width, height) = AiParts.photoSize(turned.width, turned.height)
        val small = try {
            android.graphics.Bitmap.createBitmap(width, height, android.graphics.Bitmap.Config.ARGB_8888).also { out ->
                android.graphics.Canvas(out).apply {
                    drawColor(android.graphics.Color.WHITE)
                    drawBitmap(turned, null, android.graphics.Rect(0, 0, width, height), android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG))
                }
            }
        } catch (_: OutOfMemoryError) { throw unreadable } finally { turned.recycle() }
        try {
            val limit = AiParts.LIMITS.getValue("image")
            for (quality in listOf(85, 70, 50)) {
                val bytes = ByteArrayOutputStream().also { small.compress(android.graphics.Bitmap.CompressFormat.JPEG, quality, it) }.toByteArray()
                if (bytes.size <= limit) return bytes
            }
        } finally { small.recycle() }
        throw AiError("too_large", "This photo is larger than 4 MiB, even made small.")
    }

    // The EXIF orientations as a turn and a mirror; the original bitmap is given back when nothing changes.
    private fun turn(bitmap: android.graphics.Bitmap, orientation: Int): android.graphics.Bitmap {
        val matrix = android.graphics.Matrix()
        when (orientation) {
            android.media.ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
            android.media.ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
            android.media.ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
            android.media.ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
            android.media.ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
            android.media.ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.setRotate(-90f); matrix.postScale(-1f, 1f) }
            android.media.ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(-90f)
            else -> return bitmap
        }
        val turned = android.graphics.Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        if (turned !== bitmap) bitmap.recycle()
        return turned
    }
}

/** The shared tool list and prompt, from the app's assets (copied there from cloud/shared/ai by the build). */
object AiAssets {
    @Volatile private var cache: Pair<List<AiTool>, String>? = null
    fun get(context: Context): Pair<List<AiTool>, String> = cache ?: synchronized(this) {
        cache ?: Pair(AiTools.load(context.assets.open("ai/tools.json").use { it.readBytes().toString(Charsets.UTF_8) }),
            context.assets.open("ai/prompt.json").use { it.readBytes().toString(Charsets.UTF_8) }).also { cache = it }
    }
}

/**
 * The notes on this phone as Ask JotDrop reads them, and the changes it asks for, saved through Storage like any
 * edit (so they sync encrypted like any other). Ids are short (n1, n2, ...) and stay on this phone with the note's
 * place; the AI service never sees a file path.
 */
class AiExecutor(private val context: Context, private val open: (Uri) -> Unit) {
    private val uris = LinkedHashMap<String, Uri>()
    // The other way round, by the Uri's text: a card's Uri finds its note whatever Uri object it came in.
    private val ids = HashMap<String, String>()
    var notes: List<AiNote> = emptyList(); private set
    var labels: List<String> = emptyList(); private set
    /** For the log line: how many notes came from the preview cache, and how long listing took. Counts and times only. */
    var fromCache = 0; private set
    var listMs = 0L; private set

    private fun iso() = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
    private fun linked(uri: Uri) = runCatching { CloudSyncManager.listLinksOf(context, uri).isNotEmpty() }.getOrDefault(false)

    // A note made in this conversation gets the next free number, also when a note in between could not be read.
    private var next = 0
    private fun remember(index: Int, uri: Uri): String = "n${index + 1}".also { uris[it] = uri; ids[uri.toString()] = it; next = maxOf(next, index + 1) }

    /**
     * Notes and Archive, not the bin. Most texts come from the preview cache the note list keeps (same time and
     * size); the others are read four at a time.
     */
    suspend fun load() = withContext(Dispatchers.IO) {
        val started = android.os.SystemClock.elapsedRealtime()
        val summaries = Storage.listNotesForAsk(context).getOrDefault(emptyList())
        listMs = android.os.SystemClock.elapsedRealtime() - started
        val iso = iso()
        val cached = java.util.concurrent.atomic.AtomicInteger()
        val texts = coroutineScope {
            summaries.map { summary -> async(READERS) {
                Storage.cachedNoteText(context, summary)?.also { cached.incrementAndGet() } ?: Storage.readNote(context, summary.uri).getOrNull()
            } }.awaitAll()
        }
        uris.clear(); ids.clear(); next = summaries.size
        notes = summaries.zip(texts).mapIndexedNotNull { index, (summary, text) ->
            if (text == null) return@mapIndexedNotNull null
            val id = remember(index, summary.uri)
            AiNote(id, summary.title, AiNoteEdits.splitNote(text).body, summary.meta.labels, iso.format(Date(summary.lastModified)), summary.space != null || linked(summary.uri),
                summary.meta.reminder, summary.meta.expires)
        }
        fromCache = cached.get()
        labels = Storage.getLabels(context)
    }

    /** Only the note a card asks about ("Summarize with AI"): one file, not the whole vault. */
    suspend fun loadOne(uri: Uri, shared: Boolean) {
        val (summary, text) = withContext(Dispatchers.IO) {
            val summary = Storage.noteSummary(context, uri)
            summary to summary?.let { Storage.readNote(context, uri).getOrNull() }
        }
        uris.clear(); ids.clear(); next = 1
        notes = if (summary == null || text == null) emptyList()
            else listOf(AiNote(remember(0, uri), summary.title, AiNoteEdits.splitNote(text).body, summary.meta.labels, iso().format(Date(summary.lastModified)), shared || linked(uri),
                summary.meta.reminder, summary.meta.expires))
        labels = withContext(Dispatchers.IO) { Storage.getLabels(context) }
    }

    fun uriOf(id: String): Uri? = uris[id]

    /** The id of a note by its Uri (a card's), or null when that note was not read. */
    fun idOf(uri: Uri): String? = ids[uri.toString()]

    private fun uri(input: Map<String, Any?>) = requireNotNull(uris[input["id"] as String]) { "There is no note with this id." }

    private suspend fun change(input: Map<String, Any?>, edit: (String) -> String) = Storage.noteWriteMutex.withLock {
        withContext(Dispatchers.IO) {
            val uri = uri(input)
            Storage.updateNote(context, uri, edit(Storage.readNote(context, uri).getOrThrow())).getOrThrow()
        }
    }

    @Suppress("UNCHECKED_CAST")
    val tools: Map<String, suspend (Map<String, Any?>) -> Any?> = mapOf(
        "create_note" to { input ->
            val label = input["label"] as? String
            val body = AiNoteEdits.newNoteBody(input["title"] as String, input["text"] as? String, input["items"] as? List<String>)
            val content = FrontmatterWriter.apply(body, NoteMeta(color = NoteColor.fromKey(input["color"] as? String)), listOfNotNull(label))
            val uri = Storage.noteWriteMutex.withLock { withContext(Dispatchers.IO) { Storage.createNote(context, content).getOrThrow().second } }
            val id = remember(next, uri)
            mapOf("id" to id, "title" to input["title"])
        },
        "append_to_note" to { input -> change(input) { AiNoteEdits.appendedText(it, input["text"] as? String, input["items"] as? List<String>) }; "Done." },
        "replace_note_text" to { input -> change(input) { AiNoteEdits.replacedText(it, input["text"] as String) }; "Done." },
        "set_labels" to { input ->
            val wanted = AiNoteEdits.cleanLabels(input["labels"] as List<String>)
            require(wanted.all(LabelNames::validate)) { "That label name is not allowed." }
            val known = Storage.getLabels(context)
            for (label in wanted) if (known.none { it.equals(label, true) }) Storage.addLabel(context, label).getOrThrow()
            val uri = uri(input)
            val current = withContext(Dispatchers.IO) { FrontmatterParser.parse(Storage.readNote(context, uri).getOrThrow()).meta.labels }
            withContext(Dispatchers.IO) { Storage.updateLabels(context, uri, wanted.toSet(), current.filter { old -> wanted.none { it.equals(old, true) } }.toSet()).getOrThrow() }
            "Done."
        },
        "set_reminder" to { input ->
            val at = input["at"] as String
            change(input) { text -> FrontmatterWriter.apply(text, FrontmatterParser.parse(text).meta.copy(reminder = at, reminderRepeat = null, reminderUntil = null, reminderLimit = null, reminderDone = 0)) }
            if (ReminderScheduler.schedule(context, uri(input), at)) "Done." else "Saved, but the time is in the past or this phone does not allow reminders, so it will not ring."
        },
        "set_expiry" to { input ->
            val uri = uri(input)
            val date = requireNotNull(PaperDrawer.validExpires(input["date"] as String)) { "That is not a valid date." }
            val drawer = (input["drawer"] as? String)?.trim().orEmpty()
            val meta = withContext(Dispatchers.IO) { FrontmatterParser.parse(Storage.readNote(context, uri).getOrThrow()).meta }
            // Like the web app: the usual warning a week before, unless the note already has a reminder.
            val reminder = withContext(Dispatchers.IO) { Storage.setExpires(context, uri, date, if (meta.reminder == null) PaperDrawer.DEFAULT_WARN else null).getOrThrow() }
            if (drawer.isNotEmpty()) {
                val labels = withContext(Dispatchers.IO) { FrontmatterParser.parse(Storage.readNote(context, uri).getOrThrow()).meta.labels }
                val target = PaperDrawer.drawerLabel(drawer)
                withContext(Dispatchers.IO) { Storage.updateLabels(context, uri, setOf(target), labels.filter { PaperDrawer.isPaperDrawer(it) && !it.equals(target, true) }.toSet()).getOrThrow() }
            }
            if (reminder != null) ReminderScheduler.schedule(context, uri, reminder)
            "Done."
        },
        "open_note" to { input -> open(uri(input)); "Opened." },
    )
}

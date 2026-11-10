package com.diexar.keepcapture

import android.content.Context
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import kotlinx.coroutines.CoroutineStart
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

/** What the user chose in Settings. The key stays on this phone; it is not synced and not in a backup. */
data class AiSettings(val provider: String = "", val key: String = "", val model: String = "", val baseUrl: String = "", val includeShared: Boolean = false) {
    val on get() = provider.isNotEmpty()
    fun config() = AiConfig(provider, key, model, baseUrl)
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
        AiSettings(provider, if (spec.needsKey || provider == "custom") stored.str("key").orEmpty().trim() else "", stored.str("model").orEmpty().trim(),
            if (provider == "custom") stored.str("baseUrl").orEmpty().trim() else "", stored["includeShared"] == true)
    }

    fun save(settings: AiSettings) = synchronized(lock) {
        val json = AiJson.stringify(linkedMapOf("provider" to settings.provider, "key" to settings.key.trim(), "model" to settings.model.trim(),
            "baseUrl" to settings.baseUrl.trim(), "includeShared" to settings.includeShared))
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
                request.body?.toByteArray(Charsets.UTF_8)?.let { bytes ->
                    connection.doOutput = true
                    connection.setFixedLengthStreamingMode(bytes.size)
                    connection.outputStream.use { it.write(bytes) }
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
    var notes: List<AiNote> = emptyList(); private set
    var labels: List<String> = emptyList(); private set

    /** Notes and Archive, not the bin. Call on IO. */
    fun load() {
        val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        val summaries = Storage.listNotes(context, NoteFolder.NOTES).getOrDefault(emptyList()) + Storage.listNotes(context, NoteFolder.ARCHIVE).getOrDefault(emptyList())
        uris.clear()
        notes = summaries.mapIndexedNotNull { index, summary ->
            val text = Storage.readNote(context, summary.uri).getOrNull() ?: return@mapIndexedNotNull null
            val id = "n${index + 1}"
            uris[id] = summary.uri
            val shared = summary.space != null || runCatching { CloudSyncManager.listLinksOf(context, summary.uri).isNotEmpty() }.getOrDefault(false)
            AiNote(id, summary.title, AiNoteEdits.splitNote(text).body, summary.meta.labels, iso.format(Date(summary.lastModified)), shared)
        }
        labels = Storage.getLabels(context)
    }

    fun uriOf(id: String): Uri? = uris[id]

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
            val id = "n${uris.size + 1}"
            uris[id] = uri
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

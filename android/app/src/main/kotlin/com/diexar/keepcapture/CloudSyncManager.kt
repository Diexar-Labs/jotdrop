package com.diexar.keepcapture

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

data class CloudSyncStatus(val connected: Boolean, val enabled: Boolean, val server: String, val vaultId: String,
    val localVault: String?, val lastSynced: String?, val message: String, val conflicts: Int, val oldUpload: Boolean = false, val conflictPaths: List<String> = emptyList())
class CloudSyncException(message: String) : Exception(message)
/** A cloud file without its content, for the Files tab. */
data class CloudListedFile(val id: String, val path: String, val revision: Int, val deleted: Boolean)

object CloudSyncManager {
    private val mutex = Mutex()
    private val pauseRequested = AtomicBoolean(false)
    private val editors = mutableMapOf<String, Int>()
    private val changed = MutableStateFlow(0L)
    val changes = changed.asStateFlow()
    private val uploaded = MutableStateFlow(emptySet<String>())
    /** Cloud paths the last sync stored, for the "Sealed" stamp on a new card. */
    val lastUploaded = uploaded.asStateFlow()
    private val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
    private const val PERIODIC = "jotdrop-cloud-periodic"
    private const val IMMEDIATE = "jotdrop-cloud-now"
    private const val OLD_UPLOAD = "An unfinished encrypted upload from a previously chosen local vault is waiting. Tap \"Keep old upload as a local copy\" first; nothing is lost."

    private fun document(uri: Uri): String = DocumentsContract.getDocumentId(uri)
    fun openEditor(uri: Uri) = synchronized(editors) { val id = document(uri); editors[id] = (editors[id] ?: 0) + 1 }
    fun closeEditor(uri: Uri) = synchronized(editors) { val id = document(uri); if ((editors[id] ?: 0) <= 1) editors.remove(id) else editors[id] = editors.getValue(id) - 1 }
    fun isEditing(uri: Uri): Boolean = synchronized(editors) { editors.containsKey(document(uri)) }

    fun client(context: Context): CloudClient? = CloudPreviewStore(context).credentials()?.let(::CloudClient)

    /**
     * The plan's maximum per file from the last sync, so Attach file and Share to JotDrop refuse a file that would
     * never reach the cloud. Null when cloud sync is off or has not run yet: then the file is simply attached.
     */
    fun attachLimit(context: Context): Long? {
        val store = CloudPreviewStore(context)
        val settings = store.settings()
        if (!settings.optBoolean("enabled") || store.credentials() == null) return null
        return settings.optLong("maxFileBytes").takeIf { it > 0 }
    }

    fun status(context: Context): CloudSyncStatus {
        val store = CloudPreviewStore(context)
        val credentials = store.credentials()
        val settings = store.settings()
        return CloudSyncStatus(credentials != null, settings.optBoolean("enabled") && credentials != null,
            credentials?.url.orEmpty(), credentials?.vaultId.orEmpty(), Storage.getVaultUri(context)?.toString(),
            settings.optString("lastSynced").takeIf { it.isNotBlank() }, settings.optString("message", "Cloud sync is off. Local notes remain available."), settings.optInt("conflicts"),
            credentials != null && runCatching { oldUploadScopes(store, CloudClient(credentials), CloudVaultAdapter.binding(context)).isNotEmpty() }.getOrDefault(false),
            settings.optJSONArray("conflictPaths")?.let { paths -> List(paths.length()) { paths.getString(it) } }.orEmpty())
    }

    /** Uploads this device started for a previously chosen local vault; they block enabling and disconnecting. */
    private fun oldUploadScopes(store: CloudPreviewStore, client: CloudClient, binding: String?): Set<String> =
        store.uploadScopes(client.credentials.deviceId) - setOfNotNull(binding?.let { scope(client, it) })

    /** Keeps those uploads as local recovery copies in the current vault, so nothing is lost and sync can continue. */
    suspend fun recoverOldUploads(context: Context) = serialized {
        val store = CloudPreviewStore(context)
        val client = client(context) ?: throw CloudSyncException("Pair this device first")
        val adapter = try { CloudVaultAdapter(context, allowOtherSync = true) } catch (error: IllegalArgumentException) {
            throw CloudSyncException(error.message ?: "Choose a local vault in Settings first")
        } catch (error: IllegalStateException) {
            throw CloudSyncException(error.message ?: "Choose a local vault in Settings first")
        }
        for (scope in oldUploadScopes(store, client, adapter.binding)) {
            val prepared = store.upload(scope, client.credentials.deviceId) ?: continue
            val file = try { client.preparedManifest(prepared) } catch (_: Exception) {
                throw CloudSyncException("An old encrypted upload cannot be opened with this device's keys. It was kept.")
            }
            // A large v2 file is not inside its upload; it is still in that local vault.
            file.bytes?.let { adapter.recoverUpload(file.path, it) }
            // The server may have dropped the unfinished upload already; the local copy is what matters.
            try { client.discardWrite(prepared) } catch (_: Exception) {}
            store.clearUpload(scope, client.credentials.deviceId)
        }
        store.saveSettings(store.settings().put("message", "The old upload was saved as a .cloud-recovery copy in this vault. You can enable sync or disconnect now."))
        changed.value++
    }

    private suspend fun <T> serialized(block: suspend () -> T): T = withContext(Dispatchers.IO) { mutex.withLock { block() } }

    suspend fun connect(context: Context, pairingCode: String) = serialized {
        val store = CloudPreviewStore(context)
        check(store.credentials() == null) { "Disconnect the current workspace before pairing another one" }
        val claimed = try { CloudClient.claim(pairingCode.trim()) } catch (_: Exception) {
            throw CloudSyncException("Pairing failed. Check the HTTPS server and use a fresh, unused pairing code.")
        }
        store.saveCredentials(claimed.credentials)
        store.saveSettings(JSONObject().put("enabled", false).put("message", "Device paired. Enable sync only for a vault without another sync system."))
    }

    /** Saves a connection made by signing in, the same way as a claimed pairing code. */
    suspend fun connectAccount(context: Context, client: CloudClient) = serialized {
        val store = CloudPreviewStore(context)
        check(store.credentials() == null) { "Disconnect the current workspace before signing in to another one" }
        store.saveCredentials(client.credentials)
        store.saveSettings(JSONObject().put("enabled", false).put("message", "Signed in. Enable sync only for a vault without another sync system."))
        changed.value++
    }

    /** True when the synced note and attachment folders hold no files yet, so turning sync on can only bring files in. */
    suspend fun localFolderEmpty(context: Context): Boolean = serialized { runCatching { CloudVaultAdapter(context).list().isEmpty() }.getOrDefault(false) }

    suspend fun setEnabled(context: Context, enabled: Boolean) {
        if (!enabled) { pauseRequested.set(true); cancel(context) }
        serialized {
        val store = CloudPreviewStore(context)
        val settings = store.settings()
        if (enabled) {
            pauseRequested.set(false)
            val client = requireNotNull(client(context)) { "Pair this device first" }
            val adapter = try {
                CloudVaultAdapter(context).also { it.list() }
            } catch (error: IllegalStateException) {
                throw CloudSyncException(error.message ?: "Local vault validation failed; no files were changed.")
            } catch (error: IllegalArgumentException) {
                throw CloudSyncException(error.message ?: "Choose safe, non-overlapping local note and attachment folders.")
            }
            if (store.hasUploads(client.credentials.deviceId) && store.upload(scope(client, adapter.binding), client.credentials.deviceId) == null) {
                throw CloudSyncException(OLD_UPLOAD)
            }
            settings.put("binding", adapter.binding)
        }
        settings.put("enabled", enabled).put("message", if (enabled) "Ready to sync. Offline changes stay in your local vault until the next successful sync." else "Cloud sync paused. Local notes were kept.")
        store.saveSettings(settings)
        if (enabled) {
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.UPDATE,
                PeriodicWorkRequestBuilder<CloudSyncWorker>(15, TimeUnit.MINUTES).setConstraints(network).build())
            request(context)
        } else cancel(context)
        }
    }

    /** A note changed outside the open screens, such as a tick on the home screen. */
    fun notifyNotesChanged() { changed.value++ }

    fun request(context: Context) {
        try {
            WorkManager.getInstance(context).enqueueUniqueWork(IMMEDIATE, ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<CloudSyncWorker>().setConstraints(network).build())
        } catch (_: Exception) {
            // Scheduling must never turn an already saved/moved note into a failed storage write.
            Log.w("JotDropCloud", "Could not schedule cloud sync; manual and periodic sync remain available")
        }
    }

    private fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
        WorkManager.getInstance(context).cancelUniqueWork(IMMEDIATE)
    }

    suspend fun disconnect(context: Context, message: String = "Disconnected. Local notes, conflicts and recovery copies were kept.") {
        pauseRequested.set(true)
        cancel(context)
        serialized {
        val store = CloudPreviewStore(context)
        val client = client(context)
        if (client != null && store.hasUploads(client.credentials.deviceId)) {
            val adapter = CloudVaultAdapter(context)
            val scope = scope(client, adapter.binding)
            val prepared = store.upload(scope, client.credentials.deviceId) ?: throw CloudSyncException(OLD_UPLOAD)
            val file = client.preparedManifest(prepared)
            // A large v2 file is not inside its upload; it is still in this vault.
            file.bytes?.let { adapter.recoverUpload(file.path, it) }
            store.clearUpload(scope, client.credentials.deviceId)
            if (store.hasUploads(client.credentials.deviceId)) throw CloudSyncException(OLD_UPLOAD)
        }
        val settings = store.settings().put("enabled", false).put("message", message)
        store.saveSettings(settings)
        store.disconnect()
        cancel(context)
        }
    }

    private fun scope(client: CloudClient, binding: String): String = CloudSyncEngine.hash((client.credentials.url + "\n" + client.credentials.vaultId + "\n" + client.credentials.vaultKey + "\n" + binding).toByteArray(Charsets.UTF_8))

    // The cloud index belongs to the cloud, not to a local folder: the sync and the Files tab share it.
    private fun indexScope(client: CloudClient): String = scope(client, "\u0000cloud index")
    private fun loadIndex(store: CloudPreviewStore, client: CloudClient): CloudRemoteIndex {
        val json = store.syncState(indexScope(client)) ?: return CloudRemoteIndex()
        val index = CloudRemoteIndex(json.getLong("cursor"))
        val objects = json.getJSONObject("objects")
        for (id in objects.keys()) objects.getJSONObject(id).let { index.objects[id] = CloudIndexedFile(it.getString("path"), it.getInt("revision"), it.getBoolean("deleted"), it.getString("hash"), it.optBoolean("bad")) }
        val pending = json.getJSONObject("pending")
        for (id in pending.keys()) index.pending[id] = pending.getInt(id)
        return index
    }
    private fun saveIndex(store: CloudPreviewStore, client: CloudClient, index: CloudRemoteIndex) {
        val objects = JSONObject()
        for ((id, file) in index.objects) objects.put(id, JSONObject().put("path", file.path).put("revision", file.revision).put("deleted", file.deleted).put("hash", file.hash).apply { if (file.bad) put("bad", true) })
        val pending = JSONObject()
        for ((id, revision) in index.pending) pending.put(id, revision)
        store.saveSyncState(indexScope(client), JSONObject().put("cursor", index.cursor).put("objects", objects).put("pending", pending))
    }
    // Each local file's hash by size and time, so a sync reads only changed files; losing it only costs one full read.
    private fun loadSeen(store: CloudPreviewStore, scope: String): MutableMap<String, CloudSeenFile> {
        val json = store.syncState("$scope-seen") ?: return mutableMapOf()
        return json.keys().asSequence().associateWithTo(mutableMapOf()) { path -> json.getJSONObject(path).let { CloudSeenFile(it.getLong("size"), it.getLong("modified"), it.getString("hash")) } }
    }
    private fun saveSeen(store: CloudPreviewStore, scope: String, seen: Map<String, CloudSeenFile>) {
        val json = JSONObject()
        for ((path, file) in seen) json.put(path, JSONObject().put("size", file.size).put("modified", file.modified).put("hash", file.hash))
        store.saveSyncState("$scope-seen", json)
    }

    /** The cloud's files without their content, from the index the sync keeps: only new changes are read. */
    suspend fun cloudFiles(context: Context): List<CloudListedFile> = serialized {
        val coroutine = currentCoroutineContext()
        val store = CloudPreviewStore(context)
        val client = client(context) ?: throw CloudSyncException("Pair this device first")
        val index = loadIndex(store, client)
        CloudSyncEngine.remoteFiles(index, client::changes, client::manifestOrNull, client::readPieces, { coroutine.ensureActive() }, { saveIndex(store, client, index) })
        index.objects.map { (id, file) -> CloudListedFile(id, file.path, file.revision, file.deleted) }
    }

    /** [source]: the file just prepared. After a restart, the local file finishes a large v2 upload if it is still the same. */
    private fun finishUpload(store: CloudPreviewStore, scope: String, client: CloudClient, state: JSONObject, checkActive: () -> Unit,
        source: ByteArray? = null, local: (String) -> ByteArray = { error("No local file") }, holder: String = client.credentials.deviceId): CloudSyncObject? {
        val prepared = store.upload(scope, holder) ?: return null
        val file = client.preparedManifest(prepared)
        val bytes = file.bytes ?: source ?: runCatching { local(file.path) }.getOrNull()?.takeIf { CloudSyncEngine.hash(it) == file.hash }
        val revision = try { client.commitWrite(prepared, bytes, checkActive) } catch (_: CloudSourceMissingException) {
            // Changed since: the cloud did not get it, and the file here is newer; the sync takes it from here.
            store.clearUpload(scope, holder)
            return null
        }
        val saved = CloudSyncObject(file.path, bytes ?: ByteArray(0), revision, hash = file.hash)
        val tracked = JSONObject((state.optJSONObject("tracked") ?: JSONObject()).toString())
        val previous = tracked.optJSONObject(saved.path)
        if (previous == null || previous.getInt("revision") < saved.revision) {
            tracked.put(saved.path, JSONObject().put("revision", saved.revision).put("hash", saved.hash).put("deleted", false))
        } else if (previous.getInt("revision") == saved.revision) {
            check(!previous.getBoolean("deleted") && previous.getString("hash") == saved.hash) { "Upload receipt differs from the saved baseline" }
        }
        // The baseline must survive a restart before the exact encrypted snapshot may be removed.
        val next = JSONObject(state.toString()).put("tracked", tracked)
        store.saveSyncState(scope, next)
        state.put("tracked", tracked)
        store.clearUpload(scope, holder)
        return saved
    }

    private fun writeUpload(store: CloudPreviewStore, scope: String, client: CloudClient, state: JSONObject,
        path: String, bytes: ByteArray, baseRevision: Int, checkActive: () -> Unit, holder: String = client.credentials.deviceId): CloudSyncObject {
        checkActive()
        check(store.upload(scope, holder) == null) { "Resume the previous encrypted upload before saving another file" }
        store.saveUpload(scope, holder, client.prepareWrite(path, bytes, baseRevision))
        return requireNotNull(finishUpload(store, scope, client, state, checkActive, bytes, holder = holder))
    }

    suspend fun resolve(context: Context, path: String, keepLocal: Boolean) {
        serialized {
            CloudSyncEngine.path(path)
            val store = CloudPreviewStore(context)
            val settings = store.settings()
            check(settings.optBoolean("enabled")) { "Enable cloud sync before resolving conflicts" }
            val client = requireNotNull(client(context))
            val initial = CloudVaultAdapter(context)
            check(settings.optString("binding") == initial.binding) { "Local vault settings changed" }
            val scope = scope(client, initial.binding)
            val state = store.syncState(scope) ?: JSONObject()
            check(!state.has("pending")) { "Recover the interrupted local write before resolving conflicts" }
            check(store.upload(scope, client.credentials.deviceId) == null) { "Run sync to resume or recover the interrupted encrypted upload before resolving conflicts" }
            val coroutine = currentCoroutineContext()
            val checkActive = {
                coroutine.ensureActive()
                check(!pauseRequested.get()) { "Cloud sync paused. Local files and encrypted uploads were kept." }
                initial.validateBinding()
            }
            val adapter = CloudVaultAdapter(context, { name, original, replacement ->
                state.put("pending", JSONObject().put("path", name).put("original", original.orEmpty()).put("replacement", replacement.orEmpty()))
                store.saveSyncState(scope, state)
            }, { state.remove("pending"); store.saveSyncState(scope, state) })
            val bytes = if (path in adapter.list()) adapter.read(path) else null
            val remote = client.read(CloudCrypto.objectId(client.credentials.vaultKey, path))
            if (keepLocal) {
                if (bytes == null) { if (!remote.deleted) client.remove(remote.id, remote.revision) }
                else if (remote.deleted || !bytes.contentEquals(remote.bytes)) writeUpload(store, scope, client, state, path, bytes, remote.revision, checkActive)
            } else {
                if (!adapter.compareAndSet(path, bytes, if (remote.deleted) null else remote.bytes)) throw CloudSyncException("The local file changed or is open in an editor. Close it and compare again")
            }
        }
        sync(context)
    }

    /**
     * Mail to JotDrop: opens waiting sealed mail with the key derived from the vault key, writes the note and its
     * attachments as local files for the normal sync to upload, and deletes an item only once every file of it is
     * confirmed in the cloud (present in the engine's tracked state). One bad mail never stops the sync.
     */
    private fun convertMail(client: CloudClient, adapter: CloudVaultAdapter, mail: JSONObject?, tracked: Map<String, CloudSyncBase>, checkActive: () -> Unit): Int {
        if (mail == null || !mail.optBoolean("enabled") || mail.optInt("pending") == 0) return 0
        val scalar = try { CloudMail.derivedScalar(client.credentials.vaultKey) } catch (error: Exception) { return 0 }
        val publicKey = mail.optString("publicKey")
        if (CloudMail.publicKey(scalar) != publicKey) {
            Log.w("JotDropCloud", "The mail key on the server does not match this vault; mail stays sealed")
            return 0
        }
        val items = try { client.call("/mail").getJSONArray("items") } catch (error: Exception) { return 0 }
        var saved = 0
        for (index in 0 until minOf(items.length(), 25)) {
            checkActive()
            try {
                val item = items.getJSONObject(index)
                val id = item.getString("id")
                require(id.matches(Regex("[0-9a-f-]{36}"))) { "Invalid mail item" }
                val uploaded = { path: String -> tracked[path]?.deleted == false }
                val detail = client.call("/mail/$id")
                val key = CloudMail.mailKey(scalar, publicKey, detail.getString("ephemeralKey"), id)
                val payload = JSONObject(String(CloudMail.openBody(key, client.credentials.vaultId, id, detail.getString("body")), Charsets.UTF_8))
                val attachments = payload.optJSONArray("attachments") ?: JSONArray()
                val names = (0 until attachments.length()).map { attachments.optJSONObject(it)?.optString("name") }
                val note = CloudMail.noteFor(payload.optString("subject"), payload.optString("from"), payload.optString("date"), payload.optString("text"), names, id, item.getString("receivedAt"))
                val paths = mutableListOf(note.path)
                note.attachments.forEachIndexed { n, name ->
                    val path = "attachments/$name"
                    paths += path
                    if (uploaded(path)) return@forEachIndexed
                    val sealed = client.call("/mail/$id/parts/$n").getString("sealed")
                    adapter.compareAndSet(path, null, CloudMail.openPart(key, client.credentials.vaultId, id, n, sealed))
                }
                if (!uploaded(note.path) && adapter.compareAndSet(note.path, null, note.content.toByteArray(Charsets.UTF_8))) saved++
                if (paths.all(uploaded)) client.call("/mail/$id", "DELETE")
            } catch (error: Exception) {
                if (error is CancellationException || error is CloudSyncException) throw error
                Log.i("JotDropCloud", "A waiting mail stays sealed for a later try: ${error.javaClass.simpleName}")
            }
        }
        return saved
    }

    /**
     * Every shared space in its own folder, with its own state. Nothing here may stop the own vault's sync: a 401 means
     * this space, not this device, and a member's bad file is left out. Runs inside the sync's lock.
     */
    private fun syncSpaces(context: Context, store: CloudPreviewStore, client: CloudClient, checkActive: () -> Unit) {
        val known = store.spaces()
        val items = try { CloudSpaces.list(client) } catch (error: Exception) {
            // No account on this cloud has no spaces; anything else leaves what is known as it is.
            Log.i("JotDropCloud", "Shared spaces not read: ${error.javaClass.simpleName}")
            return
        }
        val listed = items.map { it.id }.toSet()
        for (item in items) {
            checkActive()
            try {
                val saved = known.optJSONObject(item.id)
                // Who is in it can change without a new note, so this is asked on every sync.
                val details = CloudSpaces.details(client, item.id)
                val savedKey = saved?.optString("key")?.takeIf { it.isNotEmpty() }
                val key = details.key ?: savedKey
                // Nothing to open yet, or read-only and not on this phone: put aside here, or replaced before this phone
                // had it. It is remembered without a key, so it stays out of sight and the 30-second look stops asking.
                // A group someone can still take over does show on a phone that never had it.
                if (key == null || details.unfinished || (item.frozen && savedKey == null && (saved != null || !details.canTakeOver))) {
                    known.put(item.id, (saved ?: JSONObject()).put("frozen", item.frozen).put("sequence", item.sequence).put("gone", false))
                    store.saveSpaces(known)
                    continue
                }
                // Back after losing access: what was thrown away here meanwhile must not read as a deletion for everyone.
                if (saved?.optBoolean("gone") == true && !item.frozen) {
                    val scope = scope(CloudSpaces.files(client, item.id, key), CloudVaultAdapter(context, spaceId = item.id).binding)
                    store.syncState(scope)?.let { state -> state.remove("tracked"); store.saveSyncState(scope, state) }
                }
                val next = (saved ?: JSONObject()).put("key", key).put("frozen", item.frozen).put("replacedBy", item.replacedBy.orEmpty()).put("sequence", item.sequence).put("gone", false)
                next.put("name", details.name.orEmpty()).put("owner", details.owner).put("others", JSONArray(details.members.filter { it.accountId != details.accountId }.map { it.name ?: "Someone" }))
                known.put(item.id, next)
                store.saveSpaces(known)
                if (item.frozen) rescueUnsent(context, store, client, item.id, key, checkActive)
                else syncSpace(context, store, client, item.id, key, checkActive)
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                Log.w("JotDropCloud", "Shared space not synced: ${error.javaClass.simpleName}")
                val saved = known.optJSONObject(item.id)
                if (error is CloudRequestException && error.status == 401 && saved != null) { known.put(item.id, saved.put("gone", true)); store.saveSpaces(known) }
            }
        }
        // Not in the list any more: nothing is removed here without asking.
        for (id in known.keys().asSequence().toList()) if (id !in listed) known.optJSONObject(id)?.let { if (it.optString("key").isEmpty()) known.remove(id) else known.put(id, it.put("gone", true)) }
        store.saveSpaces(known)
        changed.value++
    }

    private fun syncSpace(context: Context, store: CloudPreviewStore, own: CloudClient, spaceId: String, spaceKey: String, checkActive: () -> Unit) {
        val client = CloudSpaces.files(own, spaceId, spaceKey)
        val initial = CloudVaultAdapter(context, spaceId = spaceId)
        val scope = scope(client, initial.binding)
        val state = store.syncState(scope) ?: JSONObject()
        val active = { checkActive(); initial.validateBinding() }
        // The folder itself is gone, whatever took it. That says nothing about the notes: starting over brings them back,
        // while reading it as deletions would remove them for everyone.
        if (!initial.hasFolder() && (state.has("tracked") || state.has("pending"))) {
            state.remove("tracked")
            state.remove("pending")
            store.saveSyncState(scope, state)
        }
        state.optJSONObject("pending")?.let { pending ->
            check(synchronized(Storage.cloudFileLock) { initial.verifyPending(pending.getString("path"), pending.optString("original").takeIf { it.isNotEmpty() }, pending.optString("replacement").takeIf { it.isNotEmpty() }) }) { "An interrupted local write in a shared space needs recovery." }
            state.remove("pending")
            store.saveSyncState(scope, state)
        }
        try { finishUpload(store, scope, client, state, active, local = initial::read, holder = spaceId) }
        catch (error: CloudRequestException) {
            if (error.status != 409) throw error
            val prepared = store.upload(scope, spaceId) ?: throw error
            val file = client.preparedManifest(prepared)
            (file.bytes ?: runCatching { initial.read(file.path) }.getOrNull()?.takeIf { CloudSyncEngine.hash(it) == file.hash })?.let { initial.recoverUpload(file.path, it) }
            store.clearUpload(scope, spaceId)
        }
        val adapter = CloudVaultAdapter(context, { path, original, replacement ->
            state.put("pending", JSONObject().put("path", path).put("original", original.orEmpty()).put("replacement", replacement.orEmpty()))
            store.saveSyncState(scope, state)
        }, { state.remove("pending"); store.saveSyncState(scope, state) }, spaceId = spaceId)
        val tracked = mutableMapOf<String, CloudSyncBase>()
        val baseline = state.optJSONObject("tracked") ?: JSONObject()
        for (name in baseline.keys()) baseline.getJSONObject(name).let { tracked[name] = CloudSyncBase(it.getInt("revision"), it.getString("hash"), it.getBoolean("deleted")) }
        val index = loadIndex(store, client)
        val seen = loadSeen(store, scope)
        val maxFileBytes = minOf(client.maxFileBytes(), Runtime.getRuntime().maxMemory() / 4)
        // A file that does not open under the key, or a note where the attachments are, is someone else's mistake or malice.
        val manifest = { id: String -> try { client.manifestOrNull(id) } catch (error: Exception) { if (error is CloudRequestException || error is java.io.IOException) throw error else throw CloudBadFile() } }
        val remote = object : CloudSyncRemote {
            override fun list(): List<CloudSyncEntry> = CloudSyncEngine.remoteFiles(index, client::changes, manifest, client::readPieces, active, { saveIndex(store, client, index) }, skipBad = { it.startsWith("notes/attachments/") })
            override fun write(path: String, bytes: ByteArray, baseRevision: Int): CloudSyncObject {
                checkActive()
                val saved = writeUpload(store, scope, client, state, path, bytes, baseRevision, active, holder = spaceId)
                index.objects[CloudCrypto.objectId(client.credentials.vaultKey, path)] = CloudIndexedFile(path, saved.revision, false, CloudSyncEngine.hash(bytes))
                return saved
            }
            override fun delete(path: String, baseRevision: Int): CloudSyncObject {
                checkActive()
                val id = CloudCrypto.objectId(client.credentials.vaultKey, path)
                val current = client.readManifest(id)
                check(current.revision == baseRevision) { "Cloud changed during sync. Retry to compare both versions" }
                val deleted = CloudSyncObject(path, ByteArray(0), client.remove(id, baseRevision), true, current.hash)
                index.objects[id] = CloudIndexedFile(path, deleted.revision, true, current.hash)
                return deleted
            }
            override fun base(path: String, revision: Int): ByteArray? {
                checkActive()
                return try { client.read(CloudCrypto.objectId(client.credentials.vaultKey, path), revision).bytes }
                catch (error: Exception) { if (error is CloudRequestException && error.status !in 400..499 || error is java.io.IOException) throw error else null }
            }
        }
        try {
            CloudSyncEngine.sync(remote, adapter, tracked, active, seen, maxFileBytes = maxFileBytes) { values ->
                val next = JSONObject()
                for ((path, base) in values) next.put(path, JSONObject().put("revision", base.revision).put("hash", base.hash).put("deleted", base.deleted))
                state.put("tracked", next)
                store.saveSyncState(scope, state)
                saveIndex(store, client, index)
            }
        } finally { runCatching { saveIndex(store, client, index); saveSeen(store, scope, seen) } }
    }

    /**
     * A read-only space takes nothing more. What differs from the last synced state is copied to the own notes as an
     * ordinary note, once per version; nothing in the space's folder is moved, so a space that comes back loses nothing.
     */
    private fun rescueUnsent(context: Context, store: CloudPreviewStore, own: CloudClient, spaceId: String, spaceKey: String, checkActive: () -> Unit) {
        val initial = CloudVaultAdapter(context, spaceId = spaceId)
        val scope = scope(CloudSpaces.files(own, spaceId, spaceKey), initial.binding)
        val state = store.syncState(scope) ?: JSONObject()
        val baseline = state.optJSONObject("tracked") ?: JSONObject()
        val rescued = state.optJSONObject("rescued") ?: JSONObject()
        val vault = CloudVaultAdapter(context)
        val mine = vault.list()
        for (path in initial.list().keys) {
            checkActive()
            val bytes = initial.read(path)
            val hash = CloudSyncEngine.hash(bytes)
            if (baseline.optJSONObject(path)?.takeIf { !it.optBoolean("deleted") }?.optString("hash") == hash || rescued.optString(path) == hash) continue
            val name = path.substringAfterLast('/')
            val wanted = if (path.startsWith("notes/")) "notes/Not sent - $name" else "attachments/$name"
            val free = generateSequence(1) { it + 1 }.map { copy -> if (copy == 1) wanted else wanted.substringBeforeLast('.') + " $copy." + wanted.substringAfterLast('.') }.first { it !in mine }
            check(vault.compareAndSet(free, null, bytes)) { "Could not save an unsent change. It is still in the shared folder." }
            rescued.put(path, hash)
            state.put("rescued", rescued)
            store.saveSyncState(scope, state)
        }
    }

    /**
     * Live list links, right after a sync of the own notes: what guests ticked or added goes into the note, and the
     * note's own changes go to the link. Only a note that is in the cloud as it is here takes part (clean, and not
     * open in an editor); one still on its way up waits for the next round. One link's failure never stops the sync.
     * Returns true when a note changed, so the caller uploads it.
     */
    private fun checkListLinks(client: CloudClient, adapter: CloudVaultAdapter, tracked: Map<String, CloudSyncBase>, checkActive: () -> Unit): Boolean {
        val links = try { CloudListLinks.list(client) } catch (error: Exception) {
            if (error is CancellationException) throw error
            Log.i("JotDropCloud", "List links not read: ${error.javaClass.simpleName}")
            return false
        }
        listed.value = links
        var changed = false
        for (link in links) {
            checkActive()
            try {
                val path = link.path ?: continue
                if (link.key == null) continue
                val base = tracked[path]?.takeIf { !it.deleted && it.revision >= 1 } ?: continue
                val bytes = runCatching { adapter.read(path) }.getOrNull() ?: continue
                if (CloudSyncEngine.hash(bytes) != base.hash) continue
                val text = String(bytes, Charsets.UTF_8)
                val parts = CloudListLinks.splitNote(text)
                val result = CloudListLinks.sync(client, link, parts.body, base.revision, parts.title)
                if (result.noteChanged && adapter.compareAndSet(path, bytes, (parts.head + result.text).toByteArray(Charsets.UTF_8))) changed = true
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                Log.w("JotDropCloud", "List link check failed: ${error.javaClass.simpleName}")
            }
        }
        return changed
    }

    private val listed = MutableStateFlow(emptyList<CloudListLinks.Link>())
    /** The live list links as the last sync or the share screen saw them, for the question before a note goes to the trash. */
    val listLinks = listed.asStateFlow()
    fun rememberListLinks(links: List<CloudListLinks.Link>) { listed.value = links }

    /** The live list links on a note, as last seen. */
    fun listLinksOf(context: Context, note: Uri): List<CloudListLinks.Link> {
        val path = CloudListLinks.cloudPath(context, note) ?: return emptyList()
        return listed.value.filter { it.path == path }
    }

    /** Ends these links: the page says the link has ended, and the note stays as it is. */
    suspend fun endListLinks(context: Context, links: List<CloudListLinks.Link>) = withContext(Dispatchers.IO) {
        val client = client(context) ?: throw CloudSyncException("Sign in to JotDrop Cloud first.")
        for (link in links) CloudListLinks.remove(client, link.id)
        listed.value = listed.value.filter { known -> links.none { it.id == known.id } }
    }

    /** The cloud path and uploaded version of a note that is in the cloud as it is now, or null while a change is still on its way up. */
    fun uploadedNote(context: Context, note: Uri, text: String): Pair<String, Int>? {
        val store = CloudPreviewStore(context)
        val client = client(context) ?: return null
        val binding = store.settings().optString("binding").takeIf { it.isNotEmpty() } ?: return null
        val path = CloudListLinks.cloudPath(context, note) ?: return null
        val tracked = store.syncState(scope(client, binding))?.optJSONObject("tracked")?.optJSONObject(path) ?: return null
        if (tracked.optBoolean("deleted") || tracked.optInt("revision") < 1 || tracked.optString("hash") != CloudSyncEngine.hash(text.toByteArray(Charsets.UTF_8))) return null
        return path to tracked.getInt("revision")
    }

    /** While this runs no sync touches a space's folder or the list of spaces. */
    internal suspend fun <T> exclusive(block: suspend () -> T): T = serialized(block)

    /** Inside [exclusive]. What differs from the last synced state goes to the own notes, before the folder is removed. */
    internal fun rescueSpace(context: Context, spaceId: String, spaceKey: String) {
        val client = client(context) ?: throw CloudSyncException("Pair this device first")
        rescueUnsent(context, CloudPreviewStore(context), client, spaceId, spaceKey) {}
    }

    /**
     * Inside [exclusive]. A space leaves this phone: its folder, kept as own notes or not, and everything remembered about
     * it. A baseline left behind would read the missing notes as deleted here, and delete them for everyone on coming back.
     * What stays is an entry without a key, so a read-only space the server still lists does not come back by itself.
     */
    internal fun dropSpace(context: Context, spaceId: String, spaceKey: String, keep: Boolean) {
        val store = CloudPreviewStore(context)
        val client = CloudSpaces.files(client(context) ?: throw CloudSyncException("Pair this device first"), spaceId, spaceKey)
        val scope = scope(client, CloudVaultAdapter(context, spaceId = spaceId).binding)
        store.clearSyncState(scope)
        store.clearSyncState("$scope-seen")
        store.clearSyncState(indexScope(client))
        store.clearUpload(scope, spaceId)
        Storage.releaseSpaceFolder(context, spaceId, keep).getOrThrow()
        val spaces = store.spaces()
        spaces.put(spaceId, JSONObject())
        store.saveSpaces(spaces)
        changed.value++
    }

    /** True when a shared space has something new, for a cheap look every 30 seconds while the app is open. */
    suspend fun spacesChanged(context: Context): Boolean = withContext(Dispatchers.IO) {
        if (!status(context).enabled) return@withContext false
        val store = CloudPreviewStore(context)
        val client = client(context) ?: return@withContext false
        val known = store.spaces()
        val items = runCatching { CloudSpaces.list(client) }.getOrNull() ?: return@withContext false
        items.any { item -> known.optJSONObject(item.id)?.let { it.optLong("sequence", -1) != item.sequence || it.optBoolean("frozen") != item.frozen || it.optBoolean("gone") } ?: true } ||
            known.keys().asSequence().any { id -> known.optJSONObject(id)?.optBoolean("gone") != true && items.none { it.id == id } }
    }

    suspend fun sync(context: Context) = serialized {
        val coroutine = currentCoroutineContext()
        val checkActive = {
            coroutine.ensureActive()
            if (pauseRequested.get()) throw CloudSyncException("Cloud sync paused. Completed operations and local files were kept.")
        }
        checkActive()
        val store = CloudPreviewStore(context)
        val settings = store.settings()
        if (!settings.optBoolean("enabled")) throw CloudSyncException("Enable cloud sync first")
        val client = client(context) ?: throw CloudSyncException("Pair this device first")
        val startedAt = System.nanoTime()
        var phase = CloudDiagnostics.Phase.VAULT_VALIDATION
        try {
            check(Storage.recoverInterruptedNoteWrite(context)) { Storage.interruptedSaveMessage(context) }
            val initial = CloudVaultAdapter(context)
            check(settings.optString("binding") == initial.binding) { "Vault settings changed. Pause and re-enable sync for the intended folder" }
            phase = CloudDiagnostics.Phase.STATE_LOAD
            val scope = scope(client, initial.binding)
            val state = store.syncState(scope) ?: JSONObject()
            val uploadActive = { checkActive(); initial.validateBinding() }
            check(!store.hasUploads(client.credentials.deviceId) || store.upload(scope, client.credentials.deviceId) != null) { OLD_UPLOAD }
            val pending = state.optJSONObject("pending")
            if (pending != null) {
                phase = CloudDiagnostics.Phase.RECOVERY
                check(synchronized(Storage.cloudFileLock) { initial.verifyPending(pending.getString("path"), pending.optString("original").takeIf { it.isNotEmpty() }, pending.optString("replacement").takeIf { it.isNotEmpty() }) }) {
                    "An interrupted local write needs recovery. Restore its .cloud-recovery copy, or remove a partial new file, before syncing again"
                }
                state.remove("pending")
                phase = CloudDiagnostics.Phase.STATE_SAVE
                store.saveSyncState(scope, state)
            }
            phase = CloudDiagnostics.Phase.REMOTE_WRITE
            try { finishUpload(store, scope, client, state, uploadActive, local = initial::read) }
            catch (error: CloudRequestException) {
                if (error.status != 409) throw error
                // A newer cloud revision wins. Preserve the sealed draft outside sync before discarding staging.
                uploadActive()
                val prepared = store.upload(scope, client.credentials.deviceId) ?: throw error
                val file = client.preparedManifest(prepared)
                phase = CloudDiagnostics.Phase.RECOVERY
                // A large v2 file is not inside its upload: the local file is that version while it is still the same.
                (file.bytes ?: runCatching { initial.read(file.path) }.getOrNull()?.takeIf { CloudSyncEngine.hash(it) == file.hash })
                    ?.let { initial.recoverUpload(file.path, it) }
                uploadActive()
                client.discardWrite(prepared)
                store.clearUpload(scope, client.credentials.deviceId)
            }
            phase = CloudDiagnostics.Phase.VAULT_VALIDATION
            val adapter = CloudVaultAdapter(context, { path, original, replacement ->
                phase = CloudDiagnostics.Phase.STATE_SAVE
                state.put("pending", JSONObject().put("path", path).put("original", original.orEmpty()).put("replacement", replacement.orEmpty()))
                store.saveSyncState(scope, state)
                phase = CloudDiagnostics.Phase.RECONCILE
            }, {
                phase = CloudDiagnostics.Phase.STATE_SAVE
                state.remove("pending")
                store.saveSyncState(scope, state)
                phase = CloudDiagnostics.Phase.RECONCILE
            })
            phase = CloudDiagnostics.Phase.STATE_LOAD
            val tracked = mutableMapOf<String, CloudSyncBase>()
            val baseline = state.optJSONObject("tracked") ?: JSONObject()
            for (name in baseline.keys()) {
                val value = baseline.getJSONObject(name)
                tracked[name] = CloudSyncBase(value.getInt("revision"), value.getString("hash"), value.getBoolean("deleted"))
            }
            val index = loadIndex(store, client)
            val seen = loadSeen(store, scope)
            phase = CloudDiagnostics.Phase.REMOTE_LIST
            // One status request: the plan's maximum per file and whether sealed mail waits (Mail to JotDrop).
            val cloudStatus = client.call("/status")
            // The plan's maximum per file, and no more than this device can hold a few times over while syncing it.
            val planMax = cloudStatus.optJSONObject("pieces")?.optLong("maxFileBytes")?.takeIf { it > 0 } ?: CloudCrypto.MAX_FILE_BYTES.toLong()
            // Kept for Attach file, which checks a file against it at once, also offline.
            if (settings.optLong("maxFileBytes") != planMax) store.saveSettings(settings.put("maxFileBytes", planMax))
            val maxFileBytes = minOf(planMax, Runtime.getRuntime().maxMemory() / 4)
            // A big first sync takes a while: show how far it is, once a second at most.
            var shownAt = 0L
            fun progress(label: String): (Int, Int) -> Unit = { done, total ->
                if (System.currentTimeMillis() - shownAt >= 1000) {
                    shownAt = System.currentTimeMillis()
                    store.saveSettings(settings.put("message", "$label $done / $total"))
                    changed.value++
                }
            }
            val remote = object : CloudSyncRemote {
                override fun list(): List<CloudSyncEntry> {
                    phase = CloudDiagnostics.Phase.REMOTE_LIST
                    val files = CloudSyncEngine.remoteFiles(index, client::changes, client::manifestOrNull, client::readPieces, uploadActive, { saveIndex(store, client, index) }, progress("Reading the cloud..."))
                    phase = CloudDiagnostics.Phase.RECONCILE
                    return files
                }
                override fun write(path: String, bytes: ByteArray, baseRevision: Int): CloudSyncObject {
                    checkActive()
                    phase = CloudDiagnostics.Phase.REMOTE_WRITE
                    val saved = writeUpload(store, scope, client, state, path, bytes, baseRevision, uploadActive)
                    // What this device wrote goes into its index, so the changes feed does not bring it back.
                    index.objects[CloudCrypto.objectId(client.credentials.vaultKey, path)] = CloudIndexedFile(path, saved.revision, false, CloudSyncEngine.hash(bytes))
                    phase = CloudDiagnostics.Phase.RECONCILE
                    return saved
                }
                override fun delete(path: String, baseRevision: Int): CloudSyncObject {
                    checkActive()
                    phase = CloudDiagnostics.Phase.REMOTE_DELETE
                    val id = CloudCrypto.objectId(client.credentials.vaultKey, path)
                    val current = client.readManifest(id)
                    check(current.revision == baseRevision) { "Cloud changed during sync. Retry to compare both versions" }
                    val deleted = CloudSyncObject(path, ByteArray(0), client.remove(id, baseRevision), true, current.hash)
                    index.objects[id] = CloudIndexedFile(path, deleted.revision, true, current.hash)
                    phase = CloudDiagnostics.Phase.RECONCILE
                    return deleted
                }
                // The version both devices last shared, to merge a note changed on both; a locked or cleared one gives null.
                override fun base(path: String, revision: Int): ByteArray? {
                    checkActive()
                    return try { client.read(CloudCrypto.objectId(client.credentials.vaultKey, path), revision).bytes }
                    catch (error: CloudRequestException) { if (error.status in 400..499) null else throw error }
                }
            }
            phase = CloudDiagnostics.Phase.RECONCILE
            fun engine(): CloudSyncReport = try {
                CloudSyncEngine.sync(remote, adapter, tracked, uploadActive, seen, progress("Syncing..."), maxFileBytes) { values ->
                    phase = CloudDiagnostics.Phase.STATE_SAVE
                    val next = JSONObject()
                    for ((path, base) in values) next.put(path, JSONObject().put("revision", base.revision).put("hash", base.hash).put("deleted", base.deleted))
                    state.put("tracked", next)
                    store.saveSyncState(scope, state)
                    // With the baselines, so a sync cut off by a crash does not download its own uploads again.
                    saveIndex(store, client, index)
                    phase = CloudDiagnostics.Phase.RECONCILE
                }
            } finally {
                runCatching { saveIndex(store, client, index); saveSeen(store, scope, seen) }
            }
            val report = engine()
            // Live list links: what guests ticked goes into the notes and up in this same run, and the check after that
            // moves the base and writes the notes' own ticks to the links.
            if (checkListLinks(client, adapter, tracked, checkActive)) {
                val again = engine()
                report.uploaded += again.uploaded
                report.downloaded += again.downloaded
                report.deleted += again.deleted
                report.conflicts += again.conflicts
                report.conflictPaths += again.conflictPaths
                report.uploadedPaths += again.uploadedPaths
                checkListLinks(client, adapter, tracked, checkActive)
            }
            phase = CloudDiagnostics.Phase.STATE_SAVE
            settings.put("lastSynced", Instant.now().toString()).put("conflicts", report.conflicts).put("conflictPaths", JSONArray(report.conflictPaths))
                .put("message", "Uploaded ${report.uploaded}, downloaded ${report.downloaded}, deleted ${report.deleted}. " +
                    (if (report.conflicts > 0) "${if (report.conflicts == 1) "1 note was" else "${report.conflicts} notes were"} changed in two places. Both versions are kept: tap Resolve now." else "Sync complete. Recovery copies remain local.") +
                    report.skipped.takeIf { it.isNotEmpty() }?.let { big ->
                        " ${if (big.size == 1) "1 file is" else "${big.size} files are"} larger than ${(maxFileBytes + 524288) / 1048576} MB, " +
                            "${if (maxFileBytes < planMax) "this device's" else "your plan's"} maximum per file, and ${if (big.size == 1) "stays" else "stay"} only on this device: " +
                            big.take(3).joinToString(", ") { it.substringAfterLast('/') } + (if (big.size > 3) " and ${big.size - 3} more." else ".")
                    }.orEmpty())
            store.saveSettings(settings)
            uploaded.value = report.uploadedPaths.toSet()
            changed.value++
            // The own vault is done; a shared space that fails says so itself and never stops this.
            syncSpaces(context, store, client, checkActive)
            // Mail to JotDrop: waiting sealed mail becomes local notes; the next sync uploads them, and only then the items go.
            val mailSaved = convertMail(client, adapter, cloudStatus.optJSONObject("mail"), tracked, checkActive)
            if (mailSaved > 0) {
                settings.put("message", settings.optString("message") + " " + if (mailSaved == 1) "1 email was saved as a note." else "$mailSaved emails were saved as notes.")
                store.saveSettings(settings)
                changed.value++
            }
            // Ask JotDrop, "Use this key on all my devices": once a day a phone that follows the shared key looks again.
            // It never stops the sync; a replaced or removed key is said in the sync message.
            val aiSaid = try { AiKeyCloud.daily(context) } catch (error: CancellationException) { throw error } catch (_: Exception) { null }
            if (aiSaid != null) {
                settings.put("message", settings.optString("message") + " " + aiSaid)
                store.saveSettings(settings)
                changed.value++
            }
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            Log.w("JotDropCloud", CloudDiagnostics.failure(error, phase, (System.nanoTime() - startedAt) / 1_000_000))
            val message = when (error) {
                is CloudRequestException -> if (error.status == 401) "Device access was revoked. Local files were kept; pair again." else error.message.orEmpty()
                is CloudSyncException -> error.message.orEmpty()
                is java.io.IOException -> "Network or local storage is unavailable. Local changes were kept; sync will retry."
                is IllegalArgumentException, is IllegalStateException -> error.message ?: "Sync validation failed. Local files were kept."
                else -> "Sync failed. Local files and encrypted sync state were kept. Retry before editing cloud settings."
            }
            settings.put("message", message)
            if (error is CloudRequestException && error.status == 401) settings.put("enabled", false)
            store.saveSettings(settings)
            changed.value++
            throw CloudSyncException(message)
        }
    }
}

class CloudSyncWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        return try {
            if (!withContext(Dispatchers.IO) { CloudSyncManager.status(applicationContext).enabled }) return Result.success()
            CloudSyncManager.sync(applicationContext)
            HomeWidgets.refresh(applicationContext)
            Result.success()
        } catch (error: CancellationException) { throw error }
        catch (_: Exception) { if (runAttemptCount < 5) Result.retry() else Result.failure() }
    }
}

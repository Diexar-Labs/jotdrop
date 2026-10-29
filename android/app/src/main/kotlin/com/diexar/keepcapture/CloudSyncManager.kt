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
        for (id in objects.keys()) objects.getJSONObject(id).let { index.objects[id] = CloudIndexedFile(it.getString("path"), it.getInt("revision"), it.getBoolean("deleted"), it.getString("hash")) }
        val pending = json.getJSONObject("pending")
        for (id in pending.keys()) index.pending[id] = pending.getInt(id)
        return index
    }
    private fun saveIndex(store: CloudPreviewStore, client: CloudClient, index: CloudRemoteIndex) {
        val objects = JSONObject()
        for ((id, file) in index.objects) objects.put(id, JSONObject().put("path", file.path).put("revision", file.revision).put("deleted", file.deleted).put("hash", file.hash))
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
        source: ByteArray? = null, local: (String) -> ByteArray = { error("No local file") }): CloudSyncObject? {
        val prepared = store.upload(scope, client.credentials.deviceId) ?: return null
        val file = client.preparedManifest(prepared)
        val bytes = file.bytes ?: source ?: runCatching { local(file.path) }.getOrNull()?.takeIf { CloudSyncEngine.hash(it) == file.hash }
        val revision = try { client.commitWrite(prepared, bytes, checkActive) } catch (_: CloudSourceMissingException) {
            // Changed since: the cloud did not get it, and the file here is newer; the sync takes it from here.
            store.clearUpload(scope, client.credentials.deviceId)
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
        store.clearUpload(scope, client.credentials.deviceId)
        return saved
    }

    private fun writeUpload(store: CloudPreviewStore, scope: String, client: CloudClient, state: JSONObject,
        path: String, bytes: ByteArray, baseRevision: Int, checkActive: () -> Unit): CloudSyncObject {
        checkActive()
        check(store.upload(scope, client.credentials.deviceId) == null) { "Resume the previous encrypted upload before saving another file" }
        store.saveUpload(scope, client.credentials.deviceId, client.prepareWrite(path, bytes, baseRevision))
        return requireNotNull(finishUpload(store, scope, client, state, checkActive, bytes))
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
            // The plan's maximum per file, and no more than this device can hold a few times over while syncing it.
            val planMax = client.maxFileBytes()
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
            val report = try {
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
            Result.success()
        } catch (error: CancellationException) { throw error }
        catch (_: Exception) { if (runAttemptCount < 5) Result.retry() else Result.failure() }
    }
}

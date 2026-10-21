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
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

data class CloudSyncStatus(val connected: Boolean, val enabled: Boolean, val server: String, val vaultId: String,
    val localVault: String?, val lastSynced: String?, val message: String, val conflicts: Int)
class CloudSyncException(message: String) : Exception(message)

object CloudSyncManager {
    private val mutex = Mutex()
    private val pauseRequested = AtomicBoolean(false)
    private val editors = mutableMapOf<String, Int>()
    private val changed = MutableStateFlow(0L)
    val changes = changed.asStateFlow()
    private val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
    private const val PERIODIC = "jotdrop-cloud-periodic"
    private const val IMMEDIATE = "jotdrop-cloud-now"

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
            settings.optString("lastSynced").takeIf { it.isNotBlank() }, settings.optString("message", "Cloud sync is off. Local notes remain available."), settings.optInt("conflicts"))
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
            check(!store.hasUploads(client.credentials.deviceId) || store.upload(scope(client, adapter.binding), client.credentials.deviceId) != null) {
                "An encrypted upload belongs to the previous local vault. Select that vault and resume or disconnect safely before changing sync folders."
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

    suspend fun disconnect(context: Context) {
        pauseRequested.set(true)
        cancel(context)
        serialized {
        val store = CloudPreviewStore(context)
        val client = client(context)
        if (client != null && store.hasUploads(client.credentials.deviceId)) {
            val adapter = CloudVaultAdapter(context)
            val scope = scope(client, adapter.binding)
            val prepared = store.upload(scope, client.credentials.deviceId)
                ?: error("Select the previous local vault to recover its encrypted upload before disconnecting")
            val file = client.preparedFile(prepared)
            adapter.recoverUpload(file.path, file.bytes)
            store.clearUpload(scope, client.credentials.deviceId)
            check(!store.hasUploads(client.credentials.deviceId)) { "Another local vault still has an encrypted upload. Its credentials were kept." }
        }
        val settings = store.settings().put("enabled", false).put("message", "Disconnected. Local notes, conflicts and recovery copies were kept.")
        store.saveSettings(settings)
        store.disconnect()
        cancel(context)
        }
    }

    private fun scope(client: CloudClient, binding: String): String = CloudSyncEngine.hash((client.credentials.url + "\n" + client.credentials.vaultId + "\n" + client.credentials.vaultKey + "\n" + binding).toByteArray(Charsets.UTF_8))

    private fun finishUpload(store: CloudPreviewStore, scope: String, client: CloudClient, state: JSONObject, checkActive: () -> Unit): CloudSyncObject? {
        val prepared = store.upload(scope, client.credentials.deviceId) ?: return null
        val file = client.preparedFile(prepared)
        val saved = CloudSyncObject(file.path, file.bytes, client.commitWrite(prepared, checkActive))
        val tracked = JSONObject((state.optJSONObject("tracked") ?: JSONObject()).toString())
        val previous = tracked.optJSONObject(saved.path)
        if (previous == null || previous.getInt("revision") < saved.revision) {
            tracked.put(saved.path, JSONObject().put("revision", saved.revision).put("hash", CloudSyncEngine.hash(saved.bytes)).put("deleted", false))
        } else if (previous.getInt("revision") == saved.revision) {
            check(!previous.getBoolean("deleted") && previous.getString("hash") == CloudSyncEngine.hash(saved.bytes)) { "Upload receipt differs from the saved baseline" }
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
        return requireNotNull(finishUpload(store, scope, client, state, checkActive))
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
            val bytes = adapter.list()[path]
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
            check(!store.hasUploads(client.credentials.deviceId) || store.upload(scope, client.credentials.deviceId) != null) {
                "An encrypted upload belongs to another local vault. Select its original sync folders to resume or recover it."
            }
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
            try { finishUpload(store, scope, client, state, uploadActive) }
            catch (error: CloudRequestException) {
                if (error.status != 409) throw error
                // A newer cloud revision wins. Preserve the sealed draft outside sync before discarding staging.
                uploadActive()
                val prepared = store.upload(scope, client.credentials.deviceId) ?: throw error
                val file = client.preparedFile(prepared)
                phase = CloudDiagnostics.Phase.RECOVERY
                initial.recoverUpload(file.path, file.bytes)
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
            val remote = object : CloudSyncRemote {
                override fun list(): List<CloudSyncObject> {
                    phase = CloudDiagnostics.Phase.REMOTE_LIST
                    val files = client.changesAndFiles(uploadActive).map { CloudSyncObject(it.path, it.bytes, it.revision, it.deleted) }
                    phase = CloudDiagnostics.Phase.RECONCILE
                    return files
                }
                override fun write(path: String, bytes: ByteArray, baseRevision: Int): CloudSyncObject {
                    checkActive()
                    phase = CloudDiagnostics.Phase.REMOTE_WRITE
                    val saved = writeUpload(store, scope, client, state, path, bytes, baseRevision, uploadActive)
                    phase = CloudDiagnostics.Phase.RECONCILE
                    return saved
                }
                override fun delete(path: String, baseRevision: Int): CloudSyncObject {
                    checkActive()
                    phase = CloudDiagnostics.Phase.REMOTE_DELETE
                    val id = CloudCrypto.objectId(client.credentials.vaultKey, path)
                    val current = client.read(id)
                    check(current.revision == baseRevision) { "Cloud changed during sync. Retry to compare both versions" }
                    val deleted = CloudSyncObject(path, current.bytes, client.remove(id, baseRevision), true)
                    phase = CloudDiagnostics.Phase.RECONCILE
                    return deleted
                }
            }
            phase = CloudDiagnostics.Phase.RECONCILE
            val report = CloudSyncEngine.sync(remote, adapter, tracked, uploadActive) { values ->
                phase = CloudDiagnostics.Phase.STATE_SAVE
                val next = JSONObject()
                for ((path, base) in values) next.put(path, JSONObject().put("revision", base.revision).put("hash", base.hash).put("deleted", base.deleted))
                state.put("tracked", next)
                store.saveSyncState(scope, state)
                phase = CloudDiagnostics.Phase.RECONCILE
            }
            phase = CloudDiagnostics.Phase.STATE_SAVE
            settings.put("lastSynced", Instant.now().toString()).put("conflicts", report.conflicts)
                .put("message", "Uploaded ${report.uploaded}, downloaded ${report.downloaded}, deleted ${report.deleted}. " +
                    if (report.conflicts > 0) "${report.conflicts} conflicts: originals were kept. Compare .cloud-conflict copies before choosing a version." else "Sync complete. Recovery copies remain local.")
            store.saveSettings(settings)
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

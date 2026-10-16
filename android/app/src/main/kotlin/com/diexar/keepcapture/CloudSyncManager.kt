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
            requireNotNull(client(context)) { "Pair this device first" }
            val adapter = try {
                CloudVaultAdapter(context).also { it.list() }
            } catch (error: IllegalStateException) {
                throw CloudSyncException(error.message ?: "Local vault validation failed; no files were changed.")
            } catch (error: IllegalArgumentException) {
                throw CloudSyncException(error.message ?: "Choose safe, non-overlapping local note and attachment folders.")
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
        val settings = store.settings().put("enabled", false).put("message", "Disconnected. Local notes, conflicts and recovery copies were kept.")
        store.saveSettings(settings)
        store.disconnect()
        cancel(context)
        }
    }

    private fun scope(client: CloudClient, binding: String): String = CloudSyncEngine.hash((client.credentials.url + "\n" + client.credentials.vaultId + "\n" + client.credentials.vaultKey + "\n" + binding).toByteArray(Charsets.UTF_8))

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
            val adapter = CloudVaultAdapter(context, { name, original, replacement ->
                state.put("pending", JSONObject().put("path", name).put("original", original.orEmpty()).put("replacement", replacement.orEmpty()))
                store.saveSyncState(scope, state)
            }, { state.remove("pending"); store.saveSyncState(scope, state) })
            val bytes = adapter.list()[path]
            val remote = client.read(CloudCrypto.objectId(client.credentials.vaultKey, path))
            if (keepLocal) {
                if (bytes == null) { if (!remote.deleted) client.remove(remote.id, remote.revision) }
                else if (remote.deleted || !bytes.contentEquals(remote.bytes)) client.write(path, bytes, remote.revision)
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
        try {
            val initial = CloudVaultAdapter(context)
            check(settings.optString("binding") == initial.binding) { "Vault settings changed. Pause and re-enable sync for the intended folder" }
            val scope = scope(client, initial.binding)
            val state = store.syncState(scope) ?: JSONObject()
            val pending = state.optJSONObject("pending")
            if (pending != null) {
                check(synchronized(Storage.cloudFileLock) { initial.verifyPending(pending.getString("path"), pending.optString("original").takeIf { it.isNotEmpty() }, pending.optString("replacement").takeIf { it.isNotEmpty() }) }) {
                    "An interrupted local write needs recovery. Restore its .cloud-recovery copy, or remove a partial new file, before syncing again"
                }
                state.remove("pending")
                store.saveSyncState(scope, state)
            }
            val adapter = CloudVaultAdapter(context, { path, original, replacement ->
                state.put("pending", JSONObject().put("path", path).put("original", original.orEmpty()).put("replacement", replacement.orEmpty()))
                store.saveSyncState(scope, state)
            }, {
                state.remove("pending")
                store.saveSyncState(scope, state)
            })
            val tracked = mutableMapOf<String, CloudSyncBase>()
            val baseline = state.optJSONObject("tracked") ?: JSONObject()
            for (name in baseline.keys()) {
                val value = baseline.getJSONObject(name)
                tracked[name] = CloudSyncBase(value.getInt("revision"), value.getString("hash"), value.getBoolean("deleted"))
            }
            val remote = object : CloudSyncRemote {
                override fun list(): List<CloudSyncObject> = client.changesAndFiles(checkActive).map { CloudSyncObject(it.path, it.bytes, it.revision, it.deleted) }
                override fun write(path: String, bytes: ByteArray, baseRevision: Int): CloudSyncObject { checkActive(); return CloudSyncObject(path, bytes, client.write(path, bytes, baseRevision)) }
                override fun delete(path: String, baseRevision: Int): CloudSyncObject {
                    checkActive()
                    val id = CloudCrypto.objectId(client.credentials.vaultKey, path)
                    val current = client.read(id)
                    check(current.revision == baseRevision) { "Cloud changed during sync. Retry to compare both versions" }
                    return CloudSyncObject(path, current.bytes, client.remove(id, baseRevision), true)
                }
            }
            val report = CloudSyncEngine.sync(remote, adapter, tracked, checkActive) { values ->
                val next = JSONObject()
                for ((path, base) in values) next.put(path, JSONObject().put("revision", base.revision).put("hash", base.hash).put("deleted", base.deleted))
                state.put("tracked", next)
                store.saveSyncState(scope, state)
            }
            settings.put("lastSynced", Instant.now().toString()).put("conflicts", report.conflicts)
                .put("message", "Uploaded ${report.uploaded}, downloaded ${report.downloaded}, deleted ${report.deleted}. " +
                    if (report.conflicts > 0) "${report.conflicts} conflicts: originals were kept. Compare .cloud-conflict copies before choosing a version." else "Sync complete. Recovery copies remain local.")
            store.saveSettings(settings)
            changed.value++
        } catch (error: Exception) {
            if (error is CancellationException) throw error
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

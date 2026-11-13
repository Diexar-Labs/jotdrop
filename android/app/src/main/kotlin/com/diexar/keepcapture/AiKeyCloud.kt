package com.diexar.keepcapture

import android.content.Context
import android.util.AtomicFile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File

/**
 * "Use this key on all my devices" (JotDrop Plus; Hand-off/ontwerp-ask-jotdrop-v2.md 4.8) on this phone, as the web
 * app does it in cloud/web/app.js: the calls to /ai-key of the own account (never a shared group), the local copy in
 * AiSecretStore, and the look once a day after a sync. The rules are AiKeySync's. The key is never shown, logged or
 * put in a message.
 */
object AiKeyCloud {
    private const val DAY_MS = 24L * 60 * 60 * 1000

    /** What a look found: the server's answer, the settings after it, and what changed here (replaced, removed) if anything. */
    class Look(val remote: AiKeyRemote, val settings: AiSettings, val changed: String?) {
        val action get() = AiKeySync.decide(settings.on, settings.synced, remote)
        /** A newer shared key for another service than the one here: it changes where questions and notes go, so it is asked. */
        val switched get() = action == "update" && !same(remote.config, settings)
        /** A key that is ready for this phone ("Use it here?"): one from another device, or a newer one for another service. */
        val offered get() = remote.config?.takeIf { action == "offer" || switched }
    }

    /** Why a step did not happen, for the screen to put in words. */
    class Refused(val reason: String, val remote: AiKeyRemote? = null, val detail: String? = null) : Exception("AI key sync: $reason")

    /**
     * What the server has right after this phone saved its own settings there: the screen then offers and labels the
     * key that is really there, not the one it saw when it opened (found 13 Nov 2026 in the two-device test).
     */
    fun ownLook(settings: AiSettings): Look? = if (settings.synced > 0) Look(AiKeyRemote(AiKeyRemote.FOUND, settings.synced,
        SharedAiKey(settings.provider, settings.key, settings.model, settings.baseUrl)), settings, null) else null

    fun client(context: Context): CloudClient? =runCatching { CloudSyncManager.client(context) }.getOrNull()

    private fun same(shared: SharedAiKey?, settings: AiSettings) = shared != null && AiKeySync.sameService(shared.provider, shared.baseUrl, settings.provider, settings.baseUrl)

    private fun followed(shared: SharedAiKey, includeShared: Boolean, updatedAt: Long) = AiSettings(shared.provider, shared.key, shared.model, shared.baseUrl, includeShared, updatedAt)

    suspend fun read(client: CloudClient): AiKeyRemote = withContext(Dispatchers.IO) {
        try {
            val answer = client.call(AiKeySync.PATH)
            AiKeySync.remote(200, AiJson.parse(answer.toString()).obj()) { AiKeySync.openKey(client.credentials.vaultKey, client.credentials.vaultId, it) }
        } catch (error: CancellationException) { throw error }
        catch (error: CloudRequestException) { AiKeySync.remote(error.status, mapOf("code" to error.code)) { null } }
        catch (_: Exception) { AiKeyRemote(AiKeyRemote.UNAVAILABLE) }
    }

    /** Seals these settings and saves them for the other devices; returns the server's time of the blob. */
    private suspend fun save(client: CloudClient, settings: AiSettings): Long = withContext(Dispatchers.IO) {
        val sealed = AiKeySync.sealKey(client.credentials.vaultKey, client.credentials.vaultId, AiKeySync.sharedKey(settings.config()))
        val time = AiKeySync.validTime(client.call(AiKeySync.PATH, "PUT", JSONObject().put("sealed", sealed)).opt("updatedAt"))
        if (time == 0L) throw Refused("unconfirmed")
        time
    }

    private suspend fun remove(client: CloudClient) = withContext(Dispatchers.IO) { client.call(AiKeySync.PATH, "DELETE"); Unit }

    // When this phone last looked, per workspace, in the no-backup folder (no key in it).
    private fun checkedFile(context: Context) = AtomicFile(File(File(context.noBackupFilesDir, "ai").also { it.mkdirs() }, "key-checked"))
    private fun lastChecked(context: Context, vaultId: String): Long = runCatching {
        String(checkedFile(context).readFully(), Charsets.UTF_8).split('\n').takeIf { it.size == 2 && it[0] == vaultId }?.get(1)?.toLong()
    }.getOrNull() ?: 0
    private fun markChecked(context: Context, vaultId: String) {
        runCatching {
            val file = checkedFile(context)
            val output = file.startWrite()
            try { output.write("$vaultId\n${System.currentTimeMillis()}".toByteArray(Charsets.UTF_8)); file.finishWrite(output) } catch (error: Exception) { file.failWrite(output); throw error }
        }
    }

    /**
     * Looks at what the server has and follows it: a newer shared key for the same service replaces the copy, a
     * removed one takes it away and turns Ask JotDrop off. Null when this phone is not connected to JotDrop Cloud.
     */
    suspend fun look(context: Context): Look? {
        val client = client(context) ?: return null
        val remote = read(client)
        if (remote.status != AiKeyRemote.UNAVAILABLE) withContext(Dispatchers.IO) { markChecked(context, client.credentials.vaultId) }
        return withContext(Dispatchers.IO) {
            val store = AiSecretStore(context)
            val settings = store.load()
            val config = remote.config
            when (AiKeySync.decide(settings.on, settings.synced, remote)) {
                "update" -> if (config != null && same(config, settings)) {
                    val next = followed(config, settings.includeShared, remote.updatedAt)
                    store.save(next)
                    Look(remote, next, "replaced")
                } else Look(remote, settings, null)
                "remove" -> { store.clear(); Look(remote, AiSettings(), "removed") }
                else -> Look(remote, settings, null)
            }
        }
    }

    /** Once a day, after an ordinary sync, and only on a phone that follows a shared key. Returns what to say, or null. */
    suspend fun daily(context: Context): String? {
        val settings = withContext(Dispatchers.IO) { AiSecretStore(context).load() }
        val client = client(context) ?: return null
        if (settings.synced == 0L || System.currentTimeMillis() - lastChecked(context, client.credentials.vaultId) in 0 until DAY_MS) return null
        return when (look(context)?.changed) {
            "replaced" -> context.getString(R.string.ai_sync_replaced)
            "removed" -> context.getString(R.string.ai_sync_removed)
            else -> null
        }
    }

    /** One tap: this phone keeps its own sealed copy of the shared key and follows it from now on. A fresh look, so it is the key of this moment. */
    suspend fun use(context: Context): AiSettings {
        val client = client(context) ?: throw Refused("cloud")
        val remote = read(client)
        val config = remote.config
        if (remote.status == AiKeyRemote.PLUS) throw Refused("plus", remote)
        if (remote.status == AiKeyRemote.UNAVAILABLE) throw Refused("unreachable", remote)
        if (remote.status != AiKeyRemote.FOUND || config == null || config.provider !in AiSecretStore.PROVIDERS) throw Refused("gone", remote)
        return withContext(Dispatchers.IO) {
            val store = AiSecretStore(context)
            followed(config, store.load().includeShared, remote.updatedAt).also(store::save)
        }
    }

    /**
     * The switch on: the key of this phone goes to the other devices. When they already share another key it is never
     * replaced without a word: [Refused] "other", with the answer, so the screen can ask.
     */
    suspend fun turnOn(context: Context, settings: AiSettings): AiSettings {
        val client = client(context) ?: throw Refused("cloud")
        val remote = read(client)
        val config = remote.config
        when {
            remote.status == AiKeyRemote.PLUS -> throw Refused("plus", remote)
            remote.status == AiKeyRemote.UNAVAILABLE -> throw Refused("unreachable", remote)
            // A blob this version cannot open may come from a newer app: never write over it.
            remote.status == AiKeyRemote.FOUND && config == null -> throw Refused("unopened", remote)
            remote.status == AiKeyRemote.FOUND && config != null && (config.provider != settings.provider || config.key != settings.key) -> throw Refused("other", remote)
        }
        val next = settings.copy(synced = saveOrRefuse(client, settings))
        withContext(Dispatchers.IO) { AiSecretStore(context).save(next) }
        return next
    }

    private suspend fun saveOrRefuse(client: CloudClient, settings: AiSettings): Long = try { save(client, settings) }
        catch (error: AiKeyShareException) { throw Refused("share-${error.code}") }
        catch (error: CloudRequestException) { throw if (error.code == "plus-required") Refused("plus") else Refused("server", detail = error.serverMessage) }
        catch (error: Refused) { throw error }
        catch (error: CancellationException) { throw error }
        catch (_: Exception) { throw Refused("unreachable") }

    /** The switch off: JotDrop removes its sealed copy; this phone keeps its key, the devices that followed it lose theirs. */
    suspend fun turnOff(context: Context, settings: AiSettings): AiSettings {
        val client = client(context) ?: throw Refused("cloud")
        try { remove(client) } catch (error: CancellationException) { throw error }
            catch (error: CloudRequestException) { throw Refused("server", detail = error.serverMessage) } catch (_: Exception) { throw Refused("unreachable") }
        val next = settings.copy(synced = 0)
        withContext(Dispatchers.IO) { AiSecretStore(context).save(next) }
        return next
    }

    /**
     * After Save on a phone that follows the shared key: the other devices get the new settings, or, when there is
     * nothing to share (Off), this phone lets go and they keep theirs. Returns the settings now kept and [Refused]
     * as the reason when the other devices keep the earlier key (null: they got it).
     */
    suspend fun shareSaved(context: Context, settings: AiSettings): Pair<AiSettings, Refused?> {
        val store = AiSecretStore(context)
        val client = client(context)
        val shareable = settings.on && runCatching { AiKeySync.sharedKey(settings.config()) }.isSuccess
        if (!shareable || client == null) {
            val next = settings.copy(synced = 0)
            withContext(Dispatchers.IO) { if (next.on) store.save(next) else store.clear() }
            return next to Refused(if (!settings.on) "let-go" else if (client == null) "cloud" else "let-go-unshareable")
        }
        return try {
            val next = settings.copy(synced = save(client, settings))
            withContext(Dispatchers.IO) { store.save(next) }
            next to null
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            withContext(Dispatchers.IO) { store.save(settings) }
            settings to when (error) {
                is CloudRequestException -> if (error.code == "plus-required") Refused("plus") else Refused("server", detail = error.serverMessage)
                is Refused -> error
                else -> Refused("unreachable")
            }
        }
    }

    /** "On all my devices": first the sealed copy on the server; if that fails, nothing is removed and the user can try again. */
    suspend fun removeEverywhere(context: Context) {
        val client = client(context) ?: throw Refused("cloud")
        try { remove(client) } catch (error: CancellationException) { throw error }
            catch (error: CloudRequestException) { throw Refused("server", detail = error.serverMessage) } catch (_: Exception) { throw Refused("unreachable") }
        withContext(Dispatchers.IO) { AiSecretStore(context).clear() }
    }

    /** The service in words, for the messages: "Claude (Anthropic)", "your own address ai.example.com". */
    fun label(context: Context, config: SharedAiKey): String = AiKeySync.serviceName(config)?.let { name ->
        if (AiProviders.SPECS[config.provider]?.base != null) aiProviderName(context, config.provider) else context.getString(R.string.ai_sync_own_address, name)
    } ?: context.getString(R.string.ai_sync_some_service)

    /** A refusal in words. */
    fun reasonText(context: Context, refused: Refused): String = when (refused.reason) {
        "plus" -> context.getString(R.string.ai_sync_plus)
        "cloud" -> context.getString(R.string.ai_sync_needs_cloud)
        "unopened" -> context.getString(R.string.ai_sync_cannot_open)
        "gone" -> context.getString(R.string.ai_sync_gone)
        "share-address" -> context.getString(R.string.ai_sync_share_address)
        "share-key" -> context.getString(R.string.ai_sync_share_key)
        "share-model" -> context.getString(R.string.ai_sync_share_model)
        "share-off", "share-local" -> context.getString(R.string.ai_sync_share_off)
        "server" -> refused.detail ?: context.getString(R.string.ai_sync_unreachable)
        else -> context.getString(R.string.ai_sync_unreachable)
    }
}

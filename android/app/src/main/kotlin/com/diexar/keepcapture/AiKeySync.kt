package com.diexar.keepcapture

import java.net.URI

/** The four fields that go to the other devices: no switch for shared notes, no time, nothing else. */
data class SharedAiKey(val provider: String, val key: String, val model: String, val baseUrl: String) {
    override fun toString() = "SharedAiKey($provider, key hidden)"
}

/**
 * What the server has for "Use this key on all my devices": FOUND with the time of the blob and its settings (null
 * when the blob does not open here), NONE when the server says in its own words that there is none, PLUS when this
 * needs JotDrop Plus, UNAVAILABLE for everything else.
 */
data class AiKeyRemote(val status: String, val updatedAt: Long = 0, val config: SharedAiKey? = null) {
    companion object {
        const val FOUND = "found"
        const val NONE = "none"
        const val PLUS = "plus"
        const val UNAVAILABLE = "unavailable"
    }
    override fun toString() = "AiKeyRemote($status, $updatedAt, ${if (config == null) "no key" else config.provider})"
}

/** Why these settings cannot go to the other devices: off, local, address, key or model. The message never holds the key. */
class AiKeyShareException(val code: String) : Exception("The AI key cannot be shared ($code).")

/**
 * Ask JotDrop, "Use this key on all my devices" (JotDrop Plus), as cloud/shared/ai/keysync.mjs: the key is sealed
 * with the workspace key and kept by the server at /ai-key, never as a file in the workspace, and the server cannot
 * open it. cloud/shared/ai/ai-key-vectors.json holds what this file must open, refuse and decide; android/checks/
 * AiCheck.kt plays every case, and the web app opens what this file seals (scripts/check-ai-android.mjs). Plain
 * Kotlin: no Android, no org.json.
 */
object AiKeySync {
    const val PATH = "/ai-key"
    /** The server takes 8 KiB at most. */
    const val MAX_SEALED = 8 * 1024
    /** Every blob is filled up to a whole number of these, so its size does not tell the server which service it is for. */
    private const val BLOCK = 1024
    private const val MAX_KEY = 500
    private const val MAX_MODEL = 200
    private const val MAX_ADDRESS = 300
    private val FIELDS = listOf("provider", "key", "model", "baseUrl")
    // As the server writes ids, lower case only: the workspace is part of the AAD, so another spelling opens nowhere.
    private val ID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    private const val MAX_SAFE = 9007199254740991L

    /** Binds a blob to this purpose and this workspace: no other envelope under the same key can take its place. */
    fun aad(vaultId: String): String {
        require(ID.matches(vaultId)) { "Invalid workspace ID." }
        return "jotdrop:ai-key:v1:$vaultId"
    }

    // JavaScript's \s and String.trim: white space and line ends, the same set, so a key reads the same everywhere.
    private fun jsSpace(char: Char) = char in "\t\n\u000B\u000C\r       　﻿" || char in ' '..' '
    private fun jsTrim(value: String) = value.trim(::jsSpace)
    private fun oneLine(value: String, maximum: Int) = value.length <= maximum && value.none { it.code < 0x20 || it.code == 0x7f }

    private fun httpsAddress(value: String): Boolean {
        if (value.isEmpty() || !oneLine(value, MAX_ADDRESS)) return false
        return try {
            // java.net.URI is stricter than the browser's URL in places (a name and password are refused here even
            // when empty): a blob the web app wrote with such an address then does not open here, and is left alone.
            val uri = URI(value)
            uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null && uri.port in -1..65535
        } catch (_: Exception) { false }
    }

    /**
     * What goes to the other devices, from the settings of this one. Throws [AiKeyShareException] when these
     * settings cannot be shared: off (nothing chosen), local (a local model has no key), address (an own address
     * that is not https), key or model.
     */
    fun sharedKey(provider: String, key: String, model: String, baseUrl: String): SharedAiKey {
        val id = jsTrim(provider)
        val spec = AiProviders.SPECS[id] ?: throw AiKeyShareException("off")
        if (spec.base != null && !spec.needsKey) throw AiKeyShareException("local")
        val address = if (spec.base != null) "" else jsTrim(baseUrl)
        if (spec.base == null && !httpsAddress(address)) throw AiKeyShareException("address")
        val cleanKey = jsTrim(key)
        val cleanModel = jsTrim(model)
        if (cleanKey.isEmpty() || cleanKey.any(::jsSpace) || !oneLine(cleanKey, MAX_KEY)) throw AiKeyShareException("key")
        if (!oneLine(cleanModel, MAX_MODEL)) throw AiKeyShareException("model")
        return SharedAiKey(id, cleanKey, cleanModel, address)
    }

    fun sharedKey(config: AiConfig): SharedAiKey = sharedKey(config.provider, config.key, config.model, config.baseUrl)

    /** The four fields of an opened blob, or null. Strict: what another device wrote must already be in its clean form. */
    private fun checked(payload: Any?): SharedAiKey? {
        val value = payload.obj() ?: return null
        if ((value["v"] as? Number)?.toDouble() != 1.0) return null
        val fields = FIELDS.map { value[it] as? String ?: return null }
        val clean = try { sharedKey(fields[0], fields[1], fields[2], fields[3]) } catch (_: AiKeyShareException) { return null }
        return if (listOf(clean.provider, clean.key, clean.model, clean.baseUrl) == fields) clean else null
    }

    /** The sealed blob for the server, as text. Throws like [sharedKey] when these settings cannot be shared. */
    fun sealKey(vaultKey: String, vaultId: String, provider: String, key: String, model: String, baseUrl: String): String {
        val additional = aad(vaultId)
        val shared = sharedKey(provider, key, model, baseUrl)
        val body = linkedMapOf<String, Any?>("v" to 1L, "provider" to shared.provider, "key" to shared.key, "model" to shared.model, "baseUrl" to shared.baseUrl, "pad" to "")
        val length = AiJson.stringify(body).toByteArray(Charsets.UTF_8).size
        body["pad"] = "0".repeat((BLOCK - length % BLOCK) % BLOCK)
        val envelope = CloudCrypto.encrypt(vaultKey, AiJson.stringify(body).toByteArray(Charsets.UTF_8), additional)
        return AiJson.stringify(linkedMapOf("v" to 1L, "iv" to envelope.iv, "ciphertext" to envelope.ciphertext))
    }

    fun sealKey(vaultKey: String, vaultId: String, shared: SharedAiKey): String = sealKey(vaultKey, vaultId, shared.provider, shared.key, shared.model, shared.baseUrl)

    /**
     * The settings in a sealed blob, or null when it does not open or is not a key this app can use: made for another
     * workspace or purpose, changed on the way, a later format, or settings that cannot be shared. Never throws: a
     * blob that does not open must leave the key on this phone alone.
     */
    fun openKey(vaultKey: String, vaultId: String, sealed: Any?): SharedAiKey? = try {
        if (sealed !is String || sealed.length > MAX_SEALED) null else {
            val envelope = AiJson.parse(sealed).obj()
            if (envelope == null || (envelope["v"] as? Number)?.toDouble() != 1.0) null else {
                val iv = envelope["iv"] as? String
                val ciphertext = envelope["ciphertext"] as? String
                if (iv == null || ciphertext == null) null
                else checked(AiJson.parse(String(CloudCrypto.decrypt(vaultKey, CloudEnvelope(iv, ciphertext), aad(vaultId)), Charsets.UTF_8)))
            }
        }
    } catch (_: Exception) { null }

    /** The server's time of a blob: a whole number above 0 that JavaScript holds exactly, or 0. */
    fun validTime(value: Any?): Long = when (value) {
        is Long -> value.takeIf { it in 1..MAX_SAFE } ?: 0
        is Int -> value.toLong().takeIf { it > 0 } ?: 0
        is Double -> if (value.isFinite() && value == Math.floor(value) && value >= 1 && value <= MAX_SAFE) value.toLong() else 0
        else -> 0
    }

    /**
     * What the server's answer to GET /ai-key means, as readSharedKey in keysync.mjs: [status] and [body] of the
     * answer (the error code for an error). "none" needs the server's code no-ai-key: an older server answers this
     * address with a plain 404, and a phone that took that for "removed" would throw its key away after a rollback.
     */
    fun remote(status: Int, body: Map<String, Any?>?, open: (String) -> SharedAiKey?): AiKeyRemote = try {
        when {
            status in 200..299 -> {
                val sealed = body?.get("sealed") as? String
                val time = validTime(body?.get("updatedAt"))
                if (sealed == null || time == 0L) AiKeyRemote(AiKeyRemote.UNAVAILABLE) else AiKeyRemote(AiKeyRemote.FOUND, time, open(sealed))
            }
            status == 404 && body?.get("code") == "no-ai-key" -> AiKeyRemote(AiKeyRemote.NONE)
            status == 402 && body?.get("code") == "plus-required" -> AiKeyRemote(AiKeyRemote.PLUS)
            else -> AiKeyRemote(AiKeyRemote.UNAVAILABLE)
        }
    } catch (_: Exception) { AiKeyRemote(AiKeyRemote.UNAVAILABLE) }

    /**
     * What this phone does with the server's answer. [synced] is the time of the blob this phone's key came from or
     * was saved as, 0 when its key (if any) is its own.
     * - offer: no key here and one is ready: ask "Use it here?".
     * - available: an own key here while the other devices share one: only say so.
     * - update: the shared key was replaced: take the new one for the same service (sameService), ask first for another.
     * - remove: the shared key was removed elsewhere: drop the copy and turn Ask JotDrop off, with a message.
     * - waiting: the copy stays; sharing waits for JotDrop Plus.
     * - none: change nothing. Also for a blob that does not open, an older blob shown again, and every answer that is
     *   not understood: when in doubt the key on this phone is left alone.
     */
    fun decide(hasKey: Boolean, synced: Long, remote: AiKeyRemote?): String {
        val followed = if (synced in 1..MAX_SAFE) synced else 0
        return when (remote?.status) {
            AiKeyRemote.PLUS -> if (followed > 0) "waiting" else "none"
            AiKeyRemote.NONE -> if (followed > 0) "remove" else "none"
            AiKeyRemote.FOUND -> when {
                remote.config == null || validTime(remote.updatedAt) == 0L -> "none"
                followed > 0 -> if (remote.updatedAt > followed) "update" else "none"
                hasKey -> "available"
                else -> "offer"
            }
            else -> "none"
        }
    }

    /**
     * The time of the shared key this phone follows, as it counts in [vaultId]: a key followed in another workspace is
     * this phone's own here (0), so after connecting to another account nothing is removed or replaced.
     */
    fun followedHere(synced: Long, syncedVault: String, vaultId: String): Long = if (synced > 0 && syncedVault == vaultId) synced else 0

    /**
     * Whether two settings talk to the same AI service: the same provider and, for an own address, the same address.
     * A newer shared key for the same service is taken without a question (a replaced key); one for another service
     * or address is asked first, because it changes where questions and notes go.
     */
    fun sameService(aProvider: String?, aBaseUrl: String?, bProvider: String?, bBaseUrl: String?): Boolean {
        val a = jsTrim(aProvider.orEmpty())
        return a.isNotEmpty() && a == jsTrim(bProvider.orEmpty()) && jsTrim(aBaseUrl.orEmpty()) == jsTrim(bBaseUrl.orEmpty())
    }

    /**
     * The service a shared key is for, for "A key from another device is ready: …": the service's name, or the host
     * of an own address (the screen puts it in words); null when it is not a service this app knows. Never the key.
     */
    fun serviceName(config: SharedAiKey): String? {
        val spec = AiProviders.SPECS[config.provider] ?: return null
        if (spec.base != null) return spec.name
        return try {
            val uri = URI(config.baseUrl)
            uri.host?.lowercase()?.let { host -> if (uri.port == -1 || uri.port == 443) host else "$host:${uri.port}" }
        } catch (_: Exception) { null }
    }
}

package com.diexar.keepcapture

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.net.HttpURLConnection
import java.net.URI
import java.security.KeyStore
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class CloudCredentials(val url: String, val vaultId: String, val deviceId: String, val token: String, val vaultKey: String) {
    fun json(): JSONObject = JSONObject().put("url", url).put("vaultId", vaultId).put("deviceId", deviceId).put("token", token).put("vaultKey", vaultKey)
    companion object {
        fun from(json: JSONObject): CloudCredentials = CloudCredentials(json.getString("url"), json.getString("vaultId"), json.getString("deviceId"), json.getString("token"), json.getString("vaultKey"))
    }
}

/** [serverMessage] is the server's own short error text, shown by the account screens. */
/** A device the server lists when a free cloud is at its device limit. */
class CloudDeviceInfo(val id: String, val name: String, val lastSeenAt: String)
/** A v2 upload whose missing pieces need the file, which changed or went away since; the newer local file wins. */
class CloudSourceMissingException : IllegalStateException("The file is needed to finish this upload. The encrypted draft was kept.")
/** `code` names a plan limit: "device-limit" comes with the active `devices` to choose from, "plus-required" with none. */
class CloudRequestException(val status: Int, val serverMessage: String? = null, val code: String? = null, val devices: List<CloudDeviceInfo> = emptyList()) : Exception(if (status == 409) "A newer cloud version exists. Your local draft was kept; refresh and compare before saving." else "Cloud request failed ($status). Your local draft was kept.")

/** Encrypted HTTPS transport; local vault access belongs to the sync adapter. */
class CloudClient(val credentials: CloudCredentials) {
    init {
        secureOrigin(credentials.url)
        require(validId(credentials.vaultId) && validId(credentials.deviceId)) { "Invalid cloud device identity" }
        require(CloudCrypto.decode(credentials.token).size == 32 && CloudCrypto.decode(credentials.vaultKey).size == 32) { "Invalid cloud credentials" }
    }

    /** One page of the changes feed after [after]. */
    fun changes(after: Long): CloudChanges {
        val page = request(credentials.url, "/changes?after=$after", "GET", null, credentials)
        val changes = page.getJSONArray("changes")
        return CloudChanges(List(changes.length()) { index ->
            val change = changes.getJSONObject(index)
            CloudChange(change.getString("id").also { require(it.matches(Regex("[0-9a-f]{64}"))) { "Invalid cloud object identity" } }, revision(change))
        }, page.getLong("cursor"), page.getBoolean("hasMore"))
    }

    /** Every file's newest revision from the changes feed alone, without downloading any file. */
    fun current(checkActive: () -> Unit = {}): List<CloudCurrentFile> {
        var cursor = 0L
        val files = linkedMapOf<String, CloudCurrentFile>()
        do {
            checkActive()
            val page = request(credentials.url, "/changes?after=$cursor", "GET", null, credentials)
            val changes = page.getJSONArray("changes")
            for (index in 0 until changes.length()) changes.getJSONObject(index).let { files[it.getString("id")] = CloudCurrentFile(it.getString("id"), revision(it), it.getBoolean("deleted")) }
            val next = page.getLong("cursor")
            val more = page.getBoolean("hasMore")
            require(!more || next > cursor) { "Invalid cloud changes cursor" }
            cursor = next
        } while (more)
        return files.values.toList()
    }

    /** The newest manifest of a file, or null when a full free cloud cleared it after 30 days in the trash. */
    fun manifestOrNull(id: String): CloudManifest? = try { readManifest(id) } catch (error: CloudRequestException) { if (error.status == 404) null else throw error }

    /** The steps of the time machine: the last change time of each minute with a change, oldest first. */
    fun moments(checkActive: () -> Unit = {}): List<String> {
        var cursor = 0L
        val times = mutableListOf<String>()
        do {
            checkActive()
            val page = request(credentials.url, "/changes?after=$cursor", "GET", null, credentials)
            val changes = page.getJSONArray("changes")
            for (index in 0 until changes.length()) times += changes.getJSONObject(index).getString("updatedAt").also { Instant.parse(it) }
            val next = page.getLong("cursor")
            val more = page.getBoolean("hasMore")
            require(!more || next > cursor) { "Invalid cloud changes cursor" }
            cursor = next
        } while (more)
        return CloudTimeMachine.steps(times)
    }

    /** Every file as it was at `at`, page by page. */
    fun snapshot(at: String): List<CloudMomentFile> {
        Instant.parse(at)
        val files = mutableListOf<CloudMomentFile>()
        var after = ""
        do {
            val page = call("/snapshot?at=$at&after=$after")
            val objects = page.getJSONArray("objects")
            for (index in 0 until objects.length()) {
                val entry = objects.getJSONObject(index)
                require(entry.getString("id").matches(Regex("[0-9a-f]{64}"))) { "Invalid cloud object identity" }
                files += CloudMomentFile(entry.getString("id"), if (entry.isNull("revision")) null else revision(entry), entry.getBoolean("deleted"), entry.getBoolean("locked"), entry.optBoolean("cleared"))
            }
            val more = page.getBoolean("hasMore")
            val next = page.getString("cursor")
            require(!more || next > after) { "Invalid cloud snapshot cursor" }
            after = next
        } while (more)
        return files
    }

    /** The whole file: its manifest, then its pieces. */
    fun read(id: String, version: Int? = null): CloudPreviewFile = readManifest(id, version).let { CloudPreviewFile(id, it.revision, it.path, readPieces(it), it.deleted) }

    /** The manifest only, as `readManifest` in cloud/shared/client.mjs: enough to compare with a local file without downloading its pieces. */
    fun readManifest(id: String, version: Int? = null): CloudManifest {
        require(id.matches(Regex("[0-9a-f]{64}")) && (version == null || version > 0)) { "Invalid cloud object identity" }
        // A v1 note of up to 4 MiB: allow minutes on a slow line.
        val response = request(credentials.url, "/objects/$id${if (version == null) "" else "?revision=$version"}", "GET", null, credentials, limitSeconds = 300)
        val encrypted = parseEnvelope(response.getString("envelope"))
        val value = JSONObject(utf8(CloudCrypto.decrypt(credentials.vaultKey, encrypted, "jotdrop:object:v1:${credentials.vaultId}:$id")))
        return manifest(id, revision(response), response.getBoolean("deleted"), value, CloudCrypto.safePath(value.getString("path")))
    }

    private fun manifest(id: String, revision: Int, deleted: Boolean, value: JSONObject, path: String): CloudManifest {
        val invalid = "Encrypted file validation failed. No local files were changed."
        require(CloudCrypto.objectId(credentials.vaultKey, path) == id) { "Encrypted file identity does not match" }
        Instant.parse(value.getString("modifiedAt"))
        if (value.optInt("v", 1) != 2) {
            val bytes = CloudCrypto.decode(value.getString("content"))
            require(bytes.size <= CloudCrypto.MAX_FILE_BYTES) { "Cloud file exceeds the 4 MiB preview limit" }
            return CloudManifest(id, revision, path, deleted, bytes.size, CloudSyncEngine.hash(bytes), emptyList(), bytes)
        }
        val size = value.getLong("size")
        val hash = value.getString("hash")
        val list = value.getJSONArray("chunks")
        require(size in 0..CloudCrypto.MAX_CHUNKED_BYTES && hash.matches(hex64)) { invalid }
        val count = if (size > CloudCrypto.INLINE_BYTES) pieces(size.toInt()) else 0
        require(list.length() == count) { invalid }
        val pieces = List(count) { index ->
            list.getJSONObject(index).let { CloudPiece(it.getString("name"), it.getInt("size")) }.also {
                require(it.name.matches(hex64) && it.size == pieceSize(size.toInt(), index) + 28) { invalid }
            }
        }
        val bytes = if (count == 0) CloudCrypto.decode(value.getString("content")).also { require(it.size.toLong() == size && CloudCrypto.sha256Hex(it) == hash) { invalid } } else null
        return CloudManifest(id, revision, path, deleted, size.toInt(), CloudCrypto.encode(hash.chunked(2).map { it.toInt(16).toByte() }.toByteArray()), pieces, bytes)
    }

    /** The file's bytes from its manifest, piece by piece; each piece and the whole file are checked. */
    fun readPieces(manifest: CloudManifest): ByteArray {
        manifest.bytes?.let { return it }
        val bytes = ByteArray(manifest.size)
        for ((index, piece) in manifest.pieces.withIndex()) {
            val sealed = requestBytes(credentials.url, "/chunks/${piece.name}", "GET", null, credentials, limitSeconds = 300)
            require(sealed.size == piece.size && CloudCrypto.sha256Hex(sealed) == piece.name) { "An encrypted piece did not match. No local files were changed." }
            CloudCrypto.decryptChunk(credentials.vaultKey, credentials.vaultId, manifest.id, index, sealed).copyInto(bytes, index * CloudCrypto.CHUNK_BYTES)
        }
        require(CloudSyncEngine.hash(bytes) == manifest.hash) { "Encrypted file validation failed. No local files were changed." }
        return bytes
    }

    private fun seal(id: String, index: Int, bytes: ByteArray): ByteArray = CloudCrypto.encryptChunk(credentials.vaultKey, credentials.vaultId, id, index,
        bytes.copyOfRange(index * CloudCrypto.CHUNK_BYTES, index * CloudCrypto.CHUNK_BYTES + pieceSize(bytes.size, index)))

    /**
     * A v2 object, as cloud/shared/client.mjs: an encrypted manifest (path, size, fingerprint, pieces) plus encrypted
     * pieces of 1 MiB. Only the piece names are kept, so a prepared write stays small; [commitWrite] encrypts the
     * pieces again from the file, which gives the same bytes.
     */
    fun prepareWrite(path: String, bytes: ByteArray, baseRevision: Int): CloudPreparedUpload {
        CloudCrypto.safePath(path)
        require(bytes.size <= CloudCrypto.MAX_CHUNKED_BYTES && baseRevision in 0 until Int.MAX_VALUE) { "Invalid cloud file or revision" }
        val id = CloudCrypto.objectId(credentials.vaultKey, path)
        val chunks = if (bytes.size > CloudCrypto.INLINE_BYTES) List(pieces(bytes.size)) { CloudCrypto.sha256Hex(seal(id, it, bytes)) } else emptyList()
        val manifest = JSONObject().put("v", 2).put("path", path).put("modifiedAt", Instant.now().toString()).put("size", bytes.size).put("hash", CloudCrypto.sha256Hex(bytes))
            .put("chunks", JSONArray(chunks.mapIndexed { index, name -> JSONObject().put("name", name).put("size", pieceSize(bytes.size, index) + 28) }))
        if (chunks.isEmpty()) manifest.put("content", CloudCrypto.encode(bytes))
        val envelope = CloudCrypto.encrypt(credentials.vaultKey, manifest.toString().toByteArray(Charsets.UTF_8), "jotdrop:object:v1:${credentials.vaultId}:$id")
        return CloudPreparedUpload(id, baseRevision, envelope, chunks)
    }

    /** A saved upload's manifest; [CloudManifest.bytes] is null for a large v2 file, which the local file finishes. */
    fun preparedManifest(prepared: CloudPreparedUpload): CloudManifest {
        prepared.canonicalEnvelope()
        val value = JSONObject(utf8(CloudCrypto.decrypt(credentials.vaultKey, prepared.envelope, "jotdrop:object:v1:${credentials.vaultId}:${prepared.id}")))
        val manifest = manifest(prepared.id, prepared.baseRevision, false, value, CloudSyncEngine.path(value.getString("path")))
        require(prepared.chunks == null || prepared.chunks == manifest.pieces.map { it.name }) { "Invalid encrypted upload snapshot" }
        return manifest
    }

    /** The plan's maximum per file; a server without encrypted pieces takes 4 MiB. */
    fun maxFileBytes(): Long = call("/status").optJSONObject("pieces")?.optLong("maxFileBytes")?.takeIf { it > 0 } ?: CloudCrypto.MAX_FILE_BYTES.toLong()

    /** [source]: the file a v2 upload was prepared from, for the pieces the cloud does not have yet. */
    fun commitWrite(prepared: CloudPreparedUpload, source: ByteArray?, checkActive: () -> Unit): Int =
        prepared.chunks?.let { commitPieces(prepared, it, source, checkActive) } ?: commitEnvelope(prepared, checkActive)

    /** Uploads the pieces the cloud does not have yet, then saves the manifest, as `commitPieces` in cloud/shared/client.mjs. */
    private fun commitPieces(prepared: CloudPreparedUpload, names: List<String>, source: ByteArray?, checkActive: () -> Unit): Int {
        require(prepared.id.matches(hex64) && names.size <= pieces(CloudCrypto.MAX_CHUNKED_BYTES) && names.all { it.matches(hex64) }) { "Invalid prepared upload" }
        // One identical retry is safe for every transfer request, including a lost successful response.
        fun <T> retrying(block: () -> T): T {
            checkActive()
            return try { block() } catch (_: IOException) { checkActive(); block() }
        }
        // An older server would keep a manifest that older devices cannot read: never save there.
        val capability = retrying { call("/status") }.optJSONObject("pieces")
        check(capability?.optInt("version") == 1 && capability.optInt("pieceBytes") == CloudCrypto.CHUNK_BYTES) { "This server does not support encrypted pieces. The encrypted draft was kept." }
        val missing = if (names.isEmpty()) emptySet() else retrying { call("/chunks/missing", "POST", JSONObject().put("names", JSONArray(names))) }
            .getJSONArray("missing").let { list -> List(list.length()) { list.getString(it) }.toSet() }
        if (missing.isNotEmpty() && source == null) throw CloudSourceMissingException()
        for ((index, name) in names.withIndex()) {
            if (name !in missing) continue
            val sealed = seal(prepared.id, index, requireNotNull(source))
            check(CloudCrypto.sha256Hex(sealed) == name) { "The file changed after it was prepared. The encrypted draft was kept." }
            // A piece of 1 MiB on a slow line: allow minutes, like a download.
            retrying { request(credentials.url, "/chunks/$name", "PUT", null, credentials, sealed, true, 300) }
        }
        checkActive()
        // Not retried: a lost answer comes back as 409 or as the same receipt on the next sync.
        val saved = request(credentials.url, objectPath(prepared.id), "PUT", JSONObject().put("baseRevision", prepared.baseRevision)
            .put("envelope", prepared.canonicalEnvelope()).put("chunks", JSONArray(names)), credentials)
        require(saved.getString("id") == prepared.id && revision(saved) == prepared.baseRevision + 1) { "Invalid cloud write acknowledgment" }
        return prepared.baseRevision + 1
    }

    /** A v1 draft saved before this version: the single-envelope upload. */
    private fun commitEnvelope(prepared: CloudPreparedUpload, checkActive: () -> Unit): Int = CloudUpload.commit(prepared, checkActive) { path, method, body, binary ->
        val result = request(credentials.url, path, method, null, credentials, body, binary)
        when {
            path == "/status" -> result.getJSONObject("transport").let {
                require(integer(it, "version") == 1L && integer(it, "chunkBytes") == 65536L) { "Resumable v1 uploads are unavailable. The encrypted draft was kept." }
                CloudUploadReply(version = 1, chunkBytes = 65536)
            }
            result.has("committed") -> result.getJSONObject("committed").let {
                val version = integer(it, "revision")
                require(version in 1..Int.MAX_VALUE.toLong()) { "Invalid upload revision" }
                CloudUploadReply(committed = CloudUploadReceipt(it.getString("id"), version.toInt(), integer(it, "sequence")))
            }
            else -> {
                val offset = integer(result, "offset")
                val size = integer(result, "size")
                require(offset in 0..6 * 1024 * 1024L && size in 28..6 * 1024 * 1024L) { "Invalid upload acknowledgment" }
                CloudUploadReply(offset.toInt(), size.toInt())
            }
        }
    }

    fun discardWrite(prepared: CloudPreparedUpload) {
        // A v2 upload leaves only pieces, which the server clears after a day when no version uses them.
        if (prepared.chunks != null) return
        try { call(prepared.uploadPath(), "DELETE") }
        catch (error: CloudRequestException) { if (error.status != 404 && error.status != 410) throw error }
    }

    internal fun call(path: String, method: String = "GET", body: JSONObject? = null): JSONObject = request(credentials.url, path, method, body, credentials)
    private fun objectPath(id: String): String {
        require(id.matches(Regex("[0-9a-f]{64}"))) { "Invalid cloud object identity" }
        return "/objects/$id"
    }
    fun remove(id: String, baseRevision: Int): Int {
        require(baseRevision > 0) { "Invalid cloud revision" }
        return revision(call(objectPath(id), "DELETE", JSONObject().put("baseRevision", baseRevision)))
    }
    fun history(id: String): JSONObject = call("${objectPath(id)}/history")
    fun restore(id: String, version: Int, baseRevision: Int): Int {
        require(version > 0 && baseRevision > 0) { "Invalid cloud revision" }
        return revision(call("${objectPath(id)}/restore", "POST", JSONObject().put("revision", version).put("baseRevision", baseRevision)))
    }
    fun devices(): JSONObject = call("/devices")
    fun revokeDevice(id: String) {
        require(validId(id) && id != credentials.deviceId) { "Use another device to revoke this device" }
        call("/devices/$id", "DELETE")
    }
    fun makePairing(deviceName: String): Pair<String, String> {
        require(deviceName.isNotBlank() && deviceName.length <= 80 && deviceName.none { it.code < 32 }) { "Enter a device name of 1 to 80 characters" }
        val token = CloudCrypto.token()
        val wrappingKey = CloudCrypto.token()
        val claimToken = CloudCrypto.token()
        val keys = JSONObject().put("vaultId", credentials.vaultId).put("vaultKey", credentials.vaultKey).put("token", token)
        val envelope = CloudCrypto.encrypt(wrappingKey, keys.toString().toByteArray(Charsets.UTF_8), "jotdrop:pairing:v1")
        val response = call("/pairings", "POST", JSONObject().put("deviceName", deviceName.trim())
            .put("deviceTokenHash", CloudCrypto.hashToken(token)).put("claimTokenHash", CloudCrypto.hashToken(claimToken))
            .put("envelope", envelopeJson(envelope).toString()))
        val id = response.getString("pairingId")
        require(validId(id)) { "Invalid pairing identity" }
        val code = JSONObject().put("v", 1).put("url", secureOrigin(credentials.url)).put("pairingId", id)
            .put("claimToken", claimToken).put("wrappingKey", wrappingKey)
        return CloudCrypto.encode(code.toString().toByteArray(Charsets.UTF_8)) to response.getString("expiresAt")
    }

    companion object {
        private val deadlines = ScheduledThreadPoolExecutor(1) { runnable -> Thread(runnable, "JotDropCloudDeadline").apply { isDaemon = true } }
            .apply { removeOnCancelPolicy = true }
        private val hex64 = Regex("[0-9a-f]{64}")
        private fun pieces(size: Int): Int = (size + CloudCrypto.CHUNK_BYTES - 1) / CloudCrypto.CHUNK_BYTES
        private fun pieceSize(size: Int, index: Int): Int = minOf(CloudCrypto.CHUNK_BYTES, size - index * CloudCrypto.CHUNK_BYTES)
        private fun integer(json: JSONObject, name: String): Long {
            val value = json.get(name)
            require(value is Int || value is Long) { "Invalid upload acknowledgment" }
            return (value as Number).toLong()
        }
        private fun validId(value: String): Boolean = value.matches(Regex("(?i)[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"))
        private fun revision(json: JSONObject): Int = json.getLong("revision").also { require(it in 1..Int.MAX_VALUE.toLong()) { "Invalid cloud revision" } }.toInt()
        private fun serverError(connection: HttpURLConnection): JSONObject? = runCatching {
            val bytes = connection.errorStream?.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(1024)
                while (output.size() <= 16384) { val count = input.read(buffer); if (count < 0) break; output.write(buffer, 0, count) }
                output.toByteArray()
            } ?: return null
            if (bytes.size > 16384) return null
            JSONObject(utf8(bytes))
        }.getOrNull()
        private fun plainText(value: String?, limit: Int): String? = value?.takeIf { it.isNotBlank() && it.length <= limit && it.none { char -> char.code < 32 } }
        private fun requestFailure(status: Int, error: JSONObject?): CloudRequestException {
            val list = error?.optJSONArray("devices")
            val devices = (0 until (list?.length() ?: 0)).mapNotNull { index ->
                val device = list?.optJSONObject(index) ?: return@mapNotNull null
                val name = plainText(device.optString("name"), 80) ?: return@mapNotNull null
                device.optString("id").takeIf(::validId)?.let { CloudDeviceInfo(it, name, device.optString("lastSeenAt")) }
            }
            return CloudRequestException(status, plainText(error?.optString("error"), 200), plainText(error?.optString("code"), 40), devices)
        }
        private fun utf8(bytes: ByteArray): String = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
        fun secureOrigin(value: String): String {
            val uri = URI(value)
            require(uri.scheme == "https" && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null && (uri.path.isNullOrEmpty() || uri.path == "/")) { "Android preview requires an HTTPS server. The local HTTP browser preview cannot be paired with Android; TLS protection is never bypassed." }
            return value.trimEnd('/')
        }
        fun envelopeJson(value: CloudEnvelope): JSONObject = JSONObject().put("v", 1).put("iv", value.iv).put("ciphertext", value.ciphertext)
        fun parseEnvelope(value: String): CloudEnvelope {
            val json = JSONObject(value)
            require(json.getInt("v") == 1) { "Unsupported cloud encryption version" }
            return CloudEnvelope(json.getString("iv"), json.getString("ciphertext"))
        }
        fun claim(pairingCode: String): CloudClient {
            require(pairingCode.length <= 4096) { "Pairing code is too long" }
            val pairing = JSONObject(utf8(CloudCrypto.decode(pairingCode)))
            require(pairing.getInt("v") == 1 && validId(pairing.getString("pairingId"))) { "Invalid pairing code" }
            val origin = secureOrigin(pairing.getString("url"))
            val claimToken = pairing.getString("claimToken")
            require(CloudCrypto.decode(claimToken).size == 32) { "Invalid claim token" }
            require(CloudCrypto.decode(pairing.getString("wrappingKey")).size == 32) { "Invalid pairing key" }
            val response = request(origin, "/pairings/${pairing.getString("pairingId")}/claim", "POST", JSONObject().put("claimToken", claimToken), null)
            val keys = JSONObject(utf8(CloudCrypto.decrypt(pairing.getString("wrappingKey"), parseEnvelope(response.getString("envelope")), "jotdrop:pairing:v1")))
            require(keys.getString("vaultId") == response.getString("vaultId")) { "Pairing workspace mismatch" }
            return CloudClient(CloudCredentials(origin, response.getString("vaultId"), response.getString("deviceId"), keys.getString("token"), keys.getString("vaultKey")))
        }
        // readTimeout already fails after 30s without bytes; limitSeconds bounds the whole request.
        internal fun request(origin: String, path: String, method: String, value: JSONObject?, auth: CloudCredentials?, body: ByteArray? = null, binary: Boolean = false, limitSeconds: Long = 30): JSONObject =
            exchange(origin, path, method, value, auth, body, binary, limitSeconds) { JSONObject(utf8(it)) }
        /** A successful body as bytes (an encrypted piece) instead of JSON. */
        internal fun requestBytes(origin: String, path: String, method: String, value: JSONObject?, auth: CloudCredentials?, limitSeconds: Long = 30): ByteArray =
            exchange(origin, path, method, value, auth, null, false, limitSeconds) { it }
        private fun <T> exchange(origin: String, path: String, method: String, value: JSONObject?, auth: CloudCredentials?, body: ByteArray?, binary: Boolean, limitSeconds: Long, decode: (ByteArray) -> T): T {
            val connection = URI(secureOrigin(origin) + "/api/v1" + path).toURL().openConnection() as HttpURLConnection
            val startedAt = System.nanoTime()
            val deadline = startedAt + TimeUnit.SECONDS.toNanos(limitSeconds)
            var phase = CloudDiagnostics.Phase.REQUEST_SETUP
            var receivedBytes = 0
            val timedOut = AtomicBoolean(false)
            val timeout = deadlines.schedule({ timedOut.set(true); connection.disconnect() }, limitSeconds, TimeUnit.SECONDS)
            try {
                connection.instanceFollowRedirects = false
                connection.connectTimeout = 10000
                connection.readTimeout = 30000
                connection.requestMethod = method
                connection.useCaches = false
                if (auth != null) {
                    connection.setRequestProperty("Authorization", "Bearer ${auth.token}")
                    connection.setRequestProperty("X-JotDrop-Vault", auth.vaultId)
                    connection.setRequestProperty("X-JotDrop-Device", auth.deviceId)
                }
                val bytes = body ?: value?.toString()?.toByteArray(Charsets.UTF_8)
                if (bytes != null) {
                    connection.setRequestProperty("Content-Type", if (binary) "application/octet-stream" else "application/json")
                    connection.doOutput = true
                    connection.setFixedLengthStreamingMode(bytes.size)
                    phase = CloudDiagnostics.Phase.REQUEST_SEND
                    connection.outputStream.use { it.write(bytes) }
                }
                phase = CloudDiagnostics.Phase.REQUEST_HEADERS
                val status = connection.responseCode
                if (status !in 200..299) throw requestFailure(status, serverError(connection))
                require(connection.contentLengthLong <= 12 * 1024 * 1024) { "Cloud response exceeds limit" }
                val output = ByteArrayOutputStream()
                phase = CloudDiagnostics.Phase.REQUEST_BODY
                connection.inputStream.use { input ->
                    val buffer = ByteArray(8192)
                    while (true) {
                        if (System.nanoTime() >= deadline) {
                            phase = CloudDiagnostics.Phase.REQUEST_DEADLINE
                            throw SocketTimeoutException("Cloud response deadline exceeded")
                        }
                        val count = input.read(buffer)
                        if (count < 0) break
                        require(output.size() + count <= 12 * 1024 * 1024) { "Cloud response exceeds limit" }
                        output.write(buffer, 0, count)
                        receivedBytes = output.size()
                    }
                }
                if (timedOut.get() || System.nanoTime() >= deadline) {
                    phase = CloudDiagnostics.Phase.REQUEST_DEADLINE
                    throw SocketTimeoutException("Cloud response deadline exceeded")
                }
                phase = CloudDiagnostics.Phase.REQUEST_DECODE
                return decode(output.toByteArray())
            } catch (error: Exception) {
                val failure = if (timedOut.get()) SocketTimeoutException("Cloud request deadline exceeded") else error
                if (timedOut.get()) phase = CloudDiagnostics.Phase.REQUEST_DEADLINE
                Log.w("JotDropCloud", CloudDiagnostics.failure(failure, phase, (System.nanoTime() - startedAt) / 1_000_000, receivedBytes))
                throw failure
            } finally { timeout.cancel(false); connection.disconnect() }
        }
    }
}

/** Android Keystore encryption plus no-backup files; credentials never enter preferences/backups. */
class CloudPreviewStore(context: Context) {
    companion object { private val lock = Any() }
    private val folder = File(context.noBackupFilesDir, "cloud-preview").also { check(it.mkdirs() || it.isDirectory) }
    private val alias = "jotdrop-cloud-preview-v1"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").also { it.load(null) }
        if (store.containsAlias(alias)) return store.getKey(alias, null) as SecretKey
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
            generateKey()
        }
    }
    private fun save(name: String, value: JSONObject) = synchronized(lock) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD("jotdrop:android:$name:v1".toByteArray(Charsets.UTF_8))
        val sealed = CloudClient.envelopeJson(CloudEnvelope(CloudCrypto.encode(cipher.iv), CloudCrypto.encode(cipher.doFinal(value.toString().toByteArray(Charsets.UTF_8)))))
        val file = AtomicFile(File(folder, name))
        val output = file.startWrite()
        val bytes = sealed.toString().toByteArray(Charsets.UTF_8)
        try {
            output.write(bytes)
            output.fd.sync()
            file.finishWrite(output)
        }
        catch (error: Exception) { file.failWrite(output); throw error }
        // Verify after finish, outside failWrite: older Android versions could delete the committed file on a late read error.
        file.openRead().use { input ->
            val actual = ByteArray(bytes.size)
            DataInputStream(input).readFully(actual)
            check(actual.contentEquals(bytes) && input.read() == -1) { "Encrypted preview save verification failed" }
        }
    }
    private fun load(name: String, maxBytes: Int = 8 * 1024 * 1024): JSONObject? = synchronized(lock) {
        val file = AtomicFile(File(folder, name))
        val sealed = try { file.openRead().use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                require(output.size() + count <= maxBytes) { "Encrypted preview file exceeds limit" }
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        } } catch (_: FileNotFoundException) { return@synchronized null }
        val envelope = CloudClient.parseEnvelope(String(sealed, Charsets.UTF_8))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, CloudCrypto.decode(envelope.iv)))
        cipher.updateAAD("jotdrop:android:$name:v1".toByteArray(Charsets.UTF_8))
        JSONObject(String(cipher.doFinal(CloudCrypto.decode(envelope.ciphertext)), Charsets.UTF_8))
    }
    fun credentials(): CloudCredentials? = load("connection")?.let(CloudCredentials::from)
    fun saveCredentials(value: CloudCredentials) = save("connection", value.json())
    fun disconnect() = synchronized(lock) { AtomicFile(File(folder, "connection")).delete() }
    private fun draftName(vaultId: String): String { UUID.fromString(vaultId); return "draft-$vaultId" }
    fun saveDraft(vaultId: String, draft: JSONObject) = save(draftName(vaultId), draft)
    fun draft(vaultId: String): JSONObject? = load(draftName(vaultId))
    // Large vaults keep large indexes; nothing else in a sync state grows with the number of files.
    fun syncState(scope: String): JSONObject? = load("sync-$scope", 32 * 1024 * 1024)
    fun saveSyncState(scope: String, value: JSONObject) = save("sync-$scope", value)
    private fun uploadName(scope: String, deviceId: String): String {
        require(scope.matches(Regex("[A-Za-z0-9_-]{43}"))) { "Invalid sync scope" }
        UUID.fromString(deviceId)
        return "upload-$scope-$deviceId"
    }
    fun upload(scope: String, deviceId: String): CloudPreparedUpload? = load(uploadName(scope, deviceId), 12 * 1024 * 1024)?.let {
        CloudPreparedUpload(it.getString("id"), it.getInt("baseRevision"), CloudClient.parseEnvelope(it.getString("envelope")),
            it.optJSONArray("chunks")?.let { names -> List(names.length()) { index -> names.getString(index) } })
    }
    fun hasUploads(deviceId: String): Boolean = synchronized(lock) {
        UUID.fromString(deviceId)
        val files = checkNotNull(folder.listFiles()) { "Encrypted upload storage is unavailable" }
        files.any { it.name.startsWith("upload-") && it.name.removeSuffix(".bak").endsWith("-$deviceId") }
    }
    /** One scope per local vault binding that still holds an encrypted upload for this device. */
    fun uploadScopes(deviceId: String): Set<String> = synchronized(lock) {
        UUID.fromString(deviceId)
        val files = checkNotNull(folder.listFiles()) { "Encrypted upload storage is unavailable" }
        files.map { it.name.removeSuffix(".bak") }.filter { it.startsWith("upload-") && it.endsWith("-$deviceId") }
            .map { it.removePrefix("upload-").removeSuffix("-$deviceId") }.toSet()
    }
    fun saveUpload(scope: String, deviceId: String, value: CloudPreparedUpload) = synchronized(lock) {
        check(!hasUploads(deviceId)) { "Resume or recover the previous encrypted upload before changing files or vaults" }
        save(uploadName(scope, deviceId), JSONObject().put("id", value.id).put("baseRevision", value.baseRevision).put("envelope", value.canonicalEnvelope())
            .put("chunks", value.chunks?.let { JSONArray(it) }))
    }
    fun clearUpload(scope: String, deviceId: String) = synchronized(lock) {
        val file = AtomicFile(File(folder, uploadName(scope, deviceId)))
        file.delete()
        check(listOf("", ".bak", ".new").none { File(file.baseFile.path + it).exists() }) { "Encrypted upload cleanup failed" }
    }
    /** A new recovery code waits here, encrypted, until the user confirms saving it; the process may die meanwhile. */
    fun recoveryCode(): String? = load("recovery-code")?.getString("code")
    fun saveRecoveryCode(code: String) = save("recovery-code", JSONObject().put("code", code))
    fun clearRecoveryCode() = synchronized(lock) { AtomicFile(File(folder, "recovery-code")).delete() }
    /** A Google or GitHub sign-in waits here for the browser to come back; the process may die meanwhile. */
    fun providerStart(): JSONObject? = load("provider-start")
    fun saveProviderStart(value: JSONObject) = save("provider-start", value)
    fun clearProviderStart() = synchronized(lock) { AtomicFile(File(folder, "provider-start")).delete() }
    fun settings(): JSONObject = load("sync-settings") ?: JSONObject()
    fun saveSettings(value: JSONObject) = save("sync-settings", value)
}

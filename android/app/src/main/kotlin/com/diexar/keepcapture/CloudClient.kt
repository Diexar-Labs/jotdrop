package com.diexar.keepcapture

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.net.HttpURLConnection
import java.net.URI
import java.security.KeyStore
import java.time.Instant
import java.util.UUID
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

data class CloudPreviewFile(val id: String, val revision: Int, val path: String, val bytes: ByteArray, val deleted: Boolean)
class CloudRequestException(val status: Int) : Exception(if (status == 409) "A newer cloud version exists. Your local draft was kept; refresh and compare before saving." else "Cloud request failed ($status). Your local draft was kept.")

/** Encrypted HTTPS transport; local vault access belongs to the sync adapter. */
class CloudClient(val credentials: CloudCredentials) {
    init {
        secureOrigin(credentials.url)
        require(validId(credentials.vaultId) && validId(credentials.deviceId)) { "Invalid cloud device identity" }
        require(CloudCrypto.decode(credentials.token).size == 32 && CloudCrypto.decode(credentials.vaultKey).size == 32) { "Invalid cloud credentials" }
    }

    fun changesAndFiles(checkActive: () -> Unit = {}): List<CloudPreviewFile> {
        var cursor = 0L
        val ids = linkedSetOf<String>()
        do {
            checkActive()
            val page = request(credentials.url, "/changes?after=$cursor", "GET", null, credentials)
            val changes = page.getJSONArray("changes")
            for (index in 0 until changes.length()) ids += changes.getJSONObject(index).getString("id")
            require(ids.size <= 500) { "The local preview supports at most 500 files" }
            val next = page.getLong("cursor")
            val more = page.getBoolean("hasMore")
            require(!more || next > cursor) { "Invalid cloud changes cursor" }
            cursor = next
        } while (more)
        var total = 0L
        return ids.map { id -> checkActive(); read(id).also { total += it.bytes.size; require(total <= 64 * 1024 * 1024) { "Cloud sync working set exceeds 64 MiB" } } }
    }

    fun read(id: String): CloudPreviewFile {
        require(id.matches(Regex("[0-9a-f]{64}"))) { "Invalid cloud object identity" }
        val response = request(credentials.url, "/objects/$id", "GET", null, credentials)
        val encrypted = parseEnvelope(response.getString("envelope"))
        val payload = JSONObject(utf8(CloudCrypto.decrypt(credentials.vaultKey, encrypted, "jotdrop:object:v1:${credentials.vaultId}:$id")))
        val path = CloudCrypto.safePath(payload.getString("path"))
        require(CloudCrypto.objectId(credentials.vaultKey, path) == id) { "Encrypted file identity does not match" }
        val bytes = CloudCrypto.decode(payload.getString("content"))
        require(bytes.size <= CloudCrypto.MAX_FILE_BYTES) { "Cloud file exceeds the 4 MiB preview limit" }
        Instant.parse(payload.getString("modifiedAt"))
        return CloudPreviewFile(id, revision(response), path, bytes, response.getBoolean("deleted"))
    }

    fun writeNote(path: String, content: String, baseRevision: Int): Int {
        require(path.startsWith("notes/") && path.endsWith(".md", ignoreCase = true) && baseRevision >= 0) { "Use a Markdown filename in notes/" }
        CloudCrypto.safePath(path)
        val bytes = content.toByteArray(Charsets.UTF_8)
        require(bytes.size <= CloudCrypto.MAX_FILE_BYTES) { "Preview notes must be 4 MiB or smaller" }
        return write(path, bytes, baseRevision)
    }

    fun write(path: String, bytes: ByteArray, baseRevision: Int): Int {
        CloudCrypto.safePath(path)
        require(bytes.size <= CloudCrypto.MAX_FILE_BYTES && baseRevision >= 0) { "Invalid cloud file or revision" }
        val id = CloudCrypto.objectId(credentials.vaultKey, path)
        val payload = JSONObject().put("path", path).put("content", CloudCrypto.encode(bytes)).put("modifiedAt", Instant.now().toString())
        val envelope = CloudCrypto.encrypt(credentials.vaultKey, payload.toString().toByteArray(Charsets.UTF_8), "jotdrop:object:v1:${credentials.vaultId}:$id")
        return revision(call("/objects/$id", "PUT", JSONObject().put("baseRevision", baseRevision).put("envelope", envelopeJson(envelope).toString())))
    }

    private fun call(path: String, method: String = "GET", body: JSONObject? = null): JSONObject = request(credentials.url, path, method, body, credentials)
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
        private fun validId(value: String): Boolean = value.matches(Regex("(?i)[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"))
        private fun revision(json: JSONObject): Int = json.getLong("revision").also { require(it in 1..Int.MAX_VALUE.toLong()) { "Invalid cloud revision" } }.toInt()
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
        private fun request(origin: String, path: String, method: String, value: JSONObject?, auth: CloudCredentials?): JSONObject {
            val connection = URI(secureOrigin(origin) + "/api/v1" + path).toURL().openConnection() as HttpURLConnection
            val startedAt = System.nanoTime()
            val deadline = startedAt + 30_000_000_000L
            var phase = CloudDiagnostics.Phase.REQUEST_SETUP
            var receivedBytes = 0
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
                if (value != null) {
                    val bytes = value.toString().toByteArray(Charsets.UTF_8)
                    connection.setRequestProperty("Content-Type", "application/json")
                    connection.doOutput = true
                    connection.setFixedLengthStreamingMode(bytes.size)
                    phase = CloudDiagnostics.Phase.REQUEST_SEND
                    connection.outputStream.use { it.write(bytes) }
                }
                phase = CloudDiagnostics.Phase.REQUEST_HEADERS
                val status = connection.responseCode
                if (status !in 200..299) throw CloudRequestException(status)
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
                if (System.nanoTime() >= deadline) {
                    phase = CloudDiagnostics.Phase.REQUEST_DEADLINE
                    throw SocketTimeoutException("Cloud response deadline exceeded")
                }
                phase = CloudDiagnostics.Phase.REQUEST_DECODE
                return JSONObject(utf8(output.toByteArray()))
            } catch (error: Exception) {
                Log.w("JotDropCloud", CloudDiagnostics.failure(error, phase, (System.nanoTime() - startedAt) / 1_000_000, receivedBytes))
                throw error
            } finally { connection.disconnect() }
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
        try { output.write(sealed.toString().toByteArray(Charsets.UTF_8)); file.finishWrite(output) }
        catch (error: Exception) { file.failWrite(output); throw error }
    }
    private fun load(name: String): JSONObject? = synchronized(lock) {
        val file = AtomicFile(File(folder, name))
        val sealed = try { file.openRead().use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                require(output.size() + count <= 8 * 1024 * 1024) { "Encrypted preview file exceeds limit" }
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
    fun syncState(scope: String): JSONObject? = load("sync-$scope")
    fun saveSyncState(scope: String, value: JSONObject) = save("sync-$scope", value)
    fun settings(): JSONObject = load("sync-settings") ?: JSONObject()
    fun saveSettings(value: JSONObject) = save("sync-settings", value)
}

package com.diexar.keepcapture

import java.io.IOException
import java.net.SocketTimeoutException
import java.security.MessageDigest

data class CloudPreparedUpload(val id: String, val baseRevision: Int, val envelope: CloudEnvelope) {
    fun canonicalEnvelope(): String {
        require(id.matches(Regex("[0-9a-f]{64}")) && baseRevision in 0 until Int.MAX_VALUE) { "Invalid prepared upload" }
        val iv = CloudCrypto.decode(envelope.iv)
        val ciphertext = CloudCrypto.decode(envelope.ciphertext)
        require(iv.size == 12 && ciphertext.size >= 16 && iv.size + ciphertext.size <= 6 * 1024 * 1024) { "Invalid binary envelope" }
        return """{"v":1,"iv":"${envelope.iv}","ciphertext":"${envelope.ciphertext}"}""".also {
            require(it.length <= 8 * 1024 * 1024) { "Cloud envelope exceeds limit" }
        }
    }

    fun uploadPath(): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(canonicalEnvelope().toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 255) }
        return "/objects/$id/uploads/$baseRevision/$digest"
    }
}

data class CloudUploadReceipt(val id: String, val revision: Int, val sequence: Long)
data class CloudUploadReply(val offset: Int = -1, val size: Int = -1, val committed: CloudUploadReceipt? = null,
    val version: Int = 0, val chunkBytes: Int = 0)

/** Portable v1 protocol. The caller must durably seal the prepared upload before entering. */
object CloudUpload {
    fun commit(prepared: CloudPreparedUpload, checkActive: () -> Unit = {},
        send: (String, String, ByteArray?, Boolean) -> CloudUploadReply): Int {
        val route = prepared.uploadPath()
        val wire = CloudCrypto.decode(prepared.envelope.iv) + CloudCrypto.decode(prepared.envelope.ciphertext)
        val deadline = System.nanoTime() + 600_000_000_000L
        fun active() {
            checkActive()
            if (System.nanoTime() >= deadline) throw SocketTimeoutException("Cloud upload attempt deadline exceeded")
        }
        fun request(path: String, method: String = "GET", body: ByteArray? = null, binary: Boolean = false): CloudUploadReply {
            active()
            val result = try { send(path, method, body, binary) }
            catch (error: IOException) { active(); send(path, method, body, binary) }
            active()
            return result
        }
        val capability = request("/status")
        require(capability.version == 1 && capability.chunkBytes == 65536) { "Resumable v1 uploads are unavailable. The encrypted draft was kept." }
        var state = request(route, "POST", """{"size":${wire.size}}""".toByteArray(Charsets.UTF_8))
        var previous = 0
        while (state.committed == null) {
            require(state.size == wire.size && state.offset in previous..wire.size) { "Invalid upload acknowledgment. The encrypted draft was kept." }
            if (state.offset == wire.size) {
                state = request("$route/commit", "POST", "{}".toByteArray(Charsets.UTF_8))
                require(state.committed != null) { "Missing upload commit acknowledgment. The encrypted draft was kept." }
            } else {
                val end = minOf(state.offset + capability.chunkBytes, wire.size)
                state = request("$route?offset=${state.offset}", "PUT", wire.copyOfRange(state.offset, end), true)
                previous = end
            }
        }
        val receipt = requireNotNull(state.committed)
        require(receipt.id == prepared.id && receipt.revision == prepared.baseRevision + 1 && receipt.sequence in 1..9007199254740991L) {
            "Invalid upload commit acknowledgment. The encrypted draft was kept."
        }
        return receipt.revision
    }
}

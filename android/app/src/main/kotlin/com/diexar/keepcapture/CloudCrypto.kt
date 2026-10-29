package com.diexar.keepcapture

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

data class CloudEnvelope(val iv: String, val ciphertext: String)

/** WebCrypto-compatible primitives. No storage, networking or Android dependencies. */
object CloudCrypto {
    const val MAX_FILE_BYTES = 4 * 1024 * 1024
    private val random = SecureRandom()
    private val forbidden = setOf(".obsidian", ".git", ".stfolder", ".stignore", ".stversions")

    fun encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun decode(value: String): ByteArray {
        require(value.length <= 16 * 1024 * 1024 && value.matches(Regex("[A-Za-z0-9_-]*"))) { "Invalid encoded data" }
        val bytes = Base64.getUrlDecoder().decode(value)
        require(encode(bytes) == value) { "Noncanonical encoded data" }
        return bytes
    }

    private fun key(value: String): ByteArray = decode(value).also { require(it.size == 32) { "Invalid cloud key" } }

    fun token(): String = encode(ByteArray(32).also(random::nextBytes))
    fun hashToken(value: String): String {
        key(value)
        return MessageDigest.getInstance("SHA-256").digest(value.toByteArray(StandardCharsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }
    }

    fun safePath(value: String): String {
        require(value.isNotEmpty() && value.length <= 512 && value.none { it == '\\' || it == ':' || it.code < 32 || it.code == 127 }) { "Unsafe cloud filename" }
        require(value.split('/').none { it.isEmpty() || it == "." || it == ".." || it.lowercase() in forbidden }) { "Unsafe cloud path" }
        return value
    }

    fun objectId(vaultKey: String, path: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key(vaultKey), "HmacSHA256"))
        return mac.doFinal("jotdrop:path:v1:${safePath(path)}".toByteArray(StandardCharsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }
    }

    fun encrypt(vaultKey: String, bytes: ByteArray, aad: String): CloudEnvelope {
        val iv = ByteArray(12).also(random::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key(vaultKey), "AES"), GCMParameterSpec(128, iv))
        cipher.updateAAD(aad.toByteArray(StandardCharsets.UTF_8))
        return CloudEnvelope(encode(iv), encode(cipher.doFinal(bytes)))
    }

    // v2 objects, as cloud/shared/crypto.mjs: a file goes in encrypted pieces of 1 MiB, small files stay inside the manifest.
    const val CHUNK_BYTES = 1024 * 1024
    const val INLINE_BYTES = 64 * 1024
    /** The largest plan maximum (JotDrop Plus); the server enforces each plan's own maximum. */
    const val MAX_CHUNKED_BYTES = 200 * 1024 * 1024

    fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }

    private fun chunkAad(vaultId: String, id: String, index: Int) = "jotdrop:chunk:v1:$vaultId:$id:$index".toByteArray(StandardCharsets.UTF_8)

    /** `iv || ciphertext+tag`. The IV follows from the piece itself, so the same piece gives the same bytes and an interrupted upload resumes. */
    fun encryptChunk(vaultKey: String, vaultId: String, id: String, index: Int, plain: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key(vaultKey), "HmacSHA256"))
        val iv = mac.doFinal("jotdrop:chunk-iv:v1:$id:$index:${sha256Hex(plain)}".toByteArray(StandardCharsets.UTF_8)).copyOf(12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key(vaultKey), "AES"), GCMParameterSpec(128, iv))
        cipher.updateAAD(chunkAad(vaultId, id, index))
        return iv + cipher.doFinal(plain)
    }

    fun decryptChunk(vaultKey: String, vaultId: String, id: String, index: Int, sealed: ByteArray): ByteArray {
        require(sealed.size in 28..CHUNK_BYTES + 28) { "Invalid encrypted piece" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key(vaultKey), "AES"), GCMParameterSpec(128, sealed, 0, 12))
        cipher.updateAAD(chunkAad(vaultId, id, index))
        return cipher.doFinal(sealed, 12, sealed.size - 12)
    }

    fun decrypt(vaultKey: String, envelope: CloudEnvelope, aad: String): ByteArray {
        val iv = decode(envelope.iv)
        val bytes = decode(envelope.ciphertext)
        require(iv.size == 12 && bytes.size >= 16) { "Invalid encrypted envelope" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key(vaultKey), "AES"), GCMParameterSpec(128, iv))
        cipher.updateAAD(aad.toByteArray(StandardCharsets.UTF_8))
        return cipher.doFinal(bytes)
    }
}

package com.diexar.keepcapture

import java.io.File

fun main(args: Array<String>) {
    fun rejects(action: () -> Unit) {
        check(runCatching(action).isFailure) { "Invalid input was accepted" }
    }
    for (path in listOf("../secret", "/root", "notes//x", "C:\\x", ".obsidian/token", "notes/../x", "notes/.git/config", ".stfolder/x", ".stversions/x")) {
        rejects { CloudCrypto.safePath(path) }
    }
    for (value in listOf("=", "a", "a+", "ab")) rejects { CloudCrypto.decode(value) }
    val output = File(args[0]).readLines().map { line ->
        val fields = line.split('\t')
        check(fields.size == 8)
        val (key, encodedPath, encodedAad, plaintext, iv) = fields
        val ciphertext = fields[5]
        val expectedId = fields[6]
        val expectedHash = fields[7]
        val path = String(CloudCrypto.decode(encodedPath), Charsets.UTF_8)
        val aad = String(CloudCrypto.decode(encodedAad), Charsets.UTF_8)
        val bytes = CloudCrypto.decode(plaintext)
        val envelope = CloudEnvelope(iv, ciphertext)
        check(CloudCrypto.objectId(key, path) == expectedId)
        check(CloudCrypto.hashToken(key) == expectedHash)
        check(CloudCrypto.decrypt(key, envelope, aad).contentEquals(bytes))
        rejects { CloudCrypto.decrypt(CloudCrypto.token(), envelope, aad) }
        rejects { CloudCrypto.decrypt(key, envelope, "$aad:wrong") }
        val corrupted = CloudCrypto.decode(ciphertext).also { it[0] = (it[0].toInt() xor 1).toByte() }
        rejects { CloudCrypto.decrypt(key, CloudEnvelope(iv, CloudCrypto.encode(corrupted)), aad) }
        rejects { CloudCrypto.decrypt(key, CloudEnvelope(CloudCrypto.encode(ByteArray(11)), ciphertext), aad) }
        rejects { CloudCrypto.decrypt(key, CloudEnvelope(iv, CloudCrypto.encode(ByteArray(15))), aad) }
        rejects { CloudCrypto.encrypt(CloudCrypto.encode(ByteArray(31)), bytes, aad) }
        val encrypted = CloudCrypto.encrypt(key, bytes, aad)
        check(encrypted.iv != CloudCrypto.encrypt(key, bytes, aad).iv)
        val prepared = CloudPreparedUpload(expectedId, 0, encrypted)
        listOf(encrypted.iv, encrypted.ciphertext, prepared.uploadPath()).joinToString("\t")
    }
    File(args[1]).writeText(output.joinToString("\n"))
    println("Android JVM crypto checks passed (${output.size} cross-runtime vectors)")
}

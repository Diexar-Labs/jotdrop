package com.diexar.keepcapture

import java.io.File
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.spec.PKCS8EncodedKeySpec

fun main(args: Array<String>) {
    fun rejects(action: () -> Unit) {
        check(runCatching(action).isFailure) { "Invalid input was accepted" }
    }
    fun text(value: String): String = String(CloudCrypto.decode(value), Charsets.UTF_8)

    val words = CloudWords.WORDS
    check(words.size == 2048 && words.toSet().size == 2048)
    val listHash = MessageDigest.getInstance("SHA-256").digest((words.joinToString("\n") + "\n").toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it.toInt() and 255) }
    check(listHash == "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda") { "Word list differs from BIP39" }

    val salt = CloudCrypto.encode(ByteArray(16))
    for ((memory, passes, parallelism) in listOf(Triple(65535L, 3L, 1L), Triple(1048577L, 3L, 1L), Triple(65536L, 2L, 1L), Triple(65536L, 11L, 1L), Triple(65536L, 3L, 0L), Triple(65536L, 3L, 5L))) {
        rejects { CloudKdf.checked(salt, memory, passes, parallelism) }
    }
    rejects { CloudKdf.checked(CloudCrypto.encode(ByteArray(15)), 65536, 3, 1) }
    rejects { CloudKdf.checked("not base64!", 65536, 3, 1) }
    rejects { CloudAccountCrypto.password("short") }
    rejects { CloudAccountCrypto.deriveKeys("x".repeat(1025), CloudAccountCrypto.newKdf()) }
    check(CloudCrypto.decode(CloudAccountCrypto.newKdf().salt).size == 16)

    val keyFactory = KeyFactory.getInstance("EC")
    val output = File(args[0]).readLines().map { line ->
        val fields = line.split('\t')
        when (fields[0]) {
            "kdf" -> {
                val keys = CloudAccountCrypto.deriveKeys(text(fields[1]), CloudKdf.checked(fields[2], fields[3].toLong(), fields[4].toLong(), fields[5].toLong()))
                check(keys.authKey == fields[6] && keys.unlockKey == fields[7]) { "Argon2id/HKDF keys differ from JavaScript" }
                "ok"
            }
            "wrap" -> {
                val unlockKey = fields[1]
                check(CloudCrypto.decrypt(unlockKey, CloudEnvelope(fields[3], fields[4]), CloudAccountCrypto.WRAP_AAD).contentEquals(CloudCrypto.decode(fields[2])))
                rejects { CloudCrypto.decrypt(unlockKey, CloudEnvelope(fields[3], fields[4]), "jotdrop:wrap:v2") }
                val sealed = CloudCrypto.encrypt(unlockKey, CloudCrypto.decode(fields[2]), CloudAccountCrypto.WRAP_AAD)
                "${sealed.iv}\t${sealed.ciphertext}"
            }
            "words" -> {
                check(CloudAccountCrypto.verificationWords(fields[1]).joinToString(" ") == fields[2]) { "Verification words differ from JavaScript" }
                "ok"
            }
            "ecdh" -> {
                val private = keyFactory.generatePrivate(PKCS8EncodedKeySpec(CloudCrypto.decode(fields[1])))
                check(CloudAccountCrypto.approvalKey(private, fields[2], fields[3]) == fields[4]) { "Approval key differs from JavaScript" }
                rejects { CloudAccountCrypto.approvalKey(private, fields[2], fields[3] + "x").also { check(it == fields[4]) } }
                "ok"
            }
            "ecdh-new" -> {
                val keys = CloudAccountCrypto.newApprovalKeys()
                "${CloudAccountCrypto.exportPublic(keys)}\t${CloudAccountCrypto.approvalKey(keys.private, fields[1], fields[2])}"
            }
            "bad-public" -> {
                val keys = CloudAccountCrypto.newApprovalKeys()
                rejects { CloudAccountCrypto.approvalKey(keys.private, fields[1], "00000000-0000-4000-8000-000000000001") }
                "ok"
            }
            else -> error("Unknown vector ${fields[0]}")
        }
    }
    File(args[1]).writeText(output.joinToString("\n"))
    println("Android JVM account checks passed (${output.size} cross-runtime vectors)")
}

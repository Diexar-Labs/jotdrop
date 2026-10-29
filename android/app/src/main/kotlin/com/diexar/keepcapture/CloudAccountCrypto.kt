package com.diexar.keepcapture

import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import java.math.BigInteger
import java.nio.charset.StandardCharsets
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.text.Normalizer
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

data class CloudKdf(val salt: String, val memory: Int, val passes: Int, val parallelism: Int) {
    companion object {
        /** Settings come from the server at login, so a malicious server must not be able to make them weak or huge. */
        fun checked(salt: String, memory: Long, passes: Long, parallelism: Long): CloudKdf {
            val bytes = runCatching { CloudCrypto.decode(salt) }.getOrNull()
            require(bytes?.size == 16 && memory in 65536..1048576 && passes in 3..10 && parallelism in 1..4) { "The server sent invalid key derivation settings." }
            return CloudKdf(salt, memory.toInt(), passes.toInt(), parallelism.toInt())
        }
    }
}

data class CloudAccountKeys(val authKey: String, val unlockKey: String)

/** Account key derivation and device approval, matching cloud/shared/account.mjs. No storage, networking or Android dependencies. */
object CloudAccountCrypto {
    const val WRAP_AAD = "jotdrop:wrap:v1"
    private val random = SecureRandom()

    fun newKdf(): CloudKdf = CloudKdf(CloudCrypto.encode(ByteArray(16).also(random::nextBytes)), 65536, 3, 1)

    fun password(value: String): String {
        require(value.length in 12..1024) { "Use a password of 12 to 1024 characters." }
        return value
    }

    /** Argon2id, then HKDF into a login key (sent to the server) and an unlock key (stays here). */
    fun deriveKeys(value: String, kdf: CloudKdf): CloudAccountKeys {
        require(value.length <= 1024) { "Use a password of at most 1024 characters." }
        val settings = CloudKdf.checked(kdf.salt, kdf.memory.toLong(), kdf.passes.toLong(), kdf.parallelism.toLong())
        // Bouncy Castle keeps all Argon2 memory on the Java heap; settings the server sends must not crash the app.
        check(settings.memory * 1024L <= Runtime.getRuntime().maxMemory() / 2) { "This device does not have enough memory for the server's sign-in settings." }
        val generator = Argon2BytesGenerator()
        generator.init(Argon2Parameters.Builder(Argon2Parameters.ARGON2_id).withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withSalt(CloudCrypto.decode(settings.salt)).withIterations(settings.passes).withMemoryAsKB(settings.memory)
            .withParallelism(settings.parallelism).build())
        val master = ByteArray(32)
        val bytes = Normalizer.normalize(value, Normalizer.Form.NFC).toByteArray(StandardCharsets.UTF_8)
        try {
            try { generator.generateBytes(bytes, master) }
            catch (_: OutOfMemoryError) { throw IllegalStateException("This device does not have enough memory for the server's sign-in settings.") }
            return CloudAccountKeys(hkdf(master, "jotdrop:auth:v1"), hkdf(master, "jotdrop:unlock:v1"))
        } finally { master.fill(0); bytes.fill(0) }
    }

    /** RFC 5869 with SHA-256, an empty salt and 32 bytes of output, like WebCrypto deriveBits(256). */
    fun hkdf(secret: ByteArray, info: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        // An empty HMAC key equals 32 zero bytes; SecretKeySpec rejects empty keys.
        mac.init(SecretKeySpec(ByteArray(32), "HmacSHA256"))
        val prk = mac.doFinal(secret)
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        mac.update(info.toByteArray(StandardCharsets.UTF_8))
        return CloudCrypto.encode(mac.doFinal(byteArrayOf(1)))
    }

    /** Four words from the public key; both screens must show the same words, so the server cannot swap in its own key. */
    fun verificationWords(publicKey: String): List<String> {
        val digest = MessageDigest.getInstance("SHA-256").digest("jotdrop:approval-words:v1:$publicKey".toByteArray(StandardCharsets.UTF_8))
        val bits = digest.take(6).fold(0L) { value, byte -> (value shl 8) or (byte.toLong() and 255) }
        return listOf(37, 26, 15, 4).map { shift -> CloudWords.WORDS[((bits shr shift) and 2047).toInt()] }
    }

    private val curve: ECParameterSpec by lazy {
        AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
    }

    fun approvalAad(approvalId: String): String = "jotdrop:approval:v1:$approvalId"

    fun newApprovalKeys(): KeyPair = KeyPairGenerator.getInstance("EC").apply { initialize(curve, random) }.generateKeyPair()

    /** Uncompressed P-256 point, the WebCrypto "raw" format. */
    fun exportPublic(keys: KeyPair): String {
        val point = (keys.public as ECPublicKey).w
        fun coordinate(value: BigInteger): ByteArray = value.toByteArray().takeLast(32).toByteArray().let { ByteArray(32 - it.size) + it }
        return CloudCrypto.encode(byteArrayOf(4) + coordinate(point.affineX) + coordinate(point.affineY))
    }

    private fun importPublic(value: String): ECPublicKey {
        val bytes = CloudCrypto.decode(value)
        require(bytes.size == 65 && bytes[0] == 4.toByte()) { "Invalid approval key" }
        val x = BigInteger(1, bytes.copyOfRange(1, 33))
        val y = BigInteger(1, bytes.copyOfRange(33, 65))
        val field = (curve.curve.field as java.security.spec.ECFieldFp).p
        // Reject points that are not on P-256 before any key agreement.
        require(x < field && y < field && y.modPow(BigInteger.valueOf(2), field) == x.pow(3).add(curve.curve.a.multiply(x)).add(curve.curve.b).mod(field)) { "Invalid approval key" }
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), curve)) as ECPublicKey
    }

    /** ECDH shared secret (x coordinate) through HKDF, bound to the approval request. */
    fun approvalKey(privateKey: PrivateKey, publicKey: String, approvalId: String): String {
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(privateKey)
        agreement.doPhase(importPublic(publicKey), true)
        val secret = agreement.generateSecret()
        try { return hkdf(secret, approvalAad(approvalId)) }
        finally { secret.fill(0) }
    }
}

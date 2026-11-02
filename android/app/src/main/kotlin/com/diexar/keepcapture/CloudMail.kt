package com.diexar.keepcapture

import org.bouncycastle.math.ec.rfc7748.X25519
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Mail to JotDrop, the client side: the X25519 pair derived from the vault key, opening sealed mail,
 * and building the note. Byte-compatible with cloud/shared/mail.mjs; the frozen vectors in
 * cloud/shared/fixtures/mail-vectors.json hold every platform to the same answers.
 */
object CloudMail {
    const val MAX_MAIL_BYTES = 20 * 1024 * 1024
    // Lowercase and digits without 0/o/1/l: 32 characters, so 12 give 60 bits and every byte maps evenly.
    private const val ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"
    private val random = SecureRandom()

    fun newAddress(domain: String): String {
        require(domain.matches(Regex("[a-z0-9.-]{4,128}"))) { "Invalid mail domain" }
        val bytes = ByteArray(12).also(random::nextBytes)
        return bytes.joinToString("") { ALPHABET[(it.toInt() and 255) % 32].toString() } + "@" + domain
    }

    private fun taggedHash(tag: String, value: String): String {
        require(value.isNotEmpty() && value.length <= 320 && value.contains('@')) { "Invalid mail address" }
        val bytes = MessageDigest.getInstance("SHA-256").digest((tag + value.trim().lowercase()).toByteArray(StandardCharsets.UTF_8))
        return bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
    }

    /** The server only ever stores and compares these hashes, never an address itself. */
    fun addressHash(address: String): String = taggedHash("jotdrop:mail-address:v1:", address)
    fun senderHash(sender: String): String = taggedHash("jotdrop:mail-sender:v1:", sender)

    private fun hkdf(ikm: ByteArray, salt: ByteArray, info: String): ByteArray {
        val extract = Mac.getInstance("HmacSHA256")
        extract.init(SecretKeySpec(if (salt.isEmpty()) ByteArray(32) else salt, "HmacSHA256"))
        val prk = extract.doFinal(ikm)
        val expand = Mac.getInstance("HmacSHA256")
        expand.init(SecretKeySpec(prk, "HmacSHA256"))
        expand.update(info.toByteArray(StandardCharsets.UTF_8))
        expand.update(1.toByte())
        return expand.doFinal().copyOf(32)
    }

    /** The account's X25519 private scalar follows from the vault key alone: nothing stored, nothing to lose. */
    fun derivedScalar(vaultKey: String): ByteArray {
        val ikm = CloudCrypto.decode(vaultKey)
        require(ikm.size == 32) { "Invalid cloud key" }
        val scalar = hkdf(ikm, ByteArray(0), "jotdrop:mail-x25519:v1")
        scalar[0] = (scalar[0].toInt() and 248).toByte()
        scalar[31] = ((scalar[31].toInt() and 127) or 64).toByte()
        return scalar
    }

    fun publicKey(scalar: ByteArray): String {
        require(scalar.size == 32) { "Invalid mail key" }
        val result = ByteArray(32)
        X25519.scalarMultBase(scalar, 0, result, 0)
        return CloudCrypto.encode(result)
    }

    /** One AES-256-GCM key per mail; the AAD then separates the body from each attachment. */
    fun mailKey(scalar: ByteArray, accountPublic: String, ephemeralKey: String, mailId: String): ByteArray {
        val ephemeral = CloudCrypto.decode(ephemeralKey)
        val account = CloudCrypto.decode(accountPublic)
        require(ephemeral.size == 32 && account.size == 32) { "Invalid mail key" }
        val secret = ByteArray(32)
        X25519.scalarMult(scalar, 0, ephemeral, 0, secret, 0)
        return hkdf(secret, ephemeral + account, "jotdrop:mail-seal:v1:$mailId")
    }

    private fun open(key: ByteArray, aad: String, sealed: ByteArray): ByteArray {
        require(sealed.size in 28..MAX_MAIL_BYTES + 28) { "Invalid sealed mail" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, sealed, 0, 12))
        cipher.updateAAD(aad.toByteArray(StandardCharsets.UTF_8))
        return cipher.doFinal(sealed, 12, sealed.size - 12)
    }

    fun openBody(key: ByteArray, vaultId: String, mailId: String, sealed: String): ByteArray =
        open(key, "jotdrop:mail:v1:$vaultId:$mailId", CloudCrypto.decode(sealed))

    fun openPart(key: ByteArray, vaultId: String, mailId: String, n: Int, sealed: String): ByteArray =
        open(key, "jotdrop:mail-part:v1:$vaultId:$mailId:$n", CloudCrypto.decode(sealed))

    // The exact whitespace class of cloud/shared/mail.mjs, so every platform collapses the same characters.
    private val spaces = Regex("[ \\t\\n\\r\\u000C\\u000B\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+")
    private val pathUnsafe = Regex("[\\\\/:\\x00-\\x1f\\x7f#\\[\\]|^]")
    private val controls = Regex("[\\x00-\\x1f\\x7f]")
    private val dotsAtEdges = Regex("^[. ]+|[. ]+$")

    private fun safeText(value: String?, fallback: String, length: Int): String {
        val text = (value ?: "").replace(pathUnsafe, " ").replace(spaces, " ").trim(' ').take(length).trim(' ')
        return text.replace(dotsAtEdges, "").ifEmpty { fallback }
    }

    private fun lineText(value: String?, fallback: String, length: Int): String =
        (value ?: "").replace(controls, " ").replace(spaces, " ").trim(' ').take(length).trim(' ').ifEmpty { fallback }

    data class MailNote(val path: String, val content: String, val attachments: List<String>)

    /**
     * The note for one opened mail, byte-identical to `mailToNote` in cloud/shared/mail.mjs:
     * two devices converting the same mail write the same file and sync merges them silently.
     */
    fun noteFor(subject: String?, from: String?, date: String?, text: String?, attachmentNames: List<String?>, mailId: String, receivedAt: String): MailNote {
        val id6 = mailId.filter { it.isLetterOrDigit() && it.code < 128 }.take(6).lowercase()
        val received = Instant.parse(receivedAt)
        require(id6.isNotEmpty()) { "Invalid mail item" }
        val day = DateTimeFormatter.ofPattern("yyyy-MM-dd").withZone(ZoneOffset.UTC).format(received)
        val safeSubject = safeText(subject, "Mail", 60)
        val names = attachmentNames.mapIndexed { index, name -> "mail-$id6-${index + 1} ${safeText(name, "attachment", 80)}" }
        val fromLine = lineText(from, "unknown sender", 160)
        val fallbackDate = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(ZoneOffset.UTC).format(received)
        val dateLine = lineText(date, fallbackDate, 80)
        // Trim like JavaScript's String.trim, which also takes the non-breaking spaces.
        val body = (text ?: "").replace("\r\n", "\n").trim { it.isWhitespace() || it == ' ' || it == ' ' || it == ' ' || it == '﻿' }
        val lines = mutableListOf("# $safeSubject", "", "From $fromLine on $dateLine", "")
        if (body.isNotEmpty()) { lines += body; lines += "" }
        for (name in names) lines += "![[$name]]"
        if (names.isNotEmpty()) lines += ""
        lines += "#mail"
        lines += ""
        return MailNote("notes/Mail/$day $safeSubject $id6.md", lines.joinToString("\n"), names)
    }
}

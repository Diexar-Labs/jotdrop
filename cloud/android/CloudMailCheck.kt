package com.diexar.keepcapture

import java.io.File
import java.util.Base64

/**
 * Holds Android to the frozen Mail to JotDrop vectors (cloud/shared/fixtures/mail-vectors.json, flattened to
 * a TSV by scripts/check-cloud-android.mjs): same derived scalar, same public key, same opened bytes, same note.
 */
private fun utf8(value: ByteArray) = String(value, Charsets.UTF_8)
private fun b64(value: String): ByteArray = Base64.getUrlDecoder().decode(value)

fun main(arguments: Array<String>) {
    val fields = File(arguments[0]).readText().trim().split('\t')
    val (vaultKey, privateScalar, publicKey, vaultId, mailId) = fields
    val receivedAt = fields[5]; val ephemeralKey = fields[6]; val body = fields[7]; val bodyPlain = fields[8]
    val part = fields[9]; val partPlain = fields[10]
    val subject = utf8(b64(fields[11])); val from = utf8(b64(fields[12])); val date = utf8(b64(fields[13])); val text = utf8(b64(fields[14]))
    val attachmentNames = fields[15].split(',').filter { it.isNotEmpty() }.map { utf8(b64(it)) }
    val expectedPath = utf8(b64(fields[16])); val expectedContent = utf8(b64(fields[17]))

    val scalar = CloudMail.derivedScalar(vaultKey)
    check(CloudCrypto.encode(scalar) == privateScalar) { "Derived scalar differs" }
    check(CloudMail.publicKey(scalar) == publicKey) { "Derived public key differs" }
    val key = CloudMail.mailKey(scalar, publicKey, ephemeralKey, mailId)
    check(CloudMail.openBody(key, vaultId, mailId, body).contentEquals(b64(bodyPlain))) { "Opened mail body differs" }
    check(CloudMail.openPart(key, vaultId, mailId, 0, part).contentEquals(b64(partPlain))) { "Opened attachment differs" }
    runCatching { CloudMail.openBody(CloudMail.mailKey(scalar, publicKey, ephemeralKey, "other-mail"), vaultId, mailId, body) }
        .onSuccess { error("A wrong mail key must never open a mail") }
    runCatching { CloudMail.openBody(key, "other-vault", mailId, body) }
        .onSuccess { error("A wrong vault in the AAD must never open a mail") }

    val note = CloudMail.noteFor(subject, from, date, text, attachmentNames, mailId, receivedAt)
    check(note.path == expectedPath) { "Note path differs: ${note.path}" }
    check(note.content == expectedContent) { "Note content differs:\n${note.content}" }

    // The hostile-input cases of cloud/shared/mail.test.mjs, byte for byte.
    val hostile = CloudMail.noteFor("  ../../etc: pass#wd [a]|b^  ", "x", "", "", listOf("..\\..\\evil :name.pdf", null), "ABC123-rest", "2026-01-05T06:07:08.000Z")
    check(hostile.path == "notes/Mail/2026-01-05 etc pass wd a b abc123.md") { "Hostile path differs: ${hostile.path}" }
    check(hostile.attachments == listOf("mail-abc123-1 evil name.pdf", "mail-abc123-2 attachment")) { "Hostile names differ: ${hostile.attachments}" }
    check(hostile.content.contains("From x on 2026-01-05 06:07")) { "Hostile date line differs" }
    val fallback = CloudMail.noteFor(null, null, null, null, emptyList(), "id9876", "2026-01-05T06:07:08.000Z")
    check(fallback.path == "notes/Mail/2026-01-05 Mail id9876.md") { "Fallback path differs" }
    check(fallback.content.startsWith("# Mail\n\nFrom unknown sender on ")) { "Fallback content differs" }
    check(fallback.content.endsWith("#mail\n")) { "Fallback tag differs" }

    val hash = CloudMail.addressHash("K7wmq3xbrn4p@in.jotdrop.net ")
    check(hash == CloudMail.addressHash("k7wmq3xbrn4p@in.jotdrop.net") && hash.matches(Regex("[0-9a-f]{64}"))) { "Address hash differs" }
    check(CloudMail.senderHash("a@b.cd") != CloudMail.addressHash("a@b.cd")) { "Hash domains must differ" }
    check(CloudMail.newAddress("in.jotdrop.net").matches(Regex("[a-km-np-z2-9]{12}@in\\.jotdrop\\.net"))) { "Address shape differs" }

    println("cloud mail parity ok")
}

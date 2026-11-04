package com.diexar.keepcapture

import java.io.File

/**
 * Holds Android to the shared list link rules: the cases of cloud/shared/list-link-vectors.json, random reconcile
 * cases computed by cloud/shared/list-links.mjs, and the sealing (AAD strings, write proof) of a list and its owner
 * envelope. scripts/check-list-links-android.mjs writes the TSV and reads the answers back.
 */
private fun text(value: String) = String(CloudCrypto.decode(value), Charsets.UTF_8)
private fun field(value: String): String? = if (value == "-") null else text(value)
private fun marks(value: String): List<CloudListRules.Mark> = if (value.isEmpty()) emptyList() else value.split(',').map { item ->
    val (line, n, by, at, added) = item.split('|')
    CloudListRules.Mark(text(line), n.toInt(), text(by), at.toLong(), added == "1")
}
private fun flat(marks: List<CloudListRules.Mark>) = marks.joinToString(",") { "${CloudCrypto.encode(it.line.toByteArray())}|${it.n}|${CloudCrypto.encode(it.by.toByteArray())}|${it.at}|${if (it.added) 1 else 0}" }
private fun envelope(json: String): CloudEnvelope {
    fun part(name: String) = requireNotNull(Regex("\"$name\":\"([^\"]+)\"").find(json)) { "No $name in the envelope" }.groupValues[1]
    return CloudEnvelope(part("iv"), part("ciphertext"))
}

fun main(arguments: Array<String>) {
    var vectors = 0
    var reconciled = 0
    val output = mutableListOf<String>()
    for (line in File(arguments[0]).readLines().filter { it.isNotBlank() }) {
        val fields = line.split('\t')
        when (fields[0]) {
            "vector" -> {
                val name = text(fields[1])
                val base = text(fields[2])
                val next = field(fields[3])
                val accepted = text(fields[4])
                if (next != null) check(CloudListRules.allowedGuestChange(base, next) == accepted) { "Guest change differs: $name" }
                val mine = field(fields[5])
                if (mine != null) {
                    val result = text(fields[6])
                    check(CloudListRules.applyGuestChanges(base, accepted, mine) == result) { "Applied change differs: $name" }
                    check(CloudListRules.applyGuestChanges(base, accepted, result) == result) { "Applying twice differs: $name" }
                }
                vectors++
            }
            "reconcile" -> {
                val result = CloudListRules.reconcile(text(fields[1]), text(fields[2]), text(fields[3]), marks(fields[4]), text(fields[5]), fields[6].toLong())
                check(result.text == text(fields[7])) { "Reconciled text differs:\n${result.text}\nexpected:\n${text(fields[7])}" }
                check(result.marks == marks(fields[8])) { "Reconciled marks differ: ${result.marks} expected ${marks(fields[8])}" }
                check(result.noteChanged == (fields[9] == "1") && result.linkChanged == (fields[10] == "1")) { "Reconciled flags differ for:\n${text(fields[1])}" }
                reconciled++
            }
            "crypto" -> {
                val (key, id, vaultKey, vaultId) = fields.subList(1, 5)
                val listPayload = CloudCrypto.decode(fields[7])
                val ownerPayload = CloudCrypto.decode(fields[8])
                check(CloudCrypto.decrypt(key, envelope(text(fields[5])), CloudListRules.listAad(id)).contentEquals(listPayload)) { "The list does not open with the list AAD" }
                check(CloudCrypto.decrypt(vaultKey, envelope(text(fields[6])), CloudListRules.ownerAad(vaultId, id)).contentEquals(ownerPayload)) { "The owner envelope does not open with the owner AAD" }
                runCatching { CloudCrypto.decrypt(key, envelope(text(fields[5])), CloudListRules.listAad("00000000-0000-4000-8000-000000000000")) }.onSuccess { error("Another list's AAD must not open this list") }
                check(CloudListRules.writeProof(key) == fields[9]) { "Write proof differs" }
                check(CloudListRules.proofHash(key) == fields[10]) { "Proof hash differs" }
                val sealed = CloudCrypto.encrypt(key, listPayload, CloudListRules.listAad(id))
                val owner = CloudCrypto.encrypt(vaultKey, ownerPayload, CloudListRules.ownerAad(vaultId, id))
                output += "sealed\t${sealed.iv}\t${sealed.ciphertext}\t${owner.iv}\t${owner.ciphertext}"
            }
            else -> error("Unknown check line: ${fields[0]}")
        }
    }
    check(vectors >= 25) { "Too few vectors: $vectors" }
    check(reconciled >= 200) { "Too few reconcile cases: $reconciled" }

    // The owner's own marks: a tick or an added line under the owner's name, unless a guest did the same.
    val own = CloudListRules.reconcile("- [ ] milk\n- [ ] eggs\n", "- [x] milk\n- [ ] eggs\n- [ ] jam\n", "- [ ] milk\n- [ ] eggs\n", emptyList(), "Eric", 5)
    check(own.text == "- [x] milk\n- [ ] eggs\n- [ ] jam\n" && !own.noteChanged && own.linkChanged) { "Own change flags differ" }
    check(own.marks == listOf(CloudListRules.Mark("- [ ] milk", 0, "Eric", 5, false), CloudListRules.Mark("- [ ] jam", 0, "Eric", 5, true))) { "Own marks differ: ${own.marks}" }
    val long = CloudListRules.reconcile("- [ ] milk\n", "- [x] milk\n", "- [ ] milk\n", emptyList(), "a".repeat(41), 5)
    check(long.marks.single().by == "Someone") { "A name over 40 characters must become Someone" }
    check(CloudListRules.hasChecklist("Text\r\n- [ ] milk\r\n") && !CloudListRules.hasChecklist("- milk\n-[ ] eggs\n")) { "Checklist detection differs" }
    check(CloudListRules.normalize("a\r\nb\rc\n") == "a\nb\nc\n") { "Line ends differ" }

    File(arguments[1]).writeText(output.joinToString("\n"))
    println("list link rules ok: $vectors vectors, $reconciled reconcile cases")
}

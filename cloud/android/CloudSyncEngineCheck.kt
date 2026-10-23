package com.diexar.keepcapture

private class CheckRemote : CloudSyncRemote {
    val files = linkedMapOf<String, CloudSyncObject>()
    var loseWrite = false
    var loseDelete = false
    override fun list(): List<CloudSyncObject> = files.values.toList()
    override fun write(path: String, bytes: ByteArray, baseRevision: Int): CloudSyncObject {
        check((files[path]?.revision ?: 0) == baseRevision) { "409" }
        val entry = CloudSyncObject(path, bytes.copyOf(), baseRevision + 1)
        files[path] = entry
        if (loseWrite) { loseWrite = false; error("Lost successful write response") }
        return entry
    }
    override fun delete(path: String, baseRevision: Int): CloudSyncObject {
        val old = files.getValue(path)
        check(old.revision == baseRevision) { "409" }
        val entry = old.copy(revision = baseRevision + 1, deleted = true)
        files[path] = entry
        if (loseDelete) { loseDelete = false; error("Lost successful delete response") }
        return entry
    }
}

private class CheckLocal : CloudSyncLocal {
    val files = linkedMapOf<String, ByteArray>()
    val copies = linkedMapOf<String, ByteArray>()
    var race = false
    override fun list(): Map<String, ByteArray> = files.mapValues { it.value.copyOf() }
    override fun compareAndSet(path: String, expected: ByteArray?, replacement: ByteArray?): Boolean {
        if (race) { race = false; files[path] = "racing edit".toByteArray(); return false }
        val current = files[path]
        if ((expected == null) != (current == null) || current != null && !current.contentEquals(expected!!)) return false
        if (replacement == null) files.remove(path) else files[path] = replacement.copyOf()
        return true
    }
    override fun conflict(path: String, remoteRevision: Int, remoteBytes: ByteArray) { copies["$path:$remoteRevision"] = remoteBytes.copyOf() }
}

fun main() {
    val uploadBytes = ByteArray(CloudCrypto.MAX_FILE_BYTES) { (it * 31).toByte() }
    val uploadKey = CloudCrypto.token()
    val uploadPayload = """{"path":"attachments/max.bin","content":"${CloudCrypto.encode(uploadBytes)}","modifiedAt":"2026-10-19T00:00:00Z"}""".toByteArray(Charsets.UTF_8)
    val prepared = CloudPreparedUpload("a".repeat(64), 7, CloudCrypto.encrypt(uploadKey, uploadPayload, "synthetic upload"))
    val uploadWire = CloudCrypto.decode(prepared.envelope.iv) + CloudCrypto.decode(prepared.envelope.ciphertext)
    val receipt = CloudUploadReceipt(prepared.id, 8, 1)
    var received = ByteArray(0)
    var committed = false
    val lost = mutableSetOf<String>()
    val chunks = mutableListOf<Pair<String, ByteArray>>()
    var route = ""
    val transport: (String, String, ByteArray?, Boolean) -> CloudUploadReply = { path, method, body, binary ->
        when {
            path == "/status" -> CloudUploadReply(version = 1, chunkBytes = 65536)
            method == "POST" && !path.endsWith("/commit") -> {
                if (route.isNotEmpty()) check(route == path)
                route = path
                check(!binary && String(requireNotNull(body)) == """{"size":${uploadWire.size}}""")
                if (lost.add("start")) throw java.io.EOFException("Lost start response")
                if (committed) CloudUploadReply(committed = receipt) else CloudUploadReply(received.size, uploadWire.size)
            }
            method == "PUT" -> {
                check(binary)
                val bytes = requireNotNull(body)
                check(bytes.size in 1..65536)
                chunks += path to bytes.copyOf()
                val offset = path.substringAfter("?offset=").toInt()
                if (offset == received.size) received += bytes
                else check(received.copyOfRange(offset, offset + bytes.size).contentEquals(bytes))
                if (lost.add("chunk")) throw java.io.EOFException("Lost chunk response")
                CloudUploadReply(received.size, uploadWire.size)
            }
            else -> {
                check(path == "$route/commit" && received.contentEquals(uploadWire))
                committed = true
                if (lost.add("commit")) throw java.io.EOFException("Lost commit response")
                CloudUploadReply(committed = receipt)
            }
        }
    }
    check(runCatching { CloudUpload.commit(prepared, { if (chunks.size >= 2) error("Synthetic process interruption") }, transport) }.isFailure)
    check(received.size == 65536 && !committed)
    val restart = prepared.copy(envelope = prepared.envelope.copy())
    check(CloudUpload.commit(restart, send = transport) == 8)
    check(received.contentEquals(uploadWire) && CloudCrypto.decrypt(uploadKey, restart.envelope, "synthetic upload").contentEquals(uploadPayload))
    check(chunks[0].first == chunks[1].first && chunks[0].second.contentEquals(chunks[1].second))
    val sent = chunks.size
    check(CloudUpload.commit(restart, send = transport) == 8 && chunks.size == sent)
    check(lost == setOf("start", "chunk", "commit"))
    check(runCatching { CloudUpload.commit(prepared) { _, _, _, _ -> CloudUploadReply() } }.isFailure)
    for (invalid in listOf(CloudUploadReply(-1, uploadWire.size), CloudUploadReply(uploadWire.size + 1, uploadWire.size),
        CloudUploadReply(0, uploadWire.size - 1), CloudUploadReply(committed = receipt.copy(id = "b".repeat(64))),
        CloudUploadReply(committed = receipt.copy(revision = 9)), CloudUploadReply(committed = receipt.copy(sequence = 0)))) {
        check(runCatching { CloudUpload.commit(prepared) { path, _, _, _ ->
            if (path == "/status") CloudUploadReply(version = 1, chunkBytes = 65536) else invalid
        } }.isFailure)
    }
    var attempts = 0
    check(runCatching { CloudUpload.commit(prepared) { _, _, _, _ -> attempts++; throw java.io.IOException("Offline") } }.isFailure && attempts == 2)
    var regressed = 0
    check(runCatching { CloudUpload.commit(prepared) { path, method, _, _ ->
        when {
            path == "/status" -> CloudUploadReply(version = 1, chunkBytes = 65536)
            method == "POST" -> CloudUploadReply(0, uploadWire.size)
            else -> { regressed++; CloudUploadReply(0, uploadWire.size) }
        }
    } }.isFailure && regressed == 1)
    check(runCatching { CloudUpload.commit(prepared) { path, _, _, _ ->
        if (path == "/status") CloudUploadReply(version = 1, chunkBytes = 65536) else CloudUploadReply(uploadWire.size, uploadWire.size)
    } }.isFailure)
    println("Native upload checks passed: 4 MiB, identical lost-response retries, interruption/resume, receipts, capability and acknowledgment limits")

    val sensitive = "Bearer synthetic-secret https://private.invalid/notes/personal.md?token=secret\nprivate note"
    val failures = listOf(
        java.net.SocketTimeoutException(sensitive) to "timeout",
        javax.net.ssl.SSLHandshakeException(sensitive) to "tls",
        java.net.UnknownHostException(sensitive) to "dns",
        java.net.ConnectException(sensitive) to "connect",
        java.io.EOFException(sensitive) to "truncated",
        java.net.SocketException(sensitive) to "socket",
        java.io.IOException(sensitive, Exception(sensitive)) to "io",
        SecurityException(sensitive) to "permission",
        java.security.GeneralSecurityException(sensitive) to "crypto",
        IllegalArgumentException(sensitive) to "validation",
        IllegalStateException(sensitive) to "validation",
        object : Exception() {
            override val message: String get() = error("Diagnostic accessed exception text")
            override fun toString(): String = error("Diagnostic rendered exception")
        } to "other",
    )
    for ((failure, category) in failures) {
        for (phase in CloudDiagnostics.Phase.entries) {
            check(CloudDiagnostics.failure(failure, phase, 123, 8192) ==
                "[DEBUG:error] phase=$phase category=$category elapsedMs=123 receivedBytes=8192")
        }
    }
    check(CloudDiagnostics.failure(java.io.IOException(sensitive), CloudDiagnostics.Phase.RECONCILE, 0) ==
        "[DEBUG:error] phase=RECONCILE category=io elapsedMs=0")
    println("Native diagnostic checks passed: fixed categories/phases, numeric timing/bytes, no exception text or causes")

    val remote = CheckRemote()
    val a = CheckLocal()
    val b = CheckLocal()
    val ta = mutableMapOf<String, CloudSyncBase>()
    val tb = mutableMapOf<String, CloudSyncBase>()
    var savedA: Map<String, CloudSyncBase> = emptyMap()
    var savedB: Map<String, CloudSyncBase> = emptyMap()
    fun syncA() = CloudSyncEngine.sync(remote, a, ta) { savedA = it.toMap() }
    fun syncB() = CloudSyncEngine.sync(remote, b, tb) { savedB = it.toMap() }
    val note = "notes/test.md"
    a.files[note] = "first".toByteArray()
    a.files["attachments/binary.bin"] = ByteArray(256) { it.toByte() }
    check(syncA().uploaded == 2)
    check(syncB().downloaded == 2)
    check(b.files.getValue(note).contentEquals(a.files.getValue(note)))
    check(savedA == ta && savedB == tb)

    a.files[note] = "from A".toByteArray()
    check(syncA().uploaded == 1)
    b.files[note] = "from B offline".toByteArray()
    check(syncB().conflicts == 1)
    check(String(b.files.getValue(note)) == "from B offline")
    check(b.copies.values.any { String(it) == "from A" })
    check(String(remote.files.getValue(note).bytes) == "from A")
    b.files[note] = "from A".toByteArray()
    check(syncB().conflicts == 0)

    a.files[note] = "next A".toByteArray()
    syncA()
    b.race = true
    check(syncB().conflicts == 1 && String(b.files.getValue(note)) == "racing edit")
    b.files[note] = remote.files.getValue(note).bytes.copyOf()
    syncB()

    a.files.remove(note)
    check(syncA().deleted == 1 && remote.files.getValue(note).deleted)
    check(syncB().deleted == 1 && !b.files.containsKey(note))
    check(ta.getValue(note).deleted && tb.getValue(note).deleted)
    b.files[note] = "explicit recreation".toByteArray()
    check(syncB().uploaded == 1 && !remote.files.getValue(note).deleted)
    check(syncA().downloaded == 1 && String(a.files.getValue(note)) == "explicit recreation")

    val beforeLost = remote.files.getValue(note).revision
    a.files[note] = "lost write response".toByteArray()
    remote.loseWrite = true
    check(runCatching { syncA() }.isFailure)
    check(ta.getValue(note).revision == beforeLost)
    check(syncA().uploaded == 0 && ta.getValue(note).revision == beforeLost + 1)
    a.files.remove(note)
    remote.loseDelete = true
    check(runCatching { syncA() }.isFailure)
    val deletedRevision = remote.files.getValue(note).revision
    check(syncA().deleted == 0 && ta.getValue(note).deleted && remote.files.getValue(note).revision == deletedRevision)

    val stale = CheckLocal().also { it.files[note] = "unsynced local".toByteArray() }
    check(CloudSyncEngine.sync(remote, stale, mutableMapOf()) {}.conflicts == 1)
    check(String(stale.files.getValue(note)) == "unsynced local" && remote.files.getValue(note).deleted)
    b.files[note] = "edited before remote delete".toByteArray()
    check(syncB().conflicts == 1 && String(b.files.getValue(note)) == "edited before remote delete")

    remote.write(note, "restored history".toByteArray(), deletedRevision)
    check(syncA().downloaded == 1 && String(a.files.getValue(note)) == "restored history")
    val pending = CheckLocal().also { it.files["notes/new.md"] = "persist failure".toByteArray() }
    val tracked = mutableMapOf<String, CloudSyncBase>()
    check(runCatching { CloudSyncEngine.sync(remote, pending, tracked) { error("Disk full") } }.isFailure)
    check(tracked.isEmpty())
    check(CloudSyncEngine.sync(remote, pending, tracked) {}.conflicts == 0)

    remote.files.remove(note)
    check(runCatching { syncA() }.isFailure)
    check(String(a.files.getValue(note)) == "restored history")
    val resumedRemote = CheckRemote()
    val newerLocal = CheckLocal().also { it.files[note] = "newer local edit".toByteArray() }
    val acknowledgedSnapshot = resumedRemote.write(note, "older sealed snapshot".toByteArray(), 0)
    val resumedBase = mutableMapOf(note to CloudSyncBase(acknowledgedSnapshot.revision, CloudSyncEngine.hash(acknowledgedSnapshot.bytes)))
    check(CloudSyncEngine.sync(resumedRemote, newerLocal, resumedBase) {}.uploaded == 1)
    check(resumedRemote.files.getValue(note).revision == 2 && String(resumedRemote.files.getValue(note).bytes) == "newer local edit")
    newerLocal.files[note] = "second offline edit".toByteArray()
    resumedRemote.write(note, "newer remote edit".toByteArray(), 2)
    check(CloudSyncEngine.sync(resumedRemote, newerLocal, resumedBase) {}.conflicts == 1)
    check(String(newerLocal.files.getValue(note)) == "second offline edit" && String(resumedRemote.files.getValue(note).bytes) == "newer remote edit")
    // A full free cloud clears a note that sat in the trash for 30 days; its name can be used again.
    val clearing = CheckRemote()
    val c = CheckLocal().also { it.files[note] = "old".toByteArray() }
    val d = CheckLocal()
    val tc = mutableMapOf<String, CloudSyncBase>()
    val td = mutableMapOf<String, CloudSyncBase>()
    var savedC: Map<String, CloudSyncBase> = emptyMap()
    CloudSyncEngine.sync(clearing, c, tc) {}
    CloudSyncEngine.sync(clearing, d, td) {}
    c.files.remove(note)
    check(CloudSyncEngine.sync(clearing, c, tc) {}.deleted == 1 && CloudSyncEngine.sync(clearing, d, td) {}.deleted == 1)
    clearing.files.remove(note)
    check(CloudSyncEngine.sync(clearing, c, tc) { savedC = it.toMap() }.conflicts == 0 && tc.isEmpty() && savedC.isEmpty())
    clearing.write(note, "new note, same name".toByteArray(), 0)
    check(CloudSyncEngine.sync(clearing, d, td) {}.downloaded == 1 && String(d.files.getValue(note)) == "new note, same name")
    // Time machine: one step per minute with a change, and a restore plan like the web app's.
    check(CloudTimeMachine.steps(listOf("2026-10-23T08:00:05.000Z", "2026-10-23T08:00:40.000Z", "2026-10-22T07:00:00.000Z", "2026-10-23T08:01:00.000Z")) ==
        listOf("2026-10-22T07:00:00.000Z", "2026-10-23T08:00:40.000Z", "2026-10-23T08:01:00.000Z"))
    val now = listOf(CloudCurrentFile("same", 2, false), CloudCurrentFile("edited", 3, false), CloudCurrentFile("trashed", 2, true),
        CloudCurrentFile("later", 1, false), CloudCurrentFile("laterTrashed", 2, true), CloudCurrentFile("wasTrashed", 4, false))
    val then = listOf(CloudMomentFile("same", 2, false, false, false), CloudMomentFile("edited", 1, false, false, false),
        CloudMomentFile("trashed", 1, false, false, false), CloudMomentFile("wasTrashed", 2, true, false, false))
    check(CloudTimeMachine.restorePlan(now, then) == listOf(CloudMomentStep.Restore("edited", 1, 3), CloudMomentStep.Restore("trashed", 1, 2),
        CloudMomentStep.Delete("later", 1), CloudMomentStep.Delete("wasTrashed", 4)))
    // Locked or cleared files from then block the moment, unless that version is still the current one.
    val inTrashLongAgo = CloudMomentFile("trashed", 2, true, true, false)
    check(CloudTimeMachine.unavailable(now, listOf(inTrashLongAgo)).isEmpty())
    val locked = CloudMomentFile("edited", 1, false, true, false)
    val cleared = CloudMomentFile("same", null, false, true, true)
    check(CloudTimeMachine.unavailable(now, listOf(locked, cleared)) == listOf(locked, cleared))
    check(runCatching { CloudTimeMachine.restorePlan(now, listOf(locked)) }.isFailure)
    for (path in listOf("../x", "notes/../x", ".obsidian/key", "notes/.stfolder/x.md", "notes/x.cloud-conflict-r1.md", "attachments/.git/x", "notes/file.exe")) {
        check(runCatching { CloudSyncEngine.path(path) }.isFailure)
    }
    check(CloudSyncEngine.path("notes/x.cloud-conflict-r1.md", allowPreserved = true) == "notes/x.cloud-conflict-r1.md")
    check(CloudSyncEngine.path("attachments/x.cloud-recovery-hash.bin", allowPreserved = true) == "attachments/x.cloud-recovery-hash.bin")
    val oversized = CheckLocal().also { it.files[note] = ByteArray(CloudCrypto.MAX_FILE_BYTES + 1) }
    check(runCatching { CloudSyncEngine.sync(CheckRemote(), oversized, mutableMapOf()) {} }.isFailure)
    val stopped = CheckRemote()
    val unsent = CheckLocal().also { it.files[note] = "retained after pause".toByteArray() }
    check(runCatching { CloudSyncEngine.sync(stopped, unsent, mutableMapOf(), { error("Paused") }) {} }.isFailure)
    check(stopped.files.isEmpty() && String(unsent.files.getValue(note)) == "retained after pause")
    println("Native sync checks passed: two devices, binary attachments, offline conflicts, CAS races, delete/recreate/restore, lost responses, persisted baselines and fail-closed limits")
}

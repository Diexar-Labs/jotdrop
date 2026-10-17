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

package com.diexar.keepcapture

private class CheckRemote : CloudSyncRemote {
    val files = linkedMapOf<String, CloudSyncObject>()
    var loseWrite = false
    var loseDelete = false
    var downloads = 0
    // Every version written, so a merge can read the one both devices last shared.
    val history = mutableMapOf<Pair<String, Int>, ByteArray>()
    override fun base(path: String, revision: Int): ByteArray? = history[path to revision]?.copyOf()
    override fun list(): List<CloudSyncEntry> = files.values.map { file -> CloudSyncEntry(file.path, file.revision, file.deleted, CloudSyncEngine.hash(file.bytes)) { downloads++; file.bytes.copyOf() } }
    override fun write(path: String, bytes: ByteArray, baseRevision: Int): CloudSyncObject {
        check((files[path]?.revision ?: 0) == baseRevision) { "409" }
        val entry = CloudSyncObject(path, bytes.copyOf(), baseRevision + 1)
        files[path] = entry
        history[path to entry.revision] = bytes.copyOf()
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
    var reads = 0
    // Each new content is a new array, so its identity stands in for a modification time.
    private val times = java.util.IdentityHashMap<ByteArray, Long>()
    override fun list(): Map<String, CloudLocalFile> = files.mapValues { (_, bytes) -> CloudLocalFile(bytes.size.toLong(), times.getOrPut(bytes) { times.size + 1L }) }
    override fun read(path: String): ByteArray { reads++; return requireNotNull(files[path]) { "Expected a local file" }.copyOf() }
    override fun compareAndSet(path: String, expected: ByteArray?, replacement: ByteArray?): Boolean {
        if (race) { race = false; files[path] = "racing edit".toByteArray(); return false }
        val current = files[path]
        if ((expected == null) != (current == null) || current != null && !current.contentEquals(expected!!)) return false
        if (replacement == null) files.remove(path) else files[path] = replacement.copyOf()
        return true
    }
    override fun conflict(path: String, remoteRevision: Int, remoteBytes: ByteArray) { copies["$path:$remoteRevision"] = remoteBytes.copyOf() }
}

// A synthetic file carries its own recipe in its first line, so neither side has to keep 300 MB around.
private fun recipeBytes(recipe: String): ByteArray {
    val bytes = ByteArray(recipe.substringAfterLast('#').toInt()) { recipe.length.toByte() }
    "$recipe\n".toByteArray().copyInto(bytes)
    return bytes
}
private fun recipeOf(bytes: ByteArray): String = String(bytes, 0, bytes.indexOf('\n'.code.toByte()))

/** Like the server with v2 objects: a manifest carries the fingerprint, and only a small file's bytes. */
private class ScaleCloud {
    class Stored(val path: String, val revision: Int, val deleted: Boolean, val recipe: String) {
        val hash = CloudSyncEngine.hash(recipeBytes(recipe))
    }
    val objects = linkedMapOf<String, Stored>()
    val feed = mutableListOf<CloudChange>()
    var reads = 0
    var downloads = 0
    fun store(file: Stored) { objects[file.path] = file; feed += CloudChange(file.path, file.revision) }
    fun changes(after: Long): CloudChanges = feed.drop(after.toInt()).take(500).let { CloudChanges(it, after + it.size, after + 500 < feed.size) }
    fun read(id: String): CloudManifest? {
        reads++
        val file = objects[id] ?: return null
        val size = file.recipe.substringAfterLast('#').toInt()
        return CloudManifest(id, file.revision, file.path, file.deleted, size, file.hash, emptyList(), if (size <= CloudCrypto.INLINE_BYTES) recipeBytes(file.recipe) else null)
    }
    fun download(manifest: CloudManifest): ByteArray = manifest.bytes ?: recipeBytes(objects.getValue(manifest.id).recipe).also { downloads++ }
}

/** One device with what it last saved, so a restart goes on from exactly that. */
private class ScaleDevice(val cloud: ScaleCloud) {
    val files = linkedMapOf<String, String>()
    private val times = mutableMapOf<String, Long>()
    private var clock = 0L
    var reads = 0
    var writes = 0
    var tracked = mutableMapOf<String, CloudSyncBase>()
    var seen = mutableMapOf<String, CloudSeenFile>()
    var index = CloudRemoteIndex()
    private var savedTracked = mapOf<String, CloudSyncBase>()
    private var savedSeen = mapOf<String, CloudSeenFile>()
    private var savedIndex = CloudRemoteIndex()
    fun set(path: String, recipe: String) { files[path] = recipe; times[path] = ++clock }
    private fun copy(value: CloudRemoteIndex) = CloudRemoteIndex(value.cursor, LinkedHashMap(value.objects), LinkedHashMap(value.pending))
    val local = object : CloudSyncLocal {
        override fun list(): Map<String, CloudLocalFile> = files.filterKeys { !it.contains(".cloud-") }.mapValues { (path, recipe) -> CloudLocalFile(recipe.substringAfterLast('#').toLong(), times.getValue(path)) }
        override fun read(path: String): ByteArray { reads++; return recipeBytes(files.getValue(path)) }
        override fun compareAndSet(path: String, expected: ByteArray?, replacement: ByteArray?): Boolean {
            val actual = files[path]
            if ((actual == null) != (expected == null) || actual != null && recipeOf(expected!!) != actual) return false
            if (replacement == null) files.remove(path) else set(path, recipeOf(replacement))
            writes++
            return true
        }
        override fun conflict(path: String, remoteRevision: Int, remoteBytes: ByteArray) = set("$path.cloud-conflict-r$remoteRevision", recipeOf(remoteBytes))
    }
    fun sync(stop: () -> Unit = {}): CloudSyncReport {
        val remote = object : CloudSyncRemote {
            override fun list() = CloudSyncEngine.remoteFiles(index, cloud::changes, cloud::read, cloud::download, stop, { savedIndex = copy(index) })
            // Like the app: what this device wrote goes into its index, so the feed does not bring it back.
            override fun write(path: String, bytes: ByteArray, baseRevision: Int): CloudSyncObject {
                check((cloud.objects[path]?.revision ?: 0) == baseRevision)
                cloud.store(ScaleCloud.Stored(path, baseRevision + 1, false, recipeOf(bytes)))
                index.objects[path] = CloudIndexedFile(path, baseRevision + 1, false, CloudSyncEngine.hash(bytes))
                return CloudSyncObject(path, bytes, baseRevision + 1)
            }
            override fun delete(path: String, baseRevision: Int): CloudSyncObject {
                val old = cloud.objects.getValue(path)
                check(old.revision == baseRevision)
                cloud.store(ScaleCloud.Stored(path, baseRevision + 1, true, old.recipe))
                val bytes = recipeBytes(old.recipe)
                index.objects[path] = CloudIndexedFile(path, baseRevision + 1, true, CloudSyncEngine.hash(bytes))
                return CloudSyncObject(path, bytes, baseRevision + 1, true)
            }
        }
        return CloudSyncEngine.sync(remote, local, tracked, stop, seen) { savedTracked = it; savedSeen = seen.toMap() }
    }
    fun restart() { tracked = savedTracked.toMutableMap(); seen = savedSeen.toMutableMap(); index = copy(savedIndex) }
}

/** 5,000 files and about 300 MB; checkCloudSync runs in a 160 MiB heap, so a sync that held them all would fail. */
/** The shared cases of cloud/shared/merge-vectors.json (as base64 lines from the check script), then two devices. */
private fun checkMerge() {
    val input = requireNotNull(System.getenv("JOTDROP_MERGE_INPUT")) { "JOTDROP_MERGE_INPUT is missing" }
    val decode = CloudCrypto::decode
    var cases = 0
    for (line in java.io.File(input).readLines().filter { it.isNotBlank() }) {
        val (name, base, local, cloud, merged) = line.split('\t')
        val result = CloudNoteMerge.merge(if (base == "-") null else decode(base), decode(local), decode(cloud))
        check(if (merged == "-") result == null else result != null && result.contentEquals(decode(merged))) { "Merge case failed: ${String(decode(name))}" }
        cases++
    }
    check(cases >= 3000) { "Too few merge cases" }

    val remote = CheckRemote()
    val desktop = CheckLocal()
    val phone = CheckLocal()
    val td = mutableMapOf<String, CloudSyncBase>()
    val tp = mutableMapOf<String, CloudSyncBase>()
    fun syncDesktop() = CloudSyncEngine.sync(remote, desktop, td) {}
    fun syncPhone() = CloudSyncEngine.sync(remote, phone, tp) {}
    val note = "notes/daily.md"
    val body = "# Daily\n\nStretch.\n"
    desktop.files[note] = "---\ntags:\n  - health\nreminder: 2026-10-27T14:00\nreminder_repeat: daily\nreminder_done: 9\n---\n$body".toByteArray()
    syncDesktop()
    syncPhone()
    // 14:00: the reminder goes off on both, each writes the next one its own way; the desktop also sets the card order.
    desktop.files[note] = "---\ntags:\n  - health\nreminder: 2026-10-28T14:00\nreminder_repeat: daily\nreminder_done: 10\norder: -5\n---\n$body".toByteArray()
    phone.files[note] = "---\ntags: [health]\nreminder: \"2026-10-28T14:00\"\nreminder_repeat: daily\nreminder_done: 10\n---\n$body".toByteArray()
    check(syncDesktop().uploaded == 1)
    check(syncPhone().let { it.downloaded == 1 && it.uploaded == 0 && it.conflicts == 0 })
    check(phone.files.getValue(note).contentEquals(desktop.files.getValue(note)) && phone.copies.isEmpty())
    // The phone pins the card while the desktop edits the text: one merged note, both ways.
    val pinned = "---\ntags:\n  - health\nreminder: 2026-10-28T14:00\nreminder_repeat: daily\nreminder_done: 10\norder: -5\npinned: true\n---\n"
    phone.files[note] = "$pinned$body".toByteArray()
    desktop.files[note] = "---\ntags:\n  - health\nreminder: 2026-10-28T14:00\nreminder_repeat: daily\nreminder_done: 10\norder: -5\n---\n# Daily\n\nStretch and walk.\n".toByteArray()
    syncDesktop()
    check(syncPhone().let { it.uploaded == 1 && it.conflicts == 0 })
    val merged = "$pinned# Daily\n\nStretch and walk.\n"
    check(String(phone.files.getValue(note)) == merged && String(remote.files.getValue(note).bytes) == merged)
    check(syncDesktop().downloaded == 1 && String(desktop.files.getValue(note)) == merged)
    check(phone.copies.isEmpty() && desktop.copies.isEmpty())
    // Both change the text: still both versions, as before.
    phone.files[note] = merged.replace("walk", "run").toByteArray()
    desktop.files[note] = merged.replace("walk", "swim").toByteArray()
    syncDesktop()
    check(syncPhone().conflicts == 1 && String(phone.files.getValue(note)) == merged.replace("walk", "run"))
    // Without the shared version (locked or cleared), a field on one side only is not merged.
    phone.files[note] = remote.files.getValue(note).bytes.copyOf()
    syncPhone()
    remote.history.clear()
    phone.files[note] = String(remote.files.getValue(note).bytes).replace("pinned: true\n", "").toByteArray()
    desktop.files[note] = String(remote.files.getValue(note).bytes).replace("order: -5", "order: -6").toByteArray()
    syncDesktop()
    check(syncPhone().conflicts == 1)

    // A list: each device ticks its own lines, both end up with all the ticks and no copy.
    val listRemote = CheckRemote()
    val listDesktop = CheckLocal()
    val listPhone = CheckLocal()
    val tld = mutableMapOf<String, CloudSyncBase>()
    val tlp = mutableMapOf<String, CloudSyncBase>()
    fun syncListDesktop() = CloudSyncEngine.sync(listRemote, listDesktop, tld) {}
    fun syncListPhone() = CloudSyncEngine.sync(listRemote, listPhone, tlp) {}
    val list = "notes/Shopping.md"
    listDesktop.files[list] = "- [ ] milk\n- [ ] eggs\n- [ ] milk\n".toByteArray()
    syncListDesktop()
    syncListPhone()
    listDesktop.files[list] = "- [x] milk\n- [ ] eggs\n- [ ] milk\n".toByteArray()
    listPhone.files[list] = "- [ ] milk\n- [x] eggs\n- [ ] milk\n".toByteArray()
    syncListDesktop()
    check(syncListPhone().let { it.uploaded == 1 && it.conflicts == 0 })
    check(syncListDesktop().downloaded == 1)
    check(String(listDesktop.files.getValue(list)) == "- [x] milk\n- [x] eggs\n- [ ] milk\n" && listDesktop.files.getValue(list).contentEquals(listPhone.files.getValue(list)))
    check(listDesktop.copies.isEmpty() && listPhone.copies.isEmpty())
    // Without the shared version it is both versions, as before, with nothing lost.
    listRemote.history.clear()
    listDesktop.files[list] = "- [x] milk\n- [x] eggs\n- [x] milk\n".toByteArray()
    listPhone.files[list] = "- [ ] milk\n- [x] eggs\n- [ ] milk\n".toByteArray()
    syncListDesktop()
    check(syncListPhone().conflicts == 1 && String(listPhone.files.getValue(list)) == "- [ ] milk\n- [x] eggs\n- [ ] milk\n")

    // A shared space's folder is not part of the vault, in either direction; an ordinary folder called Shared is.
    val spaceRemote = CheckRemote()
    val spaceDevice = CheckLocal()
    val spaces = mutableMapOf<String, CloudSyncBase>()
    fun syncSpaces() = CloudSyncEngine.sync(spaceRemote, spaceDevice, spaces) {}
    val spaceNote = "notes/Shared/3f2a1c9e-8b7d-4e6f-a5c4-1d2e3f4a5b6c/List.md"
    val ordinary = "notes/Shared/Holiday.md"
    spaceDevice.files[spaceNote] = "From the space\n".toByteArray()
    spaceDevice.files[ordinary] = "My own note\n".toByteArray()
    check(syncSpaces().uploaded == 1 && spaceRemote.files.keys == setOf(ordinary))
    // An old app uploaded the space's note into the vault: it stays there untouched and does not come down.
    val oldCopy = "notes/Shared/3F2A1C9E-8B7D-4E6F-A5C4-1D2E3F4A5B6C/Old.md"
    spaceRemote.write(oldCopy, "Old copy\n".toByteArray(), 0)
    spaces[oldCopy] = CloudSyncBase(1, spaceRemote.files.getValue(oldCopy).hash, false)
    val quiet = syncSpaces()
    check(quiet.uploaded == 0 && quiet.downloaded == 0 && quiet.deleted == 0 && quiet.conflicts == 0)
    check(oldCopy !in spaceDevice.files && !spaceRemote.files.getValue(oldCopy).deleted && oldCopy !in spaces)
    spaceDevice.files.remove(spaceNote)
    check(syncSpaces().deleted == 0 && !spaceRemote.files.getValue(oldCopy).deleted)
    for (path in listOf("notes/Shared/not-an-id/List.md", "notes/Shared/3f2a1c9e-8b7d-4e6f-a5c4-1d2e3f4a5b6c.md", "notes/Other/3f2a1c9e-8b7d-4e6f-a5c4-1d2e3f4a5b6c/List.md")) check(!CloudSyncEngine.isSpacePath(path)) { path }

    println("Native merge checks passed: $cases shared cases, a daily reminder on two devices, text and fields from different devices, ticks on different lines, overlaps keep both versions, shared spaces stay out of the vault")
}

private fun checkScale() {
    val started = System.currentTimeMillis()
    val cloud = ScaleCloud()
    val a = ScaleDevice(cloud)
    val b = ScaleDevice(cloud)
    var total = 0L
    for (n in 0 until 4500) { a.set("notes/Folder ${n % 30}/Note $n.md", "notes/$n#1#2048"); total += 2048 }
    for (n in 0 until 500) {
        val size = if (n < 10) CloudCrypto.MAX_FILE_BYTES else 520 * 1024
        a.set("attachments/photo-$n.jpg", "attachments/$n#1#$size")
        total += size
    }
    check(total > 290L * 1024 * 1024)
    check(a.sync() == CloudSyncReport(uploaded = 5000))
    a.reads = 0
    cloud.reads = 0
    check(a.sync() == CloudSyncReport())
    check(a.reads == 0 && cloud.reads == 0) { "A quiet sync reads and downloads nothing" }

    // A new device, cut off twice: once while it learns the cloud, once while it downloads.
    check(runCatching { b.sync { check(cloud.reads < 2000) { "Cut off" } } }.isFailure)
    b.restart()
    val learned = b.index.objects.size
    check(learned >= 1000) { "Files learned before the cut-off are kept" }
    cloud.reads = 0
    check(runCatching { b.sync { check(b.writes < 1500) { "Cut off" } } }.isFailure)
    b.restart()
    check(cloud.reads - b.writes <= 5000 - learned + 1) { "A resumed listing reads only the files it had not learned" }
    val resumed = b.sync()
    check(resumed.uploaded == 0 && resumed.conflicts == 0)
    check(b.writes == 5000) { "Every file arrives exactly once" }
    check(b.files == a.files)

    // Downloaded files are read once more to learn their time; after that a quiet sync reads nothing.
    b.sync()
    b.reads = 0
    cloud.reads = 0
    check(b.sync() == CloudSyncReport() && b.reads == 0 && cloud.reads == 0)

    // Small changes stay small.
    for (n in 0 until 10) a.set("notes/Folder ${n % 30}/Note $n.md", "notes/$n#2#2100")
    for (n in 10 until 15) a.files.remove("notes/Folder ${n % 30}/Note $n.md")
    a.reads = 0
    check(a.sync() == CloudSyncReport(uploaded = 10, deleted = 5) && a.reads == 10)
    cloud.reads = 0
    check(b.sync() == CloudSyncReport(downloaded = 10, deleted = 5) && cloud.reads <= 15)

    // A device that already has the files learns the cloud from manifests alone: no piece is downloaded.
    val c = ScaleDevice(cloud)
    for ((path, recipe) in a.files) c.set(path, recipe)
    cloud.downloads = 0
    check(c.sync() == CloudSyncReport() && cloud.downloads == 0)
    println("Native sync scale check passed: 5,000 files, ${total / 1024 / 1024} MiB in a ${Runtime.getRuntime().maxMemory() / 1024 / 1024} MiB heap, cut off twice and resumed, ${(System.currentTimeMillis() - started) / 1000} s")
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
    check(syncB().let { it.conflicts == 1 && it.conflictPaths == listOf(note) })
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
    // A file over 4 MiB stays on its device and the rest syncs; a synced file that grows past it is never deleted elsewhere.
    val bigRemote = CheckRemote()
    val oversized = CheckLocal().also { it.files[note] = ByteArray(CloudCrypto.MAX_FILE_BYTES + 1); it.files["attachments/small.bin"] = ByteArray(10) }
    val bigTracked = mutableMapOf<String, CloudSyncBase>()
    val bigReport = CloudSyncEngine.sync(bigRemote, oversized, bigTracked) {}
    check(bigReport == CloudSyncReport(uploaded = 1, skipped = mutableListOf(note)))
    // The report names what went up, for the "Sealed" stamp; never a file that stayed on the device.
    check(bigReport.uploadedPaths == listOf("attachments/small.bin"))
    check(note !in bigRemote.files)
    oversized.files["attachments/small.bin"] = ByteArray(CloudCrypto.MAX_FILE_BYTES + 1)
    check(CloudSyncEngine.sync(bigRemote, oversized, bigTracked) {} == CloudSyncReport(skipped = mutableListOf("attachments/small.bin", note)))
    check(!bigRemote.files.getValue("attachments/small.bin").deleted && bigRemote.files.getValue("attachments/small.bin").bytes.size == 10)
    // The plan's maximum replaces 4 MiB: a 5 MiB photo goes along, a file over the maximum stays.
    val planRemote = CheckRemote()
    val planLocal = CheckLocal().also { it.files["attachments/photo.jpg"] = ByteArray(5 * 1024 * 1024); it.files["attachments/video.mp4"] = ByteArray(7 * 1024 * 1024) }
    check(CloudSyncEngine.sync(planRemote, planLocal, mutableMapOf(), maxFileBytes = 6L * 1024 * 1024) {} == CloudSyncReport(uploaded = 1, skipped = mutableListOf("attachments/video.mp4")))
    val stopped = CheckRemote()
    val unsent = CheckLocal().also { it.files[note] = "retained after pause".toByteArray() }
    check(runCatching { CloudSyncEngine.sync(stopped, unsent, mutableMapOf(), { error("Paused") }) {} }.isFailure)
    check(stopped.files.isEmpty() && String(unsent.files.getValue(note)) == "retained after pause")
    // A quiet sync reads no unchanged local file again.
    val quiet = CheckLocal().also { it.files["notes/quiet.md"] = "quiet".toByteArray() }
    val quietSeen = mutableMapOf<String, CloudSeenFile>()
    val quietRemote = CheckRemote()
    val quietTracked = mutableMapOf<String, CloudSyncBase>()
    CloudSyncEngine.sync(quietRemote, quiet, quietTracked, seen = quietSeen) {}
    quiet.reads = 0
    quietRemote.downloads = 0
    check(CloudSyncEngine.sync(quietRemote, quiet, quietTracked, seen = quietSeen) {} == CloudSyncReport() && quiet.reads == 0 && quietRemote.downloads == 0)
    println("Native sync checks passed: two devices, binary attachments, offline conflicts, CAS races, delete/recreate/restore, lost responses, persisted baselines and fail-closed limits")
    checkMerge()
    checkScale()
}

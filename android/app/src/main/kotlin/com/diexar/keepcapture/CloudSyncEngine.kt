package com.diexar.keepcapture

import java.security.MessageDigest

/** One cloud file with its content, as read from the server. */
data class CloudPreviewFile(val id: String, val revision: Int, val path: String, val bytes: ByteArray, val deleted: Boolean)
/**
 * A cloud file's manifest: path and fingerprint without downloading its pieces. [hash] has the form of
 * [CloudSyncEngine.hash]; [bytes] is set when the file is inside the manifest (a v1 object or a small v2 file).
 */
class CloudManifest(val id: String, val revision: Int, val path: String, val deleted: Boolean, val size: Int, val hash: String, val pieces: List<CloudPiece>, val bytes: ByteArray?)
data class CloudPiece(val name: String, val size: Int)
/** What the cloud acknowledged for a write or delete; a delete can give [hash] without the file's bytes. */
data class CloudSyncObject(val path: String, val bytes: ByteArray, val revision: Int, val deleted: Boolean = false, val hash: String = CloudSyncEngine.hash(bytes))
/** A cloud file as the sync sees it; [bytes] downloads it only when it is needed. */
class CloudSyncEntry(val path: String, val revision: Int, val deleted: Boolean, val hash: String, val bytes: () -> ByteArray)
data class CloudSyncBase(val revision: Int, val hash: String, val deleted: Boolean = false)
/** [skipped]: files over the maximum per file, left alone on this device. */
data class CloudSyncReport(var uploaded: Int = 0, var downloaded: Int = 0, var deleted: Int = 0, var conflicts: Int = 0, val skipped: MutableList<String> = mutableListOf(), val conflictPaths: MutableList<String> = mutableListOf()) {
    /** The paths this sync stored in the cloud, for the "Sealed" stamp on a new card; not part of comparing reports. */
    val uploadedPaths: MutableList<String> = mutableListOf()
}
/** A local file without reading it. */
data class CloudLocalFile(val size: Long, val modified: Long)
/** The hash of a local file as it was at this size and modification time. */
data class CloudSeenFile(val size: Long, val modified: Long, val hash: String)
/** A cloud file without its content, as the changes feed and one read gave it. */
data class CloudIndexedFile(val path: String, val revision: Int, val deleted: Boolean, val hash: String)
/** The cloud as last read from the changes feed: every file by id, and the changes still to read. */
class CloudRemoteIndex(var cursor: Long = 0, val objects: MutableMap<String, CloudIndexedFile> = linkedMapOf(), val pending: MutableMap<String, Int> = linkedMapOf())
data class CloudChange(val id: String, val revision: Int)
data class CloudChanges(val changes: List<CloudChange>, val cursor: Long, val hasMore: Boolean)

interface CloudSyncRemote {
    fun list(): List<CloudSyncEntry>
    fun write(path: String, bytes: ByteArray, baseRevision: Int): CloudSyncObject
    fun delete(path: String, baseRevision: Int): CloudSyncObject
    /** That older version's bytes, to merge a note changed on two devices; null when the cloud no longer has it. */
    fun base(path: String, revision: Int): ByteArray? = null
}

interface CloudSyncLocal {
    fun list(): Map<String, CloudLocalFile>
    fun read(path: String): ByteArray
    fun compareAndSet(path: String, expected: ByteArray?, replacement: ByteArray?): Boolean
    fun conflict(path: String, remoteRevision: Int, remoteBytes: ByteArray)
}

/**
 * Reconcile only against acknowledged baselines, never timestamps or missing remote entries; the same rules as
 * cloud/shared/sync.mjs. No limit on the number of files or their total size: one file at a time is in memory, and
 * `seen` keeps each local file's hash by size and time, so a sync reads only what changed.
 */
object CloudSyncEngine {
    /** Cloud files read while listing stay in memory up to this much, so a first sync does not download them twice. */
    const val KEPT_BYTES = 16 * 1024 * 1024
    /** Progress is saved at least this often; a sync cut off in between redoes no upload or download twice. */
    private const val SAVE_EVERY_MS = 1000L
    /** Notes up to this size merge when two devices changed different parts; bigger ones keep both versions. */
    const val MERGE_BYTES = 1024 * 1024

    fun hash(bytes: ByteArray): String = CloudCrypto.encode(MessageDigest.getInstance("SHA-256").digest(bytes))
    fun path(value: String, allowPreserved: Boolean = false): String {
        CloudCrypto.safePath(value)
        require(value.startsWith("notes/") || value.startsWith("attachments/")) { "File is outside the cloud note and attachment folders" }
        require(value.split('/').none { it.startsWith('.') || !allowPreserved && (it.contains(".cloud-conflict-") || it.contains(".cloud-recovery-")) }) { "Cloud sync does not accept hidden or preserved-copy paths" }
        require(!value.startsWith("notes/") || value.endsWith(".md", true)) { "Cloud notes must be Markdown files" }
        return value
    }

    fun sync(remote: CloudSyncRemote, local: CloudSyncLocal, tracked: MutableMap<String, CloudSyncBase>, checkActive: () -> Unit = {},
        seen: MutableMap<String, CloudSeenFile> = mutableMapOf(), progress: (Int, Int) -> Unit = { _, _ -> },
        maxFileBytes: Long = CloudCrypto.MAX_FILE_BYTES.toLong(), persist: (Map<String, CloudSyncBase>) -> Unit): CloudSyncReport {
        checkActive()
        val result = CloudSyncReport()
        val files = local.list()
        val entries = remote.list()
        require(entries.map { it.path }.distinct().size == entries.size) { "Duplicate encrypted cloud paths" }
        val clouds = entries.associateBy { path(it.path) }
        for ((name, file) in files) {
            path(name)
            // Too big for one cloud file: it stays on this device as it is, nothing about it changes anywhere, the rest syncs.
            if (file.size > maxFileBytes) result.skipped += name
        }
        result.skipped.sort()
        for (entry in entries) require(entry.revision > 0) { "Invalid cloud file or revision" }
        seen.keys.retainAll(files.keys)
        // A full free cloud clears notes that sat in the trash for 30 days; then the name can start over at revision 1.
        val cleared = tracked.filter { (name, base) -> base.deleted && (clouds[name]?.revision ?: 0) < base.revision }.keys
        for ((name, base) in tracked) {
            path(name)
            require(base.revision > 0 && CloudCrypto.decode(base.hash).size == 32) { "Invalid saved cloud baseline" }
            if (name in cleared) continue
            require(clouds.containsKey(name)) { "A tracked cloud object disappeared. Local files were kept" }
            require(clouds.getValue(name).revision >= base.revision) { "Cloud history moved backwards. Local files were kept" }
        }
        // Decisions read `next`; `tracked` follows only once `next` is saved.
        val next = tracked.toMutableMap()
        var dirty = false
        var savedAt = System.currentTimeMillis()
        fun flush() {
            if (!dirty) return
            val saved = next.toMap()
            persist(saved)
            dirty = false
            savedAt = System.currentTimeMillis()
            tracked.clear()
            tracked.putAll(saved)
        }
        fun remember(path: String, base: CloudSyncBase) {
            next[path] = base
            dirty = true
            if (System.currentTimeMillis() - savedAt >= SAVE_EVERY_MS) flush()
        }
        fun remember(entry: CloudSyncEntry) = remember(entry.path, CloudSyncBase(entry.revision, entry.hash, entry.deleted))
        fun remember(saved: CloudSyncObject) = remember(saved.path, CloudSyncBase(saved.revision, saved.hash, saved.deleted))
        if (cleared.isNotEmpty()) { next -= cleared; dirty = true; flush() }
        fun conflict(entry: CloudSyncEntry, bytes: ByteArray? = null) {
            result.conflicts++
            result.conflictPaths += entry.path
            local.conflict(entry.path, entry.revision, bytes ?: entry.bytes())
        }
        fun upload(name: String, read: ByteArray?, baseRevision: Int) {
            val bytes = read ?: local.read(name)
            val saved = remote.write(name, bytes, baseRevision)
            require(saved.path == name && !saved.deleted && saved.bytes.contentEquals(bytes) && saved.revision == baseRevision + 1) { "Invalid cloud write acknowledgment" }
            remember(saved)
            result.uploaded++
            result.uploadedPaths += name
        }
        // The hash of a local file, read only when its size or time changed (or is unknown); the bytes come along only when just read.
        fun scan(name: String): Pair<String, ByteArray?> {
            val file = files.getValue(name)
            seen[name]?.takeIf { file.size >= 0 && file.modified > 0 && it.size == file.size && it.modified == file.modified }?.let { return it.hash to null }
            val bytes = local.read(name)
            val value = hash(bytes)
            seen[name] = CloudSeenFile(file.size, file.modified, value)
            return value to bytes
        }
        // The file as the decision saw it, or null when it changed or went away since; then nothing local is replaced.
        fun unchanged(name: String, localHash: String, read: ByteArray? = null): ByteArray? =
            read ?: runCatching { local.read(name) }.getOrNull()?.takeIf { hash(it) == localHash }
        fun replace(name: String, expected: ByteArray?, replacement: ByteArray?): Boolean = expected != null && local.compareAndSet(name, expected, replacement)
        // Both sides changed a note. When the changes do not overlap, measured against the version both last shared
        // (from the cloud's history, when it can still be read), one merged note goes both ways instead of a copy.
        fun merge(entry: CloudSyncEntry, base: CloudSyncBase?, localHash: String, read: ByteArray?, theirs: ByteArray): Boolean {
            val mine = unchanged(entry.path, localHash, read) ?: return false
            if (mine.size > MERGE_BYTES || theirs.size > MERGE_BYTES) return false
            val old = if (base != null && !base.deleted) remote.base(entry.path, base.revision)?.takeIf { hash(it) == base.hash } else null
            val note = CloudNoteMerge.merge(old, mine, theirs) ?: return false
            val noteHash = hash(note)
            if (noteHash == entry.hash) {
                if (!local.compareAndSet(entry.path, mine, note)) return false
                remember(entry)
                result.downloaded++
                return true
            }
            if (noteHash != localHash && !local.compareAndSet(entry.path, mine, note)) return false
            upload(entry.path, note, entry.revision)
            return true
        }
        val removals = mutableListOf<() -> Unit>()
        // Upload/download destinations before removing sources of archive/trash moves.
        val names = (files.keys + clouds.keys - result.skipped.toSet()).sortedWith(compareBy<String> { !it.startsWith("attachments/") }.thenBy { it })
        try {
            for ((done, name) in names.withIndex()) {
                checkActive()
                progress(done, names.size)
                val entry = clouds[name]
                val base = next[name]
                val (localHash, bytes) = if (name in files) scan(name) else null to null
                if (entry == null) {
                    check(base == null)
                    if (localHash != null) upload(name, bytes, 0)
                    continue
                }
                if (entry.deleted) {
                    when {
                        localHash == null -> remember(entry)
                        base?.deleted == true -> upload(name, bytes, entry.revision)
                        base != null && base.hash == localHash -> removals.add {
                            if (replace(name, unchanged(name, localHash), null)) { remember(entry); result.deleted++ }
                            else conflict(entry)
                        }
                        else -> conflict(entry)
                    }
                    continue
                }
                if (localHash == null) {
                    if (base == null || base.deleted) {
                        if (local.compareAndSet(name, null, entry.bytes())) { remember(entry); result.downloaded++ }
                        else conflict(entry)
                    } else if (base.revision == entry.revision && base.hash == entry.hash) {
                        removals.add {
                            if (!local.compareAndSet(name, null, null)) { conflict(entry); return@add }
                            val saved = remote.delete(name, entry.revision)
                            require(saved.path == name && saved.deleted && saved.revision == entry.revision + 1 && saved.hash == entry.hash) { "Invalid cloud delete acknowledgment" }
                            remember(saved)
                            result.deleted++
                        }
                    } else conflict(entry)
                    continue
                }
                when {
                    localHash == entry.hash -> remember(entry)
                    base != null && !base.deleted && base.hash == localHash && base.revision != entry.revision -> {
                        if (replace(name, unchanged(name, localHash, bytes), entry.bytes())) { remember(entry); result.downloaded++ }
                        else conflict(entry)
                    }
                    base != null && !base.deleted && base.revision == entry.revision && base.hash == entry.hash -> upload(name, bytes, entry.revision)
                    else -> {
                        val theirs = if (name.startsWith("notes/")) entry.bytes() else null
                        if (theirs == null || !merge(entry, base, localHash, bytes, theirs)) conflict(entry, theirs)
                    }
                }
            }
            removals.forEach { checkActive(); it() }
            progress(names.size, names.size)
        } catch (error: Throwable) {
            // Keep what was done; the error that stopped the sync is the one to report.
            runCatching { flush() }
            throw error
        }
        flush()
        return result
    }

    /**
     * The cloud side for [sync], kept up to date from the changes feed so a sync only reads what changed. [index] is
     * updated in place and [save] keeps it, so a first sync cut off halfway goes on from where it was. [read] gives a
     * manifest, or null for a file cleared from a full free cloud after 30 days in the trash; [download] gives the
     * file's bytes from its manifest, only for a file that is missing or different here.
     */
    fun remoteFiles(index: CloudRemoteIndex, changes: (Long) -> CloudChanges, read: (String) -> CloudManifest?, download: (CloudManifest) -> ByteArray,
        checkActive: () -> Unit = {}, save: () -> Unit = {}, progress: (Int, Int) -> Unit = { _, _ -> }): List<CloudSyncEntry> {
        do {
            checkActive()
            val page = changes(index.cursor)
            for (change in page.changes) {
                if (index.objects[change.id]?.revision == change.revision) index.pending.remove(change.id)
                else index.pending[change.id] = change.revision
            }
            require(!page.hasMore || page.cursor > index.cursor) { "Invalid cloud changes cursor" }
            index.cursor = page.cursor
        } while (page.hasMore)
        save()
        val loaded = mutableMapOf<String, ByteArray>()
        var kept = 0
        var savedAt = System.currentTimeMillis()
        val waiting = index.pending.keys.toList()
        try {
            for ((done, id) in waiting.withIndex()) {
                checkActive()
                progress(done, waiting.size)
                val file = read(id)
                index.pending.remove(id)
                if (file == null) { index.objects.remove(id); continue }
                require(file.id == id && file.revision > 0) { "Invalid cloud file or revision" }
                index.objects[id] = CloudIndexedFile(path(file.path), file.revision, file.deleted, file.hash)
                file.bytes?.let { if (kept + it.size <= KEPT_BYTES) { loaded[id] = it; kept += it.size } }
                if (System.currentTimeMillis() - savedAt >= SAVE_EVERY_MS) { save(); savedAt = System.currentTimeMillis() }
            }
        } catch (error: Throwable) {
            runCatching { save() }
            throw error
        }
        if (waiting.isNotEmpty()) save()
        return index.objects.map { (id, item) ->
            CloudSyncEntry(item.path, item.revision, item.deleted, item.hash) {
                loaded.remove(id) ?: requireNotNull(read(id)) { "Cloud file changed during sync. Local files were kept" }.let {
                    // The current version, like the web: the free plan locks older versions, never the newest.
                    require(it.revision == item.revision && it.path == item.path && it.hash == item.hash) { "Cloud file changed during sync. Local files were kept" }
                    download(it)
                }
            }
        }
    }
}

data class CloudCurrentFile(val id: String, val revision: Int, val deleted: Boolean)
/** A file as it was at a moment; `revision` is null when a full free cloud cleared that version. */
data class CloudMomentFile(val id: String, val revision: Int?, val deleted: Boolean, val locked: Boolean, val cleared: Boolean)
sealed interface CloudMomentStep {
    data class Restore(val id: String, val revision: Int, val baseRevision: Int) : CloudMomentStep
    data class Delete(val id: String, val baseRevision: Int) : CloudMomentStep
}

/** The time machine, like the web app's: steps through the minutes with a change and restores a moment as new versions. */
object CloudTimeMachine {
    /** The last change time of each minute with a change, oldest first. */
    fun steps(times: List<String>): List<String> = times.groupBy { it.take(16) }.values.map { it.max() }.sorted()

    /** Files from then that the free plan cannot open or that were cleared; a moment comes back whole or not at all. */
    fun unavailable(current: List<CloudCurrentFile>, then: List<CloudMomentFile>): List<CloudMomentFile> {
        val revisions = current.associate { it.id to it.revision }
        return then.filter { (it.locked || it.cleared) && revisions[it.id] != it.revision }
    }

    /** Files from then come back, files made later move to the trash; nothing is erased. */
    fun restorePlan(current: List<CloudCurrentFile>, then: List<CloudMomentFile>): List<CloudMomentStep> {
        require(unavailable(current, then).isEmpty()) { "JotDrop Plus restores this moment" }
        val old = then.associateBy { it.id }
        return current.mapNotNull { file ->
            val version = old[file.id]
            when {
                version?.revision == file.revision -> null
                version == null || version.deleted -> if (file.deleted) null else CloudMomentStep.Delete(file.id, file.revision)
                else -> CloudMomentStep.Restore(file.id, requireNotNull(version.revision), file.revision)
            }
        }
    }
}

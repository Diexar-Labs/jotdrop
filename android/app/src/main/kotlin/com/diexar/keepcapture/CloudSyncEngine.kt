package com.diexar.keepcapture

import java.security.MessageDigest

data class CloudSyncObject(val path: String, val bytes: ByteArray, val revision: Int, val deleted: Boolean = false)
data class CloudSyncBase(val revision: Int, val hash: String, val deleted: Boolean = false)
data class CloudSyncReport(var uploaded: Int = 0, var downloaded: Int = 0, var deleted: Int = 0, var conflicts: Int = 0)

interface CloudSyncRemote {
    fun list(): List<CloudSyncObject>
    fun write(path: String, bytes: ByteArray, baseRevision: Int): CloudSyncObject
    fun delete(path: String, baseRevision: Int): CloudSyncObject
}

interface CloudSyncLocal {
    fun list(): Map<String, ByteArray>
    fun compareAndSet(path: String, expected: ByteArray?, replacement: ByteArray?): Boolean
    fun conflict(path: String, remoteRevision: Int, remoteBytes: ByteArray)
}

/** Reconcile only against acknowledged baselines, never timestamps or missing remote entries. */
object CloudSyncEngine {
    fun hash(bytes: ByteArray): String = CloudCrypto.encode(MessageDigest.getInstance("SHA-256").digest(bytes))
    fun path(value: String, allowPreserved: Boolean = false): String {
        CloudCrypto.safePath(value)
        require(value.startsWith("notes/") || value.startsWith("attachments/")) { "File is outside the cloud note and attachment folders" }
        require(value.split('/').none { it.startsWith('.') || !allowPreserved && (it.contains(".cloud-conflict-") || it.contains(".cloud-recovery-")) }) { "Cloud sync does not accept hidden or preserved-copy paths" }
        require(!value.startsWith("notes/") || value.endsWith(".md", true)) { "Cloud notes must be Markdown files" }
        return value
    }

    fun sync(remote: CloudSyncRemote, local: CloudSyncLocal, tracked: MutableMap<String, CloudSyncBase>, checkActive: () -> Unit = {}, persist: (Map<String, CloudSyncBase>) -> Unit): CloudSyncReport {
        checkActive()
        val result = CloudSyncReport()
        val files = local.list()
        val entries = remote.list()
        require(files.size <= 500 && entries.size <= 500 && tracked.size <= 500) { "Cloud sync supports at most 500 files" }
        require(entries.map { it.path }.distinct().size == entries.size) { "Duplicate encrypted cloud paths" }
        val clouds = entries.associateBy { path(it.path) }
        require((files.keys + clouds.keys).size <= 500) { "Cloud sync supports at most 500 distinct files" }
        var total = 0L
        for ((name, bytes) in files) {
            path(name)
            require(bytes.size <= CloudCrypto.MAX_FILE_BYTES) { "Cloud files must be 4 MiB or smaller" }
            total += bytes.size
        }
        for (entry in entries) {
            require(entry.revision > 0 && entry.bytes.size <= CloudCrypto.MAX_FILE_BYTES) { "Invalid cloud file or revision" }
            total += entry.bytes.size
        }
        // ponytail: bounded snapshot sync; use a streaming indexed journal for larger vaults.
        require(total <= 64 * 1024 * 1024) { "Cloud sync working set exceeds 64 MiB" }
        // A full free cloud clears notes that sat in the trash for 30 days; then the name can start over at revision 1.
        val cleared = tracked.filter { (name, base) -> base.deleted && (clouds[name]?.revision ?: 0) < base.revision }.keys
        for ((name, base) in tracked) {
            path(name)
            require(base.revision > 0 && CloudCrypto.decode(base.hash).size == 32) { "Invalid saved cloud baseline" }
            if (name in cleared) continue
            require(clouds.containsKey(name)) { "A tracked cloud object disappeared. Local files were kept" }
            require(clouds.getValue(name).revision >= base.revision) { "Cloud history moved backwards. Local files were kept" }
        }
        if (cleared.isNotEmpty()) {
            val next = tracked - cleared
            persist(next)
            tracked.clear()
            tracked.putAll(next)
        }
        fun remember(entry: CloudSyncObject) {
            val next = tracked.toMutableMap()
            next[entry.path] = CloudSyncBase(entry.revision, hash(entry.bytes), entry.deleted)
            persist(next)
            tracked.clear()
            tracked.putAll(next)
        }
        fun conflict(entry: CloudSyncObject) {
            result.conflicts++
            local.conflict(entry.path, entry.revision, entry.bytes)
        }
        val removals = mutableListOf<() -> Unit>()
        // Upload/download destinations before removing sources of archive/trash moves.
        for (name in (files.keys + clouds.keys).sortedWith(compareBy<String> { !it.startsWith("attachments/") }.thenBy { it })) {
            checkActive()
            val bytes = files[name]
            val entry = clouds[name]
            val base = tracked[name]
            if (entry == null) {
                check(base == null)
                if (bytes != null) {
                    val saved = remote.write(name, bytes, 0)
                    require(saved.path == name && !saved.deleted && saved.bytes.contentEquals(bytes) && saved.revision == 1) { "Invalid cloud write acknowledgment" }
                    remember(saved)
                    result.uploaded++
                }
                continue
            }
            if (entry.deleted) {
                when {
                    bytes == null -> remember(entry)
                    base?.deleted == true -> {
                        val saved = remote.write(name, bytes, entry.revision)
                        require(saved.path == name && !saved.deleted && saved.bytes.contentEquals(bytes) && saved.revision == entry.revision + 1) { "Invalid cloud write acknowledgment" }
                        remember(saved)
                        result.uploaded++
                    }
                    base != null && base.hash == hash(bytes) -> removals.add {
                        if (local.compareAndSet(name, bytes, null)) { remember(entry); result.deleted++ }
                        else conflict(entry)
                    }
                    else -> conflict(entry)
                }
                continue
            }
            if (bytes == null) {
                if (base == null || base.deleted) {
                    if (local.compareAndSet(name, null, entry.bytes)) { remember(entry); result.downloaded++ }
                    else conflict(entry)
                } else if (base.revision == entry.revision && base.hash == hash(entry.bytes)) {
                    removals.add {
                        if (!local.compareAndSet(name, null, null)) { conflict(entry); return@add }
                        val saved = remote.delete(name, entry.revision)
                        require(saved.path == name && saved.deleted && saved.revision == entry.revision + 1 && saved.bytes.contentEquals(entry.bytes)) { "Invalid cloud delete acknowledgment" }
                        remember(saved)
                        result.deleted++
                    }
                } else conflict(entry)
                continue
            }
            val localHash = hash(bytes)
            val remoteHash = hash(entry.bytes)
            when {
                localHash == remoteHash -> remember(entry)
                base != null && !base.deleted && base.hash == localHash && base.revision != entry.revision -> {
                    if (local.compareAndSet(name, bytes, entry.bytes)) { remember(entry); result.downloaded++ }
                    else conflict(entry)
                }
                base != null && !base.deleted && base.revision == entry.revision && base.hash == remoteHash -> {
                    val saved = remote.write(name, bytes, entry.revision)
                    require(saved.path == name && !saved.deleted && saved.bytes.contentEquals(bytes) && saved.revision == entry.revision + 1) { "Invalid cloud write acknowledgment" }
                    remember(saved)
                    result.uploaded++
                }
                else -> conflict(entry)
            }
        }
        removals.forEach { checkActive(); it() }
        return result
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

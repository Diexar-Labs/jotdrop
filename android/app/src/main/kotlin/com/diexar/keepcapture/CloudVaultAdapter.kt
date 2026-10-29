package com.diexar.keepcapture

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import androidx.documentfile.provider.DocumentFile
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.withLock
import java.io.ByteArrayOutputStream
import java.util.UUID

/** Strict SAF reads: provider failures must never look like locally deleted files. */
class CloudVaultAdapter(
    private val context: Context,
    private val beforeMutation: (String, String?, String?) -> Unit = { _, _, _ -> },
    private val afterMutation: () -> Unit = {},
    // Only for saving recovery copies: one local file, like a captured note, never two sync systems.
    private val allowOtherSync: Boolean = false,
) : CloudSyncLocal {
    private val treeUri = requireNotNull(Storage.getVaultUri(context)) { "Choose a local vault in Settings first" }
    private val notes = CloudCrypto.safePath(Storage.getSubfolder(context))
    private val assets = CloudCrypto.safePath(Storage.resolveAssetsFolder(context))
    private val legacyAssets = "$notes/.attachments"
    private val tree = requireNotNull(DocumentFile.fromTreeUri(context, treeUri)) { "Local vault is unavailable" }
    val binding = listOf(treeUri.toString(), notes, assets).joinToString("\n")

    companion object {
        /** The same binding as an adapter would have, without opening the folder. */
        fun binding(context: Context): String? = Storage.getVaultUri(context)?.let {
            listOf(it.toString(), CloudCrypto.safePath(Storage.getSubfolder(context)), CloudCrypto.safePath(Storage.resolveAssetsFolder(context))).joinToString("\n")
        }
    }

    init {
        require(assets != notes && !notes.startsWith("$assets/") && assets != "$notes/Archive" && assets != "$notes/Trash") { "Note and attachment folders overlap" }
        require(assets == legacyAssets || !assets.startsWith("$notes/")) { "Keep custom attachments outside the note folder" }
        check(tree.canRead() && tree.canWrite()) { "Local vault permission is missing. Choose the folder again in Settings" }
        validate()
    }

    fun validateBinding() {
        check(Storage.getVaultUri(context) == treeUri && Storage.getSubfolder(context) == notes && Storage.resolveAssetsFolder(context) == assets) { "Vault settings changed. Pause and re-enable cloud sync for the intended folder" }
    }

    fun validate() {
        validateBinding()
        for (folder in listOf(notes, assets, legacyAssets).distinct()) {
            var current = tree
            for (segment in listOf("") + folder.split('/')) {
                val entries = children(current)
                check(allowOtherSync || entries.none { it.name.lowercase() in setOf(".stfolder", ".stignore", ".stversions") }) { "Syncthing markers found. Never run two sync systems on the same vault" }
                if (segment.isEmpty()) continue
                val next = entries.firstOrNull { it.name == segment } ?: break
                check(next.directory) { "Local folder path is occupied by a file" }
                current = next.file
            }
        }
    }

    private fun folder(path: String, create: Boolean): DocumentFile? {
        var current = tree
        for (segment in path.split('/')) {
            val entries = children(current)
            check(allowOtherSync || entries.none { it.name.lowercase() in setOf(".stfolder", ".stignore", ".stversions") }) { "Syncthing markers found. Cloud sync stopped" }
            val found = entries.firstOrNull { it.name == segment }
            current = if (found != null) found.also { check(it.directory) { "Local folder path is occupied" } }.file
                else if (create) {
                    val uri = DocumentsContract.createDocument(context.contentResolver, current.uri, DocumentsContract.Document.MIME_TYPE_DIR, segment) ?: error("Could not create local folder")
                    requireNotNull(DocumentFile.fromSingleUri(context, uri))
                } else return null
        }
        return current
    }

    private fun localPath(path: String): String {
        CloudSyncEngine.path(path, allowPreserved = true)
        return if (path.startsWith("notes/")) "$notes/${path.removePrefix("notes/")}" else "$assets/${path.removePrefix("attachments/")}"
    }

    private fun candidates(path: String): List<DocumentFile> {
        val mapped = localPath(path)
        val paths = if (path.startsWith("attachments/")) listOf(mapped, "$legacyAssets/${path.removePrefix("attachments/")}").distinct() else listOf(mapped)
        return paths.mapNotNull { local -> folder(local.substringBeforeLast('/'), false)?.let { children(it).firstOrNull { child -> child.name == local.substringAfterLast('/') }?.file } }
    }

    private fun find(path: String): DocumentFile? = candidates(path).firstOrNull()

    private fun read(file: DocumentFile): ByteArray {
        check(file.isFile) { "Expected a local file" }
        // The sync leaves files over the plan's maximum alone; this is the largest any plan allows.
        require(file.length() <= CloudCrypto.MAX_CHUNKED_BYTES) { "Local file exceeds the 200 MB sync limit" }
        return (context.contentResolver.openInputStream(file.uri) ?: error("Local file could not be read")).use { input ->
            val output = ByteArrayOutputStream(file.length().toInt().coerceAtLeast(8192))
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                require(output.size() + count <= CloudCrypto.MAX_CHUNKED_BYTES) { "Local file exceeds the 200 MB sync limit" }
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        }
    }

    fun verifyPending(path: String, original: String?, replacement: String?): Boolean {
        val values = candidates(path).map { CloudSyncEngine.hash(read(it)) }.distinct()
        if (values.size > 1) return false
        val current = values.firstOrNull()
        return current == original || current == replacement
    }

    private fun preserved(name: String): Boolean = name.contains(".cloud-conflict-") || name.contains(".cloud-recovery-")

    /**
     * A folder's children with name, type, size and time from one provider query. Asking a DocumentFile for its name
     * or type is a query per file, which made each sync step thousands of queries in a big folder.
     */
    private class Child(val file: DocumentFile, val name: String, val directory: Boolean, val size: Long, val modified: Long)
    private fun children(parent: DocumentFile): List<Child> {
        val uri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, DocumentsContract.getDocumentId(parent.uri))
        val columns = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED)
        val result = mutableListOf<Child>()
        val names = mutableSetOf<String>()
        val cursor = context.contentResolver.query(uri, columns, null, null, null) ?: error("Could not read the local folder. No deletions were inferred")
        cursor.use {
            while (it.moveToNext()) {
                val id = it.getString(0) ?: error("Invalid local document identity")
                val name = it.getString(1) ?: error("Invalid local filename")
                check(names.add(name)) { "Ambiguous duplicate local filenames" }
                val directory = it.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR
                // A provider without a size or time: then the file counts as changed and is read.
                val size = if (it.isNull(3)) -1L else it.getLong(3)
                val modified = if (it.isNull(4)) -1L else it.getLong(4)
                result += Child(requireNotNull(DocumentFile.fromSingleUri(context, DocumentsContract.buildDocumentUriUsingTree(treeUri, id))), name, directory, size, modified)
            }
        }
        return result
    }

    // The files of the last list(), so reading one does not search its folder again.
    private val listed = mutableMapOf<String, DocumentFile>()

    override fun list(): Map<String, CloudLocalFile> = runBlocking {
        Storage.noteWriteMutex.withLock {
            synchronized(Storage.cloudFileLock) {
            validate()
            // Een tijdens deze sync mislukte notitie-write laat een halve notitie plus journaal achter; die niet uploaden.
            check(Storage.recoverInterruptedNoteWrite(context)) { "A note was not saved completely. Sync again; if this repeats, open that note in JotDrop to keep the change as a copy or discard it" }
            val result = linkedMapOf<String, CloudLocalFile>()
            listed.clear()
            fun walk(directory: DocumentFile, prefix: String, attachments: Boolean, depth: Int = 0) {
                require(depth <= 16) { "Cloud folder nesting exceeds the sync limit" }
                for (child in children(directory)) {
                    val name = child.name
                    if (preserved(name)) continue
                    if (name.startsWith('.')) {
                        check(name.lowercase() !in setOf(".stfolder", ".stignore", ".stversions")) { "Syncthing markers found. Cloud sync stopped" }
                        continue
                    }
                    val path = "$prefix/$name"
                    if (child.directory) walk(child.file, path, attachments, depth + 1)
                    else if (attachments || name.endsWith(".md", true)) {
                        CloudSyncEngine.path(path)
                        val old = listed[path]
                        if (old == null) {
                            listed[path] = child.file
                            result[path] = CloudLocalFile(child.size, child.modified)
                        } else require(read(old).contentEquals(read(child.file))) { "Legacy and configured attachments differ. Resolve them before syncing" }
                    }
                }
            }
            folder(notes, false)?.let { walk(it, "notes", false) }
            for (path in listOf(assets, legacyAssets).distinct()) folder(path, false)?.let { walk(it, "attachments", true) }
            result
            }
        }
    }

    override fun read(path: String): ByteArray = runBlocking {
        Storage.noteWriteMutex.withLock {
            synchronized(Storage.cloudFileLock) {
                read(listed[path] ?: find(path) ?: error("Expected a local file. No deletions were inferred"))
            }
        }
    }

    private fun writeNew(path: String, bytes: ByteArray): DocumentFile {
        val mapped = localPath(path)
        val parent = folder(mapped.substringBeforeLast('/'), true) ?: error("Local folder is unavailable")
        check(children(parent).none { it.name == mapped.substringAfterLast('/') }) { "Local destination already exists" }
        val uri = DocumentsContract.createDocument(context.contentResolver, parent.uri, if (path.endsWith(".md", true)) "text/markdown" else "application/octet-stream", mapped.substringAfterLast('/')) ?: error("Could not create local file")
        val target = requireNotNull(DocumentFile.fromSingleUri(context, uri))
        if (target.name != mapped.substringAfterLast('/')) { target.delete(); error("Provider changed the destination filename") }
        write(target, bytes)
        return target
    }

    private fun write(target: DocumentFile, bytes: ByteArray) {
        (context.contentResolver.openOutputStream(target.uri, "wt") ?: error("Could not write local file")).use { it.write(bytes) }
        check(read(target).contentEquals(bytes)) { "Local write verification failed. Preserved copies were kept" }
    }

    private fun copyName(path: String, suffix: String): String {
        val extension = path.lastIndexOf('.').takeIf { it > path.lastIndexOf('/') }
        return if (extension != null) path.substring(0, extension) + suffix + path.substring(extension) else path + suffix
    }

    /** The copy written now, or null when the same copy was already there (that one is never ours to remove). */
    private fun preserve(path: String, bytes: ByteArray, suffix: String): DocumentFile? {
        var name = copyName(path, suffix)
        val old = find(name)
        if (old != null) {
            if (read(old).contentEquals(bytes)) return null
            name = copyName(path, "$suffix-${UUID.randomUUID()}")
        }
        return writeNew(name, bytes)
    }

    fun recoverUpload(path: String, bytes: ByteArray): Unit = runBlocking {
        Storage.noteWriteMutex.withLock {
            synchronized(Storage.cloudFileLock) {
                validate()
                CloudSyncEngine.path(path)
                preserve(path, bytes, ".cloud-recovery-${CloudSyncEngine.hash(bytes).take(12)}")
            }
        }
    }

    override fun compareAndSet(path: String, expected: ByteArray?, replacement: ByteArray?): Boolean = runBlocking {
        Storage.noteWriteMutex.withLock {
            synchronized(Storage.cloudFileLock) {
            validate()
            val files = candidates(path)
            val actual = files.firstOrNull()?.let(::read)
            if ((actual == null) != (expected == null) || (actual != null && !actual.contentEquals(expected!!))) return@withLock false
            if (files.any { CloudSyncManager.isEditing(it.uri) || !read(it).contentEquals(expected!!) }) return@withLock false
            if (replacement == null && files.isEmpty()) return@withLock true
            // SAF has no universal atomic replacement. Verify a visible recovery copy first.
            val copy = actual?.let { preserve(path, it, ".cloud-recovery-${CloudSyncEngine.hash(it).take(12)}") }
            beforeMutation(path, actual?.let(CloudSyncEngine::hash), replacement?.let(CloudSyncEngine::hash))
            if (replacement == null) files.forEach { check(it.delete()) { "Local deletion failed. Recovery copy was kept" } }
            else if (files.isEmpty()) writeNew(path, replacement)
            else files.forEach { write(it, replacement) }
            afterMutation()
            // The change is verified and no longer pending, so the copy has nothing left to guard; left behind, it shows as a duplicate note.
            copy?.delete()
            true
            }
        }
    }

    override fun conflict(path: String, remoteRevision: Int, remoteBytes: ByteArray): Unit = runBlocking {
        Storage.noteWriteMutex.withLock {
            synchronized(Storage.cloudFileLock) {
            validate()
            preserve(path, remoteBytes, ".cloud-conflict-r$remoteRevision")
            }
        }
    }
}

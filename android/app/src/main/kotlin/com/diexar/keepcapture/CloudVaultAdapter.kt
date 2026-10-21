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
) : CloudSyncLocal {
    private val treeUri = requireNotNull(Storage.getVaultUri(context)) { "Choose a local vault in Settings first" }
    private val notes = CloudCrypto.safePath(Storage.getSubfolder(context))
    private val assets = CloudCrypto.safePath(Storage.resolveAssetsFolder(context))
    private val legacyAssets = "$notes/.attachments"
    private val tree = requireNotNull(DocumentFile.fromTreeUri(context, treeUri)) { "Local vault is unavailable" }
    val binding = listOf(treeUri.toString(), notes, assets).joinToString("\n")

    init {
        require(assets != notes && !notes.startsWith("$assets/") && assets != "$notes/Archive" && assets != "$notes/Trash") { "Note and attachment folders overlap" }
        require(assets == legacyAssets || !assets.startsWith("$notes/")) { "Keep custom attachments outside the note folder" }
        check(tree.canRead() && tree.canWrite()) { "Local vault permission is missing. Choose the folder again in Settings" }
        validate()
    }

    private fun children(parent: DocumentFile): List<DocumentFile> {
        val uri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, DocumentsContract.getDocumentId(parent.uri))
        val columns = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME)
        val result = mutableListOf<DocumentFile>()
        val names = mutableSetOf<String>()
        val cursor = context.contentResolver.query(uri, columns, null, null, null) ?: error("Could not read the local folder. No deletions were inferred")
        cursor.use {
            while (it.moveToNext()) {
                val id = it.getString(0) ?: error("Invalid local document identity")
                val name = it.getString(1) ?: error("Invalid local filename")
                check(names.add(name)) { "Ambiguous duplicate local filenames" }
                result += requireNotNull(DocumentFile.fromSingleUri(context, DocumentsContract.buildDocumentUriUsingTree(treeUri, id)))
            }
        }
        return result
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
                check(entries.none { it.name?.lowercase() in setOf(".stfolder", ".stignore", ".stversions") }) { "Syncthing markers found. Never run two sync systems on the same vault" }
                if (segment.isEmpty()) continue
                val next = entries.firstOrNull { it.name == segment } ?: break
                check(next.isDirectory) { "Local folder path is occupied by a file" }
                current = next
            }
        }
    }

    private fun folder(path: String, create: Boolean): DocumentFile? {
        var current = tree
        for (segment in path.split('/')) {
            val entries = children(current)
            check(entries.none { it.name?.lowercase() in setOf(".stfolder", ".stignore", ".stversions") }) { "Syncthing markers found. Cloud sync stopped" }
            val found = entries.firstOrNull { it.name == segment }
            current = if (found != null) found.also { check(it.isDirectory) { "Local folder path is occupied" } }
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
        return paths.mapNotNull { local -> folder(local.substringBeforeLast('/'), false)?.let { children(it).firstOrNull { child -> child.name == local.substringAfterLast('/') } } }
    }

    private fun find(path: String): DocumentFile? = candidates(path).firstOrNull()

    private fun read(file: DocumentFile): ByteArray {
        check(file.isFile) { "Expected a local file" }
        require(file.length() <= CloudCrypto.MAX_FILE_BYTES) { "Local file exceeds the 4 MiB sync limit" }
        return (context.contentResolver.openInputStream(file.uri) ?: error("Local file could not be read")).use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                require(output.size() + count <= CloudCrypto.MAX_FILE_BYTES) { "Local file exceeds the 4 MiB sync limit" }
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

    override fun list(): Map<String, ByteArray> = runBlocking {
        Storage.noteWriteMutex.withLock {
            synchronized(Storage.cloudFileLock) {
            validate()
            // Een tijdens deze sync mislukte notitie-write laat een halve notitie plus journaal achter; die niet uploaden.
            check(Storage.recoverInterruptedNoteWrite(context)) { "A note was not saved completely. Sync again; if this repeats, open that note in JotDrop to keep the change as a copy or discard it" }
            val result = linkedMapOf<String, ByteArray>()
            var total = 0L
            fun walk(directory: DocumentFile, prefix: String, attachments: Boolean, depth: Int = 0) {
                require(depth <= 16) { "Cloud folder nesting exceeds the sync limit" }
                for (child in children(directory)) {
                    val name = requireNotNull(child.name)
                    if (preserved(name)) continue
                    if (name.startsWith('.')) {
                        check(name.lowercase() !in setOf(".stfolder", ".stignore", ".stversions")) { "Syncthing markers found. Cloud sync stopped" }
                        continue
                    }
                    val path = "$prefix/$name"
                    if (child.isDirectory) walk(child, path, attachments, depth + 1)
                    else if (attachments || name.endsWith(".md", true)) {
                        CloudSyncEngine.path(path)
                        val bytes = read(child)
                        val old = result[path]
                        require(old == null || old.contentEquals(bytes)) { "Legacy and configured attachments differ. Resolve them before syncing" }
                        if (old == null) {
                            total += bytes.size
                            require(total <= 64 * 1024 * 1024 && result.size < 500) { "Local sync limit: 500 files and 64 MiB working set" }
                            result[path] = bytes
                        }
                    }
                }
            }
            folder(notes, false)?.let { walk(it, "notes", false) }
            for (path in listOf(assets, legacyAssets).distinct()) folder(path, false)?.let { walk(it, "attachments", true) }
            result
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

    private fun preserve(path: String, bytes: ByteArray, suffix: String) {
        var name = copyName(path, suffix)
        val old = find(name)
        if (old != null) {
            if (read(old).contentEquals(bytes)) return
            name = copyName(path, "$suffix-${UUID.randomUUID()}")
        }
        writeNew(name, bytes)
    }

    fun recoverUpload(path: String, bytes: ByteArray) = runBlocking {
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
            if (actual != null) {
                // SAF has no universal atomic replacement. Verify a visible recovery copy first.
                preserve(path, actual, ".cloud-recovery-${CloudSyncEngine.hash(actual).take(12)}")
            }
            beforeMutation(path, actual?.let(CloudSyncEngine::hash), replacement?.let(CloudSyncEngine::hash))
            if (replacement == null) files.forEach { check(it.delete()) { "Local deletion failed. Recovery copy was kept" } }
            else if (files.isEmpty()) writeNew(path, replacement)
            else files.forEach { write(it, replacement) }
            afterMutation()
            true
            }
        }
    }

    override fun conflict(path: String, remoteRevision: Int, remoteBytes: ByteArray) = runBlocking {
        Storage.noteWriteMutex.withLock {
            synchronized(Storage.cloudFileLock) {
            validate()
            preserve(path, remoteBytes, ".cloud-conflict-r$remoteRevision")
            }
        }
    }
}

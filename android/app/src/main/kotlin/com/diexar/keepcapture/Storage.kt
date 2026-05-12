package com.diexar.keepcapture

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.documentfile.provider.DocumentFile
import androidx.preference.PreferenceManager
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object Storage {
    private const val KEY_VAULT_URI = "vault_tree_uri"
    private const val KEY_SUBFOLDER = "subfolder"
    private const val KEY_SPEECH_LANG = "speech_language"
    const val DEFAULT_SUBFOLDER = "Mini Notes"
    const val DEFAULT_SPEECH_LANG = "nl-NL"

    /**
     * Talen die in de UI worden aangeboden voor spraak-naar-tekst. Bewust beperkt
     * tot vijf veelgebruikte West-Europese talen + Engels — extra talen kunnen
     * later via Android-systeeminstellingen toegevoegd worden zonder code-wijziging.
     */
    val SUPPORTED_SPEECH_LANGS: List<Pair<String, String>> = listOf(
        "nl-NL" to "Nederlands",
        "en-US" to "English (US)",
        "es-ES" to "Español",
        "de-DE" to "Deutsch",
        "fr-FR" to "Français",
        "it-IT" to "Italiano",
    )

    fun getVaultUri(context: Context): Uri? {
        val prefs = PreferenceManager.getDefaultSharedPreferences(context)
        return prefs.getString(KEY_VAULT_URI, null)?.let(Uri::parse)
    }

    fun saveVaultUri(context: Context, uri: Uri) {
        PreferenceManager.getDefaultSharedPreferences(context)
            .edit()
            .putString(KEY_VAULT_URI, uri.toString())
            .apply()
    }

    fun getSubfolder(context: Context): String {
        val prefs = PreferenceManager.getDefaultSharedPreferences(context)
        return prefs.getString(KEY_SUBFOLDER, DEFAULT_SUBFOLDER) ?: DEFAULT_SUBFOLDER
    }

    fun saveSubfolder(context: Context, subfolder: String) {
        PreferenceManager.getDefaultSharedPreferences(context)
            .edit()
            .putString(KEY_SUBFOLDER, subfolder.ifBlank { DEFAULT_SUBFOLDER })
            .apply()
    }

    fun getSpeechLanguage(context: Context): String {
        val prefs = PreferenceManager.getDefaultSharedPreferences(context)
        return prefs.getString(KEY_SPEECH_LANG, DEFAULT_SPEECH_LANG) ?: DEFAULT_SPEECH_LANG
    }

    fun saveSpeechLanguage(context: Context, lang: String) {
        val valid = SUPPORTED_SPEECH_LANGS.any { it.first == lang }
        PreferenceManager.getDefaultSharedPreferences(context)
            .edit()
            .putString(KEY_SPEECH_LANG, if (valid) lang else DEFAULT_SPEECH_LANG)
            .apply()
    }

    fun persistUriPermission(context: Context, uri: Uri) {
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        try {
            context.contentResolver.takePersistableUriPermission(uri, flags)
        } catch (_: SecurityException) {
            // Sommige Android-versies geven dit pas op de eerste schrijfactie; geen reden tot paniek.
        }
    }

    fun saveNote(context: Context, content: String): Result<String> {
        return createNote(context, content).map { it.first }
    }

    /**
     * Kopieert een via share-intent ontvangen afbeelding naar `.attachments` en
     * maakt een notitie aan met een Obsidian-style image-embed. Werkt voor zowel
     * lokale (camera roll) als cloud-URI's (Google Photos), zolang de share-intent
     * tijdens deze call leesrechten geeft.
     */
    fun saveImageNote(
        context: Context,
        imageUri: Uri,
        subject: String?,
        extraText: String?,
    ): Result<String> {
        val basename = copyImageToAttachments(context, imageUri).getOrElse {
            return Result.failure(it)
        }
        val stamp = SimpleDateFormat("yyyy-MM-dd HHmmss", Locale.US).format(Date())
        val title = subject?.trim()?.takeIf { it.isNotEmpty() } ?: "Foto $stamp"
        val body = buildString {
            append("# "); append(title); append("\n\n")
            append("![["); append(basename); append("]]")
            if (!extraText.isNullOrBlank()) {
                append("\n\n")
                append(extraText.trim())
            }
        }
        return saveNote(context, body)
    }

    /**
     * Kopieert een afbeelding (lokaal of via content-URI) naar `.attachments` en
     * retourneert de basename voor gebruik in een `![[…]]`-embed. Gebruikt door
     * zowel saveImageNote (nieuwe foto-notitie) als de editor (foto invoegen in
     * bestaande notitie).
     */
    fun copyImageToAttachments(context: Context, imageUri: Uri): Result<String> {
        val attachmentsFolder = getOrCreateAttachmentsFolder(context).getOrElse {
            return Result.failure(it)
        }
        val mime = context.contentResolver.getType(imageUri).orEmpty().lowercase()
        val ext = when {
            mime.contains("jpeg") || mime.contains("jpg") -> "jpg"
            mime.contains("png") -> "png"
            mime.contains("webp") -> "webp"
            mime.contains("gif") -> "gif"
            mime.contains("heic") -> "heic"
            mime.contains("heif") -> "heif"
            else -> "jpg"
        }
        val mimeForFile = when (ext) {
            "jpg" -> "image/jpeg"
            "png" -> "image/png"
            "webp" -> "image/webp"
            "gif" -> "image/gif"
            "heic" -> "image/heic"
            "heif" -> "image/heif"
            else -> "image/*"
        }
        val stamp = SimpleDateFormat("yyyy-MM-dd HHmmss", Locale.US).format(Date())
        val basename = "diexar-$stamp.$ext"

        val target = attachmentsFolder.createFile(mimeForFile, basename)
            ?: return Result.failure(IllegalStateException("Kan attachment niet aanmaken."))
        try {
            context.contentResolver.openInputStream(imageUri)?.use { input ->
                context.contentResolver.openOutputStream(target.uri, "wt")?.use { out ->
                    input.copyTo(out)
                } ?: run {
                    target.delete()
                    return Result.failure(IllegalStateException("Kan attachment niet schrijven."))
                }
            } ?: run {
                target.delete()
                return Result.failure(IllegalStateException("Kan bron-afbeelding niet lezen."))
            }
        } catch (e: Exception) {
            target.delete()
            return Result.failure(e)
        }
        return Result.success(basename)
    }

    fun createNote(context: Context, content: String): Result<Pair<String, Uri>> {
        val subfolder = openOrCreateNotesFolder(context).getOrElse { return Result.failure(it) }

        val filename = generateFilename(content)
        val newFile = subfolder.createFile("text/markdown", filename)
            ?: return Result.failure(IllegalStateException("Bestand kon niet worden aangemaakt."))

        return try {
            context.contentResolver.openOutputStream(newFile.uri, "wt")?.use { out ->
                out.write(content.toByteArray(Charsets.UTF_8))
            } ?: return Result.failure(IllegalStateException("Kan niet schrijven naar bestand."))
            Result.success((newFile.name ?: filename) to newFile.uri)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun listNotes(context: Context): Result<List<NoteSummary>> {
        val vaultUri = getVaultUri(context)
            ?: return Result.failure(IllegalStateException("Geen vault-map gekozen."))
        val subfolder = openNotesFolder(context).getOrElse { return Result.failure(it) }

        // Eén cursor-query haalt name/mime/mtime voor álle kinderen op — veel sneller
        // dan DocumentFile.listFiles() + per-item .name/.lastModified() (elk een aparte
        // ContentResolver.query()).
        val children = queryChildren(context, vaultUri, subfolder.uri)
            .filter { !it.name.startsWith(".") && it.name.endsWith(".md", ignoreCase = true) }

        // Snapshot van de .attachments-map: één listing → Map<basename, Uri>. Hierdoor
        // hoeft NoteCard niet meer per kaart te zoeken.
        val attachments = snapshotAttachments(context, vaultUri)

        val notes = children.map { child ->
            val preview = readPreview(context, child.uri)
            val parsed = FrontmatterParser.parse(preview)
            val firstImage = findEmbeddedImageBasenames(parsed.body).firstOrNull()
            NoteSummary(
                uri = child.uri,
                filename = child.name,
                lastModified = child.lastModified,
                title = extractTitle(parsed.body, child.name),
                snippet = extractSnippet(parsed.body),
                meta = parsed.meta,
                thumbnailBasename = firstImage,
                thumbnailUri = firstImage?.let { attachments[it] },
            )
        }
        return Result.success(notes)
    }

    private fun queryChildren(context: Context, treeUri: Uri, parentUri: Uri): List<ChildDoc> {
        val docId = DocumentsContract.getDocumentId(parentUri)
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, docId)
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        val out = mutableListOf<ChildDoc>()
        try {
            context.contentResolver.query(childrenUri, projection, null, null, null)?.use { cursor ->
                while (cursor.moveToNext()) {
                    val id = cursor.getString(0) ?: continue
                    val name = cursor.getString(1) ?: continue
                    val mime = cursor.getString(2) ?: ""
                    val mtime = if (cursor.isNull(3)) 0L else cursor.getLong(3)
                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) continue
                    val uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, id)
                    out.add(ChildDoc(uri, name, mtime))
                }
            }
        } catch (_: Exception) {
            // Cursor kan falen bij intrekken van permissies; lege lijst voorkomt crash.
        }
        return out
    }

    private fun snapshotAttachments(context: Context, vaultUri: Uri): Map<String, Uri> {
        val tree = DocumentFile.fromTreeUri(context, vaultUri) ?: return emptyMap()
        val path = getSubfolder(context).trimEnd('/') + "/.attachments"
        val folder = traverseSubfolder(tree, path) ?: return emptyMap()
        val result = HashMap<String, Uri>()
        for (child in queryChildren(context, vaultUri, folder.uri)) {
            result[child.name] = child.uri
        }
        return result
    }

    private data class ChildDoc(val uri: Uri, val name: String, val lastModified: Long)

    fun readNote(context: Context, uri: Uri): Result<String> {
        return try {
            val text = context.contentResolver.openInputStream(uri)?.use { input ->
                input.readBytes().toString(Charsets.UTF_8)
            } ?: return Result.failure(IllegalStateException("Kan bestand niet openen."))
            Result.success(text)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun updateNote(context: Context, uri: Uri, content: String): Result<Unit> {
        return try {
            context.contentResolver.openOutputStream(uri, "wt")?.use { out ->
                out.write(content.toByteArray(Charsets.UTF_8))
            } ?: return Result.failure(IllegalStateException("Kan niet schrijven naar bestand."))
            Result.success(Unit)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * Past metadata aan op een bestaande notitie zonder de body te verliezen.
     * Leest bestand → vervangt frontmatter → schrijft terug.
     */
    fun updateNoteMeta(context: Context, uri: Uri, meta: NoteMeta): Result<Unit> {
        val current = readNote(context, uri).getOrElse { return Result.failure(it) }
        val newContent = FrontmatterWriter.apply(current, meta)
        return updateNote(context, uri, newContent)
    }

    fun deleteNote(context: Context, uri: Uri): Result<Unit> {
        return try {
            // Vóór verwijderen: zoek alle ingebedde afbeeldingen en verwijder die ook.
            val content = readNote(context, uri).getOrNull() ?: ""
            val embeddedImages = findEmbeddedImageBasenames(content)
            if (embeddedImages.isNotEmpty()) {
                val attachments = traverseSubfolder(
                    DocumentFile.fromTreeUri(context, getVaultUri(context) ?: return Result.failure(IllegalStateException("Geen vault."))) ?: return Result.failure(IllegalStateException("Vault niet open.")),
                    getSubfolder(context).trimEnd('/') + "/.attachments",
                )
                if (attachments != null) {
                    for (name in embeddedImages) {
                        attachments.findFile(name)?.delete()
                    }
                }
            }

            val doc = DocumentFile.fromSingleUri(context, uri)
                ?: return Result.failure(IllegalStateException("Bestand niet gevonden."))
            if (doc.delete()) Result.success(Unit)
            else Result.failure(IllegalStateException("Verwijderen mislukt."))
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * Vindt of maakt de `.attachments`-submap onder de notitiemap. Gebruikt voor OG-images.
     */
    fun getOrCreateAttachmentsFolder(context: Context): Result<DocumentFile> {
        val vaultUri = getVaultUri(context)
            ?: return Result.failure(IllegalStateException("Geen vault-map gekozen."))
        val tree = DocumentFile.fromTreeUri(context, vaultUri)
            ?: return Result.failure(IllegalStateException("Vault-map kan niet worden geopend."))
        if (!tree.canWrite()) {
            return Result.failure(IllegalStateException("Geen schrijfrechten op de vault-map."))
        }
        val path = getSubfolder(context).trimEnd('/') + "/.attachments"
        val folder = findOrCreateSubfolder(tree, path)
            ?: return Result.failure(IllegalStateException("Attachments-map kon niet worden aangemaakt."))
        return Result.success(folder)
    }

    /**
     * Zoekt een attachment-bestand op basename. Gebruikt voor het renderen van
     * `![[image.jpg]]`-embeds in de UI.
     */
    fun findAttachmentUri(context: Context, basename: String): Uri? {
        val vaultUri = getVaultUri(context) ?: return null
        val tree = DocumentFile.fromTreeUri(context, vaultUri) ?: return null
        val path = getSubfolder(context).trimEnd('/') + "/.attachments"
        val folder = traverseSubfolder(tree, path) ?: return null
        return folder.findFile(basename)?.uri
    }

    /**
     * Detecteert ingebedde afbeeldingen in een markdown-body. Dekt zowel
     * Obsidian-stijl `![[name.ext]]` als standaard `![](path/name.ext)`.
     */
    fun findEmbeddedImageBasenames(content: String): List<String> {
        val result = LinkedHashSet<String>()
        val obsidian = Regex("!\\[\\[([^\\]\\n|]+)(?:\\|[^\\]\\n]+)?\\]\\]")
        for (m in obsidian.findAll(content)) {
            val name = m.groupValues[1].trim().substringAfterLast('/')
            if (name.isNotEmpty()) result.add(name)
        }
        val standard = Regex("!\\[[^\\]]*\\]\\(([^)\\s]+)(?:\\s+\"[^\"]*\")?\\)")
        for (m in standard.findAll(content)) {
            val path = m.groupValues[1].trim()
            val name = path.substringAfterLast('/').substringBefore('?').substringBefore('#')
            if (name.isNotEmpty() && looksLikeImage(name)) result.add(name)
        }
        return result.toList()
    }

    private fun looksLikeImage(name: String): Boolean {
        val ext = name.substringAfterLast('.', "").lowercase()
        return ext in setOf("jpg", "jpeg", "png", "gif", "webp", "bmp", "svg")
    }

    fun archiveNote(context: Context, uri: Uri): Result<Unit> {
        val content = readNote(context, uri).getOrElse { return Result.failure(it) }

        val vaultUri = getVaultUri(context)
            ?: return Result.failure(IllegalStateException("Geen vault-map gekozen."))
        val tree = DocumentFile.fromTreeUri(context, vaultUri)
            ?: return Result.failure(IllegalStateException("Vault-map kan niet worden geopend."))

        val archivePath = getSubfolder(context).trimEnd('/') + "/Archive"
        val archiveFolder = findOrCreateSubfolder(tree, archivePath)
            ?: return Result.failure(IllegalStateException("Archiefmap kon niet worden aangemaakt."))

        val sourceDoc = DocumentFile.fromSingleUri(context, uri)
            ?: return Result.failure(IllegalStateException("Bronbestand niet gevonden."))
        val filename = sourceDoc.name ?: "archived-${System.currentTimeMillis()}.md"

        val targetName = uniqueFilename(archiveFolder, filename)
        val newFile = archiveFolder.createFile("text/markdown", targetName)
            ?: return Result.failure(IllegalStateException("Bestand kon niet worden aangemaakt in archief."))

        return try {
            context.contentResolver.openOutputStream(newFile.uri, "wt")?.use { out ->
                out.write(content.toByteArray(Charsets.UTF_8))
            } ?: return Result.failure(IllegalStateException("Kan niet schrijven naar archief."))
            if (!sourceDoc.delete()) {
                return Result.failure(IllegalStateException("Origineel bestand kon niet worden verwijderd."))
            }
            Result.success(Unit)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * Loopt de hele vault recursief af en geeft alle markdown-bestanden terug
     * voor link-autocomplete. Performance: voor vaults < ~2000 notities OK; bij
     * grotere vaults caching in de aanroeper aanbevolen.
     */
    fun listAllVaultMarkdownFiles(context: Context): Result<List<VaultMarkdownFile>> {
        val vaultUri = getVaultUri(context)
            ?: return Result.failure(IllegalStateException("Geen vault-map gekozen."))
        val tree = DocumentFile.fromTreeUri(context, vaultUri)
            ?: return Result.failure(IllegalStateException("Vault-map kan niet worden geopend."))

        val results = mutableListOf<VaultMarkdownFile>()
        walkVault(tree, "", results)
        results.sortBy { it.basename.lowercase() }
        return Result.success(results)
    }

    private fun walkVault(folder: DocumentFile, pathPrefix: String, into: MutableList<VaultMarkdownFile>) {
        // Sla Obsidian-systeemmappen over om niet honderden .md's uit plugins te laden.
        val name = folder.name ?: ""
        if (name.startsWith(".")) return

        for (child in folder.listFiles()) {
            val childName = child.name ?: continue
            if (child.isDirectory) {
                val newPrefix = if (pathPrefix.isEmpty()) childName else "$pathPrefix/$childName"
                walkVault(child, newPrefix, into)
            } else if (child.isFile && childName.endsWith(".md", ignoreCase = true)) {
                val basename = childName.removeSuffix(".md").removeSuffix(".MD")
                val relPath = if (pathPrefix.isEmpty()) basename else "$pathPrefix/$basename"
                into.add(VaultMarkdownFile(basename = basename, relativePath = relPath, uri = child.uri))
            }
        }
    }

    private fun openNotesFolder(context: Context): Result<DocumentFile> {
        val vaultUri = getVaultUri(context)
            ?: return Result.failure(IllegalStateException("Geen vault-map gekozen."))
        val tree = DocumentFile.fromTreeUri(context, vaultUri)
            ?: return Result.failure(IllegalStateException("Vault-map kan niet worden geopend."))
        val subfolderName = getSubfolder(context)
        val subfolder = traverseSubfolder(tree, subfolderName)
            ?: return Result.failure(IllegalStateException("Submap '$subfolderName' bestaat niet."))
        return Result.success(subfolder)
    }

    private fun openOrCreateNotesFolder(context: Context): Result<DocumentFile> {
        val vaultUri = getVaultUri(context)
            ?: return Result.failure(IllegalStateException("Geen vault-map gekozen."))
        val tree = DocumentFile.fromTreeUri(context, vaultUri)
            ?: return Result.failure(IllegalStateException("Vault-map kan niet worden geopend."))
        if (!tree.canWrite()) {
            return Result.failure(IllegalStateException("Geen schrijfrechten op de vault-map."))
        }
        val subfolderName = getSubfolder(context)
        val subfolder = findOrCreateSubfolder(tree, subfolderName)
            ?: return Result.failure(IllegalStateException("Submap '$subfolderName' kon niet worden aangemaakt."))
        return Result.success(subfolder)
    }

    private fun traverseSubfolder(parent: DocumentFile, name: String): DocumentFile? {
        var current: DocumentFile = parent
        for (segment in name.split('/').map { it.trim() }.filter { it.isNotEmpty() }) {
            val existing = current.findFile(segment) ?: return null
            if (!existing.isDirectory) return null
            current = existing
        }
        return current
    }

    private fun findOrCreateSubfolder(parent: DocumentFile, name: String): DocumentFile? {
        var current: DocumentFile = parent
        for (segment in name.split('/').map { it.trim() }.filter { it.isNotEmpty() }) {
            val existing = current.findFile(segment)
            current = if (existing != null && existing.isDirectory) {
                existing
            } else {
                current.createDirectory(segment) ?: return null
            }
        }
        return current
    }

    private fun uniqueFilename(folder: DocumentFile, desired: String): String {
        if (folder.findFile(desired) == null) return desired
        val dot = desired.lastIndexOf('.')
        val base = if (dot > 0) desired.substring(0, dot) else desired
        val ext = if (dot > 0) desired.substring(dot) else ""
        var i = 2
        while (folder.findFile("$base ($i)$ext") != null) i++
        return "$base ($i)$ext"
    }

    private fun readPreview(context: Context, uri: Uri): String {
        return try {
            context.contentResolver.openInputStream(uri)?.use { input ->
                val buf = ByteArray(4096)
                val read = input.read(buf)
                if (read <= 0) "" else String(buf, 0, read, Charsets.UTF_8)
            }.orEmpty()
        } catch (_: Exception) {
            ""
        }
    }

    private fun extractTitle(body: String, fallbackFilename: String): String {
        val firstLine = body.lineSequence().firstOrNull { it.isNotBlank() }?.trim().orEmpty()
        val cleaned = firstLine.trimStart('#').trim()
        return cleaned.ifBlank { fallbackFilename.removeSuffix(".md") }
    }

    private fun extractSnippet(body: String): String {
        // Filter zowel Obsidian-wikilink-embeds (![[…]]) als standaard markdown-images (![alt](…)).
        val wikiEmbed = Regex("^\\s*!\\[\\[[^\\]]+]]\\s*$")
        val mdImage = Regex("^\\s*!\\[[^\\]]*]\\([^)]+\\)\\s*$")
        val lines = body.lineSequence()
            .map { it.trim() }
            .filter { it.isNotBlank() && !wikiEmbed.matches(it) && !mdImage.matches(it) }
            .toList()
        val rest = if (lines.size > 1) lines.drop(1).joinToString("\n") else ""
        return rest.take(280)
    }

    private fun generateFilename(content: String): String {
        val stamp = SimpleDateFormat("yyyy-MM-dd HHmmss", Locale.US).format(Date())
        val parsed = FrontmatterParser.parse(content)
        val firstLine = parsed.body.lineSequence().firstOrNull { it.isNotBlank() }?.trim().orEmpty()
        val slug = firstLine
            .replace(Regex("""[#*_`>\[\]()]"""), "")
            .replace(Regex("""[\\/:*?"<>|]"""), "")
            .trim()
            .take(40)
        val base = if (slug.isNotEmpty()) "$stamp $slug" else stamp
        return "$base.md"
    }
}

data class NoteSummary(
    val uri: Uri,
    val filename: String,
    val lastModified: Long,
    val title: String,
    val snippet: String,
    val meta: NoteMeta = NoteMeta(),
    val thumbnailBasename: String? = null,
    val thumbnailUri: Uri? = null,
)

data class VaultMarkdownFile(
    val basename: String,
    val relativePath: String,
    val uri: Uri,
)

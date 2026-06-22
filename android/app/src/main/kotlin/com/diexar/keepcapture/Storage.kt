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
    private const val KEY_DOWNLOAD_IMAGES = "download_images"
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

    fun getDownloadImages(context: Context): Boolean {
        return PreferenceManager.getDefaultSharedPreferences(context)
            .getBoolean(KEY_DOWNLOAD_IMAGES, true)
    }

    fun saveDownloadImages(context: Context, enabled: Boolean) {
        PreferenceManager.getDefaultSharedPreferences(context)
            .edit()
            .putBoolean(KEY_DOWNLOAD_IMAGES, enabled)
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
        return createNote(context, neutralizeBodyHashtags(content)).map { it.first }
    }

    /**
     * Strip `#hashtag`-patronen volledig uit een titel-regel. Absolute regel:
     * tags zijn ALLEEN handmatig door de gebruiker toegevoegd. Inhoud die uit
     * een share, OG-meta of paste komt mag dus geen tags in de titel hebben —
     * en escapen (`\#`) lost het wel op voor de graph maar laat lelijke
     * backslashes achter in de kaart-titel. Daarom: weghalen.
     *
     * Bewaart heading-marker (`# `) en wikilinks intact; verwijdert alleen
     * losse `#tag`-tokens en de spaties eromheen.
     */
    fun sanitizeTitleFromShare(title: String): String {
        val tagPattern = Regex("(?<![\\\\\\w/])#[A-Za-z_/][\\w/-]*")
        // URL's uit de titel halen: TikTok e.d. leveren de link soms in zowel
        // EXTRA_SUBJECT (→ titel) als EXTRA_TEXT (→ markdown-link). Bleef de URL
        // in de titel staan, dan toonde de kaart twee identieke links. De link
        // hoort alleen in de markdown-link; valt de titel daardoor leeg, dan
        // vult buildPlaceholder() 'm met dezelfde URL als de link → één chip.
        val urlPattern = Regex("https?://\\S+")
        return urlPattern.replace(title, "")
            .let { tagPattern.replace(it, "") }
            .replace(Regex("\\s+"), " ")
            .trim()
            .trim(',', ';', '·', '|', '-', '–', '—')
            .trim()
    }

    /**
     * Escape inline `#hashtag`-syntax in vrije body-tekst zodat Obsidian de tags
     * niet vault-breed indexeert. Spiegel van TS `neutralizeBodyHashtags` in
     * `src/metadata.ts` — frontmatter (`---`-blok) blijft ongemoeid, code-fences
     * en inline-code worden overgeslagen.
     */
    fun neutralizeBodyHashtags(content: String): String {
        val fmRegex = Regex("^---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n?")
        val fmMatch = fmRegex.find(content)
        return if (fmMatch != null) {
            fmMatch.value + neutralizeInlineHashtags(content.substring(fmMatch.value.length))
        } else {
            neutralizeInlineHashtags(content)
        }
    }

    private fun neutralizeInlineHashtags(text: String): String {
        val fencePattern = Regex("```[\\s\\S]*?```|~~~[\\s\\S]*?~~~")
        val out = StringBuilder()
        var idx = 0
        for (m in fencePattern.findAll(text)) {
            out.append(processOutsideFences(text.substring(idx, m.range.first)))
            out.append(m.value)
            idx = m.range.last + 1
        }
        out.append(processOutsideFences(text.substring(idx)))
        return out.toString()
    }

    private fun processOutsideFences(segment: String): String {
        val inlineCode = Regex("`[^`\\n]+`")
        val out = StringBuilder()
        var idx = 0
        for (m in inlineCode.findAll(segment)) {
            out.append(escapeHashtags(segment.substring(idx, m.range.first)))
            out.append(m.value)
            idx = m.range.last + 1
        }
        out.append(escapeHashtags(segment.substring(idx)))
        return out.toString()
    }

    private fun escapeHashtags(segment: String): String {
        // Negative lookbehind on `\` or word-char or `/` to skip heading-markers,
        // wiki-link-anchors, URL-anchors en al-geescapete `\#`.
        val tagPattern = Regex("(?<![\\\\\\w/])#([A-Za-z_/][\\w/-]*)")
        return tagPattern.replace(segment, "\\\\#$1")
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
        val rawTitle = subject?.trim()?.takeIf { it.isNotEmpty() } ?: "Foto $stamp"
        val title = sanitizeTitleFromShare(rawTitle).ifEmpty { "Foto $stamp" }
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
     * Kopieert een lokaal opgenomen voicememo (cache-bestand) naar `.attachments`
     * en maakt een notitie met een Obsidian-style audio-embed + duur-regel.
     * Het bron-bestand wordt na succesvolle kopie verwijderd.
     */
    fun saveVoiceMemoNote(
        context: Context,
        sourceFile: java.io.File,
        durationMs: Long,
    ): Result<String> {
        val attachmentsFolder = getOrCreateAttachmentsFolder(context).getOrElse {
            return Result.failure(it)
        }
        val stamp = SimpleDateFormat("yyyy-MM-dd HHmmss", Locale.US).format(Date())
        val basename = "diexar-$stamp.m4a"
        val target = attachmentsFolder.createFile("audio/mp4", basename)
            ?: return Result.failure(IllegalStateException("Kan voicememo-bestand niet aanmaken."))
        try {
            sourceFile.inputStream().use { input ->
                context.contentResolver.openOutputStream(target.uri, "wt")?.use { out ->
                    input.copyTo(out)
                } ?: run {
                    target.delete()
                    return Result.failure(IllegalStateException("Kan voicememo niet schrijven."))
                }
            }
        } catch (e: Exception) {
            target.delete()
            return Result.failure(e)
        }
        sourceFile.delete()

        val durationLabel = formatDuration(durationMs)
        val title = "Voicememo $stamp"
        val body = buildString {
            append("# "); append(title); append("\n\n")
            append("![["); append(basename); append("]]\n\n")
            append(durationLabel)
        }
        return saveNote(context, body)
    }

    /** Formatteert milliseconden als `M:SS`. */
    private fun formatDuration(ms: Long): String {
        val totalSec = (ms / 1000).coerceAtLeast(0)
        val minutes = totalSec / 60
        val seconds = totalSec % 60
        return "%d:%02d".format(minutes, seconds)
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
            val firstAudio = if (firstImage == null) {
                findEmbeddedAudioBasenames(parsed.body).firstOrNull()
            } else null
            NoteSummary(
                uri = child.uri,
                filename = child.name,
                lastModified = child.lastModified,
                title = extractTitle(parsed.body, child.name),
                snippet = extractSnippet(parsed.body),
                urls = extractUrls(parsed.body),
                meta = parsed.meta,
                thumbnailBasename = firstImage,
                thumbnailUri = firstImage?.let { attachments[it] },
                audioBasename = firstAudio,
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
            // Vóór verwijderen: zoek ingebedde afbeeldingen en verwijder die ook —
            // mits geen andere notitie (Mini Notes of Archive) er nog naar verwijst.
            // OG-thumbnails worden door OgFetcher gehasht op URL en kunnen dus gedeeld
            // worden tussen kaarten met dezelfde og:image — wis nooit zo'n shared file.
            val content = readNote(context, uri).getOrNull() ?: ""
            val embeddedImages = findEmbeddedAttachmentBasenames(content)
            if (embeddedImages.isNotEmpty()) {
                val vaultUri = getVaultUri(context)
                if (vaultUri != null) {
                    val stillReferenced = collectReferencedAttachments(context, vaultUri, uri)
                    val toRemove = embeddedImages.filter { it !in stillReferenced }
                    if (toRemove.isNotEmpty()) {
                        // Cursor-based snapshot — DocumentFile.findFile() bleek
                        // onbetrouwbaar op SAF-mappen die Syncthing extern aanpast.
                        val snapshot = snapshotAttachments(context, vaultUri)
                        for (name in toRemove) {
                            val attUri = snapshot[name] ?: continue
                            try {
                                DocumentsContract.deleteDocument(context.contentResolver, attUri)
                            } catch (_: Exception) {
                                // Individuele attachment-failure mag het verwijderen
                                // van de .md niet blokkeren.
                            }
                        }
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
     * Verzamelt alle attachment-basenames die nog gerefereerd worden door notities
     * in de Notes-map én in Archive, met uitzondering van [excludeUri]. Gebruikt
     * door [deleteNote] om gedeelde OG-thumbnails te beschermen.
     */
    private fun collectReferencedAttachments(
        context: Context,
        vaultUri: Uri,
        excludeUri: Uri,
    ): Set<String> {
        val excludeKey = excludeUri.toString()
        val result = HashSet<String>()

        val notesFolder = openNotesFolder(context).getOrNull()
        if (notesFolder != null) {
            for (child in queryChildren(context, vaultUri, notesFolder.uri)) {
                if (child.name.startsWith(".") || !child.name.endsWith(".md", true)) continue
                if (child.uri.toString() == excludeKey) continue
                val body = readNote(context, child.uri).getOrNull() ?: continue
                result.addAll(findEmbeddedAttachmentBasenames(body))
            }
        }

        val tree = DocumentFile.fromTreeUri(context, vaultUri)
        if (tree != null) {
            val archivePath = getSubfolder(context).trimEnd('/') + "/Archive"
            val archive = traverseSubfolder(tree, archivePath)
            if (archive != null) {
                for (child in queryChildren(context, vaultUri, archive.uri)) {
                    if (!child.name.endsWith(".md", true)) continue
                    if (child.uri.toString() == excludeKey) continue
                    val body = readNote(context, child.uri).getOrNull() ?: continue
                    result.addAll(findEmbeddedAttachmentBasenames(body))
                }
            }
        }

        return result
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
     * Filtert op image-extensies; voicememo's (.m4a etc.) komen hier NIET in.
     */
    fun findEmbeddedImageBasenames(content: String): List<String> {
        return collectEmbedBasenames(content) { looksLikeImage(it) }
    }

    /** Zoals [findEmbeddedImageBasenames] maar voor audio-attachments (voicememo's). */
    fun findEmbeddedAudioBasenames(content: String): List<String> {
        return collectEmbedBasenames(content) { looksLikeAudio(it) }
    }

    /**
     * Levert álle ingebedde attachment-basenames (image + audio). Gebruikt door
     * [deleteNote] om bij verwijderen ook audio-bestanden refcount-aware mee te
     * nemen — anders blijven `.m4a`-bestanden in `.attachments/` rondhangen.
     */
    fun findEmbeddedAttachmentBasenames(content: String): List<String> {
        return collectEmbedBasenames(content) { looksLikeImage(it) || looksLikeAudio(it) }
    }

    private fun collectEmbedBasenames(content: String, accept: (String) -> Boolean): List<String> {
        val result = LinkedHashSet<String>()
        val obsidian = Regex("!\\[\\[([^\\]\\n|]+)(?:\\|[^\\]\\n]+)?\\]\\]")
        for (m in obsidian.findAll(content)) {
            val name = m.groupValues[1].trim().substringAfterLast('/')
            if (name.isNotEmpty() && accept(name)) result.add(name)
        }
        val standard = Regex("!\\[[^\\]]*\\]\\(([^)\\s]+)(?:\\s+\"[^\"]*\")?\\)")
        for (m in standard.findAll(content)) {
            val path = m.groupValues[1].trim()
            val name = path.substringAfterLast('/').substringBefore('?').substringBefore('#')
            if (name.isNotEmpty() && accept(name)) result.add(name)
        }
        return result.toList()
    }

    private fun looksLikeImage(name: String): Boolean {
        val ext = name.substringAfterLast('.', "").lowercase()
        return ext in setOf("jpg", "jpeg", "png", "gif", "webp", "bmp", "svg")
    }

    private fun looksLikeAudio(name: String): Boolean {
        val ext = name.substringAfterLast('.', "").lowercase()
        return ext in setOf("m4a", "mp3", "wav", "ogg", "aac", "flac", "3gp", "amr")
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
        // Embed-regels overslaan; anders krijg je `![[bestand.jpg]]` als
        // kaart-titel bij notities die met een afbeelding beginnen.
        val wikiEmbed = Regex("^!\\[\\[[^\\]]+]]$")
        val mdImage = Regex("^!\\[[^\\]]*]\\([^)]+\\)$")
        val firstLine = body.lineSequence()
            .map { it.trim() }
            .filter { it.isNotEmpty() && !wikiEmbed.matches(it) && !mdImage.matches(it) }
            .firstOrNull().orEmpty()
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
        // URLs strippen — die worden als chips onderaan getoond (plugin-pariteit).
        // Markdown-link-syntax behoudt het label, losse URLs verdwijnen volledig.
        val stripped = rest
            .replace(Regex("\\[([^\\]\\n]+)]\\(https?://[^)\\s]+\\)"), "$1")
            .replace(Regex("https?://\\S+"), "")
            .replace(Regex("[ \\t]{2,}"), " ")
            .lineSequence()
            .map { it.trimEnd() }
            .joinToString("\n")
            .trim()
        return stripped.take(280)
    }

    /**
     * Unieke `http(s)://`-URL's uit de body, in invoegvolgorde. Embed-syntax
     * eerst gestript zodat lokale image-paden niet meelopen. Trailing leestekens
     * worden afgekapt zodat zinnen die op een URL eindigen schone hostnames
     * geven.
     */
    private fun extractUrls(body: String): List<String> {
        var stripped = body
            .replace(Regex("!\\[\\[[^\\]]+]]"), "")
            .replace(Regex("!\\[[^\\]]*]\\([^)]+\\)"), "")
        // Eerste heading-regel (de titel) weghalen: een URL die al als kaart-titel
        // wordt getoond mag niet óók als losse chip verschijnen. Dit was de
        // oorzaak van twee identieke links per kaart bij gedeelde TikTok-video's.
        stripped = stripped.replaceFirst(Regex("(?m)^[ \\t]*#{1,6}[ \\t]+.*$"), "")

        val seen = LinkedHashSet<String>()
        val out = ArrayList<String>()
        fun push(raw: String) {
            val clean = raw.trimEnd('.', ',', ')', ']', '}', '"', '\'', '!', '?', ';', ':')
            if (clean.isEmpty()) return
            if (seen.add(canonicalUrlKey(clean))) out.add(clean)
        }
        // Markdown-link-targets eerst; verwijder de hele `[tekst](url)` zodat een
        // URL die als link-tekst staat niet nog eens als losse URL meetelt.
        stripped = Regex("\\[[^\\]\\n]*]\\((https?://[^)\\s]+)\\)").replace(stripped) { m ->
            push(m.groupValues[1]); " "
        }
        for (m in Regex("https?://[^\\s)<>\"']+").findAll(stripped)) push(m.value)
        return out
    }

    /**
     * Genormaliseerde sleutel voor URL-deduplicatie: host zonder `www.`, pad
     * zonder trailing slash. Query/fragment blijven behouden (kunnen content
     * identificeren). Zo vallen `www.tiktok.com/x` en `tiktok.com/x/` samen.
     */
    private fun canonicalUrlKey(url: String): String {
        return try {
            val u = java.net.URI(url)
            val host = (u.host ?: "").lowercase().removePrefix("www.")
            val path = (u.rawPath ?: "").trimEnd('/')
            val query = if (u.rawQuery != null) "?" + u.rawQuery else ""
            "$host$path$query"
        } catch (_: Exception) {
            url.trim().lowercase()
        }
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
    val urls: List<String> = emptyList(),
    val meta: NoteMeta = NoteMeta(),
    val thumbnailBasename: String? = null,
    val thumbnailUri: Uri? = null,
    val audioBasename: String? = null,
)

data class VaultMarkdownFile(
    val basename: String,
    val relativePath: String,
    val uri: Uri,
)

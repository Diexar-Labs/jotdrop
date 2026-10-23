package com.diexar.keepcapture

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.provider.DocumentsContract
import android.system.Os
import android.system.OsConstants
import android.util.AtomicFile
import androidx.documentfile.provider.DocumentFile
import androidx.preference.PreferenceManager
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.CRC32

enum class NoteFolder { NOTES, ARCHIVE, TRASH }

/**
 * Sorteermodi voor de notitielijst. NEWEST = aanmaaktijd aflopend,
 * MANUAL = handmatige `order`-volgorde (default; sleep om te herschikken).
 */
enum class NoteSortMode { NEWEST, MANUAL }

object Storage {
    /**
     * Serialiseert read-modify-write-cycli op notitiebestanden. Meta-updates
     * (pin/kleur/tag), body-saves en de PreviewWorker lezen elk eerst het
     * bestand en schrijven het daarna terug; zonder lock kan een trage write
     * een nieuwere overschrijven (getypte tekst kwijt na een tag-tik).
     */
    val noteWriteMutex = Mutex()
    // Eén journaal voor alle notitie-writes; dit slot houdt ze daarom na elkaar.
    private val noteJournalLock = Any()

    private const val KEY_VAULT_URI = "vault_tree_uri"
    private const val KEY_SUBFOLDER = "subfolder"
    private const val KEY_ASSETS_FOLDER = "assets_folder"
    private const val KEY_SPEECH_LANG = "speech_language"
    private const val KEY_DOWNLOAD_IMAGES = "download_images"
    private const val KEY_SORT_MODE = "sort_mode"
    private const val JOURNAL_SEPARATOR = '\n'.code.toByte()
    // Journaal v2: magic + uri + separator + inhoud + CRC32. Oude journalen beginnen met "content:".
    private val JOURNAL_MAGIC = "JDJ2".toByteArray(Charsets.US_ASCII)
    private const val PARKED_JOURNAL_DIR = "note-write-parked"
    // Geparkeerde notities niet bij elke aanroep opnieuw proberen: listLabels leest elke notitie.
    private const val PARKED_RETRY_MS = 30_000L
    @Volatile private var parkedRetryAt = 0L
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

    /** De expliciet ingestelde assets-map, of "" (lege string) als niet ingesteld. */
    fun getAssetsFolder(context: Context): String {
        val prefs = PreferenceManager.getDefaultSharedPreferences(context)
        return prefs.getString(KEY_ASSETS_FOLDER, "").orEmpty()
    }

    /**
     * Valideert en slaat de assets-map op. Retourneert `true` bij succes.
     * Lege invoer herstelt de dynamische default; ongeldige invoer (vault-escape,
     * drive-/URI-pad, absolute pad) wordt geweigerd zonder de oude waarde te
     * overschrijven. Spiegelt `normalizeAssetsFolder` in `src/attachments.ts`.
     */
    fun saveAssetsFolder(context: Context, raw: String): Boolean {
        val normalized = normalizeAssetsFolder(raw) ?: return false
        PreferenceManager.getDefaultSharedPreferences(context)
            .edit()
            .putString(KEY_ASSETS_FOLDER, normalized)
            .apply()
        return true
    }

    /** Normaliseert een vault-relatieve assets-map. "" = reset, null = ongeldig. */
    private fun normalizeAssetsFolder(input: String): String? {
        val trimmed = input.replace('\\', '/').trim()
        if (trimmed.isEmpty()) return ""
        if (trimmed.contains(':')) return null // drive (C:) of URI/scheme (https:, app:)
        if (trimmed.startsWith('/')) return null
        if (trimmed.startsWith('~')) return null
        val segments = trimmed.split('/').filter { it.isNotEmpty() }
        if (segments.isEmpty()) return null
        if (segments.any { it == "." || it == ".." }) return null
        if (Regex("[<>\"|?*\u0000-\u001f]").containsMatchIn(trimmed)) return null
        return segments.joinToString("/")
    }

    /**
     * De effectieve assets-map: de expliciete instelling wanneer aanwezig,
     * anders de legacy `<subfolder>/.attachments`. Spiegelt
     * `JotDropPlugin.resolveAssetsFolder()` in de plugin.
     */
    fun resolveAssetsFolder(context: Context): String {
        val explicit = getAssetsFolder(context)
        return if (explicit.isNotBlank()) explicit else legacyAssetsPath(context)
    }

    /** Legacy-locatie: `.attachments` binnen de notitiemap. */
    private fun legacyAssetsPath(context: Context): String {
        return getSubfolder(context).trimEnd('/') + "/.attachments"
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

    fun getSortMode(context: Context): NoteSortMode {
        val raw = PreferenceManager.getDefaultSharedPreferences(context)
            .getString(KEY_SORT_MODE, null)
        return try {
            NoteSortMode.valueOf(raw ?: NoteSortMode.MANUAL.name)
        } catch (_: Exception) {
            NoteSortMode.MANUAL
        }
    }

    fun saveSortMode(context: Context, mode: NoteSortMode) {
        PreferenceManager.getDefaultSharedPreferences(context)
            .edit()
            .putString(KEY_SORT_MODE, mode.name)
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
     * `src/metadata.ts` — frontmatter (`---`-blok) blijft ongemoeid; de regels
     * (code, links, URL's, alleen cijfers) staan in `InlineTags.neutralize`.
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

    private fun neutralizeInlineHashtags(text: String): String = InlineTags.neutralize(text)

    /**
     * Kopieert een via share-intent ontvangen afbeelding naar de assets-map en
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
     * Kopieert een lokaal opgenomen voicememo (cache-bestand) naar de assets-map
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

        val durationLabel = formatDuration(durationMs)
        val title = "Voicememo $stamp"
        val body = buildString {
            append("# "); append(title); append("\n\n")
            append("![["); append(basename); append("]]")
            append("\n\n")
            append(durationLabel)
        }
        val result = saveNote(context, body)
        if (result.isSuccess) {
            sourceFile.delete()
        }
        return result
    }

    /** Formatteert milliseconden als `M:SS`. */
    private fun formatDuration(ms: Long): String {
        val totalSec = (ms / 1000).coerceAtLeast(0)
        val minutes = totalSec / 60
        val seconds = totalSec % 60
        return "%d:%02d".format(minutes, seconds)
    }

    /**
     * Kopieert een afbeelding (lokaal of via content-URI) naar de assets-map en
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
        // Eerst herstellen: anders bleef bij een vastzittend journaal een leeg bestand achter.
        if (!recoverNoteJournals(context)) {
            return Result.failure(IllegalStateException(context.getString(R.string.error_interrupted_save)))
        }
        val subfolder = openOrCreateNotesFolder(context).getOrElse { return Result.failure(it) }

        val filename = generateFilename(content)
        val newFile = subfolder.createFile("text/markdown", filename)
            ?: return Result.failure(IllegalStateException("Bestand kon niet worden aangemaakt."))

        return try {
            if (!writeNoteBytes(context, newFile.uri, content.toByteArray(Charsets.UTF_8))) {
                newFile.delete()
                return Result.failure(IllegalStateException("Kan niet schrijven naar bestand."))
            }
            Result.success((newFile.name ?: filename) to newFile.uri)
        } catch (e: Exception) {
            // Staat het journaal nog, dan maakt het herstel deze notitie later af.
            if (!noteJournal(context).baseFile.exists()) newFile.delete()
            Result.failure(e)
        }
    }

    fun listNotes(context: Context): Result<List<NoteSummary>> {
        recoverNoteJournals(context)
        val vaultUri = getVaultUri(context)
            ?: return Result.failure(IllegalStateException("Geen vault-map gekozen."))
        val subfolder = openOrCreateNotesFolder(context).getOrElse { return Result.failure(it) }
        val children = queryChildren(context, vaultUri, subfolder.uri)
            .filter { !it.name.startsWith(".") && it.name.endsWith(".md", ignoreCase = true) }
        return Result.success(buildNoteSummaries(context, vaultUri, children))
    }

    /**
     * List notes in the given [folder]. NOTES uses the existing pipeline
     * (creates the notes folder on first run). ARCHIVE/TRASH return notes
     * from those folders if present; absent → empty list without creation.
     */
    fun listNotes(context: Context, folder: NoteFolder): Result<List<NoteSummary>> {
        return when (folder) {
            NoteFolder.NOTES -> listNotes(context)
            NoteFolder.ARCHIVE, NoteFolder.TRASH -> {
                val vaultUri = getVaultUri(context)
                    ?: return Result.failure(IllegalStateException("Geen vault-map gekozen."))
                val tree = DocumentFile.fromTreeUri(context, vaultUri) ?: return Result.success(emptyList())
                val folderPath = folderPath(context, folder)
                val folderDoc = traverseSubfolder(context, tree, folderPath) ?: return Result.success(emptyList())
                val children = queryChildren(context, vaultUri, folderDoc.uri)
                    .filter { !it.name.startsWith(".") && it.name.endsWith(".md", ignoreCase = true) }
                Result.success(buildNoteSummaries(context, vaultUri, children))
            }
        }
    }

    private fun buildNoteSummaries(
        context: Context,
        vaultUri: Uri,
        children: List<ChildDoc>,
    ): List<NoteSummary> {
        val attachments = snapshotAttachments(context, vaultUri)
        return children.map { child ->
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
    }

    /** Refresh one changed card without reopening every note in the vault. */
    fun refreshNoteSummary(context: Context, note: NoteSummary): NoteSummary? {
        val preview = readPreview(context, note.uri)
        if (preview.isEmpty()) return null
        val parsed = FrontmatterParser.parse(preview)
        return note.copy(
            title = extractTitle(parsed.body, note.filename),
            snippet = extractSnippet(parsed.body),
            urls = extractUrls(parsed.body),
            meta = parsed.meta,
            lastModified = lastModified(context, note.uri, note.lastModified),
        )
    }

    fun lastModified(context: Context, uri: Uri, fallback: Long): Long = try {
        DocumentFile.fromSingleUri(context, uri)?.lastModified()?.takeIf { it > 0 } ?: fallback
    } catch (_: Exception) {
        fallback
    }

    private fun queryChildren(context: Context, treeUri: Uri, parentUri: Uri, strict: Boolean = false): List<ChildDoc> {
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
            val cursor = context.contentResolver.query(childrenUri, projection, null, null, null)
            if (strict && cursor == null) error("Kan de notitiemap niet lezen.")
            cursor?.use { cursor ->
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
        } catch (e: Exception) {
            if (strict) throw e
            // Cursor kan falen bij intrekken van permissies; lege lijst voorkomt crash.
        }
        return out
    }

    private fun snapshotAttachments(context: Context, vaultUri: Uri): Map<String, Uri> {
        val tree = DocumentFile.fromTreeUri(context, vaultUri) ?: return emptyMap()
        val result = HashMap<String, Uri>()
        // Legacy-locatie eerst; de effectieve map overschrijft daarna bij gelijke
        // basenames (deterministische volgorde, pariteit met de plugin). Zo blijven
        // oude notities die naar `.attachments` wijzen renderen én wint de
        // ingestelde map wanneer dezelfde basename op beide plekken bestaat.
        for (path in listOf(legacyAssetsPath(context), resolveAssetsFolder(context)).distinct()) {
            val folder = traverseSubfolder(context, tree, path) ?: continue
            for (child in queryChildren(context, vaultUri, folder.uri)) {
                result[child.name] = child.uri
            }
        }
        return result
    }

    /**
     * Alle exemplaren van [basename] in zowel de effectieve als de legacy
     * assets-map. Gebruikt queryChildren (niet DocumentFile.findFile), wat
     * betrouwbaarder is op SAF-mappen die Syncthing extern aanpast. Voor
     * refcount-aware delete, waar élke orphan-kopie verwijderd mag worden.
     */
    private fun allAttachmentUris(context: Context, vaultUri: Uri, basename: String): List<Uri> {
        val tree = DocumentFile.fromTreeUri(context, vaultUri) ?: return emptyList()
        val result = LinkedHashSet<Uri>()
        for (path in listOf(resolveAssetsFolder(context), legacyAssetsPath(context)).distinct()) {
            val folder = traverseSubfolder(context, tree, path) ?: continue
            for (child in queryChildren(context, vaultUri, folder.uri)) {
                if (child.name == basename) result.add(child.uri)
            }
        }
        return result.toList()
    }

    /**
     * Eén gecachte attachment-index voor de editor. Een losse [findAttachmentUri]
     * doet meerdere SAF-queries per afbeelding; bij swipen blokkeerde dat eerder
     * de Compose UI-thread. Deze snapshot wordt op Dispatchers.IO opgebouwd en
     * daarna voor alle notities binnen dezelfde editorsessie hergebruikt.
     */
    fun listAttachmentUris(context: Context): Map<String, Uri> {
        val vaultUri = getVaultUri(context) ?: return emptyMap()
        return snapshotAttachments(context, vaultUri)
    }

    private data class ChildDoc(val uri: Uri, val name: String, val lastModified: Long)

    fun readNote(context: Context, uri: Uri): Result<String> {
        // Een halve notitie mag niet verder (archief/prullenbak kopieert en wist de bron).
        if (!recoverNoteJournals(context)) {
            return Result.failure(IllegalStateException(context.getString(R.string.error_interrupted_save)))
        }
        val parked = parkedJournal(context, uri)
        if (parked.baseFile.exists()) {
            // Deze notitie zelf wel meteen opnieuw proberen (Try again), los van de wachttijd voor de rest.
            synchronized(noteJournalLock) { recoverJournal(context, parked) }
            if (parked.baseFile.exists()) {
                return Result.failure(ParkedSaveException(context.getString(R.string.error_parked_save, noteName(uri))))
            }
        }
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
            if (!writeNoteBytes(context, uri, content.toByteArray(Charsets.UTF_8))) {
                return Result.failure(IllegalStateException("Kan niet schrijven naar bestand."))
            }
            Result.success(Unit)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * SAF heeft geen atomaire vervanging: "wt" leegt het bestand vóór de write,
     * dus een procesdood daartussen liet een lege of halve notitie achter. De
     * nieuwe inhoud staat daarom eerst in een journaal in appopslag (buiten de
     * vault); [recoverNoteJournals] maakt een onderbroken write af.
     */
    private fun noteJournal(context: Context) = AtomicFile(File(context.noBackupFilesDir, "note-write.journal"))

    private fun writeNoteBytes(context: Context, uri: Uri, bytes: ByteArray): Boolean = synchronized(noteJournalLock) {
        check(recoverNoteJournals(context)) { context.getString(R.string.error_interrupted_save) }
        val journal = noteJournal(context)
        val output = journal.startWrite()
        try {
            val body = JOURNAL_MAGIC + uri.toString().toByteArray(Charsets.UTF_8) + JOURNAL_SEPARATOR + bytes
            output.write(body)
            // Oude AtomicFile (API 26-29) schrijft direct naar het journaal; de CRC herkent een afgebroken journaal.
            output.write(ByteBuffer.allocate(4).putInt(journalCrc(body, body.size)).array())
            output.fd.sync()
            journal.finishWrite(output)
        } catch (e: Exception) {
            journal.failWrite(output)
            throw e
        }
        // AtomicFile synct de map niet; zonder deze sync kan stroomverlies de rename
        // van het journaal kwijtraken terwijl de "wt"-truncatie wel op schijf staat.
        runCatching {
            val dir = Os.open(journal.baseFile.parent, OsConstants.O_RDONLY, 0)
            try { Os.fsync(dir) } finally { Os.close(dir) }
        }
        // Bij een exception blijft het journaal staan, zodat de write later alsnog wordt afgemaakt.
        val written = writeSynced(context, uri, bytes)
        journal.delete()
        // Een ouder geparkeerd journaal mag deze nieuwere inhoud later niet meer aanvullen.
        if (written) parkedJournal(context, uri).delete()
        written
    }

    private fun writeSynced(context: Context, uri: Uri, bytes: ByteArray): Boolean {
        val out = context.contentResolver.openOutputStream(uri, "wt") ?: return false
        out.use {
            it.write(bytes)
            (it as? FileOutputStream)?.let { file -> runCatching { file.fd.sync() } }
        }
        return true
    }

    /**
     * Maakt een door procesdood onderbroken notitie-write af. Alleen als de
     * notitie nu leeg of een begin van de bedoelde inhoud is, wordt die inhoud
     * opnieuw geschreven; anders is de write nooit begonnen of heeft iets anders
     * het bestand gewijzigd, en blijft het bestand ongemoeid. Mislukt dat afmaken,
     * of is de vault-map onbereikbaar (SD-kaart, toestemming, hernoemd), dan wordt
     * het journaal per notitie geparkeerd en later afgemaakt, zonder andere writes
     * te blokkeren; [readNote] weigert zolang die ene notitie. Geparkeerde journalen
     * worden hooguit eens per [PARKED_RETRY_MS] opnieuw geprobeerd. Geeft false als
     * het journaal niet geparkeerd kon worden en dus nog openstaat.
     */
    private fun recoverNoteJournals(context: Context): Boolean {
        val journal = noteJournal(context)
        val parkedDir = File(context.noBackupFilesDir, PARKED_JOURNAL_DIR)
        val retryParked = SystemClock.elapsedRealtime() >= parkedRetryAt
        if (!journal.baseFile.exists() && (!retryParked || parkedDir.list().isNullOrEmpty())) return true
        synchronized(noteJournalLock) {
        // Vóór het actieve journaal opgehaald: een net geparkeerde notitie krijgt pas bij een volgende ronde een nieuwe poging.
        val parked = if (retryParked) parkedJournalFiles(context) else emptyList()
        var recovered = !journal.baseFile.exists() || recoverJournal(context, journal)
        if (retryParked) {
            parked.forEach {
                if (!recoverJournal(context, AtomicFile(it))) recovered = false
            }
            parkedRetryAt = SystemClock.elapsedRealtime() + PARKED_RETRY_MS
        }
        return recovered
        }
    }

    /** Readnote weigert een notitie met een geparkeerde, nog niet afgemaakte opslag. */
    class ParkedSaveException(message: String) : IllegalStateException(message)

    sealed interface ParkedResolution {
        data class Copied(val name: String) : ParkedResolution
        /** Journaal weg zonder kopie: verworpen, of er was niets te bewaren. */
        object Released : ParkedResolution
    }

    /**
     * Uitweg voor een geparkeerde notitie: bewaart de onvolledig opgeslagen
     * wijziging als `<naam> (recovered).md` en geeft de notitie vrij zoals ze nu
     * is (leeg of afgekapt). Bewust altijd een kopie en geen nieuwe afmaakpoging:
     * die laat het journaal vervallen als de notitie intussen elders is gewijzigd.
     */
    fun keepParkedSaveAsCopy(context: Context, uri: Uri): Result<ParkedResolution> {
        synchronized(noteJournalLock) {
        val parked = parkedJournal(context, uri)
        val data = try {
            parked.readFully()
        } catch (_: FileNotFoundException) {
            return Result.success(ParkedResolution.Released)
        } catch (e: IOException) {
            return Result.failure(e)
        }
        val bytes = parseJournal(data)?.second
        val name = if (bytes == null || bytes.isEmpty()) {
            null
        } else {
            rescueNote(context, uri, bytes) ?: return Result.failure(IllegalStateException(context.getString(R.string.error_parked_copy)))
        }
        parked.delete()
        return Result.success(if (name == null) ParkedResolution.Released else ParkedResolution.Copied(name))
        }
    }

    /** Uitweg voor een geparkeerde notitie: verwerpt de onvolledige wijziging; de notitie blijft zoals ze nu is. */
    fun discardParkedSave(context: Context, uri: Uri) {
        synchronized(noteJournalLock) { parkedJournal(context, uri).delete() }
    }

    private fun parkedJournalFiles(context: Context): List<File> =
        File(context.noBackupFilesDir, PARKED_JOURNAL_DIR).listFiles { file -> file.name.endsWith(".journal") }?.toList().orEmpty()

    /** Uri en bedoelde inhoud uit een journaal; null bij een afgebroken journaal (de write begon nooit). */
    private fun parseJournal(data: ByteArray): Pair<Uri, ByteArray>? {
        val body = when {
            !data.copyOf(JOURNAL_MAGIC.size).contentEquals(JOURNAL_MAGIC) -> data
            data.size >= JOURNAL_MAGIC.size + 4 && ByteBuffer.wrap(data, data.size - 4, 4).int == journalCrc(data, data.size - 4) ->
                data.copyOfRange(JOURNAL_MAGIC.size, data.size - 4)
            else -> ByteArray(0)
        }
        val split = body.indexOf(JOURNAL_SEPARATOR)
        if (split < 0) return null
        return Uri.parse(String(body, 0, split, Charsets.UTF_8)) to body.copyOfRange(split + 1, body.size)
    }

    private fun recoverJournal(context: Context, journal: AtomicFile): Boolean {
        val data = try {
            journal.readFully()
        } catch (_: FileNotFoundException) {
            return true
        } catch (_: IOException) {
            return false
        }
        // Afgebroken journaal (oude AtomicFile schrijft direct): de write naar de notitie begon nooit.
        val (uri, bytes) = parseJournal(data) ?: run {
            journal.delete()
            return true
        }
        val current = try {
            context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        } catch (_: Exception) {
            null
        }
        if (current == null) {
            // Bestaat de notitie nog maar is ze nu niet leesbaar: parkeren en later opnieuw proberen; alleen deze notitie blijft dicht.
            if (DocumentFile.fromSingleUri(context, uri)?.exists() == true) return parkOrRescue(context, journal, uri, data, bytes)
            // Onbereikbare map: de notitie is er misschien nog, dus niet wissen maar parkeren.
            if (!vaultTreeReachable(context, uri) && !otherVaultReachable(context, uri)) return parkJournal(context, journal, uri, data)
            // Notitie weg (bv. in Obsidian hernoemd) of andere vault gekozen (bv. de hernoemde map): bedoelde inhoud redden.
            if (bytes.isNotEmpty() && rescueNote(context, uri, bytes) == null) return parkJournal(context, journal, uri, data)
        } else if (current.size < bytes.size && current.contentEquals(bytes.copyOf(current.size))) {
            val restored = try {
                writeSynced(context, uri, bytes) &&
                    context.contentResolver.openInputStream(uri)?.use { it.readBytes() }?.contentEquals(bytes) == true
            } catch (_: Exception) {
                false
            }
            // Mislukt het afmaken, dan parkeren: anders blokkeerde dit journaal lezen, opslaan en sync van alle notities.
            if (!restored) return parkOrRescue(context, journal, uri, data, bytes)
            // Een ouder geparkeerd journaal mag deze nieuwere inhoud later niet meer aanvullen.
            parkedJournal(context, uri).takeIf { it.baseFile != journal.baseFile }?.delete()
        }
        journal.delete()
        return true
    }

    private fun journalCrc(data: ByteArray, length: Int): Int = CRC32().apply { update(data, 0, length) }.value.toInt()

    private fun parkedJournal(context: Context, uri: Uri): AtomicFile {
        val hash = MessageDigest.getInstance("SHA-256").digest(uri.toString().toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return AtomicFile(File(File(context.noBackupFilesDir, PARKED_JOURNAL_DIR), "$hash.journal"))
    }

    /** Zet het journaal apart per notitie; false als dat niet lukt en het journaal dus blijft blokkeren. */
    private fun parkJournal(context: Context, journal: AtomicFile, uri: Uri, data: ByteArray): Boolean {
        val parked = parkedJournal(context, uri)
        if (parked.baseFile == journal.baseFile) return true
        parked.baseFile.parentFile?.mkdirs()
        val output = try { parked.startWrite() } catch (_: IOException) { return false }
        try {
            output.write(data)
            output.fd.sync()
            parked.finishWrite(output)
        } catch (_: Exception) {
            parked.failWrite(output)
            return false
        }
        journal.delete()
        return true
    }

    /**
     * Een notitie buiten de gekozen vault staat in geen lijst en is dus niet te openen: daar redden in plaats van
     * parkeren. Pas bij een al geparkeerd journaal, zodat de notitie in die vault eerst een tweede kans krijgt.
     */
    private fun parkOrRescue(context: Context, journal: AtomicFile, uri: Uri, data: ByteArray, bytes: ByteArray): Boolean {
        val alreadyParked = journal.baseFile == parkedJournal(context, uri).baseFile
        if (!alreadyParked || bytes.isEmpty() || !otherVaultReachable(context, uri) || rescueNote(context, uri, bytes) == null) {
            return parkJournal(context, journal, uri, data)
        }
        journal.delete()
        // Een ouder geparkeerd journaal is door deze nieuwere kopie achterhaald.
        parkedJournal(context, uri).delete()
        return true
    }

    private fun vaultTreeReachable(context: Context, uri: Uri): Boolean = try {
        val treeUri = DocumentsContract.buildTreeDocumentUri(uri.authority, DocumentsContract.getTreeDocumentId(uri))
        DocumentFile.fromTreeUri(context, treeUri)?.isDirectory == true
    } catch (_: Exception) {
        false
    }

    /** Een andere, wel bereikbare vault gekozen: daar redden in plaats van voor altijd te parkeren. */
    private fun otherVaultReachable(context: Context, uri: Uri): Boolean {
        val vault = getVaultUri(context) ?: return false
        val same = runCatching { DocumentsContract.getTreeDocumentId(vault) == DocumentsContract.getTreeDocumentId(uri) }.getOrDefault(true)
        return !same && vaultTreeReachable(context, vault)
    }

    private fun noteName(uri: Uri): String = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull()
        ?.substringAfterLast('/')?.substringAfterLast(':')?.removeSuffix(".md")
        ?.takeIf { it.isNotBlank() } ?: "Note"

    /** Schrijft de bedoelde inhoud als `<naam> (recovered).md` in de notitiemap; geeft de bestandsnaam of null. */
    private fun rescueNote(context: Context, uri: Uri, bytes: ByteArray): String? {
        val folder = openOrCreateNotesFolder(context).getOrElse { return null }
        val filename = "${noteName(uri)} (recovered).md"
        val file = folder.createFile("text/markdown", filename) ?: return null
        val written = try {
            writeSynced(context, file.uri, bytes) &&
                context.contentResolver.openInputStream(file.uri)?.use { it.readBytes() }?.contentEquals(bytes) == true
        } catch (_: Exception) {
            false
        }
        if (!written) file.delete()
        return if (written) file.name ?: filename else null
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

    /** Zet alleen de handmatige `order`-waarde op een bestaande notitie. */
    fun setNoteOrder(context: Context, uri: Uri, order: Double): Result<Unit> {
        val current = readNote(context, uri).getOrElse { return Result.failure(it) }
        val meta = FrontmatterParser.parse(current).meta.copy(order = order)
        return updateNote(context, uri, FrontmatterWriter.apply(current, meta))
    }

    /**
     * Past een handmatige herschikking toe. [finalOrder] is de volledige lijst
     * in de nieuwe volgorde (gepind eerst); [moved] is de verplaatste notitie.
     * Berekent de nieuwe `order` ten opzichte van de buren in dezelfde sectie
     * (gepind/overige), of hernummerd de sectie als er geen numerieke ruimte is.
     */
    fun applyManualOrder(context: Context, moved: NoteSummary, finalOrder: List<NoteSummary>): Result<Map<String, Double>> {
        val section = finalOrder
            .filter { it.meta.pinned == moved.meta.pinned }
            .map { NoteOrder.OrderedNote(it.uri.toString(), NoteOrder.manualRank(it.meta.order, it.filename)) }
        return when (val plan = NoteOrder.planDrop(section, moved.uri.toString())) {
            is NoteOrder.DropPlan.Assign -> setNoteOrder(context, moved.uri, plan.order)
                .map { mapOf(moved.uri.toString() to plan.order) }
            is NoteOrder.DropPlan.Renumber -> {
                for ((key, order) in plan.assignments) {
                    val r = setNoteOrder(context, Uri.parse(key), order)
                    if (r.isFailure) return Result.failure(r.exceptionOrNull()!!)
                }
                Result.success(plan.assignments)
            }
        }
    }

    /** Schakelt exact het N-de Markdown-checklist-item in de body om. */
    fun toggleChecklistItem(context: Context, uri: Uri, targetIndex: Int): Result<Unit> {
        if (targetIndex < 0) {
            return Result.failure(IllegalArgumentException("Ongeldig checklist-item."))
        }
        val current = readNote(context, uri).getOrElse { return Result.failure(it) }
        val frontmatter = Regex("\\A---\\r?\\n[\\s\\S]*?\\r?\\n---(?:\\r?\\n|$)").find(current)
        val bodyStart = frontmatter?.range?.last?.plus(1) ?: 0
        val head = current.substring(0, bodyStart)
        val body = current.substring(bodyStart)
        val itemRegex = Regex("(?m)^(\\s*-\\s+\\[)([ xX])(\\](?:\\s|$))")
        var currentIndex = 0
        var toggled = false
        val updatedBody = itemRegex.replace(body) { match ->
            if (currentIndex++ != targetIndex) {
                match.value
            } else {
                toggled = true
                val state = match.groupValues[2]
                match.groupValues[1] + (if (state == " ") "x" else " ") + match.groupValues[3]
            }
        }
        if (!toggled) {
            return Result.failure(IllegalStateException("Checklist-item bestaat niet meer."))
        }
        return updateNote(context, uri, head + updatedBody)
    }

    fun deleteNote(context: Context, uri: Uri): Result<Unit> {
        return try {
            // Delete the note first; a failed delete must never strip its attachments.
            // OG-thumbnails worden door OgFetcher gehasht op URL en kunnen dus gedeeld
            // worden tussen kaarten met dezelfde og:image — wis nooit zo'n shared file.
            val content = readNote(context, uri).getOrElse { return Result.failure(it) }
            val embeddedImages = findEmbeddedAttachmentBasenames(content)
            val vaultUri = getVaultUri(context)
            val referenced = vaultUri?.let {
                runCatching { collectReferencedAttachments(context, it, uri) }.getOrNull()
            }
            val doc = DocumentFile.fromSingleUri(context, uri)
                ?: return Result.failure(IllegalStateException("Bestand niet gevonden."))
            if (!doc.delete()) return Result.failure(IllegalStateException("Verwijderen mislukt."))
            if (embeddedImages.isNotEmpty()) {
                if (vaultUri != null) {
                    if (referenced != null) {
                        val toRemove = embeddedImages.filter { it !in referenced }
                        if (toRemove.isNotEmpty()) {
                            for (name in toRemove) {
                                for (attUri in allAttachmentUris(context, vaultUri, name)) {
                                    try {
                                        DocumentsContract.deleteDocument(context.contentResolver, attUri)
                                    } catch (_: Exception) {
                                    }
                                }
                            }
                        }
                    }
                }
            }

            Result.success(Unit)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * Verzamelt alle attachment-basenames die nog gerefereerd worden door notities
     * in de Notes-map, Archive én Trash, met uitzondering van [excludeUri]. Gebruikt
     * door [deleteNote] om gedeelde OG-thumbnails te beschermen.
     */
    private fun collectReferencedAttachments(
        context: Context,
        vaultUri: Uri,
        excludeUri: Uri,
    ): Set<String>? {
        val excludeKey = excludeUri.toString()
        val result = HashSet<String>()

        val notesFolder = openNotesFolder(context).getOrNull()
        if (notesFolder != null) {
            for (child in queryChildren(context, vaultUri, notesFolder.uri, strict = true)) {
                if (child.name.startsWith(".") || !child.name.endsWith(".md", true)) continue
                if (child.uri.toString() == excludeKey) continue
                val body = readNote(context, child.uri).getOrNull() ?: return null
                result.addAll(findEmbeddedAttachmentBasenames(body))
            }
        }

        val tree = DocumentFile.fromTreeUri(context, vaultUri)
        if (tree == null) return null
        for (path in listOf("/Archive", "/Trash")) {
            val sub = traverseSubfolder(context, tree, getSubfolder(context).trimEnd('/') + path)
            if (sub != null) {
                for (child in queryChildren(context, vaultUri, sub.uri, strict = true)) {
                    if (!child.name.endsWith(".md", true)) continue
                    if (child.uri.toString() == excludeKey) continue
                    val body = readNote(context, child.uri).getOrNull() ?: return null
                    result.addAll(findEmbeddedAttachmentBasenames(body))
                }
            }
        }

        return result
    }

    // ── Labels ──────────────────────────────────────────────────────────────

    private fun labelsKey(context: Context): String? {
        val vaultUri = getVaultUri(context) ?: return null
        return "collections_${vaultUri}_${getSubfolder(context)}"
    }

    /**
     * Persistente labels geschaard per vault+subfolder via SharedPreferences.
     * Geen SAF-IO op de hoofdthread.
     */
    fun getLabels(context: Context): List<String> {
        val key = labelsKey(context) ?: return emptyList()
        val raw = PreferenceManager.getDefaultSharedPreferences(context)
            .getString(key, null) ?: return emptyList()
        return raw.split("\n").filter { it.isNotBlank() }
    }

    /** Discover only dedicated collection memberships, never ordinary tags. Call on IO. */
    private fun listLabels(context: Context): Result<List<String>> = runCatching {
        val vaultUri = getVaultUri(context) ?: error("Geen vault-map gekozen.")
        val tree = DocumentFile.fromTreeUri(context, vaultUri) ?: error("Vault-map kan niet worden geopend.")
        val labels = getLabels(context).toMutableList()
        for (folder in NoteFolder.entries) {
            val directory = traverseSubfolder(context, tree, folderPath(context, folder)) ?: continue
            for (child in queryChildren(context, vaultUri, directory.uri, strict = true)) {
                if (child.name.startsWith(".") || !child.name.endsWith(".md", true)) continue
                val note = readNote(context, child.uri)
                // Eén geparkeerde notitie mag het verversen niet blokkeren; bestaande labels blijven in het register.
                if (note.exceptionOrNull() is ParkedSaveException) continue
                labels.addAll(FrontmatterParser.parse(note.getOrThrow()).meta.labels)
            }
        }
        labels.distinctBy { it.lowercase() }
    }

    /**
     * Slaat labels persistent op via SharedPreferences. Retourneert Result<Unit>
     * — geen fouten worden geblokkeerd of genegeerd.
     */
    private fun saveLabels(context: Context, labels: List<String>): Result<Unit> {
        val key = labelsKey(context) ?: return Result.failure(IllegalStateException("Geen vault-map gekozen."))
        return try {
            PreferenceManager.getDefaultSharedPreferences(context)
                .edit()
                .putString(key, labels.distinctBy { it.lowercase() }.joinToString("\n"))
                .commit().also { if (!it) error("Labels konden niet worden opgeslagen.") }
            Result.success(Unit)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun addLabel(context: Context, label: String): Result<Unit> = noteWriteMutex.withLock {
        runCatching {
            require(LabelNames.validate(label)) { "Ongeldig label." }
            saveLabels(context, getLabels(context) + label).getOrThrow()
        }
    }

    suspend fun refreshLabels(context: Context): Result<Unit> = noteWriteMutex.withLock {
        val scopeKey = labelsKey(context)
        listLabels(context).fold(
            onSuccess = { labels ->
                if (scopeKey != labelsKey(context) || labels == getLabels(context)) Result.success(Unit)
                else saveLabels(context, labels)
            },
            onFailure = { Result.failure(it) },
        )
    }

    suspend fun updateLabels(context: Context, uri: Uri, added: Set<String>, removed: Set<String>): Result<List<String>> = noteWriteMutex.withLock {
        runCatching {
            require((added + removed).all { LabelNames.validate(it) }) { "Ongeldig label." }
            val current = readNote(context, uri).getOrThrow()
            val meta = FrontmatterParser.parse(current).meta
            val labels = LabelNames.applyChanges(meta.labels, added, removed)
            if (labels != meta.labels) updateNote(context, uri, FrontmatterWriter.applyLabels(current, labels)).getOrThrow()
            labels
        }
    }

    /**
     * Hernoemt label [old] naar [new] in het register én in de metadata
     * van alle notities in Notes/Archive/Trash onder [noteWriteMutex].
     *
     * [new] = null → verwijdert het label uit het register én uit alle
     * notities (notities en hun tags blijven behouden).
     *
     * Behoudt het lichaam (body) van elke notitie; bij partiële mislukkingen
     * wordt het register OUD gehouden en het aantal failures gerapporteerd.
     */
    suspend fun renameLabel(context: Context, old: String, new: String?): Result<Unit> {
        return noteWriteMutex.withLock {
            runCatching {
                require(new == null || LabelNames.validate(new)) { "Ongeldig label." }
                val vaultUri = getVaultUri(context) ?: error("Geen vault-map gekozen.")
                val tree = DocumentFile.fromTreeUri(context, vaultUri) ?: error("Vault-map kan niet worden geopend.")
                // Failed reads/writes retain the old registry entry so the operation can be retried.
                var parked: Throwable? = null
                for (folder in NoteFolder.entries) {
                    val folderDoc = traverseSubfolder(context, tree, folderPath(context, folder)) ?: continue
                    for (child in queryChildren(context, vaultUri, folderDoc.uri, strict = true)) {
                        if (child.name.startsWith(".") || !child.name.endsWith(".md", true)) continue
                        val note = readNote(context, child.uri)
                        // Eén geparkeerde notitie mag de rest niet halverwege laten staan; daarna melden.
                        val error = note.exceptionOrNull()
                        if (error is ParkedSaveException) {
                            parked = error
                            continue
                        }
                        val current = note.getOrThrow()
                        val meta = FrontmatterParser.parse(current).meta
                        if (meta.labels.none { it.equals(old, true) }) continue
                        val labels = meta.labels.mapNotNull { if (it.equals(old, true)) new else it }
                            .distinctBy { it.lowercase() }
                        updateNote(context, child.uri, FrontmatterWriter.applyLabels(current, labels)).getOrThrow()
                    }
                }
                parked?.let { throw it }
                val labels = getLabels(context).filterNot { it.equals(old, true) }
                saveLabels(context, if (new == null) labels else labels + new).getOrThrow()
            }
        }
    }

    // ── Einde labels ────────────────────────────────────────────────────────

    /**
     * Vindt of maakt de effectieve assets-map (expliciete instelling, of de
     * legacy `.attachments`-submap onder de notitiemap). Gebruikt voor OG-images,
     * foto-import en voicememo's.
     */
    fun getOrCreateAttachmentsFolder(context: Context): Result<DocumentFile> {
        val vaultUri = getVaultUri(context)
            ?: return Result.failure(IllegalStateException("Geen vault-map gekozen."))
        val tree = DocumentFile.fromTreeUri(context, vaultUri)
            ?: return Result.failure(IllegalStateException("Vault-map kan niet worden geopend."))
        if (!tree.canWrite()) {
            return Result.failure(IllegalStateException("Geen schrijfrechten op de vault-map."))
        }
        val path = resolveAssetsFolder(context)
        val folder = findOrCreateSubfolder(context, tree, path)
            ?: return Result.failure(IllegalStateException("Attachments-map kon niet worden aangemaakt."))
        return Result.success(folder)
    }

    /**
     * Zoekt een attachment-bestand op basename. Gebruikt voor het renderen van
     * `![[image.jpg]]`-embeds in de UI. Zoekt eerst de effectieve map, daarna de
     * legacy-locatie, zodat oude notities blijven werken na een mapwissel.
     */
    fun findAttachmentUri(context: Context, basename: String): Uri? {
        val vaultUri = getVaultUri(context) ?: return null
        val tree = DocumentFile.fromTreeUri(context, vaultUri) ?: return null
        val effective = resolveAssetsFolder(context)
        val effectiveFolder = traverseSubfolder(context, tree, effective)
        val effectiveHit = effectiveFolder?.findFile(basename)
        if (effectiveHit != null) return effectiveHit.uri
        val legacy = legacyAssetsPath(context)
        if (legacy == effective) return null
        val legacyFolder = traverseSubfolder(context, tree, legacy) ?: return null
        return legacyFolder.findFile(basename)?.uri
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
        // "webm" = desktop-voicememo's van de plugin (opus/webm); zonder die
        // extensie werden ze niet als audio herkend én bij delete overgeslagen
        // door de refcount (wees-bestanden in .attachments/).
        return ext in setOf("m4a", "mp3", "wav", "ogg", "aac", "flac", "3gp", "amr", "webm")
    }

    fun archiveNote(context: Context, uri: Uri): Result<Unit> {
        return moveNoteToFolder(context, uri, NoteFolder.ARCHIVE)
    }

    /**
     * Move [uri] into [folder]. Collision-safe (unique filename on conflict).
     * Verifies target output exists and matches source content BEFORE deleting
     * the source. If verification fails, source is retained and failure returned.
     */
    private fun moveNoteToFolder(context: Context, uri: Uri, folder: NoteFolder): Result<Unit> {
        val content = readNote(context, uri).getOrElse { return Result.failure(it) }

        val vaultUri = getVaultUri(context)
            ?: return Result.failure(IllegalStateException("Geen vault-map gekozen."))
        val tree = DocumentFile.fromTreeUri(context, vaultUri)
            ?: return Result.failure(IllegalStateException("Vault-map kan niet worden geopend."))

        val folderPath = folderPath(context, folder)
        val targetFolder = findOrCreateSubfolder(context, tree, folderPath)
            ?: return Result.failure(IllegalStateException("Doelmap kon niet worden aangemaakt."))

        val sourceDoc = DocumentFile.fromSingleUri(context, uri)
            ?: return Result.failure(IllegalStateException("Bronbestand niet gevonden."))
        val filename = sourceDoc.name ?: "${System.currentTimeMillis()}.md"

        val targetName = uniqueFilename(targetFolder, filename)
        val newFile = targetFolder.createFile("text/markdown", targetName)
            ?: return Result.failure(IllegalStateException("Bestand kon niet worden aangemaakt in doelmap."))

        return try {
            context.contentResolver.openOutputStream(newFile.uri, "wt")?.use { out ->
                out.write(content.toByteArray(Charsets.UTF_8))
            } ?: run {
                newFile.delete()
                return Result.failure(IllegalStateException("Kan niet schrijven naar doelmap."))
            }

            // Verify target output before source delete
            val verified = readNote(context, newFile.uri).getOrNull()
            if (verified != content) {
                newFile.delete()
                return Result.failure(IllegalStateException("Doelbestand verificatie mislukt."))
            }

            if (!sourceDoc.delete()) {
                newFile.delete()
                return Result.failure(IllegalStateException("Origineel bestand kon niet worden verwijderd."))
            }
            Result.success(Unit)
        } catch (e: Exception) {
            newFile.delete()
            Result.failure(e)
        }
    }

    private fun folderPath(context: Context, folder: NoteFolder): String {
        val base = getSubfolder(context).trimEnd('/')
        return when (folder) {
            NoteFolder.NOTES -> base
            NoteFolder.ARCHIVE -> "$base/Archive"
            NoteFolder.TRASH -> "$base/Trash"
        }
    }

    fun trashNote(context: Context, uri: Uri): Result<Unit> {
        return moveNoteToFolder(context, uri, NoteFolder.TRASH)
    }

    fun restoreNote(context: Context, uri: Uri): Result<Unit> {
        return moveNoteToFolder(context, uri, NoteFolder.NOTES)
    }

    /**
     * If [uri] is inside Trash → permanent delete. Otherwise → move to Trash.
     * The editor and bulk selection both use the same deletion policy.
     */
    fun deleteOrTrashNote(context: Context, uri: Uri): Result<Unit> {
        return runCatching {
            if (isInFolder(context, uri, NoteFolder.TRASH)) deleteNote(context, uri).getOrThrow()
            else trashNote(context, uri).getOrThrow()
        }
    }

    private fun isInFolder(context: Context, uri: Uri, folder: NoteFolder): Boolean {
        val vaultUri = getVaultUri(context) ?: return false
        val tree = DocumentFile.fromTreeUri(context, vaultUri) ?: return false
        val folderPath = folderPath(context, folder)
        val folderDoc = traverseSubfolder(context, tree, folderPath) ?: return false
        val uriDocId = DocumentsContract.getDocumentId(uri)
        val children = queryChildren(context, vaultUri, folderDoc.uri, strict = true)
        return children.any { DocumentsContract.getDocumentId(it.uri) == uriDocId }
    }

    /**
     * Loopt de hele vault recursief af en geeft alle markdown-bestanden terug
     * voor link-autocomplete. Performance: voor vaults < ~2000 notities OK; bij
     * grotere vaults caching in de aanroeper aanbevolen.
     */
    fun listAllVaultMarkdownFiles(context: Context): Result<List<VaultMarkdownFile>> {
        val vaultUri = getVaultUri(context)
            ?: return Result.failure(IllegalStateException("Geen vault-map gekozen."))
        val rootId = try {
            DocumentsContract.getTreeDocumentId(vaultUri)
        } catch (_: Exception) {
            return Result.failure(IllegalStateException("Vault-map kan niet worden geopend."))
        }

        val results = mutableListOf<VaultMarkdownFile>()
        walkVault(context, vaultUri, rootId, "", results)
        results.sortBy { it.basename.lowercase() }
        return Result.success(results)
    }

    // Eén query per map: DocumentFile.listFiles() vraagt naam en type per bestand apart op (circa 20 s bij een grote vault).
    private fun walkVault(context: Context, treeUri: Uri, folderId: String, pathPrefix: String, into: MutableList<VaultMarkdownFile>) {
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, folderId)
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
        )
        val folders = mutableListOf<Pair<String, String>>()
        try {
            context.contentResolver.query(childrenUri, projection, null, null, null)?.use { cursor ->
                while (cursor.moveToNext()) {
                    val id = cursor.getString(0) ?: continue
                    val childName = cursor.getString(1) ?: continue
                    val mime = cursor.getString(2).orEmpty()
                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                        // Sla Obsidian-systeemmappen over om niet honderden .md's uit plugins te laden.
                        if (!childName.startsWith(".")) {
                            folders.add(id to if (pathPrefix.isEmpty()) childName else "$pathPrefix/$childName")
                        }
                    } else if (mime.isNotEmpty() && childName.endsWith(".md", ignoreCase = true)) {
                        val basename = childName.removeSuffix(".md").removeSuffix(".MD")
                        val relPath = if (pathPrefix.isEmpty()) basename else "$pathPrefix/$basename"
                        into.add(VaultMarkdownFile(basename, relPath, DocumentsContract.buildDocumentUriUsingTree(treeUri, id)))
                    }
                }
            }
        } catch (_: Exception) {
            // Net als DocumentFile.listFiles(): een onleesbare map telt als leeg.
        }
        for ((id, path) in folders) walkVault(context, treeUri, id, path, into)
    }

    private fun openNotesFolder(context: Context): Result<DocumentFile> {
        val vaultUri = getVaultUri(context)
            ?: return Result.failure(IllegalStateException("Geen vault-map gekozen."))
        val tree = DocumentFile.fromTreeUri(context, vaultUri)
            ?: return Result.failure(IllegalStateException("Vault-map kan niet worden geopend."))
        val subfolderName = getSubfolder(context)
        val subfolder = traverseSubfolder(context, tree, subfolderName)
            ?: return Result.failure(IllegalStateException(context.getString(R.string.error_subfolder_missing, subfolderName)))
        return Result.success(subfolder)
    }

    private fun openOrCreateNotesFolder(context: Context): Result<DocumentFile> {
        val vaultUri = getVaultUri(context)
            ?: return Result.failure(IllegalStateException("Geen vault-map gekozen."))
        val tree = DocumentFile.fromTreeUri(context, vaultUri)
            ?: return Result.failure(IllegalStateException("Vault-map kan niet worden geopend."))
        val subfolderName = getSubfolder(context)
        val subfolder = findOrCreateSubfolder(context, tree, subfolderName)
            ?: return Result.failure(IllegalStateException(context.getString(R.string.error_subfolder_create, subfolderName)))
        return Result.success(subfolder)
    }

    private fun traverseSubfolder(context: Context, parent: DocumentFile, name: String): DocumentFile? {
        var current: DocumentFile = parent
        for (segment in name.split('/').map { it.trim() }.filter { it.isNotEmpty() }) {
            val existing = findDirectory(context, current, segment) ?: return null
            current = existing
        }
        return current
    }

    // One cursor per directory, instead of DocumentFile.findFile's per-child metadata queries.
    private fun findDirectory(context: Context, parent: DocumentFile, name: String): DocumentFile? {
        return try {
        val uri = DocumentsContract.buildChildDocumentsUriUsingTree(parent.uri, DocumentsContract.getDocumentId(parent.uri))
        val columns = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
        )
        context.contentResolver.query(uri, columns, null, null, null)?.use { cursor ->
            while (cursor.moveToNext()) {
                if (cursor.getString(1) == name && cursor.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) {
                    val id = cursor.getString(0) ?: continue
                    val childUri = DocumentsContract.buildDocumentUriUsingTree(parent.uri, id)
                    return DocumentFile.fromTreeUri(context, childUri)
                }
            }
        }
        null
        } catch (_: Exception) { null }
    }

    private fun findOrCreateSubfolder(context: Context, parent: DocumentFile, name: String): DocumentFile? {
        var current: DocumentFile = parent
        for (segment in name.split('/').map { it.trim() }.filter { it.isNotEmpty() }) {
            val existing = findDirectory(context, current, segment)
            current = if (existing != null) {
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
        // Lijstmarkers strippen zodat de kaarttitel niet met rauwe Markdown begint.
        // CardText haalt ook opmaaktekens weg en toont `\#tag` (geneutraliseerde gedeelde
        // tekst) zoals Obsidian's leesweergave: zonder backslash.
        val cleaned = CardText.plain(firstLine
            .replace(Regex("^-[ \\t]+\\[[ xX]\\](?:[ \\t]+|$)"), "")
            .replace(Regex("^(?:[-*+][ \\t]+|\\d{1,9}[.)][ \\t]+)"), "")
            .trimStart('#'))
            .trim()
        return cleaned.ifBlank { fallbackFilename.removeSuffix(".md") }
    }

    private fun extractSnippet(body: String): String {
        // Filter zowel Obsidian-wikilink-embeds (![[…]]) als standaard markdown-images (![alt](…)).
        val wikiEmbed = Regex("^\\s*!\\[\\[[^\\]]+]]\\s*$")
        val mdImage = Regex("^\\s*!\\[[^\\]]*]\\([^)]+\\)\\s*$")
        // Preview-markering van PreviewWorker niet tonen (plugin-pariteit: extractPreview in view.ts).
        val previewMarker = Regex("^\\s*<!--\\s*(?:jotdrop|diexar)-preview:.*?-->\\s*$")
        val lines = body.lineSequence()
            .map { it.trimEnd() }
            .filter { it.isNotBlank() && !wikiEmbed.matches(it) && !mdImage.matches(it) && !previewMarker.matches(it) }
            .toList()
        // Een gewone eerste regel is al de kaarttitel en hoeft niet dubbel in de
        // snippet. Een lijstregel blijft juist staan, inclusief geneste checklists.
        val firstIsList = lines.firstOrNull()?.matches(
            Regex("^[ \\t]*(?:-[ \\t]+\\[[ xX]\\](?:[ \\t]|$)|[-*+][ \\t]+|\\d{1,9}[.)][ \\t]+).*$"),
        ) == true
        val rest = if (firstIsList) lines.joinToString("\n")
        else if (lines.size > 1) lines.drop(1).joinToString("\n")
        else ""
        // URLs strippen — die worden als chips onderaan getoond (plugin-pariteit).
        // Markdown-link-syntax behoudt het label, losse URLs verdwijnen volledig.
        // Daarna opmaaktekens weg (plugin-pariteit), en `\#tag` zonder backslash.
        val stripped = CardText.plain(rest
            .replace(Regex("\\[([^\\]\\n]+)]\\(https?://[^)\\s]+\\)"), "$1")
            .replace(Regex("https?://\\S+"), ""))
            .lineSequence()
            .map { it.trimEnd() }
            .joinToString("\n")
            .trimEnd()
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
            .replace(Regex("""^- \[[ xX]]\s*"""), "")
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

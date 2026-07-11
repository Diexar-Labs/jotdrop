package com.diexar.keepcapture

import android.content.Context
import android.net.Uri
import androidx.work.BackoffPolicy
import androidx.work.CoroutineWorker
import androidx.work.Constraints
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.TimeUnit

/**
 * Achtergrond-fetcher voor OG-previews. Wordt door ShareActivity gescheduled
 * nadat een placeholder-notitie is opgeslagen, zodat de share-dialog binnen
 * ~100ms sluit ongeacht hoe traag het OG-endpoint reageert (3-15s in praktijk).
 *
 * Veiligheid voor user-edits: de worker checkt eerst of de PENDING-marker nog
 * in de notitie staat. Als die weg is (gebruiker heeft de notitie bewerkt),
 * laat de worker 'm met rust.
 */
class PreviewWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): ListenableWorker.Result {
        val noteUriString = inputData.getString(KEY_NOTE_URI)
            ?: return ListenableWorker.Result.failure()
        val url = inputData.getString(KEY_URL)
            ?: return ListenableWorker.Result.failure()
        val fallbackSubject = inputData.getString(KEY_FALLBACK_SUBJECT)
        val extraText = inputData.getString(KEY_EXTRA_TEXT)
        val noteUri = Uri.parse(noteUriString)

        val current = Storage.readNote(applicationContext, noteUri).getOrNull()
            ?: return ListenableWorker.Result.success()
        if (!current.contains(PENDING_MARKER)) {
            return ListenableWorker.Result.success()
        }

        val previewResult: kotlin.Result<OgPreview> = try {
            OgFetcher.fetch(applicationContext, url, Storage.getDownloadImages(applicationContext))
        } catch (e: Throwable) {
            kotlin.Result.failure(e)
        }

        val preview = previewResult.getOrNull()
        val diagnostic = previewResult.exceptionOrNull()?.let { e ->
            "${e.javaClass.simpleName}: ${e.message?.take(80)}"
        } ?: if (preview?.imageBasename == null) "geen og:image gevonden" else null

        val content = buildLinkNote(url, preview, fallbackSubject, diagnostic, extraText)

        // Onder de schrijf-mutex: herlees vlak vóór de write. De OG-fetch duurt
        // 3-15s; als de gebruiker in die tijd de notitie bewerkte (marker weg)
        // of tags/kleur/pin zette (frontmatter erbij), mag de herschrijf die
        // wijzigingen niet weggooien.
        return Storage.noteWriteMutex.withLock {
            val latest = Storage.readNote(applicationContext, noteUri).getOrNull()
                ?: return@withLock ListenableWorker.Result.success()
            if (!latest.contains(PENDING_MARKER)) {
                return@withLock ListenableWorker.Result.success()
            }
            val fm = FrontmatterParser.parse(latest).frontmatter
            Storage.updateNote(applicationContext, noteUri, fm + content).fold(
                onSuccess = { ListenableWorker.Result.success() },
                onFailure = { ListenableWorker.Result.retry() },
            )
        }
    }

    companion object {
        const val KEY_NOTE_URI = "note_uri"
        const val KEY_URL = "url"
        const val KEY_FALLBACK_SUBJECT = "subject"
        const val KEY_EXTRA_TEXT = "extra_text"
        const val PENDING_MARKER = "<!-- jotdrop-preview: pending -->"

        fun enqueue(context: Context, noteUri: Uri, url: String, subject: String?, extraText: String? = null) {
            val data = workDataOf(
                KEY_NOTE_URI to noteUri.toString(),
                KEY_URL to url,
                KEY_FALLBACK_SUBJECT to subject,
                KEY_EXTRA_TEXT to extraText,
            )
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val req = OneTimeWorkRequestBuilder<PreviewWorker>()
                .setInputData(data)
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.LINEAR, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context.applicationContext).enqueue(req)
        }

        fun buildPlaceholder(url: String, subject: String?, extraText: String? = null): String {
            val rawTitle = subject?.trim()?.takeIf { it.isNotEmpty() } ?: url
            // Strippen — geen escapen — zodat de kaart-titel niet vol staat met `\#fyp`.
            val title = Storage.sanitizeTitleFromShare(rawTitle).ifEmpty { url }
            return buildString {
                append("# "); append(title); append("\n\n")
                append("["); append(title); append("]("); append(url); append(")\n\n")
                if (!extraText.isNullOrBlank()) {
                    // Meegedeelde tekst rond de URL hoort in de notitie te blijven.
                    append(Storage.neutralizeBodyHashtags(extraText.trim())); append("\n\n")
                }
                append(PENDING_MARKER)
            }
        }

        fun buildLinkNote(
            url: String,
            preview: OgPreview?,
            fallbackSubject: String?,
            diagnostic: String?,
            extraText: String? = null,
        ): String {
            val rawTitle = preview?.title?.trim()?.takeIf { it.isNotEmpty() }
                ?: fallbackSubject?.trim()?.takeIf { it.isNotEmpty() }
                ?: url
            val title = Storage.sanitizeTitleFromShare(rawTitle).ifEmpty { url }
            val description = preview?.description?.trim()
            val imageBasename = preview?.imageBasename

            val raw = buildString {
                append("# ")
                append(title)
                append("\n\n")
                if (imageBasename != null) {
                    append("![[")
                    append(imageBasename)
                    append("]]\n\n")
                }
                append("[")
                append(title)
                append("](")
                append(url)
                append(")")
                if (!description.isNullOrEmpty()) {
                    append("\n\n")
                    append(description)
                }
                if (!extraText.isNullOrBlank()) {
                    append("\n\n")
                    append(extraText.trim())
                }
                if (diagnostic != null) {
                    append("\n\n<!-- jotdrop-preview: ")
                    append(diagnostic)
                    append(" -->")
                }
            }
            // Neutralisatie nogmaals over de hele tekst — de description kan
            // alsnog `#tags` bevatten en die mogen ABSOLUUT niet in Obsidian's
            // graph view belanden.
            return Storage.neutralizeBodyHashtags(raw)
        }
    }
}

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
        val noteUri = Uri.parse(noteUriString)

        val current = Storage.readNote(applicationContext, noteUri).getOrNull()
            ?: return ListenableWorker.Result.success()
        if (!current.contains(PENDING_MARKER)) {
            return ListenableWorker.Result.success()
        }

        val previewResult: kotlin.Result<OgPreview> = try {
            OgFetcher.fetch(applicationContext, url)
        } catch (e: Throwable) {
            kotlin.Result.failure(e)
        }

        val preview = previewResult.getOrNull()
        val diagnostic = previewResult.exceptionOrNull()?.let { e ->
            "${e.javaClass.simpleName}: ${e.message?.take(80)}"
        } ?: if (preview?.imageBasename == null) "geen og:image gevonden" else null

        val content = buildLinkNote(url, preview, fallbackSubject, diagnostic)

        return Storage.updateNote(applicationContext, noteUri, content).fold(
            onSuccess = { ListenableWorker.Result.success() },
            onFailure = { ListenableWorker.Result.retry() },
        )
    }

    companion object {
        const val KEY_NOTE_URI = "note_uri"
        const val KEY_URL = "url"
        const val KEY_FALLBACK_SUBJECT = "subject"
        const val PENDING_MARKER = "<!-- obsidrop-preview: pending -->"

        fun enqueue(context: Context, noteUri: Uri, url: String, subject: String?) {
            val data = workDataOf(
                KEY_NOTE_URI to noteUri.toString(),
                KEY_URL to url,
                KEY_FALLBACK_SUBJECT to subject,
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

        fun buildPlaceholder(url: String, subject: String?): String {
            val title = subject?.trim()?.takeIf { it.isNotEmpty() } ?: url
            return buildString {
                append("# "); append(title); append("\n\n")
                append("["); append(title); append("]("); append(url); append(")\n\n")
                append(PENDING_MARKER)
            }
        }

        fun buildLinkNote(
            url: String,
            preview: OgPreview?,
            fallbackSubject: String?,
            diagnostic: String?,
        ): String {
            val title = preview?.title?.trim()?.takeIf { it.isNotEmpty() }
                ?: fallbackSubject?.trim()?.takeIf { it.isNotEmpty() }
                ?: url
            val description = preview?.description?.trim()
            val imageBasename = preview?.imageBasename

            return buildString {
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
                if (diagnostic != null) {
                    append("\n\n<!-- obsidrop-preview: ")
                    append(diagnostic)
                    append(" -->")
                }
            }
        }
    }
}

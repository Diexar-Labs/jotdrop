package com.diexar.keepcapture

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.compose.setContent
import com.diexar.keepcapture.ui.JotDropTheme

/**
 * Onzichtbare activiteit die alleen wordt geactiveerd door een share-intent.
 * Strategie: bewaar direct een placeholder-notitie (URL + titel) en sluit
 * de share-dialog binnen ~100ms. Een achtergrond-worker (PreviewWorker) haalt
 * daarna de OG-preview op en updatet de notitie als hij klaar is. Hierdoor
 * voelt elke share instant, ongeacht hoe traag de bron-site reageert.
 */
class ShareActivity : ThemedAppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleShare()
    }

    private fun handleShare() {
        val vaultUri = Storage.getVaultUri(this)
        if (vaultUri == null) {
            toast(getString(R.string.error_no_vault))
            startActivity(Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            })
            finish()
            return
        }

        // Files first (a photo, a PDF from a mail or WhatsApp, several at once): the person chooses New note or
        // Add to a note. A text share that also carries a file (some apps add a .txt) stays a text note, as before.
        val shared = sharedFiles(intent)
        if (shared.isNotEmpty() && !isTextShare(intent)) {
            val files = shared.filter { Attachments.isReadableSource(this, it) }
            if (files.isEmpty()) {
                toast(getString(R.string.attach_unreadable))
                finish()
                return
            }
            val subject = intent?.getStringExtra(Intent.EXTRA_SUBJECT)
            val extraText = intent?.getStringExtra(Intent.EXTRA_TEXT)
            // The theme's title bar was never seen while a share closed at once; over the chooser it only looks odd.
            supportActionBar?.hide()
            setContent {
                JotDropTheme {
                    ShareFilesChooser(files, subject, extraText, onDone = { finish() })
                }
            }
            return
        }

        val text = extractText(intent)
        if (text.isBlank()) {
            toast(getString(R.string.empty_share))
            finish()
            return
        }

        val url = pickBestUrl(intent) ?: OgFetcher.detectUrl(text)
        if (url == null) {
            saveTextNote(text)
            return
        }

        val subject = intent?.getStringExtra(Intent.EXTRA_SUBJECT)
        // Begeleidende tekst rond de URL bewaren ("Niet vergeten! https://…"):
        // die ging voorheen verloren zodra er een URL in de share zat, terwijl
        // de plugin-capture 'm wél bewaart.
        val extraText = intent?.getStringExtra(Intent.EXTRA_TEXT)
            ?.replace(url, "")
            ?.trim()
            ?.takeIf { it.isNotEmpty() && it != subject?.trim() }
        val placeholder = PreviewWorker.buildPlaceholder(url, subject, extraText)
        val created = Storage.createNote(this, placeholder)
        created.onSuccess { (filename, noteUri) ->
            toast(getString(R.string.toast_saved, filename))
            PreviewWorker.enqueue(applicationContext, noteUri, url, subject, extraText)
        }.onFailure { err ->
            toast(getString(R.string.toast_error, err.message ?: "onbekende fout"))
        }
        finish()
    }

    /** A shared text (a link, a quote): a text type with text in it, even when the app also adds a file. */
    private fun isTextShare(intent: Intent?): Boolean =
        intent?.type?.lowercase().orEmpty().startsWith("text/") && !intent?.getStringExtra(Intent.EXTRA_TEXT).isNullOrBlank()

    /** The files in a share: EXTRA_STREAM (one, or several with SEND_MULTIPLE), or the clip's file items. */
    @Suppress("DEPRECATION")
    private fun sharedFiles(intent: Intent?): List<Uri> {
        if (intent == null) return emptyList()
        val found = mutableListOf<Uri>()
        if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
            val list = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
                else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
            list?.let(found::addAll)
        } else {
            val one = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                else intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
            one?.let(found::add)
        }
        if (found.isEmpty() && !intent.type.orEmpty().startsWith("text/")) {
            intent.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(found::add) }
        }
        return found.distinct()
    }

    private fun saveTextNote(text: String) {
        val result = Storage.saveNote(this, text)
        result.onSuccess { filename ->
            toast(getString(R.string.toast_saved, filename))
        }.onFailure { err ->
            toast(getString(R.string.toast_error, err.message ?: "onbekende fout"))
        }
        finish()
    }

    /**
     * Verzamelt URL-kandidaten uit alle bronnen in het share-intent en kiest de
     * "beste": eerst niet-afgekapte URL's (zonder `…` / `%E2%80%A6`), daarbinnen
     * de langste. Lost het Telegraaf-probleem op waarbij EXTRA_TEXT een verkorte
     * URL bevat terwijl de volledige URL elders in het intent zit.
     */
    private fun pickBestUrl(intent: Intent?): String? {
        if (intent == null) return null
        val candidates = mutableListOf<String>()
        fun harvest(text: String?) {
            if (text.isNullOrBlank()) return
            candidates.addAll(OgFetcher.findAllUrls(text))
        }
        harvest(intent.getStringExtra(Intent.EXTRA_TEXT))
        harvest(intent.getStringExtra(Intent.EXTRA_SUBJECT))
        harvest(intent.getStringExtra("android.intent.extra.HTML_TEXT"))
        harvest(intent.dataString)
        intent.clipData?.let { clip ->
            for (i in 0 until clip.itemCount) {
                val item = clip.getItemAt(i)
                harvest(item.text?.toString())
                harvest(item.uri?.toString())
                harvest(item.htmlText)
            }
        }
        if (candidates.isEmpty()) return null
        val untruncated = candidates.filter { !OgFetcher.isTruncatedUrl(it) }
        val pool = if (untruncated.isNotEmpty()) untruncated else candidates
        return pool.maxByOrNull { it.length }
    }

    private fun extractText(intent: Intent?): String {
        if (intent == null) return ""
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.trim().orEmpty()
        var body = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
        if (body.isEmpty()) {
            val clip = intent.clipData
            if (clip != null && clip.itemCount > 0) {
                for (i in 0 until clip.itemCount) {
                    val item = clip.getItemAt(i)
                    val text = (item.text?.toString()
                        ?: item.uri?.toString()
                        ?: item.htmlText)?.trim().orEmpty()
                    if (text.isNotEmpty()) { body = text; break }
                }
            }
        }
        if (body.isEmpty()) {
            body = intent.dataString?.trim().orEmpty()
        }
        if (body.isEmpty()) {
            body = intent.getStringExtra("android.intent.extra.HTML_TEXT")?.trim().orEmpty()
        }
        // Wanneer de subject als titel-regel gebruikt wordt: tags eruit strippen.
        // Body laat saveNote() doorheen de neutralizer lopen — die escapet hashtags
        // i.p.v. ze te verwijderen, want daar tellen ze als content.
        return when {
            subject.isNotEmpty() && body.isNotEmpty() && body != subject -> {
                val cleanTitle = Storage.sanitizeTitleFromShare(subject)
                if (cleanTitle.isEmpty()) body else "# $cleanTitle\n\n$body"
            }
            subject.isNotEmpty() -> subject
            else -> body
        }
    }

    private fun toast(message: String) {
        Toast.makeText(applicationContext, message, Toast.LENGTH_SHORT).show()
    }
}

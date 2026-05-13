package com.diexar.keepcapture

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/**
 * Onzichtbare activiteit die alleen wordt geactiveerd door een share-intent.
 * Strategie: bewaar direct een placeholder-notitie (URL + titel) en sluit
 * de share-dialog binnen ~100ms. Een achtergrond-worker (PreviewWorker) haalt
 * daarna de OG-preview op en updatet de notitie als hij klaar is. Hierdoor
 * voelt elke share instant, ongeacht hoe traag de bron-site reageert.
 */
class ShareActivity : AppCompatActivity() {

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

        // Image-share heeft voorrang: Camera/Galerij sturen image/* met EXTRA_STREAM.
        // Sommige apps zetten daar ook een caption in EXTRA_TEXT bij.
        if (isImageShare(intent)) {
            handleImageShare()
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
        val placeholder = PreviewWorker.buildPlaceholder(url, subject)
        val created = Storage.createNote(this, placeholder)
        created.onSuccess { (filename, noteUri) ->
            toast(getString(R.string.toast_saved, filename))
            PreviewWorker.enqueue(applicationContext, noteUri, url, subject)
        }.onFailure { err ->
            toast(getString(R.string.toast_error, err.message ?: "onbekende fout"))
        }
        finish()
    }

    private fun isImageShare(intent: Intent?): Boolean {
        if (intent == null) return false
        val type = intent.type?.lowercase().orEmpty()
        if (!type.startsWith("image/")) return false
        return getImageUri(intent) != null
    }

    @Suppress("DEPRECATION")
    private fun getImageUri(intent: Intent): android.net.Uri? {
        return if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, android.net.Uri::class.java)
        } else {
            intent.getParcelableExtra(Intent.EXTRA_STREAM)
        }
    }

    private fun handleImageShare() {
        val imageUri = getImageUri(intent)
        if (imageUri == null) {
            toast(getString(R.string.no_image_in_share))
            finish()
            return
        }
        val subject = intent?.getStringExtra(Intent.EXTRA_SUBJECT)
        val extraText = intent?.getStringExtra(Intent.EXTRA_TEXT)
        Storage.saveImageNote(this, imageUri, subject, extraText).onSuccess { filename ->
            toast(getString(R.string.toast_saved, filename))
        }.onFailure { err ->
            toast(getString(R.string.toast_error, err.message ?: "onbekende fout"))
        }
        finish()
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

package com.diexar.keepcapture

import android.content.Context
import android.net.Uri
import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.google.mlkit.vision.text.devanagari.DevanagariTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Dunne wrapper rond ML Kit Text Recognition. Het Latijnse model wordt met de APK
 * meegeleverd, dus werkt zonder Play Services en zonder internet. Chinees en
 * Devanagari (Hindi) komen via Play Services: zonder Play Services of zolang het
 * model nog niet binnen is, worden ze overgeslagen.
 */
object OcrService {

    private val latin by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }
    private val chinese by lazy { TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build()) }
    private val devanagari by lazy { TextRecognition.getClient(DevanagariTextRecognizerOptions.Builder().build()) }

    /** Vraagt Play Services de Chinese en Devanagari-modellen alvast op te halen, terwijl de gebruiker scant. */
    fun prepareOtherScripts(context: Context) {
        try {
            ModuleInstall.getClient(context)
                .installModules(ModuleInstallRequest.newBuilder().addApi(chinese).addApi(devanagari).build())
        } catch (_: Throwable) {
            // Geen Play Services: alleen Latijn.
        }
    }

    suspend fun recognizeFromUri(context: Context, imageUri: Uri): Result<String> = try {
        val image = InputImage.fromFilePath(context, imageUri)
        val text = awaitRecognition(latin, image)
        // Een ander schrift telt alleen als zijn tekst er duidelijk in staat.
        val other = listOf(devanagari to Character.UnicodeScript.DEVANAGARI, chinese to Character.UnicodeScript.HAN)
            .firstNotNullOfOrNull { (recognizer, script) ->
                runCatching { awaitRecognition(recognizer, image) }.getOrNull()?.takeIf { mostly(it, script) }
            }
        Result.success(other ?: text)
    } catch (e: Throwable) {
        Result.failure(e)
    }

    /** At least three letters of [script], and at least a tenth of all letters. */
    internal fun mostly(text: String, script: Character.UnicodeScript): Boolean {
        val letters = text.codePoints().filter(Character::isLetter).toArray()
        val inScript = letters.count { Character.UnicodeScript.of(it) == script }
        return inScript >= 3 && inScript * 10 >= letters.size
    }

    private suspend fun awaitRecognition(
        recognizer: TextRecognizer,
        image: InputImage,
    ): String = suspendCancellableCoroutine { cont ->
        recognizer.process(image)
            .addOnSuccessListener { result ->
                // result.text is de hele tekst gejoinde met newlines tussen blokken —
                // precies wat we voor markdown-inserts willen.
                cont.resume(result.text.trim())
            }
            .addOnFailureListener { e ->
                cont.resumeWithException(e)
            }
    }
}

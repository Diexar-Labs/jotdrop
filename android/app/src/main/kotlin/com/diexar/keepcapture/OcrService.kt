package com.diexar.keepcapture

import android.content.Context
import android.net.Uri
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Dunne wrapper rond ML Kit Text Recognition (Latijns schrift). Het standalone
 * model wordt met de APK meegeleverd, dus werkt zonder Play Services en zonder
 * internet. Andere scripts (Chinees, Devanagari, Japans, Koreaans) zijn aparte
 * artifacts — niet nodig voor de talen die we nu in de UI ondersteunen.
 */
object OcrService {

    suspend fun recognizeFromUri(context: Context, imageUri: Uri): Result<String> = try {
        val image = InputImage.fromFilePath(context, imageUri)
        val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
        val text = awaitRecognition(recognizer, image)
        Result.success(text)
    } catch (e: Throwable) {
        Result.failure(e)
    }

    private suspend fun awaitRecognition(
        recognizer: com.google.mlkit.vision.text.TextRecognizer,
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

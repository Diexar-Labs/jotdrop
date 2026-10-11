package com.diexar.keepcapture

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import java.io.File

class VoiceMemoRecorder(private val context: Context) {
    fun start(): Result<Unit> = runCatching {
        check(!VoiceMemoRecordingService.recording.value) { "Opname loopt al." }
        check(VoiceMemoRecordingService.pending.value == null) { "Sla eerst de vorige opname op." }
        VoiceMemoRecordingService.recording.value = true
        try {
            ContextCompat.startForegroundService(context, Intent(context, VoiceMemoRecordingService::class.java).apply {
                action = VoiceMemoRecordingService.ACTION_START
            })
        } catch (e: Exception) {
            VoiceMemoRecordingService.recording.value = false
            throw e
        }
    }

    fun stopAndFinalize(): Result<RecordedMemo> =
        VoiceMemoRecordingService.instance?.stopRecording()
            ?: Result.failure(IllegalStateException("Opname wordt nog gestart. Probeer opnieuw."))

    fun clearPending() = VoiceMemoRecordingService.clearPending(context)

    data class RecordedMemo(val file: File, val durationMs: Long)
}

/** One pending save belongs to the process, never to an Activity's lifecycle. */
internal object VoiceMemoSave {
    val saving = MutableStateFlow(false)
    val saved = MutableStateFlow<String?>(null)
    val failure = MutableStateFlow<String?>(null)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Synchronized
    fun save(action: suspend () -> Result<String>, onSaved: () -> Unit) {
        if (saving.value) return
        saving.value = true
        failure.value = null
        scope.launch {
            try {
                val filename = action().getOrThrow()
                onSaved()
                saved.value = filename
            } catch (e: Exception) {
                failure.value = e.message ?: e.javaClass.simpleName
            } finally {
                synchronized(VoiceMemoSave) { saving.value = false }
            }
        }
    }
}

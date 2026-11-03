package com.diexar.keepcapture

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

/**
 * Holding the app icon and choosing the voice memo lands here. A launcher shortcut closes every screen in its task,
 * and the editor saves only on the way back, so this screen has its own task and an open note stays as it is.
 * Not exported: only the shortcut may start the microphone, not another app.
 */
class VoiceMemoShortcutActivity : ThemedAppCompatActivity() {
    private val askMicrophone = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) record() else Toast.makeText(this, R.string.record_permission_denied, Toast.LENGTH_SHORT).show()
        openNotes()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Rotating during the permission question must not ask twice.
        if (savedInstanceState != null) return
        VoiceMemoRecordingService.restorePending(this)
        // No folder, a running recording or an unsaved memo: the notes screen already handles these.
        if (Storage.getVaultUri(this) == null || VoiceMemoRecordingService.recording.value || VoiceMemoRecordingService.pending.value != null) {
            openNotes()
        } else if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            record()
            openNotes()
        } else {
            askMicrophone.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    private fun record() {
        VoiceMemoRecorder(applicationContext).start().onFailure { err ->
            Toast.makeText(this, getString(R.string.record_start_failed, err.message ?: err.javaClass.simpleName), Toast.LENGTH_SHORT).show()
        }
    }

    /** The board with its stop button; REORDER_TO_FRONT leaves an open editor alive behind it. */
    private fun openNotes() {
        startActivity(Intent(this, NotesListActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
        finish()
    }
}

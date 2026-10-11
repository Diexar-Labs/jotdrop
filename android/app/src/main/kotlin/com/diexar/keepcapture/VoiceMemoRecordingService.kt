package com.diexar.keepcapture

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.content.getSystemService
import androidx.preference.PreferenceManager
import kotlinx.coroutines.flow.MutableStateFlow
import java.io.File

class VoiceMemoRecordingService : Service() {
    companion object {
        const val ACTION_START = "com.diexar.keepcapture.action.START_RECORDING"
        const val ACTION_STOP = "com.diexar.keepcapture.action.STOP_RECORDING"
        private const val CHANNEL_ID = "voice_memo_recording"
        private const val NOTIFICATION_ID = 1001
        private const val PENDING_FILE = "pending_voice_memo"
        private const val PENDING_DURATION = "pending_voice_memo_duration"
        internal val recording = MutableStateFlow(false)
        internal val pending = MutableStateFlow<VoiceMemoRecorder.RecordedMemo?>(null)
        internal val failure = VoiceMemoSave.failure
        internal var instance: VoiceMemoRecordingService? = null
            private set

        fun restorePending(context: Context) {
            if (pending.value != null) return
            val prefs = PreferenceManager.getDefaultSharedPreferences(context)
            val path = prefs.getString(PENDING_FILE, null) ?: return
            val file = File(path)
            if (file.parentFile?.canonicalFile != context.noBackupFilesDir.canonicalFile || !file.isFile) {
                clearPending(context)
                return
            }
            pending.value = VoiceMemoRecorder.RecordedMemo(file, prefs.getLong(PENDING_DURATION, 0))
        }

        fun clearPending(context: Context) {
            PreferenceManager.getDefaultSharedPreferences(context).edit()
                .remove(PENDING_FILE).remove(PENDING_DURATION).apply()
            pending.value = null
        }
    }

    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null
    private var startedAt = 0L
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        getSystemService<NotificationManager>()?.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.recording_notification_channel_name), NotificationManager.IMPORTANCE_LOW).apply {
                description = getString(R.string.recording_notification_channel_desc)
            },
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startRecording()
            ACTION_STOP -> stopRecording()
            else -> stopSelf()
        }
        // A killed microphone session cannot safely restart without user interaction.
        return START_NOT_STICKY
    }

    private fun startRecording() {
        if (recorder != null) return
        val openApp = PendingIntent.getActivity(this, 0,
            Intent(this, NotesListActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 0,
            Intent(this, VoiceMemoRecordingService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        try {
            val notification = NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(getString(R.string.recording_notification_title))
                .setContentIntent(openApp).setOngoing(true)
                .addAction(0, getString(R.string.action_stop_recording), stop).build()
            startForeground(NOTIFICATION_ID, notification)
            val file = File(noBackupFilesDir, "voicememo-${System.currentTimeMillis()}.m4a")
            outputFile = file
            val media = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(this) else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }
            recorder = media
            media.setAudioSource(MediaRecorder.AudioSource.MIC)
            media.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            media.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            media.setAudioEncodingBitRate(64_000)
            media.setAudioSamplingRate(44_100)
            media.setAudioChannels(1)
            media.setOutputFile(file.absolutePath)
            media.prepare()
            wakeLock = getSystemService<PowerManager>()?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "JotDrop:VoiceMemo")
                ?.apply { acquire() }
            media.start()
            startedAt = SystemClock.elapsedRealtime()
            recording.value = true
        } catch (e: Exception) {
            releaseRecorder()
            outputFile?.delete()
            outputFile = null
            recording.value = false
            failure.value = e.message ?: e.javaClass.simpleName
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    fun stopRecording(): Result<VoiceMemoRecorder.RecordedMemo> {
        val media = recorder ?: return Result.failure(IllegalStateException("Geen actieve opname."))
        val result = runCatching {
            val duration = SystemClock.elapsedRealtime() - startedAt
            media.stop()
            val file = checkNotNull(outputFile)
            check(file.length() > 0) { "Lege opname." }
            VoiceMemoRecorder.RecordedMemo(file, duration).also { memo ->
                // Retain a finalized recording until the vault save succeeds or the user discards it.
                pending.value = memo
                val saved = PreferenceManager.getDefaultSharedPreferences(this).edit()
                    .putString(PENDING_FILE, file.absolutePath).putLong(PENDING_DURATION, duration).commit()
                if (!saved) failure.value = "Opname nog niet duurzaam opgeslagen. Sla de voicememo op."
            }
        }
        releaseRecorder()
        outputFile = null
        recording.value = false
        result.onFailure { failure.value = it.message ?: it.javaClass.simpleName }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        return result
    }

    private fun releaseRecorder() {
        try { recorder?.release() } catch (_: Exception) { }
        recorder = null
        if (wakeLock?.isHeld == true) wakeLock?.release()
        wakeLock = null
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        if (recorder != null) stopRecording()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        if (recorder != null) stopRecording()
        releaseRecorder()
        recording.value = false
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}

package com.diexar.keepcapture

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.getSystemService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.launch

/**
 * BroadcastReceiver die door AlarmManager wordt gepingd op de reminder-tijd.
 * Bouwt de notificatie en laat ReminderEngine de reminder afhandelen (one-shot
 * wissen, of herhaling doorschuiven + herschedulen). Notificatie-kanaal wordt
 * hier lazy aangemaakt zodat we geen Application-class hoeven te onderhouden.
 */
class ReminderReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val noteUriString = intent.getStringExtra(EXTRA_NOTE_URI) ?: return
        val noteUri = Uri.parse(noteUriString)

        // goAsync() geeft tot 10s om de SAF-read/write af te ronden voordat de
        // receiver gekilled wordt.
        val pending = goAsync()
        val appContext = context.applicationContext
        @OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)
        GlobalScope.launch(Dispatchers.IO) {
            try {
                ReminderEngine.fireAndAdvance(appContext, noteUri)
            } catch (_: Throwable) {
                // Best-effort: als de write faalt blijft de reminder staan.
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_FIRE = "com.diexar.keepcapture.action.FIRE_REMINDER"
        const val EXTRA_NOTE_URI = "note_uri"
        const val CHANNEL_ID = "reminders"

        fun requestCodeFor(noteUri: String): Int = noteUri.hashCode()
        fun notificationIdFor(noteUri: String): Int = (noteUri.hashCode() and 0x7fffffff) or 1

        fun ensureChannel(context: Context) {
            val nm = context.getSystemService<NotificationManager>() ?: return
            if (nm.getNotificationChannel(CHANNEL_ID) != null) return
            val channel = NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.reminder_channel_name),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = context.getString(R.string.reminder_channel_desc)
            }
            nm.createNotificationChannel(channel)
        }
    }
}

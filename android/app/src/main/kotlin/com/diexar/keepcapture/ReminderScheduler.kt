package com.diexar.keepcapture

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.getSystemService
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/**
 * Plant/cancel't reminders via AlarmManager. Gebruikt `setAndAllowWhileIdle`
 * — niet exact, maar wel betrouwbaar door Doze heen (slop ~9min op verse
 * batterij; acceptabel voor reminders). Vermijdt `setExactAndAllowWhileIdle`
 * dat sinds Android 12 de `SCHEDULE_EXACT_ALARM`-permissie vereist die wij
 * niet aanvragen.
 */
object ReminderScheduler {

    fun schedule(context: Context, noteUri: Uri, reminderIso: String): Boolean {
        val whenMillis = parseToEpochMillis(reminderIso) ?: return false
        if (whenMillis <= System.currentTimeMillis()) return false

        val am = context.getSystemService<AlarmManager>() ?: return false
        val intent = buildIntent(context, noteUri)
        val pi = PendingIntent.getBroadcast(
            context,
            ReminderReceiver.requestCodeFor(noteUri.toString()),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return try {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, whenMillis, pi)
            true
        } catch (_: SecurityException) {
            false
        }
    }

    fun cancel(context: Context, noteUri: Uri) {
        val am = context.getSystemService<AlarmManager>() ?: return
        val intent = buildIntent(context, noteUri)
        val pi = PendingIntent.getBroadcast(
            context,
            ReminderReceiver.requestCodeFor(noteUri.toString()),
            intent,
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
        ) ?: return
        am.cancel(pi)
        pi.cancel()
    }

    /**
     * Plant alle reminders die in de vault staan opnieuw. Door BootReceiver
     * aangeroepen zodat reminders een reboot overleven (AlarmManager wist alle
     * alarms bij boot).
     */
    fun rescheduleAll(context: Context) {
        val notes = Storage.listNotes(context).getOrNull() ?: return
        val now = System.currentTimeMillis()
        for (note in notes) {
            val reminder = note.meta.reminder ?: continue
            val whenMillis = parseToEpochMillis(reminder) ?: continue
            if (whenMillis <= now) continue
            schedule(context, note.uri, reminder)
        }
    }

    private fun buildIntent(context: Context, noteUri: Uri): Intent {
        return Intent(context, ReminderReceiver::class.java).apply {
            action = ReminderReceiver.ACTION_FIRE
            putExtra(ReminderReceiver.EXTRA_NOTE_URI, noteUri.toString())
            // setData met note-URI maakt de Intent uniek per notitie zodat
            // PendingIntent.FLAG_UPDATE_CURRENT de juiste vervangt.
            data = noteUri
        }
    }

    /**
     * Parseert ISO-formaat zonder timezone (zoals `<input type="datetime-local">`
     * teruggeeft) als lokale tijd. Levert epoch-millis terug, of null bij
     * ongeldige input.
     */
    private fun parseToEpochMillis(iso: String): Long? {
        return try {
            val ldt = LocalDateTime.parse(iso, DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm"))
            ldt.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
        } catch (_: DateTimeParseException) {
            // Probeer met seconden-precisie als fallback
            try {
                val ldt = LocalDateTime.parse(iso)
                ldt.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
            } catch (_: DateTimeParseException) {
                null
            }
        }
    }
}

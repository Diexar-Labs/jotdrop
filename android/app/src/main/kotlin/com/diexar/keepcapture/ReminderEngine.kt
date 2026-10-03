package com.diexar.keepcapture

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.content.getSystemService
import kotlinx.coroutines.sync.withLock
import java.time.LocalDateTime

/**
 * Deelt de fire-afhandeling tussen ReminderReceiver (normale afgaande alarm)
 * en ReminderScheduler.rescheduleAll (overdue reminders na reboot/update).
 *
 * One-shot reminders worden na het afgaan gewist (bestaand gedrag); herhalende
 * reminders schuiven door en worden opnieuw gescheduled. Verloopt de reeks,
 * dan worden alle reminder-keys gewist — de notitie zelf wordt nooit
 * gearchiveerd of verwijderd.
 */
object ReminderEngine {

    /**
     * Vuurt één notificatie en schuift de reminder door. Leest eerst de notitie
     * om te verifiëren dat de reminder er nog staat (geen notificatie voor een
     * inmiddels gewiste/verwijderde reminder). De read-modify-write gebeurt
     * onder Storage.noteWriteMutex zodat een gelijktijdige editor-save niet
     * verloren gaat.
     */
    suspend fun fireAndAdvance(context: Context, noteUri: Uri) {
        ReminderReceiver.ensureChannel(context)
        val fired = Storage.noteWriteMutex.withLock {
            val fresh = Storage.readNote(context, noteUri).getOrNull() ?: return@withLock null
            val parsed = FrontmatterParser.parse(fresh)
            val now = LocalDateTime.now()
            val due = parsed.meta.reminder?.let(ReminderRecurrence::parseIso) ?: return@withLock null
            if (due.isAfter(now)) return@withLock null
            val expired = parsed.meta.reminderRepeat != null && ReminderRecurrence.isExpired(parsed.meta)
            val advanced = if (expired) {
                ReminderRecurrence.clear(parsed.meta)
            } else {
                ReminderRecurrence.advance(parsed.meta, now)
            }
            if (Storage.updateNote(context, noteUri, FrontmatterWriter.apply(fresh, advanced)).isFailure) {
                return@withLock null
            }
            if (expired) return@withLock null
            noteTitle(context, parsed.body) to advanced.reminder
        } ?: return
        notify(context, noteUri, fired.first)
        fired.second?.let { ReminderScheduler.schedule(context, noteUri, it) }
    }

    /** Wist de hele reminder-reeks (reminder + alle repeat-keys) zonder te vuren. */
    suspend fun expire(context: Context, noteUri: Uri) {
        Storage.noteWriteMutex.withLock {
            val current = Storage.readNote(context, noteUri).getOrNull() ?: return
            val parsed = FrontmatterParser.parse(current)
            if (parsed.meta.reminder == null) return
            val cleared = ReminderRecurrence.clear(parsed.meta)
            Storage.updateNote(context, noteUri, FrontmatterWriter.apply(current, cleared))
        }
    }

    private fun noteTitle(context: Context, body: String): String {
        return try {
            val wikiEmbed = Regex("^!\\[\\[[^\\]]+]]$")
            val mdImage = Regex("^!\\[[^\\]]*]\\([^)]+\\)$")
            val firstLine = body.lineSequence()
                .map { it.trim() }
                .filter { it.isNotEmpty() && !wikiEmbed.matches(it) && !mdImage.matches(it) }
                .firstOrNull().orEmpty()
            firstLine
                .replace(Regex("^- \\[[ xX]]\\s*"), "")
                .trimStart('#')
                .trim()
                .ifEmpty { context.getString(R.string.reminder_default_title) }
        } catch (_: Throwable) {
            context.getString(R.string.reminder_default_title)
        }
    }

    private fun notify(context: Context, noteUri: Uri, title: String) {
        val openIntent = EditorActivity.openNoteIntent(context, noteUri).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val tap = PendingIntent.getActivity(
            context, ReminderReceiver.requestCodeFor(noteUri.toString()), openIntent, pendingFlags,
        )

        val notification = NotificationCompat.Builder(context, ReminderReceiver.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.reminder_notification_title))
            .setContentText(title)
            .setStyle(NotificationCompat.BigTextStyle().bigText(title))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()

        val nm = context.getSystemService<NotificationManager>() ?: return
        try {
            nm.notify(ReminderReceiver.notificationIdFor(noteUri.toString()), notification)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS niet verleend op Android 13+.
        }
    }
}

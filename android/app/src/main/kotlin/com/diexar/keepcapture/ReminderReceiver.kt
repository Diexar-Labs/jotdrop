package com.diexar.keepcapture

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.content.getSystemService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.launch

/**
 * BroadcastReceiver die door AlarmManager wordt gepingd op de reminder-tijd.
 * Bouwt een notificatie met titel uit het notitie-bestand; tap → opent de
 * notitie in EditorActivity. Notificatie-kanaal wordt hier lazy aangemaakt
 * zodat we geen Application-class hoeven te onderhouden.
 */
class ReminderReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val noteUriString = intent.getStringExtra(EXTRA_NOTE_URI) ?: return
        val noteUri = Uri.parse(noteUriString)

        ensureChannel(context)

        // Titel ophalen uit de notitie zelf — als 'ie inmiddels weg is, fall
        // back op generieke string zodat de notificatie nog steeds verschijnt.
        // Embed-regels (`![[…]]` of `![](…)`) overslaan, anders zou een
        // afbeelding-only top van de notitie als notificatie-tekst belanden.
        val title = try {
            val raw = Storage.readNote(context, noteUri).getOrNull().orEmpty()
            val body = FrontmatterParser.parse(raw).body
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

        val openIntent = EditorActivity.openNoteIntent(context, noteUri).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val tap = PendingIntent.getActivity(context, requestCodeFor(noteUriString), openIntent, pendingFlags)

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
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
            nm.notify(notificationIdFor(noteUriString), notification)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS niet verleend op Android 13+; gebruiker moet
            // permissie eerst toekennen. Stilletjes negeren.
        }

        // One-shot consumption: reminder uit frontmatter strippen zodat 'ie
        // niet als "dode" entry blijft staan na firing. goAsync() geeft tot
        // 10s om de SAF-write af te ronden voor de receiver gekilled wordt.
        val pending = goAsync()
        val appContext = context.applicationContext
        @OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)
        GlobalScope.launch(Dispatchers.IO) {
            try {
                val current = Storage.readNote(appContext, noteUri).getOrNull() ?: return@launch
                val parsed = FrontmatterParser.parse(current)
                if (parsed.meta.reminder == null) return@launch
                val cleared = parsed.meta.copy(reminder = null)
                val newContent = FrontmatterWriter.apply(current, cleared)
                Storage.updateNote(appContext, noteUri, newContent)
            } catch (_: Throwable) {
                // Best-effort: als de write faalt blijft de reminder in
                // frontmatter staan; geen crash.
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

package com.diexar.keepcapture

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.launch

/**
 * Herschedult alle openstaande reminders na een reboot. AlarmManager wist
 * z'n eigen alarmen bij boot; zonder deze receiver zouden alle reminders
 * stilletjes verdwijnen.
 *
 * Werkt ook na een app-update (ACTION_MY_PACKAGE_REPLACED) — zelfde reden.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED &&
            action != "android.intent.action.QUICKBOOT_POWERON") return

        val pending = goAsync()
        @OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)
        GlobalScope.launch(Dispatchers.IO) {
            try {
                ReminderScheduler.rescheduleAll(context.applicationContext)
            } finally {
                pending.finish()
            }
        }
    }
}

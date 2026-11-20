package com.diexar.keepcapture

import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Info
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.time.Instant
import java.util.Date

private const val HOLD_PREFS = "jotdrop-sync-hold"
private const val NOTICE_SKIPPED = "noticeSkipped"

/**
 * The line on the board about sync on hold (Hand-off/ontwerp-sync-pauzeren-boven-free.md, deel 8): before the pause on
 * every device, and once it has started on this phone if it is not one of the chosen ones. One line that stays while
 * it lasts, a sign and words (never colour alone), and JotDrop Plus in words only: no price and no link (Google Play).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun SyncHoldLine() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val changes by CloudSyncManager.changes.collectAsState()
    var plan by remember { mutableStateOf<CloudSyncPlan?>(null) }
    var skipped by remember { mutableStateOf(context.getSharedPreferences(HOLD_PREFS, Context.MODE_PRIVATE).getString(NOTICE_SKIPPED, null)) }
    var checking by remember { mutableStateOf(false) }
    LaunchedEffect(changes) { plan = withContext(Dispatchers.IO) { runCatching { CloudSyncManager.syncPlan(context) }.getOrNull() } }
    val shown = plan ?: return
    val now = System.currentTimeMillis()
    val held = CloudSyncHold.onHold(shown)
    if (!held && !CloudSyncHold.noticeShown(shown, skipped, now)) return
    fun devices(here: Boolean) = context.startActivity(Intent(context, CloudActivity::class.java)
        .putExtra(CloudActivity.EXTRA_DEVICES, if (here) CloudActivity.DEVICES_HERE else CloudActivity.DEVICES_LIST))
    val text = if (held) {
        stringResource(R.string.sync_hold_text) + (CloudSyncHold.waitUntil(shown, now)?.let { " " + stringResource(R.string.sync_hold_wait, dateTime(it)) } ?: "")
    } else {
        val names = shown.goingOnHold.map { device ->
            if (device.here) stringResource(R.string.sync_this_phone) else appName(device.app)?.let { stringResource(R.string.sync_device_app, device.name, stringResource(it)) } ?: device.name
        }
        stringResource(R.string.sync_ending_text, shown.limit ?: 2, day(shown.pauseAt), names.joinToString(", ").ifEmpty { stringResource(R.string.sync_ending_some) })
    }
    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer,
        contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        Column(Modifier.padding(start = 12.dp, top = 10.dp, end = 8.dp, bottom = 4.dp)) {
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(if (held) Icons.Filled.CloudOff else Icons.Filled.Info, contentDescription = null)
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(text, style = MaterialTheme.typography.bodyMedium)
                    Text(stringResource(R.string.sync_hold_plus), style = MaterialTheme.typography.bodySmall)
                }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(start = 24.dp)) {
                if (held) {
                    if (CloudSyncHold.waitUntil(shown, now) == null) TextButton(onClick = { devices(true) }) { Text(stringResource(R.string.sync_hold_here)) }
                    TextButton(onClick = { devices(false) }) { Text(stringResource(R.string.sync_hold_devices)) }
                    TextButton(enabled = !checking, onClick = {
                        checking = true
                        scope.launch {
                            try { CloudSyncManager.sync(context, check = true) }
                            catch (error: CancellationException) { throw error }
                            catch (error: Exception) { Toast.makeText(context, context.getString(R.string.toast_error, error.message ?: error.javaClass.simpleName), Toast.LENGTH_LONG).show() }
                            finally { checking = false }
                        }
                    }) { Text(stringResource(R.string.sync_hold_check)) }
                } else {
                    TextButton(onClick = { devices(false) }) { Text(stringResource(R.string.sync_ending_choose)) }
                    TextButton(onClick = {
                        skipped = shown.pauseAt
                        context.getSharedPreferences(HOLD_PREFS, Context.MODE_PRIVATE).edit().putString(NOTICE_SKIPPED, shown.pauseAt).apply()
                    }) { Text(stringResource(R.string.sync_ending_later)) }
                }
            }
        }
    }
}

private fun appName(app: String?): Int? = when (app) {
    "android" -> R.string.sync_app_android
    "web" -> R.string.sync_app_web
    "obsidian" -> R.string.sync_app_obsidian
    "joplin" -> R.string.sync_app_joplin
    "clipper" -> R.string.sync_app_clipper
    "mcp" -> R.string.sync_app_mcp
    else -> null
}

private fun day(at: String?): String = at?.let { runCatching { DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date.from(Instant.parse(it))) }.getOrNull() } ?: ""
private fun dateTime(at: Instant): String = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date.from(at))

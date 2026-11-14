package com.diexar.keepcapture

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** "A key from another device is ready: …" or, for a newer key of another service, "Your other devices now use …". */
internal fun aiOfferText(context: Context, look: AiKeyCloud.Look): String? {
    val config = look.offered ?: return null
    return context.getString(if (look.switched) R.string.ai_sync_offer_switched else R.string.ai_sync_offer, AiKeyCloud.label(context, config))
}

/**
 * The settings block for "Use this key on all my devices" (JotDrop Plus, named in words only: no price, no link).
 * It acts on the saved settings, like the web app; [onSaved] gets the settings after each step.
 */
@Composable
internal fun AiKeySyncBlock(saved: AiSettings, connected: Boolean, seen: AiKeyCloud.Look?, onLook: (AiKeyCloud.Look?) -> Unit,
    onSaved: (AiSettings) -> Unit, say: (String, Boolean) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var other by remember { mutableStateOf<SharedAiKey?>(null) }
    var stopping by remember { mutableStateOf(false) }
    // What the server said, against the settings saved now (a key saved since then turns "offer" into "available").
    val look = seen?.let { AiKeyCloud.Look(it.remote, saved, null) }
    val action = look?.action

    fun use() {
        busy = true
        scope.launch {
            try {
                val next = AiKeyCloud.use(context)
                onSaved(next)
                onLook(AiKeyCloud.ownLook(next))
                say(context.getString(R.string.ai_sync_used, AiKeyCloud.label(context, SharedAiKey(next.provider, next.key, next.model, next.baseUrl))), false)
            } catch (error: CancellationException) { throw error }
            catch (error: AiKeyCloud.Refused) { say(AiKeyCloud.reasonText(context, error), true) }
            catch (_: Exception) { say(context.getString(R.string.ai_sync_unreachable), true) }
            finally { busy = false }
        }
    }

    fun turnOn() {
        busy = true
        scope.launch {
            try {
                val next = AiKeyCloud.turnOn(context, saved)
                onSaved(next)
                onLook(AiKeyCloud.ownLook(next))
                say(context.getString(R.string.ai_sync_turned_on), false)
            } catch (error: CancellationException) { throw error }
            catch (error: AiKeyCloud.Refused) {
                error.remote?.let { remote -> onLook(AiKeyCloud.Look(remote, saved, null)) }
                // The other devices already share another key: take theirs or keep this one, never replace it without a word.
                if (error.reason == "other") other = error.remote?.config else say(AiKeyCloud.reasonText(context, error), true)
            } catch (_: Exception) { say(context.getString(R.string.ai_sync_unreachable), true) }
            finally { busy = false }
        }
    }

    fun turnOff() {
        busy = true
        scope.launch {
            try {
                onSaved(AiKeyCloud.turnOff(context, saved))
                look?.let { onLook(AiKeyCloud.Look(AiKeyRemote(AiKeyRemote.NONE), saved.copy(synced = 0), null)) }
                say(context.getString(R.string.ai_sync_stopped), false)
            } catch (error: CancellationException) { throw error }
            catch (error: AiKeyCloud.Refused) { say(AiKeyCloud.reasonText(context, error), true) }
            catch (_: Exception) { say(context.getString(R.string.ai_sync_unreachable), true) }
            finally { busy = false }
        }
    }

    look?.let { aiOfferText(context, it) }?.let { offer ->
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(offer)
                Button(enabled = !busy, onClick = { use() }) { Text(stringResource(R.string.ai_sync_use)) }
            }
        }
    }

    // Only a saved key of an AI service can go to other devices.
    val on = saved.synced > 0
    val enabled = connected && !busy && (on || (saved.on && saved.key.isNotEmpty()))
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()
        .toggleable(value = on, enabled = enabled, role = Role.Switch) { if (it) turnOn() else stopping = true }) {
        Text(stringResource(R.string.ai_sync_switch), Modifier.weight(1f))
        Switch(on, onCheckedChange = null, enabled = enabled)
    }
    Text(stringResource(R.string.ai_sync_note), style = MaterialTheme.typography.bodySmall)
    val status = when {
        !connected -> stringResource(R.string.ai_sync_needs_cloud)
        on -> stringResource(if (action == "waiting") R.string.ai_sync_waiting else R.string.ai_sync_on)
        action == "available" -> look?.remote?.config?.let { stringResource(R.string.ai_sync_available, AiKeyCloud.label(context, it)) }
        else -> null
    }
    status?.let { Text(it, style = MaterialTheme.typography.bodySmall) }

    other?.let { theirs ->
        AlertDialog(
            onDismissRequest = { other = null },
            title = { Text(stringResource(R.string.ai_sync_other_title)) },
            text = { Text(stringResource(R.string.ai_sync_other_text, AiKeyCloud.label(context, theirs))) },
            confirmButton = { TextButton(onClick = { other = null; use() }) { Text(stringResource(R.string.ai_sync_use_theirs)) } },
            dismissButton = { TextButton(onClick = { other = null }) { Text(stringResource(R.string.ai_sync_keep_mine)) } },
        )
    }
    if (stopping) AlertDialog(
        onDismissRequest = { stopping = false },
        title = { Text(stringResource(R.string.ai_sync_stop_title)) },
        text = { Text(stringResource(R.string.ai_sync_stop_text)) },
        confirmButton = { TextButton(onClick = { stopping = false; turnOff() }) { Text(stringResource(R.string.ai_sync_stop)) } },
        dismissButton = { TextButton(onClick = { stopping = false }) { Text(stringResource(R.string.ai_sync_cancel)) } },
    )
}

/** "Turn off and remove key" on a phone that follows the shared key: the user says where it goes. */
@Composable
internal fun AiRemoveChoiceDialog(onAll: () -> Unit, onHere: () -> Unit, onCancel: () -> Unit) {
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text(stringResource(R.string.ai_remove_where_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.ai_remove_where_text))
                OutlinedButton(onClick = onAll, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.ai_remove_all)) }
                OutlinedButton(onClick = onHere, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.ai_remove_here)) }
            }
        },
        confirmButton = { TextButton(onClick = onCancel) { Text(stringResource(R.string.ai_sync_cancel)) } },
    )
}

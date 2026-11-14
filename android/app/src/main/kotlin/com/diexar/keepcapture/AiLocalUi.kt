package com.diexar.keepcapture

import android.content.Context
import android.text.format.Formatter
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale

private fun size(context: Context, bytes: Long) = Formatter.formatShortFileSize(context, bytes)

/** The words for a failed download. */
private fun downloadError(context: Context, code: String?) = context.getString(when (code) {
    "model_space" -> R.string.ai_error_model_space
    "model_hash" -> R.string.ai_error_model_hash
    "network" -> R.string.ai_local_failed_network
    else -> R.string.ai_local_failed_server
})

/**
 * Settings for "On this phone (no key)": which model, its download (with the size, Wi-Fi advice, carrying on and a
 * check of the hash), removing it, and "Try it", which loads the model and lets it write one sentence. [model] is
 * the chosen model's id; [clear] takes away an earlier message. The screen stays on while a download runs here.
 */
@Composable
internal fun AiLocalBlock(model: String, onModel: (String) -> Unit, say: (String, Boolean) -> Unit, clear: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val memory = remember { AiLocal.totalMemory(context) }
    val recommended = remember { AiLocalModels.default(memory) }
    val chosen = AiLocalModels.byId(model) ?: recommended
    val download by AiLocal.download.collectAsState()
    // Bumped after a download or a removal, so the file is looked at again.
    var looked by remember { mutableIntStateOf(0) }
    val ready = remember(chosen, looked, download.phase) { AiLocal.ready(context, chosen) != null }
    val partial = remember(chosen, looked, download.phase) { AiModelDownload.partial(AiLocal.dir(context), chosen) }
    val mine = download.model == chosen.id
    val running = mine && download.phase in setOf("running", "checking")
    var trying by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }

    val view = LocalView.current
    DisposableEffect(running) {
        view.keepScreenOn = running
        onDispose { view.keepScreenOn = false }
    }

    var licences by remember { mutableStateOf(false) }
    if (licences) AiLocalLicences { licences = false }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.ai_local_intro), style = MaterialTheme.typography.bodySmall)
        // Apache 2.0 asks for the licence and the notices of what the app carries along (LiteRT-LM); Gemma's is the same licence.
        Text(stringResource(R.string.ai_local_credit), style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = { licences = true }) { Text(stringResource(R.string.ai_local_licences)) }
        if (!AiLocal.supported) {
            Text(stringResource(R.string.ai_local_unsupported), color = MaterialTheme.colorScheme.error)
            return@Column
        }
        if (AiLocalModels.tooLittleMemory(memory)) Text(stringResource(R.string.ai_local_low_memory), color = MaterialTheme.colorScheme.error)
        Text(stringResource(R.string.ai_local_model), style = MaterialTheme.typography.titleSmall)
        for (option in AiLocalModels.ALL) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().selectable(selected = option == chosen, enabled = !running && !trying, role = Role.RadioButton) { onModel(option.id) }) {
                RadioButton(selected = option == chosen, onClick = null, enabled = !running && !trying)
                Text(stringResource(R.string.ai_local_option, option.name, size(context, option.bytes)) +
                    if (option == recommended) " · " + stringResource(R.string.ai_local_recommended) else "", Modifier.padding(start = 8.dp))
            }
        }

        when {
            ready -> Text(stringResource(R.string.ai_local_ready, chosen.name))
            running && download.phase == "checking" -> Text(stringResource(R.string.ai_local_checking))
            running -> Text(stringResource(R.string.ai_local_progress, size(context, download.done), size(context, download.total),
                if (download.total > 0) (download.done * 100 / download.total).toInt() else 0))
            mine && download.phase == "failed" -> Text(stringResource(R.string.ai_problem, downloadError(context, download.error)), color = MaterialTheme.colorScheme.error)
            partial > 0 -> Text(stringResource(R.string.ai_local_paused, size(context, partial), size(context, chosen.bytes)))
            else -> Text(stringResource(R.string.ai_local_wifi, size(context, chosen.bytes)), style = MaterialTheme.typography.bodySmall)
        }
        if (running) {
            if (download.phase == "checking" || download.total <= 0) LinearProgressIndicator(Modifier.fillMaxWidth())
            else LinearProgressIndicator(progress = { download.done.toFloat() / download.total }, modifier = Modifier.fillMaxWidth())
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            when {
                running -> OutlinedButton(onClick = { AiLocal.stop() }, enabled = download.phase == "running") { Text(stringResource(R.string.ai_local_stop)) }
                !ready -> Button(onClick = { clear(); AiLocal.start(context, chosen) }) {
                    Text(stringResource(if (partial > 0) R.string.ai_local_continue else R.string.ai_local_download))
                }
                else -> {
                    OutlinedButton(enabled = !trying, onClick = {
                        trying = true
                        say(context.getString(R.string.ai_local_trying), false)
                        scope.launch {
                            val started = System.currentTimeMillis()
                            try {
                                val provider = AiLocal.provider(context, AiSettings(AiLocalModels.PHONE, model = chosen.id)) { loading = it }
                                val answer = provider.complete("Answer in one short sentence, in ${Locale.getDefault().getDisplayLanguage(Locale.ENGLISH)}.",
                                    listOf(AiMessage.User("Say that the AI on this phone works.")), emptyList(), AiAssistant.FILE_TIMEOUT_MS)
                                val where = context.getString(if (AiLocal.engine(context).backend == "gpu") R.string.ai_local_gpu else R.string.ai_local_cpu)
                                val seconds = ((System.currentTimeMillis() - started + 500) / 1000).toInt()
                                say(context.getString(R.string.ai_local_tried, where, seconds, answer.text.ifBlank { context.getString(R.string.ai_no_answer) }), false)
                            } catch (error: CancellationException) { throw error }
                            catch (error: AiError) { say(aiErrorText(context, error.code), true) }
                            finally { trying = false; loading = false }
                        }
                    }) { Text(stringResource(R.string.ai_local_try)) }
                    OutlinedButton(enabled = !trying, onClick = {
                        scope.launch {
                            AiLocal.delete(context, chosen)
                            looked++
                            say(context.getString(R.string.ai_local_removed), false)
                        }
                    }) { Text(stringResource(R.string.ai_local_delete)) }
                }
            }
            if (!running && !ready && partial > 0) OutlinedButton(onClick = {
                scope.launch { AiLocal.delete(context, chosen); looked++ }
            }) { Text(stringResource(R.string.ai_local_delete)) }
        }
        if (trying) {
            if (loading) Text(stringResource(R.string.ai_local_loading), style = MaterialTheme.typography.bodySmall)
            LinearProgressIndicator(Modifier.fillMaxWidth())
        }
    }
}

/** LiteRT-LM's licence and its notices for the libraries inside it, as it ships them (about 42,000 lines), line by line. */
@Composable
private fun AiLocalLicences(onClose: () -> Unit) {
    val context = LocalContext.current
    var lines by remember { mutableStateOf<List<String>?>(null) }
    LaunchedEffect(Unit) {
        lines = withContext(Dispatchers.IO) {
            listOf("licenses/litertlm-LICENSE.txt", "licenses/litertlm-THIRD_PARTY_NOTICE.txt").flatMap { name ->
                context.assets.open(name).bufferedReader().use { it.readLines() } + ""
            }
        }
    }
    AlertDialog(onDismissRequest = onClose, title = { Text(stringResource(R.string.ai_local_licences)) },
        text = {
            val shown = lines
            if (shown == null) LinearProgressIndicator(Modifier.fillMaxWidth())
            else LazyColumn(Modifier.heightIn(max = 480.dp)) { items(shown) { Text(it, style = MaterialTheme.typography.bodySmall) } }
        },
        confirmButton = { TextButton(onClick = onClose) { Text(stringResource(R.string.ai_local_close)) } })
}

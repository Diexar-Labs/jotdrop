package com.diexar.keepcapture

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.speech.RecognizerIntent
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.diexar.keepcapture.ui.JotDropTheme
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** The words for an AiError code, for the user. Never the service's own text with a key in it. */
internal fun aiErrorText(context: Context, code: String?): String = context.getString(when (code) {
    "no_provider" -> R.string.ai_error_no_provider
    "no_key" -> R.string.ai_error_no_key
    "no_model" -> R.string.ai_error_no_model
    "bad_address" -> R.string.ai_error_bad_address
    "auth" -> R.string.ai_error_auth
    "quota" -> R.string.ai_error_quota
    "rate" -> R.string.ai_error_rate
    "model" -> R.string.ai_error_model
    "server" -> R.string.ai_error_server
    "network" -> R.string.ai_error_network
    "timeout" -> R.string.ai_error_timeout
    "bad_response" -> R.string.ai_error_bad_response
    else -> R.string.ai_error_bad_request
})

internal fun aiProviderName(context: Context, id: String): String =
    if (id == "custom") context.getString(R.string.ai_provider_custom) else AiProviders.SPECS[id]?.name ?: id

/**
 * Ask JotDrop: say or type what JotDrop should do; the AI service the user chose answers straight from this phone.
 * From a card's menu it asks about that note, or summarizes only that note.
 * From the editor it works on the draft only: nothing else goes along, nothing is changed,
 * and the answer goes back to the editor to replace the text or follow it.
 */
class AskActivity : ThemedComponentActivity() {
    companion object {
        const val EXTRA_NOTE = "ai_note"
        const val EXTRA_SUMMARIZE = "ai_summarize"
        private const val EXTRA_KIND = "ai_kind"
        private const val EXTRA_TITLE = "ai_draft_title"
        private const val EXTRA_TEXT = "ai_draft_text"
        const val RESULT_TEXT = "ai_result_text"
        const val RESULT_REPLACE = "ai_result_replace"
        fun intent(context: Context, note: Uri? = null, summarize: Boolean = false): Intent =
            Intent(context, AskActivity::class.java).putExtra(EXTRA_NOTE, note?.toString()).putExtra(EXTRA_SUMMARIZE, summarize)
        /** kind is "rewrite", "checklist" or "summarize". */
        fun draftIntent(context: Context, kind: String, title: String, text: String): Intent =
            Intent(context, AskActivity::class.java).putExtra(EXTRA_KIND, kind).putExtra(EXTRA_TITLE, title).putExtra(EXTRA_TEXT, text)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val note = intent.getStringExtra(EXTRA_NOTE)?.let(Uri::parse)
        val summarize = intent.getBooleanExtra(EXTRA_SUMMARIZE, false)
        val kind = intent.getStringExtra(EXTRA_KIND)
        val draft = kind?.let { AiNote("draft", intent.getStringExtra(EXTRA_TITLE).orEmpty(), intent.getStringExtra(EXTRA_TEXT).orEmpty()) }
        setContent {
            JotDropTheme {
                AskScreen(note, summarize, draft, kind, onClose = { finish() }, onDraftAnswer = { answer, replace ->
                    setResult(RESULT_OK, Intent().putExtra(RESULT_TEXT, answer).putExtra(RESULT_REPLACE, replace))
                    finish()
                })
            }
        }
    }
}

private class Pending(val change: AiChange, val answer: CompletableDeferred<Boolean>)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AskScreen(target: Uri?, summarize: Boolean, draft: AiNote?, kind: String?, onClose: () -> Unit, onDraftAnswer: (String, Boolean) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var settings by remember { mutableStateOf(AiSecretStore(context).load()) }
    val executor = remember { AiExecutor(context) { uri -> context.startActivity(EditorActivity.openNoteIntent(context, uri)) } }
    var loaded by remember { mutableStateOf(false) }
    var request by remember { mutableStateOf("") }
    var excluded by remember { mutableStateOf(setOf<String>()) }
    var goesOpen by remember { mutableStateOf(false) }
    var job by remember { mutableStateOf<Job?>(null) }
    var pending by remember { mutableStateOf<Pending?>(null) }
    var report by remember { mutableStateOf<AiReport?>(null) }
    var asked by remember { mutableStateOf("") }
    var savedNote by remember { mutableStateOf(false) }
    var addedBelow by remember { mutableStateOf(false) }
    var stopped by remember { mutableStateOf(false) }
    val pinnedId = remember(loaded) { target?.let { uri -> executor.notes.firstOrNull { executor.uriOf(it.id) == uri }?.id } }
    val provider = aiProviderName(context, settings.provider)
    val model = settings.model.ifEmpty { AiProviders.SPECS[settings.provider]?.defaultModel.orEmpty() }

    // A fixed request (card summary or editor button) cannot be edited or dictated, and has no list of notes to untick.
    val fixed = summarize || draft != null

    // Only the notes the user leaves in can go along or be searched; a summary takes only its own note, an editor button only the draft.
    fun usable(): List<AiNote> = when {
        draft != null -> listOf(draft)
        summarize -> executor.notes.filter { it.id == pinnedId }
        else -> executor.notes.filter { it.id !in excluded }
    }

    fun send() {
        val text = request.trim()
        if (text.isEmpty() || job != null) return
        asked = text
        report = null
        savedNote = false
        addedBelow = false
        stopped = false
        job = scope.launch {
            val (tools, prompt) = withContext(Dispatchers.IO) { AiAssets.get(context) }
            val day = SimpleDateFormat("yyyy-MM-dd EEEE", Locale.US).format(Date())
            val system = AiPrompt.system(prompt, Locale.getDefault().getDisplayLanguage(Locale.ENGLISH), day, TimeZone.getDefault().id, executor.labels)
            try {
                report = AiAssistant.run(
                    request = text,
                    notes = usable(),
                    labels = executor.labels,
                    tools = tools,
                    system = system,
                    provider = { AiProviders.create(settings.config(), AiHttp) },
                    // The draft is not saved yet, so the AI changes nothing: the answer waits for Replace or Add below.
                    executor = if (draft != null) emptyMap() else executor.tools,
                    confirm = if (draft != null) { _ -> false } else { change -> val answer = CompletableDeferred<Boolean>(); pending = Pending(change, answer); answer.await().also { pending = null } },
                    pinned = if (draft != null) listOf(draft.id) else listOfNotNull(pinnedId),
                    includeShared = settings.includeShared,
                    secrets = listOf(settings.key),
                )
            } catch (error: CancellationException) {
                stopped = true
                throw error
            } finally { job = null; pending = null }
        }
    }

    LaunchedEffect(Unit) {
        if (!settings.on) return@LaunchedEffect
        if (draft != null && kind != null) {
            loaded = true
            request = AiNoteEdits.editorRequest(kind, draft.title)
            send()
            return@LaunchedEffect
        }
        val started = SystemClock.elapsedRealtime()
        withContext(Dispatchers.IO) { executor.load() }
        // Only a count and a time, never note content: to see how long a big vault takes to read.
        Log.i("AskJotDrop", "Read ${executor.notes.size} notes in ${SystemClock.elapsedRealtime() - started} ms")
        loaded = true
        if (summarize) {
            val title = executor.notes.firstOrNull { executor.uriOf(it.id) == target }?.title
            if (title != null) { request = AiNoteEdits.editorRequest("summarize", title); send() }
        }
    }

    val speech = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
        val heard = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.trim().orEmpty()
        if (heard.isNotEmpty()) request = if (request.isBlank()) heard else "${request.trimEnd()} $heard"
    }
    fun dictate() {
        val lang = Storage.getSpeechLanguage(context)
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang)
            .putExtra(RecognizerIntent.EXTRA_PROMPT, context.getString(R.string.ai_hint_short))
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        try { speech.launch(intent) } catch (_: Exception) { Toast.makeText(context, R.string.speech_unavailable, Toast.LENGTH_SHORT).show() }
    }

    Scaffold(topBar = {
        TopAppBar(title = { Text(stringResource(R.string.ai_title)) },
            navigationIcon = { IconButton(onClick = { job?.cancel(); onClose() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.ai_back)) } })
    }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding).imePadding(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (!settings.on) {
                item {
                    Text(stringResource(R.string.ai_off))
                    Button(onClick = { context.startActivity(Intent(context, AiSettingsActivity::class.java)); onClose() }, Modifier.padding(top = 12.dp)) { Text(stringResource(R.string.ai_open_settings)) }
                }
                return@LazyColumn
            }
            item {
                OutlinedTextField(
                    value = request, onValueChange = { request = it }, readOnly = fixed || job != null,
                    label = { Text(stringResource(R.string.ai_hint_short)) }, placeholder = { Text(stringResource(R.string.ai_hint)) },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp),
                )
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (job == null) {
                        if (!fixed) OutlinedButton(onClick = { dictate() }) { Icon(Icons.Filled.Mic, contentDescription = null); Text(" " + stringResource(R.string.ai_dictate)) }
                        Button(onClick = { send() }, enabled = loaded && request.isNotBlank()) { Text(stringResource(R.string.ai_send)) }
                    } else {
                        OutlinedButton(onClick = { job?.cancel() }) { Text(stringResource(R.string.ai_stop)) }
                    }
                }
                Text(stringResource(R.string.ai_goes_to, provider, model.ifEmpty { "?" }), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
            }
            if (!loaded) item {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text(stringResource(R.string.ai_reading_notes), style = MaterialTheme.typography.bodySmall)
            } else if (!fixed && job == null && report == null) {
                val goes = AiContext.selectNotes(executor.notes.filter { it.id !in excluded }, request, includeShared = settings.includeShared, pinned = listOfNotNull(pinnedId)).notes
                val shown = (goes.map { it.id } + excluded).distinct().mapNotNull { id -> executor.notes.firstOrNull { it.id == id } }
                item {
                    Text(
                        (if (goesOpen) "▾ " else "▸ ") + stringResource(R.string.ai_what_goes, goes.size),
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.fillMaxWidth().clickable(role = Role.Button) { goesOpen = !goesOpen }.padding(vertical = 8.dp),
                    )
                    if (goesOpen) Text(stringResource(R.string.ai_what_goes_help), style = MaterialTheme.typography.bodySmall)
                }
                if (goesOpen) items(shown, key = { it.id }) { note ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable(role = Role.Checkbox) {
                        excluded = if (note.id in excluded) excluded - note.id else excluded + note.id
                    }) {
                        Checkbox(checked = note.id !in excluded, onCheckedChange = null)
                        Text(note.title.ifBlank { stringResource(R.string.ai_untitled) }, Modifier.padding(start = 8.dp))
                    }
                }
            }
            if (job != null) item {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text(stringResource(R.string.ai_working, provider), style = MaterialTheme.typography.bodySmall)
            }
            if (stopped) item { Text(stringResource(R.string.ai_stopped)) }
            report?.let { done -> item { AiResult(done, asked, provider, model, executor, target, summarize, kind.takeIf { draft != null }, savedNote, addedBelow, onSaved = { savedNote = true }, onAddedBelow = { addedBelow = true }, onDraft = { replace -> onDraftAnswer(done.answer, replace) }) } }
        }
    }

    pending?.let { waiting -> AiConfirmDialog(waiting.change, onAnswer = { waiting.answer.complete(it) }) }
}

@Composable
private fun AiResult(
    report: AiReport, asked: String, provider: String, model: String, executor: AiExecutor, target: Uri?, summarize: Boolean,
    draftKind: String?, savedNote: Boolean, addedBelow: Boolean, onSaved: () -> Unit, onAddedBelow: () -> Unit, onDraft: (Boolean) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        when (report.stop) {
            "error", "off", "timeout" -> Text(stringResource(R.string.ai_problem, aiErrorText(context, report.error?.code)), color = MaterialTheme.colorScheme.error)
            "max_rounds" -> Text(stringResource(R.string.ai_problem, stringResource(R.string.ai_stop_max_rounds)), color = MaterialTheme.colorScheme.error)
            "refusal" -> Text(stringResource(R.string.ai_stop_refusal))
        }
        if (report.answer.isNotBlank()) Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.ai_answer_label, provider, model), style = MaterialTheme.typography.labelMedium)
                Text(report.answer)
            }
        }
        // The draft is already open in the editor, so it gets no source button.
        if (draftKind == null && report.sources.isNotEmpty()) {
            Text(stringResource(R.string.ai_sources), style = MaterialTheme.typography.titleSmall)
            for (source in report.sources) OutlinedButton(onClick = { executor.uriOf(source.id)?.let { context.startActivity(EditorActivity.openNoteIntent(context, it)) } }) { Text(source.title) }
        }
        if (report.actions.any { it.tool !in setOf("search_notes", "read_note") }) {
            Text(stringResource(R.string.ai_actions), style = MaterialTheme.typography.titleSmall)
            for (action in report.actions.filter { it.tool !in setOf("search_notes", "read_note") }) {
                val status = stringResource(when (action.status) { "done" -> R.string.ai_action_done; "declined" -> R.string.ai_action_declined; "refused" -> R.string.ai_action_refused; else -> R.string.ai_action_failed })
                Text("$status: ${aiToolText(context, action)}")
            }
        }
        val names = report.sent.map { it.title.ifBlank { context.getString(R.string.ai_untitled) } }
        Text(if (names.isEmpty()) stringResource(R.string.ai_sent_none, provider) else stringResource(R.string.ai_sent_notes, provider, names.joinToString(", ")), style = MaterialTheme.typography.bodySmall)
        if (report.rounds > 0) Text(stringResource(R.string.ai_tokens, report.input, report.output), style = MaterialTheme.typography.bodySmall)
        // Back in the editor the answer is part of the draft; it is saved like any edit.
        if (draftKind != null && report.answer.isNotBlank()) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (draftKind != "summarize") Button(onClick = { onDraft(true) }) { Text(stringResource(R.string.ai_replace_text)) }
            OutlinedButton(onClick = { onDraft(false) }) { Text(stringResource(R.string.ai_add_below)) }
        }
        if (report.answer.isNotBlank()) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (draftKind != null) Unit
            else if (summarize && target != null) OutlinedButton(enabled = !addedBelow, onClick = {
                scope.launch {
                    val ok = runCatching { Storage.noteWriteMutex.withLock { withContext(Dispatchers.IO) { Storage.updateNote(context, target, AiNoteEdits.appendedText(Storage.readNote(context, target).getOrThrow(), report.answer, null)).getOrThrow() } } }.isSuccess
                    if (ok) onAddedBelow() else Toast.makeText(context, R.string.ai_error_save, Toast.LENGTH_SHORT).show()
                }
            }) { Text(stringResource(if (addedBelow) R.string.ai_added_below else R.string.ai_add_below)) }
            else OutlinedButton(enabled = !savedNote, onClick = {
                scope.launch {
                    val title = context.getString(R.string.ai_saved_note_title, AiNoteEdits.oneLine(asked).take(60))
                    val ok = runCatching { Storage.noteWriteMutex.withLock { withContext(Dispatchers.IO) { Storage.createNote(context, AiNoteEdits.newNoteBody(title, report.answer, null)).getOrThrow() } } }.isSuccess
                    if (ok) onSaved() else Toast.makeText(context, R.string.ai_error_save, Toast.LENGTH_SHORT).show()
                }
            }) { Text(stringResource(if (savedNote) R.string.ai_saved_as_note else R.string.ai_save_note)) }
            TextButton(onClick = {
                val body = "Ask JotDrop report\nAI service: $provider\nModel: $model\nDate: ${SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US).format(Date())}\n\nQuestion:\n$asked\n\nAnswer:\n${report.answer}\n\nWhat is wrong with it:\n"
                val mail = Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:hello@jotdrop.net"))
                    .putExtra(Intent.EXTRA_SUBJECT, "Ask JotDrop report").putExtra(Intent.EXTRA_TEXT, body)
                try { context.startActivity(mail) } catch (_: Exception) { Toast.makeText(context, R.string.ai_no_mail_app, Toast.LENGTH_LONG).show() }
            }) { Text(stringResource(R.string.ai_report)) }
        }
    }
}

private fun aiToolText(context: Context, action: AiAction): String {
    val title = (action.input?.get("title") as? String)
    return when (action.tool) {
        "create_note" -> context.getString(R.string.ai_tool_create, title ?: "")
        "append_to_note" -> context.getString(R.string.ai_tool_append)
        "replace_note_text" -> context.getString(R.string.ai_tool_replace)
        "set_labels" -> context.getString(R.string.ai_tool_labels)
        "set_reminder" -> context.getString(R.string.ai_tool_reminder, (action.input?.get("at") as? String)?.replace('T', ' ') ?: "")
        "set_expiry" -> context.getString(R.string.ai_tool_expiry, action.input?.get("date") as? String ?: "")
        "open_note" -> context.getString(R.string.ai_tool_open)
        else -> context.getString(R.string.ai_tool_other, action.tool)
    }
}

/** A change to an existing note waits here for a yes. Lines carry + or − in front: never color alone. */
@Composable
private fun AiConfirmDialog(change: AiChange, onAnswer: (Boolean) -> Unit) {
    val context = LocalContext.current
    val name = change.note.title.ifBlank { context.getString(R.string.ai_untitled) }
    val none = stringResource(R.string.ai_none)
    AlertDialog(
        onDismissRequest = { onAnswer(false) },
        title = { Text(stringResource(when (change.tool) {
            "append_to_note" -> R.string.ai_confirm_append
            "replace_note_text" -> R.string.ai_confirm_replace
            "set_labels" -> R.string.ai_confirm_labels
            "set_reminder" -> R.string.ai_confirm_reminder
            else -> R.string.ai_confirm_expiry
        }, name)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val lines = AiNoteEdits.changeLines(change)
                if (lines != null) {
                    Text(stringResource(R.string.ai_legend), style = MaterialTheme.typography.bodySmall)
                    HorizontalDivider()
                    for ((sign, text) in lines) Text(
                        "${if (sign == '-') '−' else sign} $text",
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.bodySmall,
                        color = when (sign) { '+' -> MaterialTheme.colorScheme.primary; '-' -> MaterialTheme.colorScheme.error; else -> MaterialTheme.colorScheme.onSurfaceVariant },
                    )
                }
                @Suppress("UNCHECKED_CAST")
                when (change.tool) {
                    "set_labels" -> {
                        Text(stringResource(R.string.ai_labels_now, change.note.labels.joinToString(", ").ifEmpty { none }))
                        Text(stringResource(R.string.ai_labels_after, AiNoteEdits.cleanLabels(change.input["labels"] as List<String>).joinToString(", ").ifEmpty { none }))
                        if (change.newLabels.isNotEmpty()) Text(stringResource(R.string.ai_new_label, change.newLabels.joinToString(", ")))
                    }
                    "set_reminder" -> Text(stringResource(R.string.ai_reminder_at, (change.input["at"] as String).replace('T', ' ')))
                    "set_expiry" -> {
                        Text(stringResource(R.string.ai_expires_on, change.input["date"] as String))
                        Text(stringResource(R.string.ai_drawer, (change.input["drawer"] as? String)?.takeIf { it.isNotBlank() } ?: PaperDrawer.LABEL))
                    }
                }
            }
        },
        confirmButton = { Button(onClick = { onAnswer(true) }) { Text(stringResource(R.string.ai_yes)) } },
        dismissButton = { TextButton(onClick = { onAnswer(false) }) { Text(stringResource(R.string.ai_no)) } },
    )
}

/** Settings for Ask JotDrop: the AI service, the user's own key, the model. Off until the user chooses. */
class AiSettingsActivity : ThemedComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent { JotDropTheme { AiSettingsScreen(onClose = { finish() }) } }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AiSettingsScreen(onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val store = remember { AiSecretStore(context) }
    var saved by remember { mutableStateOf(store.load()) }
    var provider by remember { mutableStateOf(saved.provider) }
    var key by remember { mutableStateOf("") }
    var address by remember { mutableStateOf(saved.baseUrl) }
    var model by remember { mutableStateOf(saved.model) }
    var includeShared by remember { mutableStateOf(saved.includeShared) }
    var models by remember { mutableStateOf<List<AiModel>>(emptyList()) }
    var message by remember { mutableStateOf<String?>(null) }
    var problem by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var pickModel by remember { mutableStateOf(false) }
    // The key field stays empty after saving; an empty field keeps the saved key for the same service.
    fun keyNow() = key.trim().ifEmpty { if (provider == saved.provider) saved.key else "" }
    fun current() = AiSettings(provider, keyNow(), model.trim(), address.trim(), includeShared)
    fun say(text: String, isProblem: Boolean) { message = if (isProblem) context.getString(R.string.ai_problem, text) else text; problem = isProblem }
    fun addressOk() = provider != "custom" || address.trim().startsWith("https://")

    Scaffold(topBar = {
        TopAppBar(title = { Text(stringResource(R.string.ai_settings_title)) },
            navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.ai_back)) } })
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.ai_settings_intro))
            Text(stringResource(R.string.ai_provider), style = MaterialTheme.typography.titleSmall)
            for (id in listOf("") + AiSecretStore.PROVIDERS) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().selectable(selected = provider == id, role = Role.RadioButton) {
                    if (provider != id) { provider = id; model = ""; models = emptyList(); message = null; key = "" }
                }) {
                    RadioButton(selected = provider == id, onClick = null)
                    Text(if (id.isEmpty()) stringResource(R.string.ai_provider_off) else aiProviderName(context, id), Modifier.padding(start = 8.dp))
                }
            }
            if (provider == "gemini") Text(stringResource(R.string.ai_gemini_warning), style = MaterialTheme.typography.bodySmall)
            if (provider == "custom") {
                Text(stringResource(R.string.ai_custom_help), style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(address, { address = it }, label = { Text(stringResource(R.string.ai_address)) }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), modifier = Modifier.fillMaxWidth())
            }
            if (provider.isNotEmpty()) {
                val hasSaved = provider == saved.provider && saved.key.isNotEmpty()
                OutlinedTextField(key, { key = it },
                    label = { Text(stringResource(if (provider == "custom") R.string.ai_key_optional else R.string.ai_key)) },
                    placeholder = { if (hasSaved) Text(stringResource(R.string.ai_key_saved)) },
                    singleLine = true, visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrect = false), modifier = Modifier.fillMaxWidth())
                Text(stringResource(R.string.ai_key_where), style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(model, { model = it }, label = { Text(stringResource(R.string.ai_model)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    placeholder = { AiProviders.SPECS[provider]?.defaultModel?.let { Text(it) } })
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(enabled = !busy, onClick = {
                        if (!addressOk()) { say(context.getString(R.string.ai_https_only), true); return@OutlinedButton }
                        busy = true; message = null
                        scope.launch {
                            try {
                                val found = AiProviders.listModels(current().config(), AiHttp)
                                models = found
                                if (model.isBlank()) model = AiProviders.pickDefaultModel(provider, found) ?: ""
                                say(context.getString(R.string.ai_models_loaded, found.size, model.ifBlank { "?" }), false)
                            } catch (error: AiError) {
                                say(aiErrorText(context, error.code), true)
                            } finally { busy = false }
                        }
                    }) { Text(stringResource(R.string.ai_load_models)) }
                    if (models.isNotEmpty()) OutlinedButton(onClick = { pickModel = true }) { Text(stringResource(R.string.ai_pick_model)) }
                }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.ai_include_shared), Modifier.weight(1f))
                    Switch(includeShared, { includeShared = it })
                }
            }
            message?.let { Text(it, color = if (problem) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface) }
            Button(onClick = {
                if (provider.isEmpty()) { store.clear(); saved = AiSettings(); say(context.getString(R.string.ai_turned_off), false); return@Button }
                if (!addressOk()) { say(context.getString(R.string.ai_https_only), true); return@Button }
                val next = current()
                try { AiProviders.create(next.config()) { _, _ -> error("not sent") } } catch (error: AiError) { say(aiErrorText(context, error.code), true); return@Button }
                store.save(next)
                saved = next
                key = ""
                say(context.getString(R.string.ai_saved), false)
            }) { Text(stringResource(R.string.ai_save)) }
            if (saved.on) OutlinedButton(onClick = {
                store.clear(); saved = AiSettings(); provider = ""; key = ""; model = ""; address = ""; models = emptyList()
                say(context.getString(R.string.ai_turned_off), false)
            }) { Text(stringResource(R.string.ai_turn_off)) }
        }
    }

    if (pickModel) AiModelDialog(provider, models, onPick = { model = it; pickModel = false }, onDismiss = { pickModel = false })
}

/** The model list in groups: per company (the part before "/"), the ones that cannot use tools at the end. */
@Composable
private fun AiModelDialog(provider: String, models: List<AiModel>, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    val usable = models.filter { it.tools != false }.sortedWith(compareBy({ it.name.lowercase() }, { it.id }))
    val other = models.filter { it.tools == false }.sortedWith(compareBy({ it.name.lowercase() }, { it.id }))
    val groups = (if (usable.any { '/' in it.id }) usable.groupBy { it.id.substringBefore('/', "Other") }.toSortedMap().toList()
        else listOf(stringResource(R.string.ai_all_models) to usable)) + if (other.isNotEmpty()) listOf(stringResource(R.string.ai_no_tools) to other) else emptyList()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.ai_pick_model)) },
        text = {
            LazyColumn {
                for ((group, list) in groups) {
                    item(key = "g:$group") { Text(group, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp)) }
                    items(list, key = { "m:$group:${it.id}" }) { m ->
                        Text(if (m.name != m.id) "${m.name} (${m.id})" else m.id, Modifier.fillMaxWidth().clickable { onPick(m.id) }.padding(vertical = 8.dp))
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.ai_close)) } },
    )
}

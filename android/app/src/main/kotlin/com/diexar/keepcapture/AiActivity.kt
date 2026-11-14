package com.diexar.keepcapture

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.text.format.Formatter
import android.speech.RecognizerIntent
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.PictureAsPdf
import androidx.compose.material.icons.filled.Image
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.diexar.keepcapture.ui.JotDropTheme
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.time.format.FormatStyle
import java.time.format.DateTimeFormatter
import java.time.LocalDate
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
    "unsupported_input" -> R.string.ai_error_unsupported_input
    "too_large" -> R.string.ai_error_too_large
    else -> R.string.ai_error_bad_request
})

/**
 * The words for a report's error. A file JotDrop itself stopped (status 0) also gets JotDrop's own sentence, which
 * names the file and never holds a key; a detail from the AI service stays hidden, as always.
 */
private fun aiReportError(context: Context, error: AiError?): String {
    val words = aiErrorText(context, error?.code)
    val own = error != null && error.status == 0 && error.code in setOf("unsupported_input", "too_large", "bad_request") && error.detail.isNotBlank()
    return if (own) "$words ${error!!.detail}" else words
}

/** Ask JotDrop's fixed file actions on a card, and the kinds of file each can send. */
private val FILE_ACTION_KINDS = mapOf("transcribe" to setOf("audio"), "photo" to setOf("image"), "receipt" to setOf("image", "pdf"))

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
        private const val EXTRA_SHARED = "ai_note_shared"
        private const val EXTRA_ACTION = "ai_file_action"
        private const val EXTRA_KIND = "ai_kind"
        private const val EXTRA_TITLE = "ai_draft_title"
        private const val EXTRA_TEXT = "ai_draft_text"
        const val RESULT_TEXT = "ai_result_text"
        const val RESULT_REPLACE = "ai_result_replace"
        /**
         * shared: the note is in a shared space (the card knows; a summary does not list the folder to find out).
         * action: a card's file action, "transcribe", "photo" or "receipt": one of the note's files goes, no notes.
         */
        fun intent(context: Context, note: Uri? = null, summarize: Boolean = false, shared: Boolean = false, action: String? = null): Intent =
            Intent(context, AskActivity::class.java).putExtra(EXTRA_NOTE, note?.toString()).putExtra(EXTRA_SUMMARIZE, summarize).putExtra(EXTRA_SHARED, shared)
                .putExtra(EXTRA_ACTION, action)
        /** kind is "rewrite", "checklist" or "summarize". */
        fun draftIntent(context: Context, kind: String, title: String, text: String): Intent =
            Intent(context, AskActivity::class.java).putExtra(EXTRA_KIND, kind).putExtra(EXTRA_TITLE, title).putExtra(EXTRA_TEXT, text)
        private const val EXTRA_WEEK = "ai_week"
        private const val EXTRA_MERGE_OLDER = "ai_merge_older"
        private const val EXTRA_MERGE_NEWER = "ai_merge_newer"
        /** "This week" (v2, part F): a short overview from a digest made on this phone, no tools. */
        fun weekIntent(context: Context): Intent = Intent(context, AskActivity::class.java).putExtra(EXTRA_WEEK, true)
        /** "Merge with AI" from Find duplicates (v2, part E): only these two notes go along; the newer one gets the text. */
        fun mergeIntent(context: Context, older: Uri, newer: Uri): Intent = Intent(context, AskActivity::class.java)
            .putExtra(EXTRA_MERGE_OLDER, older.toString()).putExtra(EXTRA_MERGE_NEWER, newer.toString())
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val note = intent.getStringExtra(EXTRA_NOTE)?.let(Uri::parse)
        val summarize = intent.getBooleanExtra(EXTRA_SUMMARIZE, false)
        val shared = intent.getBooleanExtra(EXTRA_SHARED, false)
        val kind = intent.getStringExtra(EXTRA_KIND)
        val draft = kind?.let { AiNote("draft", intent.getStringExtra(EXTRA_TITLE).orEmpty(), intent.getStringExtra(EXTRA_TEXT).orEmpty()) }
        val action = intent.getStringExtra(EXTRA_ACTION)?.takeIf { note != null && it in FILE_ACTION_KINDS }
        val week = intent.getBooleanExtra(EXTRA_WEEK, false)
        val merge = intent.getStringExtra(EXTRA_MERGE_OLDER)?.let { older -> intent.getStringExtra(EXTRA_MERGE_NEWER)?.let { Uri.parse(older) to Uri.parse(it) } }
        setContent {
            JotDropTheme {
                AskScreen(note, shared, summarize, draft, kind, action, week, merge, onClose = { finish() }, onDraftAnswer = { answer, replace ->
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
private fun AskScreen(
    target: Uri?, targetShared: Boolean, summarize: Boolean, draft: AiNote?, kind: String?, action: String?, week: Boolean, merge: Pair<Uri, Uri>?,
    onClose: () -> Unit, onDraftAnswer: (String, Boolean) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var settings by remember { mutableStateOf(AiSecretStore(context).load()) }
    val executor = remember { AiExecutor(context) { uri -> context.startActivity(EditorActivity.openNoteIntent(context, uri)) } }
    var loaded by remember { mutableStateOf(false) }
    // Done when the notes are read: the screen can be used before that, and a request waits for it.
    val reading = remember { CompletableDeferred<Unit>() }
    // The receipt's title is asked for in the phone's language; the request of a file action is fixed.
    val language = Locale.getDefault().getDisplayLanguage(Locale.ENGLISH)
    var request by remember { mutableStateOf(when {
        week -> context.getString(R.string.ai_week_request)
        action == null -> ""
        action == "receipt" -> AiReceipt.request(language).second
        else -> AiParts.fileRequest(action)
    }) }
    // Version 2: "This week" lists what its digest picked; "Merge with AI" knows its two notes by id once they are read.
    var weekShown by remember { mutableStateOf<List<DigestEntry>>(emptyList()) }
    var mergeIds by remember { mutableStateOf<Pair<AiNote, AiNote>?>(null) }
    var olderTrashed by remember { mutableStateOf(false) }
    // Why nothing was sent (nothing for the week, notes too long to merge), in words.
    var notice by remember { mutableStateOf<Int?>(null) }
    val zone = TimeZone.getDefault().id
    var excluded by remember { mutableStateOf(setOf<String>()) }
    var goesOpen by remember { mutableStateOf(false) }
    var job by remember { mutableStateOf<Job?>(null) }
    var pending by remember { mutableStateOf<Pending?>(null) }
    var report by remember { mutableStateOf<AiReport?>(null) }
    var asked by remember { mutableStateOf("") }
    var savedNote by remember { mutableStateOf(false) }
    var addedBelow by remember { mutableStateOf(false) }
    var stopped by remember { mutableStateOf(false) }
    var missing by remember { mutableStateOf(false) }
    var listed by remember { mutableStateOf<AiPlan?>(null) }
    // Version 2: the card's files (listed at once, read only when one goes) and the ticked ones, by name.
    var files by remember { mutableStateOf<List<AiFileRef>>(emptyList()) }
    var filesOn by remember { mutableStateOf(setOf<String>()) }
    // The card's note has a live list link while shared notes are kept out: then its files stay home too.
    var keptOut by remember { mutableStateOf(false) }
    var targetTitle by remember { mutableStateOf("") }
    var targetLabels by remember { mutableStateOf<List<String>>(emptyList()) }
    var preparing by remember { mutableStateOf<Int?>(null) }
    var chooseFile by remember { mutableStateOf(false) }
    var receipt by remember { mutableStateOf<AiReceiptData?>(null) }
    var receiptBefore by remember { mutableStateOf("") }
    var receiptBusy by remember { mutableStateOf(false) }
    var receiptSaid by remember { mutableStateOf<String?>(null) }
    val provider = aiProviderName(context, settings.provider)
    // OpenAI writes out a recording with its own model, which the line names.
    val model = if (action == "transcribe" && settings.provider == "openai") AiProviders.TRANSCRIBE_MODEL
        else settings.model.ifEmpty { AiProviders.SPECS[settings.provider]?.defaultModel.orEmpty() }

    // A fixed request (card summary, file action, editor button, This week, Merge with AI) cannot be edited or dictated.
    val fixed = summarize || draft != null || action != null || week || merge != null

    // What goes along, decided from the notes as they are now: the list on screen and the request use the same plan.
    fun plan(text: String, unticked: Set<String>): AiPlan = AiAsk.plan(executor.notes, text, unticked,
        pinned = target?.let(executor::idOf), target = target != null, summarize = summarize, includeShared = settings.includeShared)

    // Why a file cannot go with this service, in words, or null. The size is known before reading; a photo is made small first.
    fun fileProblem(file: AiFileRef): String? {
        val use = if (action == "transcribe") "transcribe" else "ask"
        val field = if (file.kind == "audio" && use == "transcribe") "transcribe" else file.kind
        if (AiParts.capabilities(settings.provider, null).of(field) == false) return AiParts.explain(settings.provider, file.kind, use)
        val limit = AiParts.LIMITS.getValue(file.kind)
        if (file.kind != "image" && file.size > limit) return context.getString(R.string.ai_file_too_large, (limit / (1024 * 1024)).toInt())
        return null
    }

    fun send() {
        val text = request.trim()
        if (text.isEmpty() || job != null) return
        val sending = files.filter { it.name in filesOn && fileProblem(it) == null }
        if (action != null && (keptOut || sending.isEmpty())) { chooseFile = !keptOut; return }
        chooseFile = false
        asked = text
        report = null
        savedNote = false
        addedBelow = false
        stopped = false
        missing = false
        receipt = null
        receiptSaid = null
        notice = null
        olderTrashed = false
        val unticked = excluded
        job = scope.launch {
            try {
                if (week) {
                    // The overview has no tools: what the notes say can never make or change a note.
                    reading.await()
                    val digest = Digest.weekDigest(executor.notes.filter { it.id !in unticked }, System.currentTimeMillis(), zone, settings.includeShared)
                    if (digest.notes.isEmpty()) { notice = R.string.ai_week_nothing; return@launch }
                    val day = SimpleDateFormat("yyyy-MM-dd EEEE", Locale.US).format(Date())
                    val (system, overview) = Digest.request(language, day, zone, digest.text)
                    val done = AiAssistant.once(text, emptyList(), provider = { AiProviders.create(settings.config(), AiHttp) }, secrets = listOf(settings.key)) { ai, time ->
                        ai.complete(system, listOf(AiMessage.User(overview)), emptyList(), time)
                    }
                    digest.notes.mapTo(done.sent) { AiSent(it.id, it.title) }
                    val said = done.answer.lowercase()
                    done.sources = done.sent.filter { it.title.length >= 3 && said.contains(it.title.lowercase()) }
                    report = done
                    return@launch
                }
                // The ticked files are read only now. One that cannot be read stops everything before anything goes out.
                val parts = if (sending.isEmpty()) emptyList() else try {
                    preparing = if (sending.any { it.kind == "image" }) R.string.ai_file_making_small else R.string.ai_file_getting_ready
                    sending.map { AiFiles.part(context, it) }
                } catch (problem: AiError) {
                    report = AiReport(text).apply { stop = "error"; error = problem }
                    return@launch
                } finally { preparing = null }
                if (action != null) {
                    // One request without tools: text on a photo or a receipt can never make or change a note.
                    val before = if (action == "receipt") withContext(Dispatchers.IO) { Storage.readNote(context, target!!).getOrNull() } else null
                    val done = AiAssistant.once(text, parts, provider = { AiProviders.create(settings.config(), AiHttp) }, secrets = listOf(settings.key)) { ai, time ->
                        when (action) {
                            "transcribe" -> ai.transcribe(parts.first(), Locale.getDefault().toLanguageTag(), time).answer()
                            "photo" -> ai.complete(AiParts.PHOTO_SYSTEM, listOf(AiMessage.User(text, parts)), emptyList(), time)
                            else -> ai.complete(AiReceipt.request(language).first, listOf(AiMessage.User(text, parts)), emptyList(), time)
                        }
                    }
                    if (action == "receipt" && done.stop == "done" && before != null) { receipt = AiReceipt.parse(done.answer); receiptBefore = before }
                    report = done
                    return@launch
                }
                // An editor button sends only the draft; anything else waits until the notes are read.
                val (notes, chosen) = if (draft != null) listOf(draft) to AiContext.selectNotes(listOf(draft), "", pinned = listOf(draft.id)).notes
                else if (merge != null) {
                    // A merge replaces the newer note's text: the AI must see all of both notes, or the merged text loses the rest.
                    reading.await()
                    val (older, newer) = mergeIds ?: run { notice = R.string.ai_merge_both; return@launch }
                    val two = executor.notes.filter { it.id == older.id || it.id == newer.id }
                    val picked = AiContext.selectNotes(two, "", pinned = listOf(older.id, newer.id)).notes
                    if (picked.size < 2) { notice = R.string.ai_merge_both; return@launch }
                    if (picked.any { it.truncated }) { notice = R.string.ai_merge_too_long; return@launch }
                    two to picked
                } else {
                    reading.await()
                    val now = plan(text, unticked)
                    // The card's note could not be read: say so instead of sending the request without it.
                    if (now.missing) { missing = true; return@launch }
                    now.notes to now.chosen
                }
                val (tools, prompt) = withContext(Dispatchers.IO) { AiAssets.get(context) }
                val day = SimpleDateFormat("yyyy-MM-dd EEEE", Locale.US).format(Date())
                val system = AiPrompt.system(prompt, language, day, TimeZone.getDefault().id, executor.labels)
                report = AiAssistant.run(
                    request = text,
                    notes = notes,
                    labels = executor.labels,
                    tools = tools,
                    system = system,
                    provider = { AiProviders.create(settings.config(), AiHttp) },
                    // The draft is not saved yet, so the AI changes nothing: the answer waits for Replace or Add below.
                    executor = if (draft != null) emptyMap() else executor.tools,
                    confirm = if (draft != null) { _ -> false } else { change -> val answer = CompletableDeferred<Boolean>(); pending = Pending(change, answer); answer.await().also { pending = null } },
                    includeShared = settings.includeShared,
                    secrets = listOf(settings.key),
                    chosen = chosen,
                    parts = parts,
                )
            } catch (error: CancellationException) {
                stopped = true
                throw error
            } finally { job = null; pending = null }
        }
    }

    // "Apply" on the receipt screen: only when the note still has the text the AI saw. Title and lines first, then
    // the expiry date with its drawer and warning, exactly as the AI's set_expiry does it.
    fun applyReceipt(title: String, drawer: String, until: String, lines: String) {
        val uri = target ?: return
        val day = PaperDrawer.validExpires(until)
        if (day == null) { Toast.makeText(context, R.string.ai_receipt_no_until, Toast.LENGTH_LONG).show(); return }
        receiptBusy = true
        scope.launch {
            try {
                val id = requireNotNull(executor.idOf(uri))
                val same = Storage.noteWriteMutex.withLock {
                    withContext(Dispatchers.IO) {
                        val now = Storage.readNote(context, uri).getOrThrow()
                        if (now != receiptBefore) return@withContext false
                        val next = AiReceipt.noteText(now, title, lines)
                        if (next != now) Storage.updateNote(context, uri, next).getOrThrow()
                        true
                    }
                }
                if (!same) { receiptSaid = context.getString(R.string.ai_receipt_changed); return@launch }
                executor.tools.getValue("set_expiry")(mapOf("id" to id, "date" to day, "drawer" to PaperDrawer.drawerName(drawer)))
                val name = PaperDrawer.drawerName(drawer).let { if (it.isEmpty()) PaperDrawer.LABEL else "${PaperDrawer.LABEL} / $it" }
                receiptSaid = context.getString(R.string.ai_receipt_done, name, LocalDate.parse(day).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG)))
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                Toast.makeText(context, R.string.ai_error_save, Toast.LENGTH_SHORT).show()
            } finally { receiptBusy = false }
        }
    }

    // Ask JotDrop off: maybe another device shares a key ("Use it here?").
    var offLook by remember { mutableStateOf<AiKeyCloud.Look?>(null) }
    var offSaid by remember { mutableStateOf<String?>(null) }
    var offUsing by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { if (!settings.on) offLook = AiKeyCloud.look(context) }

    // Runs again when a key from another device is taken here: the screen then opens as it was asked.
    LaunchedEffect(settings.on) {
        if (!settings.on) return@LaunchedEffect
        if (draft != null && kind != null) {
            loaded = true
            reading.complete(Unit)
            request = AiNoteEdits.editorRequest(kind, draft.title)
            send()
            return@LaunchedEffect
        }
        val started = SystemClock.elapsedRealtime()
        // A summary and a file action need their own note only.
        if ((summarize || action != null) && target != null) executor.loadOne(target, targetShared) else executor.load()
        // Only counts and times, never note content: to see how long a big vault takes to read.
        Log.i("AskJotDrop", "Read ${executor.notes.size} notes in ${SystemClock.elapsedRealtime() - started} ms (listing ${executor.listMs} ms, ${executor.fromCache} from the cache)")
        if (target != null && !summarize) {
            val note = executor.idOf(target)?.let { id -> executor.notes.firstOrNull { it.id == id } }
            targetTitle = note?.title.orEmpty()
            targetLabels = note?.labels.orEmpty()
            keptOut = note?.shared == true && !settings.includeShared
            val own = if (keptOut) emptyList() else withContext(Dispatchers.IO) { Storage.readNote(context, target).getOrNull()?.let { AiFiles.of(context, it, null) }.orEmpty() }
            files = if (action != null) own.filter { it.kind in FILE_ACTION_KINDS.getValue(action) } else own
            // A file action sends one file: the first that can go is chosen.
            if (action != null) files.firstOrNull { fileProblem(it) == null }?.let { filesOn = setOf(it.name) }
        }
        if (week) weekShown = withContext(Dispatchers.Default) { Digest.weekDigest(executor.notes, System.currentTimeMillis(), zone, settings.includeShared).notes }
        if (merge != null) {
            // Notes are named by id only: a title is data, never part of the request.
            val older = executor.idOf(merge.first)?.let { id -> executor.notes.firstOrNull { it.id == id } }
            val newer = executor.idOf(merge.second)?.let { id -> executor.notes.firstOrNull { it.id == id } }
            if (older != null && newer != null) {
                mergeIds = older to newer
                request = AiNoteEdits.mergeRequest(older.id, newer.id)
            } else missing = true
        }
        loaded = true
        reading.complete(Unit)
        if (summarize) {
            val note = target?.let(executor::idOf)?.let { id -> executor.notes.firstOrNull { it.id == id } }
            if (note != null) { request = AiNoteEdits.editorRequest("summarize", note.title); send() } else missing = true
        }
    }

    // The list of what goes along follows the request while typing, worked out off the main thread.
    LaunchedEffect(loaded, request, excluded) {
        if (!loaded || fixed) return@LaunchedEffect
        val text = request
        val unticked = excluded
        delay(150)
        listed = withContext(Dispatchers.Default) { plan(text, unticked) }
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

    val sendingFiles = files.filter { it.name in filesOn && fileProblem(it) == null }
    Scaffold(topBar = {
        TopAppBar(title = { Text(stringResource(R.string.ai_title)) },
            navigationIcon = { IconButton(onClick = { job?.cancel(); onClose() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.ai_back)) } })
    }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding).imePadding(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (!settings.on) {
                item {
                    val offer = offLook?.let { aiOfferText(context, it) }
                    Text(if (offer != null) stringResource(R.string.ai_off_offer, offer) else stringResource(R.string.ai_off))
                    offSaid?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) }
                    val openSettings = { context.startActivity(Intent(context, AiSettingsActivity::class.java)); onClose() }
                    Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (offer != null) {
                            Button(enabled = !offUsing, onClick = {
                                offUsing = true; offSaid = null
                                scope.launch {
                                    try { settings = AiKeyCloud.use(context) }
                                    catch (error: CancellationException) { throw error }
                                    catch (error: AiKeyCloud.Refused) { offSaid = AiKeyCloud.reasonText(context, error) }
                                    catch (_: Exception) { offSaid = context.getString(R.string.ai_sync_unreachable) }
                                    finally { offUsing = false }
                                }
                            }) { Text(stringResource(R.string.ai_sync_use)) }
                            OutlinedButton(onClick = openSettings) { Text(stringResource(R.string.ai_open_settings)) }
                        } else Button(onClick = openSettings) { Text(stringResource(R.string.ai_open_settings)) }
                    }
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
                        Button(onClick = { send() }, enabled = request.isNotBlank() && (action == null || (loaded && !keptOut && files.isNotEmpty()))) { Text(stringResource(R.string.ai_send)) }
                        // Only from the plain ask screen, as on the web: not about one card, not from the editor.
                        if (!fixed && target == null) OutlinedButton(onClick = { context.startActivity(AskActivity.weekIntent(context)); onClose() }) { Text(stringResource(R.string.ai_week)) }
                    } else {
                        OutlinedButton(onClick = { job?.cancel() }) { Text(stringResource(R.string.ai_stop)) }
                    }
                }
                Text(stringResource(R.string.ai_goes_to, provider, model.ifEmpty { "?" }), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
            }
            if (!loaded) item {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text(stringResource(R.string.ai_reading_notes), style = MaterialTheme.typography.bodySmall)
            } else if (week && job == null && report == null) {
                // What the digest picked, each a switch; only the facts the help names go along.
                item {
                    Text(stringResource(R.string.ai_what_goes, weekShown.count { it.id !in excluded }), style = MaterialTheme.typography.titleSmall)
                    Text(stringResource(if (weekShown.isEmpty()) R.string.ai_week_nothing else R.string.ai_week_goes), style = MaterialTheme.typography.bodySmall)
                }
                items(weekShown, key = { "w:" + it.id }) { entry ->
                    val on = entry.id !in excluded
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                        .toggleable(value = on, role = Role.Checkbox) { excluded = if (it) excluded - entry.id else excluded + entry.id }.padding(vertical = 4.dp)) {
                        Checkbox(checked = on, onCheckedChange = null)
                        Column(Modifier.padding(start = 8.dp)) {
                            val title = AiAsk.shortTitle(entry.title).ifBlank { stringResource(R.string.ai_untitled) }
                            Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            entry.firstLine.takeIf { it.isNotEmpty() && it != title }?.let { Text(AiAsk.shortTitle(it, 80), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                            if (!on) Text(stringResource(R.string.ai_stays_home), style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            } else if (merge != null && job == null && report == null) mergeIds?.let { (older, newer) ->
                item {
                    Text(stringResource(R.string.ai_what_goes, 2), style = MaterialTheme.typography.titleSmall)
                    for (note in listOf(older, newer)) Text("• " + AiAsk.shortTitle(note.title).ifBlank { stringResource(R.string.ai_untitled) }, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            } else if (action != null && job == null && report == null) {
                // A file action shows the files at once: the user sends the chosen one, or chooses another first.
                item {
                    Text(stringResource(when { keptOut -> R.string.ai_file_shared_off; files.isEmpty() -> R.string.ai_file_none; else -> R.string.ai_files_choose }),
                        style = if (keptOut || files.isEmpty()) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.titleSmall)
                }
                items(files, key = { "f:" + it.name }) { file ->
                    AiFileRow(file, on = file.name in filesOn, one = true, problem = fileProblem(file)) { filesOn = setOf(file.name); chooseFile = false }
                }
                if (sendingFiles.isNotEmpty()) item { Text(stringResource(R.string.ai_files_others), style = MaterialTheme.typography.bodySmall) }
                if (chooseFile) item { Text(stringResource(R.string.ai_file_choose_first)) }
            } else if (!fixed && job == null && report == null) listed?.let { now ->
                val ticked = now.shown.filter { it.id !in excluded }
                item {
                    Text(
                        (if (goesOpen) "▾ " else "▸ ") + if (sendingFiles.isEmpty()) stringResource(R.string.ai_what_goes, now.chosen.size)
                            else stringResource(R.string.ai_what_goes_files, now.chosen.size, sendingFiles.size),
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.fillMaxWidth().clickable(role = Role.Button) { goesOpen = !goesOpen }.padding(vertical = 8.dp),
                    )
                    if (goesOpen) Text(stringResource(if (now.shown.isEmpty()) R.string.ai_what_goes_none else R.string.ai_what_goes_help), style = MaterialTheme.typography.bodySmall)
                    if (goesOpen && now.shown.isNotEmpty()) TextButton(onClick = {
                        val ids = now.shown.map { it.id }
                        excluded = if (ticked.isNotEmpty()) excluded + ids else excluded - ids.toSet()
                    }) { Text(stringResource(if (ticked.isNotEmpty()) R.string.ai_untick_all else R.string.ai_tick_all)) }
                }
                // One short row per note, the whole row a switch; an unticked note also says so in words.
                if (goesOpen) items(now.shown, key = { it.id }) { note ->
                    val on = note.id !in excluded
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                        .toggleable(value = on, role = Role.Checkbox) { excluded = if (it) excluded - note.id else excluded + note.id }.padding(vertical = 4.dp)) {
                        Checkbox(checked = on, onCheckedChange = null)
                        Column(Modifier.padding(start = 8.dp)) {
                            val title = AiAsk.shortTitle(note.title).ifBlank { stringResource(R.string.ai_untitled) }
                            Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            AiAsk.firstLine(note).takeIf { it.isNotEmpty() && it != title }?.let {
                                Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            if (!on) Text(stringResource(R.string.ai_stays_home), style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
                // The note's own files, unticked: a file goes only when the user ticks it.
                if (goesOpen && files.isNotEmpty()) {
                    item { Text(stringResource(R.string.ai_files_ticked_only), style = MaterialTheme.typography.bodySmall) }
                    items(files, key = { "f:" + it.name }) { file ->
                        AiFileRow(file, on = file.name in filesOn, one = false, problem = fileProblem(file)) { on -> filesOn = if (on) filesOn + file.name else filesOn - file.name }
                    }
                    if (sendingFiles.isNotEmpty()) item { Text(stringResource(R.string.ai_files_others), style = MaterialTheme.typography.bodySmall) }
                }
            }
            if (missing || (job == null && report == null && listed?.missing == true)) item { Text(stringResource(R.string.ai_note_missing)) }
            if (job != null) item {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text(preparing?.let { stringResource(it) } ?: if (loaded) stringResource(R.string.ai_working, provider) else stringResource(R.string.ai_reading_notes), style = MaterialTheme.typography.bodySmall)
            }
            if (stopped) item { Text(stringResource(R.string.ai_stopped)) }
            notice?.let { said -> item { Text(stringResource(said)) } }
            val found = receipt
            if (found != null && receiptSaid == null) item {
                val drawers = (executor.labels.filter { PaperDrawer.drawerName(it).isNotEmpty() } + PaperDrawer.SUGGESTED_DRAWERS.map(PaperDrawer::drawerLabel)).distinctBy { it.lowercase() }
                val current = targetLabels.firstOrNull { PaperDrawer.drawerName(it).isNotEmpty() }?.let { label -> drawers.firstOrNull { it.equals(label.trim(), true) } } ?: PaperDrawer.LABEL
                ReceiptCard(found, AiAsk.shortTitle(targetTitle), current, drawers, receiptBusy, onApply = ::applyReceipt,
                    onSkip = { receiptSaid = context.getString(R.string.ai_receipt_skipped) })
            }
            receiptSaid?.let { said -> item { Text(said) } }
            report?.let { done -> item {
                AiResult(done, asked, provider, model, executor, target, summarize, kind.takeIf { draft != null }, action, targetTitle, hideAnswer = found != null,
                    savedNote, addedBelow, onSaved = { savedNote = true }, onAddedBelow = { addedBelow = true }, onDraft = { replace -> onDraftAnswer(done.answer, replace) },
                    saveTitle = mergeIds?.second?.let { context.getString(R.string.ai_title_merge, AiAsk.shortTitle(it.title).ifBlank { context.getString(R.string.ai_untitled) }) })
            } }
            // After a merge that was applied, the older note is still there: moving it to the trash is the user's own step.
            val merged = mergeIds
            if (merged != null && report?.actions?.any { it.tool == "replace_note_text" && it.status == "done" && it.input?.get("id") == merged.second.id } == true) item {
                val older = AiAsk.shortTitle(merged.first.title).ifBlank { stringResource(R.string.ai_untitled) }
                if (olderTrashed) Text(stringResource(R.string.ai_merge_trashed, older))
                else Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.ai_merge_older_left, older))
                    OutlinedButton(onClick = {
                        scope.launch {
                            try {
                                val uri = merge!!.first
                                ReminderScheduler.cancel(context, uri)
                                withContext(Dispatchers.IO) { Storage.noteWriteMutex.withLock { Storage.trashNote(context, uri).getOrThrow() } }
                                olderTrashed = true
                            } catch (error: CancellationException) {
                                throw error
                            } catch (_: Exception) { Toast.makeText(context, R.string.ai_error_save, Toast.LENGTH_SHORT).show() }
                        }
                    }) { Text(stringResource(R.string.ai_merge_trash)) }
                }
            }
        }
    }

    pending?.let { waiting -> AiConfirmDialog(waiting.change, onAnswer = { waiting.answer.complete(it) }) }
}

/** A file of the note: a mark, the name, the kind in words and the size; one that cannot go says why and cannot be chosen. */
@Composable
private fun AiFileRow(file: AiFileRef, on: Boolean, one: Boolean, problem: String?, onChange: (Boolean) -> Unit) {
    val context = LocalContext.current
    val chosen = on && problem == null
    val choose = when {
        problem != null -> Modifier
        one -> Modifier.selectable(selected = chosen, role = Role.RadioButton) { onChange(true) }
        else -> Modifier.toggleable(value = chosen, role = Role.Checkbox, onValueChange = onChange)
    }
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).then(choose).padding(vertical = 4.dp)) {
        if (one) RadioButton(selected = chosen, onClick = null, enabled = problem == null) else Checkbox(checked = chosen, onCheckedChange = null, enabled = problem == null)
        Icon(when (file.kind) { "image" -> Icons.Filled.Image; "pdf" -> Icons.Filled.PictureAsPdf; else -> Icons.Filled.Mic }, contentDescription = null,
            modifier = Modifier.padding(start = 8.dp).size(20.dp))
        Column(Modifier.padding(start = 8.dp)) {
            Text(file.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val kindWords = stringResource(when (file.kind) { "image" -> R.string.ai_file_photo; "pdf" -> R.string.ai_file_pdf; else -> R.string.ai_file_audio })
            Text(if (file.size >= 0) "$kindWords · ${Formatter.formatShortFileSize(context, file.size)}" else kindWords, style = MaterialTheme.typography.bodySmall)
            when {
                problem != null -> Text(stringResource(R.string.ai_file_cannot, problem), style = MaterialTheme.typography.labelSmall)
                !chosen -> Text(stringResource(R.string.ai_stays_home), style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AiResult(
    report: AiReport, asked: String, provider: String, model: String, executor: AiExecutor, target: Uri?, summarize: Boolean,
    draftKind: String?, action: String?, targetTitle: String, hideAnswer: Boolean,
    savedNote: Boolean, addedBelow: Boolean, onSaved: () -> Unit, onAddedBelow: () -> Unit, onDraft: (Boolean) -> Unit,
    saveTitle: String? = null,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        when (report.stop) {
            "error", "off", "timeout" -> Text(stringResource(R.string.ai_problem, aiReportError(context, report.error)), color = MaterialTheme.colorScheme.error)
            "max_rounds" -> Text(stringResource(R.string.ai_problem, stringResource(R.string.ai_stop_max_rounds)), color = MaterialTheme.colorScheme.error)
            "refusal" -> Text(stringResource(R.string.ai_stop_refusal))
        }
        // An answer without words (a silent recording, a blank page) says so, as the web app does.
        if (report.stop == "done" && report.answer.isBlank()) Text(stringResource(R.string.ai_no_answer))
        // A receipt the app could read shows as the receipt screen, not as the AI's raw answer.
        if (report.answer.isNotBlank() && !hideAnswer) Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.ai_answer_label, provider, model), style = MaterialTheme.typography.labelMedium)
                AiMarkdownText(report.answer)
            }
        }
        // The draft is already open in the editor, so it gets no source button.
        if (draftKind == null && report.sources.isNotEmpty()) {
            Text(stringResource(R.string.ai_sources), style = MaterialTheme.typography.titleSmall)
            for (source in report.sources) OutlinedButton(onClick = { executor.uriOf(source.id)?.let { context.startActivity(EditorActivity.openNoteIntent(context, it)) } }) { Text(AiAsk.shortTitle(source.title).ifBlank { context.getString(R.string.ai_untitled) }, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
        if (report.actions.any { it.tool !in setOf("search_notes", "read_note") }) {
            Text(stringResource(R.string.ai_actions), style = MaterialTheme.typography.titleSmall)
            for (step in report.actions.filter { it.tool !in setOf("search_notes", "read_note") }) {
                val status = stringResource(when (step.status) { "done" -> R.string.ai_action_done; "declined" -> R.string.ai_action_declined; "refused" -> R.string.ai_action_refused; else -> R.string.ai_action_failed })
                Text("$status: ${aiToolText(context, step)}")
            }
        }
        // Titles only, one short line each, as in the list of what goes along: never the note's text. Files by name.
        val names = report.sent.map { AiAsk.shortTitle(it.title).ifBlank { context.getString(R.string.ai_untitled) } }.joinToString(", ")
        val fileNames = report.files.joinToString(", ") { AiParts.label(it.name) }
        Text(when {
            report.stop == "off" || (report.error != null && report.rounds == 0) -> stringResource(R.string.ai_sent_nothing)
            action == "transcribe" -> stringResource(R.string.ai_sent_recording, provider, fileNames)
            names.isEmpty() && fileNames.isEmpty() -> stringResource(R.string.ai_sent_none, provider)
            fileNames.isEmpty() -> stringResource(R.string.ai_sent_notes, provider, names)
            names.isEmpty() -> stringResource(R.string.ai_sent_files, provider, fileNames)
            else -> stringResource(R.string.ai_sent_notes_files, provider, names, fileNames)
        }, style = MaterialTheme.typography.bodySmall)
        // A recording written out by OpenAI is billed by its length, not in tokens.
        if (report.rounds > 0) Text(report.seconds?.let { stringResource(R.string.ai_seconds, Math.round(it).toInt()) } ?: stringResource(R.string.ai_tokens, report.input, report.output), style = MaterialTheme.typography.bodySmall)
        // Back in the editor the answer is part of the draft; it is saved like any edit.
        if (draftKind != null && report.answer.isNotBlank()) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (draftKind != "summarize") Button(onClick = { onDraft(true) }) { Text(stringResource(R.string.ai_replace_text)) }
            OutlinedButton(onClick = { onDraft(false) }) { Text(stringResource(R.string.ai_add_below)) }
        }
        if (report.answer.isNotBlank() && !hideAnswer) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            // A summary or a file's text goes below its own note first.
            if (draftKind == null && target != null && (summarize || action != null)) OutlinedButton(enabled = !addedBelow, onClick = {
                scope.launch {
                    val ok = runCatching { Storage.noteWriteMutex.withLock { withContext(Dispatchers.IO) { Storage.updateNote(context, target, AiNoteEdits.appendedText(Storage.readNote(context, target).getOrThrow(), report.answer, null)).getOrThrow() } } }.isSuccess
                    if (ok) onAddedBelow() else Toast.makeText(context, R.string.ai_error_save, Toast.LENGTH_SHORT).show()
                }
            }) { Text(stringResource(if (addedBelow) R.string.ai_added_below else R.string.ai_add_below)) }
            if (draftKind == null && !summarize) OutlinedButton(enabled = !savedNote, onClick = {
                scope.launch {
                    val name = AiAsk.shortTitle(targetTitle).ifBlank { context.getString(R.string.ai_untitled) }
                    val title = saveTitle ?: when (action) {
                        "transcribe" -> context.getString(R.string.ai_title_transcribe, name)
                        "photo" -> context.getString(R.string.ai_title_photo, name)
                        "receipt" -> context.getString(R.string.ai_title_receipt, name)
                        else -> context.getString(R.string.ai_saved_note_title, AiNoteEdits.oneLine(asked).take(60))
                    }
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
    val name = AiAsk.shortTitle(change.note.title).ifBlank { context.getString(R.string.ai_untitled) }
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
    // "Use this key on all my devices": whether this phone is in JotDrop Cloud, what the server has, and the remove choice.
    var connected by remember { mutableStateOf(false) }
    var look by remember { mutableStateOf<AiKeyCloud.Look?>(null) }
    var removing by remember { mutableStateOf(false) }
    // The key field stays empty after saving; an empty field keeps the saved key for the same service.
    fun keyNow() = key.trim().ifEmpty { if (provider == saved.provider) saved.key else "" }
    fun current() = AiSettings(provider, keyNow(), model.trim(), address.trim(), includeShared, saved.synced, saved.syncedVault)
    fun showSaved(next: AiSettings) { saved = next; provider = next.provider; model = next.model; address = next.baseUrl; includeShared = next.includeShared; key = ""; models = emptyList() }
    fun say(text: String, isProblem: Boolean) { message = if (isProblem) context.getString(R.string.ai_problem, text) else text; problem = isProblem }
    fun addressOk() = provider != "custom" || address.trim().startsWith("https://")

    // When these settings open, a look at what the server has: a newer key, a removed one, or one that is ready here.
    LaunchedEffect(Unit) {
        connected = withContext(Dispatchers.IO) { AiKeyCloud.client(context) != null }
        if (!connected) return@LaunchedEffect
        val found = AiKeyCloud.look(context) ?: return@LaunchedEffect
        look = found
        when (found.changed) {
            "replaced" -> { showSaved(found.settings); say(context.getString(R.string.ai_sync_replaced), false) }
            "removed" -> { showSaved(AiSettings()); say(context.getString(R.string.ai_sync_removed), false) }
            // Connected to another account: the key followed elsewhere is this phone's own here.
            "own" -> showSaved(found.settings)
        }
    }

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
            AiKeySyncBlock(saved, connected, look, onLook = { look = it }, onSaved = { showSaved(it) }, say = ::say)
            message?.let { Text(it, color = if (problem) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface) }
            Button(onClick = {
                // A phone that follows the shared key passes its new settings on, or lets go when there is nothing to share.
                val followed = saved.synced > 0
                if (provider.isEmpty()) {
                    store.clear(); saved = AiSettings()
                    say(context.getString(R.string.ai_turned_off) + if (followed) " " + context.getString(R.string.ai_sync_let_go) else "", false)
                    return@Button
                }
                if (!addressOk()) { say(context.getString(R.string.ai_https_only), true); return@Button }
                val next = current()
                try { AiProviders.create(next.config()) { _, _ -> error("not sent") } } catch (error: AiError) { say(aiErrorText(context, error.code), true); return@Button }
                store.save(next)
                saved = next
                key = ""
                say(context.getString(R.string.ai_saved), false)
                if (!followed) return@Button
                scope.launch {
                    val (kept, refused) = AiKeyCloud.shareSaved(context, next)
                    saved = kept
                    if (refused == null) look = AiKeyCloud.ownLook(kept)
                    val more = when {
                        refused == null -> context.getString(R.string.ai_sync_shared_saved)
                        refused.reason.startsWith("let-go") || refused.reason == "cloud" -> context.getString(R.string.ai_sync_let_go)
                        else -> context.getString(R.string.ai_sync_kept_earlier, AiKeyCloud.reasonText(context, refused))
                    }
                    say(context.getString(R.string.ai_saved) + " " + more, false)
                }
            }) { Text(stringResource(R.string.ai_save)) }
            if (saved.on) OutlinedButton(onClick = {
                // A key the other devices use too: the user says where it goes.
                if (saved.synced > 0) { removing = true; return@OutlinedButton }
                store.clear(); showSaved(AiSettings())
                say(context.getString(R.string.ai_turned_off), false)
            }) { Text(stringResource(R.string.ai_turn_off)) }
        }
    }

    if (removing) AiRemoveChoiceDialog(
        onAll = {
            removing = false
            scope.launch {
                try {
                    AiKeyCloud.removeEverywhere(context)
                    showSaved(AiSettings())
                    look = look?.let { AiKeyCloud.Look(AiKeyRemote(AiKeyRemote.NONE), AiSettings(), null) }
                    say(context.getString(R.string.ai_removed_all), false)
                } catch (error: CancellationException) { throw error }
                catch (error: AiKeyCloud.Refused) { say(AiKeyCloud.reasonText(context, error), true) }
            }
        },
        onHere = { removing = false; store.clear(); showSaved(AiSettings()); look = look?.let { AiKeyCloud.Look(it.remote, AiSettings(), null) }; say(context.getString(R.string.ai_removed_here), false) },
        onCancel = { removing = false },
    )

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

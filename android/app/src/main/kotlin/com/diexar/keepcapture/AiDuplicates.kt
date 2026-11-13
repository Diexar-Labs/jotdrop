package com.diexar.keepcapture

import android.content.Context
import android.net.Uri
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.diexar.keepcapture.ui.JotDropTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.time.Instant

/**
 * "Keep both" from Find duplicates, remembered on this phone only and never synced, as the web app keeps its list
 * on its own device. A note is known here by its place (Uri), because Android has no other lasting id for a note.
 */
object DuplicatesKept {
    private const val PREFS = "jotdrop_duplicates"
    private const val KEY = "kept"
    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    fun load(context: Context): Set<String> = prefs(context).getStringSet(KEY, emptySet())!!.toSet()
    fun add(context: Context, key: String) { prefs(context).edit().putStringSet(KEY, load(context) + key).apply() }
}

/**
 * Find duplicates (Ask JotDrop v2, part E): compared on this phone with Similar, without AI and without sending
 * anything. Per pair: Compare, the trash for the note Similar offers (always named), Keep both and, when Ask
 * JotDrop is on, Merge with AI, which opens the ask screen with only these two notes.
 */
class DuplicatesActivity : ThemedComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent { JotDropTheme { DuplicatesScreen(onClose = { finish() }) } }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun DuplicatesScreen(onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val executor = remember { AiExecutor(context) { uri -> context.startActivity(EditorActivity.openNoteIntent(context, uri)) } }
    val aiOn = remember { AiSecretStore(context).load().on }
    // The notes with their place as id, so that Keep both and the trash outlive this screen.
    var notes by remember { mutableStateOf<List<AiNote>>(emptyList()) }
    var result by remember { mutableStateOf<SimilarResult?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var open by remember { mutableStateOf<String?>(null) }

    suspend fun search() {
        val now = notes
        val kept = DuplicatesKept.load(context)
        result = withContext(Dispatchers.Default) { Similar.findDuplicates(now, kept) }
    }

    LaunchedEffect(Unit) {
        executor.load()
        notes = executor.notes.mapNotNull { note -> executor.uriOf(note.id)?.let { note.copy(id = it.toString()) } }
        search()
    }

    val byId = notes.associateBy { it.id }
    fun title(id: String) = AiAsk.shortTitle(byId[id]?.title.orEmpty()).ifBlank { context.getString(R.string.ai_untitled) }
    fun edited(id: String) = byId[id]?.updatedAt?.let { runCatching { DateFormat.getDateInstance(DateFormat.MEDIUM).format(java.util.Date(Instant.parse(it).toEpochMilli())) }.getOrNull() }
        ?.let { context.getString(R.string.dup_edited, it) } ?: context.getString(R.string.dup_no_date)

    Scaffold(topBar = {
        TopAppBar(title = { Text(stringResource(R.string.dup_title)) },
            navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.ai_back)) } })
    }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Text(stringResource(R.string.dup_intro), style = MaterialTheme.typography.bodySmall) }
            val found = result
            if (found == null) {
                item {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                    Text(stringResource(R.string.dup_looking), style = MaterialTheme.typography.bodySmall)
                }
                return@LazyColumn
            }
            item {
                val more = if (found.complete) "" else " " + stringResource(R.string.dup_incomplete)
                Text(when {
                    found.pairs.isNotEmpty() -> pluralStringResource(R.plurals.dup_found, found.pairs.size, found.pairs.size) + more
                    found.complete -> stringResource(R.string.dup_none)
                    else -> stringResource(R.string.dup_none_incomplete)
                })
                problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
            items(found.pairs, key = { Similar.pairKey(it.a, it.b) }) { pair ->
                val key = Similar.pairKey(pair.a, pair.b)
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        // Words, not color: the kind is written out.
                        val percent = Math.round(pair.score * 100).toInt()
                        Text(when (pair.kind) {
                            "same" -> stringResource(R.string.dup_same)
                            "near" -> stringResource(R.string.dup_near, percent)
                            else -> stringResource(R.string.dup_inside, percent, title(pair.drop))
                        }, style = MaterialTheme.typography.titleSmall)
                        Text(stringResource(R.string.dup_older, title(pair.a), edited(pair.a)), style = MaterialTheme.typography.bodySmall)
                        Text(stringResource(R.string.dup_newer, title(pair.b), edited(pair.b)), style = MaterialTheme.typography.bodySmall)
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            OutlinedButton(onClick = { open = if (open == key) null else key }) { Text(stringResource(if (open == key) R.string.dup_compare_hide else R.string.dup_compare)) }
                            // The button names the note: the older one, or for "inside" the shorter one, never the one that holds more.
                            OutlinedButton(onClick = {
                                scope.launch {
                                    problem = null
                                    try {
                                        val uri = Uri.parse(pair.drop)
                                        ReminderScheduler.cancel(context, uri)
                                        withContext(Dispatchers.IO) { Storage.noteWriteMutex.withLock { Storage.trashNote(context, uri).getOrThrow() } }
                                        notes = notes.filter { it.id != pair.drop }
                                        search()
                                    } catch (error: CancellationException) {
                                        throw error
                                    } catch (_: Exception) { problem = context.getString(R.string.ai_error_save) }
                                }
                            }) { Text(stringResource(R.string.dup_trash, title(pair.drop)), maxLines = 2, overflow = TextOverflow.Ellipsis) }
                            OutlinedButton(onClick = { DuplicatesKept.add(context, key); scope.launch { search() } }) { Text(stringResource(R.string.dup_keep)) }
                            // Like the web app, this window closes: the ask screen takes over with the two notes.
                            if (aiOn) OutlinedButton(onClick = {
                                context.startActivity(AskActivity.mergeIntent(context, Uri.parse(pair.a), Uri.parse(pair.b)))
                                onClose()
                            }) { Text(stringResource(R.string.dup_merge)) }
                        }
                        if (open == key) DuplicateCompare(pair, title(pair.a), title(pair.b))
                    }
                }
            }
        }
    }
}

/** The two notes line by line, from the older to the newer: + was added, - was removed. Read when opened. */
@Composable
private fun DuplicateCompare(pair: SimilarPair, older: String, newer: String) {
    val context = LocalContext.current
    var lines by remember(pair) { mutableStateOf<List<CloudVersionDiff.Line>?>(null) }
    var read by remember(pair) { mutableStateOf(false) }
    LaunchedEffect(pair) {
        lines = withContext(Dispatchers.IO) {
            val a = Storage.readNote(context, Uri.parse(pair.a)).getOrNull()
            val b = Storage.readNote(context, Uri.parse(pair.b)).getOrNull()
            if (a == null || b == null) null else CloudVersionDiff.lines(a, b)
        }
        read = true
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        val shown = lines
        when {
            !read -> LinearProgressIndicator(Modifier.fillMaxWidth())
            shown == null -> Text(stringResource(R.string.dup_too_long), style = MaterialTheme.typography.bodySmall)
            else -> {
                Text(stringResource(R.string.dup_compare_intro, older, newer), style = MaterialTheme.typography.bodySmall)
                for (line in CloudVersionDiff.fold(shown)) when (line.kind) {
                    CloudVersionDiff.Kind.GAP -> Text(pluralStringResource(R.plurals.dup_unchanged, line.count, line.count), style = MaterialTheme.typography.bodySmall)
                    CloudVersionDiff.Kind.SAME -> Text("  ${line.text}", style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                    CloudVersionDiff.Kind.ADDED -> Text("+ ${line.text}", style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                    CloudVersionDiff.Kind.REMOVED -> Text("- ${line.text}", style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                }
            }
        }
    }
}

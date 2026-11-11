package com.diexar.keepcapture

import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.NoteAdd
import androidx.compose.material.icons.filled.PostAdd
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

private enum class ShareStep { CHOOSE, PICK_NOTE, SAVING }

/**
 * Share to JotDrop for files (11 Nov 2026): "New note" makes a note with the files, "Add to a note" puts them at the
 * end of a note picked from the recent ones (with a search field). The files are copied while this screen is open,
 * because the read permission the other app gave ends when the share screen closes.
 */
@Composable
internal fun ShareFilesChooser(files: List<Uri>, subject: String?, extraText: String?, onDone: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var step by remember { mutableStateOf(ShareStep.CHOOSE) }
    var problems by remember { mutableStateOf<List<String>>(emptyList()) }
    var finished by remember { mutableStateOf(false) }
    val names = remember(files) { files.map { Storage.displayName(context, it) ?: it.lastPathSegment.orEmpty() } }

    // Closing waits for the dialog with the files that were not attached.
    fun finish(outcome: Attachments.Outcome) {
        problems = outcome.problems
        finished = true
        if (problems.isEmpty()) onDone()
    }

    fun save(note: NoteSummary?) {
        step = ShareStep.SAVING
        scope.launch {
            val spaceId = note?.uri?.let(Storage::spaceIdOf)
            val outcome = withContext(Dispatchers.IO) { Attachments.copy(context, files, spaceId) }
            if (outcome.names.isNotEmpty()) {
                val result = withContext(Dispatchers.IO) {
                    if (note == null) Storage.saveFilesNote(context, outcome.names, subject, extraText, shownName = outcome.shown.firstOrNull())
                    else Storage.noteWriteMutex.withLock { Storage.appendAttachmentEmbeds(context, note.uri, outcome.names) }.map { note.title }
                }
                result.fold(
                    { saved ->
                        val text = if (note == null) context.getString(R.string.toast_saved, saved) else context.getString(R.string.share_added_to, saved)
                        Toast.makeText(context.applicationContext, text, Toast.LENGTH_SHORT).show()
                    },
                    { Toast.makeText(context.applicationContext, context.getString(R.string.toast_error, it.message ?: ""), Toast.LENGTH_LONG).show() },
                )
            }
            finish(outcome)
        }
    }

    BackHandler(enabled = step == ShareStep.PICK_NOTE) { step = ShareStep.CHOOSE }

    // A dim backdrop over the app the file came from; a tap next to the card cancels, like a dialog.
    // Once saved, only the dialog with the files that were not attached stays.
    if (!finished) Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.45f))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { if (step != ShareStep.SAVING) onDone() }
            .safeDrawingPadding()
            .imePadding(),
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            shape = RoundedCornerShape(20.dp),
            color = MaterialTheme.colorScheme.surface,
            tonalElevation = 6.dp,
            modifier = Modifier
                .padding(20.dp)
                .widthIn(max = 480.dp)
                .fillMaxWidth()
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {},
        ) {
            Column(Modifier.padding(20.dp)) {
                Text(stringResource(R.string.share_choice_title), style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.height(8.dp))
                for (name in names.take(CARD_FILE_CHIPS)) {
                    Text(name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (names.size > CARD_FILE_CHIPS) {
                    val more = names.size - CARD_FILE_CHIPS
                    Text(pluralStringResource(R.plurals.attach_more, more, more), style = MaterialTheme.typography.bodyMedium)
                }
                Spacer(Modifier.height(16.dp))
                when (step) {
                    ShareStep.CHOOSE -> {
                        Button(onClick = { save(null) }, modifier = Modifier.fillMaxWidth()) {
                            Icon(Icons.Filled.NoteAdd, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.size(8.dp))
                            Text(stringResource(R.string.share_new_note))
                        }
                        Spacer(Modifier.height(8.dp))
                        OutlinedButton(onClick = { step = ShareStep.PICK_NOTE }, modifier = Modifier.fillMaxWidth()) {
                            Icon(Icons.Filled.PostAdd, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.size(8.dp))
                            Text(stringResource(R.string.share_add_to_note))
                        }
                        Spacer(Modifier.height(4.dp))
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                            TextButton(onClick = onDone) { Text(stringResource(R.string.action_cancel)) }
                        }
                    }
                    ShareStep.PICK_NOTE -> NotePicker(onPick = ::save, onBack = { step = ShareStep.CHOOSE })
                    ShareStep.SAVING -> Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.size(12.dp))
                        Text(stringResource(R.string.share_saving))
                    }
                }
            }
        }
    }

    if (finished && problems.isNotEmpty()) AttachProblemsDialog(problems) { problems = emptyList(); onDone() }
}

/** The recent notes, newest first, with a search field on title and file name. Notes of a group that is closed are left out. */
@Composable
private fun NotePicker(onPick: (NoteSummary) -> Unit, onBack: () -> Unit) {
    val context = LocalContext.current
    var notes by remember { mutableStateOf<List<NoteSummary>?>(null) }
    var query by remember { mutableStateOf("") }
    LaunchedEffect(Unit) {
        notes = withContext(Dispatchers.IO) {
            Storage.listNotesForChooser(context).getOrDefault(emptyList())
                .filter { it.space?.let { space -> !space.frozen && !space.gone } ?: true }
                .sortedByDescending { it.lastModified }
        }
    }
    OutlinedTextField(
        value = query,
        onValueChange = { query = it },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
        placeholder = { Text(stringResource(R.string.share_search_hint)) },
    )
    Spacer(Modifier.height(8.dp))
    val all = notes
    if (all == null) {
        Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
    } else {
        val words = query.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
        val shown = all.filter { note -> words.all { word -> note.title.lowercase().contains(word) || note.filename.lowercase().contains(word) } }.take(100)
        if (shown.isEmpty()) {
            Text(stringResource(R.string.share_no_notes), modifier = Modifier.padding(vertical = 12.dp))
        } else {
            LazyColumn(Modifier.heightIn(max = 340.dp)) {
                items(shown, key = { it.uri.toString() }) { note ->
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clickable { onPick(note) }
                            .padding(vertical = 10.dp, horizontal = 4.dp),
                    ) {
                        Text(
                            note.title.ifBlank { note.filename.removeSuffix(".md") },
                            style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        note.space?.let { Text(it.name, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1) }
                    }
                    HorizontalDivider()
                }
            }
        }
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        TextButton(onClick = onBack) { Text(stringResource(R.string.action_back)) }
    }
}

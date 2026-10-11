package com.diexar.keepcapture

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.triStateToggleable
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun JotDropDrawer(
    labels: List<String>,
    folder: NoteFolder,
    remindersOnly: Boolean,
    selectedLabel: String?,
    onNavigate: (NoteFolder, Boolean, String?) -> Unit,
    onManageLabels: () -> Unit,
    onSettings: () -> Unit,
    onHelp: () -> Unit,
) {
    ModalDrawerSheet {
        LazyColumn(Modifier.fillMaxHeight().widthIn(max = 320.dp)) {
            item {
                Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineSmall,
                    modifier = Modifier.padding(horizontal = 28.dp, vertical = 24.dp))
                NavigationDrawerItem(
                    label = { Text(stringResource(R.string.nav_notes)) },
                    icon = { Icon(Icons.Filled.Lightbulb, null) },
                    selected = folder == NoteFolder.NOTES && !remindersOnly && selectedLabel == null,
                    onClick = { onNavigate(NoteFolder.NOTES, false, null) },
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
                NavigationDrawerItem(
                    label = { Text(stringResource(R.string.nav_reminders)) },
                    icon = { Icon(Icons.Filled.NotificationsNone, null) },
                    selected = folder == NoteFolder.NOTES && remindersOnly,
                    onClick = { onNavigate(NoteFolder.NOTES, true, null) },
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
                HorizontalDivider(Modifier.padding(vertical = 12.dp))
                Row(Modifier.fillMaxWidth().padding(start = 28.dp, end = 12.dp)) {
                    Text(stringResource(R.string.nav_labels), style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.weight(1f).padding(top = 14.dp))
                    TextButton(onClick = onManageLabels) { Text(stringResource(R.string.nav_edit_labels)) }
                }
            }
            items(labels, key = { it }) { label ->
                NavigationDrawerItem(
                    label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    icon = { Icon(Icons.Filled.Label, null) },
                    selected = folder == NoteFolder.NOTES && label.equals(selectedLabel, true),
                    onClick = { onNavigate(NoteFolder.NOTES, false, label) },
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
            }
            item {
                NavigationDrawerItem(
                    label = { Text(stringResource(R.string.nav_create_label)) },
                    icon = { Icon(Icons.Filled.Add, null) },
                    selected = false, onClick = onManageLabels,
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
                HorizontalDivider(Modifier.padding(vertical = 12.dp))
                NavigationDrawerItem(
                    label = { Text(stringResource(R.string.nav_archive)) },
                    icon = { Icon(Icons.Filled.Archive, null) },
                    selected = folder == NoteFolder.ARCHIVE,
                    onClick = { onNavigate(NoteFolder.ARCHIVE, false, null) },
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
                NavigationDrawerItem(
                    label = { Text(stringResource(R.string.nav_trash)) },
                    icon = { Icon(Icons.Filled.DeleteOutline, null) },
                    selected = folder == NoteFolder.TRASH,
                    onClick = { onNavigate(NoteFolder.TRASH, false, null) },
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
                NavigationDrawerItem(
                    label = { Text(stringResource(R.string.action_settings)) },
                    icon = { Icon(Icons.Filled.Settings, null) },
                    selected = false, onClick = onSettings,
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
                NavigationDrawerItem(
                    label = { Text(stringResource(R.string.nav_help)) },
                    icon = { Icon(Icons.Filled.HelpOutline, null) },
                    selected = false, onClick = onHelp,
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
                Spacer(Modifier.height(24.dp))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun LabelManagerSheet(labels: List<String>, onChanged: () -> Unit, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf<String?>(null) }
    var deleting by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun save() {
        val normalized = LabelNames.normalized(name)
        if (normalized == null) {
            error = context.getString(R.string.label_invalid)
            return
        }
        if (labels.any { it.equals(normalized, true) && !it.equals(editing, true) }) {
            error = context.getString(R.string.label_duplicate)
            return
        }
        val old = editing
        busy = true
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                if (old == null) Storage.addLabel(context, normalized)
                else Storage.renameLabel(context, old, normalized)
            }
            busy = false
            result.onSuccess {
                name = ""
                editing = null
                error = null
                onChanged()
            }.onFailure {
                error = it.message ?: context.getString(R.string.error_unknown)
                onChanged()
            }
        }
    }

    ModalBottomSheet(onDismissRequest = { if (!busy) onDismiss() },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
            Text(stringResource(R.string.nav_edit_labels), style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(
                value = name, onValueChange = { name = it; error = null }, enabled = !busy,
                label = { Text(stringResource(if (editing == null) R.string.nav_create_label else R.string.label_rename)) },
                singleLine = true, isError = error != null,
                supportingText = { Text(error ?: stringResource(R.string.label_hint)) },
                modifier = Modifier.fillMaxWidth(),
            )
            Row {
                TextButton(onClick = ::save, enabled = !busy && name.isNotBlank()) {
                    Text(stringResource(if (editing == null) R.string.nav_create_label else R.string.action_save))
                }
                if (editing != null) TextButton(onClick = { editing = null; name = ""; error = null }, enabled = !busy) {
                    Text(stringResource(R.string.action_cancel))
                }
            }
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = false)) {
                items(labels, key = { it }) { label ->
                    ListItem(
                        headlineContent = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        leadingContent = { Icon(Icons.Filled.Label, null) },
                        trailingContent = {
                            Row {
                                IconButton(onClick = { editing = label; name = label; error = null }, enabled = !busy) {
                                    Icon(Icons.Filled.Edit, stringResource(R.string.label_rename))
                                }
                                IconButton(onClick = { deleting = label }, enabled = !busy) {
                                    Icon(Icons.Filled.DeleteOutline, stringResource(R.string.label_delete))
                                }
                            }
                        },
                    )
                }
            }
            TextButton(onClick = onDismiss, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.action_close))
            }
            Spacer(Modifier.height(16.dp))
        }
    }
    deleting?.let { label ->
        AlertDialog(
            onDismissRequest = { if (!busy) deleting = null },
            title = { Text(stringResource(R.string.label_delete)) },
            text = { Text(stringResource(R.string.label_delete_message, label)) },
            confirmButton = {
                TextButton(enabled = !busy, onClick = {
                    busy = true
                    scope.launch {
                        val result = withContext(Dispatchers.IO) { Storage.renameLabel(context, label, null) }
                        busy = false
                        deleting = null
                        result.onFailure { error = it.message ?: context.getString(R.string.error_unknown) }
                        onChanged()
                    }
                }) { Text(stringResource(R.string.action_delete)) }
            },
            dismissButton = { TextButton(onClick = { deleting = null }, enabled = !busy) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun LabelAssignmentSheet(
    labels: List<String>,
    selectedLabels: Set<String>,
    mixedLabels: Set<String> = emptySet(),
    onApply: suspend (Set<String>, Set<String>) -> Result<Unit>,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    var names by remember { mutableStateOf((labels + selectedLabels + mixedLabels).distinctBy { it.lowercase() }) }
    val changes = remember { mutableStateMapOf<String, Boolean>() }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(labels) { names = (names + labels).distinctBy { it.lowercase() } }

    fun state(name: String): ToggleableState = when {
        changes.containsKey(name.lowercase()) -> if (changes[name.lowercase()] == true) ToggleableState.On else ToggleableState.Off
        selectedLabels.any { it.equals(name, true) } -> ToggleableState.On
        mixedLabels.any { it.equals(name, true) } -> ToggleableState.Indeterminate
        else -> ToggleableState.Off
    }

    ModalBottomSheet(onDismissRequest = { if (!busy) onDismiss() },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().imePadding().padding(horizontal = 16.dp)) {
            Text(stringResource(R.string.nav_labels), style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(
                value = query, onValueChange = { query = it; error = null }, enabled = !busy,
                label = { Text(stringResource(R.string.label_search)) }, singleLine = true,
                modifier = Modifier.fillMaxWidth(), isError = error != null,
                supportingText = { if (error != null) Text(error!!) },
            )
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (query.isNotBlank() && names.none { it.equals(query.trim(), true) }) {
                TextButton(enabled = !busy, onClick = {
                    val name = LabelNames.normalized(query)
                    if (name == null) { error = context.getString(R.string.label_invalid); return@TextButton }
                    busy = true
                    scope.launch {
                        val result = withContext(Dispatchers.IO) { Storage.addLabel(context, name) }
                        busy = false
                        result.onSuccess {
                            names = (names + name).distinctBy { it.lowercase() }
                            changes[name.lowercase()] = true
                            query = ""
                        }.onFailure { error = it.message ?: context.getString(R.string.error_unknown) }
                    }
                }) {
                    Icon(Icons.Filled.Add, null)
                    Spacer(Modifier.width(8.dp))
                    Text("${stringResource(R.string.nav_create_label)}: ${query.trim()}")
                }
            }
            LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = false)) {
                items(names.filter { it.contains(query.trim(), true) }.sortedBy { it.lowercase() }, key = { it }) { name ->
                    val checked = state(name)
                    ListItem(
                        headlineContent = { Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        leadingContent = { Icon(Icons.Filled.Label, null) },
                        trailingContent = { TriStateCheckbox(state = checked, onClick = null, enabled = !busy) },
                        modifier = Modifier.triStateToggleable(
                            state = checked, enabled = !busy, role = Role.Checkbox,
                            onClick = { changes[name.lowercase()] = checked != ToggleableState.On },
                        ),
                    )
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onDismiss, enabled = !busy) { Text(stringResource(R.string.action_cancel)) }
                TextButton(enabled = !busy, onClick = {
                    busy = true
                    scope.launch {
                        val added = names.filter { changes[it.lowercase()] == true }.toSet()
                        val removed = names.filter { changes[it.lowercase()] == false }.toSet()
                        val result = try { onApply(added, removed) } catch (e: Exception) { Result.failure(e) }
                        busy = false
                        result.onSuccess { onDismiss() }
                            .onFailure { error = it.message ?: context.getString(R.string.error_unknown) }
                    }
                }) { Text(stringResource(R.string.action_save)) }
            }
            Spacer(Modifier.height(16.dp))
        }
    }
}

package com.diexar.keepcapture

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp

/**
 * Pick a folder in the vault, like the plugin's "Move to folder…" picker.
 * [folders] is null while the vault is still being read; "" is the vault root.
 */
@Composable
fun FolderPickerDialog(
    title: String,
    hint: String?,
    folders: List<String>?,
    onPick: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var query by remember { mutableStateOf("") }
    val rootLabel = stringResource(R.string.folder_root_label)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column {
                if (hint != null) {
                    Text(hint, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(bottom = 8.dp))
                }
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    label = { Text(stringResource(R.string.folder_picker_search)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (folders == null) {
                    CircularProgressIndicator(Modifier.padding(16.dp))
                } else {
                    val q = query.trim().lowercase()
                    val shown = folders.filter { q.isEmpty() || it.lowercase().contains(q) }
                    if (shown.isEmpty()) {
                        Text(stringResource(R.string.folder_picker_empty), Modifier.padding(vertical = 12.dp))
                    }
                    LazyColumn(Modifier.heightIn(max = 320.dp)) {
                        items(shown) { folder ->
                            Text(
                                text = folder.ifEmpty { rootLabel },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { onPick(folder) }
                                    .padding(vertical = 12.dp),
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

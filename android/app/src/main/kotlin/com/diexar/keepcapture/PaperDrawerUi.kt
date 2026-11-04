package com.diexar.keepcapture

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.EventBusy
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** "Expires 12 Mar 2027" or "Expired 12 Mar 2027": an icon and a word, never only a colour. */
@Composable
internal fun ExpiresBadge(expires: String, foreground: Color) {
    val day = LocalDate.parse(expires)
    val expired = PaperDrawer.isExpired(expires, LocalDate.now())
    val date = day.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))
    Surface(
        color = foreground.copy(alpha = if (expired) 0.16f else 0.08f),
        contentColor = foreground,
        shape = RoundedCornerShape(10.dp),
        border = if (expired) BorderStroke(1.dp, foreground.copy(alpha = 0.6f)) else null,
    ) {
        Row(modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.EventBusy, contentDescription = null, modifier = Modifier.size(12.dp))
            Spacer(Modifier.size(4.dp))
            Text(
                text = stringResource(if (expired) R.string.expires_badge_expired else R.string.expires_badge, date),
                style = MaterialTheme.typography.labelSmall.copy(fontWeight = if (expired) FontWeight.Bold else FontWeight.Normal),
            )
        }
    }
}

/** Expiry date plus an optional warning before it. Saving a date puts the note in the Paper drawer. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ExpiresDialog(initial: String?, onSave: (String?, String?) -> Unit, onDismiss: () -> Unit) {
    var day by remember { mutableStateOf(initial ?: LocalDate.now().plusYears(1).toString()) }
    var lead by remember { mutableStateOf<String?>(null) }
    var picking by remember { mutableStateOf(false) }
    val leads = listOf(
        null to R.string.expires_warn_none,
        "1w" to R.string.expires_warn_1w,
        "1m" to R.string.expires_warn_1m,
        "2m" to R.string.expires_warn_2m,
        "3m" to R.string.expires_warn_3m,
    )
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.action_expires)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                OutlinedButton(onClick = { picking = true }, modifier = Modifier.fillMaxWidth()) {
                    Text(LocalDate.parse(day).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG)))
                }
                Text(stringResource(R.string.expires_warn_title), style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp))
                for ((key, text) in leads) {
                    Row(
                        modifier = Modifier.fillMaxWidth().selectable(selected = lead == key, role = Role.RadioButton) { lead = key },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = lead == key, onClick = null)
                        Text(stringResource(text), modifier = Modifier.padding(start = 8.dp))
                    }
                }
                Text(stringResource(R.string.expires_help), style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = { TextButton(onClick = { onSave(day, lead) }) { Text(stringResource(R.string.action_save)) } },
        dismissButton = {
            Row {
                if (initial != null) TextButton(onClick = { onSave(null, null) }) { Text(stringResource(R.string.expires_clear)) }
                TextButton(onClick = onDismiss) { Text(stringResource(android.R.string.cancel)) }
            }
        },
    )
    if (picking) {
        val state = rememberDatePickerState(
            initialSelectedDateMillis = LocalDate.parse(day).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),
        )
        DatePickerDialog(
            onDismissRequest = { picking = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { millis ->
                        day = java.time.Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate().toString()
                    }
                    picking = false
                }) { Text(stringResource(android.R.string.ok)) }
            },
            dismissButton = { TextButton(onClick = { picking = false }) { Text(stringResource(android.R.string.cancel)) } },
        ) {
            DatePicker(state = state)
        }
    }
}

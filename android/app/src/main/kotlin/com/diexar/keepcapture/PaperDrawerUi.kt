package com.diexar.keepcapture

import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Alarm
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.material.icons.filled.DocumentScanner
import androidx.compose.material.icons.filled.EventBusy
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
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
    // A new expiry date warns a week before unless the user picks otherwise.
    var lead by remember { mutableStateOf(if (initial == null) PaperDrawer.DEFAULT_WARN else null) }
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
    if (picking) DayPicker(day, onPick = { day = it }, onDismiss = { picking = false })
}

/** A calendar to pick one day ("YYYY-MM-DD"); day is where it opens, today when it is null. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DayPicker(day: String?, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    val state = rememberDatePickerState(
        initialSelectedDateMillis = (day?.let(LocalDate::parse) ?: LocalDate.now()).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),
    )
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = {
                state.selectedDateMillis?.let { millis -> onPick(java.time.Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate().toString()) }
                onDismiss()
            }) { Text(stringResource(android.R.string.ok)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(android.R.string.cancel)) } },
    ) {
        DatePicker(state = state)
    }
}

internal const val PAPER_PREFS = "paper_drawer"
internal const val PAPER_TIP_CLOSED = "tip_closed"

/** A finished scan waiting for its drawer and expiry date. */
internal data class PendingScan(val pdf: Uri?, val firstPage: Uri?, val text: String, val title: String, val expires: String?)

private val INTRO_POINTS = listOf(
    Icons.Filled.DocumentScanner to R.string.paper_intro_scan,
    Icons.Filled.Search to R.string.paper_intro_search,
    Icons.Filled.Alarm to R.string.paper_intro_alarm,
)

@Composable
private fun IntroPoint(icon: ImageVector, text: Int) {
    Row(verticalAlignment = Alignment.Top, modifier = Modifier.padding(vertical = 6.dp)) {
        Icon(icon, contentDescription = null, modifier = Modifier.padding(top = 2.dp).size(20.dp))
        Spacer(Modifier.size(12.dp))
        Text(stringResource(text), style = MaterialTheme.typography.bodyMedium)
    }
}

/** An empty Paper drawer explains what it does, so the first visit shows why it is worth using. */
@Composable
internal fun PaperDrawerIntro(onScan: () -> Unit) {
    // Outside a Surface the text would stay black, also in the dark theme. Kept at the top and clear of the floating buttons.
    CompositionLocalProvider(LocalContentColor provides MaterialTheme.colorScheme.onBackground) {
    Box(Modifier.fillMaxSize().padding(start = 24.dp, top = 32.dp, end = 88.dp), contentAlignment = Alignment.TopStart) {
        Column(Modifier.widthIn(max = 420.dp)) {
            Text(stringResource(R.string.paper_intro_title), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(6.dp))
            Text(stringResource(R.string.paper_intro_lead), style = MaterialTheme.typography.bodyLarge)
            Spacer(Modifier.height(12.dp))
            for ((icon, text) in INTRO_POINTS) IntroPoint(icon, text)
            Spacer(Modifier.height(16.dp))
            Button(onClick = onScan, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Filled.DocumentScanner, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.size(8.dp))
                Text(stringResource(R.string.action_scan_document))
            }
        }
    }
    }
}

/** The same three points as a small tip above the papers, until the user closes it. */
@Composable
internal fun PaperDrawerTip(onClose: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        Row(Modifier.padding(start = 14.dp, top = 6.dp, bottom = 8.dp)) {
            Column(Modifier.weight(1f).padding(top = 6.dp)) {
                for ((icon, text) in INTRO_POINTS) IntroPoint(icon, text)
            }
            IconButton(onClick = onClose) {
                Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.paper_tip_close))
            }
        }
    }
}

/** Which drawer a paper goes in: the Paper drawer, one of its small drawers, or a new one typed in. */
internal class DrawerChoice(initial: String) {
    var drawer by mutableStateOf(initial)
    var adding by mutableStateOf(false)
    var newName by mutableStateOf("")
    /** The label: "Paper drawer" or "Paper drawer/Work". */
    fun chosen(): String = if (adding && newName.isNotBlank()) PaperDrawer.drawerLabel(newName) else drawer
}

/** The drawers as chips; the chosen one has a check mark, never only a colour. drawers: small-drawer labels. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun DrawerChips(choice: DrawerChoice, drawers: List<String>) {
    val check: @Composable () -> Unit = { Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(16.dp)) }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        val base = !choice.adding && choice.drawer == PaperDrawer.LABEL
        FilterChip(selected = base, onClick = { choice.adding = false; choice.drawer = PaperDrawer.LABEL }, label = { Text(PaperDrawer.LABEL) }, leadingIcon = if (base) check else null)
        for (label in drawers) {
            val chosen = !choice.adding && choice.drawer == label
            FilterChip(selected = chosen, onClick = { choice.adding = false; choice.drawer = label }, label = { Text(PaperDrawer.drawerName(label)) }, leadingIcon = if (chosen) check else null)
        }
        FilterChip(
            selected = choice.adding,
            onClick = { choice.adding = true },
            label = { Text(stringResource(R.string.scan_save_new_drawer)) },
            leadingIcon = { Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(16.dp)) },
        )
    }
    if (choice.adding) {
        OutlinedTextField(
            value = choice.newName,
            onValueChange = { choice.newName = it.replace("/", "").take(40) },
            label = { Text(stringResource(R.string.scan_save_drawer_name)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/** After a scan: which small drawer, and keep the expiry date found on the paper with a warning a week before. */
@Composable
internal fun ScanSaveDialog(expiresFound: String?, drawers: List<String>, onSave: (String, String?, String?) -> Unit) {
    val choice = remember { DrawerChoice(PaperDrawer.LABEL) }
    var keepExpiry by remember { mutableStateOf(expiresFound != null) }
    val save = {
        val chosen = choice.chosen()
        val expires = expiresFound?.takeIf { keepExpiry }
        // A date that is less than a week away or past is kept for the badge, without a reminder that would go off at once.
        val lead = expires?.takeIf { !LocalDate.parse(it).minusDays(7).isBefore(LocalDate.now()) }?.let { PaperDrawer.DEFAULT_WARN }
        onSave(chosen, expires, lead)
    }
    AlertDialog(
        // Closing the box still keeps the scan, in the drawer chosen so far.
        onDismissRequest = save,
        title = { Text(stringResource(R.string.scan_save_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                DrawerChips(choice, drawers)
                if (expiresFound != null) {
                    val date = LocalDate.parse(expiresFound).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth().toggleable(value = keepExpiry, role = Role.Checkbox) { keepExpiry = it },
                    ) {
                        Checkbox(checked = keepExpiry, onCheckedChange = null)
                        Spacer(Modifier.size(8.dp))
                        Text(stringResource(R.string.scan_save_expires, date))
                    }
                } else {
                    Text(stringResource(R.string.scan_save_no_expiry), style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Start)
                }
            }
        },
        confirmButton = { TextButton(onClick = save) { Text(stringResource(R.string.action_save)) } },
    )
}

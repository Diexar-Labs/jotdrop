package com.diexar.keepcapture

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * "Receipt to Paper drawer": what the AI read, in one screen to check and change, as the web app has it. Nothing is
 * saved before Apply. The AI's answer is only data here: AiReceipt.parse checked every field, and the app works out
 * the keep date itself (AiReceipt.keepUntil). Without a date on the receipt it keeps 2 years from the day of purchase
 * (Eric, 12 Nov 2026, as the web app).
 *
 * drawer: the note's Paper drawer label now ("Paper drawer" when it has none); drawers: small-drawer labels to offer.
 * onApply gets the title, the drawer label, the keep date and the lines to add.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ReceiptCard(
    receipt: AiReceiptData, noteTitle: String, drawer: String, drawers: List<String>, busy: Boolean,
    onApply: (String, String, String, String) -> Unit, onSkip: () -> Unit,
) {
    var name by remember { mutableStateOf(receipt.title.orEmpty()) }
    val choice = remember { DrawerChoice(drawer) }
    var bought by remember { mutableStateOf(receipt.bought.orEmpty()) }
    var until by remember { mutableStateOf(receipt.warrantyUntil ?: AiReceipt.keepUntil(receipt.bought.orEmpty(), 2)) }
    var lines by remember { mutableStateOf(AiReceipt.lines(receipt)) }
    var picking by remember { mutableStateOf<String?>(null) }
    val check: @Composable () -> Unit = { Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(16.dp)) }
    fun shown(day: String) = PaperDrawer.validExpires(day)?.let { LocalDate.parse(it).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG)) }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.ai_receipt_title), style = MaterialTheme.typography.titleMedium)
            Text(stringResource(R.string.ai_receipt_intro), style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(name, { name = it.take(120) }, label = { Text(stringResource(R.string.ai_receipt_name)) },
                placeholder = { if (noteTitle.isNotBlank()) Text(noteTitle) }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Text(stringResource(R.string.ai_receipt_drawer), style = MaterialTheme.typography.titleSmall)
            DrawerChips(choice, drawers)
            Text(stringResource(R.string.ai_receipt_bought), style = MaterialTheme.typography.titleSmall)
            OutlinedButton(onClick = { picking = "bought" }, modifier = Modifier.fillMaxWidth()) {
                Text(shown(bought) ?: stringResource(R.string.ai_receipt_pick_date))
            }
            Text(stringResource(R.string.ai_receipt_keep), style = MaterialTheme.typography.titleSmall)
            // The keep buttons count from the day of purchase; the chosen one carries a check mark, not only a colour.
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (years in AiReceipt.KEEP_YEARS) {
                    val date = AiReceipt.keepUntil(bought, years)
                    val on = date.isNotEmpty() && date == until
                    FilterChip(selected = on, enabled = date.isNotEmpty(), onClick = { until = date },
                        label = { Text(pluralStringResource(R.plurals.ai_receipt_years, years, years)) }, leadingIcon = if (on) check else null)
                }
                receipt.warrantyUntil?.let { printed ->
                    val on = printed == until
                    FilterChip(selected = on, onClick = { until = printed }, label = { Text(stringResource(R.string.ai_receipt_printed)) }, leadingIcon = if (on) check else null)
                }
            }
            if (PaperDrawer.validExpires(bought) == null) Text(stringResource(R.string.ai_receipt_need_bought), style = MaterialTheme.typography.bodySmall)
            Text(stringResource(R.string.ai_receipt_until), style = MaterialTheme.typography.titleSmall)
            OutlinedButton(onClick = { picking = "until" }, modifier = Modifier.fillMaxWidth()) {
                Text(shown(until) ?: stringResource(R.string.ai_receipt_pick_date))
            }
            OutlinedTextField(lines, { lines = it.take(400) }, label = { Text(stringResource(R.string.ai_receipt_lines)) },
                modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(enabled = !busy, onClick = { onApply(name, choice.chosen(), until, lines) }) { Text(stringResource(R.string.ai_receipt_apply)) }
                OutlinedButton(enabled = !busy, onClick = onSkip) { Text(stringResource(R.string.ai_receipt_skip)) }
            }
        }
    }
    picking?.let { field ->
        DayPicker(PaperDrawer.validExpires(if (field == "bought") bought else until), onPick = { if (field == "bought") bought = it else until = it }, onDismiss = { picking = null })
    }
}

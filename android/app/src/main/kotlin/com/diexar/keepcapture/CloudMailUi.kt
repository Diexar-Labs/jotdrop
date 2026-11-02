package com.diexar.keepcapture

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * The Mail to JotDrop card in JotDrop Cloud: the secret address, a new one, the sender filter and off.
 * Google Play: the card names JotDrop Plus and the website, with no price, link or button to a checkout.
 */
@Composable
fun CloudMailSection(busy: Boolean, mail: JSONObject?, run: (suspend () -> Unit) -> Unit, cloud: suspend () -> CloudClient, onMail: (JSONObject?) -> Unit) {
    if (mail == null) { Text("Mail to JotDrop appears here after the next sync.", style = MaterialTheme.typography.bodyMedium); return }
    val clipboard = LocalClipboardManager.current
    var plain by remember(mail.toString()) { mutableStateOf<JSONObject?>(null) }
    var confirmRotate by rememberSaveable { mutableStateOf(false) }
    var confirmOff by rememberSaveable { mutableStateOf(false) }
    var senderList by rememberSaveable { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }

    suspend fun register(rotate: Boolean, senders: List<String>) {
        val client = cloud()
        withContext(Dispatchers.IO) {
            val scalar = CloudMail.derivedScalar(client.credentials.vaultKey)
            val address = if (!rotate) plain?.optString("address")?.takeIf { it.isNotEmpty() } ?: CloudMail.newAddress(mail.getString("domain")) else CloudMail.newAddress(mail.getString("domain"))
            val sealed = CloudCrypto.encrypt(client.credentials.vaultKey, JSONObject().put("address", address).put("senders", JSONArray(senders)).toString().toByteArray(Charsets.UTF_8), "jotdrop:mail-address:v1")
            val body = JSONObject().put("action", "enable").put("publicKey", CloudMail.publicKey(scalar)).put("addressHash", CloudMail.addressHash(address))
                .put("addressEnvelope", JSONObject().put("v", 1).put("iv", sealed.iv).put("ciphertext", sealed.ciphertext).toString())
                .put("mode", if (mail.optBoolean("enabled") && mail.optString("mode") == "senders") "senders" else "open")
            onMail(client.call("/mail", "POST", body).optJSONObject("mail"))
        }
    }

    // The sealed copy of the address opens only here, with the vault key.
    LaunchedEffect(mail.toString()) {
        plain = if (!mail.optBoolean("enabled")) null else try {
            val client = cloud()
            withContext(Dispatchers.IO) {
                val envelope = JSONObject(mail.getString("address"))
                require(envelope.optInt("v") == 1) { "Unsupported envelope" }
                JSONObject(String(CloudCrypto.decrypt(client.credentials.vaultKey, CloudEnvelope(envelope.getString("iv"), envelope.getString("ciphertext")), "jotdrop:mail-address:v1"), Charsets.UTF_8))
            }
        } catch (error: Exception) { JSONObject() }
    }

    Text("Email anything to your own secret address and it becomes a note here, attachments included. Our server seals every incoming mail the moment it arrives, with a key only your devices hold.", style = MaterialTheme.typography.bodyMedium)
    if (!mail.optBoolean("enabled")) {
        // Google Play allows naming the website, without a link or button, when the app sells nothing itself.
        Text("Mail to JotDrop is part of JotDrop Plus. Upgrade on our website.", style = MaterialTheme.typography.bodySmall)
        Button(onClick = { run { register(rotate = false, senders = emptyList()); notice = "Mail to JotDrop is on." } }, enabled = !busy && !mail.optString("domain").isNullOrEmpty(),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Turn on Mail to JotDrop") }
        if (mail.optInt("pending") > 0) Text("${mail.optInt("pending")} sealed mail(s) from before are still waiting and will still become notes.", style = MaterialTheme.typography.bodySmall)
        notice?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        return
    }
    val address = plain?.optString("address").orEmpty()
    Text("Your secret address", style = MaterialTheme.typography.titleSmall)
    SelectionContainer { Text(if (address.isNotEmpty()) address else "The address could not be read on this device.", style = MaterialTheme.typography.bodyLarge) }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(onClick = { clipboard.setText(AnnotatedString(address)); notice = "Address copied." }, enabled = !busy && address.isNotEmpty(), modifier = Modifier.heightIn(min = 48.dp)) { Text("Copy address") }
        Spacer(Modifier.width(10.dp))
        OutlinedButton(onClick = { confirmRotate = true }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("New address") }
    }
    Text("Anyone who knows this address can mail into your notes, so treat it like a key.", style = MaterialTheme.typography.bodySmall)
    if (mail.optInt("pending") > 0) Text("${if (mail.optInt("pending") == 1) "1 mail is" else "${mail.optInt("pending")} mails are"} waiting to become notes. The next sync picks ${if (mail.optInt("pending") == 1) "it" else "them"} up.", style = MaterialTheme.typography.bodyMedium)
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Only accept mail from senders I list", style = MaterialTheme.typography.titleSmall)
            Text("A sender address can be faked: a filter against noise, not proof.", style = MaterialTheme.typography.bodySmall)
        }
        Switch(checked = mail.optString("mode") == "senders", onCheckedChange = { strict ->
            run {
                val client = cloud()
                withContext(Dispatchers.IO) { onMail(client.call("/mail", "POST", JSONObject().put("action", "mode").put("mode", if (strict) "senders" else "open")).optJSONObject("mail")) }
            }
        }, enabled = !busy, modifier = Modifier.semantics { contentDescription = "Only accept mail from listed senders" })
    }
    if (mail.optString("mode") == "senders") {
        val shown = senderList ?: (plain?.optJSONArray("senders")?.let { list -> List(list.length()) { index -> list.optString(index) } } ?: emptyList()).joinToString("\n")
        OutlinedTextField(value = shown, onValueChange = { senderList = it }, label = { Text("Allowed senders, one address per line") },
            modifier = Modifier.fillMaxWidth(), enabled = !busy, minLines = 2)
        OutlinedButton(onClick = {
            val senders = shown.split("\n").map { it.trim().lowercase() }.filter { it.isNotEmpty() }.distinct()
            if (senders.any { !it.contains('@') || it.length > 320 } || senders.size > 200) { notice = "Use one full email address per line, at most 200."; return@OutlinedButton }
            run {
                val client = cloud()
                withContext(Dispatchers.IO) { client.call("/mail/senders", "POST", JSONObject().put("senders", JSONArray(senders.map(CloudMail::senderHash)))) }
                register(rotate = false, senders = senders)
                senderList = null
                notice = if (senders.isEmpty()) "The sender list is empty: no mail is accepted while the filter is on." else "Sender list saved: ${senders.size}."
            }
        }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Save sender list") }
    }
    TextButton(onClick = { confirmOff = true }, enabled = !busy) { Text("Turn off Mail to JotDrop") }
    notice?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }

    if (confirmRotate) AlertDialog(onDismissRequest = { confirmRotate = false }, title = { Text("Make a new secret address?") },
        text = { Text("The old address stops working at once. Use this when the address ended up with the wrong people.") },
        confirmButton = { TextButton(onClick = { confirmRotate = false; run { register(rotate = true, senders = plain?.optJSONArray("senders")?.let { list -> List(list.length()) { index -> list.optString(index) } } ?: emptyList()); notice = "This is your new address. The old one is gone." } }) { Text("New address") } },
        dismissButton = { TextButton(onClick = { confirmRotate = false }) { Text("Cancel") } })
    if (confirmOff) AlertDialog(onDismissRequest = { confirmOff = false }, title = { Text("Turn off Mail to JotDrop?") },
        text = { Text("The secret address stops working at once. Mail that already arrived stays and still becomes notes.") },
        confirmButton = { TextButton(onClick = { confirmOff = false; run { val client = cloud(); withContext(Dispatchers.IO) { onMail(client.call("/mail", "DELETE").optJSONObject("mail")) }; notice = "Mail to JotDrop is off." } }) { Text("Turn off") } },
        dismissButton = { TextButton(onClick = { confirmOff = false }) { Text("Cancel") } })
}

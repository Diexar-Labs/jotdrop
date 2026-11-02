package com.diexar.keepcapture

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Sharing a note from its card, on a page of its own (Eric, 2 Nov: the dialogs on top of the
 * cloud screen were stacked and unclear). First the choice between working together and a
 * read-only link, then numbered steps, and the link ready to send on the same page.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ShareNoteScreen(note: Uri, startWithLink: Boolean, onOpenCloud: () -> Unit, onClose: () -> Unit) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var connected by remember { mutableStateOf<Boolean?>(null) }
    var title by remember { mutableStateOf("") }
    var together by rememberSaveable { mutableStateOf(!startWithLink) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    // Working together.
    var groups by remember { mutableStateOf<List<KnownSpace>>(emptyList()) }
    var choice by rememberSaveable { mutableStateOf<String?>(null) }
    var newName by rememberSaveable { mutableStateOf("") }
    var me by rememberSaveable { mutableStateOf("") }
    var sharedIn by rememberSaveable { mutableStateOf<String?>(null) }
    var invite by rememberSaveable { mutableStateOf<String?>(null) }
    // Read-only link.
    var days by rememberSaveable { mutableStateOf(7) }
    var made by rememberSaveable { mutableStateOf<String?>(null) }
    var links by remember { mutableStateOf<List<CloudNoteLinks.Link>>(emptyList()) }

    suspend fun client(): CloudClient = withContext(Dispatchers.IO) { CloudSyncManager.client(context) ?: throw CloudSyncException("Sign in to JotDrop Cloud first.") }
    fun run(action: suspend () -> Unit) {
        if (busy) return
        busy = true
        error = null
        notice = null
        scope.launch {
            try { action() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: CloudRequestException) { error = failure.serverMessage ?: failure.message }
            catch (failure: Exception) { error = failure.message ?: "Something went wrong. Try again." }
            finally { busy = false }
        }
    }
    fun send(text: String, chooserTitle: String) {
        context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), chooserTitle))
    }
    suspend fun loadLinks() { val own = client(); links = withContext(Dispatchers.IO) { CloudNoteLinks.list(own) } }

    LaunchedEffect(note) {
        connected = withContext(Dispatchers.IO) { runCatching { CloudSyncManager.client(context) != null }.getOrDefault(false) }
        title = withContext(Dispatchers.IO) { Storage.readNote(context, note).map { CloudNoteLinks.parts(it).first }.getOrDefault("") }
        if (connected != true) return@LaunchedEffect
        groups = withContext(Dispatchers.IO) { CloudSpacesFlow.known(context).filter { !it.gone && !it.frozen } }
        runCatching {
            val own = client()
            if (me.isEmpty()) me = withContext(Dispatchers.IO) { CloudSpacesFlow.myName(own, CloudSpacesFlow.known(context)) }
        }
        runCatching { loadLinks() }
    }
    BackHandler(onBack = onClose)

    Scaffold(topBar = {
        TopAppBar(title = { Text("Share note") }, navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.Filled.Close, "Close") } })
    }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding).imePadding(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            item {
                Text(title.ifBlank { "Untitled note" }, style = MaterialTheme.typography.titleLarge, maxLines = 2)
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp))
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 8.dp)) }
                notice?.let { Text(it, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 8.dp)) }
            }
            if (connected == false) {
                item {
                    Text("Sharing goes through JotDrop Cloud. Sign in there first; it is free.", style = MaterialTheme.typography.bodyLarge)
                    Button(onClick = onOpenCloud, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(top = 12.dp)) { Text("Open JotDrop Cloud") }
                }
                return@LazyColumn
            }
            if (connected == null) return@LazyColumn
            // Step 0: how. Both choices are always visible, with a check mark and a label, not only a colour.
            if (sharedIn == null && made == null) item {
                Text("How do you want to share it?", style = MaterialTheme.typography.titleMedium)
                Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    ShareChoice(Icons.Filled.Group, "Work on it together", "The people you invite can read and change this note. They need a free JotDrop account.", together, !busy) { together = true }
                    ShareChoice(Icons.Filled.Link, "Send a read-only copy", "Anyone with the link can read a copy, without an account. Later changes do not go along. Photos and files stay out.", !together, !busy) { together = false }
                }
            }
            if (together) {
                val group = sharedIn
                if (group == null) {
                    item {
                        StepTitle(1, "Choose a group")
                        Text("The note moves into a shared group. Pin, labels, order and a reminder stay behind.", style = MaterialTheme.typography.bodySmall)
                        for (known in groups) RadioRow(choice == known.id, known.name.ifEmpty { "Shared group" } + if (known.others.isNotEmpty()) " (with ${known.others.joinToString(", ")})" else "", !busy) { choice = known.id }
                        RadioRow(choice == null, "A new group", !busy) { choice = null }
                        if (choice == null) OutlinedTextField(value = newName, onValueChange = { if (it.length <= 80) newName = it }, label = { Text("Name of the new group, for example Shopping") },
                            singleLine = true, enabled = !busy, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences))
                    }
                    item {
                        StepTitle(2, "Your name for the others")
                        OutlinedTextField(value = me, onValueChange = { if (it.length <= 80) me = it }, label = { Text("Your name") }, singleLine = true, enabled = !busy,
                            modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words))
                    }
                    item {
                        TermsNotice("sharing")
                        Button(onClick = { run {
                            val own = client()
                            val target = choice
                            val id = withContext(Dispatchers.IO) { CloudSpacesFlow.share(context, own, note, target, newName, me) }
                            CloudSyncManager.request(context)
                            sharedIn = id
                        } }, enabled = !busy && me.isNotBlank() && (choice != null || newName.isNotBlank()), modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text("Share note") }
                    }
                } else {
                    item {
                        DoneRow("The note is shared.")
                        StepTitle(3, "Invite someone")
                        Text("Make a link for one person. It works once and expires after 7 days. Send it the way you like: WhatsApp, email, a message.", style = MaterialTheme.typography.bodyMedium)
                        val link = invite
                        if (link == null) Button(onClick = { run {
                            val own = client()
                            val space = withContext(Dispatchers.IO) { CloudSpacesFlow.known(context).first { it.id == group } }
                            invite = withContext(Dispatchers.IO) { CloudSpaces.makeInvite(own, space.id, space.key, me.ifBlank { "Someone" }) }
                        } }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(top = 8.dp)) { Text("Make invitation link") }
                        else LinkBox(link,
                            onSend = { send("I would like to share notes with you on JotDrop. This link works once:\n\n$link", "Send invitation") },
                            onCopy = { clipboard.setText(AnnotatedString(link)); notice = "Link copied." },
                            another = { invite = null })
                    }
                    item { OutlinedButton(onClick = onClose, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text("Done") } }
                }
            } else {
                val link = made
                if (link == null) {
                    item {
                        StepTitle(1, "How long may the link work?")
                        for ((value, label) in listOf(1 to "1 day", 7 to "7 days", 30 to "30 days", 0 to "Until I remove it")) RadioRow(days == value, label, !busy) { days = value }
                    }
                    item {
                        TermsNotice("sharing")
                        Button(onClick = { run {
                            val own = client()
                            try {
                                made = withContext(Dispatchers.IO) {
                                    val (heading, text) = CloudNoteLinks.parts(Storage.readNote(context, note).getOrThrow())
                                    CloudNoteLinks.create(own, heading, text, days)
                                }
                                loadLinks()
                            } catch (failure: CloudRequestException) {
                                // No link and no price: Google allows telling people where to upgrade, not sending them there.
                                if (failure.code != "plus-required") throw failure
                                error = "${failure.serverMessage} You can try it free for 14 days on our website."
                            }
                        } }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text("Make link") }
                    }
                } else {
                    item {
                        DoneRow("The link is ready.")
                        Text("Send it yourself. The key is in the link, so JotDrop never sees the note.", style = MaterialTheme.typography.bodyMedium)
                        LinkBox(link, onSend = { send(link, "Send link") }, onCopy = { clipboard.setText(AnnotatedString(link)); notice = "Link copied." }, another = null)
                    }
                    item { OutlinedButton(onClick = onClose, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text("Done") } }
                }
                if (links.isNotEmpty()) item {
                    Text("Your links", style = MaterialTheme.typography.titleMedium)
                    for (item in links) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text("${item.title.ifBlank { "Untitled note" }}, ${item.expiresAt?.let { "ends ${it.take(10)}" } ?: "until you remove it"}", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = { run {
                            val own = client()
                            withContext(Dispatchers.IO) { CloudNoteLinks.remove(own, item.id) }
                            if (made == item.address) made = null
                            notice = "The link no longer works."
                            loadLinks()
                        } }, enabled = !busy) { Text("Remove") }
                    }
                }
            }
        }
    }
}

@Composable
private fun ShareChoice(icon: ImageVector, title: String, text: String, selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val colors = if (selected) CardDefaults.outlinedCardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer) else CardDefaults.outlinedCardColors()
    OutlinedCard(colors = colors, border = BorderStroke(if (selected) 2.dp else 1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.Top) {
            Icon(icon, null, Modifier.size(28.dp))
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text(text, style = MaterialTheme.typography.bodySmall)
            }
            if (selected) {
                Spacer(Modifier.width(8.dp))
                Icon(Icons.Filled.CheckCircle, "Chosen", tint = MaterialTheme.colorScheme.primary)
            }
        }
    }
}

@Composable
private fun StepTitle(number: Int, text: String) {
    Text("$number. $text", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(bottom = 4.dp))
}

@Composable
private fun RadioRow(selected: Boolean, label: String, enabled: Boolean, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick), verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected = selected, onClick = null, enabled = enabled)
        Spacer(Modifier.width(8.dp))
        Text(label)
    }
}

@Composable
private fun DoneRow(text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 8.dp)) {
        Icon(Icons.Filled.CheckCircle, null, tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.titleMedium)
    }
}

@Composable
private fun LinkBox(link: String, onSend: () -> Unit, onCopy: () -> Unit, another: (() -> Unit)?) {
    Card(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(link, style = MaterialTheme.typography.bodySmall, maxLines = 3)
            Button(onClick = onSend, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                Icon(Icons.Filled.Send, null); Spacer(Modifier.width(8.dp)); Text("Send link")
            }
            OutlinedButton(onClick = onCopy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Icon(Icons.Filled.ContentCopy, null); Spacer(Modifier.width(8.dp)); Text("Copy link")
            }
            another?.let { TextButton(onClick = it) { Text("Make a link for someone else") } }
        }
    }
}

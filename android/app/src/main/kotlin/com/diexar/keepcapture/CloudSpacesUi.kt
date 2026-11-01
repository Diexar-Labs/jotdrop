package com.diexar.keepcapture

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** A shared group as this phone knows it, also after access ended: its folder stays until the person decides. */
internal class KnownSpace(val id: String, val key: String, val name: String, val others: List<String>, val frozen: Boolean, val gone: Boolean, val owner: Boolean)

internal object CloudSpacesFlow {
    // No link and no price: Google allows telling people where to upgrade, not sending them there.
    private const val FREE_SHARES_ONE = "The free plan shares one note. JotDrop Plus shares more, and you can try it free for 14 days on our website."

    /** From an invitation link, until it is used or put aside. */
    var invitation by mutableStateOf<String?>(null)
    /** The note a card's menu wants to share. */
    var shareNote by mutableStateOf<Uri?>(null)

    /** The note a card's menu wants to share by link. */
    var linkNote by mutableStateOf<Uri?>(null)

    fun known(context: Context): List<KnownSpace> {
        val spaces = CloudPreviewStore(context).spaces()
        return spaces.keys().asSequence().mapNotNull { id ->
            val space = spaces.optJSONObject(id) ?: return@mapNotNull null
            val others = space.optJSONArray("others")
            KnownSpace(id, space.optString("key"), space.optString("name"), List(others?.length() ?: 0) { others!!.getString(it) }, space.optBoolean("frozen"), space.optBoolean("gone"), space.optBoolean("owner"))
        }.filter { it.key.isNotEmpty() }.toList().sortedBy { it.name.lowercase() }
    }

    private fun remember(context: Context, id: String, key: String, name: String, owner: Boolean) {
        val store = CloudPreviewStore(context)
        val spaces = store.spaces()
        // A group that comes back stays marked until the sync has forgotten what it knew of it.
        val returning = spaces.optJSONObject(id)?.optBoolean("gone") == true
        spaces.put(id, (spaces.optJSONObject(id) ?: JSONObject()).put("key", key).put("name", name).put("owner", owner).put("gone", returning).put("frozen", false))
        store.saveSpaces(spaces)
    }

    /** Your own name, as the others in a group already know you. */
    fun myName(client: CloudClient, spaces: List<KnownSpace>): String = spaces.asSequence().filter { !it.gone }.mapNotNull { space ->
        runCatching { CloudSpaces.details(client, space.id).let { info -> info.members.firstOrNull { it.accountId == info.accountId }?.name } }.getOrNull()
    }.firstOrNull().orEmpty()

    /** Moves the note to the group's folder; the next sync does the rest. Reminders, pin, labels and order stay behind. */
    fun share(context: Context, client: CloudClient, note: Uri, spaceId: String?, newName: String, me: String): String {
        val (id, key) = if (spaceId != null) spaceId to known(context).first { it.id == spaceId }.key
            else try {
                CloudSpaces.create(client, newName, me).also { remember(context, it.first, it.second, newName, true) }
            } catch (error: CloudRequestException) {
                if (error.code == "plus-required") throw CloudSyncException(FREE_SHARES_ONE)
                throw error
            }
        if (spaceId != null) runCatching { CloudSpaces.setMemberName(client, id, key, me) }
        val files = CloudSpaces.files(client, id, key)
        if (files.call("/status").optJSONObject("plan")?.optString("name") != "plus" && Storage.noteCountInSpace(context, id) >= 1) throw CloudSyncException(FREE_SHARES_ONE)
        Storage.moveNoteToSpace(context, note, id).getOrThrow()
        return id
    }

    fun join(context: Context, client: CloudClient, link: String, name: String): CloudJoined {
        val joined = CloudSpaces.accept(client, CloudSpaces.readInvite(link), name)
        val details = CloudSpaces.details(client, joined.id)
        remember(context, joined.id, joined.key, details.name.orEmpty(), false)
        return joined
    }

    /** You lose access. The folder stays here until you choose to keep a copy or remove it. */
    fun leave(context: Context, client: CloudClient, spaceId: String) {
        CloudSpaces.leave(client, spaceId)
        val store = CloudPreviewStore(context)
        val spaces = store.spaces()
        spaces.optJSONObject(spaceId)?.put("gone", true)
        store.saveSpaces(spaces)
    }

    /** The other side of a group is gone or read-only: keep the notes as your own, or remove the folder. Asks first, in the screen. */
    suspend fun release(context: Context, space: KnownSpace, keep: Boolean) = CloudSyncManager.exclusive { CloudSyncManager.dropSpace(context, space.id, space.key, keep) }

    /** Removing a person. The mark goes first, under your own key, so a crash shows "Finish removing" on any device. */
    suspend fun remove(context: Context, client: CloudClient, space: KnownSpace, member: CloudSpaceMember): String {
        val info = CloudSpaces.details(client, space.id)
        CloudSpaces.savePrefs(client, space.id, info.prefs.put("finishRemoval", true))
        CloudSpaces.removeMember(client, space.id, member.accountId)
        return finishRemoval(context, client, space)
    }

    suspend fun finishRemoval(context: Context, client: CloudClient, space: KnownSpace): String {
        // What this phone did not send yet goes first.
        runCatching { CloudSyncManager.sync(context) }
        return CloudSyncManager.exclusive {
            val info = CloudSpaces.details(client, space.id)
            if (info.members.size <= 1) {
                // Only you left: the group ends and the notes go back to your own notes. In this order, because a failure
                // in between then leaves a group without access whose notes are still here, to keep.
                CloudSpaces.delete(client, space.id)
                CloudSyncManager.dropSpace(context, space.id, space.key, true)
                return@exclusive "The person is removed. The notes are back in your own notes."
            }
            val me = info.members.firstOrNull { it.accountId == info.accountId }?.name ?: "Someone"
            val next = CloudSpaces.replace(client, info, me)
            remember(context, next.first, next.second, info.name.orEmpty(), true)
            // Right before the folder goes: what was changed since the sync gets a copy in the own notes.
            CloudSyncManager.rescueSpace(context, space.id, space.key)
            CloudSyncManager.dropSpace(context, space.id, space.key, false)
            "The person is removed. Send the others a new link: ${info.members.filter { it.accountId != info.accountId }.joinToString(", ") { it.name ?: "Someone" }}."
        }
    }
}

private val REPORT_REASONS = listOf("abuse" to "Threats, harassment or hate", "illegal" to "Illegal content", "spam" to "Spam or a scam", "other" to "Something else")

/** The terms come before anything is shared or joined. */
@Composable
private fun TermsNotice(action: String) {
    val context = LocalContext.current
    Text("By $action you accept the terms of use.", style = MaterialTheme.typography.bodySmall)
    val server = remember { runCatching { CloudPreviewStore(context).credentials()?.url }.getOrNull() ?: "https://app.jotdrop.net" }
    TextButton(onClick = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${server.trimEnd('/')}/terms"))) } }) { Text("Read the terms of use") }
}

/** The groups on this phone, and the people in the one that is open. */
@Composable
internal fun SharedGroups(busy: Boolean, run: (suspend () -> Unit) -> Unit, client: suspend () -> CloudClient, setNotice: (String) -> Unit) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    var version by remember { mutableStateOf(0) }
    var groups by remember { mutableStateOf<List<KnownSpace>>(emptyList()) }
    var open by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<CloudSpaceInfo?>(null) }
    var link by remember { mutableStateOf<String?>(null) }
    var paste by remember { mutableStateOf("") }
    var ask by remember { mutableStateOf<Triple<String, String, suspend () -> Unit>?>(null) }
    var reporting by remember { mutableStateOf<Pair<KnownSpace, CloudSpaceMember?>?>(null) }
    var reported by remember { mutableStateOf(false) }
    val reload = { version++ }
    LaunchedEffect(version, busy) { groups = withContext(Dispatchers.IO) { CloudSpacesFlow.known(context) } }
    LaunchedEffect(open, version) {
        val id = open
        info = if (id == null) null else runCatching { val own = client(); withContext(Dispatchers.IO) { CloudSpaces.details(own, id) } }.getOrNull()
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Shared groups", style = MaterialTheme.typography.titleLarge)
        Text("Share a note from the menu on its card. Everyone in a group can read and change its notes. JotDrop's server cannot read them.", style = MaterialTheme.typography.bodySmall)
        for (group in groups) {
            val state = when { group.gone -> "No access any more"; group.frozen -> "Read-only"; group.others.isEmpty() -> "Only you so far"; else -> "Shared with ${group.others.joinToString(", ")}" }
            OutlinedButton(onClick = { open = if (open == group.id) null else group.id }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text("${group.name.ifEmpty { "Shared group" }}: $state")
            }
            if (open != group.id) continue
            val details = info?.takeIf { it.id == group.id }
            if (group.gone || group.frozen) {
                if (group.frozen && !group.gone) Text("${if (group.owner) "A new group replaced this one." else "Ask the owner for a new link."} This group goes away after 30 days. What you changed and could not send is in your own notes, named \"Not sent\".", style = MaterialTheme.typography.bodySmall)
                else Text("You can no longer reach this group. This phone still has a copy of its notes.", style = MaterialTheme.typography.bodySmall)
                Button(onClick = { run { withContext(Dispatchers.IO) { CloudSpacesFlow.release(context, group, true) }; open = null; reload(); setNotice("The notes are in your own notes.") } }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Keep a copy in my notes") }
                OutlinedButton(onClick = { ask = Triple("Remove from this phone?", "The notes of \"${group.name}\" are removed from this phone.") { withContext(Dispatchers.IO) { CloudSpacesFlow.release(context, group, false) }; open = null; reload() } }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Remove from this phone") }
            }
            if (details?.canTakeOver == true) Button(onClick = { run { val own = client(); withContext(Dispatchers.IO) { CloudSpaces.takeOver(own, group.id) }; CloudSyncManager.request(context); reload(); setNotice("This group is yours now. Its storage counts for your plan.") } }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Take over this group") }
            if (details != null) {
                if (details.prefs.optBoolean("finishRemoval")) Button(onClick = { run { val own = client(); setNotice(withContext(Dispatchers.IO) { CloudSpacesFlow.finishRemoval(context, own, group) }); open = null; reload() } }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Finish removing the person") }
                for (member in details.members) {
                    val me = member.accountId == details.accountId
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(listOfNotNull(member.name ?: "Someone", "(you)".takeIf { me }, "(owner)".takeIf { member.owner }, member.email?.let { "- $it" }).joinToString(" "), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                        if (details.owner && !me && !details.frozen) TextButton(onClick = { ask = Triple("Remove ${member.name ?: "this person"}?", "They lose access right away to all notes in this group. What they already downloaded stays with them.") { val own = client(); setNotice(withContext(Dispatchers.IO) { CloudSpacesFlow.remove(context, own, group, member) }); open = null; CloudSyncManager.request(context); reload() } }, enabled = !busy) { Text("Remove") }
                    }
                    if (!me) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        TextButton(onClick = { reporting = group to member }, enabled = !busy) { Text("Report") }
                        if (!details.frozen && details.replacedBy == null) TextButton(onClick = { ask = Triple("Block ${member.name ?: "this person"}?", "${if (details.owner) "They are removed from this group" else "You leave this group"} and the two of you cannot join a new group together. Other groups you share stay as they are. To undo this, write to hello@jotdrop.net.") {
                            val own = client()
                            withContext(Dispatchers.IO) { CloudSpaces.block(own, group.id, member.accountId) }
                            if (details.owner) {
                                setNotice(withContext(Dispatchers.IO) { CloudSpacesFlow.remove(context, own, group, member) })
                                open = null
                                CloudSyncManager.request(context)
                            } else withContext(Dispatchers.IO) { CloudSpacesFlow.leave(context, own, group.id) }
                            reload()
                        } }, enabled = !busy) { Text("Block") }
                    }
                }
                for (invite in details.invites.filter { !it.claimed }) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("Link not used yet", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = { run { val own = client(); withContext(Dispatchers.IO) { CloudSpaces.withdrawInvite(own, group.id, invite.id) }; reload() } }, enabled = !busy) { Text("Withdraw") }
                }
                if (details.owner && !details.frozen) Button(onClick = { run {
                    val own = client()
                    link = withContext(Dispatchers.IO) { CloudSpaces.makeInvite(own, group.id, group.key, details.members.firstOrNull { it.accountId == details.accountId }?.name ?: "Someone") }
                    reload()
                } }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Invite someone") }
                if (!details.frozen && details.replacedBy == null) OutlinedButton(onClick = { ask = Triple("Leave \"${group.name}\"?", "You lose access. You can keep a copy of the notes next.") { val own = client(); withContext(Dispatchers.IO) { CloudSpacesFlow.leave(context, own, group.id) }; reload() } }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Leave group") }
                if (details.members.size > 1) OutlinedButton(onClick = { reporting = group to null }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Report this group") }
                if (details.owner) OutlinedButton(onClick = { ask = Triple("Delete \"${group.name}\"?", "The group and all of its notes are deleted for everyone. This cannot be undone. Move notes you want to keep to your own notes first.") { val own = client(); withContext(Dispatchers.IO) { CloudSpaces.delete(own, group.id); CloudSpacesFlow.release(context, group, false) }; open = null; reload() } }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Delete group") }
            }
        }
        OutlinedTextField(value = paste, onValueChange = { if (it.length <= 512) paste = it }, label = { Text("Invitation link") }, modifier = Modifier.fillMaxWidth(), enabled = !busy, maxLines = 3)
        OutlinedButton(onClick = { CloudSpacesFlow.invitation = paste.trim(); paste = "" }, enabled = !busy && paste.isNotBlank(), modifier = Modifier.heightIn(min = 48.dp)) { Text("Use invitation link") }
    }
    ask?.let { (title, text, action) ->
        AlertDialog(onDismissRequest = { ask = null }, title = { Text(title) }, text = { Text(text) },
            confirmButton = { TextButton(onClick = { ask = null; run(action) }) { Text("Continue") } },
            dismissButton = { TextButton(onClick = { ask = null }) { Text("Cancel") } })
    }
    if (reported) AlertDialog(onDismissRequest = { reported = false }, title = { Text("Report sent") }, text = { Text("Thanks. Your report was sent to JotDrop.") },
        confirmButton = { TextButton(onClick = { reported = false }) { Text("OK") } })
    reporting?.let { (space, member) ->
        var reason by remember { mutableStateOf(REPORT_REASONS.first().first) }
        var words by remember { mutableStateOf("") }
        AlertDialog(onDismissRequest = { reporting = null }, title = { Text(if (member != null) "Report ${member.name ?: "this person"}" else "Report this group") },
            text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("We cannot read the notes in this group, so we only see what you write here. Your email address goes along, so we can reply.", style = MaterialTheme.typography.bodySmall)
                for ((value, label) in REPORT_REASONS) Row(verticalAlignment = Alignment.CenterVertically) { RadioButton(selected = reason == value, onClick = { reason = value }); Text(label) }
                OutlinedTextField(value = words, onValueChange = { if (it.length <= 2000) words = it }, label = { Text("Tell us more (optional)") }, modifier = Modifier.fillMaxWidth(), maxLines = 4)
            } },
            confirmButton = { TextButton(onClick = {
                reporting = null
                run {
                    val own = client()
                    withContext(Dispatchers.IO) { CloudSpaces.report(own, space.id, reason, member?.accountId, words) }
                    reported = true
                }
            }, enabled = !busy) { Text("Send report") } },
            dismissButton = { TextButton(onClick = { reporting = null }) { Text("Cancel") } })
    }
    link?.let { value ->
        AlertDialog(onDismissRequest = { link = null }, title = { Text("Invite someone") },
            text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Send this link yourself, to one person. It works once and expires after 7 days. They need a free JotDrop account.")
                Text(value, style = MaterialTheme.typography.bodySmall)
            } },
            confirmButton = { TextButton(onClick = {
                context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "I would like to share notes with you on JotDrop. This link works once:\n\n$value"), "Send invitation"))
                link = null
            }) { Text("Send link") } },
            dismissButton = { TextButton(onClick = { clipboard.setText(AnnotatedString(value)); link = null; setNotice("Link copied.") }) { Text("Copy link") } })
    }
    CloudSpacesFlow.invitation?.let { value ->
        var name by remember { mutableStateOf("") }
        LaunchedEffect(value) { name = runCatching { val own = client(); withContext(Dispatchers.IO) { CloudSpacesFlow.myName(own, CloudSpacesFlow.known(context)) } }.getOrDefault("") }
        AlertDialog(onDismissRequest = { CloudSpacesFlow.invitation = null }, title = { Text("You are invited to a shared group") },
            text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Accept only a link from someone you know. The people in the group can read and change its notes. Joining sends none of your own notes.")
                Text("The owner of the group can see your email address. The others see the name you choose here.")
                OutlinedTextField(value = name, onValueChange = { if (it.length <= 80) name = it }, label = { Text("Your name for the others") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words))
                TermsNotice("joining")
            } },
            confirmButton = { TextButton(onClick = {
                val used = value
                CloudSpacesFlow.invitation = null
                run {
                    val own = client()
                    val joined = withContext(Dispatchers.IO) { CloudSpacesFlow.join(context, own, used, name) }
                    CloudSyncManager.request(context)
                    reload()
                    setNotice(if (joined.inviterName.isNotEmpty()) "You joined. ${joined.inviterName} can see you in this group." else "You joined this group.")
                }
            }, enabled = name.isNotBlank() && !busy) { Text("Join") } },
            dismissButton = { TextButton(onClick = { CloudSpacesFlow.invitation = null }) { Text("Not now") } })
    }
    CloudSpacesFlow.linkNote?.let { note ->
        var days by remember { mutableStateOf(7) }
        var made by remember { mutableStateOf<String?>(null) }
        var said by remember { mutableStateOf("") }
        var links by remember { mutableStateOf<List<CloudNoteLinks.Link>>(emptyList()) }
        val load: suspend () -> Unit = { val own = client(); links = withContext(Dispatchers.IO) { CloudNoteLinks.list(own) } }
        LaunchedEffect(note) { runCatching { load() } }
        AlertDialog(onDismissRequest = { CloudSpacesFlow.linkNote = null }, title = { Text("Share by link") },
            text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                val link = made
                if (link == null) {
                    Text("Anyone with this link can read a copy of this note, without an account. Later changes do not go along. Photos and files stay out.", style = MaterialTheme.typography.bodySmall)
                    for ((value, label) in listOf(1 to "After 1 day", 7 to "After 7 days", 30 to "After 30 days", 0 to "When I remove it")) Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = days == value, onClick = { days = value })
                        Text(label)
                    }
                    TermsNotice("sharing")
                } else {
                    Text("Send this link yourself. It holds the key, so we never see it.", style = MaterialTheme.typography.bodySmall)
                    Text(link, style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = { context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link), null)) }) { Text("Send link") }
                }
                if (said.isNotEmpty()) Text(said, style = MaterialTheme.typography.bodySmall)
                if (links.isNotEmpty()) Text("Your links", style = MaterialTheme.typography.titleSmall)
                for (item in links) Column {
                    Text("${item.title.ifBlank { "Untitled note" }} - ${item.expiresAt?.let { "ends ${it.take(10)}" } ?: "until you remove it"}", style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = { run { val own = client(); withContext(Dispatchers.IO) { CloudNoteLinks.remove(own, item.id) }; said = "The link no longer works."; if (made == item.address) made = null; load() } }, enabled = !busy) { Text("Remove") }
                }
            } },
            confirmButton = { if (made == null) TextButton(onClick = {
                run {
                    val own = client()
                    try {
                        made = withContext(Dispatchers.IO) {
                            val (title, text) = CloudNoteLinks.parts(Storage.readNote(context, note).getOrThrow())
                            CloudNoteLinks.create(own, title, text, days)
                        }
                        said = ""
                        load()
                    } catch (error: CloudRequestException) {
                        // No link and no price: Google allows telling people where to upgrade, not sending them there.
                        if (error.code != "plus-required") throw error
                        said = "${error.serverMessage} You can try it free for 14 days on our website."
                    }
                }
            }, enabled = !busy) { Text("Make link") } },
            dismissButton = { TextButton(onClick = { CloudSpacesFlow.linkNote = null }) { Text("Close") } })
    }
    CloudSpacesFlow.shareNote?.let { note ->
        var choice by remember { mutableStateOf<String?>(null) }
        var newName by remember { mutableStateOf("") }
        var me by remember { mutableStateOf("") }
        LaunchedEffect(note) { me = runCatching { val own = client(); withContext(Dispatchers.IO) { CloudSpacesFlow.myName(own, CloudSpacesFlow.known(context)) } }.getOrDefault("") }
        AlertDialog(onDismissRequest = { CloudSpacesFlow.shareNote = null }, title = { Text("Share this note") },
            text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("The note moves to a shared group. Pin, labels, order and a reminder stay behind.", style = MaterialTheme.typography.bodySmall)
                for (group in groups.filter { !it.gone && !it.frozen }) Row(verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = choice == group.id, onClick = { choice = group.id })
                    Text(group.name.ifEmpty { "Shared group" })
                }
                Row(verticalAlignment = Alignment.CenterVertically) { RadioButton(selected = choice == null, onClick = { choice = null }); Text("New group") }
                if (choice == null) OutlinedTextField(value = newName, onValueChange = { if (it.length <= 80) newName = it }, label = { Text("Name of the new group") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(value = me, onValueChange = { if (it.length <= 80) me = it }, label = { Text("Your name for the others") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                TermsNotice("sharing")
            } },
            confirmButton = { TextButton(onClick = {
                val target = choice
                CloudSpacesFlow.shareNote = null
                run {
                    val own = client()
                    val id = withContext(Dispatchers.IO) { CloudSpacesFlow.share(context, own, note, target, newName, me) }
                    CloudSyncManager.request(context)
                    open = id
                    reload()
                    setNotice("The note is shared. Invite someone below.")
                }
            }, enabled = me.isNotBlank() && (choice != null || newName.isNotBlank()) && !busy) { Text("Share") } },
            dismissButton = { TextButton(onClick = { CloudSpacesFlow.shareNote = null }) { Text("Cancel") } })
    }
}

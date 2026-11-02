package com.diexar.keepcapture

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.activity.compose.BackHandler
import androidx.compose.material.icons.filled.Backup
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.CloudSync
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Devices
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Sync
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.diexar.keepcapture.ui.JotDropTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlin.math.roundToInt

class CloudActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        if (savedInstanceState == null) {
            CloudAccountFlow.startProvider = intent.getStringExtra(EXTRA_PROVIDER)
            takeProviderReturn(intent)
        }
        val welcome = intent.getBooleanExtra(EXTRA_WELCOME, false)
        val resolve = intent.getStringExtra(EXTRA_RESOLVE)
        // From a card's menu: sharing gets a page of its own, not dialogs on top of the cloud screen.
        val sharing = (intent.getStringExtra(EXTRA_SHARE) ?: intent.getStringExtra(EXTRA_LINK))?.let(Uri::parse)
        val startWithLink = intent.getStringExtra(EXTRA_SHARE) == null
        setContent { JotDropTheme {
            var share by rememberSaveable { mutableStateOf(sharing != null) }
            if (share && sharing != null) ShareNoteScreen(sharing, startWithLink, onOpenCloud = { share = false }, onClose = { finish() })
            else CloudScreen(welcome, resolve, onBack = { finish() }, onSignedIn = {
                // Also from Settings: whoever just signed in wants to write a note.
                startActivity(Intent(this, NotesListActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
                finish()
            }, onSettings = { startActivity(Intent(this, MainActivity::class.java)) })
        } }
    }

    companion object {
        /** From the welcome screen: the screen closes once sync runs. */
        const val EXTRA_WELCOME = "welcome"
        /** From the welcome screen: "google" or "github", whose sign-in opens at once. */
        const val EXTRA_PROVIDER = "provider"
        /** From a conflict copy's card: the file name of the note it belongs to, whose comparison opens at once. */
        const val EXTRA_RESOLVE = "resolve"
        /** From a card's menu: the note to share. */
        const val EXTRA_SHARE = "share"
        const val EXTRA_LINK = "link"
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takeProviderReturn(intent)
    }

    /** Google or GitHub sends the browser back to jotdrop-cloud://oauth?oauth=<ticket>, the person check to jotdrop-cloud://human?token=<token>. */
    private fun takeProviderReturn(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "jotdrop-cloud" && data.host == "oauth") CloudAccountFlow.providerReturn = data
        // An invitation link: the secrets are in the part after # and never go to a server.
        if (data.scheme == "https" && data.path == "/join" && data.fragment != null) CloudSpacesFlow.invitation = data.fragment
        if (data.scheme == "jotdrop-cloud" && data.host == "human") CloudAccountFlow.personReturn = data.getQueryParameter("token")
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CloudScreen(welcome: Boolean, resolve: String?, onBack: () -> Unit, onSignedIn: () -> Unit, onSettings: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf<CloudSyncStatus?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var pairing by remember { mutableStateOf("") }
    var deviceName by remember { mutableStateOf("") }
    var generated by remember { mutableStateOf<Pair<String, String>?>(null) }
    // -1 is the overview; 0 to 3 open Files, Trash, Devices or Time machine on a page of their own.
    var tab by rememberSaveable { mutableStateOf(-1) }
    var files by remember { mutableStateOf<List<CloudListedFile>>(emptyList()) }
    var devices by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var selected by remember { mutableStateOf<CloudListedFile?>(null) }
    var preview by remember { mutableStateOf<String?>(null) }
    var versions by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var compared by remember { mutableStateOf<Pair<Int, List<CloudVersionDiff.Line>?>?>(null) }
    var confirmEnable by remember { mutableStateOf(false) }
    var confirmDisconnect by remember { mutableStateOf(false) }
    var revoke by remember { mutableStateOf<JSONObject?>(null) }
    var restore by remember { mutableStateOf<Int?>(null) }
    var resolveLocal by remember { mutableStateOf<Boolean?>(null) }
    // Time machine: the steps, the slider position (last step = now) and the moment shown, read-only.
    var moments by remember { mutableStateOf<List<String>>(emptyList()) }
    var step by remember { mutableStateOf(0f) }
    var moment by remember { mutableStateOf<TimeMoment?>(null) }
    var confirmMoment by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<String?>(null) }
    // The account this phone is in, at the top of the screen like on the website and in Obsidian.
    var accountEmail by remember { mutableStateOf<String?>(null) }
    // When the 14 days of Plus every new account starts with end; null outside a trial.
    var trialEnds by remember { mutableStateOf<java.time.Instant?>(null) }

    suspend fun refresh() {
        status = withContext(Dispatchers.IO) { CloudSyncManager.status(context) }
    }
    fun run(account: Boolean = false, action: suspend () -> Unit) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            try { action(); refresh() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                error = when {
                    failure is CloudSyncException -> failure.message
                    // Account screens show the server's own text ("Invalid email or password") and their own input checks.
                    account && failure is CloudRequestException -> failure.serverMessage ?: failure.message
                    // Plan limits (device limit, versions older than 30 days) explain themselves, also outside account screens.
                    failure is CloudRequestException && failure.code != null -> failure.serverMessage ?: failure.message
                    account && (failure is IllegalArgumentException || failure is IllegalStateException) && failure.message != null -> failure.message
                    failure is CloudRequestException -> failure.message
                    else -> "This action could not complete. Check the HTTPS connection and local vault settings; local notes were kept."
                }
                runCatching { refresh() }
            } finally { busy = false }
        }
    }
    fun accountRun(action: suspend () -> Unit) = run(true, action)
    suspend fun cloud(): CloudClient = withContext(Dispatchers.IO) { CloudSyncManager.client(context) ?: throw CloudSyncException("Pair this device first") }
    fun loadFiles() = run { files = CloudSyncManager.cloudFiles(context).sortedBy { it.path }; selected = null }
    suspend fun showHistory(file: CloudListedFile) {
        val client = cloud()
        withContext(Dispatchers.IO) {
            val array = client.history(file.id).getJSONArray("versions")
            versions = List(array.length()) { array.getJSONObject(it) }
            preview = if (file.path.endsWith(".md", true) && !file.deleted) String(client.read(file.id).bytes, Charsets.UTF_8).take(1024) else null
        }
        compared = null
        selected = file
    }
    fun loadDevices() = run {
        val client = cloud()
        devices = withContext(Dispatchers.IO) { val array = client.devices().getJSONArray("devices"); List(array.length()) { array.getJSONObject(it) } }
    }
    fun loadTimeline() = run {
        val client = cloud()
        moments = withContext(Dispatchers.IO) { val coroutine = currentCoroutineContext(); client.moments { coroutine.ensureActive() } }
        step = (moments.size - 1).coerceAtLeast(0).toFloat()
        moment = null
    }
    fun showMoment() = run {
        val index = step.roundToInt()
        moment = null
        notice = null
        if (index >= moments.size - 1) return@run
        val at = moments[index]
        val client = cloud()
        val known = CloudSyncManager.cloudFiles(context).associateBy { it.id }
        moment = withContext(Dispatchers.IO) {
            val coroutine = currentCoroutineContext()
            val then = client.snapshot(at)
            val unavailable = CloudTimeMachine.unavailable(client.current { coroutine.ensureActive() }, then)
            val kept = (then - unavailable.toSet()).filter { !it.deleted }
            // One file at a time and only notes, for their first lines: attachments are listed by name from the index.
            val shown = kept.map { file ->
                coroutine.ensureActive()
                val revision = requireNotNull(file.revision)
                val now = known[file.id]?.takeIf { it.revision == revision }
                if (now != null && !now.path.endsWith(".md", true)) MomentEntry(file.id, now.path, null)
                else (if (now != null) client.read(file.id) else client.read(file.id, revision)).let { read ->
                    MomentEntry(file.id, read.path, if (read.path.endsWith(".md", true)) String(read.bytes, Charsets.UTF_8).take(200) else null)
                }
            }
            TimeMoment(at, then, shown.sortedBy { it.path }, then.count { it.deleted }, unavailable.count { !it.cleared }, unavailable.count { it.cleared })
        }
    }
    LaunchedEffect(Unit) { try { refresh() } catch (_: Exception) { error = "Encrypted cloud settings could not be opened. Do not clear app data; your local notes remain in the vault." } }
    LaunchedEffect(Unit) { CloudSyncManager.changes.collect { runCatching { refresh() } } }
    LaunchedEffect(status?.connected, status?.vaultId) {
        accountEmail = if (status?.connected != true) null else try { val client = cloud(); withContext(Dispatchers.IO) { CloudAccount.accountInfo(client)?.email } }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { null }
    }
    LaunchedEffect(status?.connected, status?.vaultId, status?.lastSynced) {
        trialEnds = if (status?.connected != true) null else try { val client = cloud(); withContext(Dispatchers.IO) { trialEndsOf(client.call("/status")) } }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { null }
    }
    // Just signed in here: an empty notes folder starts syncing at once, a folder with files asks first (Eric).
    var wasConnected by remember { mutableStateOf<Boolean?>(null) }
    var justSignedIn by rememberSaveable { mutableStateOf(welcome) }
    LaunchedEffect(status?.connected) {
        val connected = status?.connected ?: return@LaunchedEffect
        if (wasConnected == false && connected) justSignedIn = true
        if (wasConnected == false && connected && status?.enabled == false && Storage.getVaultUri(context) != null) {
            snapshotFlow { busy }.first { !it }
            if (CloudSyncManager.localFolderEmpty(context)) run { CloudSyncManager.setEnabled(context, true) } else confirmEnable = true
        }
        wasConnected = connected
    }
    // Just signed in, from anywhere: to the notes once sync runs and the recovery code is saved.
    if (justSignedIn) LaunchedEffect(status?.enabled, CloudAccountFlow.recoveryCode, CloudAccountFlow.secureOffer, CloudAccountFlow.totpTurnedOn) {
        if (status?.enabled == true && CloudAccountFlow.recoveryCode == null && CloudAccountFlow.secureOffer == null && !CloudAccountFlow.totpTurnedOn) onSignedIn()
    }
    // From a conflict copy's card: straight into the comparison of its note, like "Resolve now" on the card in Obsidian.
    var resolveOpened by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(status?.connected) {
        if (resolve == null || resolveOpened || status?.connected != true) return@LaunchedEffect
        resolveOpened = true
        snapshotFlow { busy }.first { !it }
        run {
            files = CloudSyncManager.cloudFiles(context).sortedBy { it.path }
            showHistory(files.firstOrNull { !it.deleted && (it.path == resolve || it.path.endsWith("/$resolve")) }
                ?: throw CloudSyncException("$resolve is no longer in the cloud. Sync again."))
        }
    }
    val list = rememberLazyListState()
    // Errors show at the top; a form further down would otherwise seem to do nothing.
    LaunchedEffect(error) { if (error != null) list.animateScrollToItem(0) }

    BackHandler(enabled = tab >= 0) { tab = -1 }
    Scaffold(topBar = {
        TopAppBar(title = { Text(if (tab >= 0) CLOUD_SECTIONS[tab].title else "JotDrop Cloud") },
            navigationIcon = { IconButton(onClick = { if (tab >= 0) tab = -1 else onBack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } })
    }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding).imePadding(), state = list, contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (tab < 0) item {
                Text("Your notes, across devices", style = MaterialTheme.typography.headlineSmall)
                Text("End-to-end encrypted. Your Markdown files stay on this phone and work offline.", style = MaterialTheme.typography.bodyMedium)
            }
            if (busy) item {
                LinearProgressIndicator(Modifier.fillMaxWidth().semantics { contentDescription = "Cloud action in progress" })
                if (status?.enabled == true) {
                    OutlinedButton(
                        onClick = { scope.launch { runCatching { CloudSyncManager.setEnabled(context, false); refresh() } } },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                    ) { Text("Pause sync safely") }
                }
            }
            error?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) } }
            if (status?.connected != true) {
                if (tab >= 0) tab = -1
                // Fixed keys: the progress row above comes and goes, and must not reset the forms below.
                item(key = "sign-in") {
                    CloudSignIn(busy, ::accountRun, { error = it }) {
                        Text("Pair this device", style = MaterialTheme.typography.titleLarge)
                        Text("Create a one-time pairing code on a connected device. A trusted HTTPS server is required; the local HTTP browser preview cannot pair with Android.")
                        OutlinedTextField(value = pairing, onValueChange = { if (it.length <= 4096) pairing = it }, label = { Text("One-time pairing code") },
                            visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), enabled = !busy, maxLines = 3,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrect = false))
                        Button(onClick = { run { CloudSyncManager.connect(context, pairing); pairing = "" } }, enabled = !busy && pairing.isNotBlank()) { Text("Pair device") }
                    }
                }
            } else if (tab >= 0) {
                // One part of the cloud on a page of its own; back returns to the overview.
                item {
                    Text(CLOUD_SECTIONS[tab].hint, style = MaterialTheme.typography.bodyMedium)
                    OutlinedButton(onClick = { when (tab) { 2 -> loadDevices(); 3 -> loadTimeline(); else -> loadFiles() } }, enabled = !busy, modifier = Modifier.padding(top = 8.dp).heightIn(min = 48.dp)) {
                        Icon(Icons.Filled.Refresh, null); Spacer(Modifier.width(8.dp)); Text("Refresh")
                    }
                }
                if (tab == 3) {
                    item {
                        Text("Slide back to see your cloud as it was", style = MaterialTheme.typography.titleMedium)
                        if (moments.size > 1) {
                            Slider(value = step, onValueChange = { step = it }, onValueChangeFinished = { showMoment() }, enabled = !busy,
                                valueRange = 0f..(moments.size - 1).toFloat(), steps = (moments.size - 2).coerceAtLeast(0),
                                modifier = Modifier.semantics { contentDescription = "Moment to show" })
                            Text(if (step.roundToInt() >= moments.size - 1) "Now" else momentLabel(moments[step.roundToInt()]))
                        } else Text("Earlier moments appear here after your next changes.")
                        notice?.let { Text(it) }
                    }
                    moment?.let { shown ->
                        item {
                            Text("${momentLabel(shown.at)}. Read-only.", style = MaterialTheme.typography.titleSmall)
                            if (shown.locked > 0) Text("${shown.locked} file(s) from then changed more than 30 days ago. JotDrop Plus shows and restores them.")
                            if (shown.cleared > 0) Text("${shown.cleared} file(s) from then were cleared to make room in the free storage, so this moment cannot be restored.")
                            shown.trashed.takeIf { it > 0 }?.let { Text("$it file(s) were in the trash then.", style = MaterialTheme.typography.bodySmall) }
                            Button(onClick = { confirmMoment = true }, enabled = !busy && shown.locked + shown.cleared == 0, modifier = Modifier.padding(top = 8.dp)) { Text("Restore this moment") }
                        }
                        items(shown.files, key = { "moment-${it.id}" }) { file ->
                            OutlinedCard(Modifier.fillMaxWidth()) {
                                Column(Modifier.padding(14.dp)) {
                                    Text(file.path, style = MaterialTheme.typography.titleSmall)
                                    file.preview?.let { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 4) }
                                }
                            }
                        }
                    }
                } else if (tab == 2) {
                    if (devices.isEmpty()) item { Text("Tap Refresh to see the devices connected to your cloud.") }
                    items(devices, key = { it.getString("id") }) { device ->
                        OutlinedCard(Modifier.fillMaxWidth()) {
                            Row(Modifier.padding(start = 14.dp, top = 6.dp, bottom = 6.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Filled.Devices, null)
                                Spacer(Modifier.width(12.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(device.getString("name"), style = MaterialTheme.typography.titleSmall)
                                    Text(if (device.optBoolean("revoked")) "Access revoked" else "Last active: ${device.optString("lastSeenAt")}", style = MaterialTheme.typography.bodySmall)
                                }
                                TextButton(onClick = { revoke = device }, enabled = !busy && !device.optBoolean("revoked")) { Text("Revoke") }
                            }
                        }
                    }
                    item {
                        Text("Add a device with a pairing code", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp))
                        OutlinedTextField(deviceName, { if (it.length <= 80) deviceName = it }, label = { Text("Name of the new device") }, enabled = !busy, singleLine = true, modifier = Modifier.fillMaxWidth())
                        OutlinedButton(onClick = { run { val client = cloud(); generated = withContext(Dispatchers.IO) { client.makePairing(deviceName) }; deviceName = "" } },
                            enabled = !busy && deviceName.isNotBlank(), modifier = Modifier.padding(top = 8.dp).heightIn(min = 48.dp)) { Text("Create pairing code") }
                    }
                } else {
                    val visible = files.filter { if (tab == 1) it.deleted || it.path.startsWith("notes/Trash/") else !it.deleted }
                    if (visible.isEmpty()) item { Text(if (files.isEmpty()) "Tap Refresh to load the list." else if (tab == 1) "The trash is empty." else "No files in the cloud yet.") }
                    items(visible, key = { it.id }) { file ->
                        OutlinedCard(Modifier.fillMaxWidth()) {
                            Row(Modifier.padding(start = 14.dp, top = 6.dp, bottom = 6.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(file.path.substringAfterLast('/'), style = MaterialTheme.typography.titleSmall)
                                    Text("${file.path.substringBeforeLast('/', "")}  |  version ${file.revision}${if (file.deleted) "  |  deleted" else ""}", style = MaterialTheme.typography.bodySmall)
                                }
                                TextButton(onClick = { run { showHistory(file) } }, enabled = !busy) { Text("History") }
                            }
                        }
                    }
                }
            } else {
                item(key = "sync") {
                    CloudCard(Icons.Filled.CloudSync, "Sync") {
                        val synced = status!!.enabled && status!!.conflictPaths.isEmpty() && !status!!.oldUpload
                        // A sign and words, not only a colour.
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(if (synced) Icons.Filled.CheckCircle else Icons.Filled.Info, null, tint = if (synced) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.width(8.dp))
                            Text(status!!.message, style = MaterialTheme.typography.bodyLarge)
                        }
                        accountEmail?.let { Text("Signed in as $it", style = MaterialTheme.typography.bodyMedium) }
                        status!!.lastSynced?.let { Text("Last sync: ${runCatching { momentLabel(it) }.getOrDefault(it)}", style = MaterialTheme.typography.bodySmall) }
                        // A note changed in two places opens straight into its comparison.
                        status!!.conflictPaths.firstOrNull()?.let { path ->
                            Button(onClick = { run {
                                files = CloudSyncManager.cloudFiles(context).sortedBy { it.path }
                                showHistory(files.firstOrNull { it.path == path } ?: throw CloudSyncException("$path is no longer in the cloud. Sync again."))
                            } }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Resolve now") }
                        }
                        if (status!!.oldUpload) {
                            Text("An unfinished upload from a previously chosen local vault is waiting. It blocks sync and disconnecting until it is kept as a local copy.",
                                color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                            OutlinedButton(onClick = { run { CloudSyncManager.recoverOldUploads(context) } }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                                Text("Keep old upload as a local copy")
                            }
                        }
                        Button(onClick = { run { CloudSyncManager.sync(context) } }, enabled = !busy && status!!.enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                            Icon(Icons.Filled.Sync, null); Spacer(Modifier.width(8.dp)); Text("Sync now")
                        }
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("Automatic sync", style = MaterialTheme.typography.titleSmall)
                                Text(if (status!!.enabled) "On" else "Off", style = MaterialTheme.typography.bodySmall)
                            }
                            Switch(checked = status!!.enabled, onCheckedChange = { if (it) confirmEnable = true else run { CloudSyncManager.setEnabled(context, false) } },
                                enabled = !busy, modifier = Modifier.semantics { contentDescription = "Automatic cloud sync" })
                        }
                        var details by rememberSaveable { mutableStateOf(false) }
                        TextButton(onClick = { details = !details }) { Text(if (details) "Hide details" else "Details") }
                        if (details) {
                            Text("Android syncs in the background every 15 minutes or later. Saving a note and opening the app also start a sync; offline changes wait for a connection.", style = MaterialTheme.typography.bodySmall)
                            Text("Server: ${status!!.server}", style = MaterialTheme.typography.bodySmall)
                            Text("Notes: ${Storage.getSubfolder(context)}  |  Attachments: ${Storage.resolveAssetsFolder(context)}", style = MaterialTheme.typography.bodySmall)
                            Text("Local vault: ${status!!.localVault ?: "No folder selected"}", style = MaterialTheme.typography.bodySmall)
                            TextButton(onClick = onSettings, enabled = !busy) { Text("Choose local vault in Settings") }
                            Text("Your plan sets the maximum per file and the total storage. Recovery copies are never merged or cleaned up automatically.", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
                item(key = "browse") {
                    CloudCard(Icons.Filled.Cloud, "Your cloud") {
                        for (row in CLOUD_SECTIONS.indices.chunked(2)) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            for (index in row) {
                                val section = CLOUD_SECTIONS[index]
                                OutlinedCard(onClick = { tab = index; when (index) { 2 -> loadDevices(); 3 -> loadTimeline(); else -> loadFiles() } }, enabled = !busy, modifier = Modifier.weight(1f).heightIn(min = 96.dp)) {
                                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                        Icon(section.icon, null, Modifier.size(28.dp), tint = MaterialTheme.colorScheme.primary)
                                        Text(section.title, style = MaterialTheme.typography.titleSmall)
                                        Text(section.short, style = MaterialTheme.typography.bodySmall, maxLines = 2)
                                    }
                                }
                            }
                        }
                        trialEnds?.let { ends ->
                            val days = maxOf(1L, kotlin.math.ceil((ends.toEpochMilli() - System.currentTimeMillis()) / 86_400_000.0).toLong())
                            val date = java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM).format(java.util.Date(ends.toEpochMilli()))
                            Text("JotDrop Plus trial: ${if (days == 1L) "1 day" else "$days days"} left, until $date. After that you are on Free and nothing is deleted.", style = MaterialTheme.typography.bodyMedium)
                        }
                        // Google Play allows naming the website, without a link or button, when the app sells nothing itself.
                        Text("JotDrop Plus adds more storage, devices and history. Upgrade on our website.", style = MaterialTheme.typography.bodySmall)
                    }
                }
                item(key = "account") { CloudCard(Icons.Filled.Shield, "Account and security") { CloudAccountSection(busy, ::accountRun) { cloud() } } }
                item(key = "shared-groups") {
                    CloudCard(Icons.Filled.Group, "Shared groups") {
                        SharedGroups(busy, { action -> run(true, action) }, ::cloud) { notice = it }
                        notice?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                    }
                }
                item(key = "backup") { CloudCard(Icons.Filled.Backup, "Automatic backup") { BackupSection(busy) { action -> run(true, action) } } }
                item {
                    OutlinedButton(
                        onClick = { confirmDisconnect = true },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                    ) { Text("Disconnect this device") }
                }
                // Folded away at the bottom on purpose (Eric): findable, not prominent.
                item {
                    var showSubscription by remember { mutableStateOf(false) }
                    TextButton(onClick = { showSubscription = !showSubscription }, modifier = Modifier.padding(top = 8.dp)) {
                        Text("Subscription", style = MaterialTheme.typography.bodySmall)
                    }
                    if (showSubscription) Text("Manage or cancel your subscription at link.com.", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
    CloudRecoveryDialog()
    CloudSecureOfferDialog { cloud() }
    if (confirmEnable) AlertDialog(onDismissRequest = { confirmEnable = false }, title = { Text("Enable sync for this vault?") },
        text = { Text("Cloud changes can update and remove synced local files. Recovery copies are kept. Do not use Syncthing or another sync system on the same folder. Confirm that this vault is dedicated to JotDrop Cloud.") },
        confirmButton = { TextButton(onClick = { confirmEnable = false; run { CloudSyncManager.setEnabled(context, true) } }) { Text("Enable cloud sync") } },
        dismissButton = { TextButton(onClick = { confirmEnable = false }) { Text("Cancel") } })
    if (confirmDisconnect) AlertDialog(onDismissRequest = { confirmDisconnect = false }, title = { Text("Disconnect this device?") },
        text = { Text("Sync will stop. Local notes and recovery copies are kept. This does not revoke the device on the server; revoke it from another connected device if needed.") },
        confirmButton = { TextButton(onClick = { confirmDisconnect = false; run { CloudSyncManager.disconnect(context); files = emptyList(); devices = emptyList(); selected = null; generated = null } }) { Text("Disconnect") } },
        dismissButton = { TextButton(onClick = { confirmDisconnect = false }) { Text("Cancel") } })
    revoke?.let { device -> AlertDialog(onDismissRequest = { revoke = null }, title = { Text("Revoke ${device.getString("name") }?") },
        text = { Text("This stops future cloud access, not access to files or keys already downloaded. This device cannot revoke itself.") },
        confirmButton = { TextButton(onClick = { revoke = null; run { val client = cloud(); withContext(Dispatchers.IO) { client.revokeDevice(device.getString("id")) }; devices = emptyList() } }) { Text("Revoke access") } },
        dismissButton = { TextButton(onClick = { revoke = null }) { Text("Cancel") } }) }
    generated?.let { (code, expires) -> AlertDialog(onDismissRequest = { generated = null }, title = { Text("Pair another device") },
        text = { Column { Text("Keep this code private. It can be used once and expires at $expires."); SelectionContainer { Text(code, style = MaterialTheme.typography.bodySmall) } } },
        confirmButton = { TextButton(onClick = { generated = null }) { Text("Close") } }) }
    selected?.let { file -> AlertDialog(onDismissRequest = { if (!busy) selected = null }, title = { Text("History: ${file.path}") },
        text = { LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            preview?.let { item { Text(it, style = MaterialTheme.typography.bodySmall) } }
            item {
                Text("Choose a source only after comparing the original and its conflict copy.", style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { resolveLocal = true }, enabled = !busy && status?.enabled == true) { Text("Keep saved local version") }
                TextButton(onClick = { resolveLocal = false }, enabled = !busy && status?.enabled == true) { Text("Use current cloud version") }
            }
            items(versions, key = { it.getInt("revision") }) { version ->
                val revision = version.getInt("revision")
                Text("Revision $revision | ${version.optString("updatedAt")}${if (version.optBoolean("deleted")) " | Deleted" else ""}")
                if (version.optBoolean("locked")) {
                    // No link and no price: Google allows telling people where to upgrade, not sending them there.
                    Text("Replaced more than 30 days ago. JotDrop Plus restores it; see our website.", style = MaterialTheme.typography.bodySmall)
                } else {
                    if (revision != file.revision && !version.optBoolean("deleted") && !file.deleted && file.path.endsWith(".md", true)) {
                        TextButton(onClick = {
                            if (compared?.first == revision) compared = null
                            else run {
                                val client = cloud()
                                compared = revision to withContext(Dispatchers.IO) {
                                    CloudVersionDiff.lines(String(client.read(file.id, revision).bytes, Charsets.UTF_8), String(client.read(file.id).bytes, Charsets.UTF_8))
                                }
                            }
                        }, enabled = !busy) { Text("Compare with current") }
                    }
                    compared?.takeIf { it.first == revision }?.let { VersionDiff(it.second) }
                    TextButton(onClick = { restore = revision }, enabled = !busy && !version.optBoolean("deleted")) { Text("Restore this version") }
                }
            }
        } }, confirmButton = { TextButton(onClick = { selected = null }, enabled = !busy) { Text("Close") } }) }
    restore?.let { version -> AlertDialog(onDismissRequest = { restore = null }, title = { Text("Restore revision $version?") },
        text = { Text("A new cloud revision will be created. Changed local files are preserved as conflicts rather than overwritten. Sync afterward to download the restored version.") },
        confirmButton = { TextButton(onClick = {
            val file = selected ?: return@TextButton
            restore = null
            run { val client = cloud(); withContext(Dispatchers.IO) { client.restore(file.id, version, file.revision) }; selected = null; files = emptyList(); if (status?.enabled == true) CloudSyncManager.sync(context) }
        }, enabled = !busy) { Text("Restore") } }, dismissButton = { TextButton(onClick = { restore = null }) { Text("Cancel") } }) }
    if (confirmMoment) moment?.let { shown -> AlertDialog(onDismissRequest = { confirmMoment = false }, title = { Text("Restore ${momentLabel(shown.at)}?") },
        text = { Text("Files from then come back and files made later move to the trash. Every change is a new cloud version, so the time machine can undo this. Changed local files are kept as conflict copies.") },
        confirmButton = { TextButton(onClick = {
            confirmMoment = false
            run {
                // Send local changes first, then compare against the newest cloud versions.
                if (status?.enabled == true) CloudSyncManager.sync(context)
                val client = cloud()
                var done = 0
                try {
                    withContext(Dispatchers.IO) {
                        val current = client.current()
                        for (change in CloudTimeMachine.restorePlan(current, shown.then)) {
                            when (change) {
                                is CloudMomentStep.Restore -> client.restore(change.id, change.revision, change.baseRevision)
                                is CloudMomentStep.Delete -> client.remove(change.id, change.baseRevision)
                            }
                            done++
                        }
                    }
                } finally {
                    // Also after an error: say what did change.
                    moment = null
                    files = emptyList()
                    notice = "Restored $done file(s) to ${momentLabel(shown.at)}."
                }
                if (status?.enabled == true) CloudSyncManager.sync(context)
                moments = withContext(Dispatchers.IO) { client.moments() }
                step = (moments.size - 1).coerceAtLeast(0).toFloat()
            }
        }, enabled = !busy) { Text("Restore") } }, dismissButton = { TextButton(onClick = { confirmMoment = false }) { Text("Cancel") } }) }
    resolveLocal?.let { keepLocal -> AlertDialog(onDismissRequest = { resolveLocal = null }, title = { Text(if (keepLocal) "Keep the saved local version?" else "Use the current cloud version?") },
        text = { Text(if (keepLocal) "The saved local file, or its deletion, becomes the current cloud version. Unsaved editor text is not included. Cloud history remains available."
            else "The latest cloud version, or its deletion, is applied locally. A verified recovery copy is kept before changing an existing file.") },
        confirmButton = { TextButton(onClick = {
            val file = selected ?: return@TextButton
            resolveLocal = null
            run { CloudSyncManager.resolve(context, file.path, keepLocal); selected = null; files = emptyList() }
        }, enabled = !busy) { Text("Confirm choice") } }, dismissButton = { TextButton(onClick = { resolveLocal = null }) { Text("Cancel") } }) }
}

private data class MomentEntry(val id: String, val path: String, val preview: String?)
/** A weekly ZIP in a folder of your choice, for JotDrop Plus. */
@Composable
private fun BackupSection(busy: Boolean, run: (suspend () -> Unit) -> Unit) {
    val context = LocalContext.current
    var plus by remember { mutableStateOf<Boolean?>(null) }
    var folder by remember { mutableStateOf(CloudBackup.folder(context)) }
    var said by remember { mutableStateOf(CloudBackup.lastMessage(context)) }
    LaunchedEffect(Unit) { plus = withContext(Dispatchers.IO) { runCatching { CloudBackup.hasPlus(context) }.getOrNull() } }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        val notes = Storage.getVaultUri(context)
        if (notes != null && CloudBackup.insideNotes(notes, uri)) { said = "Choose a backup folder outside your notes folder."; return@rememberLauncherForActivityResult }
        CloudBackup.setFolder(context, uri)
        folder = uri
        said = "A backup goes to this folder every week."
    }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        when (plus) {
            null -> Unit
            // No link and no price: Google allows telling people where to upgrade, not sending them there.
            false -> Text("A weekly copy of your notes in a folder of your choice is part of JotDrop Plus. See our website.", style = MaterialTheme.typography.bodySmall)
            true -> {
                Text("Every week a ZIP of your notes goes to a folder you choose. Drive and Dropbox work if their apps offer a folder here. The ZIP is not encrypted: anyone who can open that folder can read it.", style = MaterialTheme.typography.bodySmall)
                val chosen = folder
                if (chosen != null) Text("Folder: ${androidx.documentfile.provider.DocumentFile.fromTreeUri(context, chosen)?.name ?: "chosen"}", style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { pick.launch(null) }, enabled = !busy) { Text(if (chosen == null) "Choose a folder" else "Change folder") }
                if (chosen != null) {
                    TextButton(onClick = { run { said = withContext(Dispatchers.IO) { CloudBackup.run(context) } } }, enabled = !busy) { Text("Back up now") }
                    TextButton(onClick = { CloudBackup.setFolder(context, null); folder = null; said = "Backups stopped. Your earlier backups stay in the folder." }, enabled = !busy) { Text("Stop backups") }
                }
            }
        }
        if (said.isNotEmpty()) Text(said, style = MaterialTheme.typography.bodySmall)
    }
}

/** Signs and a line through removed text, so the difference does not depend on colour. */
@Composable
private fun VersionDiff(lines: List<CloudVersionDiff.Line>?) {
    Column {
        when {
            lines == null -> Text("This note is too long to compare here.", style = MaterialTheme.typography.bodySmall)
            lines.all { it.kind == CloudVersionDiff.Kind.SAME } -> Text("This version is the same as the current note.", style = MaterialTheme.typography.bodySmall)
            else -> {
                Text("From this version to the current note: + was added, - was removed.", style = MaterialTheme.typography.bodySmall)
                for (line in CloudVersionDiff.fold(lines)) when (line.kind) {
                    CloudVersionDiff.Kind.GAP -> Text("${line.count} unchanged ${if (line.count == 1) "line" else "lines"}", style = MaterialTheme.typography.bodySmall)
                    CloudVersionDiff.Kind.SAME -> Text("  ${line.text}", style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                    CloudVersionDiff.Kind.ADDED -> Text("+ ${line.text}", style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
                    CloudVersionDiff.Kind.REMOVED -> Text("- ${line.text}", style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, textDecoration = TextDecoration.LineThrough)
                }
            }
        }
    }
}

private data class TimeMoment(val at: String, val then: List<CloudMomentFile>, val files: List<MomentEntry>, val trashed: Int, val locked: Int, val cleared: Int)

private fun momentLabel(at: String): String = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM).withZone(ZoneId.systemDefault()).format(Instant.parse(at))

private class CloudSection(val title: String, val short: String, val hint: String, val icon: ImageVector)
private val CLOUD_SECTIONS = listOf(
    CloudSection("Files", "Everything in your cloud", "Every note and attachment in your cloud. Open the history of a file to compare or restore an earlier version.", Icons.Filled.Description),
    CloudSection("Trash", "Deleted notes", "Notes you deleted. Open the history to bring one back.", Icons.Filled.Delete),
    CloudSection("Devices", "Phones and computers", "The phones, computers and browsers that can open your notes. Revoke one you no longer use.", Icons.Filled.Devices),
    CloudSection("Time machine", "Go back in time", "See your whole cloud as it was at an earlier moment, and restore it if you want.", Icons.Filled.History),
)

/** One part of the cloud screen: a card with an icon and a title, so the parts do not run into each other (Eric, 2 Nov). */
@Composable
private fun CloudCard(icon: ImageVector, title: String, content: @Composable ColumnScope.() -> Unit) {
    ElevatedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, null, tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(10.dp))
                Text(title, style = MaterialTheme.typography.titleLarge)
            }
            content()
        }
    }
}

/** The end of a running sign-up trial from `/status`, or null: the server only sends `trialEnds` while the trial is what gives Plus. */
internal fun trialEndsOf(status: JSONObject): java.time.Instant? =
    status.optJSONObject("plan")?.takeUnless { it.isNull("trialEnds") }?.optString("trialEnds")?.takeIf { it.isNotBlank() }
        ?.let { runCatching { java.time.Instant.parse(it) }.getOrNull() }

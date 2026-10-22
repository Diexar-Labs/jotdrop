package com.diexar.keepcapture

import android.content.Context
import android.os.Build
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

private const val DEFAULT_SERVER = "https://api.jotdrop.net"

/** Pending sign-in steps survive rotation for the life of the process. Passwords are never kept here. */
internal object CloudAccountFlow {
    var signup by mutableStateOf<CloudSignup?>(null)
    var login by mutableStateOf<CloudLoginChallenge?>(null)
    var reset by mutableStateOf<CloudReset?>(null)
    var approval by mutableStateOf<CloudApprovalRequest?>(null)
    var attach by mutableStateOf<CloudSignup?>(null)
    var recoveryCode by mutableStateOf<String?>(null)
    fun clear() { signup = null; login = null; reset = null; approval = null }
}

internal fun cloudDeviceName(): String =
    "JotDrop on ${Build.MANUFACTURER} ${Build.MODEL}".replace(Regex("\\p{Cntrl}"), " ").trim().take(80)

private suspend fun <T> io(block: () -> T): T = withContext(Dispatchers.IO) { block() }

/** Once the server may have committed (account created, cloud deleted), finish locally even if the screen goes away. */
private suspend fun <T> committed(block: suspend () -> T): T = withContext(NonCancellable) { block() }

private suspend fun keepRecoveryCode(context: Context, code: String) {
    io { CloudPreviewStore(context).saveRecoveryCode(code) }
    CloudAccountFlow.recoveryCode = code
}

private fun localTime(value: String): String = runCatching {
    DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withZone(ZoneId.systemDefault()).format(Instant.parse(value))
}.getOrDefault(value)

private fun newPasswordProblem(password: String, confirm: String): String? = when {
    password.length < 12 -> "Use at least 12 characters."
    password != confirm -> "The passwords do not match."
    else -> null
}

@Composable
private fun PasswordField(value: String, onChange: (String) -> Unit, label: String, enabled: Boolean) {
    OutlinedTextField(value, { if (it.length <= 1024) onChange(it) }, label = { Text(label) }, visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrect = false), singleLine = true, enabled = enabled,
        modifier = Modifier.fillMaxWidth())
}

@Composable
private fun EmailField(value: String, onChange: (String) -> Unit, enabled: Boolean) {
    OutlinedTextField(value, { if (it.length <= 254) onChange(it.trim()) }, label = { Text("Email") },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrect = false), singleLine = true, enabled = enabled,
        modifier = Modifier.fillMaxWidth())
}

@Composable
private fun CodeField(value: String, onChange: (String) -> Unit, enabled: Boolean) {
    OutlinedTextField(value, { next -> if (next.length <= 6 && next.all(Char::isDigit)) onChange(next) }, label = { Text("6-digit code") },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword), singleLine = true, enabled = enabled,
        modifier = Modifier.fillMaxWidth())
}

/** The whole row toggles, not only the small box. */
@Composable
private fun CheckRow(checked: Boolean, onChange: (Boolean) -> Unit, label: String, enabled: Boolean = true) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
        .toggleable(value = checked, onValueChange = onChange, enabled = enabled, role = Role.Checkbox)) {
        Checkbox(checked = checked, onCheckedChange = null, enabled = enabled)
        Text(label, modifier = Modifier.padding(start = 12.dp))
    }
}

@Composable
private fun Problem(text: String?) {
    text?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
}

/** Sign in, create an account or recover access on a device that is not connected yet. */
@Composable
internal fun CloudSignIn(busy: Boolean, run: (suspend () -> Unit) -> Unit, showError: (String) -> Unit, pairing: @Composable () -> Unit) {
    val context = LocalContext.current
    val flow = CloudAccountFlow
    var mode by rememberSaveable { mutableStateOf("signin") }
    var server by rememberSaveable { mutableStateOf(DEFAULT_SERVER) }
    var email by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var recovery by remember { mutableStateOf("") }
    var route by rememberSaveable { mutableStateOf("approve") }
    var understood by remember { mutableStateOf(false) }
    fun startAgain() { flow.clear(); password = ""; confirm = ""; code = ""; recovery = ""; understood = false }
    val serverField: @Composable () -> Unit = {
        OutlinedTextField(server, { if (it.length <= 200) server = it.trim() }, label = { Text("Server") }, singleLine = true, enabled = !busy,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrect = false), modifier = Modifier.fillMaxWidth())
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        val login = flow.login
        val signup = flow.signup
        val approval = flow.approval
        val reset = flow.reset
        when {
            login != null -> {
                Text("Enter your code", style = MaterialTheme.typography.titleLarge)
                Text(if (login.secondFactor == "totp") "Open your authenticator app and enter the 6-digit code for JotDrop."
                    else "We sent a 6-digit code to $email. It is valid for 15 minutes.")
                CodeField(code, { code = it }, !busy)
                Button(onClick = { run { committed {
                    val client = io { CloudAccount.confirmLogin(login, code) }
                    CloudSyncManager.connectAccount(context, client)
                    startAgain()
                } } }, enabled = !busy && code.length == 6) { Text("Sign in") }
                TextButton(onClick = ::startAgain, enabled = !busy) { Text("Start again") }
            }
            signup != null -> {
                Text("Confirm your email", style = MaterialTheme.typography.titleLarge)
                Text("We sent a 6-digit code to $email. It is valid for 15 minutes.")
                CodeField(code, { code = it }, !busy)
                Button(onClick = { run { committed {
                    val result = checkNotNull(io { CloudAccount.confirmSignup(signup, code) })
                    keepRecoveryCode(context, result.recoveryCode)
                    CloudSyncManager.connectAccount(context, result.client)
                    startAgain()
                } } }, enabled = !busy && code.length == 6) { Text("Create account") }
                TextButton(onClick = ::startAgain, enabled = !busy) { Text("Start again") }
            }
            approval != null -> ApprovalWait(approval, busy, run, showError, onDone = ::startAgain)
            reset != null -> {
                Text("Choose how to get back in", style = MaterialTheme.typography.titleLarge)
                Text("If $email has an account, we sent it a 6-digit code. Your notes on this device are not affected by any of these choices.")
                CodeField(code, { code = it }, !busy)
                listOf(
                    "approve" to "Approve on a connected device (phone or browser)",
                    "recovery" to "Use my recovery code",
                    "restart" to "I have neither: start the cloud over",
                ).forEach { (value, label) ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                        .selectable(selected = route == value, onClick = { route = value }, enabled = !busy, role = Role.RadioButton)) {
                        RadioButton(selected = route == value, onClick = null, enabled = !busy)
                        Text(label, modifier = Modifier.weight(1f).padding(start = 12.dp))
                    }
                }
                when (route) {
                    "approve" -> Button(onClick = { run { flow.approval = io { CloudAccount.requestApproval(reset, code) }; code = "" } },
                        enabled = !busy && code.length == 6) { Text("Ask for approval") }
                    "recovery" -> {
                        OutlinedTextField(recovery, { if (it.length <= 2048) recovery = it.trim() }, label = { Text("Recovery code") },
                            visualTransformation = PasswordVisualTransformation(), maxLines = 3, enabled = !busy, modifier = Modifier.fillMaxWidth(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrect = false))
                        PasswordField(password, { password = it }, "New password", !busy)
                        PasswordField(confirm, { confirm = it }, "Repeat new password", !busy)
                        if (password.isNotEmpty()) Problem(newPasswordProblem(password, confirm))
                        Button(onClick = { run { committed {
                            val client = io { CloudAccount.resetWithRecoveryCode(reset, code, recovery, password, cloudDeviceName()) }
                            CloudSyncManager.connectAccount(context, client)
                            startAgain()
                        } } }, enabled = !busy && code.length == 6 && recovery.isNotBlank() && newPasswordProblem(password, confirm) == null) { Text("Set new password") }
                    }
                    else -> {
                        Text("This permanently deletes the encrypted copy in the cloud, because nobody can read it any more. All devices are signed out. " +
                            "Your Markdown notes on this phone and your other devices stay as they are and can be uploaded again.",
                            color = MaterialTheme.colorScheme.error)
                        CheckRow(understood, { understood = it }, "I understand that the cloud copy will be deleted", !busy)
                        PasswordField(password, { password = it }, "New password", !busy)
                        PasswordField(confirm, { confirm = it }, "Repeat new password", !busy)
                        if (password.isNotEmpty()) Problem(newPasswordProblem(password, confirm))
                        Button(onClick = { run { committed {
                            val result = io { CloudAccount.startOver(reset, code, password, cloudDeviceName()) }
                            keepRecoveryCode(context, result.recoveryCode)
                            CloudSyncManager.connectAccount(context, result.client)
                            startAgain()
                        } } }, enabled = !busy && understood && code.length == 6 && newPasswordProblem(password, confirm) == null,
                            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text("Delete the cloud copy and start over") }
                    }
                }
                TextButton(onClick = ::startAgain, enabled = !busy) { Text("Start again") }
            }
            mode == "signup" -> {
                Text("Create a JotDrop Cloud account", style = MaterialTheme.typography.titleLarge)
                Text("Your password never leaves this device. It locks your notes before they are uploaded, so the server cannot read them.")
                EmailField(email, { email = it }, !busy)
                PasswordField(password, { password = it }, "Password (at least 12 characters)", !busy)
                PasswordField(confirm, { confirm = it }, "Repeat password", !busy)
                if (password.isNotEmpty()) Problem(newPasswordProblem(password, confirm))
                serverField()
                Button(onClick = { run { flow.signup = io { CloudAccount.signUp(server, email, password, cloudDeviceName()) }; password = ""; confirm = "" } },
                    enabled = !busy && email.contains('@') && newPasswordProblem(password, confirm) == null) { Text("Create account") }
                TextButton(onClick = { mode = "signin" }, enabled = !busy) { Text("I already have an account") }
            }
            mode == "forgot" -> {
                Text("Forgot your password?", style = MaterialTheme.typography.titleLarge)
                Text("We will email you a code. Then you can approve this phone on a connected device, use your recovery code, or start the cloud over.")
                EmailField(email, { email = it }, !busy)
                serverField()
                Button(onClick = { run { flow.reset = io { CloudAccount.startReset(server, email) } } }, enabled = !busy && email.contains('@')) { Text("Send code") }
                TextButton(onClick = { mode = "signin" }, enabled = !busy) { Text("Back to sign in") }
            }
            mode == "pair" -> {
                pairing()
                TextButton(onClick = { mode = "signin" }, enabled = !busy) { Text("Sign in with email instead") }
            }
            else -> {
                Text("Sign in to JotDrop Cloud", style = MaterialTheme.typography.titleLarge)
                EmailField(email, { email = it }, !busy)
                PasswordField(password, { password = it }, "Password", !busy)
                serverField()
                Button(onClick = { run { flow.login = io { CloudAccount.logIn(server, email, password, cloudDeviceName()) }; password = "" } },
                    enabled = !busy && email.contains('@') && password.isNotEmpty()) { Text("Continue") }
                TextButton(onClick = { mode = "forgot" }, enabled = !busy) { Text("Forgot password?") }
                TextButton(onClick = { mode = "signup" }, enabled = !busy) { Text("Create an account") }
                TextButton(onClick = { mode = "pair" }, enabled = !busy) { Text("Use a one-time pairing code") }
            }
        }
    }
}

@Composable
private fun ApprovalWait(pending: CloudApprovalRequest, busy: Boolean, run: (suspend () -> Unit) -> Unit, showError: (String) -> Unit, onDone: () -> Unit) {
    val context = LocalContext.current
    var approved by remember(pending) { mutableStateOf(pending.approved) }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    LaunchedEffect(pending) {
        while (!approved) {
            delay(3000)
            try { if (io { CloudAccount.checkApproval(pending) }) approved = true }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: CloudRequestException) {
                if (failure.status == 401) { onDone(); showError("The request was rejected or has expired. Start again."); return@LaunchedEffect }
            }
            catch (_: Exception) { /* Offline for a moment; keep waiting until the request expires. */ }
        }
    }
    if (!approved) {
        Text("Approve on your other device", style = MaterialTheme.typography.titleLarge)
        Text("Open JotDrop Cloud on a device that is already connected and look for the new request. Approve it only if it shows exactly these four words:")
        Text(pending.words.joinToString("   "), style = MaterialTheme.typography.headlineSmall)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            Text("Waiting for approval. The request expires at ${localTime(pending.expiresAt)}.", style = MaterialTheme.typography.bodySmall)
        }
        TextButton(onClick = onDone, enabled = !busy) { Text("Cancel") }
    } else {
        Text("Approved. Choose a new password", style = MaterialTheme.typography.titleLarge)
        PasswordField(password, { password = it }, "New password (at least 12 characters)", !busy)
        PasswordField(confirm, { confirm = it }, "Repeat new password", !busy)
        if (password.isNotEmpty()) Problem(newPasswordProblem(password, confirm))
        Text("Finish within 10 minutes of asking for approval; after that, start again.", style = MaterialTheme.typography.bodySmall)
        Button(onClick = { run { committed {
            val client = try { io { CloudAccount.completeApproval(pending, password, cloudDeviceName()) } }
                catch (failure: CloudRequestException) { if (failure.status == 401) onDone(); throw failure }
            CloudSyncManager.connectAccount(context, client)
            onDone()
        } } }, enabled = !busy && newPasswordProblem(password, confirm) == null) { Text("Set new password") }
        TextButton(onClick = onDone, enabled = !busy) { Text("Start again") }
    }
}

/** Account settings on a connected device: add email sign-in, change the password, approve new devices. */
@Composable
internal fun CloudAccountSection(busy: Boolean, run: (suspend () -> Unit) -> Unit, cloud: suspend () -> CloudClient) {
    val flow = CloudAccountFlow
    var email by remember { mutableStateOf<String?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var loadFailed by remember { mutableStateOf(false) }
    var reload by remember { mutableStateOf(0) }
    var notice by remember { mutableStateOf<String?>(null) }
    var newEmail by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var current by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var changing by rememberSaveable { mutableStateOf(false) }
    var signOutOthers by rememberSaveable { mutableStateOf(false) }
    var approvals by remember { mutableStateOf<List<CloudApproval>?>(null) }
    var approve by remember { mutableStateOf<CloudApproval?>(null) }
    LaunchedEffect(reload) {
        loadFailed = false
        try { val client = cloud(); email = io { CloudAccount.accountEmail(client) }; loaded = true }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { loadFailed = true }
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Account", style = MaterialTheme.typography.titleLarge)
        notice?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        val attach = flow.attach
        when {
            loadFailed -> {
                Text("Account details could not be loaded. Check the connection.")
                TextButton(onClick = { reload++ }, enabled = !busy) { Text("Try again") }
            }
            !loaded -> Text("Loading account details...", style = MaterialTheme.typography.bodySmall)
            attach != null -> {
                Text("We sent a 6-digit code to ${newEmail}. It is valid for 15 minutes.")
                CodeField(code, { code = it }, !busy)
                Button(onClick = { run { committed { io { CloudAccount.confirmSignup(attach, code) } }; flow.attach = null; code = ""; notice = "Email sign-in is ready. You can now sign in on new devices with your email and password."; reload++ } },
                    enabled = !busy && code.length == 6) { Text("Confirm email") }
                TextButton(onClick = { flow.attach = null; code = "" }, enabled = !busy) { Text("Cancel") }
            }
            email == null -> {
                Text("This cloud has no email sign-in yet. Add an email and password to sign in on new devices without a pairing code. Nothing has to be uploaded again.")
                EmailField(newEmail, { newEmail = it }, !busy)
                PasswordField(password, { password = it }, "Password (at least 12 characters)", !busy)
                PasswordField(confirm, { confirm = it }, "Repeat password", !busy)
                if (password.isNotEmpty()) Problem(newPasswordProblem(password, confirm))
                Button(onClick = { run { val client = cloud(); flow.attach = io { CloudAccount.attachAccount(client, newEmail, password) }; password = ""; confirm = "" } },
                    enabled = !busy && newEmail.contains('@') && newPasswordProblem(password, confirm) == null) { Text("Add email sign-in") }
            }
            else -> {
                Text("Email sign-in: $email", style = MaterialTheme.typography.bodyMedium)
                OutlinedButton(onClick = { run { val client = cloud(); approvals = io { CloudAccount.listApprovals(client) } } }, enabled = !busy) { Text("Check requests from new devices") }
                approvals?.let { list ->
                    if (list.isEmpty()) Text("No devices are waiting for approval.", style = MaterialTheme.typography.bodySmall)
                    list.forEach { request ->
                        Column {
                            Text("A new device asks for access", style = MaterialTheme.typography.titleMedium)
                            Text("Words: ${request.words.joinToString(" ")}", style = MaterialTheme.typography.bodyLarge)
                            Text("Expires at ${localTime(request.expiresAt)}", style = MaterialTheme.typography.bodySmall)
                            Row {
                                TextButton(onClick = { approve = request }, enabled = !busy) { Text("Approve") }
                                TextButton(onClick = { run { val client = cloud(); io { CloudAccount.rejectDevice(client, request.id) }; approvals = list - request } }, enabled = !busy) { Text("Reject") }
                            }
                        }
                    }
                }
                if (!changing) TextButton(onClick = { changing = true }, enabled = !busy) { Text("Change password") }
                else {
                    PasswordField(current, { current = it }, "Current password", !busy)
                    PasswordField(password, { password = it }, "New password (at least 12 characters)", !busy)
                    PasswordField(confirm, { confirm = it }, "Repeat new password", !busy)
                    if (password.isNotEmpty()) Problem(newPasswordProblem(password, confirm))
                    CheckRow(signOutOthers, { signOutOthers = it }, "Sign out all other devices", !busy)
                    Row {
                        Button(onClick = { run {
                            val client = cloud()
                            io { CloudAccount.changePassword(client, current, password, signOutOthers) }
                            current = ""; password = ""; confirm = ""; changing = false; notice = "Password changed."
                        } }, enabled = !busy && current.isNotEmpty() && newPasswordProblem(password, confirm) == null) { Text("Change password") }
                        TextButton(onClick = { changing = false; current = ""; password = ""; confirm = "" }, enabled = !busy) { Text("Cancel") }
                    }
                }
            }
        }
    }
    approve?.let { request -> AlertDialog(onDismissRequest = { approve = null }, title = { Text("Approve this device?") },
        text = { Text("Only approve if the new device shows exactly these words:\n\n${request.words.joinToString("   ")}\n\nThe device gets full access to your notes.") },
        confirmButton = { TextButton(onClick = { approve = null; run {
            val client = cloud()
            io { CloudAccount.approveDevice(client, request) }
            approvals = approvals?.minus(request)
            notice = "Approved. The new device can now choose a new password."
        } }, enabled = !busy) { Text("Words match, approve") } },
        dismissButton = { TextButton(onClick = { approve = null }) { Text("Cancel") } }) }
}

/** Shown once after creating a cloud; without this code a forgotten password can only start the cloud over. */
@Composable
internal fun CloudRecoveryDialog() {
    val context = LocalContext.current
    LaunchedEffect(Unit) {
        // After the process was killed, the code is still waiting in encrypted storage.
        if (CloudAccountFlow.recoveryCode == null) runCatching { io { CloudPreviewStore(context).recoveryCode() } }.getOrNull()?.let { CloudAccountFlow.recoveryCode = it }
    }
    val code = CloudAccountFlow.recoveryCode ?: return
    var saved by remember { mutableStateOf(false) }
    AlertDialog(onDismissRequest = {}, title = { Text("Save your recovery code") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("If you forget your password and have no other connected device, this code is the only way back to your cloud. Store it somewhere safe, for example in a password manager. JotDrop cannot show it again.")
            SelectionContainer { Text(code, style = MaterialTheme.typography.bodySmall) }
            CheckRow(saved, { saved = it }, "I saved my recovery code")
        } },
        confirmButton = { TextButton(onClick = {
            CloudAccountFlow.recoveryCode = null
            runCatching { CloudPreviewStore(context).clearRecoveryCode() }
        }, enabled = saved) { Text("Done") } })
}

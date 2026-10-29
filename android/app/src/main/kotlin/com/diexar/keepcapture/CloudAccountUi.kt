package com.diexar.keepcapture

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PersistableBundle
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

private const val DEFAULT_SERVER = "https://app.jotdrop.net"
private val PROVIDER_NAMES = mapOf("google" to "Google", "github" to "GitHub")

/** Pending sign-in steps survive rotation for the life of the process. Passwords are never kept here; `secureOffer` holds only the login key of a new password. */
internal object CloudAccountFlow {
    var signup by mutableStateOf<CloudSignup?>(null)
    var login by mutableStateOf<CloudLoginChallenge?>(null)
    var reset by mutableStateOf<CloudReset?>(null)
    var approval by mutableStateOf<CloudApprovalRequest?>(null)
    var attach by mutableStateOf<CloudSignup?>(null)
    var recoveryCode by mutableStateOf<String?>(null)
    var deviceChoice by mutableStateOf<CloudDeviceChoice?>(null)
    /** Google or GitHub is open in the browser; `providerReturn` is the jotdrop-cloud://oauth link it comes back with. */
    var waitingFor by mutableStateOf<String?>(null)
    var providerReturn by mutableStateOf<Uri?>(null)
    /** The person check is open in the browser; `personReturn` is the token it comes back with (jotdrop-cloud://human). */
    var waitingForPerson by mutableStateOf(false)
    var personReturn by mutableStateOf<String?>(null)
    var provider by mutableStateOf<CloudProviderSignIn?>(null)
    /** Opened from the welcome screen: Google sign-in starts without another tap. */
    var startGoogle by mutableStateOf(false)
    /** Signed up with a password: the authenticator offer follows the recovery code, then this is dropped. */
    var secureOffer by mutableStateOf<CloudSecureOffer?>(null)
    /** An authenticator being set up, in settings or in the offer, until it is turned on or cancelled. */
    var totpSetup by mutableStateOf<CloudTotpSetup?>(null)
    /** Bumped when the offer changed the account, so the account section loads it again. */
    var accountChanged by mutableStateOf(0)
    fun clear() { signup = null; login = null; reset = null; approval = null; deviceChoice = null; waitingFor = null; waitingForPerson = false; provider = null; totpSetup = null }
}

/** The free plan's device limit was reached: the person picks the device this phone replaces, and `retry` repeats the same sign-in. */
internal class CloudDeviceChoice(val message: String, val devices: List<CloudDeviceInfo>, val retry: suspend (String) -> Unit)

/** Runs a sign-in; at the device limit it asks which device to replace instead of failing. The server kept the code, so the retry reuses it. */
private suspend fun withDeviceChoice(connect: suspend (String?) -> Unit) {
    try { connect(null) }
    catch (failure: CloudRequestException) {
        if (failure.code != "device-limit" || failure.devices.isEmpty()) throw failure
        CloudAccountFlow.deviceChoice = CloudDeviceChoice(failure.serverMessage ?: "This cloud has reached its device limit.", failure.devices) { connect(it) }
    }
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

private fun localDate(value: String): String = runCatching {
    DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withZone(ZoneId.systemDefault()).format(Instant.parse(value))
}.getOrDefault(value)

@Composable
private fun DeviceChoiceDialog(choice: CloudDeviceChoice, busy: Boolean, run: (suspend () -> Unit) -> Unit) {
    AlertDialog(
        onDismissRequest = { if (!busy) CloudAccountFlow.deviceChoice = null },
        title = { Text("Choose a device to sign out") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.verticalScroll(rememberScrollState())) {
                Text("${choice.message} This phone takes the place of the device you choose; that device is signed out.")
                choice.devices.forEach { device ->
                    OutlinedButton(onClick = { run { committed { CloudAccountFlow.deviceChoice = null; choice.retry(device.id) } } },
                        enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                        Text("Sign out ${device.name}\nLast used ${localDate(device.lastSeenAt)}")
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = { CloudAccountFlow.deviceChoice = null }, enabled = !busy) { Text("Cancel") } },
    )
}

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
// Off unless the person ticks it, like on the website and in Obsidian.
private const val NEWSLETTER_LABEL = "Email me news about JotDrop."

@Composable
private fun CheckRow(checked: Boolean, onChange: (Boolean) -> Unit, label: String, enabled: Boolean = true) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
        .toggleable(value = checked, onValueChange = onChange, enabled = enabled, role = Role.Checkbox)) {
        Checkbox(checked = checked, onCheckedChange = null, enabled = enabled)
        Text(label, modifier = Modifier.padding(start = 12.dp))
    }
}

/** Google first offers Android's own account picker; without it (no Play services, or not set up for this build) the browser signs in. */
private suspend fun startProviderSignIn(context: Context, server: String, name: String) {
    val clientId = if (name == "google") io { CloudAccount.googleClientId(server) } else null
    if (clientId != null) {
        val verifier = CloudCrypto.token()
        val option = GetSignInWithGoogleOption.Builder(clientId).setNonce(CloudCrypto.hashToken(verifier)).build()
        val credential = try { CredentialManager.create(context).getCredential(context, GetCredentialRequest(listOf(option))).credential }
            catch (_: GetCredentialCancellationException) { return }
            catch (_: GetCredentialException) { null }
        if (credential is CustomCredential && credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
            val token = GoogleIdTokenCredential.createFrom(credential.data).idToken
            CloudAccountFlow.provider = io { CloudAccount.googleIdTicket(server, token, verifier) }
            return
        }
    }
    val start = io { CloudAccount.startProviderSignIn(server, name) }
    io { CloudPreviewStore(context).saveProviderStart(JSONObject().put("url", start.url).put("verifier", start.verifier)) }
    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(start.href)))
    CloudAccountFlow.waitingFor = name
}

/** Each provider's own colours and mark, with its name: Google light or dark neutral, GitHub near black. */
@Composable
internal fun ProviderButton(name: String, label: String, enabled: Boolean, onClick: () -> Unit) {
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val google = name == "google"
    val container = if (google) (if (dark) Color(0xFF131314) else Color.White) else Color(0xFF24292F)
    val content = if (google && !dark) Color(0xFF1F1F1F) else if (google) Color(0xFFE3E3E3) else Color.White
    val edge = if (google) (if (dark) Color(0xFF8E918F) else Color(0xFF747775)) else if (dark) Color(0xFF6E7681) else Color(0xFF24292F)
    OutlinedButton(onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), border = BorderStroke(1.dp, edge),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = container, contentColor = content)) {
        Image(painterResource(if (google) R.drawable.ic_provider_google else R.drawable.ic_provider_github), contentDescription = null, modifier = Modifier.size(20.dp))
        Text(label, modifier = Modifier.padding(start = 12.dp))
    }
}

/** Google or GitHub only say who you are; the key to the notes still comes from your own devices. */
@Composable
private fun ProviderButtons(providers: List<String>, server: String, busy: Boolean, run: (suspend () -> Unit) -> Unit) {
    if (providers.isEmpty()) return
    val context = LocalContext.current
    providers.forEach { name ->
        ProviderButton(name, "Continue with ${PROVIDER_NAMES.getValue(name)}", !busy) { run { startProviderSignIn(context, server, name) } }
    }
    Text("Or with email and password:", style = MaterialTheme.typography.bodySmall)
}

/** The privacy policy lives on the cloud server itself. */
@Composable
private fun PrivacyLink(server: suspend () -> String, enabled: Boolean) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    TextButton(onClick = { scope.launch {
        val url = runCatching { server() }.getOrNull() ?: return@launch
        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${url.trimEnd('/')}/privacy"))) }
    } }, enabled = enabled) { Text("Privacy policy") }
}

@Composable
private fun Problem(text: String?) {
    text?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
}

/** Opens the otpauth:// link in an authenticator app on this phone; the setup key is for typing it in by hand. */
@Composable
private fun TotpSetupSteps(setup: CloudTotpSetup, code: String, onCode: (String) -> Unit, enabled: Boolean) {
    val context = LocalContext.current
    var noApp by remember(setup) { mutableStateOf(false) }
    var copied by remember(setup) { mutableStateOf(false) }
    Text("Add JotDrop to your authenticator app, then enter the 6-digit code it shows.")
    Button(onClick = {
        noApp = try { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(setup.uri))); false } catch (_: ActivityNotFoundException) { true }
    }, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Open authenticator app") }
    Problem(if (noApp) "No authenticator app is installed on this phone. Install one, like Google Authenticator, Microsoft Authenticator or 2FAS, " +
        "and tap \"Open authenticator app\" again. Or type the setup key below into an authenticator app." else null)
    Text("No authenticator on this phone? Choose \"enter a setup key\" in the app and type this key.", style = MaterialTheme.typography.bodySmall)
    SelectionContainer { Text(setup.secret, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyLarge) }
    TextButton(onClick = {
        // Marked sensitive, so Android does not show the key in its clipboard preview.
        val clip = ClipData.newPlainText("JotDrop setup key", setup.secret)
        clip.description.extras = PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true) }
        context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(clip)
        copied = true
    }, enabled = enabled) { Text(if (copied) "Setup key copied" else "Copy setup key") }
    CodeField(code, onCode, enabled)
}

/** Wrong code or password: the server's own words, shown next to the fields, which stay filled in. */
private fun accountProblem(failure: Exception): String = when {
    failure is CloudRequestException -> failure.serverMessage ?: failure.message
    (failure is IllegalArgumentException || failure is IllegalStateException) -> failure.message
    else -> null
} ?: "This could not complete. Check the connection and try again."

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
    var newsletter by rememberSaveable { mutableStateOf(false) }
    var providers by remember { mutableStateOf<List<String>>(emptyList()) }
    fun startAgain() { flow.clear(); password = ""; confirm = ""; code = ""; recovery = ""; understood = false }
    LaunchedEffect(server) {
        delay(500)
        providers = runCatching { io { CloudAccount.providers(server) } }.getOrDefault(emptyList()).filter { it in PROVIDER_NAMES }
    }
    // From the welcome screen: straight to Google.
    LaunchedEffect(Unit) {
        if (!flow.startGoogle) return@LaunchedEffect
        flow.startGoogle = false
        run { startProviderSignIn(context, server, "google") }
    }
    // Back from the browser: the ticket only works with the verifier this phone kept, and only once.
    LaunchedEffect(flow.providerReturn) {
        val back = flow.providerReturn ?: return@LaunchedEffect
        flow.providerReturn = null
        run {
            val store = CloudPreviewStore(context)
            val started = io { store.providerStart().also { store.clearProviderStart() } }
            flow.waitingFor = null
            val ticket = back.getQueryParameter("oauth") ?: throw IllegalStateException(back.getQueryParameter("oauth-error") ?: "The sign-in did not finish. Try again.")
            checkNotNull(started) { "This sign-in was started elsewhere or has expired. Start again here." }
            flow.provider = io { CloudAccount.providerTicket(started.getString("url"), ticket, started.getString("verifier")) }
        }
    }
    // Back from the person check: the new account is made with the token, once.
    LaunchedEffect(flow.personReturn) {
        val token = flow.personReturn ?: return@LaunchedEffect
        flow.personReturn = null
        if (!flow.waitingForPerson) return@LaunchedEffect
        flow.waitingForPerson = false
        run { flow.signup = io { CloudAccount.signUp(server, email, password, cloudDeviceName(), newsletter, token) }; password = ""; confirm = "" }
    }
    val serverField: @Composable () -> Unit = {
        OutlinedTextField(server, { if (it.length <= 200) server = it.trim() }, label = { Text("Server") }, singleLine = true, enabled = !busy,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrect = false), modifier = Modifier.fillMaxWidth())
    }

    flow.deviceChoice?.let { DeviceChoiceDialog(it, busy, run) }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        val login = flow.login
        val signup = flow.signup
        val approval = flow.approval
        val reset = flow.reset
        val provider = flow.provider
        val waiting = flow.waitingFor
        when {
            login != null -> {
                Text("Enter your code", style = MaterialTheme.typography.titleLarge)
                Text(if (login.secondFactor == "totp") "Open your authenticator app and enter the 6-digit code for JotDrop."
                    else "We sent a 6-digit code to $email. It is valid for 15 minutes.")
                CodeField(code, { code = it }, !busy)
                Button(onClick = { run { committed { withDeviceChoice { replace ->
                    val client = io { CloudAccount.confirmLogin(login, code, replace) }
                    CloudSyncManager.connectAccount(context, client)
                    startAgain()
                } } } }, enabled = !busy && code.length == 6) { Text("Sign in") }
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
                    flow.secureOffer = result.secureOffer
                } } }, enabled = !busy && code.length == 6) { Text("Create account") }
                TextButton(onClick = ::startAgain, enabled = !busy) { Text("Start again") }
            }
            approval != null -> ApprovalWait(approval, busy, run, showError, onDone = ::startAgain)
            provider != null -> {
                val name = PROVIDER_NAMES[provider.provider] ?: provider.provider
                Text(if (provider.account) "Open your notes on this phone" else "Create your JotDrop cloud", style = MaterialTheme.typography.titleLarge)
                Text("Signed in with $name as ${provider.email}.")
                if (!provider.account) {
                    Text("Free, with 250 MB of storage. Your notes are encrypted on this phone before they leave it. You get a recovery code: keep it safe, it opens your notes if you lose your devices.")
                    CheckRow(newsletter, { newsletter = it }, NEWSLETTER_LABEL, !busy)
                    Button(onClick = { run { committed {
                        val result = io { CloudAccount.providerSignUp(provider, cloudDeviceName(), newsletter) }
                        keepRecoveryCode(context, result.recoveryCode)
                        CloudSyncManager.connectAccount(context, result.client)
                        startAgain()
                    } } }, enabled = !busy) { Text("Create my cloud and start syncing") }
                } else {
                    Text("Only your own devices hold the key to your notes. Get it from a device that is signed in, or with your recovery code.")
                    Button(onClick = { run { flow.approval = io { CloudAccount.providerApproval(provider) }; flow.provider = null } }, enabled = !busy) { Text("Approve on a signed-in device") }
                    OutlinedTextField(recovery, { if (it.length <= 2048) recovery = it.trim() }, label = { Text("Or use your recovery code") },
                        visualTransformation = PasswordVisualTransformation(), maxLines = 3, enabled = !busy, modifier = Modifier.fillMaxWidth(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrect = false))
                    OutlinedButton(onClick = { run { committed { withDeviceChoice { replace ->
                        val client = io { CloudAccount.providerRecover(provider, recovery, cloudDeviceName(), replace) }
                        CloudSyncManager.connectAccount(context, client)
                        startAgain()
                    } } } }, enabled = !busy && recovery.isNotBlank()) { Text("Use recovery code") }
                }
                TextButton(onClick = ::startAgain, enabled = !busy) { Text("Start again") }
            }
            waiting != null -> {
                Text("Continue with ${PROVIDER_NAMES[waiting] ?: waiting}", style = MaterialTheme.typography.titleLarge)
                Text("Sign in with ${PROVIDER_NAMES[waiting] ?: waiting} in your browser. JotDrop comes back here when you are done.")
                TextButton(onClick = { flow.waitingFor = null }, enabled = !busy) { Text("Back") }
            }
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
                        Button(onClick = { run { committed { withDeviceChoice { replace ->
                            val client = io { CloudAccount.resetWithRecoveryCode(reset, code, recovery, password, cloudDeviceName(), replace) }
                            CloudSyncManager.connectAccount(context, client)
                            startAgain()
                        } } } }, enabled = !busy && code.length == 6 && recovery.isNotBlank() && newPasswordProblem(password, confirm) == null) { Text("Set new password") }
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
                ProviderButtons(providers, server, busy, run)
                EmailField(email, { email = it }, !busy)
                PasswordField(password, { password = it }, "Password (at least 12 characters)", !busy)
                PasswordField(confirm, { confirm = it }, "Repeat password", !busy)
                if (password.isNotEmpty()) Problem(newPasswordProblem(password, confirm))
                CheckRow(newsletter, { newsletter = it }, NEWSLETTER_LABEL, !busy)
                serverField()
                if (flow.waitingForPerson) Text("Confirm in your browser that you are a person. JotDrop continues here.")
                Button(onClick = { run {
                    if (io { CloudAccount.needsPersonCheck(server) }) {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${server.trimEnd('/')}/human?client=android")))
                        flow.waitingForPerson = true
                    } else { flow.signup = io { CloudAccount.signUp(server, email, password, cloudDeviceName(), newsletter) }; password = ""; confirm = "" }
                } }, enabled = !busy && email.contains('@') && newPasswordProblem(password, confirm) == null) { Text("Create account") }
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
                ProviderButtons(providers, server, busy, run)
                EmailField(email, { email = it }, !busy)
                PasswordField(password, { password = it }, "Password", !busy)
                serverField()
                Button(onClick = { run { flow.login = io { CloudAccount.logIn(server, email, password, cloudDeviceName()) }; password = "" } },
                    enabled = !busy && email.contains('@') && password.isNotEmpty()) { Text("Continue") }
                TextButton(onClick = { mode = "forgot" }, enabled = !busy) { Text("Forgot password?") }
                TextButton(onClick = { mode = "signup" }, enabled = !busy) { Text("Create an account") }
                TextButton(onClick = { mode = "pair" }, enabled = !busy) { Text("Use a one-time pairing code") }
                PrivacyLink({ CloudClient.secureOrigin(server) }, !busy)
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
    } else if (pending.keepsPassword) {
        Text("Approved. Open your notes", style = MaterialTheme.typography.titleLarge)
        Text("Finish within 10 minutes of asking for approval; after that, start again.", style = MaterialTheme.typography.bodySmall)
        Button(onClick = { run { committed { withDeviceChoice { replace ->
            val client = try { io { CloudAccount.completeApproval(pending, null, cloudDeviceName(), replace) } }
                catch (failure: CloudRequestException) { if (failure.status == 401) onDone(); throw failure }
            CloudSyncManager.connectAccount(context, client)
            onDone()
        } } } }, enabled = !busy) { Text("Open my notes") }
        TextButton(onClick = onDone, enabled = !busy) { Text("Start again") }
    } else {
        Text("Approved. Choose a new password", style = MaterialTheme.typography.titleLarge)
        PasswordField(password, { password = it }, "New password (at least 12 characters)", !busy)
        PasswordField(confirm, { confirm = it }, "Repeat new password", !busy)
        if (password.isNotEmpty()) Problem(newPasswordProblem(password, confirm))
        Text("Finish within 10 minutes of asking for approval; after that, start again.", style = MaterialTheme.typography.bodySmall)
        Button(onClick = { run { committed { withDeviceChoice { replace ->
            val client = try { io { CloudAccount.completeApproval(pending, password, cloudDeviceName(), replace) } }
                catch (failure: CloudRequestException) { if (failure.status == 401) onDone(); throw failure }
            CloudSyncManager.connectAccount(context, client)
            onDone()
        } } } }, enabled = !busy && newPasswordProblem(password, confirm) == null) { Text("Set new password") }
        TextButton(onClick = onDone, enabled = !busy) { Text("Start again") }
    }
}

/** Account settings on a connected device: add email sign-in, change the password, approve new devices. */
@Composable
internal fun CloudAccountSection(busy: Boolean, run: (suspend () -> Unit) -> Unit, cloud: suspend () -> CloudClient) {
    val flow = CloudAccountFlow
    var email by remember { mutableStateOf<String?>(null) }
    var hasPassword by remember { mutableStateOf(true) }
    var loaded by remember { mutableStateOf(false) }
    var loadFailed by remember { mutableStateOf(false) }
    var reload by remember { mutableStateOf(0) }
    var notice by remember { mutableStateOf<String?>(null) }
    var newEmail by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var current by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var newsletter by rememberSaveable { mutableStateOf(false) }
    var code by remember { mutableStateOf("") }
    var changing by rememberSaveable { mutableStateOf(false) }
    var signOutOthers by rememberSaveable { mutableStateOf(false) }
    var renewing by rememberSaveable { mutableStateOf(false) }
    var recoveryPassword by remember { mutableStateOf("") }
    var deleting by rememberSaveable { mutableStateOf(false) }
    var deletePassword by remember { mutableStateOf("") }
    var deleteTyped by remember { mutableStateOf("") }
    var totp by remember { mutableStateOf(false) }
    var vaultId by remember { mutableStateOf<String?>(null) }
    var totpCode by remember { mutableStateOf("") }
    var totpPassword by remember { mutableStateOf("") }
    var totpProblem by remember { mutableStateOf<String?>(null) }
    var turningOff by rememberSaveable { mutableStateOf(false) }
    val context = LocalContext.current
    var approvals by remember { mutableStateOf<List<CloudApproval>?>(null) }
    var approve by remember { mutableStateOf<CloudApproval?>(null) }
    LaunchedEffect(reload, flow.accountChanged) {
        loadFailed = false
        try {
            val client = cloud(); val info = io { CloudAccount.accountInfo(client) }
            email = info?.email; hasPassword = info?.password ?: true; totp = info?.totp ?: false; vaultId = client.credentials.vaultId; loaded = true
        }
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
                CheckRow(newsletter, { newsletter = it }, NEWSLETTER_LABEL, !busy)
                Button(onClick = { run { val client = cloud(); flow.attach = io { CloudAccount.attachAccount(client, newEmail, password, newsletter) }; password = ""; confirm = "" } },
                    enabled = !busy && newEmail.contains('@') && newPasswordProblem(password, confirm) == null) { Text("Add email sign-in") }
            }
            else -> {
                Text(if (hasPassword) "Email sign-in: $email" else "Account: $email", style = MaterialTheme.typography.bodyMedium)
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
                // An account made with Google or GitHub gets a password through "Forgot password?", like on the website.
                if (!hasPassword) Text("You sign in with Google or GitHub, so this account has no password. A password is needed to make a new recovery code. " +
                    "To add one: disconnect this device, choose \"Forgot password?\" and follow the steps.", style = MaterialTheme.typography.bodySmall)
                else if (!changing) TextButton(onClick = { changing = true }, enabled = !busy) { Text("Change password") }
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
                // Recommended, never required: without an app a new device gets a code by email. Needs the password, like on the website.
                if (hasPassword) {
                    val setup = flow.totpSetup?.takeIf { it.vaultId == vaultId && flow.secureOffer == null }
                    fun totpDone(message: String, on: Boolean) { flow.totpSetup = null; totpCode = ""; totpPassword = ""; totpProblem = null; turningOff = false; totp = on; notice = message }
                    // A wrong code or password (401) shows next to the fields; anything else at the top, like other account forms.
                    suspend fun checked(action: () -> Unit): Boolean {
                        totpProblem = null
                        try { io(action); return true }
                        catch (failure: CloudRequestException) { if (failure.status != 401) throw failure; totpProblem = accountProblem(failure); return false }
                    }
                    Text("Authenticator app", style = MaterialTheme.typography.titleMedium)
                    Text(if (totp) "On: a new device asks for a code from your app." else "Off: a new device asks for a code by email.")
                    when {
                        setup != null -> {
                            TotpSetupSteps(setup, totpCode, { totpCode = it }, !busy)
                            PasswordField(totpPassword, { totpPassword = it }, "Password", !busy)
                            Problem(totpProblem)
                            Row {
                                Button(onClick = { run {
                                    val client = cloud()
                                    if (checked { CloudAccount.enableTotp(client, totpPassword, totpCode) })
                                        totpDone("Authenticator app turned on. A new device now asks for a code from the app.", true)
                                } }, enabled = !busy && totpCode.length == 6 && totpPassword.isNotEmpty()) { Text("Turn on") }
                                TextButton(onClick = { flow.totpSetup = null; totpCode = ""; totpPassword = ""; totpProblem = null }, enabled = !busy) { Text("Cancel") }
                            }
                        }
                        totp && turningOff -> {
                            Text("New devices then get a code by email again.", style = MaterialTheme.typography.bodySmall)
                            PasswordField(totpPassword, { totpPassword = it }, "Password", !busy)
                            Problem(totpProblem)
                            Row {
                                Button(onClick = { run {
                                    val client = cloud()
                                    if (checked { CloudAccount.disableTotp(client, totpPassword) })
                                        totpDone("Authenticator app turned off. New devices get a code by email.", false)
                                } }, enabled = !busy && totpPassword.isNotEmpty()) { Text("Turn off") }
                                TextButton(onClick = { turningOff = false; totpPassword = ""; totpProblem = null }, enabled = !busy) { Text("Cancel") }
                            }
                        }
                        totp -> TextButton(onClick = { turningOff = true }, enabled = !busy) { Text("Turn off") }
                        else -> TextButton(onClick = { run {
                            val client = cloud()
                            flow.totpSetup = io { CloudAccount.setupTotp(client) }
                            totpCode = ""; totpPassword = ""; totpProblem = null
                        } }, enabled = !busy) { Text("Set up an authenticator app") }
                    }
                }
            }
        }
        if (loaded && !loadFailed && attach == null && hasPassword) {
            if (!renewing) TextButton(onClick = { renewing = true }, enabled = !busy) { Text("Make a new recovery code") }
            else {
                Text("Recovery code", style = MaterialTheme.typography.titleMedium)
                Text("A new code replaces your old recovery code. The old code stops working.", style = MaterialTheme.typography.bodySmall)
                if (email != null) PasswordField(recoveryPassword, { recoveryPassword = it }, "Password", !busy)
                Row {
                    Button(onClick = { run { committed {
                        val client = cloud()
                        keepRecoveryCode(context, io { CloudAccount.newRecoveryCode(client, email?.let { recoveryPassword }) })
                        recoveryPassword = ""; renewing = false
                    } } }, enabled = !busy && (email == null || recoveryPassword.isNotEmpty())) { Text("Make new code") }
                    TextButton(onClick = { renewing = false; recoveryPassword = "" }, enabled = !busy) { Text("Cancel") }
                }
            }
        }
        if (loaded && !loadFailed && attach == null) {
            val needsPassword = email != null && hasPassword
            if (!deleting) TextButton(onClick = { deleting = true }, enabled = !busy) { Text("Delete account", color = MaterialTheme.colorScheme.error) }
            else {
                Text("Delete account", style = MaterialTheme.typography.titleMedium)
                Text("This deletes your JotDrop Cloud: every note and version stored there, your account and the devices signed in to it. " +
                    "A running JotDrop Plus subscription is cancelled. The notes on this phone stay. This cannot be undone.", color = MaterialTheme.colorScheme.error)
                if (needsPassword) PasswordField(deletePassword, { deletePassword = it }, "Password", !busy)
                OutlinedTextField(deleteTyped, { if (it.length <= 20) deleteTyped = it }, label = { Text("Type DELETE to confirm") }, singleLine = true, enabled = !busy,
                    keyboardOptions = KeyboardOptions(autoCorrect = false), modifier = Modifier.fillMaxWidth())
                Row {
                    Button(onClick = { run { committed {
                        val client = cloud()
                        io { CloudAccount.deleteAccount(client, if (needsPassword) deletePassword else null) }
                        deletePassword = ""; deleteTyped = ""; deleting = false
                        CloudSyncManager.disconnect(context, "Your account and cloud were deleted. The notes on this phone were kept.")
                    } } }, enabled = !busy && deleteTyped.trim() == "DELETE" && (!needsPassword || deletePassword.isNotEmpty()),
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text("Delete my account and cloud") }
                    TextButton(onClick = { deleting = false; deletePassword = ""; deleteTyped = "" }, enabled = !busy) { Text("Cancel") }
                }
            }
        }
        PrivacyLink({ cloud().credentials.url }, !busy)
    }
    approve?.let { request -> AlertDialog(onDismissRequest = { approve = null }, title = { Text("Approve this device?") },
        text = { Text("Only approve if the new device shows exactly these words:\n\n${request.words.joinToString("   ")}\n\nThe device gets full access to your notes.") },
        confirmButton = { TextButton(onClick = { approve = null; run {
            val client = cloud()
            io { CloudAccount.approveDevice(client, request) }
            approvals = approvals?.minus(request)
            notice = "Approved. The new device can now open your notes."
        } }, enabled = !busy) { Text("Words match, approve") } },
        dismissButton = { TextButton(onClick = { approve = null }) { Text("Cancel") } }) }
}

/** Shown once after creating a cloud or making a new code; without this code a forgotten password can only start the cloud over. */
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
            Text("If you lose access to all your signed-in devices, this code may be the only way back to your notes. Store it somewhere safe, for example in a password manager. JotDrop cannot show it again.")
            SelectionContainer { Text(code, style = MaterialTheme.typography.bodySmall) }
            CheckRow(saved, { saved = it }, "I saved my recovery code")
        } },
        confirmButton = { TextButton(onClick = {
            CloudAccountFlow.recoveryCode = null
            runCatching { CloudPreviewStore(context).clearRecoveryCode() }
        }, enabled = saved) { Text("Done") } })
}

/** After signing up with a password, once the recovery code is saved. Recommended, not required; the login key of the new password stands in for asking it again. */
@Composable
internal fun CloudSecureOfferDialog(cloud: suspend () -> CloudClient) {
    val flow = CloudAccountFlow
    val scope = rememberCoroutineScope()
    var working by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var code by remember { mutableStateOf("") }
    var turnedOn by remember { mutableStateOf(false) }
    val offer = flow.secureOffer
    if (flow.recoveryCode != null || (offer == null && !turnedOn)) return
    val setup = flow.totpSetup
    fun close() { flow.secureOffer = null; flow.totpSetup = null; code = ""; problem = null; turnedOn = false }
    fun attempt(action: suspend () -> Unit) {
        if (working) return
        working = true
        problem = null
        scope.launch {
            try { action() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { problem = accountProblem(failure) }
            finally { working = false }
        }
    }
    if (offer == null) {
        AlertDialog(onDismissRequest = ::close, title = { Text("Authenticator app turned on") },
            text = { Text("Authenticator app turned on. A new device now asks for a code from the app.") },
            confirmButton = { TextButton(onClick = ::close) { Text("Done") } })
        return
    }
    // Once the key is shown it may already be in the app, so only the buttons close the dialog.
    AlertDialog(onDismissRequest = { if (setup == null && !working) close() },
        title = { Text("Secure your account with an authenticator app (recommended)") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.verticalScroll(rememberScrollState())) {
            if (setup == null) {
                Text("An authenticator app, like Google Authenticator, Microsoft Authenticator or 2FAS, shows a new 6-digit code every 30 seconds. " +
                    "With one set up, a new device asks for that code instead of a code by email, so your account stays safe even if someone gets into your email.")
                Text("You can also do this later in settings.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else TotpSetupSteps(setup, code, { code = it }, !working)
            Problem(problem)
        } },
        confirmButton = {
            if (setup == null) TextButton(onClick = { attempt { val client = cloud(); flow.totpSetup = io { CloudAccount.setupTotp(client) } } }, enabled = !working) { Text("Set up now") }
            else TextButton(onClick = { attempt {
                val client = cloud()
                io { CloudAccount.enableTotp(client, offer, code) }
                flow.secureOffer = null; flow.totpSetup = null; code = ""; turnedOn = true
                flow.accountChanged++
            } }, enabled = !working && code.length == 6) { Text("Turn on") }
        },
        dismissButton = { TextButton(onClick = ::close, enabled = !working) { Text("Later") } })
}

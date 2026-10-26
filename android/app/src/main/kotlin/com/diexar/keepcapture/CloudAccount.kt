package com.diexar.keepcapture

import org.json.JSONObject
import java.security.PrivateKey

/** A registration waiting for the emailed code. A new cloud carries its keys; an existing cloud only its id. */
class CloudSignup internal constructor(val url: String, val signupId: String, val vaultId: String?,
    internal val vaultKey: String?, internal val recoveryToken: String?, internal val deviceToken: String?, internal val authKey: String? = null)
class CloudLoginChallenge internal constructor(val url: String, val challengeId: String, val secondFactor: String,
    internal val unlockKey: String, internal val deviceToken: String)
class CloudReset internal constructor(val url: String, val resetId: String)
/** `keepsPassword`: asked after Google or GitHub, so the account keeps its password (or stays without one) instead of getting a new one. */
class CloudApprovalRequest internal constructor(val url: String, val approvalId: String, val expiresAt: String, val words: List<String>,
    internal val claimToken: String, internal val privateKey: PrivateKey, val keepsPassword: Boolean = false) {
    @Volatile internal var vaultId: String? = null
    @Volatile internal var vaultKey: String? = null
    val approved: Boolean get() = vaultKey != null
}
class CloudApproval(val id: String, val publicKey: String, val expiresAt: String, val words: List<String>)
/** `secureOffer` is set after signing up with a password: it turns on an authenticator app without asking the password again. */
class CloudSignedUp(val client: CloudClient, val recoveryCode: String, val secureOffer: CloudSecureOffer? = null)
/** The login key derived from the password just chosen, not the password itself. Memory only, dropped when the offer closes. */
class CloudSecureOffer internal constructor(internal val authKey: String)
class CloudAccountInfo(val email: String, val password: Boolean, val totp: Boolean = false)
/** A new authenticator secret for one cloud, waiting until enableTotp confirms a code from the app. `uri` is the otpauth:// link that adds it to an app. */
class CloudTotpSetup(val vaultId: String, val secret: String, val uri: String)
/** Open `href` in the browser and keep `verifier` on this device until the ticket comes back. */
class CloudProviderStart(val url: String, val verifier: String, val href: String)
/** Who signed in with Google or GitHub, and whether that address already has an account. The ticket only works with this device's verifier. */
class CloudProviderSignIn internal constructor(val url: String, val provider: String, val email: String, val account: Boolean,
    internal val ticket: String, internal val verifier: String)

/** Email and password accounts, matching cloud/shared/account.mjs. The password and the unlock key never leave this device. */
object CloudAccount {
    private val uuid = Regex("(?i)[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
    private fun id(value: String): String = value.also { require(it.matches(uuid)) { "The server sent an invalid identifier." } }
    private fun post(url: String, path: String, body: JSONObject): JSONObject = CloudClient.request(url, path, "POST", body, null)
    // secureOrigin's own message is about pairing; typed server addresses get a plain one.
    private fun origin(url: String): String = runCatching { CloudClient.secureOrigin(url.trim()) }
        .getOrElse { throw IllegalArgumentException("Enter the server address as https://name, without a path.") }
    private fun JSONObject.with(other: JSONObject): JSONObject = apply { other.keys().forEach { put(it, other.get(it)) } }

    private fun credentials(password: String, vaultKey: String): JSONObject {
        val kdf = CloudAccountCrypto.newKdf()
        val keys = CloudAccountCrypto.deriveKeys(CloudAccountCrypto.password(password), kdf)
        val wrapped = CloudCrypto.encrypt(keys.unlockKey, JSONObject().put("vaultKey", vaultKey).toString().toByteArray(Charsets.UTF_8), CloudAccountCrypto.WRAP_AAD)
        return JSONObject().put("kdf", JSONObject().put("salt", kdf.salt).put("memory", kdf.memory).put("passes", kdf.passes).put("parallelism", kdf.parallelism))
            .put("authKey", keys.authKey).put("wrappedVaultKey", CloudClient.envelopeJson(wrapped).toString())
    }

    private fun device(deviceName: String): Pair<String, JSONObject> {
        val token = CloudCrypto.token()
        return token to JSONObject().put("deviceName", deviceName).put("deviceTokenHash", CloudCrypto.hashToken(token))
    }

    private fun connect(url: String, result: JSONObject, deviceToken: String, vaultKey: String): CloudClient =
        CloudClient(CloudCredentials(CloudClient.secureOrigin(url), result.getString("vaultId"), result.getString("deviceId"), deviceToken, vaultKey))

    private fun kdf(json: JSONObject): CloudKdf = CloudKdf.checked(json.getString("salt"), json.getLong("memory"), json.getLong("passes"), json.getLong("parallelism"))

    fun encodeRecovery(vaultId: String, vaultKey: String, recoveryToken: String): String {
        id(vaultId); CloudCrypto.hashToken(vaultKey); CloudCrypto.hashToken(recoveryToken)
        return CloudCrypto.encode(JSONObject().put("v", 1).put("vaultId", vaultId).put("vaultKey", vaultKey).put("recoveryToken", recoveryToken).toString().toByteArray(Charsets.UTF_8))
    }

    private fun decodeRecovery(code: String): JSONObject {
        val value = runCatching {
            require(code.length <= 2048)
            JSONObject(String(CloudCrypto.decode(code.trim()), Charsets.UTF_8)).also {
                require(it.getInt("v") == 1)
                encodeRecovery(it.getString("vaultId"), it.getString("vaultKey"), it.getString("recoveryToken"))
            }
        }.getOrNull()
        return requireNotNull(value) { "This recovery code is not valid." }
    }

    /** Starts a new account and cloud; the server mails a code to confirm the address. */
    fun signUp(url: String, email: String, password: String, deviceName: String, newsletter: Boolean = false): CloudSignup {
        val vaultKey = CloudCrypto.token()
        val recoveryToken = CloudCrypto.token()
        val (deviceToken, fields) = device(deviceName)
        val keys = credentials(password, vaultKey)
        val body = JSONObject().put("email", email.trim()).with(keys).put("recoveryTokenHash", CloudCrypto.hashToken(recoveryToken)).with(fields).put("newsletter", newsletter)
        val result = post(origin(url), "/accounts", body)
        return CloudSignup(origin(url), id(result.getString("signupId")), null, vaultKey, recoveryToken, deviceToken, keys.getString("authKey"))
    }

    /** Gives the cloud this device is already connected to an account. Confirm with confirmSignup. */
    fun attachAccount(client: CloudClient, email: String, password: String, newsletter: Boolean = false): CloudSignup {
        val result = client.call("/account", "POST", JSONObject().put("email", email.trim()).with(credentials(password, client.credentials.vaultKey)).put("newsletter", newsletter))
        return CloudSignup(client.credentials.url, id(result.getString("signupId")), client.credentials.vaultId, null, null, null)
    }

    /** Returns the new connection and its recovery code, or null when an existing cloud got its account. */
    fun confirmSignup(pending: CloudSignup, code: String): CloudSignedUp? {
        val result = post(pending.url, "/accounts/verify", JSONObject().put("signupId", pending.signupId).put("code", code.trim()))
        if (pending.deviceToken == null) {
            check(result.getString("vaultId") == pending.vaultId) { "The server linked the account to another cloud." }
            return null
        }
        val client = connect(pending.url, result, pending.deviceToken, requireNotNull(pending.vaultKey))
        return CloudSignedUp(client, encodeRecovery(client.credentials.vaultId, client.credentials.vaultKey, requireNotNull(pending.recoveryToken)),
            pending.authKey?.let(::CloudSecureOffer))
    }

    /** First step of logging in; then confirmLogin with the code from the email or the authenticator app. */
    fun logIn(url: String, email: String, password: String, deviceName: String): CloudLoginChallenge {
        val origin = origin(url)
        val keys = CloudAccountCrypto.deriveKeys(password, kdf(post(origin, "/auth/prelogin", JSONObject().put("email", email.trim())).getJSONObject("kdf")))
        val (deviceToken, fields) = device(deviceName)
        val started = post(origin, "/auth/login", JSONObject().put("email", email.trim()).put("authKey", keys.authKey).with(fields))
        val factor = started.getString("secondFactor")
        require(factor == "email" || factor == "totp") { "The server asked for an unknown sign-in step." }
        return CloudLoginChallenge(origin, id(started.getString("challengeId")), factor, keys.unlockKey, deviceToken)
    }

    /** At the free device limit the server answers "device-limit"; call again with the same code and `replaceDeviceId`. */
    fun confirmLogin(pending: CloudLoginChallenge, code: String, replaceDeviceId: String? = null): CloudClient {
        val result = post(pending.url, "/auth/login/verify", JSONObject().put("challengeId", pending.challengeId).put("code", code.trim()).put("replaceDeviceId", replaceDeviceId))
        val wrapped = CloudClient.parseEnvelope(result.getString("wrappedVaultKey"))
        val vaultKey = JSONObject(String(CloudCrypto.decrypt(pending.unlockKey, wrapped, CloudAccountCrypto.WRAP_AAD), Charsets.UTF_8)).getString("vaultKey")
        return connect(pending.url, result, pending.deviceToken, vaultKey)
    }

    /** The account of the connected cloud, or null when it has no account yet. Accounts made with Google or GitHub may have no password. */
    fun accountInfo(client: CloudClient): CloudAccountInfo? = try { client.call("/account").let { CloudAccountInfo(it.getString("email"), it.optBoolean("password", true), it.optBoolean("totp")) } }
        catch (error: CloudRequestException) { if (error.status == 404) null else throw error }

    fun accountEmail(client: CloudClient): String? = accountInfo(client)?.email

    private fun currentAuthKey(client: CloudClient, password: String): String {
        val email = requireNotNull(accountEmail(client)) { "This cloud has no account yet." }
        return CloudAccountCrypto.deriveKeys(password, kdf(post(client.credentials.url, "/auth/prelogin", JSONObject().put("email", email)).getJSONObject("kdf"))).authKey
    }

    /** The vault key stays the same, so nothing has to be encrypted again. */
    fun changePassword(client: CloudClient, currentPassword: String, newPassword: String, signOutOtherDevices: Boolean) {
        client.call("/account/password", "POST", JSONObject().put("currentAuthKey", currentAuthKey(client, currentPassword))
            .with(credentials(newPassword, client.credentials.vaultKey)).put("signOutOtherDevices", signOutOtherDevices))
    }

    /** Replaces the recovery code; the old one stops working. The password is only needed when the cloud has an account. */
    fun newRecoveryCode(client: CloudClient, password: String?): String {
        val recoveryToken = CloudCrypto.token()
        val body = JSONObject().put("recoveryTokenHash", CloudCrypto.hashToken(recoveryToken))
        if (password != null) body.put("currentAuthKey", currentAuthKey(client, password))
        client.call("/recovery", "POST", body)
        return encodeRecovery(client.credentials.vaultId, client.credentials.vaultKey, recoveryToken)
    }

    /** Deletes the cloud and its account; notes on this phone stay. The password is only needed when the account has one. */
    fun deleteAccount(client: CloudClient, password: String?) {
        val body = JSONObject().put("confirm", "DELETE MY CLOUD")
        if (password != null) body.put("currentAuthKey", currentAuthKey(client, password))
        client.call("/account/delete", "POST", body)
    }

    /** Starts over each time: a new secret replaces one that was never confirmed. Turning it on needs a code from the app and the password. */
    fun setupTotp(client: CloudClient): CloudTotpSetup {
        val result = client.call("/account/totp", "POST", JSONObject())
        val secret = result.getString("secret")
        val uri = result.getString("uri")
        require(secret.matches(Regex("[A-Z2-7]{16,128}")) && uri.startsWith("otpauth://totp/")) { "The server sent an invalid authenticator setup." }
        return CloudTotpSetup(client.credentials.vaultId, secret, uri)
    }

    /** From then on a new device asks for a code from the app instead of a code by email. */
    fun enableTotp(client: CloudClient, password: String, code: String) = turnOnTotp(client, code, currentAuthKey(client, password))

    /** Right after signing up: the key from the new password, so it is not asked twice. */
    fun enableTotp(client: CloudClient, offer: CloudSecureOffer, code: String) = turnOnTotp(client, code, offer.authKey)

    private fun turnOnTotp(client: CloudClient, code: String, authKey: String) {
        client.call("/account/totp/enable", "POST", JSONObject().put("code", code.trim()).put("currentAuthKey", authKey))
    }

    /** New devices get a code by email again. */
    fun disableTotp(client: CloudClient, password: String) {
        client.call("/account/totp/disable", "POST", JSONObject().put("currentAuthKey", currentAuthKey(client, password)))
    }

    /** Forgot password: the server mails a code that one of the three routes below needs. */
    fun startReset(url: String, email: String): CloudReset {
        val origin = origin(url)
        return CloudReset(origin, id(post(origin, "/auth/reset/start", JSONObject().put("email", email.trim())).getString("resetId")))
    }

    fun resetWithRecoveryCode(reset: CloudReset, code: String, recoveryCode: String, newPassword: String, deviceName: String, replaceDeviceId: String? = null): CloudClient {
        val recovery = decodeRecovery(recoveryCode)
        val (deviceToken, fields) = device(deviceName)
        val result = post(reset.url, "/auth/reset/recover", JSONObject().put("resetId", reset.resetId).put("code", code.trim())
            .put("recoveryToken", recovery.getString("recoveryToken")).with(credentials(newPassword, recovery.getString("vaultKey"))).with(fields)
            .put("replaceDeviceId", replaceDeviceId))
        check(result.getString("vaultId") == recovery.getString("vaultId")) { "The recovery code belongs to another cloud." }
        return connect(reset.url, result, deviceToken, recovery.getString("vaultKey"))
    }

    private fun askApproval(url: String, path: String, fields: JSONObject, keepsPassword: Boolean): CloudApprovalRequest {
        val keys = CloudAccountCrypto.newApprovalKeys()
        val publicKey = CloudAccountCrypto.exportPublic(keys)
        val claimToken = CloudCrypto.token()
        val result = post(url, path, fields.put("publicKey", publicKey).put("claimTokenHash", CloudCrypto.hashToken(claimToken)))
        return CloudApprovalRequest(url, id(result.getString("approvalId")), result.getString("expiresAt"),
            CloudAccountCrypto.verificationWords(publicKey), claimToken, keys.private, keepsPassword)
    }

    /** New device: asks a connected device for the vault key. Show `words` and keep polling checkApproval. */
    fun requestApproval(reset: CloudReset, code: String): CloudApprovalRequest =
        askApproval(reset.url, "/auth/reset/approval", JSONObject().put("resetId", reset.resetId).put("code", code.trim()), false)

    /** False while waiting; true once the other device approved and the vault key is unpacked. */
    fun checkApproval(pending: CloudApprovalRequest): Boolean {
        if (pending.approved) return true
        val result = post(pending.url, "/auth/reset/approval/${pending.approvalId}", JSONObject().put("claimToken", pending.claimToken))
        if (result.isNull("envelope")) return false
        val sealed = JSONObject(result.getString("envelope"))
        val key = CloudAccountCrypto.approvalKey(pending.privateKey, sealed.getString("publicKey"), pending.approvalId)
        val payload = JSONObject(String(CloudCrypto.decrypt(key, CloudClient.parseEnvelope(sealed.toString()), CloudAccountCrypto.approvalAad(pending.approvalId)), Charsets.UTF_8))
        pending.vaultId = id(payload.getString("vaultId"))
        pending.vaultKey = payload.getString("vaultKey").also { CloudCrypto.hashToken(it) }
        return true
    }

    /** Without `newPassword` (sign-in with Google or GitHub) the account keeps its password, or stays without one. */
    fun completeApproval(pending: CloudApprovalRequest, newPassword: String?, deviceName: String, replaceDeviceId: String? = null): CloudClient {
        val vaultKey = checkNotNull(pending.vaultKey) { "Wait until your other device approves this request." }
        val (deviceToken, fields) = device(deviceName)
        val body = JSONObject().put("claimToken", pending.claimToken)
        if (newPassword != null) body.with(credentials(newPassword, vaultKey))
        val result = post(pending.url, "/auth/reset/approval/${pending.approvalId}/complete", body.with(fields).put("replaceDeviceId", replaceDeviceId))
        check(result.getString("vaultId") == pending.vaultId) { "The server linked the account to another cloud." }
        return connect(pending.url, result, deviceToken, vaultKey)
    }

    /** Connected device: requests waiting for approval, each with the words to compare. */
    fun listApprovals(client: CloudClient): List<CloudApproval> {
        val array = client.call("/account/approvals").getJSONArray("approvals")
        return List(array.length()) { index ->
            val entry = array.getJSONObject(index)
            CloudApproval(id(entry.getString("id")), entry.getString("publicKey"), entry.getString("expiresAt"), CloudAccountCrypto.verificationWords(entry.getString("publicKey")))
        }
    }

    /** Seals the vault key to the new device's public key; only that device can open it. */
    fun approveDevice(client: CloudClient, approval: CloudApproval) {
        val keys = CloudAccountCrypto.newApprovalKeys()
        val key = CloudAccountCrypto.approvalKey(keys.private, approval.publicKey, approval.id)
        val payload = JSONObject().put("vaultId", client.credentials.vaultId).put("vaultKey", client.credentials.vaultKey)
        val sealed = CloudClient.envelopeJson(CloudCrypto.encrypt(key, payload.toString().toByteArray(Charsets.UTF_8), CloudAccountCrypto.approvalAad(approval.id)))
            .put("publicKey", CloudAccountCrypto.exportPublic(keys))
        client.call("/account/approvals/${id(approval.id)}", "POST", JSONObject().put("envelope", sealed.toString()))
    }

    fun rejectDevice(client: CloudClient, approvalId: String) {
        client.call("/account/approvals/${id(approvalId)}", "DELETE", JSONObject())
    }

    /** The sign-in buttons the server offers; empty when it has no Google or GitHub app. */
    fun providers(url: String): List<String> {
        val array = CloudClient.request(origin(url), "/auth/providers", "GET", null, null).getJSONArray("providers")
        return List(array.length()) { array.getString(it) }
    }

    /** Sign in with Google or GitHub, step 1. The browser comes back to jotdrop-cloud://oauth with a ticket that only works with the verifier. */
    fun startProviderSignIn(url: String, provider: String): CloudProviderStart {
        require(provider == "google" || provider == "github") { "Unknown sign-in provider." }
        val origin = origin(url)
        val verifier = CloudCrypto.token()
        return CloudProviderStart(origin, verifier, "$origin/api/v1/auth/oauth/$provider/start?client=android&challenge=${CloudCrypto.hashToken(verifier)}")
    }

    /** Step 2: who signed in, and whether that address already has an account. */
    fun providerTicket(url: String, ticket: String, verifier: String): CloudProviderSignIn {
        val origin = origin(url)
        val result = post(origin, "/auth/oauth/ticket", JSONObject().put("ticket", ticket).put("verifier", verifier))
        return CloudProviderSignIn(origin, result.getString("provider"), result.getString("email"), result.getBoolean("account"), ticket, verifier)
    }

    private fun ticket(signIn: CloudProviderSignIn): JSONObject = JSONObject().put("ticket", signIn.ticket).put("verifier", signIn.verifier)

    /** No account yet: a new cloud for this address, without a password. Show the recovery code. */
    fun providerSignUp(signIn: CloudProviderSignIn, deviceName: String, newsletter: Boolean = false): CloudSignedUp {
        val vaultKey = CloudCrypto.token()
        val recoveryToken = CloudCrypto.token()
        val (deviceToken, fields) = device(deviceName)
        val result = post(signIn.url, "/auth/oauth/signup", ticket(signIn).put("recoveryTokenHash", CloudCrypto.hashToken(recoveryToken)).with(fields).put("newsletter", newsletter))
        val client = connect(signIn.url, result, deviceToken, vaultKey)
        return CloudSignedUp(client, encodeRecovery(client.credentials.vaultId, vaultKey, recoveryToken))
    }

    /** An account already exists: ask a signed-in device for the key, then checkApproval and completeApproval without a password. */
    fun providerApproval(signIn: CloudProviderSignIn): CloudApprovalRequest = askApproval(signIn.url, "/auth/oauth/approval", ticket(signIn), true)

    /** An account already exists: the recovery code brings the key. */
    fun providerRecover(signIn: CloudProviderSignIn, recoveryCode: String, deviceName: String, replaceDeviceId: String? = null): CloudClient {
        val recovery = decodeRecovery(recoveryCode)
        val (deviceToken, fields) = device(deviceName)
        val result = post(signIn.url, "/auth/oauth/recover", ticket(signIn).put("recoveryToken", recovery.getString("recoveryToken")).with(fields).put("replaceDeviceId", replaceDeviceId))
        check(result.getString("vaultId") == recovery.getString("vaultId")) { "The recovery code belongs to another cloud." }
        return connect(signIn.url, result, deviceToken, recovery.getString("vaultKey"))
    }

    /** Last resort: deletes the unreadable cloud and starts an empty one; notes on devices are not touched. */
    fun startOver(reset: CloudReset, code: String, newPassword: String, deviceName: String): CloudSignedUp {
        val vaultKey = CloudCrypto.token()
        val recoveryToken = CloudCrypto.token()
        val (deviceToken, fields) = device(deviceName)
        val result = post(reset.url, "/auth/reset/restart", JSONObject().put("resetId", reset.resetId).put("code", code.trim()).put("confirm", "DELETE CLOUD DATA")
            .put("recoveryTokenHash", CloudCrypto.hashToken(recoveryToken)).with(credentials(newPassword, vaultKey)).with(fields))
        val client = connect(reset.url, result, deviceToken, vaultKey)
        return CloudSignedUp(client, encodeRecovery(client.credentials.vaultId, vaultKey, recoveryToken))
    }
}

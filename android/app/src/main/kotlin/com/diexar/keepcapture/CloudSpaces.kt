package com.diexar.keepcapture

import org.json.JSONObject

data class CloudSpaceItem(val id: String, val sequence: Long, val frozen: Boolean, val replacedBy: String?)
data class CloudSpaceMember(val accountId: String, val name: String?, val owner: Boolean, val email: String?)
data class CloudSpaceInvite(val id: String, val expiresAt: String, val claimed: Boolean)
/** [key] is null while an invitation was not finished; a [name] is null when it does not open under the key. */
class CloudSpaceInfo(val id: String, val owner: Boolean, val name: String?, val key: String?, val members: List<CloudSpaceMember>, val frozen: Boolean,
    val replacedBy: String?, val unfinished: Boolean, val ownerGone: Boolean, val canTakeOver: Boolean, val usedBytes: Long,
    val invites: List<CloudSpaceInvite>, val prefs: JSONObject, val accountId: String)
data class CloudInvitation(val id: String, val claimToken: String, val wrappingKey: String)
class CloudJoined(val id: String, val key: String, val inviterName: String)

/**
 * A shared space from the app's side, the same as cloud/shared/spaces.mjs: a small vault of its own, reached through
 * the account's membership. Its files go through an ordinary [CloudClient] with the space's id and key.
 */
object CloudSpaces {
    private val uuid = Regex("(?i)[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
    private val secret = Regex("[\\w-]{43}")
    private fun keyAad(vaultId: String, spaceId: String) = "jotdrop:space-key:v1:$vaultId:$spaceId"
    private fun prefsAad(vaultId: String, spaceId: String) = "jotdrop:space-prefs:v1:$vaultId:$spaceId"
    private fun nameAad(spaceId: String) = "jotdrop:space-name:v1:$spaceId"
    private fun memberAad(spaceId: String, accountId: String) = "jotdrop:member-name:v1:$spaceId:$accountId"
    private fun inviteAad(id: String) = "jotdrop:invite:v1:$id"

    private fun seal(key: String, payload: JSONObject, aad: String): String =
        CloudClient.envelopeJson(CloudCrypto.encrypt(key, payload.toString().toByteArray(Charsets.UTF_8), aad)).toString()
    /** Null when it does not open: a member or the server can write anything here. */
    private fun open(key: String, envelope: String?, aad: String): JSONObject? = if (envelope.isNullOrEmpty()) null else
        runCatching { JSONObject(String(CloudCrypto.decrypt(key, CloudClient.parseEnvelope(envelope), aad), Charsets.UTF_8)) }.getOrNull()
    private fun shortName(value: String): String = value.trim().also { require(it.isNotEmpty() && it.length <= 80 && it.none { c -> c.code < 32 }) { "Enter a name of 1 to 80 characters." } }
    private fun route(id: String, rest: String = ""): String { require(uuid.matches(id)) { "Invalid shared space." }; return "/spaces/$id$rest" }
    private fun JSONObject.text(name: String): String? = if (isNull(name)) null else optString(name).takeIf { has(name) }

    /** The client for the files of a space. */
    fun files(client: CloudClient, spaceId: String, spaceKey: String) = CloudClient(client.credentials.copy(vaultId = spaceId, vaultKey = spaceKey))

    fun list(client: CloudClient): List<CloudSpaceItem> {
        val spaces = client.call("/spaces").getJSONArray("spaces")
        return List(spaces.length()) { index -> spaces.getJSONObject(index).let { CloudSpaceItem(it.getString("id"), it.getLong("sequence"), it.getBoolean("frozen"), it.text("replacedBy")) } }
    }

    fun details(client: CloudClient, spaceId: String): CloudSpaceInfo {
        val view = client.call(route(spaceId))
        val me = view.getJSONObject("me")
        val accountId = me.getString("accountId")
        val (vaultId, vaultKey) = client.credentials.let { it.vaultId to it.vaultKey }
        val key = open(vaultKey, me.text("wrapped"), keyAad(vaultId, spaceId))?.optString("spaceKey")?.takeIf { it.isNotEmpty() }
        val members = view.getJSONArray("members").let { list ->
            List(list.length()) { index ->
                val member = list.getJSONObject(index)
                val memberId = member.getString("accountId")
                CloudSpaceMember(memberId, key?.let { open(it, member.text("nameEnvelope"), memberAad(spaceId, memberId))?.optString("name")?.takeIf { name -> name.isNotBlank() }?.take(80) },
                    member.optString("role") == "owner", member.text("email"))
            }
        }
        val invites = view.optJSONArray("invites")?.let { list -> List(list.length()) { index -> list.getJSONObject(index).let { CloudSpaceInvite(it.getString("id"), it.getString("expiresAt"), it.getBoolean("claimed")) } } }.orEmpty()
        return CloudSpaceInfo(spaceId, view.getString("role") == "owner", key?.let { open(it, view.text("nameEnvelope"), nameAad(spaceId))?.optString("name")?.takeIf { name -> name.isNotBlank() }?.take(80) }, key, members,
            view.getBoolean("frozen"), view.text("replacedBy"), view.optBoolean("unfinished"), view.text("ownerGoneAt") != null, view.optBoolean("canTakeOver"), view.optLong("usedBytes"),
            invites, open(vaultKey, me.text("prefs"), prefsAad(vaultId, spaceId)) ?: JSONObject(), accountId)
    }

    /** Returns id and key. Another device of this account may already have begun the same replacement: then that one. */
    fun create(client: CloudClient, name: String, memberName: String?, replaces: String? = null): Pair<String, String> {
        val (vaultId, vaultKey) = client.credentials.let { it.vaultId to it.vaultKey }
        val id = java.util.UUID.randomUUID().toString()
        val key = CloudCrypto.token()
        val body = JSONObject().put("id", id).put("nameEnvelope", seal(key, JSONObject().put("name", shortName(name)), nameAad(id)))
            .put("wrapped", seal(vaultKey, JSONObject().put("spaceKey", key), keyAad(vaultId, id)))
        if (replaces != null) body.put("replaces", replaces)
        val made = client.call("/spaces", "POST", body).getString("id")
        val space = if (made == id) id to key else made to requireNotNull(details(client, made).key) { "This shared space cannot be opened." }
        if (memberName != null) setMemberName(client, space.first, space.second, memberName)
        return space
    }

    fun setMemberName(client: CloudClient, spaceId: String, spaceKey: String, name: String) {
        val accountId = client.call(route(spaceId)).getJSONObject("me").getString("accountId")
        client.call(route(spaceId, "/key"), "PUT", JSONObject().put("nameEnvelope", seal(spaceKey, JSONObject().put("name", shortName(name)), memberAad(spaceId, accountId))))
    }

    fun savePrefs(client: CloudClient, spaceId: String, prefs: JSONObject) {
        client.call(route(spaceId, "/key"), "PUT", JSONObject().put("prefs", seal(client.credentials.vaultKey, prefs, prefsAad(client.credentials.vaultId, spaceId))))
    }

    /** The link holds a claim code and a key for the sealed envelope; the server gets the hash and the envelope. */
    fun makeInvite(client: CloudClient, spaceId: String, spaceKey: String, inviterName: String, origin: String = client.credentials.url): String {
        val id = java.util.UUID.randomUUID().toString()
        val claimToken = CloudCrypto.token()
        val wrappingKey = CloudCrypto.token()
        val envelope = seal(wrappingKey, JSONObject().put("spaceId", spaceId).put("spaceKey", spaceKey).put("inviterName", shortName(inviterName)), inviteAad(id))
        client.call(route(spaceId, "/invites"), "POST", JSONObject().put("id", id).put("claimTokenHash", CloudCrypto.hashToken(claimToken)).put("envelope", envelope))
        return "$origin/join#v1.$id.$claimToken.$wrappingKey"
    }

    fun readInvite(link: String): CloudInvitation {
        val parts = link.trim().substringAfterLast('#').split('.')
        require(parts.size == 4 && parts[0] == "v1" && uuid.matches(parts[1]) && secret.matches(parts[2]) && secret.matches(parts[3])) { "This invitation link is not complete. Ask for a new one." }
        return CloudInvitation(parts[1], parts[2], parts[3])
    }

    /** Safe to repeat after a crash: the same account gets the envelope again until the key is saved. */
    fun accept(client: CloudClient, invitation: CloudInvitation, memberName: String): CloudJoined {
        val name = shortName(memberName)
        val claimed = client.call("/invites/${invitation.id}/claim", "POST", JSONObject().put("claimToken", invitation.claimToken))
        val spaceId = claimed.getString("spaceId")
        val sealed = JSONObject(String(CloudCrypto.decrypt(invitation.wrappingKey, CloudClient.parseEnvelope(claimed.getString("envelope")), inviteAad(invitation.id)), Charsets.UTF_8))
        require(sealed.getString("spaceId") == spaceId) { "This invitation does not match its shared space. Nothing was saved." }
        val key = sealed.getString("spaceKey")
        require(CloudCrypto.decode(key).size == 32) { "This invitation does not hold a valid key. Nothing was saved." }
        val (vaultId, vaultKey) = client.credentials.let { it.vaultId to it.vaultKey }
        val accountId = client.call(route(spaceId)).getJSONObject("me").getString("accountId")
        client.call(route(spaceId, "/key"), "PUT", JSONObject().put("wrapped", seal(vaultKey, JSONObject().put("spaceKey", key), keyAad(vaultId, spaceId)))
            .put("nameEnvelope", seal(key, JSONObject().put("name", name), memberAad(spaceId, accountId))))
        return CloudJoined(spaceId, key, sealed.optString("inviterName").take(80))
    }

    fun withdrawInvite(client: CloudClient, spaceId: String, inviteId: String) { client.call(route(spaceId, "/invites/$inviteId"), "DELETE") }
    /** The number of people left in the space. */
    fun removeMember(client: CloudClient, spaceId: String, accountId: String): Int = client.call(route(spaceId, "/members/$accountId"), "DELETE").getInt("members")
    fun leave(client: CloudClient, spaceId: String) { client.call(route(spaceId, "/leave"), "POST", JSONObject()) }
    /** reason: abuse, illegal, spam or other. Without [about] the report is about the group. */
    fun report(client: CloudClient, spaceId: String, reason: String, about: String?, details: String) { client.call(route(spaceId, "/report"), "POST", JSONObject().put("reason", reason).apply { about?.let { put("about", it) }; if (details.isNotBlank()) put("details", details) }) }
    fun block(client: CloudClient, spaceId: String, accountId: String) { client.call(route(spaceId, "/block"), "POST", JSONObject().put("accountId", accountId)) }
    fun takeOver(client: CloudClient, spaceId: String) { client.call(route(spaceId, "/takeover"), "POST", JSONObject()) }
    fun delete(client: CloudClient, spaceId: String) { client.call(route(spaceId), "DELETE") }

    private fun write(target: CloudClient, path: String, bytes: ByteArray, baseRevision: Int) { target.commitWrite(target.prepareWrite(path, bytes, baseRevision), bytes) {} }
    private fun fileAt(target: CloudClient, path: String): CloudPreviewFile? = try { target.read(CloudCrypto.objectId(target.credentials.vaultKey, path)) }
        catch (error: CloudRequestException) { if (error.status == 404) null else throw error }

    /** Writes under this name or the first free one ("name 2.md"). The same bytes already there count as written, so a retry never doubles. */
    fun writeUnderFreeName(target: CloudClient, path: String, bytes: ByteArray): String {
        val dot = path.lastIndexOf('.').takeIf { it > path.lastIndexOf('/') }
        val stem = dot?.let { path.substring(0, it) } ?: path
        val end = dot?.let { path.substring(it) }.orEmpty()
        for (copy in 1 until 1000) {
            val candidate = if (copy == 1) path else "$stem $copy$end"
            val existing = fileAt(target, candidate)
            if (existing != null && !existing.deleted && existing.bytes.contentEquals(bytes)) return candidate
            if (existing != null && !existing.deleted) continue
            write(target, candidate, bytes, existing?.revision ?: 0)
            return candidate
        }
        error("Too many files are called \"$path\".")
    }

    /** The current files of one cloud in another, without old versions. Run it again to bring the copy up to date. */
    fun copyCurrentFiles(from: CloudClient, to: CloudClient) {
        // A file that does not open is left out: one bad file must not stop the owner from removing someone.
        val live = from.current().filter { !it.deleted }.mapNotNull { file ->
            try { from.read(file.id) } catch (error: Exception) { if (error is CloudRequestException || error is java.io.IOException) throw error else null }
        }.filter { !it.deleted }
        for (file in live) {
            val existing = fileAt(to, file.path)
            if (existing == null || existing.deleted || !existing.bytes.contentEquals(file.bytes)) write(to, file.path, file.bytes, existing?.revision ?: 0)
        }
        val paths = live.map { it.path }.toSet()
        for (file in to.current().filter { !it.deleted }) {
            val copy = to.read(file.id)
            if (!copy.deleted && copy.path !in paths) to.remove(copy.id, copy.revision)
        }
    }

    /**
     * Removing someone from a group of three or more: a new space with a new key, and the old one frozen once the copy
     * is complete. The server refuses the last step when the old space changed since the copy, so this copies again.
     */
    fun replace(client: CloudClient, space: CloudSpaceInfo, memberName: String, attempts: Int = 5): Pair<String, String> {
        val oldKey = requireNotNull(space.key) { "This shared space cannot be opened." }
        val next = create(client, space.name ?: "Shared", memberName, replaces = space.id)
        val from = files(client, space.id, oldKey)
        val to = files(client, next.first, next.second)
        var attempt = 1
        while (true) {
            val sequence = list(client).firstOrNull { it.id == space.id }?.sequence ?: 0L
            copyCurrentFiles(from, to)
            try {
                client.call(route(space.id, "/replace"), "POST", JSONObject().put("newSpaceId", next.first).put("expectedSequence", sequence))
                return next
            } catch (error: CloudRequestException) {
                if (error.status != 409 || error.code == "space-frozen" || attempt >= attempts) throw error
            }
            attempt++
        }
    }
}

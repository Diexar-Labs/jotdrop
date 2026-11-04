package com.diexar.keepcapture

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import org.json.JSONArray
import org.json.JSONObject

/**
 * A list anyone with the link can read and tick, without an account, the same way as cloud/shared/list-links.mjs.
 * The server keeps one sealed version with a number; your devices share one base (the last version an owner wrote)
 * in the link's `ownerEnvelope`, sealed under the vault key next to the link's key. Against that base, what the link
 * holds now is what guests did. The rules of what counts are in [CloudListRules].
 */
object CloudListLinks {
    data class Base(val revision: Int, val noteRevision: Int, val text: String)
    /** `key`, `path` and `base` are null when the owner envelope does not open on this device. */
    data class Link(val id: String, val revision: Int, val updatedAt: String?, val expiresAt: String?, val title: String, val path: String?, val key: String?, val base: Base?, val address: String?)
    class Opened(val title: String, val text: String, val marks: List<CloudListRules.Mark>, val revision: Int, val expiresAt: String?, val lines: List<CloudListRules.Line>)
    /** `skipped`: this device's note is older than the base's; it waits for its own sync. */
    class Synced(val text: String, val marks: List<CloudListRules.Mark>?, val noteChanged: Boolean, val linkChanged: Boolean, val revision: Int, val skipped: Boolean = false)
    /** The frontmatter and heading (`head`) stay in the note; the `body` below them is what the link holds. */
    class Parts(val head: String, val title: String, val body: String)
    private class Fetched(val envelope: String, val revision: Int, val expiresAt: String?)

    /** Text beyond this does not fit the server's 64 KB sealed envelope. */
    const val MAX_TEXT_BYTES = 48 * 1024
    private const val ATTEMPTS = 5

    private val frontmatter = Regex("^---\\r?\\n[\\s\\S]*?\\r?\\n---(?:\\r?\\n|$)")
    private val heading = Regex("^#[ \\t]+(.*?)[ \\t]*(?:\\r?\\n|$)(?:[ \\t]*\\r?\\n)?")

    /** The same split as the web app and the plugin, so two devices do not take turns rewriting the link's title. */
    fun splitNote(text: String): Parts {
        val front = frontmatter.find(text)?.value.orEmpty()
        val rest = text.substring(front.length)
        val title = heading.find(rest) ?: return Parts(front, "", rest)
        return Parts(front + title.value, title.groupValues[1], rest.substring(title.value.length))
    }

    /** The cloud path of a note in the local vault, as the sync names it, or null for a note outside the synced folder. */
    fun cloudPath(context: Context, note: Uri): String? {
        val vault = Storage.getVaultUri(context) ?: return null
        val id = runCatching { DocumentsContract.getDocumentId(note) }.getOrNull() ?: return null
        val tree = runCatching { DocumentsContract.getTreeDocumentId(vault) }.getOrNull() ?: return null
        val folder = Storage.getSubfolder(context).trim('/') + "/"
        val relative = id.removePrefix("$tree/").takeIf { it != id } ?: return null
        if (!relative.startsWith(folder) || !relative.endsWith(".md", true)) return null
        return runCatching { CloudSyncEngine.path("notes/" + relative.removePrefix(folder)) }.getOrNull()
    }

    private fun address(url: String, id: String, key: String) = "${url.trimEnd('/')}/l/$id#$key"
    private fun seal(key: String, payload: JSONObject, aad: String) =
        CloudClient.envelopeJson(CloudCrypto.encrypt(key, payload.toString().toByteArray(Charsets.UTF_8), aad)).toString()
    private fun open(key: String, envelope: String, aad: String) =
        JSONObject(String(CloudCrypto.decrypt(key, CloudClient.parseEnvelope(envelope), aad), Charsets.UTF_8))
    private fun marksJson(marks: List<CloudListRules.Mark>) = JSONArray().apply {
        for (mark in marks) put(JSONObject().put("line", mark.line).put("n", mark.n).put("by", mark.by).put("at", mark.at).put("added", mark.added))
    }
    private fun sealList(key: String, id: String, revision: Int, title: String, text: String, marks: List<CloudListRules.Mark>) =
        seal(key, JSONObject().put("v", 1).put("revision", revision).put("title", title).put("text", text).put("marks", marksJson(marks)), CloudListRules.listAad(id))
    private fun sealOwner(client: CloudClient, id: String, key: String, title: String, path: String?, base: Base): String {
        val mine = JSONObject().put("key", key).put("title", title).put("path", path)
            .put("base", JSONObject().put("revision", base.revision).put("noteRevision", base.noteRevision).put("text", base.text))
        return seal(client.credentials.vaultKey, mine, CloudListRules.ownerAad(client.credentials.vaultId, id))
    }

    /** Marks as read from a link: anything malformed is dropped, an odd name becomes "Someone". */
    private fun readMarks(value: JSONArray?): List<CloudListRules.Mark> {
        if (value == null) return emptyList()
        return (0 until value.length()).mapNotNull { index ->
            val mark = value.optJSONObject(index) ?: return@mapNotNull null
            val line = mark.opt("line") as? String ?: return@mapNotNull null
            val n = mark.opt("n") as? Int ?: return@mapNotNull null
            val at = when (val raw = mark.opt("at")) { is Int -> raw.toLong(); is Long -> raw; else -> return@mapNotNull null }
            if (line.length > 10000 || n < 0) return@mapNotNull null
            CloudListRules.Mark(line, n, CloudListRules.validName(mark.optString("by")), at, mark.opt("added") == true)
        }
    }

    /**
     * `days` 0 means until it is removed. `path` is the note's path and `noteRevision` the number of its uploaded version,
     * so each of your devices knows which note the link belongs to and whether it has that version yet.
     */
    fun create(client: CloudClient, title: String, text: String, days: Int, path: String, noteRevision: Int): Link {
        require(CloudListRules.hasChecklist(text)) { "This note has no checklist." }
        val id = java.util.UUID.randomUUID().toString()
        val key = CloudCrypto.token()
        val normalized = CloudListRules.normalize(text)
        val base = Base(1, noteRevision, normalized)
        val made = client.call("/list-links", "POST", JSONObject().put("id", id).put("days", days)
            .put("envelope", sealList(key, id, 1, title, normalized, emptyList()))
            .put("ownerEnvelope", sealOwner(client, id, key, title, path, base))
            .put("writeProofHash", CloudListRules.proofHash(key)))
        val expiresAt = if (made.isNull("expiresAt")) null else made.getString("expiresAt")
        return Link(id, 1, null, expiresAt, title, path, key, base, address(client.credentials.url, id, key))
    }

    /** Your list links as the server has them now. */
    fun list(client: CloudClient): List<Link> {
        val (vaultId, vaultKey) = client.credentials.let { it.vaultId to it.vaultKey }
        val links = client.call("/list-links").getJSONArray("links")
        return List(links.length()) { index ->
            val link = links.getJSONObject(index)
            val id = link.getString("id")
            val mine = runCatching { open(vaultKey, link.getString("ownerEnvelope"), CloudListRules.ownerAad(vaultId, id)) }.getOrNull()
            val base = mine?.optJSONObject("base")?.let { base ->
                val revision = base.opt("revision") as? Int
                val noteRevision = base.opt("noteRevision") as? Int
                val text = base.opt("text") as? String
                if (revision == null || revision < 1 || noteRevision == null || text == null) null else Base(revision, noteRevision, text)
            }
            val key = if (base != null) mine?.optString("key")?.takeIf { it.isNotEmpty() } else null
            val path = if (key != null) mine?.optString("path")?.takeIf { it.isNotEmpty() } else null
            Link(id, link.getInt("revision"), if (link.isNull("updatedAt")) null else link.getString("updatedAt"), if (link.isNull("expiresAt")) null else link.getString("expiresAt"),
                mine?.optString("title").orEmpty(), path, key, if (key != null) base else null, key?.let { address(client.credentials.url, id, it) })
        }
    }

    fun remove(client: CloudClient, id: String) { client.call("/list-links/$id", "DELETE") }

    private fun fetch(url: String, id: String, minRevision: Int?): Fetched {
        val got = CloudClient.request(url, "/public-lists/$id", "GET", null, null)
        val revision = got.getInt("revision")
        require(revision >= 1) { "This link does not open." }
        require(minRevision == null || revision >= minRevision) { "The server returned an older version of this list." }
        return Fetched(got.getString("envelope"), revision, if (got.isNull("expiresAt")) null else got.getString("expiresAt"))
    }

    /** The sealed list opened with the key. The number inside must be the number the server gave: an old version cannot pass as new. */
    private fun unseal(key: String, id: String, fetched: Fetched): Opened {
        val payload = open(key, fetched.envelope, CloudListRules.listAad(id))
        require(payload.optInt("v") == 1 && payload.opt("revision") == fetched.revision && payload.opt("title") is String && payload.opt("text") is String) { "This list does not match its version." }
        val text = CloudListRules.normalize(payload.getString("text"))
        val marks = CloudListRules.updateMarks(readMarks(payload.optJSONArray("marks")), text)
        return Opened(payload.getString("title"), text, marks, fetched.revision, fetched.expiresAt, CloudListRules.listLines(text, marks))
    }

    /** No account needed. Throws a [CloudRequestException] with status 404 or 410 when the link has ended. */
    fun open(url: String, id: String, key: String, minRevision: Int? = null): Opened = unseal(key, id, fetch(url, id, minRevision))

    /**
     * One check of one of your links, with the note clean: `note` is its uploaded body and `noteRevision` that version's
     * number. Guests' ticks and new lines come back as `text` with `noteChanged`: save and upload it, and the next check
     * carries it to the base. Once the note and the base agree, your own changes go into the link. A sealed version that
     * does not open, or does not match its number, counts as nothing new and is written over.
     */
    fun sync(client: CloudClient, link: Link, note: String, noteRevision: Int, title: String, ownerName: String = "Owner", now: Long = System.currentTimeMillis()): Synced {
        val mine = CloudListRules.normalize(note)
        val key = link.key
        val base = link.base
        check(key != null && base != null) { "This link cannot be opened on this device." }
        if (noteRevision < base.noteRevision) return Synced(mine, null, false, false, link.revision, skipped = true)
        if (link.revision == base.revision && mine == CloudListRules.normalize(base.text) && title == link.title) return Synced(mine, null, false, false, link.revision)
        for (attempt in 0 until ATTEMPTS) {
            val fetched = fetch(client.credentials.url, link.id, base.revision)
            val opened = runCatching { unseal(key, link.id, fetched) }.getOrNull()
            val result = CloudListRules.reconcile(base.text, mine, opened?.text ?: base.text, opened?.marks ?: emptyList(), ownerName, now)
            if (result.noteChanged) return Synced(result.text, result.marks, true, false, fetched.revision)
            val write = opened == null || result.linkChanged || title != opened.title
            val next = Base(fetched.revision + (if (write) 1 else 0), noteRevision, mine)
            try {
                val body = JSONObject().put("baseRevision", fetched.revision).put("ownerEnvelope", sealOwner(client, link.id, key, title, link.path, next))
                if (write) body.put("envelope", sealList(key, link.id, next.revision, title, mine, result.marks))
                val revision = client.call("/list-links/${link.id}", "PUT", body).getInt("revision")
                return Synced(result.text, result.marks, false, write, revision)
            } catch (error: CloudRequestException) {
                if (error.status != 409 || attempt >= ATTEMPTS - 1) throw error
            }
        }
        error("Someone else changed the list.")
    }
}

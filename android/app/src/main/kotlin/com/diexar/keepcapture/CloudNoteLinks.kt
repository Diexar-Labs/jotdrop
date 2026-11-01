package com.diexar.keepcapture

import org.json.JSONObject

/**
 * A copy of a note anyone with the link can read, the same way as cloud/shared/links.mjs. The key is only in the part of
 * the address after #, which browsers do not send, so the server holds sealed text.
 */
object CloudNoteLinks {
    data class Link(val id: String, val title: String, val address: String?, val expiresAt: String?)

    private fun linkAad(id: String) = "jotdrop:note-link:v1:$id"
    private fun ownerAad(vaultId: String, id: String) = "jotdrop:note-link-owner:v1:$vaultId:$id"
    private fun seal(key: String, payload: JSONObject, aad: String) =
        CloudClient.envelopeJson(CloudCrypto.encrypt(key, payload.toString().toByteArray(Charsets.UTF_8), aad)).toString()
    private fun address(client: CloudClient, id: String, key: String) = "${client.credentials.url.trimEnd('/')}/n/$id#$key"

    /** Frontmatter and attachments stay behind: a link is for the words. */
    fun parts(note: String): Pair<String, String> {
        val lines = FrontmatterParser.parse(note).body.split(Regex("\\r?\\n")).filterNot { Regex("^\\s*!\\[").containsMatchIn(it) }
        val heading = lines.firstOrNull { it.isNotBlank() }?.let { Regex("^#[ \\t]+(.*)$").find(it) }
        if (heading == null) return "" to lines.joinToString("\n").trim()
        return heading.groupValues[1].trim() to lines.dropWhile { it.isBlank() }.drop(1).joinToString("\n").trim()
    }

    /** `days` 0 means until it is removed. */
    fun create(client: CloudClient, title: String, text: String, days: Int): String {
        val id = java.util.UUID.randomUUID().toString()
        val key = CloudCrypto.token()
        val (vaultId, vaultKey) = client.credentials.let { it.vaultId to it.vaultKey }
        client.call("/links", "POST", JSONObject().put("id", id).put("days", days)
            .put("envelope", seal(key, JSONObject().put("title", title).put("text", text), linkAad(id)))
            .put("ownerEnvelope", seal(vaultKey, JSONObject().put("key", key).put("title", title.take(200)), ownerAad(vaultId, id))))
        return address(client, id, key)
    }

    fun list(client: CloudClient): List<Link> {
        val (vaultId, vaultKey) = client.credentials.let { it.vaultId to it.vaultKey }
        val links = client.call("/links").getJSONArray("links")
        return List(links.length()) { index ->
            val link = links.getJSONObject(index)
            val id = link.getString("id")
            val mine = runCatching {
                JSONObject(String(CloudCrypto.decrypt(vaultKey, CloudClient.parseEnvelope(link.getString("ownerEnvelope")), ownerAad(vaultId, id)), Charsets.UTF_8))
            }.getOrNull()
            Link(id, mine?.optString("title").orEmpty(), mine?.let { address(client, id, it.getString("key")) }, if (link.isNull("expiresAt")) null else link.getString("expiresAt"))
        }
    }

    fun remove(client: CloudClient, id: String) { client.call("/links/$id", "DELETE") }
}

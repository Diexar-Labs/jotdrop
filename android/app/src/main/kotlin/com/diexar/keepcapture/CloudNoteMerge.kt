package com.diexar.keepcapture

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * A note changed on two devices merges when the changes do not overlap, the same rules as cloud/shared/merge.mjs.
 * The note splits into frontmatter fields and the text below them. Against the version both devices last shared
 * (`base`), a field or the text that only one side changed takes that side; the same value on both sides is one
 * change, however each device writes it (`[a, b]` or a block list, quotes, 10 or 10.0). Anything else, and any
 * frontmatter this simple reading does not understand, gives null: then the sync keeps both versions as before.
 */
object CloudNoteMerge {
    class Field(val lines: List<String>, val value: String)
    class Note(val fields: LinkedHashMap<String, Field>, val body: String)

    private val number = Regex("^-?\\d+(\\.\\d+)?([eE][+-]?\\d+)?$")
    private val keyPattern = Regex("^[A-Za-z0-9_][A-Za-z0-9_.-]*$")
    private val item = Regex("^\\s*- ")

    private fun utf8(bytes: ByteArray): String? = try {
        Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes)).toString()
    } catch (_: CharacterCodingException) { null }

    /** One scalar as JotDrop reads it: quotes off, and numbers by value. Null when it needs real YAML. */
    private fun scalar(raw: String): String? {
        val value = raw.trim()
        if (value.length >= 2 && value[0] in "\"'" && value.last() in "\"'") {
            val inner = value.substring(1, value.length - 1)
            return if (value[0] != value.last() || inner.any { it in "\"'\\" }) null else "s:$inner"
        }
        if (value.isNotEmpty() && value[0] in "[]{}|>&*!%@`\"'#" || value.contains(" #") || value.contains(": ")) return null
        return if (number.matches(value)) "n:${value.toDouble()}" else "s:$value"
    }

    /** The fields and the text below them, or null when the frontmatter is more than flat keys and lists. */
    fun split(text: String): Note? {
        if ('\r' in text) return null
        val lines = text.split('\n')
        if (lines[0] != "---") return Note(linkedMapOf(), text)
        val end = lines.subList(1, lines.size).indexOf("---").let { if (it < 0) -1 else it + 1 }
        if (end < 0 || end == lines.size - 1) return null
        val fields = linkedMapOf<String, Field>()
        var i = 1
        while (i < end) {
            val line = lines[i]
            val colon = line.indexOf(':')
            val key = if (colon > 0) line.substring(0, colon) else ""
            if (!keyPattern.matches(key) || key in fields) return null
            val rest = line.substring(colon + 1)
            if (rest.isNotEmpty() && !rest.startsWith(" ")) return null
            val own = mutableListOf(line)
            val value: String?
            if (rest.isBlank()) {
                val items = mutableListOf<String?>()
                i++
                while (i < end && item.containsMatchIn(lines[i])) { own += lines[i]; items += scalar(lines[i].replaceFirst(item, "")); i++ }
                if (i < end && lines[i].firstOrNull()?.isWhitespace() == true) return null
                value = if (items.isEmpty()) "s:" else if (null in items) null else list(items.filterNotNull())
            } else {
                i++
                val flow = rest.trim()
                value = if (flow.startsWith("[") && flow.endsWith("]")) {
                    val inner = flow.substring(1, flow.length - 1)
                    val items = if (inner.isBlank()) emptyList() else inner.split(',').map(::scalar)
                    if (null in items) null else list(items.filterNotNull())
                } else scalar(rest)
            }
            fields[key] = Field(own, value ?: return null)
        }
        return Note(fields, lines.subList(end + 1, lines.size).joinToString("\n"))
    }

    private fun list(items: List<String>) = "l:" + items.joinToString("\u0000", "[", "]")

    /** The merged note's bytes, or null when the two versions really disagree. */
    fun merge(base: ByteArray?, local: ByteArray, cloud: ByteArray): ByteArray? {
        val mine = split(utf8(local) ?: return null) ?: return null
        val theirs = split(utf8(cloud) ?: return null) ?: return null
        val shared = base?.let(::utf8)?.let(::split)
        fun pick(own: String?, other: String?, old: String?): Boolean? = when {
            own == other -> true
            shared != null && own == old -> true
            shared != null && other == old -> false
            else -> null
        }
        val cloudBody = pick(mine.body, theirs.body, shared?.body) ?: return null
        val lines = mutableListOf<String>()
        for (key in LinkedHashSet(theirs.fields.keys + mine.fields.keys)) {
            val own = mine.fields[key]
            val other = theirs.fields[key]
            val fromCloud = pick(own?.value, other?.value, shared?.fields?.get(key)?.value) ?: return null
            (if (fromCloud) other else own)?.let { lines += it.lines }
        }
        val head = if (lines.isEmpty()) "" else lines.joinToString("\n", "---\n", "\n---\n")
        return (head + if (cloudBody) theirs.body else mine.body).toByteArray(Charsets.UTF_8)
    }
}

package com.diexar.keepcapture

/**
 * Small JSON for Ask JotDrop: objects as LinkedHashMap (order kept), arrays as List, numbers as Long or Double,
 * plus String, Boolean and null. Plain Kotlin, so the same code runs in the app and in the JVM check
 * (android.jar's org.json is only a stub there). Requests to AI services and their answers go through here.
 */
object AiJson {
    class ParseError(message: String) : Exception(message)

    fun parse(text: String): Any? {
        val reader = Reader(text)
        reader.space()
        val value = reader.value(0)
        reader.space()
        if (reader.at < text.length) throw ParseError("Unexpected text after JSON")
        return value
    }

    fun parseOrNull(text: String): Any? = try { parse(text) } catch (_: ParseError) { MISSING }

    /** Returned by [parseOrNull] when the text is not JSON (JSON null is a real value). */
    val MISSING = Any()

    fun stringify(value: Any?): String = StringBuilder().also { write(it, value) }.toString()

    private fun write(out: StringBuilder, value: Any?) {
        when (value) {
            null -> out.append("null")
            is String -> quote(out, value)
            is Boolean -> out.append(value)
            is Int, is Long -> out.append(value.toString())
            is Double -> if (value.isFinite() && value == Math.floor(value) && Math.abs(value) < 1e15) out.append(value.toLong()) else out.append(value)
            is Float -> write(out, value.toDouble())
            is Map<*, *> -> {
                out.append('{')
                var first = true
                for ((key, item) in value) {
                    if (!first) out.append(',')
                    first = false
                    quote(out, key.toString())
                    out.append(':')
                    write(out, item)
                }
                out.append('}')
            }
            is List<*> -> {
                out.append('[')
                value.forEachIndexed { index, item -> if (index > 0) out.append(','); write(out, item) }
                out.append(']')
            }
            else -> quote(out, value.toString())
        }
    }

    private fun quote(out: StringBuilder, text: String) {
        out.append('"')
        for (char in text) {
            when (char) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                '\b' -> out.append("\\b")
                '\u000C' -> out.append("\\f")
                else -> if (char.code < 0x20 || char == ' ' || char == ' ') out.append("\\u%04x".format(char.code)) else out.append(char)
            }
        }
        out.append('"')
    }

    private class Reader(val text: String) {
        var at = 0
        fun fail(what: String): Nothing = throw ParseError("$what at $at")
        fun space() { while (at < text.length && text[at].let { it == ' ' || it == '\n' || it == '\r' || it == '\t' }) at++ }
        fun value(depth: Int): Any? {
            if (depth > 200) fail("Too deep")
            if (at >= text.length) fail("Unexpected end")
            return when (text[at]) {
                '{' -> obj(depth)
                '[' -> array(depth)
                '"' -> string()
                't' -> word("true", true)
                'f' -> word("false", false)
                'n' -> word("null", null)
                else -> number()
            }
        }
        fun word(word: String, value: Any?): Any? { if (!text.startsWith(word, at)) fail("Unexpected word"); at += word.length; return value }
        fun obj(depth: Int): Map<String, Any?> {
            val map = LinkedHashMap<String, Any?>()
            at++
            space()
            if (text.getOrNull(at) == '}') { at++; return map }
            while (true) {
                space()
                if (text.getOrNull(at) != '"') fail("Expected a key")
                val key = string()
                space()
                if (text.getOrNull(at) != ':') fail("Expected :")
                at++
                space()
                map[key] = value(depth + 1)
                space()
                when (text.getOrNull(at)) { ',' -> at++; '}' -> { at++; return map }; else -> fail("Expected , or }") }
            }
        }
        fun array(depth: Int): List<Any?> {
            val list = ArrayList<Any?>()
            at++
            space()
            if (text.getOrNull(at) == ']') { at++; return list }
            while (true) {
                space()
                list.add(value(depth + 1))
                space()
                when (text.getOrNull(at)) { ',' -> at++; ']' -> { at++; return list }; else -> fail("Expected , or ]") }
            }
        }
        fun string(): String {
            at++
            val out = StringBuilder()
            while (true) {
                if (at >= text.length) fail("Unclosed string")
                val char = text[at++]
                when {
                    char == '"' -> return out.toString()
                    char == '\\' -> {
                        if (at >= text.length) fail("Bad escape")
                        when (val next = text[at++]) {
                            '"' -> out.append('"'); '\\' -> out.append('\\'); '/' -> out.append('/')
                            'b' -> out.append('\b'); 'f' -> out.append('\u000C'); 'n' -> out.append('\n')
                            'r' -> out.append('\r'); 't' -> out.append('\t')
                            'u' -> {
                                if (at + 4 > text.length) fail("Bad escape")
                                out.append(text.substring(at, at + 4).toIntOrNull(16)?.toChar() ?: fail("Bad escape"))
                                at += 4
                            }
                            else -> fail("Bad escape \\$next")
                        }
                    }
                    char.code < 0x20 -> fail("Control character in string")
                    else -> out.append(char)
                }
            }
        }
        fun number(): Any {
            val start = at
            if (text.getOrNull(at) == '-') at++
            while (at < text.length && text[at].isDigit()) at++
            var whole = true
            if (text.getOrNull(at) == '.') { whole = false; at++; while (at < text.length && text[at].isDigit()) at++ }
            if (text.getOrNull(at) == 'e' || text.getOrNull(at) == 'E') {
                whole = false; at++
                if (text.getOrNull(at) == '+' || text.getOrNull(at) == '-') at++
                while (at < text.length && text[at].isDigit()) at++
            }
            val raw = text.substring(start, at)
            if (raw.isEmpty() || raw == "-") fail("Unexpected character")
            if (whole) raw.toLongOrNull()?.let { return it }
            return raw.toDoubleOrNull() ?: fail("Bad number")
        }
    }
}

// Reading helpers for parsed JSON: a wrong shape gives null, never an exception.
@Suppress("UNCHECKED_CAST")
internal fun Any?.obj(): Map<String, Any?>? = this as? Map<String, Any?>
internal fun Any?.list(): List<Any?>? = this as? List<Any?>
internal fun Map<String, Any?>?.str(name: String): String? = this?.get(name) as? String
internal fun Map<String, Any?>?.num(name: String): Long? = (this?.get(name) as? Number)?.toLong()
internal fun Map<String, Any?>?.child(name: String): Map<String, Any?>? = this?.get(name).obj()
internal fun Map<String, Any?>?.items(name: String): List<Any?> = this?.get(name).list() ?: emptyList()

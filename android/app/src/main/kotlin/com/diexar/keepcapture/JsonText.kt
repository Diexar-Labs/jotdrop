package com.diexar.keepcapture

/**
 * Hand-geschreven JSON-string-extractor: vindt `"key"` (vanaf `from`),
 * leest de erop volgende waarde tot de eerste niet-ge-escapete `"`.
 * Vermijdt regex-backtracking op pathologische inputs.
 */
internal fun extractJsonString(json: String, key: String, from: Int = 0): String? {
    val needle = "\"" + key + "\""
    var idx = from
    while (true) {
        val found = json.indexOf(needle, idx)
        if (found < 0) return null
        // Sla witruimte en `:` over.
        var p = found + needle.length
        while (p < json.length && (json[p] == ' ' || json[p] == '\t' || json[p] == '\n' || json[p] == '\r' || json[p] == ':')) p++
        if (p >= json.length || json[p] != '"') {
            idx = found + 1
            continue
        }
        p++ // sla openingsquote over
        val sb = StringBuilder()
        while (p < json.length) {
            val c = json[p]
            if (c == '\\' && p + 1 < json.length) {
                sb.append(c)
                sb.append(json[p + 1])
                p += 2
            } else if (c == '"') {
                return decodeJsonString(sb.toString()).takeIf { it.isNotBlank() }
            } else {
                sb.append(c)
                p++
            }
        }
        return null
    }
}

internal fun decodeJsonString(s: String): String {
    val sb = StringBuilder()
    var i = 0
    while (i < s.length) {
        val c = s[i]
        if (c == '\\' && i + 1 < s.length) {
            when (val next = s[i + 1]) {
                '"' -> sb.append('"')
                '\\' -> sb.append('\\')
                '/' -> sb.append('/')
                'n' -> sb.append('\n')
                't' -> sb.append('\t')
                'r' -> sb.append('\r')
                'u' -> {
                    if (i + 5 < s.length) {
                        val hex = s.substring(i + 2, i + 6)
                        val code = hex.toIntOrNull(16)
                        if (code != null) {
                            sb.append(code.toChar())
                            i += 4
                        } else {
                            sb.append(next)
                        }
                    } else {
                        sb.append(next)
                    }
                }
                else -> sb.append(next)
            }
            i += 2
        } else {
            sb.append(c)
            i++
        }
    }
    return sb.toString()
}

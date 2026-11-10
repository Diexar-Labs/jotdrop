package com.diexar.keepcapture

/**
 * Keys never show: not in an error, a log line or a report. The same rules as cloud/shared/ai/redact.mjs: the
 * user's own key is hidden by value, the shapes of the big providers' keys (sk-..., AIza...) and anything after
 * Bearer or a key header by pattern.
 */
object AiRedact {
    private const val HIDDEN = "[hidden]"
    private val PATTERNS = listOf(
        Regex("(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}") to HIDDEN,
        Regex("AIza[0-9A-Za-z_-]{20,}") to HIDDEN,
        Regex("(?i)(Bearer\\s+)(?!\\[hidden\\])[^\\s\"',;]{6,}") to "$1$HIDDEN",
        Regex("(?i)((?:x-api-key|x-goog-api-key|api[_-]?key|authorization)[\"']?\\s*[:=]\\s*[\"']?)(?!Bearer\\b)(?!\\[hidden\\])[^\\s\"',;&}]{6,}") to "$1$HIDDEN",
        Regex("([?&]key=)(?!\\[hidden\\])[^&\\s\"']+") to "$1$HIDDEN",
    )

    fun redact(value: Any?, secrets: List<String?> = emptyList()): String {
        var text = when (value) {
            null -> ""
            is Throwable -> value.toString()
            else -> value.toString()
        }
        for (secret in secrets) {
            val trimmed = secret?.trim() ?: continue
            if (trimmed.length >= 6) text = text.replace(trimmed, HIDDEN)
        }
        for ((pattern, replacement) in PATTERNS) text = pattern.replace(text, replacement)
        return text
    }
}

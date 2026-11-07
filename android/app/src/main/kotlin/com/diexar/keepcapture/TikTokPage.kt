package com.diexar.keepcapture

/**
 * TikTok geeft via oEmbed geen titel, auteur of thumbnail meer voor video's, en de pagina
 * heeft geen og:-tags: alleen een algemene <title> "TikTok - Make Your Day", voor élke video
 * hetzelfde. De gegevens van de video zelf staan in de rehydration-JSON van de pagina; die
 * leest dit. Spiegel van `parseTikTokVideo` in `src/ogfetch.ts`.
 */
object TikTokPage {
    data class Video(
        val caption: String?,
        val authorId: String?,
        val nickname: String?,
        val covers: List<String>,
    )

    private const val GENERIC_TITLE = "TikTok - Make Your Day"

    fun isGenericTitle(title: String?): Boolean = title?.trim().equals(GENERIC_TITLE, ignoreCase = true)

    /** Het video-id uit een `/@user/video/<id>`- of `/photo/<id>`-URL; korte links hebben er geen. */
    fun videoId(url: String): String? = Regex("/(?:video|photo)/(\\d+)").find(url)?.groupValues?.get(1)

    /**
     * Geeft null als de pagina geen video bevat (muziekpagina, verwijderde video, captcha) of
     * als het id niet het verwachte is — liever geen voorbeeld dan dat van een andere video.
     */
    fun parse(html: String, expectedId: String? = null): Video? {
        val scope = html.indexOf("\"webapp.video-detail\"").takeIf { it >= 0 } ?: return null
        val item = html.indexOf("\"itemStruct\":{", scope).takeIf { it >= 0 } ?: return null
        // Een itemStruct na het volgende scope-blok hoort niet bij deze video.
        val nextScope = html.indexOf("\"webapp.", scope + 1)
        if (nextScope in 0 until item) return null
        val id = extractJsonString(html, "id", item) ?: return null
        if (expectedId != null && id != expectedId) return null
        val author = html.indexOf("\"author\":{", item)
        val covers = listOf("cover", "originCover", "dynamicCover")
            .mapNotNull { extractJsonString(html, it, item) }
            .distinct()
        return Video(
            caption = extractJsonString(html, "desc", item),
            authorId = if (author >= 0) extractJsonString(html, "uniqueId", author) else null,
            nickname = if (author >= 0) extractJsonString(html, "nickname", author) else null,
            covers = covers,
        )
    }
}

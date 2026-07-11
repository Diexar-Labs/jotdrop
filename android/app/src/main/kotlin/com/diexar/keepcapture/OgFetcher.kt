package com.diexar.keepcapture

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest

data class OgPreview(
    val sourceUrl: String,
    val title: String?,
    val description: String?,
    val imageBasename: String?,
)

object OgFetcher {

    // Desktop Chrome — Cloudflare/WAF-stacks scoren mobile UA's hoger als bot
    // dan desktop, dus desktop voorop is bewust. Spiegel van de plugin-kant.
    private const val USER_AGENT =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.127 Safari/537.36"
    // Crawler-UAs: nieuwsites met cookie-walls (Telegraaf e.d.) serveren OG-meta wél aan
    // bekende social-media-crawlers, zodat hun shares op FB/Twitter netjes embedden.
    // Twitterbot komt eerst omdat Telegraaf zelfs Googlebot/FB 403't, maar Twitterbot toelaat.
    private val FALLBACK_UAS = listOf(
        "Twitterbot/1.0",
        "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    )
    private const val CONNECT_TIMEOUT_MS = 8_000
    private const val READ_TIMEOUT_MS = 12_000
    private const val MAX_HTML_BYTES = 512 * 1024 // 512 KB — sommige sites hebben een grote <head>
    private const val MAX_IMAGE_BYTES = 4 * 1024 * 1024 // 4 MB image cap
    private val URL_REGEX = Regex("https?://\\S+", RegexOption.IGNORE_CASE)

    /**
     * Detecteert een URL in tekst. Geeft de URL terug, of null als er geen is.
     */
    fun detectUrl(text: String): String? {
        val match = URL_REGEX.find(text) ?: return null
        // Strip eventuele trailing leestekens die geen URL-onderdeel zijn.
        return match.value.trimEnd('.', ',', ')', ']', '}', '"', '\'', '!', '?', ';', ':')
    }

    /**
     * Vindt alle URL's in een stuk tekst en strip trailing-leestekens per match.
     * Bedoeld om bij share-intents meerdere kandidaten te kunnen vergelijken
     * (sommige apps — Telegraaf — sturen een afgekapte URL in EXTRA_TEXT terwijl
     * een volledige URL elders in het intent staat).
     */
    fun findAllUrls(text: String): List<String> {
        return URL_REGEX.findAll(text)
            .map { it.value.trimEnd('.', ',', ')', ']', '}', '"', '\'', '!', '?', ';', ':') }
            .filter { it.isNotEmpty() }
            .toList()
    }

    /**
     * Herkent of een URL afgekapt is met een ellipsis (Telegraaf-app stuurt zo
     * verkorte URL's mee in de share-tekst — die 404'en in een echte browser).
     */
    fun isTruncatedUrl(url: String): Boolean {
        val normalized = url.lowercase()
        return url.contains('…') || // …
            normalized.contains("%e2%80%a6") ||
            url.endsWith("...")
    }

    /**
     * Haalt OG-meta op voor een URL en slaat de afbeelding op in de attachments-map.
     * Retourneert de basenaam van de afbeelding (bv. "a3f.jpg") of null bij fout.
     */
    fun fetch(context: Context, url: String, downloadImages: Boolean = true): Result<OgPreview> {
        return try {
            // Speciale gevallen: sites die JS-renderen en hun OG via oEmbed serveren.
            if (url.contains("tiktok.com", ignoreCase = true)) {
                // TikTok's oEmbed accepteert alleen de canonieke `/@user/video/<id>`-URL.
                // Korte vm./vt.-links eerst zelf redirecten — anders hangt het endpoint
                // soms 10+ seconden voor het uiteindelijk een fout teruggeeft.
                val canonical = if (url.contains("vm.tiktok.com", ignoreCase = true) ||
                    url.contains("vt.tiktok.com", ignoreCase = true)) {
                    resolveRedirects(url)
                } else url
                return fetchViaOEmbed(context, canonical, "https://www.tiktok.com/oembed?url=", downloadImages)
            }
            // Twitter/X blokkeert scrapers voor uitgelogde clients. fxtwitter.com is een mirror
            // die wél nette OG-meta serveert (gebruikt door Discord/Telegram embeds).
            val fetchUrl = rewriteForScraping(url)

            // Probeer eerst met Chrome desktop UA. Als dat een 4xx geeft (Telegraaf 403't bv.)
            // óf geen image-kandidaten levert (cookie-wall HTML), retry met crawler-UAs in volgorde.
            var html: String? = null
            var rawImageCandidates: List<String> = emptyList()
            var lastError: Throwable? = null

            for (ua in listOf(USER_AGENT) + FALLBACK_UAS) {
                val attempt = downloadHtml(fetchUrl, ua)
                val attemptHtml = attempt.getOrNull()
                if (attemptHtml == null) {
                    lastError = attempt.exceptionOrNull()
                    continue
                }
                if (html == null) html = attemptHtml
                val candidates = findOgImageCandidates(attemptHtml, fetchUrl)
                if (candidates.isNotEmpty()) {
                    html = attemptHtml
                    rawImageCandidates = candidates
                    break
                }
            }

            if (html == null) {
                return Result.failure(lastError ?: IllegalStateException("Geen HTML opgehaald"))
            }

            val title = extractMeta(html, "og:title")
                ?: extractMeta(html, "twitter:title")
                ?: extractTitleTag(html)
            val description = extractMeta(html, "og:description")
                ?: extractMeta(html, "twitter:description")
                ?: extractMeta(html, "description")

            // Probeer elke kandidaat tot er één daadwerkelijk downloadbaar is.
            // Hola Gestoría heeft bijvoorbeeld een og:image die 404't — dan vallen
            // we automatisch terug op apple-touch-icon of body-img.
            var imageBasename: String? = null
            if (downloadImages) {
                for (candidate in rawImageCandidates) {
                    val absolute = absolutize(candidate, fetchUrl)
                    val basename = downloadImage(context, absolute).getOrNull()
                    if (basename != null) {
                        imageBasename = basename
                        break
                    }
                }
            }

            Result.success(
                OgPreview(
                    sourceUrl = url,
                    title = title,
                    description = description,
                    imageBasename = imageBasename,
                )
            )
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * Verzamelt álle image-kandidaten in prioriteitsvolgorde. Sites zetten soms
     * een `og:image` die 404't (zie holagestoria.es) — we vallen dan terug op
     * twitter:image, JSON-LD, apple-touch-icon en als allerlaatste een
     * same-site `<img>` uit de body. Spiegel van de plugin-keten.
     */
    private fun findOgImageCandidates(html: String, pageUrl: String): List<String> {
        val sources = listOfNotNull(
            extractMeta(html, "og:image"),
            extractMeta(html, "og:image:url"),
            extractMeta(html, "og:image:secure_url"),
            extractMeta(html, "twitter:image"),
            extractMeta(html, "twitter:image:src"),
            extractLinkImageSrc(html),
            extractJsonLdImage(html),
            extractAppleTouchIcon(html),
            extractFirstBodyImage(html, pageUrl),
        )
        val seen = mutableSetOf<String>()
        return sources.filter { it.isNotEmpty() && seen.add(it) }
    }

    /**
     * Schema.org JSON-LD-blokken kunnen een `image`-veld bevatten — string,
     * object met `url`, of array van een van beide. We wandelen de boom
     * recursief af tot de eerste string-URL.
     */
    private fun extractJsonLdImage(html: String): String? {
        val scriptRe = Regex(
            """<script[^>]+type\s*=\s*["']application/ld\+json["'][^>]*>([\s\S]*?)</script>""",
            RegexOption.IGNORE_CASE,
        )
        for (match in scriptRe.findAll(html)) {
            val payload = match.groupValues[1].trim()
            if (payload.isEmpty()) continue
            val found = try {
                when {
                    payload.startsWith("{") -> walkJsonLdImage(JSONObject(payload))
                    payload.startsWith("[") -> walkJsonLdImage(JSONArray(payload))
                    else -> null
                }
            } catch (_: JSONException) {
                null
            }
            if (found != null) return found
        }
        return null
    }

    private fun walkJsonLdImage(node: Any?): String? {
        when (node) {
            is JSONArray -> {
                for (i in 0 until node.length()) {
                    val found = walkJsonLdImage(node.opt(i))
                    if (found != null) return found
                }
            }
            is JSONObject -> {
                val image = node.opt("image")
                when (image) {
                    is String -> if (image.isNotBlank()) return image
                    is JSONObject -> {
                        val url = image.optString("url", "")
                        if (url.isNotBlank()) return url
                    }
                    is JSONArray -> {
                        for (i in 0 until image.length()) {
                            when (val item = image.opt(i)) {
                                is String -> if (item.isNotBlank()) return item
                                is JSONObject -> {
                                    val url = item.optString("url", "")
                                    if (url.isNotBlank()) return url
                                }
                            }
                        }
                    }
                }
                val keys = node.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    if (key == "image") continue
                    val found = walkJsonLdImage(node.opt(key))
                    if (found != null) return found
                }
            }
        }
        return null
    }

    /**
     * Apple-touch-icon — WordPress genereert die standaard op 180x180, dus nog
     * acceptabel als card-thumbnail. Beter dan een lege kaart.
     */
    private fun extractAppleTouchIcon(html: String): String? {
        val p1 = Regex(
            """<link[^>]+?rel\s*=\s*["']apple-touch-icon(?:-precomposed)?["'][^>]*?href\s*=\s*["']([^"']+)["']""",
            RegexOption.IGNORE_CASE,
        )
        val p2 = Regex(
            """<link[^>]+?href\s*=\s*["']([^"']+)["'][^>]*?rel\s*=\s*["']apple-touch-icon(?:-precomposed)?["']""",
            RegexOption.IGNORE_CASE,
        )
        val match = p1.find(html) ?: p2.find(html)
        return match?.groupValues?.getOrNull(1)?.let { decodeHtmlEntities(it).trim().takeIf { s -> s.isNotEmpty() } }
    }

    /**
     * Allerlaatste redmiddel: eerste niet-triviale `<img>` uit de body.
     * Filtert third-party widgets (Google-login, FB-pixel) op same-site domein.
     */
    private fun extractFirstBodyImage(html: String, pageUrl: String): String? {
        val bodyMatch = Regex("""<body\b[\s\S]*$""", RegexOption.IGNORE_CASE).find(html)
        val body = bodyMatch?.value ?: html
        val imgRe = Regex(
            """<img\b[^>]*?(?:data-src|data-lazy-src|src)\s*=\s*["']([^"']+)["']""",
            RegexOption.IGNORE_CASE,
        )
        for (m in imgRe.findAll(body)) {
            val src = decodeHtmlEntities(m.groupValues[1]).trim()
            if (src.isEmpty()) continue
            if (src.startsWith("data:")) continue
            if (Regex("""\.svg(\?|#|$)""", RegexOption.IGNORE_CASE).containsMatchIn(src)) continue
            if (Regex("""\b(spinner|loader|placeholder|pixel|tracking|spacer|blank|transparent)\b""", RegexOption.IGNORE_CASE).containsMatchIn(src)) continue
            if (Regex("""\b1x1\b|\b1px\b""", RegexOption.IGNORE_CASE).containsMatchIn(src)) continue
            if (!isSameSite(src, pageUrl)) continue
            return src
        }
        return null
    }

    /**
     * Same-site check voor de body-img scrape. Relatieve URL's zijn per
     * definitie same-site. Voor absolute URL's vergelijken we hostnames met
     * `www.`-prefix gestript, subdomeinen worden geaccepteerd.
     */
    private fun isSameSite(imageSrc: String, pageUrl: String): Boolean {
        if (!Regex("""^https?://""", RegexOption.IGNORE_CASE).containsMatchIn(imageSrc)) return true
        return try {
            val strip: (String) -> String = { it.lowercase().removePrefix("www.") }
            val imgHost = strip(URL(imageSrc).host)
            val pageHost = strip(URL(pageUrl).host)
            imgHost == pageHost ||
                imgHost.endsWith(".$pageHost") ||
                pageHost.endsWith(".$imgHost")
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Schrijf bekende JS-rendered sites om naar mirrors die wél nette OG-meta serveren.
     * Voor nu: twitter.com / x.com → fxtwitter.com (zelfde pad).
     */
    private fun rewriteForScraping(url: String): String {
        return try {
            val u = URL(url)
            val host = u.host.lowercase()
            val mirrored = when {
                host == "twitter.com" || host == "www.twitter.com" -> "fxtwitter.com"
                host == "x.com" || host == "www.x.com" -> "fxtwitter.com"
                host == "mobile.twitter.com" || host == "mobile.x.com" -> "fxtwitter.com"
                else -> return url
            }
            val port = if (u.port == -1) "" else ":${u.port}"
            val query = if (u.query.isNullOrEmpty()) "" else "?${u.query}"
            "${u.protocol}://$mirrored$port${u.path}$query"
        } catch (_: Exception) {
            url
        }
    }

    /**
     * Chrome-fingerprint headers — sobere requests (alleen UA + Accept) worden
     * door Cloudflare/WAF-stacks geweigerd met 403 nog vóór de bytes worden
     * geserveerd. Met de volledige sec-ch-ua/sec-fetch-set passeren we de
     * default-bot-regels. Gebruikt door zowel HTML-scrapes als image-downloads.
     */
    private fun applyBrowserHeaders(
        conn: HttpURLConnection,
        userAgent: String,
        accept: String,
        secFetchDest: String,
    ) {
        conn.setRequestProperty("User-Agent", userAgent)
        conn.setRequestProperty("Accept", accept)
        conn.setRequestProperty("Accept-Language", "nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7")
        conn.setRequestProperty("Referer", "https://www.google.com/")
        if (secFetchDest == "document") {
            conn.setRequestProperty("Upgrade-Insecure-Requests", "1")
        }
        val isChrome = userAgent.contains("Chrome/") && !userAgent.contains("Googlebot")
        if (isChrome) {
            conn.setRequestProperty("sec-ch-ua", "\"Not/A)Brand\";v=\"8\", \"Chromium\";v=\"126\", \"Google Chrome\";v=\"126\"")
            conn.setRequestProperty("sec-ch-ua-mobile", "?0")
            conn.setRequestProperty("sec-ch-ua-platform", "\"Windows\"")
            conn.setRequestProperty("sec-fetch-dest", secFetchDest)
            conn.setRequestProperty("sec-fetch-mode", if (secFetchDest == "document") "navigate" else "no-cors")
            conn.setRequestProperty("sec-fetch-site", "cross-site")
            if (secFetchDest == "document") {
                conn.setRequestProperty("sec-fetch-user", "?1")
            }
        }
    }

    /**
     * SSRF-guard: OG-fetching mag nooit bruikbaar zijn om de eigen telefoon,
     * het LAN of cloud-metadata-endpoints te bereiken via een gedeelde URL.
     * Hostname-literal-check (spiegelt de plugin): een publieke DNS-naam die
     * naar een privé-IP resolvet vangt dit niet, maar de directe en
     * redirect-literal-gevallen wel.
     */
    private fun isForbiddenTarget(urlString: String): Boolean {
        val url = try { URL(urlString) } catch (_: Exception) { return true }
        if (url.protocol != "http" && url.protocol != "https") return true
        val host = url.host.lowercase().trim('[', ']')
        if (host == "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true
        if (host.contains(":")) {
            // IPv6: loopback, link-local (fe80::/10), unique-local (fc00::/7).
            return host == "::1" || host == "::" || Regex("^(fe[89ab]|f[cd])").containsMatchIn(host)
        }
        val v4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$").matchEntire(host) ?: return false
        val a = v4.groupValues[1].toInt()
        val b = v4.groupValues[2].toInt()
        return a == 127 || a == 10 || a == 0 ||
            (a == 192 && b == 168) ||
            (a == 172 && b in 16..31) ||
            (a == 169 && b == 254) ||
            a >= 224 // multicast/reserved
    }

    private fun downloadHtml(urlString: String, userAgent: String = USER_AGENT): Result<String> {
        if (isForbiddenTarget(urlString)) {
            return Result.failure(IllegalArgumentException("Geweigerd: niet-publiek doel."))
        }
        val url = URL(urlString)
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            instanceFollowRedirects = true
        }
        applyBrowserHeaders(
            conn,
            userAgent,
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "document",
        )
        return try {
            val code = conn.responseCode
            if (code !in 200..299) {
                return Result.failure(IllegalStateException("HTTP $code"))
            }
            val charset = parseCharset(conn.contentType) ?: Charsets.UTF_8
            val buf = ByteArrayOutputStream()
            conn.inputStream.use { input ->
                val chunk = ByteArray(8 * 1024)
                var total = 0
                while (true) {
                    val n = input.read(chunk)
                    if (n <= 0) break
                    val toWrite = minOf(n, MAX_HTML_BYTES - total)
                    if (toWrite <= 0) break
                    buf.write(chunk, 0, toWrite)
                    total += toWrite
                    if (total >= MAX_HTML_BYTES) break
                }
            }
            Result.success(buf.toString(charset.name()))
        } catch (e: Exception) {
            Result.failure(e)
        } finally {
            conn.disconnect()
        }
    }

    private fun downloadImage(context: Context, urlString: String): Result<String> {
        if (isForbiddenTarget(urlString)) {
            return Result.failure(IllegalArgumentException("Geweigerd: niet-publiek doel."))
        }
        val attachmentsFolder = Storage.getOrCreateAttachmentsFolder(context).getOrElse {
            return Result.failure(it)
        }

        val url = URL(urlString)
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            instanceFollowRedirects = true
        }
        applyBrowserHeaders(
            conn,
            USER_AGENT,
            "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "image",
        )
        return try {
            val code = conn.responseCode
            if (code !in 200..299) {
                return Result.failure(IllegalStateException("Afbeelding HTTP $code"))
            }
            val mime = conn.contentType?.substringBefore(';')?.trim()?.lowercase().orEmpty()
            // Reject HTML error pages, login redirects, etc. that the server serves
            // on image URLs — these would otherwise be written as .png/.jpg files.
            if (mime.isNotEmpty() && !mime.startsWith("image/")) {
                return Result.failure(IllegalStateException("Geen afbeelding: content-type=$mime"))
            }
            val ext = when {
                mime.contains("jpeg") -> "jpg"
                mime.contains("png") -> "png"
                mime.contains("webp") -> "webp"
                mime.contains("gif") -> "gif"
                mime.contains("avif") -> "avif"
                else -> urlString.substringAfterLast('.', "")
                    .substringBefore('?')
                    .takeIf { it.length in 2..5 } ?: "jpg"
            }
            val basename = hashName(urlString) + "." + ext
            // Skip als 'ie al bestaat (zelfde URL → zelfde hash).
            attachmentsFolder.findFile(basename)?.let { existing ->
                if (existing.isFile && existing.length() > 0) {
                    return Result.success(basename)
                }
            }

            // Geen Content-Type-header → snif de magic bytes vóór we een bestand
            // aanmaken; anders belandt een headerloze HTML-foutpagina alsnog als
            // .jpg in de vault. Spiegelt de sniff in de plugin-fetcher.
            val stream = java.io.BufferedInputStream(conn.inputStream)
            if (mime.isEmpty()) {
                stream.mark(16)
                val header = ByteArray(16)
                var headerRead = 0
                while (headerRead < header.size) {
                    val n = stream.read(header, headerRead, header.size - headerRead)
                    if (n <= 0) break
                    headerRead += n
                }
                stream.reset()
                if (!looksLikeImageBytes(header, headerRead)) {
                    return Result.failure(IllegalStateException("Geen afbeelding: onherkenbare bytes."))
                }
            }

            val mimeForFile = when (ext) {
                "jpg" -> "image/jpeg"
                "png" -> "image/png"
                "webp" -> "image/webp"
                "gif" -> "image/gif"
                else -> "image/*"
            }
            val target = attachmentsFolder.createFile(mimeForFile, basename)
                ?: return Result.failure(IllegalStateException("Kan attachment niet aanmaken."))

            context.contentResolver.openOutputStream(target.uri, "wt")?.use { out ->
                stream.use { input ->
                    val chunk = ByteArray(16 * 1024)
                    var total = 0
                    while (true) {
                        val n = input.read(chunk)
                        if (n <= 0) break
                        val toWrite = minOf(n, MAX_IMAGE_BYTES - total)
                        if (toWrite <= 0) break
                        out.write(chunk, 0, toWrite)
                        total += toWrite
                        if (total >= MAX_IMAGE_BYTES) break
                    }
                }
            } ?: run {
                target.delete()
                return Result.failure(IllegalStateException("Kan niet schrijven naar attachment."))
            }
            Result.success(basename)
        } catch (e: Exception) {
            Result.failure(e)
        } finally {
            conn.disconnect()
        }
    }

    /** Magic-byte-check voor responses zónder Content-Type. Alleen formaten uit onze extensie-map. */
    private fun looksLikeImageBytes(b: ByteArray, len: Int): Boolean {
        if (len >= 3 && b[0] == 0xFF.toByte() && b[1] == 0xD8.toByte() && b[2] == 0xFF.toByte()) return true // JPEG
        if (len >= 4 && b[0] == 0x89.toByte() && b[1] == 0x50.toByte() && b[2] == 0x4E.toByte() && b[3] == 0x47.toByte()) return true // PNG
        if (len >= 4 && b[0] == 0x47.toByte() && b[1] == 0x49.toByte() && b[2] == 0x46.toByte() && b[3] == 0x38.toByte()) return true // GIF
        if (len >= 12 && b[0] == 0x52.toByte() && b[1] == 0x49.toByte() && b[2] == 0x46.toByte() && b[3] == 0x46.toByte() &&
            b[8] == 0x57.toByte() && b[9] == 0x45.toByte() && b[10] == 0x42.toByte() && b[11] == 0x50.toByte()
        ) return true // WEBP
        if (len >= 2 && b[0] == 0x42.toByte() && b[1] == 0x4D.toByte()) return true // BMP
        if (len >= 12 && b[4] == 0x66.toByte() && b[5] == 0x74.toByte() && b[6] == 0x79.toByte() && b[7] == 0x70.toByte()) return true // AVIF/HEIC (ftyp)
        return false
    }

    private fun hashName(input: String): String {
        val md = MessageDigest.getInstance("SHA-1")
        val bytes = md.digest(input.toByteArray(Charsets.UTF_8))
        return bytes.joinToString("") { "%02x".format(it) }.take(12)
    }

    private fun parseCharset(contentType: String?): java.nio.charset.Charset? {
        if (contentType == null) return null
        val match = Regex("charset=([^;\\s]+)", RegexOption.IGNORE_CASE).find(contentType) ?: return null
        return try {
            java.nio.charset.Charset.forName(match.groupValues[1].trim('"', '\''))
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Vindt een <meta>-tag met property of name = "og:xxx" en geeft de content terug.
     * Ondersteunt beide attribuutvolgordes en single/double quotes.
     */
    private fun extractMeta(html: String, propertyName: String): String? {
        val esc = Regex.escape(propertyName)
        // property/name kan voor of na content komen.
        val pattern1 = Regex(
            """<meta[^>]+?(?:property|name)\s*=\s*["']$esc["'][^>]*?content\s*=\s*["']([^"']*)["']""",
            RegexOption.IGNORE_CASE,
        )
        val pattern2 = Regex(
            """<meta[^>]+?content\s*=\s*["']([^"']*)["'][^>]*?(?:property|name)\s*=\s*["']$esc["']""",
            RegexOption.IGNORE_CASE,
        )
        val match = pattern1.find(html) ?: pattern2.find(html)
        val raw = match?.groupValues?.getOrNull(1) ?: return null
        return decodeHtmlEntities(raw).trim().takeIf { it.isNotEmpty() }
    }

    private fun extractTitleTag(html: String): String? {
        val match = Regex("<title[^>]*>([\\s\\S]*?)</title>", RegexOption.IGNORE_CASE).find(html)
        val raw = match?.groupValues?.getOrNull(1) ?: return null
        return decodeHtmlEntities(raw).trim().takeIf { it.isNotEmpty() }
    }

    /**
     * Sommige sites publiceren een image-preview via `<link rel="image_src" href="…">`
     * in plaats van een `<meta>`-tag.
     */
    private fun extractLinkImageSrc(html: String): String? {
        val pattern1 = Regex(
            """<link[^>]+?rel\s*=\s*["']image_src["'][^>]*?href\s*=\s*["']([^"']+)["']""",
            RegexOption.IGNORE_CASE,
        )
        val pattern2 = Regex(
            """<link[^>]+?href\s*=\s*["']([^"']+)["'][^>]*?rel\s*=\s*["']image_src["']""",
            RegexOption.IGNORE_CASE,
        )
        val match = pattern1.find(html) ?: pattern2.find(html)
        return match?.groupValues?.getOrNull(1)?.let { decodeHtmlEntities(it).trim() }
    }

    private fun decodeHtmlEntities(input: String): String {
        return input
            .replace("&amp;", "&")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&#x27;", "'")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&nbsp;", " ")
            .replace(Regex("&#(\\d+);")) { m ->
                m.groupValues[1].toIntOrNull()?.toChar()?.toString() ?: m.value
            }
    }

    /**
     * Sommige sites (TikTok, YouTube, Vimeo) renderen hun OG-meta pas met JavaScript
     * maar bieden wel een open oEmbed-endpoint dat JSON met `title`, `author_name`
     * en `thumbnail_url` teruggeeft. Dat parsen is robuuster dan HTML scrapen.
     */
    private fun fetchViaOEmbed(context: Context, originalUrl: String, oembedBase: String, downloadImages: Boolean = true): Result<OgPreview> {
        return try {
            val encoded = URLEncoder.encode(originalUrl, "UTF-8")
            val json = downloadHtml(oembedBase + encoded).getOrElse {
                return Result.failure(it)
            }
            val title = extractJsonString(json, "title")
            val author = extractJsonString(json, "author_name")
            val thumbnailUrl = extractJsonString(json, "thumbnail_url")
            val imageBasename = if (downloadImages) thumbnailUrl?.let { downloadImage(context, it).getOrNull() } else null

            val description = author?.takeIf { it.isNotBlank() }?.let { "via @$it" }

            Result.success(
                OgPreview(
                    sourceUrl = originalUrl,
                    title = title,
                    description = description,
                    imageBasename = imageBasename,
                )
            )
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * Hand-geschreven JSON-string-extractor: vindt `"key"` op het topniveau,
     * leest de erop volgende waarde tot de eerste niet-ge-escapete `"`.
     * Vermijdt regex-backtracking op pathologische inputs.
     */
    private fun extractJsonString(json: String, key: String): String? {
        val needle = "\"" + key + "\""
        var idx = 0
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

    private fun decodeJsonString(s: String): String {
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

    /**
     * Volgt 3xx-redirects handmatig met HEAD-requests. Sneller en betrouwbaarder
     * dan een externe service de redirect laten resolven (zoals TikTok's oEmbed,
     * dat soms 10+ seconden hangt op vm./vt.-shortlinks voor het opgeeft).
     */
    private fun resolveRedirects(urlString: String, maxHops: Int = 6): String {
        var current = urlString
        repeat(maxHops) {
            // Ook elke redirect-hop langs de SSRF-guard: een publieke URL die
            // 302't naar 192.168.x.x mag daar niet heen gevolgd worden.
            if (isForbiddenTarget(current)) return urlString
            val conn = try {
                (URL(current).openConnection() as HttpURLConnection).apply {
                    requestMethod = "HEAD"
                    connectTimeout = 4_000
                    readTimeout = 4_000
                    instanceFollowRedirects = false
                    setRequestProperty("User-Agent", USER_AGENT)
                }
            } catch (_: Exception) {
                return current
            }
            try {
                val code = conn.responseCode
                if (code in 300..399) {
                    val loc = conn.getHeaderField("Location") ?: return current
                    current = if (loc.startsWith("http", ignoreCase = true)) {
                        loc
                    } else {
                        try { URL(URL(current), loc).toString() } catch (_: Exception) { return current }
                    }
                } else {
                    return current
                }
            } catch (_: Exception) {
                return current
            } finally {
                conn.disconnect()
            }
        }
        return current
    }

    private fun absolutize(maybeRelative: String, pageUrl: String): String {
        return try {
            val base = URL(pageUrl)
            URL(base, maybeRelative).toString()
        } catch (_: Exception) {
            maybeRelative
        }
    }
}

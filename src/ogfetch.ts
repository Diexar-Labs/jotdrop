import { App, normalizePath, requestUrl } from "obsidian";

/**
 * OG meta fetcher for the plugin. Mirror of the Android OgFetcher so that
 * URLs entered in quick-capture get the same thumbnail as when they arrive
 * via the share flow on the phone.
 *
 * Uses Obsidian's `requestUrl` (no CORS in Electron) and writes downloaded
 * images to `<notesFolder>/.attachments/<hash>.<ext>` — the exact same
 * convention and SHA-1 naming as Android, so Syncthing deduplicates
 * automatically and the plugin's display flow finds the file.
 */

// Desktop Chrome — Cloudflare/WAF stacks score mobile UAs higher as bots
// than desktop, so desktop first is deliberate.
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.127 Safari/537.36";

// Order matters: Telegraaf 403s everyone except Twitterbot.
const FALLBACK_UAS = [
  "Twitterbot/1.0",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
];

const URL_REGEX = /https?:\/\/\S+/i;

export interface OgPreview {
  sourceUrl: string;
  title: string | null;
  description: string | null;
  imageBasename: string | null;
}

export function detectUrl(text: string): string | null {
  const match = text.match(URL_REGEX);
  if (!match) return null;
  return match[0].replace(/[.,)\]}"'!?;:]+$/, "");
}

/**
 * All unique `http(s)://` URLs in order of occurrence, after stripping embed
 * syntax so local image paths do not match. Used by the capture flow for OG
 * fallback: try first URL → if no image, try next, etc.
 */
export function detectAllUrls(text: string): string[] {
  const cleaned = text
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "");
  const matches = cleaned.match(/https?:\/\/[^\s)<>"']+/g) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const clean = raw.replace(/[.,)\]}"'!?;:]+$/, "");
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

export async function fetchOg(
  app: App,
  attachmentsFolder: string,
  url: string,
  downloadImages = true,
): Promise<OgPreview | null> {
  try {
    if (/tiktok\.com/i.test(url)) {
      // vm./vt. shortlinks do not accept the oEmbed endpoint — it hangs for
      // 10+ seconds before giving up. Resolve to the canonical URL first via
      // the redirect target's `<link rel="canonical">` or `og:url`.
      const canonical = /vm\.tiktok\.com|vt\.tiktok\.com/i.test(url)
        ? await resolveCanonicalUrl(url)
        : url;
      return await fetchTikTokOEmbed(app, attachmentsFolder, canonical, downloadImages);
    }
    const fetchUrl = rewriteForScraping(url);

    let html: string | null = null;
    let rawImageCandidates: string[] = [];
    const errors: string[] = [];

    for (const ua of [CHROME_UA, ...FALLBACK_UAS]) {
      const attempt = await downloadHtml(fetchUrl, ua);
      if ("error" in attempt) {
        errors.push(`${ua.split(/[\s\/]/)[0]}=${attempt.error}`);
        continue;
      }
      if (!html) html = attempt.html;
      const candidates = findOgImageCandidates(attempt.html, fetchUrl);
      if (candidates.length > 0) {
        html = attempt.html;
        rawImageCandidates = candidates;
        break;
      }
    }

    if (!html) {
      console.warn(`Jot Drop: could not fetch HTML for ${url} (${errors.join("; ")})`);
      return null;
    }

    const title =
      extractMeta(html, "og:title") ||
      extractMeta(html, "twitter:title") ||
      extractTitleTag(html);
    const description =
      extractMeta(html, "og:description") ||
      extractMeta(html, "twitter:description") ||
      extractMeta(html, "description");
    let imageBasename: string | null = null;
    if (downloadImages) {
      for (const candidate of rawImageCandidates) {
        const absolute = absolutize(candidate, fetchUrl);
        const basename = await downloadImage(app, attachmentsFolder, absolute);
        if (basename) {
          imageBasename = basename;
          break;
        }
      }
    }

    return { sourceUrl: url, title, description, imageBasename };
  } catch (e) {
    console.error("Jot Drop: OG-fetch failed:", e);
    return null;
  }
}

/**
 * Follows vm./vt.tiktok.com shortlinks to the canonical `/@user/video/<id>` URL.
 * Obsidian's `requestUrl` follows 3xx automatically — we then extract the
 * canonical link or og:url meta from the final HTML.
 */
async function resolveCanonicalUrl(shortUrl: string): Promise<string> {
  try {
    const res = await requestUrl({
      url: shortUrl,
      method: "GET",
      headers: { "User-Agent": CHROME_UA },
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) return shortUrl;
    const html = res.text;
    const linkPattern1 = /<link[^>]+?rel\s*=\s*["']canonical["'][^>]*?href\s*=\s*["']([^"']+)["']/i;
    const linkPattern2 = /<link[^>]+?href\s*=\s*["']([^"']+)["'][^>]*?rel\s*=\s*["']canonical["']/i;
    const canon = html.match(linkPattern1) || html.match(linkPattern2);
    if (canon) {
      const decoded = decodeHtmlEntities(canon[1]).trim();
      if (decoded) return decoded;
    }
    const ogUrl = extractMeta(html, "og:url");
    if (ogUrl) return ogUrl;
    return shortUrl;
  } catch {
    return shortUrl;
  }
}

async function fetchTikTokOEmbed(
  app: App,
  attachmentsFolder: string,
  url: string,
  downloadImages: boolean,
): Promise<OgPreview | null> {
  try {
    const oembedUrl = "https://www.tiktok.com/oembed?url=" + encodeURIComponent(url);
    const res = await requestUrl({
      url: oembedUrl,
      method: "GET",
      headers: { "User-Agent": CHROME_UA },
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) return null;
    const json = JSON.parse(res.text);
    const title = typeof json.title === "string" ? json.title : null;
    const author = typeof json.author_name === "string" ? json.author_name : null;
    const thumbnailUrl = typeof json.thumbnail_url === "string" ? json.thumbnail_url : null;
    const imageBasename = (downloadImages && thumbnailUrl)
      ? await downloadImage(app, attachmentsFolder, thumbnailUrl)
      : null;
    const description = author ? `via @${author}` : null;
    return { sourceUrl: url, title, description, imageBasename };
  } catch {
    return null;
  }
}

type DownloadResult = { html: string } | { error: string };

/**
 * Chrome-fingerprint headers — Cloudflare/WAF stacks reject bare requests
 * (UA + Accept only) and return 403 before bytes are even served.
 * With the full `sec-ch-ua-*` + `sec-fetch-*` set we pass the default bot rules.
 * Used for both HTML scrapes and image downloads.
 *
 * Accept-Encoding is deliberately NOT set: Electron's requestUrl handles
 * decompression automatically, and setting it manually produces raw gzipped
 * bytes on some builds.
 */
function browserHeaders(
  userAgent: string,
  opts: { accept: string; secFetchDest: "document" | "image" },
): Record<string, string> {
  const isChrome = userAgent.includes("Chrome/") && !userAgent.includes("Googlebot");
  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    Accept: opts.accept,
    "Accept-Language": "nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7",
    Referer: "https://www.google.com/",
  };
  if (opts.secFetchDest === "document") {
    headers["Upgrade-Insecure-Requests"] = "1";
  }
  if (isChrome) {
    headers["sec-ch-ua"] = '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"';
    headers["sec-ch-ua-mobile"] = "?0";
    headers["sec-ch-ua-platform"] = '"Windows"';
    headers["sec-fetch-dest"] = opts.secFetchDest;
    headers["sec-fetch-mode"] = opts.secFetchDest === "document" ? "navigate" : "no-cors";
    headers["sec-fetch-site"] = "cross-site";
    if (opts.secFetchDest === "document") headers["sec-fetch-user"] = "?1";
  }
  return headers;
}

async function downloadHtml(url: string, userAgent: string): Promise<DownloadResult> {
  const headers = browserHeaders(userAgent, {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    secFetchDest: "document",
  });
  try {
    const res = await requestUrl({ url, method: "GET", headers, throw: false });
    if (res.status < 200 || res.status >= 300) {
      return { error: `HTTP ${res.status}` };
    }
    return { html: res.text };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function downloadImage(
  app: App,
  attachmentsFolder: string,
  imageUrl: string,
): Promise<string | null> {
  try {
    const folder = normalizePath(attachmentsFolder);
    try {
      await app.vault.adapter.mkdir(folder);
    } catch {
      // Already exists — adapter.mkdir throws on some builds, ignoring is safe.
    }

    const base = await hashName(imageUrl);
    const urlExt = guessExtensionFromUrl(imageUrl);

    // Fast dedup: if already saved with the URL-guessed extension, skip the download.
    if (urlExt) {
      const quickPath = normalizePath(`${folder}/${base}.${urlExt}`);
      if (await app.vault.adapter.exists(quickPath)) {
        return `${base}.${urlExt}`;
      }
    }

    const headers = browserHeaders(CHROME_UA, {
      accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      secFetchDest: "image",
    });
    const res = await requestUrl({ url: imageUrl, method: "GET", headers, throw: false });
    if (res.status < 200 || res.status >= 300) {
      console.warn(`Jot Drop: image download failed for ${imageUrl} (HTTP ${res.status})`);
      return null;
    }

    // Reject non-image responses — some servers return an HTML error page or a
    // redirect to a login screen for image URLs, resulting in a Markdown file
    // that Obsidian incorrectly treats as a PNG/JPEG.
    const rawCt = (res.headers?.["content-type"] ?? "") as string;
    const contentType = rawCt.split(";")[0].trim().toLowerCase();
    if (contentType && !contentType.startsWith("image/")) {
      console.warn(`Jot Drop: skipping non-image response (${contentType}) for ${imageUrl}`);
      return null;
    }

    // Prefer the content-type extension over the URL hint (more accurate).
    const ext = extensionFromContentType(contentType) || urlExt || "jpg";
    const filename = `${base}.${ext}`;
    const path = normalizePath(`${folder}/${filename}`);

    if (await app.vault.adapter.exists(path)) {
      return filename;
    }

    await app.vault.adapter.writeBinary(path, res.arrayBuffer);
    return filename;
  } catch (e) {
    console.error("Jot Drop: image download failed:", e);
    return null;
  }
}

function extensionFromContentType(contentType: string): string | null {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/bmp": "bmp",
  };
  return map[contentType] ?? null;
}

function rewriteForScraping(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host.toLowerCase();
    const shouldMirror =
      host === "twitter.com" ||
      host === "www.twitter.com" ||
      host === "x.com" ||
      host === "www.x.com" ||
      host === "mobile.twitter.com" ||
      host === "mobile.x.com";
    if (shouldMirror) {
      u.host = "fxtwitter.com";
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Collects all image candidates in priority order. Sites sometimes set an
 * `og:image` that 404s (see holagestoria.es) — we must then be able to fall
 * back to twitter:image, JSON-LD or the apple-touch-icon. Duplicates are
 * filtered out so we do not fetch the same 404 twice.
 */
function findOgImageCandidates(html: string, pageUrl: string): string[] {
  const sources = [
    extractMeta(html, "og:image"),
    extractMeta(html, "og:image:url"),
    extractMeta(html, "og:image:secure_url"),
    extractMeta(html, "twitter:image"),
    extractMeta(html, "twitter:image:src"),
    extractLinkImageSrc(html),
    extractJsonLdImage(html),
    extractAppleTouchIcon(html),
    extractFirstBodyImage(html, pageUrl),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of sources) {
    if (!src || seen.has(src)) continue;
    seen.add(src);
    out.push(src);
  }
  return out;
}

/**
 * Schema.org JSON-LD blocks can contain an `image` field — string, object
 * with `url`, or an array of either. We walk the tree recursively
 * until the first string URL.
 */
function extractJsonLdImage(html: string): string | null {
  const scriptRe = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    try {
      const json = JSON.parse(match[1].trim());
      const found = walkForJsonLdImage(json);
      if (found) return found;
    } catch {
      // Invalid JSON-LD — skip.
    }
  }
  return null;
}

function walkForJsonLdImage(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = walkForJsonLdImage(item);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const image = obj.image;
    if (typeof image === "string") return image;
    if (Array.isArray(image)) {
      for (const item of image) {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const url = (item as Record<string, unknown>).url;
          if (typeof url === "string") return url;
        }
      }
    } else if (image && typeof image === "object") {
      const url = (image as Record<string, unknown>).url;
      if (typeof url === "string") return url;
    }
    for (const key of Object.keys(obj)) {
      if (key === "image") continue;
      const found = walkForJsonLdImage(obj[key]);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Last resort — some sites (see holagestoria.es) have all meta images broken
 * or missing. We then take the first non-trivial `<img>` from the body, which
 * is usually the logo or hero image. Filters against noise: data URIs (inline
 * base64), SVGs (no JPG/PNG so our extension guesser does not work), tracking
 * pixels and spinners.
 *
 * We search in `<body>` first to prevent a favicon from `<head>` being returned.
 */
function extractFirstBodyImage(html: string, pageUrl: string): string | null {
  const bodyMatch = html.match(/<body\b[\s\S]*$/i);
  const body = bodyMatch ? bodyMatch[0] : html;
  const imgRe = /<img\b[^>]*?(?:data-src|data-lazy-src|src)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(body)) !== null) {
    const src = decodeHtmlEntities(m[1]).trim();
    if (!src) continue;
    if (src.startsWith("data:")) continue;
    if (/\.svg(\?|#|$)/i.test(src)) continue;
    if (/\b(spinner|loader|placeholder|pixel|tracking|spacer|blank|transparent)\b/i.test(src)) continue;
    if (/\b1x1\b|\b1px\b/i.test(src)) continue;
    if (!isSameSite(src, pageUrl)) continue;
    return src;
  }
  return null;
}

/**
 * Filters out third-party img tags (Google login buttons, Facebook pixels, etc.)
 * from the body scrape. Relative URLs are by definition same-site. For absolute
 * URLs we compare hostnames with the `www.` prefix stripped, and accept
 * subdomains (a CDN at `cdn.holagestoria.es` still belongs to that site).
 */
function isSameSite(imageSrc: string, pageUrl: string): boolean {
  if (!/^https?:\/\//i.test(imageSrc)) return true;
  try {
    const strip = (h: string) => h.toLowerCase().replace(/^www\./, "");
    const imgHost = strip(new URL(imageSrc).host);
    const pageHost = strip(new URL(pageUrl).host);
    if (imgHost === pageHost) return true;
    if (imgHost.endsWith("." + pageHost)) return true;
    if (pageHost.endsWith("." + imgHost)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Last resort for sites without OG/Twitter meta: the apple-touch-icon.
 * WordPress generates it at 180x180 by default, so it still looks acceptable
 * as a card thumbnail. Better than an empty card.
 */
function extractAppleTouchIcon(html: string): string | null {
  const p1 = /<link[^>]+?rel\s*=\s*["']apple-touch-icon(?:-precomposed)?["'][^>]*?href\s*=\s*["']([^"']+)["']/i;
  const p2 = /<link[^>]+?href\s*=\s*["']([^"']+)["'][^>]*?rel\s*=\s*["']apple-touch-icon(?:-precomposed)?["']/i;
  const m = html.match(p1) || html.match(p2);
  if (!m) return null;
  return decodeHtmlEntities(m[1]).trim() || null;
}

function extractMeta(html: string, propertyName: string): string | null {
  const esc = propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const p1 = new RegExp(
    `<meta[^>]+?(?:property|name)\\s*=\\s*["']${esc}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`,
    "i",
  );
  const p2 = new RegExp(
    `<meta[^>]+?content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${esc}["']`,
    "i",
  );
  const m = html.match(p1) || html.match(p2);
  if (!m) return null;
  const decoded = decodeHtmlEntities(m[1]).trim();
  return decoded || null;
}

function extractTitleTag(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  return decodeHtmlEntities(m[1]).trim() || null;
}

function extractLinkImageSrc(html: string): string | null {
  const p1 = /<link[^>]+?rel\s*=\s*["']image_src["'][^>]*?href\s*=\s*["']([^"']+)["']/i;
  const p2 = /<link[^>]+?href\s*=\s*["']([^"']+)["'][^>]*?rel\s*=\s*["']image_src["']/i;
  const m = html.match(p1) || html.match(p2);
  if (!m) return null;
  return decodeHtmlEntities(m[1]).trim() || null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function absolutize(maybeRelative: string, base: string): string {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}

async function hashName(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-1", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

function guessExtensionFromUrl(url: string): string | null {
  const m = url.match(/\.(jpe?g|png|webp|gif|avif)(?:\?|#|$)/i);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return ext === "jpeg" ? "jpg" : ext;
}

/**
 * Builds a markdown note from an OG preview. Mirror of Android's `buildLinkNote`.
 * If `userContent` is exactly equal to the URL (user pasted only a URL),
 * we replace it with a full link note. Otherwise we only prepend the image
 * embed (if found) so the user's text is preserved.
 */
export function buildLinkNote(url: string, preview: OgPreview, userContent: string): string {
  const trimmedUser = userContent.trim();
  const title = (preview.title || "").trim() || url;
  const isJustUrl = trimmedUser === url;

  if (isJustUrl) {
    let s = `# ${title}\n\n`;
    if (preview.imageBasename) s += `![[${preview.imageBasename}]]\n\n`;
    s += `[${title}](${url})`;
    if (preview.description) s += `\n\n${preview.description}`;
    return s;
  }
  if (preview.imageBasename) {
    return `![[${preview.imageBasename}]]\n\n${userContent}`;
  }
  return userContent;
}

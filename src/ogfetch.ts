import { App, normalizePath, requestUrl } from "obsidian";

/**
 * OG-meta-fetcher voor de plugin. Spiegel van de Android-OgFetcher zodat
 * URL's die in de quick-capture zijn ingevoerd dezelfde thumbnail krijgen
 * als wanneer ze via de share-flow op de telefoon binnenkomen.
 *
 * Gebruikt Obsidian's `requestUrl` (geen CORS in Electron) en schrijft
 * gedownloade afbeeldingen naar `<notesFolder>/.attachments/<hash>.<ext>` —
 * exact dezelfde conventie en SHA-1-naamgeving als Android, dus Syncthing
 * deduplicates automatisch en de plugin's display-flow vindt de file.
 */

const CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36";

// Volgorde matters: Telegraaf 403't iedereen behalve Twitterbot.
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

export async function fetchOg(
  app: App,
  attachmentsFolder: string,
  url: string,
): Promise<OgPreview | null> {
  try {
    if (/tiktok\.com/i.test(url)) {
      return await fetchTikTokOEmbed(app, attachmentsFolder, url);
    }
    const fetchUrl = rewriteForScraping(url);

    let html = await downloadHtml(fetchUrl, CHROME_UA);
    let rawImageUrl = html ? findOgImage(html) : null;

    if (rawImageUrl == null) {
      for (const ua of FALLBACK_UAS) {
        const attempt = await downloadHtml(fetchUrl, ua);
        if (!attempt) continue;
        const img = findOgImage(attempt);
        if (img) {
          html = attempt;
          rawImageUrl = img;
          break;
        }
        if (!html) html = attempt;
      }
    }

    if (!html) return null;

    const title =
      extractMeta(html, "og:title") ||
      extractMeta(html, "twitter:title") ||
      extractTitleTag(html);
    const description =
      extractMeta(html, "og:description") ||
      extractMeta(html, "twitter:description") ||
      extractMeta(html, "description");
    const imageUrl = rawImageUrl ? absolutize(rawImageUrl, fetchUrl) : null;
    const imageBasename = imageUrl
      ? await downloadImage(app, attachmentsFolder, imageUrl)
      : null;

    return { sourceUrl: url, title, description, imageBasename };
  } catch (e) {
    console.error("Diexar Keep: OG-fetch faalde:", e);
    return null;
  }
}

async function fetchTikTokOEmbed(
  app: App,
  attachmentsFolder: string,
  url: string,
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
    const imageBasename = thumbnailUrl
      ? await downloadImage(app, attachmentsFolder, thumbnailUrl)
      : null;
    const description = author ? `via @${author}` : null;
    return { sourceUrl: url, title, description, imageBasename };
  } catch {
    return null;
  }
}

async function downloadHtml(url: string, userAgent: string): Promise<string | null> {
  try {
    const res = await requestUrl({
      url,
      method: "GET",
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) return null;
    return res.text;
  } catch {
    return null;
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
      // Bestaat al — adapter.mkdir gooit op sommige builds, negeren is veilig.
    }

    const base = await hashName(imageUrl);
    const ext = guessExtensionFromUrl(imageUrl) || "jpg";
    const filename = `${base}.${ext}`;
    const path = normalizePath(`${folder}/${filename}`);

    if (await app.vault.adapter.exists(path)) {
      return filename;
    }

    const res = await requestUrl({
      url: imageUrl,
      method: "GET",
      headers: { "User-Agent": CHROME_UA, Accept: "image/*" },
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) return null;

    await app.vault.adapter.writeBinary(path, res.arrayBuffer);
    return filename;
  } catch (e) {
    console.error("Diexar Keep: image-download faalde:", e);
    return null;
  }
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

function findOgImage(html: string): string | null {
  return (
    extractMeta(html, "og:image") ||
    extractMeta(html, "og:image:url") ||
    extractMeta(html, "twitter:image") ||
    extractMeta(html, "twitter:image:src") ||
    extractLinkImageSrc(html)
  );
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
 * Bouw een markdown-notitie uit een OG-preview. Spiegel van Android's `buildLinkNote`.
 * Als `userContent` exact gelijk is aan de URL (gebruiker plakte alleen een URL),
 * vervangen we 'm door een volledige link-notitie. Anders prependen we alleen
 * het image-embed (indien gevonden) zodat user-tekst behouden blijft.
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

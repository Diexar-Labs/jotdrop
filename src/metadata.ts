import { App, TFile } from "obsidian";

export type ColorName =
  | "default"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "teal"
  | "blue"
  | "purple"
  | "pink"
  | "brown"
  | "gray";

export const COLOR_NAMES: ColorName[] = [
  "default",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
  "brown",
  "gray",
];

export const COLOR_LABELS_NL: Record<ColorName, string> = {
  default: "Standaard",
  red: "Rood",
  orange: "Oranje",
  yellow: "Geel",
  green: "Groen",
  teal: "Turquoise",
  blue: "Blauw",
  purple: "Paars",
  pink: "Roze",
  brown: "Bruin",
  gray: "Grijs",
};

export interface NoteMeta {
  color: ColorName;
  tags: string[];
  pinned: boolean;
}

export const DEFAULT_META: NoteMeta = {
  color: "default",
  tags: [],
  pinned: false,
};

export function isColorName(value: unknown): value is ColorName {
  return typeof value === "string" && (COLOR_NAMES as string[]).includes(value);
}

/**
 * Leest metadata uit de Obsidian metadataCache. Werkt zonder eigen YAML-parser.
 */
export function readMeta(app: App, file: TFile): NoteMeta {
  const cache = app.metadataCache.getFileCache(file);
  const fm = cache?.frontmatter ?? {};

  const color = isColorName(fm.color) ? fm.color : "default";

  const tags: string[] = [];
  const seen = new Set<string>();
  const pushTag = (t: string) => {
    const clean = t.replace(/^#/, "").trim();
    if (!clean) return;
    if (seen.has(clean.toLowerCase())) return;
    seen.add(clean.toLowerCase());
    tags.push(clean);
  };
  if (Array.isArray(fm.tags)) {
    for (const t of fm.tags) {
      if (typeof t === "string") pushTag(t);
    }
  } else if (typeof fm.tags === "string") {
    for (const t of fm.tags.split(/[\s,]+/)) pushTag(t);
  }
  // Inline #hashtags worden door cache.tags geleverd.
  if (cache?.tags) {
    for (const ref of cache.tags) pushTag(ref.tag);
  }

  const pinned = fm.pinned === true || fm.pinned === "true";

  return { color, tags, pinned };
}

/**
 * Past metadata aan in een notitie via processFrontMatter (read-modify-write veilig).
 */
export async function updateMeta(
  app: App,
  file: TFile,
  patch: Partial<NoteMeta>,
): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm) => {
    if (patch.color !== undefined) {
      if (patch.color === "default") delete fm.color;
      else fm.color = patch.color;
    }
    if (patch.pinned !== undefined) {
      if (patch.pinned) fm.pinned = true;
      else delete fm.pinned;
    }
    if (patch.tags !== undefined) {
      const cleaned = patch.tags
        .map((t) => t.replace(/^#/, "").trim())
        .filter((t) => t.length > 0);
      if (cleaned.length === 0) delete fm.tags;
      else fm.tags = Array.from(new Set(cleaned));
    }
  });
}

/**
 * Geeft alle bekende tags in de vault als gesorteerde lijst (voor autocomplete).
 */
export function getAllVaultTags(app: App): string[] {
  const raw = (app.metadataCache as unknown as { getTags?: () => Record<string, number> }).getTags?.() ?? {};
  return Object.keys(raw)
    .map((t) => t.replace(/^#/, ""))
    .filter((t) => t.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Geeft de body van een notitie zonder frontmatter-blok.
 */
export function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/**
 * Heel beperkte HTML-render voor previews: escapet HTML, rendert `[[link]]` en `[[link|alias]]`
 * als gestileerde spans, en zet `[text](url)` plus losse http(s)-URL's om naar klikbare
 * `<a class="diexar-keep-url">`-tags. Klikken worden afgevangen door de view via delegation.
 */
export function renderInlinePreviewHtml(text: string): string {
  const escaped = escapeHtml(text);

  // Wikilinks → spans. target/alias komen uit reeds geescapete tekst,
  // dus geen tweede escape-laag toepassen.
  const withWiki = escaped.replace(
    /\[\[([^\]\|\n]+)(?:\|([^\]\n]+))?\]\]/g,
    (_match, target: string, alias?: string) => {
      const safeTarget = target.trim();
      const display = (alias ?? target).trim();
      return `<span class="diexar-keep-wikilink" data-href="${safeTarget}">${display}</span>`;
    },
  );

  // Markdown-links eerst naar placeholders zodat de bare-URL-pass hun href-deel niet opnieuw matcht.
  const placeholders: string[] = [];
  const withMd = withWiki.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, label: string, url: string) => {
      const idx = placeholders.length;
      // url komt al door de buitenste escapeHtml-pass; niet nogmaals escapen,
      // anders krijg je &amp;amp; in href en knappen Telegraaf-URLs af op 404.
      placeholders.push(
        `<a class="diexar-keep-url" data-href="${url}" rel="noopener noreferrer">${label}</a>`,
      );
      return `L${idx}`;
    },
  );

  // Losse URL's
  const withUrls = withMd.replace(
    /https?:\/\/\S+/g,
    (raw: string) => {
      const tailMatch = raw.match(/[).,;:!?\]"']+$/);
      const trail = tailMatch ? tailMatch[0] : "";
      const clean = trail ? raw.slice(0, raw.length - trail.length) : raw;
      if (!clean) return raw;
      return `<a class="diexar-keep-url" data-href="${clean}" rel="noopener noreferrer">${clean}</a>${trail}`;
    },
  );

  return withUrls.replace(/L(\d+)/g, (_m, idx: string) => placeholders[Number(idx)]);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

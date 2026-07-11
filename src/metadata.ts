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

import { t } from "./i18n";

/** Localized display label for a note color (looks up `color_<name>`). */
export function colorLabel(name: ColorName): string {
  return t(`color_${name}`);
}

export interface NoteMeta {
  color: ColorName;
  tags: string[];
  pinned: boolean;
  /** ISO 8601 local datetime string ("YYYY-MM-DDTHH:mm") for a reminder, or null. */
  reminder: string | null;
}

export const DEFAULT_META: NoteMeta = {
  color: "default",
  tags: [],
  pinned: false,
  reminder: null,
};

export function isColorName(value: unknown): value is ColorName {
  return typeof value === "string" && (COLOR_NAMES as string[]).includes(value);
}

/**
 * Reads metadata from the Obsidian metadataCache. Works without a custom YAML parser.
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
  // Deliberately NO inline #hashtags included. Otherwise tags from shared
  // social-media posts (#fyp, #trending) pollute the card chips and the
  // vault-wide graph view. User tags come via the capture/edit chip UI
  // and land neatly in frontmatter.

  const pinned = fm.pinned === true || fm.pinned === "true";

  let reminder: string | null = null;
  if (typeof fm.reminder === "string" && fm.reminder.trim().length > 0) {
    // Accept both "YYYY-MM-DDTHH:mm" and full ISO. We store the entered
    // local datetime string verbatim; conversion to epoch happens only
    // in the scheduler.
    reminder = fm.reminder.trim();
  }

  return { color, tags, pinned, reminder };
}

/**
 * Updates metadata in a note via processFrontMatter (read-modify-write safe).
 */
export async function updateMeta(
  app: App,
  file: TFile,
  patch: Partial<NoteMeta>,
): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
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
    if (patch.reminder !== undefined) {
      if (patch.reminder === null || patch.reminder === "") {
        delete fm.reminder;
      } else {
        fm.reminder = patch.reminder;
      }
    }
  });
}

/**
 * Parses a reminder string to epoch-ms. Returns NaN for invalid input.
 * Accepts "YYYY-MM-DDTHH:mm" (local time) and full ISO 8601.
 */
export function parseReminderMs(reminder: string | null): number {
  if (!reminder) return NaN;
  const ms = Date.parse(reminder);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Formats a reminder briefly relative to now. Returns labels in the plugin UI
 * language via `t()`. Deliberately colorless — color-blind friendly:
 * overdue reminders are identified by the "Overdue" label, not by color alone.
 */
export function formatReminderShort(reminder: string | null, now: number = Date.now()): string {
  const ms = parseReminderMs(reminder);
  if (!Number.isFinite(ms)) return "";
  const diff = ms - now;
  const absMin = Math.abs(diff) / 60000;
  const overdue = diff < 0;
  if (absMin < 1) return t(overdue ? "reminder_just_overdue" : "reminder_now");
  if (absMin < 60) {
    const n = Math.round(absMin);
    return t(overdue ? "reminder_min_overdue" : "reminder_in_min", String(n));
  }
  const absHr = absMin / 60;
  if (absHr < 24) {
    const n = Math.round(absHr);
    return t(overdue ? "reminder_hr_overdue" : "reminder_in_hr", String(n));
  }
  const absDay = absHr / 24;
  if (absDay < 30) {
    const n = Math.round(absDay);
    return t(overdue ? "reminder_day_overdue" : "reminder_in_day", String(n));
  }
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Returns all known tags in the vault as a sorted list (for autocomplete).
 */
export function getAllVaultTags(app: App): string[] {
  const raw = (app.metadataCache as unknown as { getTags?: () => Record<string, number> }).getTags?.() ?? {};
  return Object.keys(raw)
    .map((t) => t.replace(/^#/, ""))
    .filter((t) => t.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Returns the body of a note without the frontmatter block.
 */
export function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/**
 * Escapes inline `#hashtag` syntax in free text so Obsidian does NOT index
 * them as tags. `#fyp` → `\#fyp`. In reading view it still renders as `#fyp`,
 * but graph view and tag pane stay clean.
 *
 * Operates outside code fences and inline code. Skips heading markers (`# Title`),
 * wiki-link anchors (`[[Note#Heading]]`) and URL anchors (`example.com#x`)
 * via lookbehind on `[\\\w/]`. Running it non-idempotently is safe: already-escaped
 * `\#` does not match again.
 */
export function neutralizeInlineHashtags(text: string): string {
  const fenceParts = text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  return fenceParts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .split(/(`[^`\n]+`)/g)
        .map((seg, j) => {
          if (j % 2 === 1) return seg;
          return seg.replace(/(?<![\\\w/])#([A-Za-z_/][\w/-]*)/g, "\\#$1");
        })
        .join("");
    })
    .join("");
}

/**
 * Applies `neutralizeInlineHashtags` to only the body of a markdown document.
 * The frontmatter block is left untouched.
 */
export function neutralizeBodyHashtags(content: string): string {
  const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (fmMatch) {
    const fm = fmMatch[0];
    const body = content.slice(fm.length);
    return fm + neutralizeInlineHashtags(body);
  }
  return neutralizeInlineHashtags(content);
}

/**
 * Converts checklist syntax at the start of a line into a shape glyph — shape,
 * not colour, so it stays readable without colour distinction (color-blind
 * friendly). Idempotent: glyph lines no longer match the syntax. Called both
 * when extracting the card preview (before word-truncation, so the syntax
 * neither eats the word budget nor gets cut mid-marker) and when rendering.
 */
export function checklistToGlyphs(text: string): string {
  return text
    .replace(/^- \[ \] /gm, "☐ ")
    .replace(/^- \[[xX]\] /gm, "☑ ");
}

/**
 * Renders a limited inline preview into `parent` as real DOM nodes — never via
 * innerHTML, so user text is inserted as text content and can never inject
 * markup. Handles checklist glyphs, `[[wikilink]]` / `[[link|alias]]` as styled
 * spans, and `[text](url)` plus bare http(s) URLs as clickable `.jotdrop-url`
 * anchors. Clicks are caught by the view via delegation on the data-href attr.
 */
export function renderInlinePreview(parent: HTMLElement, text: string): void {
  const src = checklistToGlyphs(text);

  // Single ordered scan: wikilink | markdown-link | bare-url. Alternation consumes
  // a markdown link whole, so its href is never re-matched as a separate bare URL.
  const tokenRe =
    /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/\S+)/g;

  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(src)) !== null) {
    if (m.index > lastIndex) parent.appendText(src.slice(lastIndex, m.index));

    if (m[1] !== undefined) {
      // [[target]] or [[target|alias]]
      const span = parent.createSpan({
        cls: "jotdrop-wikilink",
        text: (m[2] ?? m[1]).trim(),
      });
      span.dataset.href = m[1].trim();
    } else if (m[3] !== undefined) {
      // [label](https://url)
      const a = parent.createEl("a", {
        cls: "jotdrop-url",
        text: m[3],
        attr: { rel: "noopener noreferrer" },
      });
      a.dataset.href = m[4];
    } else if (m[5] !== undefined) {
      // Bare URL — strip trailing sentence punctuation back into plain text.
      const raw = m[5];
      const trail = raw.match(/[).,;:!?\]"']+$/)?.[0] ?? "";
      const clean = trail ? raw.slice(0, raw.length - trail.length) : raw;
      if (clean) {
        const a = parent.createEl("a", {
          cls: "jotdrop-url",
          text: clean,
          attr: { rel: "noopener noreferrer" },
        });
        a.dataset.href = clean;
        if (trail) parent.appendText(trail);
      } else {
        parent.appendText(raw);
      }
    }

    lastIndex = tokenRe.lastIndex;
  }
  if (lastIndex < src.length) parent.appendText(src.slice(lastIndex));
}

import type { App, TFile } from "obsidian";

/**
 * Showing Excalidraw drawings on a card (read only).
 *
 * Measured 10 Nov 2026 with Excalidraw 2.29.2 (see Hand-off/HANDOFF.md):
 * - A drawing is `name.excalidraw.md` (frontmatter `excalidraw-plugin`) with a
 *   `compressed-json` block, so its text is never worth showing on a card.
 * - The plugin can write `name.excalidraw.png` / `.svg` next to it ("auto export",
 *   off by default). A note that embeds such an export already shows it.
 * - `window.ExcalidrawAutomate.createPNG(path)` renders a drawing that is not
 *   open, but only after the vault has loaded.
 *
 * Order of preference: a fresh export next to the drawing (works without the
 * Excalidraw plugin), then the plugin itself, then an old export, then a plain
 * "Excalidraw drawing" label. Nothing is ever written to the vault.
 */

const DRAWING_NAME_RE = /\.excalidraw(?:\.md)?$/i;
const IMAGE_NAME_RE = /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i;
const EMBED_RE = /!\[\[([^\]\n|]+)(?:\|[^\]\n]+)?\]\]/g;
const STANDARD_EMBED_RE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const PLUGIN_ID = "obsidian-excalidraw-plugin";
/** An export written a moment after the drawing is still the same drawing. */
const EXPORT_SLACK_MS = 2000;
const RETRY_DELAYS_MS = [0, 400, 800, 1200, 1600, 2000];
const NO_PLUGIN_WAIT_MS = 6000;

/** `name.excalidraw` or `name.excalidraw.md`, optionally with a folder and a `#subpath`. */
export function isDrawingLink(link: string): boolean {
  return DRAWING_NAME_RE.test(link.split("#")[0].trim());
}

/** Card title of a drawing file: the file name without `.excalidraw`. */
export function drawingTitle(basename: string): string {
  return basename.replace(/\.excalidraw$/i, "").trim() || basename;
}

/** Export files the plugin writes next to `folder/name.excalidraw.md`, best first. */
export function exportPathsFor(drawingPath: string): string[] {
  const stem = drawingPath.replace(/\.md$/i, "");
  return [`${stem}.png`, `${stem}.svg`];
}

/**
 * The first Excalidraw embed (`![[name.excalidraw]]`) of a note body, but only
 * when it comes before the first ordinary image: that image keeps the card.
 */
export function drawingEmbedBeforeImage(body: string): string | null {
  let drawing: { link: string; index: number } | null = null;
  let imageIndex = Infinity;
  for (const m of body.matchAll(EMBED_RE)) {
    const link = m[1].trim();
    const index = m.index ?? 0;
    if (!drawing && isDrawingLink(link)) drawing = { link: link.split("#")[0].trim(), index };
    else if (IMAGE_NAME_RE.test(link) && index < imageIndex) imageIndex = index;
  }
  for (const m of body.matchAll(STANDARD_EMBED_RE)) {
    const name = (m[1].trim().split("/").pop() ?? "").split("?")[0].split("#")[0];
    if (IMAGE_NAME_RE.test(name) && (m.index ?? 0) < imageIndex) imageIndex = m.index ?? 0;
  }
  return drawing && drawing.index < imageIndex ? drawing.link : null;
}

interface AutomateLike {
  createPNG: (path: string, scale?: number) => Promise<unknown>;
  reset?: () => void;
  getAPI?: () => AutomateLike;
}

interface Rendered {
  mtime: number;
  url: string | null;
  at: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

export class ExcalidrawPreviews {
  private readonly rendered = new Map<string, Rendered>();
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly app: App) {}

  isDrawingFile(file: TFile): boolean {
    if (DRAWING_NAME_RE.test(file.name)) return true;
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    return frontmatter?.["excalidraw-plugin"] !== undefined;
  }

  /** The drawing a link such as `Sketch.excalidraw` points to, seen from `from`. */
  resolveDrawing(link: string, from: TFile): TFile | null {
    const clean = link.split("#")[0].trim();
    const dest = this.app.metadataCache.getFirstLinkpathDest(clean, from.path)
      ?? this.app.metadataCache.getFirstLinkpathDest(clean.replace(/\.md$/i, ""), from.path);
    return dest && this.isDrawingFile(dest) ? dest : null;
  }

  /** An export next to the drawing, and whether it is at least as new as the drawing. */
  findExport(drawing: TFile): { file: TFile; fresh: boolean } | null {
    for (const path of exportPathsFor(drawing.path)) {
      const file = this.app.vault.getFileByPath(path);
      if (file) return { file, fresh: file.stat.mtime >= drawing.stat.mtime - EXPORT_SLACK_MS };
    }
    return null;
  }

  /** Whether a picture of this drawing can be had: an export next to it, or the Excalidraw plugin to draw it. */
  canPicture(drawing: TFile): boolean {
    return this.findExport(drawing) !== null || this.pluginEnabled();
  }

  resourcePath(file: TFile): string {
    return this.app.vault.getResourcePath(file);
  }

  /** A picture made by the Excalidraw plugin, or null when it is not there or fails. Cached per file version. */
  render(drawing: TFile): Promise<string | null> {
    const hit = this.rendered.get(drawing.path);
    if (hit && hit.mtime === drawing.stat.mtime && (hit.url || Date.now() - hit.at < 30000)) return Promise.resolve(hit.url);
    const job = this.queue.then(() => this.renderNow(drawing));
    this.queue = job.catch(() => null);
    return job;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.rendered.values()) if (entry.url) URL.revokeObjectURL(entry.url);
    this.rendered.clear();
  }

  private async renderNow(drawing: TFile): Promise<string | null> {
    let url: string | null = null;
    try {
      const automate = await this.waitForAutomate();
      if (automate) url = await this.createPng(automate, drawing);
    } catch {
      url = null;
    }
    if (this.disposed) {
      if (url) URL.revokeObjectURL(url);
      return null;
    }
    const old = this.rendered.get(drawing.path);
    if (old?.url) URL.revokeObjectURL(old.url);
    this.rendered.set(drawing.path, { mtime: drawing.stat.mtime, url, at: Date.now() });
    return url;
  }

  private pluginEnabled(): boolean {
    const plugins = (this.app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins;
    return Boolean(plugins?.enabledPlugins?.has(PLUGIN_ID));
  }

  private automate(): AutomateLike | null {
    const shared = (window as unknown as { ExcalidrawAutomate?: AutomateLike }).ExcalidrawAutomate;
    if (!shared || typeof shared.createPNG !== "function") return null;
    // Own instance when the plugin offers one, so a user's script state is never reset.
    try {
      const own = shared.getAPI?.();
      if (own && typeof own.createPNG === "function") return own;
    } catch {
      /* fall back to the shared object */
    }
    return shared;
  }

  private async waitForAutomate(): Promise<AutomateLike | null> {
    const start = Date.now();
    for (;;) {
      const found = this.automate();
      if (found) return found;
      if (!this.pluginEnabled() || this.disposed || Date.now() - start > NO_PLUGIN_WAIT_MS) return null;
      await sleep(250);
    }
  }

  private async createPng(automate: AutomateLike, drawing: TFile): Promise<string | null> {
    // Right after start the object exists but the plugin has not finished loading: try again a few times.
    for (const delay of RETRY_DELAYS_MS) {
      if (delay) await sleep(delay);
      if (this.disposed) return null;
      try {
        automate.reset?.();
        const blob = await automate.createPNG(drawing.path, 1);
        if (blob instanceof Blob && blob.size > 0) return URL.createObjectURL(blob);
      } catch {
        /* not ready yet, or this drawing cannot be drawn */
      }
    }
    return null;
  }
}

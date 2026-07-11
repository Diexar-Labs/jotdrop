import { Notice } from "obsidian";
import type JotDropPlugin from "./main";
import { createNoteInFolder } from "./capture";
import { fetchOg, safeMarkdownLink } from "./ogfetch";
import { neutralizeBodyHashtags, updateMeta, ColorName, isColorName } from "./metadata";
import { t } from "./i18n";

// Node's http module via Electron's CommonJS bridge (desktop-only clip server).
// 'http' is not part of Obsidian's plugin TS types, so type just the bit we use.
// We do NOT disable import/no-nodejs-modules: the review bot forbids disabling it,
// and it stays a harmless warning — a loopback server genuinely needs Node's http.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- loopback clip server needs Node's http; Obsidian exposes no typed equivalent
const http = require("http") as {
  createServer(handler: (req: IncomingMessageLike, res: ServerResponseLike) => void): ServerLike;
};

interface IncomingMessageLike {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "end", listener: () => void): void;
}

interface ServerResponseLike {
  setHeader(name: string, value: string): void;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

interface ServerLike {
  listen(port: number, host: string, cb: () => void): void;
  close(cb?: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface ClipBody {
  url?: string;
  title?: string;
  selection?: string;
  tags?: unknown;
  color?: string;
  pinned?: boolean;
}

/**
 * Loopback-only HTTP server (127.0.0.1) used by the Chrome extension to drop
 * a page as a note into the vault. Authenticates via Bearer token from
 * settings; rejects everything that is not POST /clip.
 */
export class ClipServer {
  private plugin: JotDropPlugin;
  private server: ServerLike | null = null;
  private boundPort = 0;

  constructor(plugin: JotDropPlugin) {
    this.plugin = plugin;
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  start(): void {
    if (this.server) return;
    const port = this.plugin.settings.clipServerPort;
    const srv: ServerLike = http.createServer(
      (req: IncomingMessageLike, res: ServerResponseLike) => this.handle(req, res),
    );
    srv.on("error", (err: Error) => {
      new Notice(t("notice_clip_server_error", err.message));
      this.server = null;
    });
    srv.listen(port, "127.0.0.1", () => {
      new Notice(t("notice_clip_server_started", String(port)));
    });
    this.server = srv;
    this.boundPort = port;
  }

  stop(): void {
    if (!this.server) return;
    this.server.close();
    this.server = null;
    new Notice(t("notice_clip_server_stopped"));
  }

  /** Restarts when port or token changes. */
  restart(): void {
    this.stop();
    this.start();
  }

  needsRestart(): boolean {
    return this.server !== null && this.boundPort !== this.plugin.settings.clipServerPort;
  }

  private handle(req: IncomingMessageLike, res: ServerResponseLike): void {
    // DNS-rebinding guard: a hostile page pointing its own domain at 127.0.0.1
    // reaches this server with its domain in the Host header. We only ever
    // serve loopback hosts, so anything else is rejected outright.
    const host = headerValue(req.headers["host"]).split(":")[0].toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
      res.writeHead(403);
      res.end();
      return;
    }

    // CORS — only browser extensions (chrome- and moz-extension:) get ACAO;
    // other origins (including "null" from sandboxed iframes) get nothing so
    // a random tab cannot probe our port.
    const origin = headerValue(req.headers["origin"]);
    const isExtension =
      origin.startsWith("chrome-extension://") ||
      origin.startsWith("moz-extension://");
    if (isExtension) {
      res.setHeader("Access-Control-Allow-Origin", origin || "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Max-Age", "600");
    }

    if (req.method === "OPTIONS") {
      res.writeHead(isExtension ? 204 : 403);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/ping") {
      // Health-check for the extension to detect whether the plugin is running.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, app: "jotdrop" }));
      return;
    }

    if (req.method !== "POST" || req.url !== "/clip") {
      res.writeHead(404);
      res.end();
      return;
    }

    const token = this.plugin.settings.clipServerToken;
    const auth = headerValue(req.headers["authorization"]).replace(/^Bearer\s+/i, "");
    if (!token || !timingSafeEqual(auth, token)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      void this.processBody(chunks, res);
    });
  }

  private async processBody(chunks: Buffer[], res: ServerResponseLike): Promise<void> {
    try {
      const raw = Buffer.concat(chunks).toString("utf-8");
      const body = JSON.parse(raw) as ClipBody;
      const result = await this.clip(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  }

  private async clip(body: ClipBody): Promise<{ ok: true; path: string }> {
    const url = sanitizeUrl(body.url);
    if (!url) throw new Error("missing url");
    const title = sanitizeText(body.title) || url;
    const selection = sanitizeText(body.selection);
    const tags = sanitizeTags(body.tags);
    const color: ColorName = isColorName(body.color) ? body.color : "default";
    const pinned = body.pinned === true;

    let content = `# ${title}\n\n`;
    if (selection) content += `> ${selection.replace(/\n/g, "\n> ")}\n\n`;
    content += safeMarkdownLink(title, url);

    const attachmentsFolder = `${this.plugin.settings.notesFolder}/.attachments`;
    try {
      const preview = await withTimeout(
        fetchOg(this.plugin.app, attachmentsFolder, url, this.plugin.settings.downloadImages),
        10_000,
      );
      if (preview) {
        // We built manual content; buildLinkNote only replaces it for
        // "URL-only" input. Here we merge the image embed manually.
        if (preview.imageBasename) {
          content = `![[${preview.imageBasename}]]\n\n${content}`;
        }
      }
    } catch (e) {
      console.error("JotDrop clip: OG-fetch failed:", e);
    }

    const safe = neutralizeBodyHashtags(content);
    const file = await createNoteInFolder(
      this.plugin.app,
      this.plugin.settings.notesFolder,
      safe,
    );

    if (color !== "default" || tags.length > 0 || pinned) {
      await updateMeta(this.plugin.app, file, { color, tags, pinned });
    }

    new Notice(t("notice_clip_saved", file.basename));
    this.plugin.refreshViews();

    return { ok: true, path: file.path };
  }
}

function headerValue(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] || "";
  return v || "";
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function sanitizeUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

function sanitizeText(v: unknown): string {
  if (typeof v !== "string") return "";
  // Truncate extremely long selections so an accidental select-all does not
  // pump 5 MB of text into the note. 8 KB is more than enough for a quote.
  return v.replace(/\r/g, "").trim().slice(0, 8000);
}

function sanitizeTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== "string") continue;
    const clean = item.replace(/^#/, "").trim();
    if (!clean || /\s/.test(clean)) continue;
    if (seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
    if (out.length >= 16) break;
  }
  return out;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return await Promise.race([
    promise,
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), ms)),
  ]);
}

// No re-export needed — clip server imports directly from other modules.

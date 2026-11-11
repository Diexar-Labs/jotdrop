import { TFile, setIcon } from "obsidian";
import type JotDropPlugin from "./main";
import { t } from "./i18n";
import kinds from "../cloud/shared/filekinds.json";

/** What a file is, from the one list every JotDrop app uses (cloud/shared/filekinds.json). */
export type FileKind = "image" | "audio" | "video" | "pdf" | "file";

const extensionOf = (name: string): string => /\.([^./\\]+)$/.exec(name)?.[1].toLowerCase() ?? "";

export function fileKind(name: string): FileKind {
  const extension = extensionOf(name);
  for (const kind of ["image", "audio", "video", "pdf"] as const) {
    if (Object.prototype.hasOwnProperty.call(kinds[kind], extension)) return kind;
  }
  return "file";
}

/** An embed of a file, not of another note or an Excalidraw drawing. */
export function isFileEmbed(name: string): boolean {
  const extension = extensionOf(name);
  return extension !== "" && extension !== "md" && extension !== "excalidraw";
}

// Mirrors Storage.findEmbeddedImageBasenames / findEmbeddedAudioBasenames in
// the Android app. Covers both Obsidian-style `![[name.ext]]` and standard
// `![](path/name.ext)`; `accept` filters on the file name.
const EMBED_OBSIDIAN_RE = /!\[\[([^\]\n|]+)(?:\|[^\]\n]+)?\]\]/g;
const EMBED_STANDARD_RE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export function collectEmbedBasenames(content: string, accept: (name: string) => boolean): string[] {
  const result = new Set<string>();
  for (const m of content.matchAll(EMBED_OBSIDIAN_RE)) {
    // `![[report.pdf#page=3]]` is still report.pdf.
    const name = (m[1].trim().split("/").pop() ?? "").split("#")[0].trim();
    if (name && accept(name)) result.add(name);
  }
  for (const m of content.matchAll(EMBED_STANDARD_RE)) {
    const path = m[1].trim();
    const name = (path.split("/").pop() ?? "").split("?")[0].split("#")[0];
    if (name && accept(name)) result.add(name);
  }
  return Array.from(result);
}

/** Like the web app's file chips. */
export function formatFileSize(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MiB` : `${Math.max(1, Math.ceil(bytes / 1024))} KiB`;
}

export const FILE_KIND_ICON: Record<FileKind, string> = {
  image: "image", audio: "audio-lines", video: "file-video", pdf: "file-text", file: "file",
};

/**
 * The original name, safe for a vault path and an `![[embed]]`: no folders, no characters that end a
 * wiki link, and no leading dot (the cloud leaves hidden files alone).
 */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*[\]#^]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+/, "")
    .replace(/[\s.]+$/, "");
  const dot = cleaned.lastIndexOf(".");
  const stem = (dot > 0 ? cleaned.slice(0, dot) : cleaned).slice(0, 100).trim();
  const extension = dot > 0 ? cleaned.slice(dot) : "";
  return `${stem || "file"}${extension}`;
}

/** `name.ext`, or `name (2).ext`, `name (3).ext`… when that name is taken: an attachment never overwrites another. */
export async function uniqueFileName(name: string, taken: (candidate: string) => Promise<boolean>): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let n = 2; await taken(candidate); n++) candidate = `${stem} (${n})${extension}`;
  return candidate;
}

/** The size of the file `![[name]]` points at for [note], or null when it is not on this device (yet). */
async function attachmentSize(plugin: JotDropPlugin, note: TFile, name: string): Promise<number | null> {
  for (const c of plugin.resolveAssetCandidates(note, name)) {
    if (c.file?.extension === "md") continue;
    const stat = c.file ? c.file.stat : await plugin.app.vault.adapter.stat(c.vaultPath).catch(() => null);
    if (stat && "size" in stat && (!("type" in stat) || stat.type === "file")) return stat.size;
  }
  return null;
}

/**
 * One attached file as a chip: kind icon, name and size, like the website. A click opens it (or calls [open]);
 * with [remove] a cross takes it off the note. Not a file (a note, a drawing) shows its name without a size.
 */
export function renderFileChip(plugin: JotDropPlugin, parent: HTMLElement, note: TFile, name: string, options: { open?: () => void; remove?: () => void } = {}): HTMLElement {
  const chip = parent.createDiv({ cls: "jotdrop-file-chip" });
  const button = chip.createEl("button", { cls: "jotdrop-file-chip-open", attr: { "aria-label": t("attach_open", name), title: name } });
  setIcon(button.createSpan({ cls: "jotdrop-file-chip-icon" }), isFileEmbed(name) ? FILE_KIND_ICON[fileKind(name)] : "link");
  button.createSpan({ cls: "jotdrop-file-chip-name", text: name });
  if (isFileEmbed(name)) {
    void attachmentSize(plugin, note, name).then((bytes) => {
      if (bytes === null) return;
      const size = formatFileSize(bytes);
      button.createSpan({ cls: "jotdrop-file-chip-size", text: size });
      button.setAttr("aria-label", `${t("attach_open", name)}, ${size}`);
    });
  }
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (options.open) options.open();
    else void plugin.openAttachment(note, name);
  });
  if (options.remove) {
    const remove = options.remove;
    const cross = chip.createEl("button", { cls: "jotdrop-file-chip-remove", text: "×", attr: { "aria-label": t("attach_remove", name), title: t("attach_remove", name) } });
    cross.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); remove(); });
  }
  return chip;
}

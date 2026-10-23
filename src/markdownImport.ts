import { ImportFiles, importFileName } from "./keepImport";

/**
 * Markdown exports from other apps: Apple Notes (macOS Tahoe / iOS 26 "Export as
 * Markdown", images in an `Attachments` folder), Bear, Joplin, Notion and more.
 * The text is kept as written; only links to exported files become vault embeds.
 */
export interface MarkdownNote {
  source: string;
  /** File name without extension: Apple Notes names files after the note title. */
  title: string;
  text: string;
  createdMs: number;
  editedMs: number;
  /** Export paths of the linked files that were found. */
  attachments: string[];
  missingAttachments: number;
}

const decoder = new TextDecoder();
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
/** `[label](target "title")` or `![alt](<target with spaces>)`. */
const LINK = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g;
const isNote = (path: string) => /\.(md|markdown)$/i.test(path);
// macOS zips carry resource forks and Finder files.
const isJunk = (path: string) => /(^|\/)(__MACOSX\/|\._|\.DS_Store$)/.test(path);

/** Resolves a relative link target to an exported file: next to the note first, then by name. */
function resolveTarget(files: ImportFiles, byName: Map<string, string>, notePath: string, rawTarget: string): string | undefined | null {
  let target = rawTarget.replace(/^<|>$/g, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("/")) return null;
  try { target = decodeURIComponent(target); } catch { /* keep the literal target */ }
  target = target.split("#")[0];
  if (!target || isNote(target) || !/\.[^./]+$/.test(target)) return null;
  const parts = notePath.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part) parts.push(part);
  }
  const path = parts.join("/");
  if (files.has(path) && !isNote(path)) return path;
  return byName.get(basename(target));
}

export async function parseMarkdownExport(files: ImportFiles, now = Date.now()): Promise<{ notes: MarkdownNote[]; failed: string[]; error?: string }> {
  const notes: MarkdownNote[] = [];
  const failed: string[] = [];
  let error: string | undefined;
  const byName = new Map<string, string>();
  for (const path of files.keys()) if (!isNote(path) && !isJunk(path) && !byName.has(basename(path))) byName.set(basename(path), path);
  for (const source of [...files.keys()].filter((path) => isNote(path) && !isJunk(path)).sort()) {
    const load = files.get(source)!;
    let text: string;
    try {
      text = decoder.decode(await load()).replace(/\r\n?/g, "\n");
    } catch (err) {
      failed.push(source);
      error ??= err instanceof Error ? err.message : String(err);
      continue;
    }
    if (!text.trim()) continue;
    const attachments: string[] = [];
    let missingAttachments = 0;
    for (const match of text.matchAll(LINK)) {
      const found = resolveTarget(files, byName, source, match[3]);
      if (found === null) continue;
      if (found === undefined) missingAttachments += 1;
      else if (!attachments.includes(found)) attachments.push(found);
    }
    const modified = load.modified && load.modified > 0 ? load.modified : now;
    notes.push({
      source,
      title: basename(source).replace(/\.(md|markdown)$/i, ""),
      text: text.endsWith("\n") ? text : `${text}\n`,
      createdMs: modified,
      editedMs: modified,
      attachments,
      missingAttachments,
    });
  }
  return { notes, failed, error };
}

export function markdownNoteFileName(note: MarkdownNote): string {
  return importFileName(note.createdMs, note.title || note.text.split("\n").find((line) => line.trim()) || "Note");
}

/** The note text with links to imported files turned into embeds; `names` maps export paths to vault file names. */
export function markdownNoteMarkdown(note: MarkdownNote, names: Map<string, string>): string {
  const files: ImportFiles = new Map(note.attachments.map((path) => [path, () => Promise.resolve(new Uint8Array())]));
  const byName = new Map(note.attachments.map((path) => [basename(path), path]));
  return note.text.replace(LINK, (link: string, bang: string, label: string, target: string) => {
    const found = resolveTarget(files, byName, note.source, target);
    const name = found ? names.get(found) : undefined;
    if (!name) return link;
    if (bang) return `![[${name}]]`;
    const text = label.replace(/[[\]|]/g, "").trim();
    return text && text !== name ? `[[${name}|${text}]]` : `[[${name}]]`;
  });
}

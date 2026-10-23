import { ColorName, isColorName, neutralizeInlineHashtags, readLabels } from "./metadata";
import { safeMarkdownLink } from "./ogfetch";

/** Lazy loader for one file, with its modification time (epoch ms) when known. */
export type ImportLoader = (() => Promise<Uint8Array>) & { modified?: number };

/** Zip entry path → lazy loader, so a large Takeout is only read where needed. */
export type ImportFiles = Map<string, ImportLoader>;

export interface KeepNote {
  /** Path of the Keep JSON file inside the export. */
  source: string;
  title: string;
  text: string;
  items: { text: string; checked: boolean }[];
  labels: string[];
  color: ColorName;
  pinned: boolean;
  archived: boolean;
  createdMs: number;
  editedMs: number;
  /** Export paths of the attachments that were found. */
  attachments: string[];
  missingAttachments: number;
  links: { url: string; title: string }[];
}

const decoder = new TextDecoder();
const damaged = () => new Error("This zip archive is damaged or incomplete.");

/**
 * Reads the central directory of a zip (including ZIP64) and returns lazy entry
 * loaders. Only stored and deflated entries are supported, which covers Takeout.
 */
export async function readZip(blob: Blob): Promise<ImportFiles> {
  const bytes = async (start: number, end: number) => new Uint8Array(await blob.slice(start, end).arrayBuffer());
  const tail = await bytes(Math.max(0, blob.size - 22 - 0xffff - 20), blob.size);
  const tv = new DataView(tail.buffer);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("This file is not a zip archive.");
  let count = tv.getUint16(end + 10, true);
  let size = tv.getUint32(end + 12, true);
  let offset = tv.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    const locator = end - 20;
    if (locator < 0 || tv.getUint32(locator, true) !== 0x07064b50) throw damaged();
    const at = Number(tv.getBigUint64(locator + 8, true));
    const record = new DataView((await bytes(at, at + 56)).buffer);
    if (record.byteLength < 56 || record.getUint32(0, true) !== 0x06064b50) throw damaged();
    count = Number(record.getBigUint64(32, true));
    size = Number(record.getBigUint64(40, true));
    offset = Number(record.getBigUint64(48, true));
  }
  const directory = await bytes(offset, offset + size);
  const dv = new DataView(directory.buffer);
  const files: ImportFiles = new Map();
  let at = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > directory.length || dv.getUint32(at, true) !== 0x02014b50) throw damaged();
    const method = dv.getUint16(at + 10, true);
    let compressed = dv.getUint32(at + 20, true);
    const uncompressed = dv.getUint32(at + 24, true);
    let local = dv.getUint32(at + 42, true);
    const nameLength = dv.getUint16(at + 28, true);
    const extraEnd = at + 46 + nameLength + dv.getUint16(at + 30, true);
    // Windows PowerShell's Compress-Archive writes backslash separators.
    const name = decoder.decode(directory.subarray(at + 46, at + 46 + nameLength)).replace(/\\/g, "/");
    // DOS date and time are local; zero fields mean "not set".
    const dosTime = dv.getUint16(at + 12, true), dosDate = dv.getUint16(at + 14, true);
    let modified = (dosDate >> 5 & 15) && (dosDate & 31)
      ? new Date(1980 + (dosDate >> 9), (dosDate >> 5 & 15) - 1, dosDate & 31, dosTime >> 11, dosTime >> 5 & 63, (dosTime & 31) * 2).getTime()
      : undefined;
    for (let e = at + 46 + nameLength; e + 4 <= extraEnd; e += 4 + dv.getUint16(e + 2, true)) {
      const id = dv.getUint16(e, true);
      // Info-ZIP extended timestamp (macOS and Linux zips): UTC seconds, more precise than DOS time.
      if (id === 0x5455 && dv.getUint16(e + 2, true) >= 5 && dv.getUint8(e + 4) & 1) modified = dv.getUint32(e + 5, true) * 1000;
      if (id !== 1) continue;
      // ZIP64 extra field: only the values that overflowed are present, in this order.
      let p = e + 4;
      if (uncompressed === 0xffffffff) p += 8;
      if (compressed === 0xffffffff) { compressed = Number(dv.getBigUint64(p, true)); p += 8; }
      if (local === 0xffffffff) local = Number(dv.getBigUint64(p, true));
    }
    at = extraEnd + dv.getUint16(at + 32, true);
    if (name.endsWith("/")) continue;
    files.set(name, Object.assign(async () => {
      const header = new DataView((await bytes(local, local + 30)).buffer);
      if (header.byteLength < 30 || header.getUint32(0, true) !== 0x04034b50) throw damaged();
      const start = local + 30 + header.getUint16(26, true) + header.getUint16(28, true);
      const data = blob.slice(start, start + compressed);
      if (method === 0) return new Uint8Array(await data.arrayBuffer());
      if (method !== 8) throw new Error(`"${name}" uses an unsupported zip compression.`);
      return new Uint8Array(await new Response(data.stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    }, { modified }));
  }
  return files;
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const stem = (name: string) => name.replace(/\.[^.]*$/, "").toLowerCase();

interface AttachmentIndex { byName: Map<string, string>; byStem: Map<string, string> }

function attachmentIndex(files: ImportFiles): AttachmentIndex {
  const index: AttachmentIndex = { byName: new Map(), byStem: new Map() };
  for (const path of files.keys()) {
    if (/\.(json|html)$/i.test(path)) continue;
    if (!index.byName.has(basename(path))) index.byName.set(basename(path), path);
    if (!index.byStem.has(stem(basename(path)))) index.byStem.set(stem(basename(path)), path);
  }
  return index;
}

/** Finds an attachment next to the note, by name anywhere, or by name with another extension (Takeout writes .jpeg references for .jpg files). */
function findAttachment(files: ImportFiles, index: AttachmentIndex, notePath: string, filePath: string): string | undefined {
  const folder = notePath.slice(0, notePath.lastIndexOf("/") + 1);
  if (files.has(folder + filePath)) return folder + filePath;
  const name = basename(filePath);
  return index.byName.get(name) ?? index.byStem.get(stem(name));
}

/** Keep stores microseconds, as a number or a string; zero or missing means unknown. */
function usecToMs(value: unknown): number | undefined {
  const ms = Math.floor(Number(value) / 1000);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

function keepColor(value: unknown): ColorName {
  const color = typeof value === "string" ? value.toLowerCase() : "";
  if (color === "cerulean") return "blue";
  return isColorName(color) ? color : "default";
}

/**
 * Converts every Keep note in an export. Trashed notes are skipped and counted;
 * unreadable files are reported, with the first error message.
 */
export async function parseKeepExport(files: ImportFiles): Promise<{ notes: KeepNote[]; trashed: number; failed: string[]; error?: string }> {
  const notes: KeepNote[] = [];
  const failed: string[] = [];
  let trashed = 0;
  let error: string | undefined;
  const index = attachmentIndex(files);
  // Loose files, or the Keep folder of a Takeout: never load huge JSON from other products.
  const sources = [...files.keys()].filter((path) => /\.json$/i.test(path) && (!path.includes("/") || /(^|\/)Keep\//.test(path)));
  for (const source of sources.sort()) {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(decoder.decode(await files.get(source)!())) as Record<string, unknown>;
    } catch (err) {
      failed.push(source);
      error ??= err instanceof Error ? err.message : String(err);
      continue;
    }
    if (!json || typeof json !== "object" || typeof json.isTrashed !== "boolean" || json.userEditedTimestampUsec === undefined) continue;
    if (json.isTrashed) { trashed += 1; continue; }
    const created = usecToMs(json.createdTimestampUsec), edited = usecToMs(json.userEditedTimestampUsec);
    const createdMs = created ?? edited, editedMs = edited ?? created;
    if (createdMs === undefined || editedMs === undefined) { failed.push(source); continue; }
    const list = Array.isArray(json.listContent) ? json.listContent as { text?: unknown; isChecked?: unknown }[] : [];
    const attachments: string[] = [];
    let missingAttachments = 0;
    for (const attachment of Array.isArray(json.attachments) ? json.attachments as { filePath?: unknown }[] : []) {
      const found = typeof attachment.filePath === "string" ? findAttachment(files, index, source, attachment.filePath) : undefined;
      if (found) attachments.push(found);
      else missingAttachments += 1;
    }
    const text = typeof json.textContent === "string" ? json.textContent.replace(/\r\n?/g, "\n").trim() : "";
    const links = (Array.isArray(json.annotations) ? json.annotations as { url?: unknown; title?: unknown }[] : [])
      .filter((link) => typeof link.url === "string" && /^https?:\/\//i.test(link.url) && !text.includes(link.url))
      .map((link) => ({ url: link.url as string, title: typeof link.title === "string" ? link.title : "" }));
    notes.push({
      source,
      title: typeof json.title === "string" ? json.title.replace(/\s+/g, " ").trim() : "",
      text,
      items: list.filter((item) => typeof item.text === "string" && item.text.trim())
        .map((item) => ({ text: (item.text as string).replace(/\s+/g, " ").trim(), checked: item.isChecked === true })),
      labels: readLabels((Array.isArray(json.labels) ? json.labels as { name?: unknown }[] : []).map((label) => label.name)),
      color: keepColor(json.color),
      pinned: json.isPinned === true,
      archived: json.isArchived === true,
      createdMs,
      editedMs,
      attachments,
      missingAttachments,
      links,
    });
  }
  return { notes, trashed, failed, error };
}

/** `<created stamp> <title>.md`, the same convention as quick capture, so the grid keeps Keep's creation order. */
export function keepNoteFileName(note: KeepNote): string {
  return importFileName(note.createdMs, note.title || note.text.split("\n").find((line) => line.trim()) || note.items[0]?.text || "Keep note");
}

/** `<local stamp> <safe words>.md` for any imported note. */
export function importFileName(createdMs: number, words: string): string {
  const date = new Date(createdMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  // Code points, not UTF-16 units, so an emoji is never cut in half.
  const name = Array.from(words.replace(/\p{Cc}|[\\/:*?"<>|#^[\]]/gu, " ").replace(/\s+/g, " ").trim())
    .slice(0, 60).join("").replace(/[\s.]+$/, "");
  return `${stamp} ${name || "Note"}.md`;
}

/** JotDrop Markdown for a Keep note; `attachmentName` maps an export path to its final vault file name. */
export function keepNoteMarkdown(note: KeepNote, attachmentName: (source: string) => string): string {
  const frontmatter = [
    note.color !== "default" ? `color: ${note.color}` : "",
    note.pinned ? "pinned: true" : "",
    note.labels.length ? `jotdrop_labels: ${JSON.stringify(note.labels)}` : "",
  ];
  // Keep has labels, not tags: typed hashtags stay text, as with shared content.
  const blocks = [
    note.title ? `# ${neutralizeInlineHashtags(note.title)}` : "",
    neutralizeInlineHashtags(note.text),
    note.items.map((item) => `- [${item.checked ? "x" : " "}] ${neutralizeInlineHashtags(item.text)}`).join("\n"),
    note.attachments.map((source) => `![[${attachmentName(source)}]]`).join("\n\n"),
    note.links.map((link) => safeMarkdownLink(link.title || link.url, link.url)).join("\n"),
  ].filter(Boolean);
  return withFrontmatter(frontmatter, blocks.join("\n\n") + "\n");
}

/** The body with the non-empty frontmatter lines on top. */
export function withFrontmatter(lines: string[], body: string): string {
  const frontmatter = lines.filter(Boolean);
  if (frontmatter.length) return `---\n${frontmatter.join("\n")}\n---\n${body}`;
  // Text that starts with a `---` line would otherwise be read as frontmatter.
  return /^---[ \t]*(\n|$)/.test(body) ? `\n${body}` : body;
}

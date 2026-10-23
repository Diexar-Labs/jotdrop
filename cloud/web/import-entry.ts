// Source of cloud/web/import.mjs (`npm run build:cloud-import`): the plugin's importers for the browser.
import { ImportFiles, keepNoteFileName, keepNoteMarkdown, parseKeepExport, readZip } from "../../src/keepImport";
import { markdownNoteFileName, markdownNoteMarkdown, parseMarkdownExport } from "../../src/markdownImport";
import { evernoteNoteFileName, evernoteNoteMarkdown, parseEnexExport } from "../../src/evernoteImport";

/** One note ready to write; `render` gets the final file names of the attachments that were written. */
export interface ImportItem {
  name: string;
  archived: boolean;
  editedMs: number;
  attachments: string[];
  render: (names: Map<string, string>) => string;
}

export interface ImportResult {
  kind: "keep" | "evernote" | "markdown";
  files: ImportFiles;
  items: ImportItem[];
  missing: number;
  skipped: number;
  failed: number;
  error?: string;
}

/** Reads picked files (zips unpacked) and converts them with the importer that fits: Evernote, Google Keep or Markdown. */
export async function readImport(picked: File[]): Promise<ImportResult> {
  const files: ImportFiles = new Map();
  for (const file of picked) {
    if (/\.zip$/i.test(file.name)) for (const [path, load] of await readZip(file)) files.set(path, load);
    else files.set(file.webkitRelativePath || file.name, Object.assign(async () => new Uint8Array(await file.arrayBuffer()), { modified: file.lastModified }));
  }
  const paths = [...files.keys()];
  const missingOf = (notes: { missingAttachments: number }[]) => notes.reduce((sum, note) => sum + note.missingAttachments, 0);
  if (paths.some((path) => /\.enex$/i.test(path))) {
    const { notes, failed, error } = await parseEnexExport(files);
    return { kind: "evernote", files, missing: missingOf(notes), skipped: 0, failed: failed.length, error,
      items: notes.map((note) => ({ name: evernoteNoteFileName(note), archived: false, editedMs: note.editedMs, attachments: note.attachments,
        render: (names) => evernoteNoteMarkdown(note, names) })) };
  }
  if (paths.some((path) => /\.json$/i.test(path) && (!path.includes("/") || /(^|\/)Keep\//.test(path)))) {
    const { notes, trashed, failed, error } = await parseKeepExport(files);
    return { kind: "keep", files, missing: missingOf(notes), skipped: trashed, failed: failed.length, error,
      items: notes.map((note) => ({ name: keepNoteFileName(note), archived: note.archived, editedMs: note.editedMs, attachments: note.attachments,
        render: (names) => keepNoteMarkdown({ ...note, attachments: note.attachments.filter((source) => names.has(source)) }, (source) => names.get(source)!) })) };
  }
  const { notes, failed, error } = await parseMarkdownExport(files);
  return { kind: "markdown", files, missing: missingOf(notes), skipped: 0, failed: failed.length, error,
    items: notes.map((note) => ({ name: markdownNoteFileName(note), archived: false, editedMs: note.editedMs, attachments: note.attachments,
      render: (names) => markdownNoteMarkdown(note, names) })) };
}

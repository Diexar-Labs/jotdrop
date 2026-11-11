import { FileSystemAdapter, Notice, Platform, Plugin, TFile, WorkspaceLeaf, addIcon, normalizePath } from "obsidian";
import { LOGO_ICON, LOGO_ICON_SVG } from "./logo";
import { DEFAULT_SETTINGS, JotDropSettings, JotDropSettingTab } from "./settings";
import { JotDropView, VIEW_TYPE_JOTDROP } from "./view";
import { QuickCaptureModal, createNoteInFolder } from "./capture";
import { PreviewRescue } from "./previewRescue";
import { ReminderScheduler } from "./reminderScheduler";
import { ClipServer } from "./clipServer";
import { CloudController } from "./cloud";
import { identifyClient } from "../cloud/shared/client.mjs";
import { MAX_CHUNKED_BYTES } from "../cloud/shared/crypto.mjs";
import { fetchOg, safeMarkdownLink } from "./ogfetch";
import { legacyAssetsPath } from "./attachments";
import { cleanFileName, collectEmbedBasenames, isFileEmbed, uniqueFileName } from "./fileKinds";
import { ExcalidrawPreviews } from "./excalidraw";
import { AiSettingsStore } from "./ai";
import { ConfirmModal } from "./confirmModal";
import { ImportFiles, keepNoteFileName, keepNoteMarkdown, parseKeepExport, readZip } from "./keepImport";
import { markdownNoteFileName, markdownNoteMarkdown, parseMarkdownExport } from "./markdownImport";
import { evernoteNoteFileName, evernoteNoteMarkdown, parseEnexExport } from "./evernoteImport";

/** One note ready to write; `render` gets the vault names of the attachments that were written. */
interface ImportItem {
  source: string;
  name: string;
  archived: boolean;
  createdMs: number;
  editedMs: number;
  attachments: string[];
  render: (names: Map<string, string>) => string;
}
import {
  ColorName,
  isColorName,
  neutralizeBodyHashtags,
  updateMeta,
} from "./metadata";
import { t } from "./i18n";

export default class JotDropPlugin extends Plugin {
  settings!: JotDropSettings;
  private refreshTimer: number | null = null;
  // Paths whose next modify-event should be ignored: used during in-place
  // updates (e.g. color change) so the grid does not re-sort due to mtime bump.
  private readonly suppressedPaths: Set<string> = new Set();
  private reminderScheduler!: ReminderScheduler;
  private clipServer!: ClipServer;
  cloud!: CloudController;
  excalidraw!: ExcalidrawPreviews;
  /** Ask JotDrop's settings and key, on this device only (never in data.json). */
  aiStore!: AiSettingsStore;

  async onload(): Promise<void> {
    await this.loadSettings();
    identifyClient("obsidian", this.manifest.version);
    this.cloud = new CloudController(this);
    this.cloud.register();
    this.excalidraw = new ExcalidrawPreviews(this.app);
    this.aiStore = new AiSettingsStore(this.app);

    this.registerView(VIEW_TYPE_JOTDROP, (leaf) => new JotDropView(leaf, this));

    addIcon(LOGO_ICON, LOGO_ICON_SVG);
    this.addRibbonIcon(LOGO_ICON, t("open_jotdrop"), () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-jotdrop",
      name: t("cmd_open_view"),
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "ask-jotdrop",
      name: t("cmd_ask_jotdrop"),
      callback: async () => {
        await this.activateView();
        const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_JOTDROP)[0]?.view;
        if (view instanceof JotDropView) view.openAsk();
      },
    });

    this.addCommand({
      id: "quick-capture-keep",
      name: t("cmd_quick_capture"),
      callback: () => new QuickCaptureModal(this.app, this).open(),
    });

    this.addSettingTab(new JotDropSettingTab(this.app, this));

    this.reminderScheduler = new ReminderScheduler(this);
    this.clipServer = new ClipServer(this);

    this.registerEvent(this.app.vault.on("create", (f) => {
      if (f instanceof TFile) this.reminderScheduler.scheduleFile(f);
      this.refreshViews();
    }));
    this.registerEvent(this.app.vault.on("delete", (f) => {
      this.reminderScheduler.cancelFile(f.path);
      this.refreshViews();
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) this.reminderScheduler.scheduleFile(file);
      if (this.suppressedPaths.has(file.path)) {
        this.suppressedPaths.delete(file.path);
        return;
      }
      this.refreshViews();
    }));
    this.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
      this.reminderScheduler.cancelFile(oldPath);
      if (f instanceof TFile) this.reminderScheduler.scheduleFile(f);
      this.refreshViews();
    }));

    this.app.workspace.onLayoutReady(() => {
      this.reminderScheduler.scheduleAll();
      if (Platform.isDesktopApp) this.applyClipServerState();
    });

    // Obsidian-URI fallback for the Chrome extension when the loopback server
    // is off or the plugin was not running at send time. Schema:
    // obsidian://jotdrop-clip?url=…&title=…&selection=…&tags=…&color=…&pinned=true|false
    // Backward-compat: also accept the previous `obsidrop-clip` schema so
    // installed Chrome extensions from before the rename keep working until
    // they auto-update.
    this.registerObsidianProtocolHandler("jotdrop-clip", (params) => {
      void this.handleClipFromUri(params);
    });
    this.registerObsidianProtocolHandler("obsidrop-clip", (params) => {
      void this.handleClipFromUri(params);
    });

    const rescue = new PreviewRescue(this);
    rescue.start();

    this.addCommand({
      id: "rescue-pending-previews",
      name: t("cmd_rescue_previews"),
      callback: () => { void rescue.rescueAllNow(); },
    });

    this.addCommand({
      id: "neutralize-inline-hashtags",
      name: t("cmd_neutralize_hashtags"),
      callback: () => { void this.neutralizeExistingHashtags(); },
    });

    this.addCommand({
      id: "import-google-keep",
      name: t("cmd_import_keep"),
      callback: () => this.importFromKeep(),
    });

    this.addCommand({
      id: "import-markdown",
      name: t("cmd_import_markdown"),
      callback: () => this.importMarkdown(),
    });

    this.addCommand({
      id: "import-evernote",
      name: t("cmd_import_evernote"),
      callback: () => this.importFromEvernote(),
    });

  }

  onunload(): void {
    // Obsidian closes the view automatically
    this.reminderScheduler?.cancelAll();
    this.clipServer?.stop();
    this.cloud?.lock();
    this.excalidraw?.dispose();
  }

  /**
   * Starts or stops the clip server according to settings; restarts on port change.
   */
  applyClipServerState(): void {
    if (!this.clipServer || !Platform.isDesktopApp) return;
    const shouldRun = this.settings.clipServerEnabled && !!this.settings.clipServerToken;
    if (shouldRun) {
      if (!this.clipServer.isRunning()) {
        this.clipServer.start();
      } else if (this.clipServer.needsRestart()) {
        this.clipServer.restart();
      }
    } else if (this.clipServer.isRunning()) {
      this.clipServer.stop();
    }
  }

  /**
   * Handles an obsidian://jotdrop-clip?…-URI as fallback for when the
   * loopback server was not running at send time. Does OG fetch and creates note.
   */
  private async handleClipFromUri(params: Record<string, string>): Promise<void> {
    const url = (params.url || "").trim();
    if (!/^https?:\/\//i.test(url)) return;
    const title = (params.title || "").trim() || url;
    const selection = (params.selection || "").trim().slice(0, 8000);
    const tags = (params.tags || "")
      .split(",")
      .map((s) => s.replace(/^#/, "").trim())
      .filter((s) => s.length > 0 && !/\s/.test(s));
    const color: ColorName = isColorName(params.color) ? params.color : "default";
    // Only the exact string "true" counts as pinned; anything else (including
    // absence) is unpinned.
    const pinned = params.pinned === "true";

    const notice = new Notice(t("notice_fetching_preview"), 0);
    let content = `# ${title}\n\n`;
    if (selection) content += `> ${selection.replace(/\n/g, "\n> ")}\n\n`;
    content += safeMarkdownLink(title, url);
    try {
      const attachmentsFolder = this.resolveAssetsFolder();
      const preview = await fetchOg(this.app, attachmentsFolder, url, this.settings.downloadImages);
      if (preview?.imageBasename) {
        content = `![[${preview.imageBasename}]]\n\n${content}`;
      }
    } catch (e) {
      console.error("JotDrop URI-clip: OG-fetch failed:", e);
    } finally {
      notice.hide();
    }

    const safe = neutralizeBodyHashtags(content);
    const file = await createNoteInFolder(this.app, this.settings.notesFolder, safe);
    if (color !== "default" || tags.length > 0 || pinned) {
      await updateMeta(this.app, file, { color, tags, pinned });
    }
    new Notice(t("notice_clip_saved", file.basename));
    this.refreshViews();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<JotDropSettings>,
    );
    // The isolated cloud preview is replaced by JotDrop Cloud; its wrapped test credentials are not used anymore.
    delete (this.settings as unknown as Record<string, unknown>).cloudConnection;
    // One-time migration: the previous default "modified-desc" reordered cards
    // on every edit. Move it to the stable "created-desc" once, then leave the
    // setting alone so a deliberate later choice sticks.
    if (!this.settings.sortMigratedToCreated) {
      if (this.settings.sortMode === "modified-desc") {
        this.settings.sortMode = "created-desc";
      }
      this.settings.sortMigratedToCreated = true;
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * The effective assets folder: the explicit, normalized `assetsFolder` when
   * set, otherwise the dynamic legacy `<notesFolder>/.attachments`.
   */
  resolveAssetsFolder(): string {
    const explicit = (this.settings.assetsFolder || "").trim();
    if (explicit) return normalizePath(explicit);
    return legacyAssetsPath(this.settings.notesFolder);
  }

  /**
   * Ordered, deduplicated candidate locations for an embedded attachment
   * basename. Deterministic on purpose (mirrored by the Android app) so that
   * identical basenames in visible and hidden folders resolve consistently:
   *
   * 1. the effective assets folder (explicit setting, or `<notesFolder>/.attachments`),
   * 2. Obsidian-resolved visible attachment (metadataCache),
   * 3. legacy `.attachments` next to the note (its pre-archive location),
   * 4. legacy `<notesFolder>/.attachments`.
   */
  resolveAssetCandidates(
    noteFile: TFile,
    basename: string,
  ): { vaultPath: string; file: TFile | null }[] {
    const out: { vaultPath: string; file: TFile | null }[] = [];
    const byPath = new Map<string, { vaultPath: string; file: TFile | null }>();
    const push = (vaultPath: string, file: TFile | null): void => {
      const np = normalizePath(vaultPath);
      const existing = byPath.get(np);
      if (existing) {
        // Upgrade a raw adapter path with the resolved TFile when Obsidian's
        // metadataCache points at the same (visible) file — keeps the lightbox
        // "open in tab" working without duplicating the candidate.
        if (file && !existing.file) existing.file = file;
        return;
      }
      const entry = { vaultPath: np, file };
      byPath.set(np, entry);
      out.push(entry);
    };

    push(`${this.resolveAssetsFolder()}/${basename}`, null);
    const dest = this.app.metadataCache.getFirstLinkpathDest(basename, noteFile.path);
    if (dest) push(dest.path, dest);
    const noteFolder = noteFile.parent?.path ?? "";
    push(noteFolder ? `${noteFolder}/.attachments/${basename}` : `.attachments/${basename}`, null);
    push(`${legacyAssetsPath(this.settings.notesFolder)}/${basename}`, null);
    return out;
  }

  /** Where a note's new attachments go: a shared group keeps its own next to its notes, like the website and Android. */
  attachmentsFolderFor(note?: TFile): string {
    const space = note ? this.cloud?.spaceOf(note.path) : undefined;
    if (space) return normalizePath(`${this.settings.notesFolder}/Shared/${space.id}/attachments`);
    return this.resolveAssetsFolder();
  }

  /**
   * Writes a new attachment under its own (cleaned) name and returns the basename for its embed. Never overwrites:
   * a name that `![[name]]` could already point at becomes `name (2).ext`.
   */
  async saveAttachment(name: string, data: ArrayBuffer | Uint8Array, note?: TFile): Promise<string> {
    const adapter = this.app.vault.adapter;
    const folder = this.attachmentsFolderFor(note);
    const taken = async (candidate: string): Promise<boolean> => {
      const paths = note
        ? this.resolveAssetCandidates(note, candidate).map((c) => c.vaultPath)
        : [`${this.resolveAssetsFolder()}/${candidate}`, `${legacyAssetsPath(this.settings.notesFolder)}/${candidate}`];
      if (!note && this.app.metadataCache.getFirstLinkpathDest(candidate, "")) return true;
      for (const path of [...paths, `${folder}/${candidate}`]) if (await adapter.exists(normalizePath(path))) return true;
      return false;
    };
    const basename = await uniqueFileName(cleanFileName(name), taken);
    const path = normalizePath(`${folder}/${basename}`);
    const buffer = data instanceof Uint8Array ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer : data;
    // Obsidian does not index hidden folders like `.attachments`: there only the adapter writes.
    if (folder.split("/").some((part) => part.startsWith("."))) {
      if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
      await adapter.writeBinary(path, buffer);
    } else {
      if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
      await this.app.vault.createBinary(path, buffer);
    }
    return basename;
  }

  /** Picked, dropped or pasted files for [note]; one over the plan's maximum is refused with the Plus line. Returns the saved basenames. */
  async saveAttachedFiles(note: TFile, files: File[]): Promise<string[]> {
    const limit = this.cloud?.enabled ? this.cloud.maxFileBytes : undefined;
    const names: string[] = [];
    for (const file of files) {
      if (limit && file.size > limit) {
        const plus = limit < MAX_CHUNKED_BYTES ? ` ${t("attach_plus")}` : "";
        new Notice(`${t("attach_too_large", file.name, `${Math.round(limit / 1048576)} MB`)}${plus}`, 10000);
        continue;
      }
      try {
        names.push(await this.saveAttachment(file.name, await file.arrayBuffer(), note));
      } catch (err) {
        new Notice(t("notice_save_failed", err instanceof Error ? err.message : String(err)));
      }
    }
    if (names.length) new Notice(names.length === 1 ? t("attach_done_one", names[0]) : t("attach_done_many", String(names.length)));
    return names;
  }

  /** The file picker for "Attach file", attached to the page so mobile webviews also open it. */
  pickAttachments(onPick: (files: File[]) => void): void {
    const input = document.body.createEl("input", { type: "file", attr: { multiple: "", hidden: "" } });
    input.addEventListener("cancel", () => input.remove());
    input.addEventListener("change", () => {
      const picked = Array.from(input.files ?? []);
      input.remove();
      if (picked.length) onPick(picked);
    });
    input.click();
  }

  /** Puts `![[name]]` lines at the end of a note that is not open in the editor. */
  async appendEmbeds(note: TFile, names: string[]): Promise<void> {
    if (!names.length) return;
    const embeds = names.map((name) => `![[${name}]]`).join("\n");
    await this.app.vault.process(note, (content) => `${content.replace(/\s+$/, "")}\n\n${embeds}\n`);
    this.refreshViews();
  }

  /** Opens an attachment in the app that handles its kind: the system app on a computer, the phone's choice on mobile. */
  async openAttachment(note: TFile, name: string): Promise<void> {
    // Another note or a drawing opens in Obsidian itself.
    if (!isFileEmbed(name)) { await this.app.workspace.openLinkText(name, note.path, "tab"); return; }
    const adapter = this.app.vault.adapter;
    for (const c of this.resolveAssetCandidates(note, name)) {
      if (c.file?.extension === "md" || !(await adapter.exists(c.vaultPath))) continue;
      if (adapter instanceof FileSystemAdapter) {
        // Electron's shell — desktop only; not part of Obsidian's plugin TS types.
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- desktop-only "open in system app", as in the lightbox
        const { shell } = require("electron") as { shell: { openPath(path: string): Promise<string> } };
        const error = await shell.openPath(adapter.getFullPath(c.vaultPath));
        if (error) new Notice(t("notice_error", error));
        return;
      }
      // Obsidian mobile hands the file to the phone ("Open in default app"); not in the plugin TS types.
      const app = this.app as unknown as { openWithDefaultApp?: (path: string) => unknown };
      if (typeof app.openWithDefaultApp === "function") { await app.openWithDefaultApp(c.vaultPath); return; }
      const file = c.file ?? this.app.vault.getAbstractFileByPath(c.vaultPath);
      if (file instanceof TFile) { await this.app.workspace.getLeaf("tab").openFile(file); return; }
    }
    new Notice(t("attach_missing", name));
  }

  /**
   * After an attachment's embed was removed from [note]: a file in an attachments folder that no note uses any more
   * goes to the trash, like deleting a note. A file elsewhere in the vault is the person's own and stays.
   */
  async trashUnusedAttachments(note: TFile, names: string[]): Promise<void> {
    if (!names.length) return;
    const used = new Set<string>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      try {
        for (const name of collectEmbedBasenames(await this.app.vault.cachedRead(file), isFileEmbed)) used.add(name);
      } catch {
        // An unreadable note keeps its files: nothing is thrown away on doubt.
        return;
      }
    }
    const noteFolder = note.parent?.path ?? "";
    const folders = new Set([this.attachmentsFolderFor(note), this.resolveAssetsFolder(), legacyAssetsPath(this.settings.notesFolder), normalizePath(noteFolder ? `${noteFolder}/.attachments` : ".attachments")]);
    for (const name of names) {
      if (used.has(name)) continue;
      for (const c of this.resolveAssetCandidates(note, name)) {
        if (!folders.has(c.vaultPath.slice(0, c.vaultPath.lastIndexOf("/")))) continue;
        try {
          if (c.file) await this.app.fileManager.trashFile(c.file);
          // A phone has no system trash: then the vault's own .trash, never a file left behind.
          else if (await this.app.vault.adapter.exists(c.vaultPath) && !(await this.app.vault.adapter.trashSystem(c.vaultPath))) await this.app.vault.adapter.trashLocal(c.vaultPath);
        } catch {
          // The next candidate still goes.
        }
      }
    }
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_JOTDROP);
    let leaf: WorkspaceLeaf | null;
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_JOTDROP, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  /**
   * Marks that the next modify event for this path should be ignored.
   * Used during in-place metadata updates (color change) so the grid does not
   * re-sort due to the bumping mtime. Auto-clears after 2s as a safety net.
   */
  suppressModifyOnce(path: string): void {
    this.suppressedPaths.add(path);
    window.setTimeout(() => this.suppressedPaths.delete(path), 2000);
  }

  /**
   * Iterates all notes under `notesFolder` (incl. archive) and escapes inline
   * `#hashtags` so they no longer appear in Obsidian's vault-wide tag index.
   * One-time migration for notes synced before the fix.
   */
  async neutralizeExistingHashtags(): Promise<void> {
    const root = normalizePath(this.settings.notesFolder);
    const files = this.app.vault.getMarkdownFiles().filter((f) =>
      f.path === root || f.path.startsWith(`${root}/`),
    );
    let changed = 0;
    for (const file of files) {
      try {
        const original = await this.app.vault.read(file);
        const next = neutralizeBodyHashtags(original);
        if (next !== original) {
          await this.app.vault.modify(file, next);
          changed += 1;
        }
      } catch (err) {
        console.error("JotDrop: neutralize failed for", file.path, err);
      }
    }
    if (changed === 0) {
      new Notice(t("notice_neutralized_none"));
    } else {
      new Notice(t("notice_neutralized", String(changed)));
      this.refreshViews();
    }
  }

  /**
   * Imports a Google Takeout export (zip parts, or loose Keep JSON plus its
   * attachments) as JotDrop notes. Existing files are never overwritten.
   */
  importFromKeep(): void {
    this.pickImportFiles(false, (picked) => this.importKeepFiles(picked));
  }

  /**
   * Imports Markdown notes exported by other apps (Apple Notes, Bear, Joplin, …):
   * loose files, a zip, or with `folder` a whole export folder.
   */
  importMarkdown(folder = false): void {
    this.pickImportFiles(folder, (picked) => this.importMarkdownFiles(picked));
  }

  /** Imports Evernote notebooks exported as .enex files (loose or in a zip). */
  importFromEvernote(): void {
    this.pickImportFiles(false, (picked) => this.importEvernoteFiles(picked));
  }

  private pickImportFiles(folder: boolean, handle: (picked: File[]) => Promise<void>): void {
    // Attached to the page so mobile webviews also open the picker.
    const input = document.body.createEl("input", { type: "file", attr: { multiple: "", hidden: "" } });
    if (folder) input.webkitdirectory = true;
    input.addEventListener("cancel", () => input.remove());
    input.addEventListener("change", () => {
      const picked = Array.from(input.files ?? []);
      input.remove();
      void handle(picked).catch((err) => {
        console.error("JotDrop: import failed", err);
        new Notice(t("import_failed", err instanceof Error ? err.message : String(err)));
      });
    });
    input.click();
  }

  /** Picked files and the contents of picked zips, keyed by their path inside the export. */
  private async readImportFiles(picked: File[]): Promise<ImportFiles> {
    const files: ImportFiles = new Map();
    for (const file of picked) {
      if (/\.zip$/i.test(file.name)) for (const [path, load] of await readZip(file)) files.set(path, load);
      else files.set(file.webkitRelativePath || file.name, Object.assign(async () => new Uint8Array(await file.arrayBuffer()), { modified: file.lastModified }));
    }
    return files;
  }

  private async importKeepFiles(picked: File[]): Promise<void> {
    if (picked.length === 0) return;
    const files = await this.readImportFiles(picked);
    const { notes, trashed, failed, error } = await parseKeepExport(files);
    if (notes.length === 0) {
      new Notice(error ? t("import_failed", error) : t("keep_import_none"));
      return;
    }
    const archived = notes.filter((note) => note.archived).length;
    const attachments = new Set(notes.flatMap((note) => note.attachments)).size;
    const missing = notes.reduce((sum, note) => sum + note.missingAttachments, 0);
    const items: ImportItem[] = notes.map((note) => ({
      source: note.source,
      name: keepNoteFileName(note),
      archived: note.archived,
      createdMs: note.createdMs,
      editedMs: note.editedMs,
      attachments: note.attachments,
      render: (names) => keepNoteMarkdown({ ...note, attachments: note.attachments.filter((source) => names.has(source)) }, (source) => names.get(source)!),
    }));
    this.confirmImport(t("keep_import_title"),
      t("keep_import_confirm", String(notes.length), String(archived), String(attachments), String(trashed), this.settings.notesFolder),
      missing, items, files, failed.length);
  }

  private async importMarkdownFiles(picked: File[]): Promise<void> {
    if (picked.length === 0) return;
    const files = await this.readImportFiles(picked);
    const { notes, failed, error } = await parseMarkdownExport(files);
    if (notes.length === 0) {
      new Notice(error ? t("import_failed", error) : t("markdown_import_none"));
      return;
    }
    const attachments = new Set(notes.flatMap((note) => note.attachments)).size;
    const missing = notes.reduce((sum, note) => sum + note.missingAttachments, 0);
    const items: ImportItem[] = notes.map((note) => ({
      source: note.source,
      name: markdownNoteFileName(note),
      archived: false,
      createdMs: note.createdMs,
      editedMs: note.editedMs,
      attachments: note.attachments,
      render: (names) => markdownNoteMarkdown(note, names),
    }));
    this.confirmImport(t("markdown_import_title"),
      t("markdown_import_confirm", String(notes.length), String(attachments), this.settings.notesFolder),
      missing, items, files, failed.length);
  }

  private async importEvernoteFiles(picked: File[]): Promise<void> {
    if (picked.length === 0) return;
    const files = await this.readImportFiles(picked);
    const { notes, notebooks, failed, error } = await parseEnexExport(files);
    if (notes.length === 0) {
      new Notice(error ? t("import_failed", error) : t("evernote_import_none"));
      return;
    }
    const attachments = notes.reduce((sum, note) => sum + note.attachments.length, 0);
    const missing = notes.reduce((sum, note) => sum + note.missingAttachments, 0);
    const items: ImportItem[] = notes.map((note) => ({
      source: note.source,
      name: evernoteNoteFileName(note),
      archived: false,
      createdMs: note.createdMs,
      editedMs: note.editedMs,
      attachments: note.attachments,
      render: (names) => evernoteNoteMarkdown(note, names),
    }));
    this.confirmImport(t("evernote_import_title"),
      t("evernote_import_confirm", String(notes.length), String(notebooks), String(attachments), this.settings.notesFolder),
      missing, items, files, failed.length);
  }

  private confirmImport(title: string, message: string, missing: number, items: ImportItem[], files: ImportFiles, unreadable: number): void {
    new ConfirmModal(this.app, {
      title,
      message: message + (missing ? ` ${t("import_missing", String(missing))}` : ""),
      confirmLabel: t("import_action"),
    }, () => {
      void this.writeImportedNotes(title, items, files, unreadable).catch((err) => {
        console.error("JotDrop: import failed", err);
        new Notice(t("import_failed", err instanceof Error ? err.message : String(err)));
      });
    }).open();
  }

  /**
   * Writes imported notes and their attachments. A note whose stamped name already
   * exists in the notes or archive folder counts as imported before, even after it
   * was edited or (un)archived; existing files are never overwritten.
   */
  private async writeImportedNotes(title: string, items: ImportItem[], files: ImportFiles, unreadable: number): Promise<void> {
    const adapter = this.app.vault.adapter;
    const ensureFolder = async (folder: string) => {
      if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
    };
    // An attachment with the same name and bytes is reused; otherwise the next free numbered name.
    const freeAttachmentPath = async (folder: string, name: string, bytes: Uint8Array) => {
      const dot = name.lastIndexOf(".") > 0 ? name.lastIndexOf(".") : name.length;
      for (let n = 1; ; n++) {
        const path = normalizePath(`${folder}/${n === 1 ? name : `${name.slice(0, dot)} ${n}${name.slice(dot)}`}`);
        if (!(await adapter.exists(path))) return { path, exists: false };
        const current = new Uint8Array(await adapter.readBinary(path));
        if (current.length === bytes.length && current.every((byte, i) => byte === bytes[i])) return { path, exists: true };
      }
    };
    const assets = this.resolveAssetsFolder();
    const folders = [this.settings.notesFolder, this.settings.archiveFolder].map((folder) => normalizePath(folder));
    const attachmentNames = new Map<string, string>();
    const brokenAttachments = new Set<string>();
    const exists = async (name: string) =>
      (await Promise.all(folders.map((folder) => adapter.exists(normalizePath(`${folder}/${name}`))))).some(Boolean);
    const written = new Set<string>();
    const progress = new Notice(t("import_progress", "0", String(items.length)), 0);
    let imported = 0, existing = 0, failed = unreadable;
    for (const [index, item] of items.entries()) {
      try {
        const times = { ctime: item.createdMs, mtime: item.editedMs };
        let name = item.name;
        if (written.has(name)) {
          // Two notes with the same stamp and title in one export: the next gets a number.
          const stem = name.replace(/\.md$/, "");
          for (let n = 2; written.has(name) || (await exists(name)); n++) name = `${stem} ${n}.md`;
        } else if (await exists(name)) {
          existing += 1;
          continue;
        }
        for (const source of item.attachments) {
          if (attachmentNames.has(source) || brokenAttachments.has(source)) continue;
          try {
            const bytes = await files.get(source)!();
            await ensureFolder(assets);
            // `[ ] | # ^` would break the ![[…]] embed.
            const target = await freeAttachmentPath(assets, source.slice(source.lastIndexOf("/") + 1).replace(/[[\]|#^]/g, "_"), bytes);
            if (!target.exists) await adapter.writeBinary(target.path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, times);
            attachmentNames.set(source, target.path.slice(target.path.lastIndexOf("/") + 1));
          } catch (err) {
            console.error("JotDrop: could not import attachment", source, err);
            brokenAttachments.add(source);
          }
        }
        const folder = folders[item.archived ? 1 : 0];
        await ensureFolder(folder);
        await this.app.vault.create(normalizePath(`${folder}/${name}`), item.render(attachmentNames), times);
        written.add(item.name).add(name);
        imported += 1;
      } catch (err) {
        console.error("JotDrop: could not import", item.source, err);
        failed += 1;
      }
      if (index % 25 === 24) progress.setMessage(t("import_progress", String(index + 1), String(items.length)));
    }
    progress.hide();
    new Notice(t("import_done", title, String(imported), String(existing), String(failed)) +
      (brokenAttachments.size ? ` ${t("import_missing_done", String(brokenAttachments.size))}` : ""), 0);
    this.refreshViews();
  }

  refreshViews(): void {
    if (this.refreshTimer != null) {
      window.clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_JOTDROP);
      for (const leaf of leaves) {
        const view = leaf.view;
        if (view instanceof JotDropView) {
          void view.render();
        }
      }
    }, 150);
  }
}

import { Notice, Plugin, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import { DEFAULT_SETTINGS, JotDropSettings, JotDropSettingTab } from "./settings";
import { JotDropView, VIEW_TYPE_JOTDROP } from "./view";
import { QuickCaptureModal, createNoteInFolder } from "./capture";
import { PreviewRescue } from "./previewRescue";
import { ReminderScheduler } from "./reminderScheduler";
import { ClipServer } from "./clipServer";
import { fetchOg, safeMarkdownLink } from "./ogfetch";
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

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_JOTDROP, (leaf) => new JotDropView(leaf, this));

    this.addRibbonIcon("sticky-note", t("open_jotdrop"), () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-jotdrop",
      name: t("cmd_open_view"),
      callback: () => this.activateView(),
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
      this.applyClipServerState();
    });

    // Obsidian-URI fallback for the Chrome extension when the loopback server
    // is off or the plugin was not running at send time. Schema:
    // obsidian://jotdrop-clip?url=…&title=…&selection=…&tags=…&color=…
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

  }

  onunload(): void {
    // Obsidian closes the view automatically
    this.reminderScheduler?.cancelAll();
    this.clipServer?.stop();
  }

  /**
   * Starts or stops the clip server according to settings; restarts on port change.
   */
  applyClipServerState(): void {
    if (!this.clipServer) return;
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

    const notice = new Notice(t("notice_fetching_preview"), 0);
    let content = `# ${title}\n\n`;
    if (selection) content += `> ${selection.replace(/\n/g, "\n> ")}\n\n`;
    content += safeMarkdownLink(title, url);
    try {
      const attachmentsFolder = `${this.settings.notesFolder}/.attachments`;
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
    if (color !== "default" || tags.length > 0) {
      await updateMeta(this.app, file, { color, tags, pinned: false });
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

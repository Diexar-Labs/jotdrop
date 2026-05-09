import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import type DiexarKeepPlugin from "./main";
import { QuickCaptureModal } from "./capture";

export const VIEW_TYPE_DIEXAR_KEEP = "diexar-keep-view";

const PREVIEW_MAX_CHARS = 280;

export class DiexarKeepView extends ItemView {
  plugin: DiexarKeepPlugin;
  private gridEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private query = "";

  constructor(leaf: WorkspaceLeaf, plugin: DiexarKeepPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_DIEXAR_KEEP;
  }

  getDisplayText(): string {
    return "Diexar Keep";
  }

  getIcon(): string {
    return "sticky-note";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("diexar-keep-view");

    const toolbar = root.createDiv({ cls: "diexar-keep-toolbar" });

    const newBtn = toolbar.createEl("button", { cls: "diexar-keep-new-btn" });
    setIcon(newBtn.createSpan({ cls: "diexar-keep-new-btn-icon" }), "plus");
    newBtn.createSpan({ text: "Nieuwe notitie" });
    newBtn.addEventListener("click", () => {
      new QuickCaptureModal(this.app, this.plugin).open();
    });

    this.searchEl = toolbar.createEl("input", {
      cls: "diexar-keep-search",
      attr: { type: "search", placeholder: "Zoeken in notities…" },
    });
    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value.toLowerCase();
      this.render();
    });

    this.gridEl = root.createDiv({ cls: "diexar-keep-grid" });
    this.applyCardWidth();
    await this.render();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  applyCardWidth(): void {
    if (this.gridEl) {
      this.gridEl.style.setProperty("--diexar-keep-card-width", `${this.plugin.settings.cardWidth}px`);
    }
  }

  async render(): Promise<void> {
    if (!this.gridEl) return;
    this.applyCardWidth();
    this.gridEl.empty();

    const files = this.collectFiles();
    if (files.length === 0) {
      const empty = this.gridEl.createDiv({ cls: "diexar-keep-empty" });
      empty.createEl("h3", { text: "Nog geen notities" });
      empty.createEl("p", {
        text: `Klik op "Nieuwe notitie" of gebruik de hotkey om je eerste kaartje te maken.`,
      });
      return;
    }

    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      if (this.query && !this.matchesQuery(file, content)) continue;
      this.renderCard(file, content);
    }
  }

  private matchesQuery(file: TFile, content: string): boolean {
    return file.basename.toLowerCase().includes(this.query) || content.toLowerCase().includes(this.query);
  }

  private collectFiles(): TFile[] {
    const folder = normalizePath(this.plugin.settings.notesFolder);
    const archive = normalizePath(this.plugin.settings.archiveFolder);
    const showArchived = this.plugin.settings.showArchived;

    const all = this.app.vault.getMarkdownFiles().filter((f) => {
      const inArchive = isUnder(f.path, archive);
      const inFolder = isUnder(f.path, folder);
      if (!inFolder) return false;
      if (inArchive && !showArchived) return false;
      return true;
    });

    return sortFiles(all, this.plugin.settings.sortMode);
  }

  private renderCard(file: TFile, content: string): void {
    const archived = isUnder(file.path, normalizePath(this.plugin.settings.archiveFolder));
    const card = this.gridEl.createDiv({
      cls: `diexar-keep-card${archived ? " is-archived" : ""}`,
    });

    const titleText = extractTitle(content) || file.basename;
    const previewText = extractPreview(content, titleText);
    const tags = extractTags(content);

    const body = card.createDiv({ cls: "diexar-keep-card-body" });
    body.addEventListener("click", async () => {
      await this.app.workspace.getLeaf(false).openFile(file);
    });

    body.createEl("h3", { cls: "diexar-keep-card-title", text: titleText });
    if (previewText) {
      body.createDiv({ cls: "diexar-keep-card-preview", text: previewText });
    }

    if (tags.length > 0) {
      const tagWrap = body.createDiv({ cls: "diexar-keep-card-tags" });
      for (const tag of tags) {
        tagWrap.createSpan({ cls: "diexar-keep-card-tag", text: `#${tag}` });
      }
    }

    const actions = card.createDiv({ cls: "diexar-keep-card-actions" });

    const editBtn = actions.createEl("button", {
      cls: "diexar-keep-card-action",
      attr: { "aria-label": "Bewerken" },
    });
    setIcon(editBtn, "pencil");
    editBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await this.app.workspace.getLeaf(false).openFile(file);
    });

    const archiveBtn = actions.createEl("button", {
      cls: "diexar-keep-card-action",
      attr: { "aria-label": archived ? "Terug uit archief" : "Archiveren" },
    });
    setIcon(archiveBtn, archived ? "archive-restore" : "archive");
    archiveBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await this.toggleArchive(file, archived);
    });

    const moreBtn = actions.createEl("button", {
      cls: "diexar-keep-card-action",
      attr: { "aria-label": "Meer" },
    });
    setIcon(moreBtn, "more-vertical");
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem((i) =>
        i
          .setTitle("Verwijder kaartje")
          .setIcon("trash-2")
          .onClick(async () => {
            await this.app.vault.trash(file, true);
            new Notice(`Verwijderd: ${file.basename}`);
            this.plugin.refreshViews();
          })
      );
      menu.addItem((i) =>
        i
          .setTitle("Open in nieuw tabblad")
          .setIcon("file-plus")
          .onClick(async () => {
            await this.app.workspace.getLeaf("tab").openFile(file);
          })
      );
      menu.showAtMouseEvent(e);
    });
  }

  private async toggleArchive(file: TFile, currentlyArchived: boolean): Promise<void> {
    const archiveFolder = normalizePath(this.plugin.settings.archiveFolder);
    const notesFolder = normalizePath(this.plugin.settings.notesFolder);
    try {
      if (currentlyArchived) {
        const newPath = normalizePath(`${notesFolder}/${file.name}`);
        await this.app.fileManager.renameFile(file, newPath);
        new Notice(`Hersteld uit archief: ${file.basename}`);
      } else {
        if (!this.app.vault.getAbstractFileByPath(archiveFolder)) {
          await this.app.vault.createFolder(archiveFolder);
        }
        const newPath = normalizePath(`${archiveFolder}/${file.name}`);
        await this.app.fileManager.renameFile(file, newPath);
        new Notice(`Gearchiveerd: ${file.basename}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Fout: ${message}`);
    }
    this.plugin.refreshViews();
  }
}

function isUnder(filePath: string, folderPath: string): boolean {
  if (!folderPath) return false;
  const f = folderPath.replace(/\/+$/, "");
  return filePath === f || filePath.startsWith(`${f}/`);
}

function sortFiles(files: TFile[], mode: string): TFile[] {
  const sorted = [...files];
  switch (mode) {
    case "modified-asc":
      sorted.sort((a, b) => a.stat.mtime - b.stat.mtime);
      break;
    case "created-desc":
      sorted.sort((a, b) => b.stat.ctime - a.stat.ctime);
      break;
    case "created-asc":
      sorted.sort((a, b) => a.stat.ctime - b.stat.ctime);
      break;
    case "title-asc":
      sorted.sort((a, b) => a.basename.localeCompare(b.basename));
      break;
    case "modified-desc":
    default:
      sorted.sort((a, b) => b.stat.mtime - a.stat.mtime);
      break;
  }
  return sorted;
}

function extractTitle(content: string): string {
  const lines = content.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("---")) continue;
    return line.replace(/^#+\s*/, "").replace(/^[*_`>]+/, "").trim().slice(0, 80);
  }
  return "";
}

function extractPreview(content: string, title: string): string {
  const stripped = content.replace(/^---[\s\S]*?---\n?/, "");
  const lines = stripped.split("\n").map((l) => l.trim()).filter(Boolean);
  const startIdx = lines[0] && stripFirstHeading(lines[0]) === title.trim() ? 1 : 0;
  const rest = lines.slice(startIdx).join(" ");
  if (!rest) return "";
  return rest.length > PREVIEW_MAX_CHARS ? `${rest.slice(0, PREVIEW_MAX_CHARS)}…` : rest;
}

function stripFirstHeading(line: string): string {
  return line.replace(/^#+\s*/, "").trim();
}

function extractTags(content: string): string[] {
  const matches = content.match(/(?:^|\s)#([A-Za-z0-9_\-/]+)/g) ?? [];
  const cleaned = matches.map((m) => m.trim().replace(/^#/, ""));
  return Array.from(new Set(cleaned)).slice(0, 8);
}

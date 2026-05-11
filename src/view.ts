import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import type DiexarKeepPlugin from "./main";
import { QuickCaptureModal } from "./capture";
import { EditNoteModal } from "./edit";
import {
  COLOR_LABELS_NL,
  COLOR_NAMES,
  ColorName,
  DEFAULT_META,
  NoteMeta,
  readMeta,
  renderInlinePreviewHtml,
  stripFrontmatter,
  updateMeta,
} from "./metadata";

export const VIEW_TYPE_DIEXAR_KEEP = "diexar-keep-view";

const PREVIEW_MAX_CHARS = 280;

interface CardData {
  file: TFile;
  content: string;
  meta: NoteMeta;
  archived: boolean;
}

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
      void this.render();
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

    const cards = await this.collectCards();
    const filtered = cards.filter((c) => this.matchesQuery(c));

    if (filtered.length === 0) {
      const empty = this.gridEl.createDiv({ cls: "diexar-keep-empty" });
      empty.createEl("h3", { text: "Nog geen notities" });
      empty.createEl("p", {
        text: `Klik op "Nieuwe notitie" of gebruik de hotkey om je eerste kaartje te maken.`,
      });
      return;
    }

    const pinned = filtered.filter((c) => c.meta.pinned);
    const rest = filtered.filter((c) => !c.meta.pinned);

    if (pinned.length > 0) {
      const pinnedSection = this.gridEl.createDiv({ cls: "diexar-keep-section" });
      pinnedSection.createDiv({ cls: "diexar-keep-section-label", text: "Vastgezet" });
      const pinnedGrid = pinnedSection.createDiv({ cls: "diexar-keep-grid-inner" });
      for (const c of pinned) this.renderCard(pinnedGrid, c);

      const restSection = this.gridEl.createDiv({ cls: "diexar-keep-section" });
      restSection.createDiv({ cls: "diexar-keep-section-label", text: "Overige" });
      const restGrid = restSection.createDiv({ cls: "diexar-keep-grid-inner" });
      for (const c of rest) this.renderCard(restGrid, c);
    } else {
      const inner = this.gridEl.createDiv({ cls: "diexar-keep-grid-inner" });
      for (const c of rest) this.renderCard(inner, c);
    }
  }

  private async collectCards(): Promise<CardData[]> {
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

    const sorted = sortFiles(all, this.plugin.settings.sortMode);

    const cards: CardData[] = [];
    for (const file of sorted) {
      const content = await this.app.vault.cachedRead(file);
      const meta = readMeta(this.app, file);
      cards.push({
        file,
        content,
        meta,
        archived: isUnder(file.path, archive),
      });
    }
    return cards;
  }

  private matchesQuery(card: CardData): boolean {
    if (!this.query) return true;
    const q = this.query;
    if (card.file.basename.toLowerCase().includes(q)) return true;
    if (card.content.toLowerCase().includes(q)) return true;
    if (card.meta.tags.some((t) => t.toLowerCase().includes(q))) return true;
    return false;
  }

  private renderCard(parent: HTMLElement, card: CardData): void {
    const { file, content, meta, archived } = card;
    const cardEl = parent.createDiv({
      cls: `diexar-keep-card${archived ? " is-archived" : ""}${meta.pinned ? " is-pinned" : ""}`,
    });
    if (meta.color !== "default") {
      cardEl.dataset.color = meta.color;
    }

    const titleText = extractTitle(content) || file.basename;
    const previewText = extractPreview(content, titleText);

    const body = cardEl.createDiv({ cls: "diexar-keep-card-body" });
    body.addEventListener("click", () => {
      new EditNoteModal(this.app, this.plugin, file).open();
    });

    const thumbnailBasename = extractFirstEmbeddedImage(content);
    if (thumbnailBasename) {
      const resourcePath = this.resolveAttachmentResource(file, thumbnailBasename);
      if (resourcePath) {
        const thumbWrap = body.createDiv({ cls: "diexar-keep-card-thumbnail" });
        const img = thumbWrap.createEl("img");
        img.src = resourcePath;
        img.alt = "";
        img.loading = "lazy";
        // Als het bestand niet bestaat (broken link), verberg de thumbnail-wrap.
        img.addEventListener("error", () => thumbWrap.remove());
      }
    }

    body.createEl("h3", { cls: "diexar-keep-card-title", text: titleText });

    if (previewText) {
      const preview = body.createDiv({ cls: "diexar-keep-card-preview" });
      preview.innerHTML = renderInlinePreviewHtml(previewText);
      preview.addEventListener("click", (e) => this.handlePreviewClick(e));
    }

    if (meta.tags.length > 0) {
      const tagWrap = body.createDiv({ cls: "diexar-keep-card-tags" });
      for (const tag of meta.tags) {
        tagWrap.createSpan({ cls: "diexar-keep-card-tag", text: `#${tag}` });
      }
    }

    const actions = cardEl.createDiv({ cls: "diexar-keep-card-actions" });

    const pinBtn = actions.createEl("button", {
      cls: `diexar-keep-card-action${meta.pinned ? " is-active" : ""}`,
      attr: { "aria-label": meta.pinned ? "Losmaken" : "Vastzetten" },
    });
    setIcon(pinBtn, meta.pinned ? "pin-off" : "pin");
    pinBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await updateMeta(this.app, file, { pinned: !meta.pinned });
      this.plugin.refreshViews();
    });

    const colorBtn = actions.createEl("button", {
      cls: "diexar-keep-card-action",
      attr: { "aria-label": "Kleur" },
    });
    setIcon(colorBtn, "palette");
    colorBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showColorMenu(e, file, meta, cardEl);
    });

    const editBtn = actions.createEl("button", {
      cls: "diexar-keep-card-action",
      attr: { "aria-label": "Bewerken" },
    });
    setIcon(editBtn, "pencil");
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      new EditNoteModal(this.app, this.plugin, file).open();
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
          .setTitle("Open in nieuw tabblad")
          .setIcon("file-plus")
          .onClick(async () => {
            await this.app.workspace.getLeaf("tab").openFile(file);
          })
      );
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
      menu.showAtMouseEvent(e);
    });
  }

  private handlePreviewClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const link = target.closest(".diexar-keep-wikilink") as HTMLElement | null;
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    const href = link.dataset.href;
    if (!href) return;
    const dest = this.app.metadataCache.getFirstLinkpathDest(href, "");
    if (dest) {
      void this.app.workspace.getLeaf(false).openFile(dest);
    } else {
      new Notice(`Geen notitie gevonden: ${href}`);
    }
  }

  private showColorMenu(event: MouseEvent, file: TFile, meta: NoteMeta, cardEl: HTMLElement): void {
    const menu = new Menu();
    for (const name of COLOR_NAMES) {
      menu.addItem((i) =>
        i
          .setTitle(COLOR_LABELS_NL[name])
          .setIcon(name === meta.color ? "check" : "circle")
          .onClick(async () => {
            // In-place update: voorkomt dat re-rendering de kaart bovenaan zet
            // doordat updateMeta de mtime bumpt en de grid hersorteert.
            this.plugin.suppressModifyOnce(file.path);
            await updateMeta(this.app, file, { color: name });
            meta.color = name;
            if (name === "default") {
              delete cardEl.dataset.color;
            } else {
              cardEl.dataset.color = name;
            }
          }),
      );
    }
    menu.showAtMouseEvent(event);
  }

  /**
   * Resolveer een ingebedde afbeelding naar een resource-path dat als `<img src>` werkt.
   *
   * 1. Probeer Obsidian's metadataCache (vindt standaard-attachments via vault-zoek).
   * 2. Fall back op `<note-folder>/.attachments/<basename>` — Obsidian's metadataCache
   *    slaat dot-prefixed mappen over (`.attachments/`, `.trash/`), maar de adapter zelf
   *    kan ze wél lezen. Android-deelflow gebruikt deze conventie.
   * 3. Fall back op `<notesFolder>/.attachments/<basename>` (geconfigureerde notitiemap).
   */
  private resolveAttachmentResource(noteFile: TFile, basename: string): string | null {
    const dest = this.app.metadataCache.getFirstLinkpathDest(basename, noteFile.path);
    if (dest) {
      return this.app.vault.getResourcePath(dest);
    }
    const candidates: string[] = [];
    const noteFolder = noteFile.parent?.path ?? "";
    if (noteFolder) candidates.push(`${noteFolder}/.attachments/${basename}`);
    else candidates.push(`.attachments/${basename}`);
    const configured = this.plugin.settings.notesFolder;
    if (configured && configured !== noteFolder) {
      candidates.push(`${configured}/.attachments/${basename}`);
    }
    for (const p of candidates) {
      const normalized = normalizePath(p);
      // We checken niet synchroon of het bestand bestaat — img.onerror ruimt op bij fail.
      return this.app.vault.adapter.getResourcePath(normalized);
    }
    return null;
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
  const body = stripFrontmatter(content);
  const lines = body.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    return line.replace(/^#+\s*/, "").replace(/^[*_`>]+/, "").trim().slice(0, 80);
  }
  return "";
}

function extractPreview(content: string, title: string): string {
  const body = stripFrontmatter(content);
  // Filter image-embed-only regels weg (zowel wiki ![[…]] als standaard ![](…)),
  // anders verschijnt de hashnaam van de thumbnail als ruwe tekst in de preview.
  // Ook diagnostische HTML-comments uit Android (<!-- diexar-preview: … -->).
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^!\[\[[^\]]+\]\]$/.test(l))
    .filter((l) => !/^!\[[^\]]*\]\([^)]+\)$/.test(l))
    .filter((l) => !/^<!--\s*diexar-preview:.*-->$/.test(l));
  const startIdx = lines[0] && stripFirstHeading(lines[0]) === title.trim() ? 1 : 0;
  const rest = lines.slice(startIdx).join("\n");
  if (!rest) return "";
  return rest.length > PREVIEW_MAX_CHARS ? `${rest.slice(0, PREVIEW_MAX_CHARS)}…` : rest;
}

/**
 * Vindt de basenaam van de eerste ingebedde afbeelding in de notitie.
 * Ondersteunt zowel Obsidian-wikilinks `![[bestand.jpg]]` als markdown `![](path)`.
 */
function extractFirstEmbeddedImage(content: string): string | null {
  const body = stripFrontmatter(content);
  const wiki = body.match(/!\[\[([^\]|]+?)\]\]/);
  if (wiki) {
    return wiki[1].trim().split("|")[0].trim();
  }
  const md = body.match(/!\[[^\]]*\]\(([^)]+)\)/);
  if (md) {
    const url = md[1].trim();
    // Voor lokale paden: pak de basename. Voor http(s) doen we niets (geen lokale resolve).
    if (/^https?:\/\//i.test(url)) return null;
    const clean = url.split("#")[0].split("?")[0];
    const parts = clean.split("/");
    return parts[parts.length - 1] || null;
  }
  return null;
}

function stripFirstHeading(line: string): string {
  return line.replace(/^#+\s*/, "").trim();
}

// Houden voor backwards-compat in case main.ts importeerde dit. Niet meer gebruikt.
export { DEFAULT_META };

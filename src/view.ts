import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import type ObsiDropPlugin from "./main";
import { QuickCaptureModal } from "./capture";
import { EditNoteModal } from "./edit";
import {
  colorLabel,
  COLOR_NAMES,
  ColorName,
  DEFAULT_META,
  NoteMeta,
  readMeta,
  renderInlinePreviewHtml,
  stripFrontmatter,
  updateMeta,
} from "./metadata";
import { t } from "./i18n";

export const VIEW_TYPE_OBSIDROP = "obsidrop-view";

const PREVIEW_MAX_CHARS = 280;

interface CardData {
  file: TFile;
  content: string;
  meta: NoteMeta;
  archived: boolean;
}

export class ObsiDropView extends ItemView {
  plugin: ObsiDropPlugin;
  private gridEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private query = "";

  constructor(leaf: WorkspaceLeaf, plugin: ObsiDropPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_OBSIDROP;
  }

  getDisplayText(): string {
    return t("view_title");
  }

  getIcon(): string {
    return "sticky-note";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("obsidrop-view");

    const toolbar = root.createDiv({ cls: "obsidrop-toolbar" });

    const newBtn = toolbar.createEl("button", { cls: "obsidrop-new-btn" });
    setIcon(newBtn.createSpan({ cls: "obsidrop-new-btn-icon" }), "plus");
    newBtn.createSpan({ text: t("action_new_note") });
    newBtn.addEventListener("click", () => {
      new QuickCaptureModal(this.app, this.plugin).open();
    });

    this.searchEl = toolbar.createEl("input", {
      cls: "obsidrop-search",
      attr: { type: "search", placeholder: t("search_placeholder") },
    });
    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value.toLowerCase();
      void this.render();
    });

    this.gridEl = root.createDiv({ cls: "obsidrop-grid" });
    this.applyCardWidth();
    await this.render();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  applyCardWidth(): void {
    if (this.gridEl) {
      this.gridEl.style.setProperty("--obsidrop-card-width", `${this.plugin.settings.cardWidth}px`);
    }
  }

  async render(): Promise<void> {
    if (!this.gridEl) return;
    this.applyCardWidth();
    this.gridEl.empty();

    const cards = await this.collectCards();
    const filtered = cards.filter((c) => this.matchesQuery(c));

    if (filtered.length === 0) {
      const empty = this.gridEl.createDiv({ cls: "obsidrop-empty" });
      empty.createEl("h3", { text: t("empty_no_notes_title") });
      empty.createEl("p", { text: t("empty_no_notes_desc") });
      return;
    }

    const pinned = filtered.filter((c) => c.meta.pinned);
    const rest = filtered.filter((c) => !c.meta.pinned);

    if (pinned.length > 0) {
      const pinnedSection = this.gridEl.createDiv({ cls: "obsidrop-section" });
      pinnedSection.createDiv({ cls: "obsidrop-section-label", text: t("section_pinned") });
      const pinnedGrid = pinnedSection.createDiv({ cls: "obsidrop-grid-inner" });
      for (const c of pinned) this.renderCard(pinnedGrid, c);

      const restSection = this.gridEl.createDiv({ cls: "obsidrop-section" });
      restSection.createDiv({ cls: "obsidrop-section-label", text: t("section_other") });
      const restGrid = restSection.createDiv({ cls: "obsidrop-grid-inner" });
      for (const c of rest) this.renderCard(restGrid, c);
    } else {
      const inner = this.gridEl.createDiv({ cls: "obsidrop-grid-inner" });
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
      cls: `obsidrop-card${archived ? " is-archived" : ""}${meta.pinned ? " is-pinned" : ""}`,
    });
    if (meta.color !== "default") {
      cardEl.dataset.color = meta.color;
    }

    const titleText = extractTitle(content) || file.basename;
    const previewText = extractPreview(content, titleText);

    const body = cardEl.createDiv({ cls: "obsidrop-card-body" });
    body.addEventListener("click", () => {
      new EditNoteModal(this.app, this.plugin, file).open();
    });

    const thumbnailBasename = extractFirstEmbeddedImage(content);
    if (thumbnailBasename) {
      const resourcePath = this.resolveAttachmentResource(file, thumbnailBasename);
      if (resourcePath) {
        const thumbWrap = body.createDiv({ cls: "obsidrop-card-thumbnail" });
        const img = thumbWrap.createEl("img");
        img.src = resourcePath;
        img.alt = "";
        img.loading = "lazy";
        // Als het bestand niet bestaat (broken link), verberg de thumbnail-wrap.
        img.addEventListener("error", () => thumbWrap.remove());
      }
    }

    body.createEl("h3", { cls: "obsidrop-card-title", text: titleText });

    if (previewText) {
      const preview = body.createDiv({ cls: "obsidrop-card-preview" });
      preview.innerHTML = renderInlinePreviewHtml(previewText);
      preview.addEventListener("click", (e) => this.handlePreviewClick(e));
    }

    if (meta.tags.length > 0) {
      const tagWrap = body.createDiv({ cls: "obsidrop-card-tags" });
      for (const tag of meta.tags) {
        tagWrap.createSpan({ cls: "obsidrop-card-tag", text: `#${tag}` });
      }
    }

    const actions = cardEl.createDiv({ cls: "obsidrop-card-actions" });

    const pinBtn = actions.createEl("button", {
      cls: `obsidrop-card-action${meta.pinned ? " is-active" : ""}`,
      attr: { "aria-label": meta.pinned ? t("action_unpin") : t("action_pin") },
    });
    setIcon(pinBtn, meta.pinned ? "pin-off" : "pin");
    pinBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await updateMeta(this.app, file, { pinned: !meta.pinned });
      this.plugin.refreshViews();
    });

    const colorBtn = actions.createEl("button", {
      cls: "obsidrop-card-action",
      attr: { "aria-label": t("action_color") },
    });
    setIcon(colorBtn, "palette");
    colorBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showColorMenu(e, file, meta, cardEl);
    });

    const editBtn = actions.createEl("button", {
      cls: "obsidrop-card-action",
      attr: { "aria-label": t("action_edit") },
    });
    setIcon(editBtn, "pencil");
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      new EditNoteModal(this.app, this.plugin, file).open();
    });

    const archiveBtn = actions.createEl("button", {
      cls: "obsidrop-card-action",
      attr: { "aria-label": archived ? t("action_unarchive") : t("action_archive") },
    });
    setIcon(archiveBtn, archived ? "archive-restore" : "archive");
    archiveBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await this.toggleArchive(file, archived);
    });

    const moreBtn = actions.createEl("button", {
      cls: "obsidrop-card-action",
      attr: { "aria-label": t("action_more") },
    });
    setIcon(moreBtn, "more-vertical");
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem((i) =>
        i
          .setTitle(t("action_open_in_tab"))
          .setIcon("file-plus")
          .onClick(async () => {
            await this.app.workspace.getLeaf("tab").openFile(file);
          })
      );
      menu.addItem((i) =>
        i
          .setTitle(t("action_delete"))
          .setIcon("trash-2")
          .onClick(async () => {
            await this.app.vault.trash(file, true);
            new Notice(t("notice_deleted", file.basename));
            this.plugin.refreshViews();
          })
      );
      menu.showAtMouseEvent(e);
    });
  }

  private handlePreviewClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const wiki = target.closest(".obsidrop-wikilink") as HTMLElement | null;
    if (wiki) {
      e.preventDefault();
      e.stopPropagation();
      const href = wiki.dataset.href;
      if (!href) return;
      const dest = this.app.metadataCache.getFirstLinkpathDest(href, "");
      if (dest) {
        void this.app.workspace.getLeaf(false).openFile(dest);
      } else {
        new Notice(t("notice_note_not_found", href));
      }
      return;
    }
    const url = target.closest(".obsidrop-url") as HTMLElement | null;
    if (url) {
      e.preventDefault();
      e.stopPropagation();
      const href = url.dataset.href;
      if (href) this.showLinkBar(url, href);
    }
  }

  private showLinkBar(anchor: HTMLElement, href: string): void {
    document.body.querySelectorAll(".obsidrop-link-bar").forEach((el) => el.remove());

    const bar = document.body.createDiv({ cls: "obsidrop-link-bar" });
    const urlSpan = bar.createSpan({ cls: "obsidrop-link-bar-url" });
    urlSpan.setText(href.length > 60 ? `${href.slice(0, 57)}…` : href);
    const openBtn = bar.createEl("button", {
      cls: "obsidrop-link-bar-open",
      text: t("action_open_link"),
    });
    const closeBtn = bar.createEl("button", {
      cls: "obsidrop-link-bar-close",
      attr: { "aria-label": t("action_close") },
      text: "×",
    });

    const dismiss = () => {
      if (bar.isConnected) bar.remove();
      document.removeEventListener("click", outsideHandler, true);
      window.clearTimeout(timer);
    };
    openBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      window.open(href, "_blank", "noopener,noreferrer");
      dismiss();
    });
    closeBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      dismiss();
    });

    const outsideHandler = (ev: MouseEvent) => {
      if (!bar.contains(ev.target as Node)) dismiss();
    };
    setTimeout(() => document.addEventListener("click", outsideHandler, true), 0);
    const timer = window.setTimeout(dismiss, 4500);

    const rect = anchor.getBoundingClientRect();
    bar.style.position = "fixed";
    bar.style.zIndex = "9999";
    // Tijdelijk renderen om de bar-breedte te kennen, dan correct positioneren.
    const barRect = bar.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(window.innerWidth - barRect.width - 8, rect.left),
    );
    const top = rect.bottom + 6 + barRect.height > window.innerHeight
      ? rect.top - barRect.height - 6
      : rect.bottom + 6;
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
  }

  private showColorMenu(event: MouseEvent, file: TFile, meta: NoteMeta, cardEl: HTMLElement): void {
    const menu = new Menu();
    for (const name of COLOR_NAMES) {
      menu.addItem((i) =>
        i
          .setTitle(colorLabel(name))
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
  // Ook diagnostische HTML-comments uit Android (<!-- obsidrop-preview: … -->,
  // plus oudere `diexar-preview`-marker voor backward compat met al gesyncde notities).
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^!\[\[[^\]]+\]\]$/.test(l))
    .filter((l) => !/^!\[[^\]]*\]\([^)]+\)$/.test(l))
    .filter((l) => !/^<!--\s*(?:obsidrop|diexar)-preview:.*-->$/.test(l));
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

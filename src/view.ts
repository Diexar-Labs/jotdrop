import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import type JotDropPlugin from "./main";
import { QuickCaptureModal } from "./capture";
import { EditNoteModal } from "./edit";
import { LightboxModal } from "./lightbox";
import { FolderPickerModal } from "./folderPicker";
import { TagPickerModal, TagItem } from "./tagPicker";
import { ConfirmModal } from "./confirmModal";
import { VoiceMemoRecorder, RecordResult } from "./recorder";
import {
  colorLabel,
  COLOR_NAMES,
  DEFAULT_META,
  formatReminderShort,
  NoteMeta,
  parseReminderMs,
  readMeta,
  renderInlinePreview,
  stripFrontmatter,
  updateMeta,
} from "./metadata";
import { voidAsync } from "./asyncUtil";
import { t } from "./i18n";

export const VIEW_TYPE_JOTDROP = "jotdrop-view";

const TITLE_MAX_WORDS = 10;
const PREVIEW_MAX_WORDS = 25;
const LINK_CHIPS_VISIBLE = 3;
const TAG_CHIPS_TOP_N = 8;
const LONG_PRESS_MS = 500;

// Mirrors Storage.findEmbeddedImageBasenames / findEmbeddedAudioBasenames in
// the Android app. Covers both Obsidian-style `![[name.ext]]` and standard
// `![](path/name.ext)`. Both forms are extension-filtered — otherwise a
// `![[memo.m4a]]` ends up in image detection and the card thumbnail slot
// reserves space for an image that never loads.
const EMBED_OBSIDIAN_RE = /!\[\[([^\]\n|]+)(?:\|[^\]\n]+)?\]\]/g;
const EMBED_STANDARD_RE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const IMAGE_EXT_RE = /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i;
const AUDIO_EXT_RE = /\.(m4a|mp3|wav|ogg|aac|flac|3gp|amr|webm)$/i;

function collectEmbedBasenames(content: string, accept: (name: string) => boolean): string[] {
  const result = new Set<string>();
  for (const m of content.matchAll(EMBED_OBSIDIAN_RE)) {
    const name = m[1].trim().split("/").pop() ?? "";
    if (name && accept(name)) result.add(name);
  }
  for (const m of content.matchAll(EMBED_STANDARD_RE)) {
    const path = m[1].trim();
    const name = (path.split("/").pop() ?? "").split("?")[0].split("#")[0];
    if (name && accept(name)) result.add(name);
  }
  return Array.from(result);
}

function findEmbeddedImageBasenames(content: string): string[] {
  return collectEmbedBasenames(content, (n) => IMAGE_EXT_RE.test(n));
}

function findEmbeddedAudioBasenames(content: string): string[] {
  return collectEmbedBasenames(content, (n) => AUDIO_EXT_RE.test(n));
}

/** Image + audio combined — used by the delete flow for refcount + cleanup. */
function findEmbeddedAttachmentBasenames(content: string): string[] {
  return collectEmbedBasenames(content, (n) => IMAGE_EXT_RE.test(n) || AUDIO_EXT_RE.test(n));
}

function formatMemoDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatStamp(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
const LONG_PRESS_MOVE_THRESHOLD_PX = 10;

interface CardData {
  file: TFile;
  content: string;
  meta: NoteMeta;
  archived: boolean;
}

export class JotDropView extends ItemView {
  plugin: JotDropPlugin;
  private gridEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private filterBarEl!: HTMLElement;
  private normalToolbarEl!: HTMLElement;
  private selectionToolbarEl!: HTMLElement;
  private selectionCountEl!: HTMLElement;
  private selectAllBtn!: HTMLButtonElement;
  private query = "";
  private selectedTags = new Set<string>();
  private selectionMode = false;
  private selectedPaths = new Set<string>();
  private lastFiltered: CardData[] = [];
  private micBtnEl: HTMLButtonElement | null = null;
  private recorder: VoiceMemoRecorder | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: JotDropPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_JOTDROP;
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
    root.addClass("jotdrop-view");

    this.normalToolbarEl = root.createDiv({ cls: "jotdrop-toolbar" });

    const newBtn = this.normalToolbarEl.createEl("button", { cls: "jotdrop-new-btn" });
    setIcon(newBtn.createSpan({ cls: "jotdrop-new-btn-icon" }), "plus");
    newBtn.createSpan({ text: t("action_new_note") });
    newBtn.addEventListener("click", () => {
      new QuickCaptureModal(this.app, this.plugin).open();
    });

    this.micBtnEl = this.normalToolbarEl.createEl("button", {
      cls: "jotdrop-mic-btn",
      attr: { "aria-label": t("action_start_recording") },
    });
    setIcon(this.micBtnEl, "mic");
    this.micBtnEl.addEventListener("click", () => void this.toggleRecord());

    this.searchEl = this.normalToolbarEl.createEl("input", {
      cls: "jotdrop-search",
      attr: { type: "search", placeholder: t("search_placeholder") },
    });
    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value.toLowerCase();
      void this.render();
    });

    this.selectionToolbarEl = root.createDiv({
      cls: "jotdrop-toolbar jotdrop-selection-toolbar is-hidden",
    });
    this.buildSelectionToolbar();

    this.filterBarEl = root.createDiv({ cls: "jotdrop-filter-bar" });
    this.gridEl = root.createDiv({ cls: "jotdrop-grid" });
    this.applyCardWidth();

    // Escape exits selection mode (counterpart of Android's BackHandler).
    this.registerDomEvent(activeDocument, "keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && this.selectionMode) {
        ev.preventDefault();
        this.exitSelection();
      }
    });

    await this.render();
  }

  private buildSelectionToolbar(): void {
    const bar = this.selectionToolbarEl;
    bar.empty();

    const exitBtn = bar.createEl("button", {
      cls: "jotdrop-selection-exit",
      attr: { "aria-label": t("action_exit_selection") },
    });
    setIcon(exitBtn, "x");
    exitBtn.addEventListener("click", () => this.exitSelection());

    this.selectionCountEl = bar.createDiv({ cls: "jotdrop-selection-count" });

    const spacer = bar.createDiv({ cls: "jotdrop-selection-spacer" });
    void spacer;

    this.selectAllBtn = bar.createEl("button", {
      cls: "jotdrop-selection-action",
      attr: { "aria-label": t("action_select_all") },
    });
    setIcon(this.selectAllBtn, "check-check");
    this.selectAllBtn.addEventListener("click", () => this.selectAllFiltered());

    const archiveBtn = bar.createEl("button", {
      cls: "jotdrop-selection-action",
      attr: { "aria-label": t("action_archive") },
    });
    setIcon(archiveBtn, "archive");
    archiveBtn.addEventListener("click", () => this.confirmBulkArchive());

    const deleteBtn = bar.createEl("button", {
      cls: "jotdrop-selection-action is-destructive",
      attr: { "aria-label": t("action_delete") },
    });
    setIcon(deleteBtn, "trash-2");
    deleteBtn.addEventListener("click", () => this.confirmBulkDelete());
  }

  private updateSelectionToolbar(): void {
    if (!this.selectionCountEl) return;
    this.selectionCountEl.setText(
      t("selection_count", String(this.selectedPaths.size)),
    );
    const allSelected =
      this.lastFiltered.length > 0 &&
      this.lastFiltered.every((c) => this.selectedPaths.has(c.file.path));
    this.selectAllBtn.toggleClass("is-active", allSelected);
  }

  private enterSelection(initialPath: string): void {
    this.selectionMode = true;
    this.selectedPaths = new Set([initialPath]);
    this.normalToolbarEl.toggleClass("is-hidden", true);
    this.filterBarEl.toggleClass("is-hidden", true);
    this.selectionToolbarEl.toggleClass("is-hidden", false);
    this.contentEl.toggleClass("is-selecting", true);
    this.updateSelectionToolbar();
    void this.render();
  }

  private exitSelection(): void {
    this.selectionMode = false;
    this.selectedPaths.clear();
    this.normalToolbarEl.toggleClass("is-hidden", false);
    this.selectionToolbarEl.toggleClass("is-hidden", true);
    this.contentEl.toggleClass("is-selecting", false);
    void this.render();
  }

  private toggleSelect(path: string): void {
    if (this.selectedPaths.has(path)) this.selectedPaths.delete(path);
    else this.selectedPaths.add(path);
    if (this.selectedPaths.size === 0) {
      // Auto-exit on last deselect — counterpart of Android behavior.
      this.exitSelection();
      return;
    }
    this.updateSelectionToolbar();
    // Update only the affected card visually instead of a full re-render —
    // otherwise the user loses scroll position on every toggle. Looping
    // is more robust than an attribute selector on file paths (which contain
    // slashes, dots and possibly quotes that are awkward to CSS-escape).
    const cards = this.gridEl.querySelectorAll<HTMLElement>(".jotdrop-card");
    for (const c of Array.from(cards)) {
      if (c.dataset.path === path) {
        this.applyCardSelectionVisual(c, this.selectedPaths.has(path));
        break;
      }
    }
  }

  private selectAllFiltered(): void {
    if (this.lastFiltered.length === 0) return;
    const allPaths = this.lastFiltered.map((c) => c.file.path);
    const allSelected = allPaths.every((p) => this.selectedPaths.has(p));
    if (allSelected) {
      for (const p of allPaths) this.selectedPaths.delete(p);
    } else {
      for (const p of allPaths) this.selectedPaths.add(p);
    }
    if (this.selectedPaths.size === 0) {
      this.exitSelection();
      return;
    }
    this.updateSelectionToolbar();
    void this.render();
  }

  private applyCardSelectionVisual(cardEl: HTMLElement, selected: boolean): void {
    cardEl.toggleClass("is-selected", selected);
    const marker = cardEl.querySelector(".jotdrop-card-select-marker");
    if (marker instanceof HTMLElement) {
      marker.empty();
      setIcon(marker, selected ? "check-circle-2" : "circle");
    }
  }

  /**
   * One button starts and stops recording. The stop path opens a confirm
   * modal with duration + Save/Cancel. Mic permission is requested by the
   * browser/Electron on `getUserMedia` — no separate permission flow needed.
   */
  private async toggleRecord(): Promise<void> {
    if (this.recorder?.isRecording()) {
      const result = await this.recorder.stop();
      this.setMicButtonState(false);
      this.recorder = null;
      if (!result) {
        new Notice(t("record_too_short"));
        return;
      }
      this.openRecordConfirm(result);
      return;
    }
    try {
      const rec = new VoiceMemoRecorder();
      await rec.start();
      this.recorder = rec;
      this.setMicButtonState(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(t("record_start_failed", msg));
    }
  }

  private setMicButtonState(recording: boolean): void {
    if (!this.micBtnEl) return;
    this.micBtnEl.empty();
    setIcon(this.micBtnEl, recording ? "square" : "mic");
    this.micBtnEl.toggleClass("is-recording", recording);
    this.micBtnEl.setAttribute(
      "aria-label",
      t(recording ? "action_stop_recording" : "action_start_recording"),
    );
  }

  private openRecordConfirm(result: RecordResult): void {
    const durationLabel = formatMemoDuration(result.durationMs);
    new ConfirmModal(
      this.app,
      {
        title: t("record_confirm_title"),
        message: t("record_confirm_message", durationLabel),
        confirmLabel: t("action_save"),
      },
      () => void this.saveVoiceMemo(result),
    ).open();
  }

  private async saveVoiceMemo(result: RecordResult): Promise<void> {
    const stamp = formatStamp(new Date());
    const basename = `diexar-${stamp}.${result.extension}`;
    const notesFolder = this.plugin.settings.notesFolder;
    const attachmentsDir = normalizePath(`${notesFolder}/.attachments`);
    const attachmentPath = normalizePath(`${attachmentsDir}/${basename}`);
    try {
      if (!(await this.app.vault.adapter.exists(attachmentsDir))) {
        await this.app.vault.adapter.mkdir(attachmentsDir);
      }
      const buf = await result.blob.arrayBuffer();
      await this.app.vault.adapter.writeBinary(attachmentPath, buf);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(t("record_save_failed", msg));
      return;
    }

    const durationLabel = formatMemoDuration(result.durationMs);
    const title = `Voicememo ${stamp}`;
    const body = [
      `# ${title}`,
      "",
      `![[${basename}]]`,
      "",
      durationLabel,
      "",
    ].join("\n");
    const safeTitle = title.replace(/[\\/:*?"<>|]/g, "");
    const notePath = normalizePath(`${notesFolder}/${safeTitle}.md`);
    try {
      if (!(await this.app.vault.adapter.exists(notesFolder))) {
        await this.app.vault.adapter.mkdir(notesFolder);
      }
      await this.app.vault.create(notePath, body);
      new Notice(t("record_saved"));
      void this.render();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(t("record_save_failed", msg));
    }
  }

  private confirmBulkArchive(): void {
    const count = this.selectedPaths.size;
    if (count === 0) return;
    new ConfirmModal(
      this.app,
      {
        title: t("bulk_archive_title", String(count)),
        message: t("bulk_archive_message"),
        confirmLabel: t("action_archive"),
      },
      () => void this.bulkArchive(),
    ).open();
  }

  private confirmBulkDelete(): void {
    const count = this.selectedPaths.size;
    if (count === 0) return;
    new ConfirmModal(
      this.app,
      {
        title: t("bulk_delete_title", String(count)),
        message: t("bulk_delete_message"),
        confirmLabel: t("action_delete"),
        destructive: true,
      },
      () => void this.bulkDelete(),
    ).open();
  }

  private async bulkArchive(): Promise<void> {
    // Snapshot of paths — selection may change during the operation
    // (unlikely) and we want to work sequentially.
    const paths = Array.from(this.selectedPaths);
    const archiveFolder = normalizePath(this.plugin.settings.archiveFolder);
    if (!this.app.vault.getAbstractFileByPath(archiveFolder)) {
      try {
        await this.app.vault.createFolder(archiveFolder);
      } catch {
        // May already exist; the rename below will still fail gracefully per file.
      }
    }
    let ok = 0;
    let fail = 0;
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        fail++;
        continue;
      }
      try {
        const newPath = normalizePath(`${archiveFolder}/${file.name}`);
        if (this.app.vault.getAbstractFileByPath(newPath)) {
          fail++;
          continue;
        }
        await this.app.fileManager.renameFile(file, newPath);
        ok++;
      } catch {
        fail++;
      }
    }
    this.reportBulkResult("notice_bulk_archived", ok, fail);
    this.exitSelection();
  }

  private async bulkDelete(): Promise<void> {
    const paths = Array.from(this.selectedPaths);
    // Refcount set pre-computed once: OG thumbnails are URL-hashed and can be
    // shared between cards. Only attachments that are not referenced anywhere
    // outside the selection may go to the trash.
    const stillReferenced = await this.collectReferencedAttachmentBasenames(new Set(paths));
    let ok = 0;
    let fail = 0;
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        fail++;
        continue;
      }
      try {
        await this.trashNoteWithOrphanedAttachments(file, stillReferenced);
        ok++;
      } catch {
        fail++;
      }
    }
    this.reportBulkResult("notice_bulk_deleted", ok, fail);
    this.exitSelection();
  }

  /**
   * Scans all markdown files in the vault — excluding [excludePaths] —
   * and returns the set of attachment basenames still in use. Mirrors
   * Storage.collectReferencedAttachments() in the Android app.
   */
  private async collectReferencedAttachmentBasenames(
    excludePaths: Set<string>,
  ): Promise<Set<string>> {
    const result = new Set<string>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (excludePaths.has(f.path)) continue;
      try {
        const content = await this.app.vault.cachedRead(f);
        for (const name of findEmbeddedAttachmentBasenames(content)) result.add(name);
      } catch {
        // An unreadable file must not block the cleanup.
      }
    }
    return result;
  }

  /**
   * Deletes orphaned attachments first (basenames not in [stillReferenced])
   * and then the note itself — both to the OS recycle bin so recovery is
   * possible. Attachments are looked up via multiple candidate paths because
   * Obsidian's metadataCache skips dot-prefixed folders (`.attachments/`).
   */
  private async trashNoteWithOrphanedAttachments(
    file: TFile,
    stillReferenced: Set<string>,
  ): Promise<void> {
    try {
      const content = await this.app.vault.cachedRead(file);
      for (const name of findEmbeddedAttachmentBasenames(content)) {
        if (stillReferenced.has(name)) continue;
        await this.trashAttachmentByBasename(file, name);
      }
    } catch {
      // Cleanup failures must not block the note deletion.
    }
    await this.app.fileManager.trashFile(file);
  }

  private async trashAttachmentByBasename(noteFile: TFile, basename: string): Promise<void> {
    const dest = this.app.metadataCache.getFirstLinkpathDest(basename, noteFile.path);
    if (dest) {
      try {
        await this.app.fileManager.trashFile(dest);
        return;
      } catch {
        // fall through to adapter lookup
      }
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
      const np = normalizePath(p);
      try {
        if (await this.app.vault.adapter.exists(np)) {
          await this.app.vault.adapter.trashSystem(np);
          return;
        }
      } catch {
        // try next candidate
      }
    }
  }

  /**
   * Long-press detection via pointer events (works for mouse and touch).
   * Timer starts on pointerdown, cancels on movement > threshold or pointerup.
   * On fire: enter selection mode (or toggle if already active). The subsequent
   * click event is consumed in the capture phase so normal click handlers do not also fire.
   */
  private attachLongPress(cardEl: HTMLElement, path: string): void {
    let timer: number | null = null;
    let startX = 0;
    let startY = 0;
    let fired = false;

    const cancel = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    cardEl.addEventListener("pointerdown", (e: PointerEvent) => {
      // Primary button / touch / pen only — leave right-click alone.
      if (e.button !== 0 && e.pointerType === "mouse") return;
      startX = e.clientX;
      startY = e.clientY;
      fired = false;
      cancel();
      timer = window.setTimeout(() => {
        timer = null;
        fired = true;
        if (this.selectionMode) this.toggleSelect(path);
        else this.enterSelection(path);
      }, LONG_PRESS_MS);
    });

    cardEl.addEventListener("pointermove", (e: PointerEvent) => {
      if (timer === null) return;
      if (
        Math.abs(e.clientX - startX) > LONG_PRESS_MOVE_THRESHOLD_PX ||
        Math.abs(e.clientY - startY) > LONG_PRESS_MOVE_THRESHOLD_PX
      ) {
        cancel();
      }
    });
    cardEl.addEventListener("pointerup", cancel);
    cardEl.addEventListener("pointercancel", cancel);
    cardEl.addEventListener("pointerleave", cancel);

    cardEl.addEventListener(
      "click",
      (e) => {
        if (fired) {
          // Long-press already acted; consume the subsequent click.
          fired = false;
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true,
    );
  }

  private reportBulkResult(successKey: string, ok: number, fail: number): void {
    if (fail === 0) {
      new Notice(t(successKey, String(ok)));
    } else if (ok === 0) {
      new Notice(t("notice_error", t("notice_bulk_partial", "0", String(fail))));
    } else {
      new Notice(t("notice_bulk_partial", String(ok), String(fail)));
    }
  }

  async onClose(): Promise<void> {
    // Release the mic stream if the view closes mid-recording.
    this.recorder?.discard();
    this.recorder = null;
    this.contentEl.empty();
  }

  applyCardWidth(): void {
    if (this.gridEl) {
      this.gridEl.style.setProperty("--jotdrop-card-width", `${this.plugin.settings.cardWidth}px`);
    }
  }

  async render(): Promise<void> {
    if (!this.gridEl) return;
    this.applyCardWidth();
    this.gridEl.empty();

    const cards = await this.collectCards();
    this.renderFilterBar(cards);

    // Drop selected tags that no longer exist after note mutations, so the
    // user cannot get stuck with a "dead" filter.
    const tagFreq = computeTagFrequency(cards);
    for (const sel of Array.from(this.selectedTags)) {
      if (!tagFreq.has(sel)) this.selectedTags.delete(sel);
    }

    const filtered = cards.filter((c) => this.matchesFilters(c));
    this.lastFiltered = filtered;

    // Drop selected paths that are outside the current filtered set or no
    // longer exist, otherwise "N selected" counts incorrectly after a filter
    // change or file deletion. (Selection mode itself stays until the user
    // presses × or Escape.)
    const allPaths = new Set(cards.map((c) => c.file.path));
    for (const p of Array.from(this.selectedPaths)) {
      if (!allPaths.has(p)) this.selectedPaths.delete(p);
    }
    if (this.selectionMode) this.updateSelectionToolbar();

    if (filtered.length === 0) {
      const empty = this.gridEl.createDiv({ cls: "jotdrop-empty" });
      if (cards.length === 0) {
        empty.createEl("h3", { text: t("empty_no_notes_title") });
        empty.createEl("p", { text: t("empty_no_notes_desc") });
      } else {
        empty.createEl("h3", { text: t("empty_no_results") });
        const clearBtn = empty.createEl("button", {
          cls: "jotdrop-empty-clear",
          text: t("empty_no_results_clear"),
        });
        clearBtn.addEventListener("click", () => this.clearAllFilters());
      }
      return;
    }

    const pinned = filtered.filter((c) => c.meta.pinned);
    const rest = filtered.filter((c) => !c.meta.pinned);

    if (pinned.length > 0) {
      const pinnedSection = this.gridEl.createDiv({ cls: "jotdrop-section" });
      pinnedSection.createDiv({ cls: "jotdrop-section-label", text: t("section_pinned") });
      const pinnedGrid = pinnedSection.createDiv({ cls: "jotdrop-grid-inner" });
      for (const c of pinned) this.renderCard(pinnedGrid, c);

      const restSection = this.gridEl.createDiv({ cls: "jotdrop-section" });
      restSection.createDiv({ cls: "jotdrop-section-label", text: t("section_other") });
      const restGrid = restSection.createDiv({ cls: "jotdrop-grid-inner" });
      for (const c of rest) this.renderCard(restGrid, c);
    } else {
      const inner = this.gridEl.createDiv({ cls: "jotdrop-grid-inner" });
      for (const c of rest) this.renderCard(inner, c);
    }
  }

  /**
   * Builds the tag-chip strip below the toolbar: top-N by frequency + always
   * also any selected tags that fall outside the top (otherwise a selected tag
   * would disappear after a new note with different tags is added).
   * Shows a "+N more" chip when tags remain; opens TagPickerModal.
   */
  private renderFilterBar(cards: CardData[]): void {
    if (!this.filterBarEl) return;
    this.filterBarEl.empty();

    const tagFreq = computeTagFrequency(cards);
    if (tagFreq.size === 0) {
      this.filterBarEl.toggleClass("is-hidden", true);
      return;
    }
    this.filterBarEl.toggleClass("is-hidden", false);

    const byFreqDesc = Array.from(tagFreq.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const top = byFreqDesc.slice(0, TAG_CHIPS_TOP_N).map(([tag]) => tag);
    const topSet = new Set(top);
    const extraSelected = Array.from(this.selectedTags)
      .filter((t) => !topSet.has(t) && tagFreq.has(t))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const visibleTags = [...top, ...extraSelected];
    const overflowCount = Math.max(0, tagFreq.size - visibleTags.length);

    for (const tag of visibleTags) {
      this.renderTagChip(tag, this.selectedTags.has(tag));
    }

    if (overflowCount > 0) {
      const more = this.filterBarEl.createEl("button", {
        cls: "jotdrop-filter-chip is-overflow",
        text: t("tag_overflow_more", String(overflowCount)),
      });
      more.addEventListener("click", () => {
        const items: TagItem[] = byFreqDesc
          .map(([tag, count]) => ({ tag, count }))
          .sort((a, b) =>
            a.tag.toLowerCase().localeCompare(b.tag.toLowerCase()),
          );
        new TagPickerModal(
          this.app,
          items,
          this.selectedTags,
          (tag) => this.toggleTagFilter(tag),
        ).open();
      });
    }

    if (this.selectedTags.size > 0) {
      const clear = this.filterBarEl.createEl("button", {
        cls: "jotdrop-filter-clear",
        text: t("tag_filter_clear"),
      });
      clear.addEventListener("click", () => {
        this.selectedTags.clear();
        void this.render();
      });
    }
  }

  private renderTagChip(tag: string, isSelected: boolean): void {
    const chip = this.filterBarEl.createEl("button", {
      cls: `jotdrop-filter-chip${isSelected ? " is-selected" : ""}`,
    });
    // Explicit ✓ symbol — color alone is insufficient (color-blind parity
    // with the Android FilterChip that also shows a Done icon).
    const check = chip.createSpan({ cls: "jotdrop-filter-chip-check" });
    check.setText(isSelected ? "✓" : "");
    chip.createSpan({ cls: "jotdrop-filter-chip-label", text: `#${tag}` });
    chip.addEventListener("click", () => this.toggleTagFilter(tag));
  }

  private toggleTagFilter(tag: string): void {
    if (this.selectedTags.has(tag)) this.selectedTags.delete(tag);
    else this.selectedTags.add(tag);
    void this.render();
  }

  private clearAllFilters(): void {
    this.selectedTags.clear();
    this.query = "";
    if (this.searchEl) this.searchEl.value = "";
    void this.render();
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

  /**
   * AND between search text and tag filter; OR within selected tags
   * (a note matches as soon as it has at least one of the selected tags).
   */
  private matchesFilters(card: CardData): boolean {
    const q = this.query;
    const matchesQuery =
      !q ||
      card.file.basename.toLowerCase().includes(q) ||
      card.content.toLowerCase().includes(q) ||
      card.meta.tags.some((t) => t.toLowerCase().includes(q));
    if (!matchesQuery) return false;

    if (this.selectedTags.size === 0) return true;
    return card.meta.tags.some((t) => this.selectedTags.has(t));
  }

  private renderCard(parent: HTMLElement, card: CardData): void {
    const { file, content, meta, archived } = card;
    const isSelected = this.selectedPaths.has(file.path);
    const cardEl = parent.createDiv({
      cls: [
        "jotdrop-card",
        archived ? "is-archived" : "",
        meta.pinned ? "is-pinned" : "",
        isSelected ? "is-selected" : "",
      ].filter(Boolean).join(" "),
    });
    cardEl.dataset.path = file.path;
    if (meta.color !== "default") {
      cardEl.dataset.color = meta.color;
    }

    this.attachLongPress(cardEl, file.path);

    // Selection-marker overlay (top-right). Shape-based (filled vs empty
    // circle icon) so selected state is visible without color perception.
    // Shown only in selection mode via CSS.
    const marker = cardEl.createSpan({ cls: "jotdrop-card-select-marker" });
    setIcon(marker, isSelected ? "check-circle-2" : "circle");

    const titleText = extractTitle(content, file.basename);
    const previewText = extractPreview(content);
    const urls = extractUrls(content);

    const body = cardEl.createDiv({ cls: "jotdrop-card-body" });

    const thumbnailBasename = extractFirstEmbeddedImage(content);
    const attachment = thumbnailBasename
      ? this.resolveAttachmentResource(file, thumbnailBasename)
      : null;
    // Voice-memo cards have no image thumb but do have an audio embed —
    // show an equalizer banner so the card type is visually recognizable.
    const audioBasename = attachment ? null : extractFirstEmbeddedAudio(content);

    // Body click = always edit (or toggle when in selection mode).
    // Thumbnail gets its own handler with stopPropagation for the lightbox,
    // otherwise the user can no longer reach the card's text.
    body.addEventListener("click", () => {
      if (this.selectionMode) { this.toggleSelect(file.path); return; }
      new EditNoteModal(this.app, this.plugin, file).open();
    });

    if (attachment) {
      const thumbWrap = body.createDiv({ cls: "jotdrop-card-thumbnail" });
      const img = thumbWrap.createEl("img");
      img.src = attachment.resourcePath;
      img.alt = "";
      img.loading = "lazy";
      // If the file does not exist (broken link), hide the thumbnail wrapper.
      img.addEventListener("error", () => thumbWrap.remove());
      thumbWrap.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.selectionMode) { this.toggleSelect(file.path); return; }
        new LightboxModal(
          this.app,
          this.plugin,
          file,
          attachment.resourcePath,
          attachment.file,
          attachment.vaultPath,
        ).open();
      });
    } else if (audioBasename) {
      const banner = body.createDiv({ cls: "jotdrop-card-voice-banner" });
      banner.setAttribute("aria-label", t("voice_memo_card_label"));
      const iconEl = banner.createSpan({ cls: "jotdrop-card-voice-icon" });
      setIcon(iconEl, "audio-lines");
    }

    body.createEl("h3", { cls: "jotdrop-card-title", text: titleText });

    if (meta.reminder) {
      const ms = parseReminderMs(meta.reminder);
      if (Number.isFinite(ms)) {
        const overdue = ms < Date.now();
        const badge = body.createDiv({
          cls: `jotdrop-card-reminder${overdue ? " is-overdue" : ""}`,
        });
        badge.createSpan({
          cls: "jotdrop-card-reminder-label",
          text: overdue ? t("reminder_badge_overdue") : t("reminder_badge_due"),
        });
        badge.createSpan({
          cls: "jotdrop-card-reminder-rel",
          text: formatReminderShort(meta.reminder),
        });
      }
    }

    if (previewText) {
      const preview = body.createDiv({ cls: "jotdrop-card-preview" });
      renderInlinePreview(preview, previewText);
      preview.addEventListener("click", (e) => {
        if (this.selectionMode) {
          e.stopPropagation();
          this.toggleSelect(file.path);
          return;
        }
        this.handlePreviewClick(e);
      });
    }

    if (urls.length > 0) {
      const linkWrap = body.createDiv({ cls: "jotdrop-card-links" });
      for (const url of urls.slice(0, LINK_CHIPS_VISIBLE)) {
        const chip = linkWrap.createEl("a", {
          cls: "jotdrop-card-link",
          text: hostnameOf(url),
          attr: { href: url, rel: "noopener noreferrer", title: url },
        });
        chip.addEventListener("click", (e) => {
          // Click on chip = open link, not trigger the edit modal.
          // In selection mode it becomes a toggle for the card instead.
          e.stopPropagation();
          e.preventDefault();
          if (this.selectionMode) { this.toggleSelect(file.path); return; }
          window.open(url, "_blank", "noopener,noreferrer");
        });
      }
      if (urls.length > LINK_CHIPS_VISIBLE) {
        const more = linkWrap.createSpan({
          cls: "jotdrop-card-link-more",
          text: `+${urls.length - LINK_CHIPS_VISIBLE}`,
          attr: { title: t("link_chip_more_tooltip") },
        });
        more.addEventListener("click", (e) => {
          // "+N" passes through to the card click → edit modal shows full content.
          // Do not stop.
          void e;
        });
      }
    }

    if (meta.tags.length > 0) {
      const tagWrap = body.createDiv({ cls: "jotdrop-card-tags" });
      for (const tag of meta.tags) {
        tagWrap.createSpan({ cls: "jotdrop-card-tag", text: `#${tag}` });
      }
    }

    const actions = cardEl.createDiv({ cls: "jotdrop-card-actions" });

    const pinBtn = actions.createEl("button", {
      cls: `jotdrop-card-action${meta.pinned ? " is-active" : ""}`,
      attr: { "aria-label": meta.pinned ? t("action_unpin") : t("action_pin") },
    });
    setIcon(pinBtn, meta.pinned ? "pin-off" : "pin");
    pinBtn.addEventListener("click", voidAsync(async (e) => {
      e.stopPropagation();
      await updateMeta(this.app, file, { pinned: !meta.pinned });
      this.plugin.refreshViews();
    }));

    const colorBtn = actions.createEl("button", {
      cls: "jotdrop-card-action",
      attr: { "aria-label": t("action_color") },
    });
    setIcon(colorBtn, "palette");
    colorBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showColorMenu(e, file, meta, cardEl);
    });

    const editBtn = actions.createEl("button", {
      cls: "jotdrop-card-action",
      attr: { "aria-label": t("action_edit") },
    });
    setIcon(editBtn, "pencil");
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      new EditNoteModal(this.app, this.plugin, file).open();
    });

    const archiveBtn = actions.createEl("button", {
      cls: "jotdrop-card-action",
      attr: { "aria-label": archived ? t("action_unarchive") : t("action_archive") },
    });
    setIcon(archiveBtn, archived ? "archive-restore" : "archive");
    archiveBtn.addEventListener("click", voidAsync(async (e) => {
      e.stopPropagation();
      await this.toggleArchive(file, archived);
    }));

    const moreBtn = actions.createEl("button", {
      cls: "jotdrop-card-action",
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
          .setTitle(t("action_move_to_folder"))
          .setIcon("folder-output")
          .onClick(() => {
            new FolderPickerModal(
              this.app,
              t("folder_picker_move_placeholder"),
              (folder) => { void this.moveNote(file, folder.path); },
            ).open();
          })
      );
      menu.addItem((i) =>
        i
          .setTitle(t("action_copy_to_folder"))
          .setIcon("copy")
          .onClick(() => {
            new FolderPickerModal(
              this.app,
              t("folder_picker_copy_placeholder"),
              (folder) => { void this.copyNote(file, folder.path); },
            ).open();
          })
      );
      menu.addItem((i) =>
        i
          .setTitle(t("action_delete"))
          .setIcon("trash-2")
          .onClick(async () => {
            const stillReferenced = await this.collectReferencedAttachmentBasenames(
              new Set([file.path]),
            );
            await this.trashNoteWithOrphanedAttachments(file, stillReferenced);
            new Notice(t("notice_deleted", file.basename));
            this.plugin.refreshViews();
          })
      );
      menu.showAtMouseEvent(e);
    });
  }

  private handlePreviewClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const wiki = target.closest<HTMLElement>(".jotdrop-wikilink");
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
    const url = target.closest<HTMLElement>(".jotdrop-url");
    if (url) {
      e.preventDefault();
      e.stopPropagation();
      const href = url.dataset.href;
      if (href) this.showLinkBar(url, href);
    }
  }

  private showLinkBar(anchor: HTMLElement, href: string): void {
    activeDocument.body.querySelectorAll(".jotdrop-link-bar").forEach((el) => el.remove());

    const bar = activeDocument.body.createDiv({ cls: "jotdrop-link-bar" });
    const urlSpan = bar.createSpan({ cls: "jotdrop-link-bar-url" });
    urlSpan.setText(href.length > 60 ? `${href.slice(0, 57)}…` : href);
    const openBtn = bar.createEl("button", {
      cls: "jotdrop-link-bar-open",
      text: t("action_open_link"),
    });
    const closeBtn = bar.createEl("button", {
      cls: "jotdrop-link-bar-close",
      attr: { "aria-label": t("action_close") },
      text: "×",
    });

    const dismiss = () => {
      if (bar.isConnected) bar.remove();
      activeDocument.removeEventListener("click", outsideHandler, true);
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
    window.setTimeout(() => activeDocument.addEventListener("click", outsideHandler, true), 0);
    const timer = window.setTimeout(dismiss, 4500);

    const rect = anchor.getBoundingClientRect();
    // Render temporarily to know the bar width, then position correctly.
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
            // In-place update: prevents re-rendering from moving the card to
            // the top because updateMeta bumps mtime and the grid re-sorts.
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
   * Resolves an embedded image to a resource path usable as `<img src>`.
   *
   * 1. Try Obsidian's metadataCache (finds standard attachments via vault lookup).
   * 2. Fall back to `<note-folder>/.attachments/<basename>` — Obsidian's metadataCache
   *    skips dot-prefixed folders (`.attachments/`, `.trash/`), but the adapter itself
   *    can read them. The Android share flow uses this convention.
   * 3. Fall back to `<notesFolder>/.attachments/<basename>` (configured notes folder).
   */
  private resolveAttachmentResource(
    noteFile: TFile,
    basename: string,
  ): { resourcePath: string; file: TFile | null; vaultPath: string } | null {
    const dest = this.app.metadataCache.getFirstLinkpathDest(basename, noteFile.path);
    if (dest) {
      return {
        resourcePath: this.app.vault.getResourcePath(dest),
        file: dest,
        vaultPath: dest.path,
      };
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
      // Adapter resource also works for dot-prefixed folders that metadataCache skips.
      // Existence check is async — img.onerror cleans up on failure.
      return {
        resourcePath: this.app.vault.adapter.getResourcePath(normalized),
        file: null,
        vaultPath: normalized,
      };
    }
    return null;
  }

  /**
   * Moves the note to a different folder. Afterwards it falls outside
   * `notesFolder` → disappears automatically from the view on refresh.
   */
  private async moveNote(file: TFile, targetFolder: string): Promise<void> {
    const target = normalizePath(`${targetFolder}/${file.name}`);
    if (target === file.path) return;
    if (this.app.vault.getAbstractFileByPath(target)) {
      new Notice(t("notice_target_exists"));
      return;
    }
    try {
      await this.app.fileManager.renameFile(file, target);
      new Notice(t("notice_moved", targetFolder || "/"));
    } catch (err) {
      new Notice(t("notice_error", err instanceof Error ? err.message : String(err)));
    }
    this.plugin.refreshViews();
  }

  /**
   * Makes a copy of the note in a different folder. The original stays in
   * `notesFolder`; embedded attachments are NOT copied (wikilinks keep working
   * because it is the same vault).
   */
  private async copyNote(file: TFile, targetFolder: string): Promise<void> {
    const target = normalizePath(`${targetFolder}/${file.name}`);
    if (target === file.path) return;
    if (this.app.vault.getAbstractFileByPath(target)) {
      new Notice(t("notice_target_exists"));
      return;
    }
    try {
      const content = await this.app.vault.read(file);
      if (!this.app.vault.getAbstractFileByPath(targetFolder) && targetFolder) {
        await this.app.vault.createFolder(targetFolder);
      }
      await this.app.vault.create(target, content);
      new Notice(t("notice_copied", targetFolder || "/"));
    } catch (err) {
      new Notice(t("notice_error", err instanceof Error ? err.message : String(err)));
    }
    this.plugin.refreshViews();
  }

  private async toggleArchive(file: TFile, currentlyArchived: boolean): Promise<void> {
    const archiveFolder = normalizePath(this.plugin.settings.archiveFolder);
    const notesFolder = normalizePath(this.plugin.settings.notesFolder);
    try {
      if (currentlyArchived) {
        const newPath = normalizePath(`${notesFolder}/${file.name}`);
        await this.app.fileManager.renameFile(file, newPath);
        new Notice(`Restored from archive: ${file.basename}`);
      } else {
        if (!this.app.vault.getAbstractFileByPath(archiveFolder)) {
          await this.app.vault.createFolder(archiveFolder);
        }
        const newPath = normalizePath(`${archiveFolder}/${file.name}`);
        await this.app.fileManager.renameFile(file, newPath);
        new Notice(`Archived: ${file.basename}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Error: ${message}`);
    }
    this.plugin.refreshViews();
  }
}

function computeTagFrequency(cards: CardData[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const c of cards) {
    for (const tag of c.meta.tags) {
      freq.set(tag, (freq.get(tag) ?? 0) + 1);
    }
  }
  return freq;
}

function isUnder(filePath: string, folderPath: string): boolean {
  if (!folderPath) return false;
  const f = folderPath.replace(/\/+$/, "");
  return filePath === f || filePath.startsWith(`${f}/`);
}

/**
 * Stable creation timestamp (ms) used for ordering. Reads the timestamp baked
 * into the filename (`YYYY-MM-DD HHMMSS …`, written by both the Android app and
 * the plugin at capture time), which never changes when a note is later edited
 * — unlike mtime. That is what kept cards jumping to the top on every open/edit.
 * Falls back to the filesystem creation time for notes without a stamped name.
 */
function noteCreatedMs(file: TFile): number {
  const m = file.basename.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2})(\d{2})(\d{2})/);
  if (m) {
    const ms = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  return file.stat.ctime;
}

function sortFiles(files: TFile[], mode: string): TFile[] {
  const sorted = [...files];
  switch (mode) {
    case "modified-asc":
      sorted.sort((a, b) => a.stat.mtime - b.stat.mtime);
      break;
    case "created-asc":
      sorted.sort((a, b) => noteCreatedMs(a) - noteCreatedMs(b));
      break;
    case "title-asc":
      sorted.sort((a, b) => a.basename.localeCompare(b.basename));
      break;
    case "modified-desc":
      sorted.sort((a, b) => b.stat.mtime - a.stat.mtime);
      break;
    // Stable, edit-proof order is the default: newest on top, older at the
    // bottom, and opening a card no longer reshuffles the grid.
    case "created-desc":
    default:
      sorted.sort((a, b) => noteCreatedMs(b) - noteCreatedMs(a));
      break;
  }
  return sorted;
}

/**
 * Title source: first non-blank, non-embed line. Markdown heading markers
 * (`#`, `*`, `_`, `` ` ``, `>`) are stripped. Result is truncated to
 * `TITLE_MAX_WORDS` with "…". Empty title → fall back to `fallback` (filename).
 */
function extractTitle(content: string, fallback: string): string {
  const body = stripFrontmatter(content);
  const lines = body.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  for (const line of lines) {
    if (/^!\[\[[^\]]+\]\]$/.test(line)) continue;
    if (/^!\[[^\]]*\]\([^)]+\)$/.test(line)) continue;
    if (/^<!--/.test(line)) continue;
    const cleaned = line.replace(/^#+\s*/, "").replace(/^[*_`>]+\s*/, "").trim();
    if (!cleaned) continue;
    return truncateWords(cleaned, TITLE_MAX_WORDS);
  }
  return fallback;
}

/**
 * Body for the card: without frontmatter, embeds, heading lines, URLs,
 * preview-comment markers. Truncated to `PREVIEW_MAX_WORDS` with "…".
 * URLs are stripped because they are shown separately as chips at the bottom.
 */
function extractPreview(content: string): string {
  const body = stripFrontmatter(content);
  const stripped = body
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/<!--\s*(?:jotdrop|diexar)-preview:.*?-->/g, "")
    .replace(/^\s{0,3}#+\s+.*$/gm, "")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "");
  const lines = stripped
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const rest = lines.join("\n");
  if (!rest) return "";
  return truncateWords(rest, PREVIEW_MAX_WORDS);
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}…`;
}

/**
 * Collects unique `http(s)://` URLs from the body, for the link chips.
 *
 * - Strips embeds so local image paths are excluded.
 * - Drops the first heading line (the title): a URL that is shown as the card
 *   title must not also appear as a separate link chip. This is what produced
 *   two identical links per card on shared TikTok videos — the short link
 *   (`vm.tiktok.com/…`) landed in the title heading while the canonical link
 *   sat in the markdown link.
 * - Parses markdown links `[text](url)` by their target and removes the whole
 *   construct, so a URL used as link *text* is never counted a second time.
 *
 * Dedupe is normalized (lowercase host, no `www.`, no trailing slash) so the
 * same page shared as `www.tiktok.com/x` and `tiktok.com/x/` collapses to one.
 * Insertion order is preserved.
 */
function extractUrls(content: string): string[] {
  let body = stripFrontmatter(content)
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "");
  // Remove the first heading line — its URL (if any) is the card title.
  body = body.replace(/^[ \t]*#{1,6}[ \t]+.*$/m, "");

  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string): void => {
    const clean = raw.replace(/[.,)\]}"'!?;:]+$/, "");
    if (!clean) return;
    const key = canonicalUrlKey(clean);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  };

  // Markdown link targets first; drop the whole `[text](url)` so a URL inside
  // the link text is not matched again below as a bare URL.
  body = body.replace(/\[[^\]\n]*\]\((https?:\/\/[^)\s]+)\)/g, (_m, url: string) => {
    push(url);
    return " ";
  });
  for (const raw of body.match(/https?:\/\/[^\s)<>"']+/g) || []) push(raw);
  return out;
}

/**
 * Normalized key for URL de-duplication: lowercase host without a leading
 * `www.`, path without a trailing slash. Query and hash are kept because they
 * can identify distinct content. Falls back to the trimmed lowercase string.
 */
function canonicalUrlKey(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}${u.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Finds the basename of the first embedded image in the note (extension-
 * filtered — voice memos are handled separately via [extractFirstEmbeddedAudio]).
 */
function extractFirstEmbeddedImage(content: string): string | null {
  return findEmbeddedImageBasenames(stripFrontmatter(content))[0] ?? null;
}

function extractFirstEmbeddedAudio(content: string): string | null {
  return findEmbeddedAudioBasenames(stripFrontmatter(content))[0] ?? null;
}

// Kept for backwards-compat in case main.ts imported this. No longer used.
export { DEFAULT_META };

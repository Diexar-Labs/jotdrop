import { App, Modal, Notice, SuggestModal, TFile, normalizePath, setIcon } from "obsidian";
import type JotDropPlugin from "./main";
import { toggleOrInsertChecklistOnTextArea } from "./capture";
import { LightboxModal } from "./lightbox";
import { voidAsync } from "./asyncUtil";
import { t } from "./i18n";
import {
  colorLabel,
  COLOR_NAMES,
  ColorName,
  getAllVaultTags,
  neutralizeInlineHashtags,
  readMeta,
  stripFrontmatter,
  updateMeta,
} from "./metadata";

/**
 * Snapshot of the card grid at the moment a note was opened: the files in
 * display order (pinned first, then the rest) plus the opened note's position.
 * Lets the modal step to the previous/next card without going back to the grid.
 */
export interface NoteNavContext {
  files: TFile[];
  index: number;
}

/** Minimum horizontal swipe distance (px) before it counts as navigation. */
const SWIPE_MIN_DISTANCE = 60;

interface EditableNote {
  file?: TFile;
  title: string;
  body: string;
  embedLines: string[];
  color: ColorName;
  tags: string[];
  pinned: boolean;
  reminder: string | null;
}

/**
 * Edit modal for an existing note. Shows color pills, pin toggle, tag chips
 * with autocomplete, link-insert button and the body editor. Saves via
 * processFrontMatter for metadata and vault.modify for body.
 */
export class EditNoteModal extends Modal {
  private plugin: JotDropPlugin;
  private file: TFile;
  private nav: NoteNavContext | null;
  private state!: EditableNote;
  private originalTitle = "";
  private originalBody = "";
  private originalEmbeds: string[] = [];
  private originalTags: string[] = [];
  private titleInputEl!: HTMLInputElement;
  private bodyEl!: HTMLTextAreaElement;
  private chipsEl!: HTMLElement;
  private tagInputEl: HTMLInputElement | null = null;
  private touchStartX: number | null = null;
  private touchStartY: number | null = null;
  private touchOnTextField = false;

  constructor(app: App, plugin: JotDropPlugin, file: TFile, nav?: NoteNavContext) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.nav = nav ?? null;
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("jotdrop-edit-modal");
    this.registerNavHandlers();
    await this.loadNote(this.file);
  }

  /** Loads a note into the modal. Called on open and again on prev/next navigation. */
  private async loadNote(file: TFile): Promise<void> {
    this.file = file;
    this.titleEl.setText(this.file.basename);

    const raw = await this.app.vault.read(this.file);
    const rawBody = stripFrontmatter(raw).replace(/^\n+/, "");
    const { textPart, embeds } = splitBodyAndEmbeds(rawBody);
    // Split off the explicit title (first `# heading`). No heading → empty
    // title and the card keeps deriving one from the first words of the body.
    const { title, body } = splitHeadingTitle(textPart);
    const meta = readMeta(this.app, this.file);

    this.state = {
      file: this.file,
      title,
      body,
      embedLines: embeds,
      color: meta.color,
      tags: [...meta.tags],
      pinned: meta.pinned,
      reminder: meta.reminder,
    };
    this.originalTitle = title;
    this.originalBody = body;
    this.originalEmbeds = [...embeds];
    this.originalTags = [...meta.tags];

    this.buildLayout();
  }

  /**
   * Keyboard (arrow keys) and touch (swipe) handlers for prev/next navigation.
   * Registered once on the modal element; they no-op without a nav context.
   */
  private registerNavHandlers(): void {
    if (!this.nav || this.nav.files.length < 2) return;

    // Keys go through the modal's keymap scope, not a DOM listener — right
    // after opening, focus sits outside the modal content, so keydown events
    // would never reach the modal element itself.
    const arrowHandler = (delta: number, fromAlt: boolean) => (evt: KeyboardEvent): boolean | void => {
      // Plain arrows must keep moving the caret inside text fields;
      // Alt+arrow navigates from anywhere.
      if (!fromAlt && isTextFieldElement(evt.target)) return;
      void this.navigate(delta);
      return false;
    };
    this.scope.register([], "ArrowLeft", arrowHandler(-1, false));
    this.scope.register([], "ArrowRight", arrowHandler(1, false));
    this.scope.register(["Alt"], "ArrowLeft", arrowHandler(-1, true));
    this.scope.register(["Alt"], "ArrowRight", arrowHandler(1, true));

    this.modalEl.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) {
          this.touchStartX = null;
          this.touchStartY = null;
          return;
        }
        this.touchStartX = e.touches[0].clientX;
        this.touchStartY = e.touches[0].clientY;
        // Swiping inside a text field selects text — never treat it as navigation.
        this.touchOnTextField = isTextFieldElement(e.target);
      },
      { passive: true },
    );

    this.modalEl.addEventListener(
      "touchend",
      (e) => {
        const startX = this.touchStartX;
        const startY = this.touchStartY;
        this.touchStartX = null;
        this.touchStartY = null;
        if (startX === null || startY === null) return;
        if (this.touchOnTextField || e.touches.length > 0) return;
        const touch = e.changedTouches[0];
        if (!touch) return;
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        // Require a clearly horizontal gesture so vertical scrolling never triggers it.
        if (Math.abs(dx) < SWIPE_MIN_DISTANCE || Math.abs(dx) < Math.abs(dy) * 2) return;
        // Swipe left = next card (card-swipe pattern), swipe right = previous.
        void this.navigate(dx < 0 ? 1 : -1);
      },
      { passive: true },
    );
  }

  /**
   * Moves to the previous/next note from the grid snapshot. Unsaved title/body/tag
   * edits are saved first (same as pressing Save); a failed save cancels navigation.
   * Files deleted since the snapshot are skipped.
   */
  private async navigate(delta: number): Promise<void> {
    if (!this.nav) return;
    let target = this.nav.index + delta;
    while (
      target >= 0 &&
      target < this.nav.files.length &&
      this.app.vault.getAbstractFileByPath(this.nav.files[target].path) === null
    ) {
      target += delta;
    }
    if (target < 0 || target >= this.nav.files.length) return;
    if (this.isDirty() && !(await this.persist())) return;
    this.nav.index = target;
    await this.loadNote(this.nav.files[target]);
  }

  private isDirty(): boolean {
    const embedsChanged =
      this.state.embedLines.length !== this.originalEmbeds.length ||
      this.state.embedLines.some((e, i) => e !== this.originalEmbeds[i]);
    const tagsChanged =
      this.state.tags.length !== this.originalTags.length ||
      this.state.tags.some((t, i) => t !== this.originalTags[i]);
    return (
      this.state.title !== this.originalTitle ||
      this.state.body !== this.originalBody ||
      embedsChanged ||
      tagsChanged
    );
  }

  private buildLayout(): void {
    const root = this.contentEl;
    root.empty();

    this.renderNavHeader(root);

    const controls = root.createDiv({ cls: "jotdrop-edit-controls" });
    this.renderControls(controls);

    this.renderEmbedThumbnail(root);

    this.titleInputEl = root.createEl("input", {
      cls: "jotdrop-edit-title",
      attr: { type: "text", placeholder: t("title_input_placeholder") },
    });
    this.titleInputEl.value = this.state.title;
    this.titleInputEl.addEventListener("input", () => {
      this.state.title = this.titleInputEl.value;
    });

    this.bodyEl = root.createEl("textarea", {
      cls: "jotdrop-edit-body",
    });
    this.bodyEl.rows = 12;
    this.bodyEl.value = this.state.body;
    this.bodyEl.addEventListener("input", () => {
      this.state.body = this.bodyEl.value;
    });

    const footer = root.createDiv({ cls: "jotdrop-edit-footer" });
    const cancel = footer.createEl("button", { text: t("action_cancel") });
    cancel.addEventListener("click", () => this.close());
    const save = footer.createEl("button", { text: t("action_save"), cls: "mod-cta" });
    save.addEventListener("click", () => void this.save());

    this.bodyEl.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void this.save();
      }
    });
  }

  /**
   * Prev/next buttons plus a "3 / 12" position counter at the top of the modal.
   * Only rendered when the modal was opened from the grid with ≥2 notes; the
   * buttons make the navigation discoverable (arrows/swipe have no visual cue).
   */
  private renderNavHeader(parent: HTMLElement): void {
    if (!this.nav || this.nav.files.length < 2) return;
    const bar = parent.createDiv({ cls: "jotdrop-edit-nav" });

    const prev = bar.createEl("button", {
      cls: "jotdrop-edit-nav-btn",
      attr: { "aria-label": t("nav_prev_note"), title: t("nav_prev_note") },
    });
    setIcon(prev, "chevron-left");
    prev.disabled = this.nav.index <= 0;
    prev.addEventListener("click", () => void this.navigate(-1));

    bar.createSpan({
      cls: "jotdrop-edit-nav-counter",
      text: `${this.nav.index + 1} / ${this.nav.files.length}`,
    });

    const next = bar.createEl("button", {
      cls: "jotdrop-edit-nav-btn",
      attr: { "aria-label": t("nav_next_note"), title: t("nav_next_note") },
    });
    setIcon(next, "chevron-right");
    next.disabled = this.nav.index >= this.nav.files.length - 1;
    next.addEventListener("click", () => void this.navigate(1));
  }

  private renderControls(parent: HTMLElement): void {
    parent.empty();

    // Color picker — changes are saved immediately
    const colorWrap = parent.createDiv({ cls: "jotdrop-edit-colorrow" });
    colorWrap.createSpan({ text: t("label_color"), cls: "jotdrop-edit-label" });
    const swatches = colorWrap.createDiv({ cls: "jotdrop-edit-swatches" });
    for (const name of COLOR_NAMES) {
      const sw = swatches.createDiv({
        cls: `jotdrop-edit-swatch${name === this.state.color ? " is-active" : ""}`,
        attr: { "aria-label": colorLabel(name), title: colorLabel(name) },
      });
      sw.dataset.color = name;
      if (name === this.state.color) {
        sw.createSpan({ cls: "jotdrop-edit-swatch-check", text: "✓" });
      }
      sw.addEventListener("click", voidAsync(async () => {
        if (this.state.color === name) return;
        this.state.color = name;
        this.renderControls(parent);
        try {
          await updateMeta(this.app, this.file, { color: name });
          this.plugin.refreshViews();
        } catch (err) {
          new Notice(t("notice_error", err instanceof Error ? err.message : String(err)));
        }
      }));
    }

    // Pin toggle — save immediately
    const pinWrap = parent.createDiv({ cls: "jotdrop-edit-row" });
    const pinBtn = pinWrap.createEl("button", {
      cls: `jotdrop-edit-pin${this.state.pinned ? " is-active" : ""}`,
      text: this.state.pinned ? t("action_unpin_btn") : t("action_pin_btn"),
    });
    pinBtn.addEventListener("click", voidAsync(async () => {
      this.state.pinned = !this.state.pinned;
      this.renderControls(parent);
      try {
        await updateMeta(this.app, this.file, { pinned: this.state.pinned });
        this.plugin.refreshViews();
      } catch (err) {
        new Notice(t("notice_error", err instanceof Error ? err.message : String(err)));
      }
    }));

    // Link insert
    const linkBtn = pinWrap.createEl("button", {
      cls: "jotdrop-edit-linkbtn",
      text: t("action_insert_link"),
    });
    linkBtn.addEventListener("click", () => {
      new InsertLinkModal(this.app, (path) => this.insertLinkAtCursor(path)).open();
    });

    const checkBtn = pinWrap.createEl("button", {
      cls: "jotdrop-edit-linkbtn",
      text: t("action_checklist"),
    });
    checkBtn.addEventListener("click", () => {
      toggleOrInsertChecklistOnTextArea(this.bodyEl);
      this.state.body = this.bodyEl.value;
    });

    // Reminder
    const reminderRow = parent.createDiv({ cls: "jotdrop-edit-row jotdrop-reminder-row" });
    reminderRow.createSpan({ text: t("label_reminder"), cls: "jotdrop-edit-label" });
    const reminderInput = reminderRow.createEl("input", {
      cls: "jotdrop-edit-reminder",
      attr: { type: "datetime-local" },
    });
    if (this.state.reminder) reminderInput.value = this.state.reminder;
    reminderInput.addEventListener("change", voidAsync(async () => {
      this.state.reminder = reminderInput.value.trim() || null;
      try {
        await updateMeta(this.app, this.file, { reminder: this.state.reminder });
        this.plugin.refreshViews();
      } catch (err) {
        new Notice(t("notice_error", err instanceof Error ? err.message : String(err)));
      }
    }));
    const clearReminder = reminderRow.createEl("button", {
      cls: "jotdrop-edit-linkbtn",
      text: t("action_clear_reminder"),
    });
    clearReminder.addEventListener("click", voidAsync(async () => {
      reminderInput.value = "";
      this.state.reminder = null;
      try {
        await updateMeta(this.app, this.file, { reminder: null });
        this.plugin.refreshViews();
      } catch (err) {
        new Notice(t("notice_error", err instanceof Error ? err.message : String(err)));
      }
    }));

    // Tags + chip input — input lives inside the chips container so it always
    // follows the last chip, even when chips wrap to a new line.
    const tagWrap = parent.createDiv({ cls: "jotdrop-edit-tagrow" });
    tagWrap.createSpan({ text: t("label_tags"), cls: "jotdrop-edit-label" });
    this.chipsEl = tagWrap.createDiv({ cls: "jotdrop-edit-chips" });
    this.tagInputEl = null;
    this.renderChips();

    this.tagInputEl = this.chipsEl.createEl("input", {
      cls: "jotdrop-edit-taginput",
      attr: { type: "text", placeholder: t("tag_input_placeholder") },
    });
    const datalistId = `jotdrop-tagcompletion-${Date.now()}`;
    const datalist = tagWrap.createEl("datalist", { attr: { id: datalistId } });
    this.tagInputEl.setAttribute("list", datalistId);
    for (const tag of getAllVaultTags(this.app)) {
      datalist.createEl("option", { attr: { value: tag } });
    }
    const commit = () => {
      if (!this.tagInputEl) return;
      const value = this.tagInputEl.value.replace(/^#/, "").trim();
      if (value && !this.state.tags.includes(value)) {
        this.state.tags.push(value);
        this.renderChips();
      }
      this.tagInputEl.value = "";
    };
    this.tagInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
        if (this.tagInputEl?.value.trim()) {
          e.preventDefault();
          commit();
        }
      } else if (e.key === "Backspace" && this.tagInputEl?.value === "" && this.state.tags.length > 0) {
        this.state.tags.pop();
        this.renderChips();
      }
    });
    this.tagInputEl.addEventListener("blur", commit);
  }

  private renderChips(): void {
    if (!this.chipsEl) return;
    this.chipsEl.empty();
    for (const tag of this.state.tags) {
      const chip = this.chipsEl.createSpan({ cls: "jotdrop-edit-chip" });
      chip.createSpan({ text: `#${tag}` });
      const x = chip.createSpan({ cls: "jotdrop-edit-chip-x", text: "×" });
      x.addEventListener("click", () => {
        this.state.tags = this.state.tags.filter((t) => t !== tag);
        this.renderChips();
      });
    }
    // Keep the input at the end of the chips container after re-render.
    if (this.tagInputEl) this.chipsEl.appendChild(this.tagInputEl);
  }

  private insertLinkAtCursor(linkPath: string): void {
    const ta = this.bodyEl;
    const insert = `[[${linkPath}]]`;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    ta.value = `${before}${insert}${after}`;
    const caret = start + insert.length;
    ta.selectionStart = ta.selectionEnd = caret;
    ta.focus();
    this.state.body = ta.value;
  }

  /**
   * Shows the first embedded attachment as a thumbnail (image) of inline
   * audio player (m4a/webm/etc.) at the top of the modal. Embed lines are
   * not in the text field (they are re-added on save), so without this
   * preview the attachment would be inaccessible from the edit modal.
   */
  private renderEmbedThumbnail(parent: HTMLElement): void {
    if (this.state.embedLines.length === 0) return;
    const match = this.state.embedLines[0].match(/!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/);
    if (!match) return;
    const basename = match[1].trim();
    const resolved = this.resolveAttachment(basename);
    if (!resolved) return;

    if (/\.(m4a|mp3|wav|ogg|aac|flac|3gp|amr|webm)$/i.test(basename)) {
      const wrap = parent.createDiv({ cls: "jotdrop-edit-audio" });
      const audio = wrap.createEl("audio");
      audio.controls = true;
      audio.src = resolved.resourcePath;
      audio.preload = "metadata";
      audio.addEventListener("error", () => wrap.remove());
      return;
    }

    const wrap = parent.createDiv({ cls: "jotdrop-edit-thumbnail" });
    const img = wrap.createEl("img");
    img.src = resolved.resourcePath;
    img.alt = "";
    img.addEventListener("error", () => wrap.remove());
    wrap.addEventListener("click", () => {
      new LightboxModal(
        this.app,
        this.plugin,
        this.file,
        resolved.resourcePath,
        resolved.file,
        resolved.vaultPath,
      ).open();
    });
  }

  private resolveAttachment(
    basename: string,
  ): { resourcePath: string; file: TFile | null; vaultPath: string } | null {
    const dest = this.app.metadataCache.getFirstLinkpathDest(basename, this.file.path);
    if (dest) {
      return {
        resourcePath: this.app.vault.getResourcePath(dest),
        file: dest,
        vaultPath: dest.path,
      };
    }
    const noteFolder = this.file.parent?.path ?? "";
    const candidate = noteFolder ? `${noteFolder}/.attachments/${basename}` : `.attachments/${basename}`;
    const normalized = normalizePath(candidate);
    return {
      resourcePath: this.app.vault.adapter.getResourcePath(normalized),
      file: null,
      vaultPath: normalized,
    };
  }

  private async save(): Promise<void> {
    if (await this.persist()) this.close();
  }

  /** Writes the current state to the file without closing (also used by [navigate]). */
  private async persist(): Promise<boolean> {
    try {
      const embedsChanged =
        this.state.embedLines.length !== this.originalEmbeds.length ||
        this.state.embedLines.some((e, i) => e !== this.originalEmbeds[i]);
      const bodyChanged =
        this.state.body !== this.originalBody ||
        this.state.title !== this.originalTitle ||
        embedsChanged;
      await updateMeta(this.app, this.file, {
        color: this.state.color,
        tags: this.state.tags,
        pinned: this.state.pinned,
        reminder: this.state.reminder,
      });
      if (bodyChanged) {
        // Re-read so our new frontmatter is preserved
        const current = await this.app.vault.read(this.file);
        const fmMatch = current.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
        const fm = fmMatch ? fmMatch[0] : "";
        // Re-attach the title as the leading `# heading`; empty title → none.
        const merged = joinHeadingTitle(this.state.title, this.state.body);
        const safeBody = neutralizeInlineHashtags(merged);
        const combined = combineBodyAndEmbeds(safeBody, this.state.embedLines);
        const newContent = `${fm}${combined.replace(/^\n+/, "")}`;
        await this.app.vault.modify(this.file, newContent);
      }
      this.originalTitle = this.state.title;
      this.originalBody = this.state.body;
      this.originalEmbeds = [...this.state.embedLines];
      this.originalTags = [...this.state.tags];
      new Notice(t("notice_saved", this.file.basename));
      this.plugin.refreshViews();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(t("notice_save_failed", message));
      return false;
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Suggest modal with autocomplete from all markdown files in the vault.
 * Returns the chosen path (without .md) via callback.
 */
export class InsertLinkModal extends SuggestModal<TFile> {
  private onPick: (linkPath: string) => void;

  constructor(app: App, onPick: (linkPath: string) => void) {
    super(app);
    this.onPick = onPick;
    this.setPlaceholder(t("link_picker_placeholder"));
  }

  getSuggestions(query: string): TFile[] {
    const q = query.toLowerCase().trim();
    const files = this.app.vault.getMarkdownFiles();
    if (!q) return files.slice(0, 50);
    return files
      .filter((f) => f.basename.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
      .slice(0, 50);
  }

  renderSuggestion(value: TFile, el: HTMLElement): void {
    el.createDiv({ text: value.basename });
    el.createDiv({ cls: "jotdrop-suggest-path", text: value.path });
  }

  onChooseSuggestion(item: TFile): void {
    // Obsidian convention: link with the basename if it is unique, otherwise the path without .md.
    const matches = this.app.vault.getMarkdownFiles().filter((f) => f.basename === item.basename);
    const linkPath = matches.length === 1 ? item.basename : item.path.replace(/\.md$/, "");
    this.onPick(linkPath);
  }
}

/** True when the event target is a text-editing element (input/textarea/contenteditable). */
function isTextFieldElement(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

/**
 * Splits a note body into an explicit title (the first `# heading` line) and
 * the rest. If the first non-blank line is not a heading, the title is empty
 * and the whole text stays as the body — the card then derives a title from the
 * first words of the body (the long-standing fallback behavior, kept intact).
 */
export function splitHeadingTitle(text: string): { title: string; body: string } {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const heading = i < lines.length ? lines[i].match(/^#{1,6}\s+(.*\S)\s*$/) : null;
  if (!heading) return { title: "", body: text };
  const body = lines.slice(i + 1).join("\n").replace(/^\n+/, "");
  return { title: heading[1].trim(), body };
}

/**
 * Re-joins an explicit title and body. An empty title yields the body only (no
 * heading), so the card falls back to auto-deriving its title.
 */
export function joinHeadingTitle(title: string, body: string): string {
  const t = title.trim();
  const b = body.replace(/^\n+/, "").replace(/\n+$/, "");
  if (!t) return b;
  return b ? `# ${t}\n\n${b}` : `# ${t}`;
}

const EMBED_LINE_REGEX = /^\s*!\[\[[^\]]+\]\]\s*$/;

/**
 * Splits the body into text (without embed-only lines) and the embed lines separately.
 * Keeps blank-line structure intact but collapses consecutive blank lines that
 * result from filtering out an embed.
 */
export function splitBodyAndEmbeds(body: string): { textPart: string; embeds: string[] } {
  const embeds: string[] = [];
  const kept: string[] = [];
  for (const line of body.split("\n")) {
    if (EMBED_LINE_REGEX.test(line)) {
      embeds.push(line.trim());
    } else {
      kept.push(line);
    }
  }
  const cleaned: string[] = [];
  let prevBlank = false;
  for (const line of kept) {
    const blank = line.trim() === "";
    if (blank && prevBlank) continue;
    cleaned.push(line);
    prevBlank = blank;
  }
  while (cleaned.length > 0 && cleaned[0].trim() === "") cleaned.shift();
  while (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === "") cleaned.pop();
  return { textPart: cleaned.join("\n"), embeds };
}

export function combineBodyAndEmbeds(bodyText: string, embedLines: string[]): string {
  if (embedLines.length === 0) return bodyText;
  const body = bodyText.replace(/\n+$/, "");
  if (body === "") return embedLines.join("\n");
  return `${body}\n\n${embedLines.join("\n")}`;
}

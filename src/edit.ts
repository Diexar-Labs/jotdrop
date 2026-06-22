import { App, Modal, Notice, SuggestModal, TFile, normalizePath } from "obsidian";
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
  private state!: EditableNote;
  private originalTitle = "";
  private originalBody = "";
  private originalEmbeds: string[] = [];
  private titleInputEl!: HTMLInputElement;
  private bodyEl!: HTMLTextAreaElement;
  private chipsEl!: HTMLElement;
  private tagInputEl: HTMLInputElement | null = null;

  constructor(app: App, plugin: JotDropPlugin, file: TFile) {
    super(app);
    this.plugin = plugin;
    this.file = file;
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText(this.file.basename);
    this.contentEl.addClass("jotdrop-edit-modal");

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

    this.buildLayout();
  }

  private buildLayout(): void {
    const root = this.contentEl;
    root.empty();

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
      new Notice(t("notice_saved", this.file.basename));
      this.plugin.refreshViews();
      this.close();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(t("notice_save_failed", message));
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

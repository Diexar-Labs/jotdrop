import { App, Modal, Notice, TFile, normalizePath } from "obsidian";
import type JotDropPlugin from "./main";
import { InsertLinkModal } from "./edit";
import {
  colorLabel,
  COLOR_NAMES,
  ColorName,
  getAllVaultTags,
  neutralizeBodyHashtags,
  updateMeta,
} from "./metadata";
import { buildLinkNote, detectAllUrls, fetchOg, OgPreview } from "./ogfetch";
import { t } from "./i18n";

export class QuickCaptureModal extends Modal {
  plugin: JotDropPlugin;
  textArea!: HTMLTextAreaElement;
  private chipsEl!: HTMLElement;
  private tagInputEl: HTMLInputElement | null = null;
  private state: {
    color: ColorName;
    tags: string[];
    pinned: boolean;
    reminder: string | null;
  } = {
    color: "default",
    tags: [],
    pinned: false,
    reminder: null,
  };

  constructor(app: App, plugin: JotDropPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(t("capture_title"));
    contentEl.addClass("jotdrop-capture");

    this.renderControls(contentEl);

    this.textArea = contentEl.createEl("textarea", {
      cls: "jotdrop-capture-textarea",
      attr: { placeholder: t("capture_placeholder") },
    });
    this.textArea.rows = 8;

    const footer = contentEl.createDiv({ cls: "jotdrop-capture-footer" });
    const hint = footer.createSpan({ cls: "jotdrop-capture-hint" });
    hint.setText(t("capture_hint"));

    const buttons = footer.createDiv({ cls: "jotdrop-capture-buttons" });
    const cancel = buttons.createEl("button", { text: t("action_cancel") });
    cancel.addEventListener("click", () => this.close());
    const save = buttons.createEl("button", { text: t("action_save"), cls: "mod-cta" });
    save.addEventListener("click", () => void this.save());

    this.textArea.addEventListener("keydown", (evt) => {
      if ((evt.ctrlKey || evt.metaKey) && evt.key === "Enter") {
        evt.preventDefault();
        void this.save();
      }
    });

    setTimeout(() => this.textArea.focus(), 50);
  }

  private renderControls(parent: HTMLElement): void {
    let bar = parent.querySelector(".jotdrop-capture-controls") as HTMLElement | null;
    if (!bar) bar = parent.createDiv({ cls: "jotdrop-capture-controls" });
    bar.empty();

    // Color
    const colorRow = bar.createDiv({ cls: "jotdrop-edit-colorrow" });
    colorRow.createSpan({ text: t("label_color"), cls: "jotdrop-edit-label" });
    const swatches = colorRow.createDiv({ cls: "jotdrop-edit-swatches" });
    for (const name of COLOR_NAMES) {
      const sw = swatches.createDiv({
        cls: `jotdrop-edit-swatch${name === this.state.color ? " is-active" : ""}`,
        attr: { "aria-label": colorLabel(name), title: colorLabel(name) },
      });
      sw.dataset.color = name;
      sw.addEventListener("click", () => {
        this.state.color = name;
        this.renderControls(parent);
      });
    }

    // Pin + link
    const actionRow = bar.createDiv({ cls: "jotdrop-edit-row" });
    const pinBtn = actionRow.createEl("button", {
      cls: `jotdrop-edit-pin${this.state.pinned ? " is-active" : ""}`,
      text: this.state.pinned ? t("action_unpin_btn") : t("action_pin_btn"),
    });
    pinBtn.addEventListener("click", () => {
      this.state.pinned = !this.state.pinned;
      this.renderControls(parent);
    });

    const linkBtn = actionRow.createEl("button", {
      cls: "jotdrop-edit-linkbtn",
      text: t("action_insert_link"),
    });
    linkBtn.addEventListener("click", () => {
      new InsertLinkModal(this.app, (path) => this.insertLinkAtCursor(path)).open();
    });

    const checkBtn = actionRow.createEl("button", {
      cls: "jotdrop-edit-linkbtn",
      text: t("action_checklist"),
    });
    checkBtn.addEventListener("click", () => this.toggleOrInsertChecklist());

    // Reminder-input
    const reminderRow = bar.createDiv({ cls: "jotdrop-edit-row jotdrop-reminder-row" });
    reminderRow.createSpan({ text: t("label_reminder"), cls: "jotdrop-edit-label" });
    const reminderInput = reminderRow.createEl("input", {
      cls: "jotdrop-edit-reminder",
      attr: { type: "datetime-local" },
    });
    if (this.state.reminder) reminderInput.value = this.state.reminder;
    reminderInput.addEventListener("change", () => {
      this.state.reminder = reminderInput.value.trim() || null;
    });
    const clearReminder = reminderRow.createEl("button", {
      cls: "jotdrop-edit-linkbtn",
      text: t("action_clear_reminder"),
    });
    clearReminder.addEventListener("click", () => {
      reminderInput.value = "";
      this.state.reminder = null;
    });

    // Tags — chips and input share the same flex container so the input always
    // follows directly after the last chip, even when chips wrap to a new line.
    const tagRow = bar.createDiv({ cls: "jotdrop-edit-tagrow" });
    tagRow.createSpan({ text: t("label_tags"), cls: "jotdrop-edit-label" });
    this.chipsEl = tagRow.createDiv({ cls: "jotdrop-edit-chips" });
    this.tagInputEl = null;
    this.renderChips();

    this.tagInputEl = this.chipsEl.createEl("input", {
      cls: "jotdrop-edit-taginput",
      attr: { type: "text", placeholder: t("tag_input_placeholder") },
    });
    const datalistId = `jotdrop-tagcompletion-capture-${Date.now()}`;
    const datalist = tagRow.createEl("datalist", { attr: { id: datalistId } });
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
    const ta = this.textArea;
    const insert = `[[${linkPath}]]`;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    ta.value = `${ta.value.slice(0, start)}${insert}${ta.value.slice(end)}`;
    const caret = start + insert.length;
    ta.selectionStart = ta.selectionEnd = caret;
    ta.focus();
  }

  private toggleOrInsertChecklist(): void {
    toggleOrInsertChecklistOnTextArea(this.textArea);
  }

  async save(): Promise<void> {
    let content = this.textArea.value.trim();
    if (!content) {
      new Notice(t("notice_empty"));
      return;
    }

    // If the text contains a URL, fetch OG meta and embed the thumbnail.
    // With multiple URLs we try them sequentially until one yields an OG image.
    // Soft-fail: on timeout or error we simply save the original text.
    const urls = detectAllUrls(content).slice(0, 3);
    if (urls.length > 0) {
      const notice = new Notice(t("notice_fetching_preview"), 0);
      try {
        const attachmentsFolder = `${this.plugin.settings.notesFolder}/.attachments`;
        let chosenUrl: string | null = null;
        let chosenPreview: OgPreview | null = null;
        for (const candidate of urls) {
          const preview = await withTimeout(
            fetchOg(this.app, attachmentsFolder, candidate, this.plugin.settings.downloadImages),
            10_000,
          );
          if (!preview) continue;
          if (!chosenPreview) {
            chosenUrl = candidate;
            chosenPreview = preview;
          }
          if (preview.imageBasename) {
            chosenUrl = candidate;
            chosenPreview = preview;
            break;
          }
        }
        if (chosenUrl && chosenPreview) {
          content = buildLinkNote(chosenUrl, chosenPreview, content);
        }
      } catch (e) {
        console.error("Jot Drop: preview fetch failed:", e);
      } finally {
        notice.hide();
      }
    }

    try {
      // Escape inline #hashtags so they do not pollute Obsidian's vault-wide
      // tag index. User tags are already in `state.tags` and go to frontmatter.
      const safeContent = neutralizeBodyHashtags(content);
      const file = await createNoteInFolder(this.app, this.plugin.settings.notesFolder, safeContent);
      if (
        this.state.color !== "default" ||
        this.state.tags.length > 0 ||
        this.state.pinned ||
        this.state.reminder
      ) {
        await updateMeta(this.app, file, {
          color: this.state.color,
          tags: this.state.tags,
          pinned: this.state.pinned,
          reminder: this.state.reminder,
        });
      }
      new Notice(t("notice_saved", file.basename));
      this.plugin.refreshViews();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(t("notice_save_failed", message));
      return;
    }
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Smart checklist toggle for textarea: inspects the current line under the
 * cursor and toggles `- [ ]` ↔ `- [x]`, or inserts `- [ ] ` at the start of
 * the line if no checkbox is present yet. Mirrored with the Android editor.
 */
export function toggleOrInsertChecklistOnTextArea(ta: HTMLTextAreaElement): void {
  const value = ta.value;
  const caret = ta.selectionStart ?? value.length;
  const before = value.slice(0, caret);
  const lineStart = before.lastIndexOf("\n") + 1;
  const nextNewline = value.indexOf("\n", caret);
  const lineEnd = nextNewline < 0 ? value.length : nextNewline;
  const line = value.slice(lineStart, lineEnd);

  let newLine: string;
  let caretDelta = 0;
  if (line.startsWith("- [ ] ")) {
    newLine = "- [x] " + line.slice(6);
  } else if (line.startsWith("- [ ]")) {
    newLine = "- [x]" + line.slice(5);
  } else if (line.startsWith("- [x] ") || line.startsWith("- [X] ")) {
    newLine = "- [ ] " + line.slice(6);
  } else if (line.startsWith("- [x]") || line.startsWith("- [X]")) {
    newLine = "- [ ]" + line.slice(5);
  } else {
    newLine = "- [ ] " + line;
    caretDelta = "- [ ] ".length;
  }

  ta.value = value.slice(0, lineStart) + newLine + value.slice(lineEnd);
  const newCaret = caret + caretDelta;
  ta.selectionStart = ta.selectionEnd = newCaret;
  ta.focus();
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return await Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

export async function createNoteInFolder(app: App, folderPath: string, content: string): Promise<TFile> {
  const folder = normalizePath(folderPath);
  if (!app.vault.getAbstractFileByPath(folder)) {
    await app.vault.createFolder(folder);
  }
  const fileName = generateFilename(content);
  const fullPath = normalizePath(`${folder}/${fileName}`);
  return await app.vault.create(fullPath, content);
}

function generateFilename(content: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const firstLine = content.split("\n")[0].trim();
  const slug = firstLine
    .replace(/[#*_`>\[\]\(\)]/g, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .slice(0, 40);

  const base = slug ? `${stamp} ${slug}` : stamp;
  return `${base}.md`;
}

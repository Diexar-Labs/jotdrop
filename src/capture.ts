import { App, Modal, Notice, TFile, normalizePath } from "obsidian";
import type ObsiDropPlugin from "./main";
import { InsertLinkModal } from "./edit";
import {
  colorLabel,
  COLOR_NAMES,
  ColorName,
  getAllVaultTags,
  updateMeta,
} from "./metadata";
import { buildLinkNote, detectUrl, fetchOg } from "./ogfetch";
import { t } from "./i18n";

export class QuickCaptureModal extends Modal {
  plugin: ObsiDropPlugin;
  textArea!: HTMLTextAreaElement;
  private chipsEl!: HTMLElement;
  private state: { color: ColorName; tags: string[]; pinned: boolean } = {
    color: "default",
    tags: [],
    pinned: false,
  };

  constructor(app: App, plugin: ObsiDropPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(t("capture_title"));
    contentEl.addClass("obsidrop-capture");

    this.renderControls(contentEl);

    this.textArea = contentEl.createEl("textarea", {
      cls: "obsidrop-capture-textarea",
      attr: { placeholder: t("capture_placeholder") },
    });
    this.textArea.rows = 8;

    const footer = contentEl.createDiv({ cls: "obsidrop-capture-footer" });
    const hint = footer.createSpan({ cls: "obsidrop-capture-hint" });
    hint.setText(t("capture_hint"));

    const buttons = footer.createDiv({ cls: "obsidrop-capture-buttons" });
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
    let bar = parent.querySelector(".obsidrop-capture-controls") as HTMLElement | null;
    if (!bar) bar = parent.createDiv({ cls: "obsidrop-capture-controls" });
    bar.empty();

    // Kleur
    const colorRow = bar.createDiv({ cls: "obsidrop-edit-colorrow" });
    colorRow.createSpan({ text: t("label_color"), cls: "obsidrop-edit-label" });
    const swatches = colorRow.createDiv({ cls: "obsidrop-edit-swatches" });
    for (const name of COLOR_NAMES) {
      const sw = swatches.createDiv({
        cls: `obsidrop-edit-swatch${name === this.state.color ? " is-active" : ""}`,
        attr: { "aria-label": colorLabel(name), title: colorLabel(name) },
      });
      sw.dataset.color = name;
      sw.addEventListener("click", () => {
        this.state.color = name;
        this.renderControls(parent);
      });
    }

    // Pin + link
    const actionRow = bar.createDiv({ cls: "obsidrop-edit-row" });
    const pinBtn = actionRow.createEl("button", {
      cls: `obsidrop-edit-pin${this.state.pinned ? " is-active" : ""}`,
      text: this.state.pinned ? t("action_unpin_btn") : t("action_pin_btn"),
    });
    pinBtn.addEventListener("click", () => {
      this.state.pinned = !this.state.pinned;
      this.renderControls(parent);
    });

    const linkBtn = actionRow.createEl("button", {
      cls: "obsidrop-edit-linkbtn",
      text: t("action_insert_link"),
    });
    linkBtn.addEventListener("click", () => {
      new InsertLinkModal(this.app, (path) => this.insertLinkAtCursor(path)).open();
    });

    const checkBtn = actionRow.createEl("button", {
      cls: "obsidrop-edit-linkbtn",
      text: t("action_checklist"),
    });
    checkBtn.addEventListener("click", () => this.toggleOrInsertChecklist());

    // Tags
    const tagRow = bar.createDiv({ cls: "obsidrop-edit-tagrow" });
    tagRow.createSpan({ text: t("label_tags"), cls: "obsidrop-edit-label" });
    this.chipsEl = tagRow.createDiv({ cls: "obsidrop-edit-chips" });
    this.renderChips();

    const tagInput = tagRow.createEl("input", {
      cls: "obsidrop-edit-taginput",
      attr: { type: "text", placeholder: t("tag_input_placeholder") },
    });
    const datalistId = `obsidrop-tagcompletion-capture-${Date.now()}`;
    const datalist = tagRow.createEl("datalist", { attr: { id: datalistId } });
    tagInput.setAttribute("list", datalistId);
    for (const tag of getAllVaultTags(this.app)) {
      datalist.createEl("option", { attr: { value: tag } });
    }
    const commit = () => {
      const value = tagInput.value.replace(/^#/, "").trim();
      if (value && !this.state.tags.includes(value)) {
        this.state.tags.push(value);
        this.renderChips();
      }
      tagInput.value = "";
    };
    tagInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
        if (tagInput.value.trim()) {
          e.preventDefault();
          commit();
        }
      } else if (e.key === "Backspace" && tagInput.value === "" && this.state.tags.length > 0) {
        this.state.tags.pop();
        this.renderChips();
      }
    });
    tagInput.addEventListener("blur", commit);
  }

  private renderChips(): void {
    if (!this.chipsEl) return;
    this.chipsEl.empty();
    for (const tag of this.state.tags) {
      const chip = this.chipsEl.createSpan({ cls: "obsidrop-edit-chip" });
      chip.createSpan({ text: `#${tag}` });
      const x = chip.createSpan({ cls: "obsidrop-edit-chip-x", text: "×" });
      x.addEventListener("click", () => {
        this.state.tags = this.state.tags.filter((t) => t !== tag);
        this.renderChips();
      });
    }
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

    // Als de tekst een URL bevat, haal OG-meta op en bed de thumbnail in.
    // Soft-fail: bij timeout of fout slaan we gewoon de originele tekst op.
    const url = detectUrl(content);
    if (url) {
      const notice = new Notice(t("notice_fetching_preview"), 0);
      try {
        const attachmentsFolder = `${this.plugin.settings.notesFolder}/.attachments`;
        const preview = await withTimeout(
          fetchOg(this.app, attachmentsFolder, url),
          10_000,
        );
        if (preview) {
          content = buildLinkNote(url, preview, content);
        }
      } catch (e) {
        console.error("ObsiDrop: preview ophalen mislukt:", e);
      } finally {
        notice.hide();
      }
    }

    try {
      const file = await createNoteInFolder(this.app, this.plugin.settings.notesFolder, content);
      if (this.state.color !== "default" || this.state.tags.length > 0 || this.state.pinned) {
        await updateMeta(this.app, file, {
          color: this.state.color,
          tags: this.state.tags,
          pinned: this.state.pinned,
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
 * Smart checklist-toggle voor textarea: kijkt naar de huidige regel onder de
 * cursor en wisselt `- [ ]` ↔ `- [x]`, of voegt `- [ ] ` in aan begin van de
 * regel als er nog geen checkbox op staat. Gespiegeld met de Android-editor.
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

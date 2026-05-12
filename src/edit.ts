import { App, Modal, Notice, SuggestModal, TFile, normalizePath } from "obsidian";
import type ObsiDropPlugin from "./main";
import { toggleOrInsertChecklistOnTextArea } from "./capture";
import { t } from "./i18n";
import {
  colorLabel,
  COLOR_NAMES,
  ColorName,
  getAllVaultTags,
  isColorName,
  readMeta,
  stripFrontmatter,
  updateMeta,
} from "./metadata";

interface EditableNote {
  file?: TFile;
  body: string;
  embedLines: string[];
  color: ColorName;
  tags: string[];
  pinned: boolean;
}

/**
 * Bewerk-modal voor een bestaande notitie. Toont kleur-pille, pin-toggle, tag-chips
 * met autocomplete, link-invoeg-knop en de body-editor. Slaat op via processFrontMatter
 * voor metadata en vault.modify voor body.
 */
export class EditNoteModal extends Modal {
  private plugin: ObsiDropPlugin;
  private file: TFile;
  private state!: EditableNote;
  private originalBody = "";
  private originalEmbeds: string[] = [];
  private bodyEl!: HTMLTextAreaElement;
  private chipsEl!: HTMLElement;

  constructor(app: App, plugin: ObsiDropPlugin, file: TFile) {
    super(app);
    this.plugin = plugin;
    this.file = file;
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText(this.file.basename);
    this.contentEl.addClass("obsidrop-edit-modal");

    const raw = await this.app.vault.read(this.file);
    const rawBody = stripFrontmatter(raw).replace(/^\n+/, "");
    const { textPart, embeds } = splitBodyAndEmbeds(rawBody);
    const meta = readMeta(this.app, this.file);

    this.state = {
      file: this.file,
      body: textPart,
      embedLines: embeds,
      color: meta.color,
      tags: [...meta.tags],
      pinned: meta.pinned,
    };
    this.originalBody = textPart;
    this.originalEmbeds = [...embeds];

    this.buildLayout();
  }

  private buildLayout(): void {
    const root = this.contentEl;
    root.empty();

    const controls = root.createDiv({ cls: "obsidrop-edit-controls" });
    this.renderControls(controls);

    this.bodyEl = root.createEl("textarea", {
      cls: "obsidrop-edit-body",
    });
    this.bodyEl.rows = 12;
    this.bodyEl.value = this.state.body;
    this.bodyEl.addEventListener("input", () => {
      this.state.body = this.bodyEl.value;
    });

    const footer = root.createDiv({ cls: "obsidrop-edit-footer" });
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

    // Kleurkiezer — wijzigingen worden direct opgeslagen
    const colorWrap = parent.createDiv({ cls: "obsidrop-edit-colorrow" });
    colorWrap.createSpan({ text: t("label_color"), cls: "obsidrop-edit-label" });
    const swatches = colorWrap.createDiv({ cls: "obsidrop-edit-swatches" });
    for (const name of COLOR_NAMES) {
      const sw = swatches.createDiv({
        cls: `obsidrop-edit-swatch${name === this.state.color ? " is-active" : ""}`,
        attr: { "aria-label": colorLabel(name), title: colorLabel(name) },
      });
      sw.dataset.color = name;
      if (name === this.state.color) {
        sw.createSpan({ cls: "obsidrop-edit-swatch-check", text: "✓" });
      }
      sw.addEventListener("click", async () => {
        if (this.state.color === name) return;
        this.state.color = name;
        this.renderControls(parent);
        try {
          await updateMeta(this.app, this.file, { color: name });
          this.plugin.refreshViews();
        } catch (err) {
          new Notice(t("notice_error", err instanceof Error ? err.message : String(err)));
        }
      });
    }

    // Pin-toggle — direct opslaan
    const pinWrap = parent.createDiv({ cls: "obsidrop-edit-row" });
    const pinBtn = pinWrap.createEl("button", {
      cls: `obsidrop-edit-pin${this.state.pinned ? " is-active" : ""}`,
      text: this.state.pinned ? t("action_unpin_btn") : t("action_pin_btn"),
    });
    pinBtn.addEventListener("click", async () => {
      this.state.pinned = !this.state.pinned;
      this.renderControls(parent);
      try {
        await updateMeta(this.app, this.file, { pinned: this.state.pinned });
        this.plugin.refreshViews();
      } catch (err) {
        new Notice(t("notice_error", err instanceof Error ? err.message : String(err)));
      }
    });

    // Link-invoegen
    const linkBtn = pinWrap.createEl("button", {
      cls: "obsidrop-edit-linkbtn",
      text: t("action_insert_link"),
    });
    linkBtn.addEventListener("click", () => {
      new InsertLinkModal(this.app, (path) => this.insertLinkAtCursor(path)).open();
    });

    const checkBtn = pinWrap.createEl("button", {
      cls: "obsidrop-edit-linkbtn",
      text: t("action_checklist"),
    });
    checkBtn.addEventListener("click", () => {
      toggleOrInsertChecklistOnTextArea(this.bodyEl);
      this.state.body = this.bodyEl.value;
    });

    // Tags + chip-input
    const tagWrap = parent.createDiv({ cls: "obsidrop-edit-tagrow" });
    tagWrap.createSpan({ text: t("label_tags"), cls: "obsidrop-edit-label" });
    this.chipsEl = tagWrap.createDiv({ cls: "obsidrop-edit-chips" });
    this.renderChips();

    const tagInput = tagWrap.createEl("input", {
      cls: "obsidrop-edit-taginput",
      attr: { type: "text", placeholder: t("tag_input_placeholder") },
    });
    const datalistId = `obsidrop-tagcompletion-${Date.now()}`;
    const datalist = tagWrap.createEl("datalist", { attr: { id: datalistId } });
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

  private async save(): Promise<void> {
    try {
      const embedsChanged =
        this.state.embedLines.length !== this.originalEmbeds.length ||
        this.state.embedLines.some((e, i) => e !== this.originalEmbeds[i]);
      const bodyChanged = this.state.body !== this.originalBody || embedsChanged;
      await updateMeta(this.app, this.file, {
        color: this.state.color,
        tags: this.state.tags,
        pinned: this.state.pinned,
      });
      if (bodyChanged) {
        // Lees opnieuw zodat onze nieuwe frontmatter behouden blijft
        const current = await this.app.vault.read(this.file);
        const fmMatch = current.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
        const fm = fmMatch ? fmMatch[0] : "";
        const combined = combineBodyAndEmbeds(this.state.body, this.state.embedLines);
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
 * Suggest-modal met autocomplete uit alle markdown-bestanden in de vault.
 * Geeft het gekozen pad (zonder .md) terug via callback.
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
    el.createDiv({ cls: "obsidrop-suggest-path", text: value.path });
  }

  onChooseSuggestion(item: TFile): void {
    // Obsidian-conventie: link met de basename als 'ie uniek is, anders het pad zonder .md.
    const matches = this.app.vault.getMarkdownFiles().filter((f) => f.basename === item.basename);
    const linkPath = matches.length === 1 ? item.basename : item.path.replace(/\.md$/, "");
    this.onPick(linkPath);
  }
}

const EMBED_LINE_REGEX = /^\s*!\[\[[^\]]+\]\]\s*$/;

/**
 * Splitst de body in tekst (zonder embed-only regels) en de embed-regels los.
 * Houdt blank-line-structuur intact maar vouwt opeenvolgende lege regels
 * samen die ontstaan door het uitfilteren van een embed.
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

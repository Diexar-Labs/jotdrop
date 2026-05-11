import { App, Modal, Notice, TFile, normalizePath } from "obsidian";
import type DiexarKeepPlugin from "./main";
import { InsertLinkModal } from "./edit";
import {
  COLOR_LABELS_NL,
  COLOR_NAMES,
  ColorName,
  getAllVaultTags,
  updateMeta,
} from "./metadata";
import { buildLinkNote, detectUrl, fetchOg } from "./ogfetch";

export class QuickCaptureModal extends Modal {
  plugin: DiexarKeepPlugin;
  textArea!: HTMLTextAreaElement;
  private chipsEl!: HTMLElement;
  private state: { color: ColorName; tags: string[]; pinned: boolean } = {
    color: "default",
    tags: [],
    pinned: false,
  };

  constructor(app: App, plugin: DiexarKeepPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Snelle notitie");
    contentEl.addClass("diexar-keep-capture");

    this.renderControls(contentEl);

    this.textArea = contentEl.createEl("textarea", {
      cls: "diexar-keep-capture-textarea",
      attr: { placeholder: "Dump hier je gedachte, idee of taak…\n\nGebruik [[Link]] om te koppelen." },
    });
    this.textArea.rows = 8;

    const footer = contentEl.createDiv({ cls: "diexar-keep-capture-footer" });
    const hint = footer.createSpan({ cls: "diexar-keep-capture-hint" });
    hint.setText("Ctrl/Cmd + Enter = opslaan • Esc = sluiten");

    const buttons = footer.createDiv({ cls: "diexar-keep-capture-buttons" });
    const cancel = buttons.createEl("button", { text: "Annuleren" });
    cancel.addEventListener("click", () => this.close());
    const save = buttons.createEl("button", { text: "Opslaan", cls: "mod-cta" });
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
    let bar = parent.querySelector(".diexar-keep-capture-controls") as HTMLElement | null;
    if (!bar) bar = parent.createDiv({ cls: "diexar-keep-capture-controls" });
    bar.empty();

    // Kleur
    const colorRow = bar.createDiv({ cls: "diexar-keep-edit-colorrow" });
    colorRow.createSpan({ text: "Kleur:", cls: "diexar-keep-edit-label" });
    const swatches = colorRow.createDiv({ cls: "diexar-keep-edit-swatches" });
    for (const name of COLOR_NAMES) {
      const sw = swatches.createDiv({
        cls: `diexar-keep-edit-swatch${name === this.state.color ? " is-active" : ""}`,
        attr: { "aria-label": COLOR_LABELS_NL[name], title: COLOR_LABELS_NL[name] },
      });
      sw.dataset.color = name;
      sw.addEventListener("click", () => {
        this.state.color = name;
        this.renderControls(parent);
      });
    }

    // Pin + link
    const actionRow = bar.createDiv({ cls: "diexar-keep-edit-row" });
    const pinBtn = actionRow.createEl("button", {
      cls: `diexar-keep-edit-pin${this.state.pinned ? " is-active" : ""}`,
      text: this.state.pinned ? "📌 Vastgezet" : "📍 Vastzetten",
    });
    pinBtn.addEventListener("click", () => {
      this.state.pinned = !this.state.pinned;
      this.renderControls(parent);
    });

    const linkBtn = actionRow.createEl("button", {
      cls: "diexar-keep-edit-linkbtn",
      text: "🔗 Link invoegen",
    });
    linkBtn.addEventListener("click", () => {
      new InsertLinkModal(this.app, (path) => this.insertLinkAtCursor(path)).open();
    });

    // Tags
    const tagRow = bar.createDiv({ cls: "diexar-keep-edit-tagrow" });
    tagRow.createSpan({ text: "Tags:", cls: "diexar-keep-edit-label" });
    this.chipsEl = tagRow.createDiv({ cls: "diexar-keep-edit-chips" });
    this.renderChips();

    const tagInput = tagRow.createEl("input", {
      cls: "diexar-keep-edit-taginput",
      attr: { type: "text", placeholder: "Voeg tag toe…" },
    });
    const datalistId = `diexar-keep-tagcompletion-capture-${Date.now()}`;
    const datalist = tagRow.createEl("datalist", { attr: { id: datalistId } });
    tagInput.setAttribute("list", datalistId);
    for (const t of getAllVaultTags(this.app)) {
      datalist.createEl("option", { attr: { value: t } });
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
      const chip = this.chipsEl.createSpan({ cls: "diexar-keep-edit-chip" });
      chip.createSpan({ text: `#${tag}` });
      const x = chip.createSpan({ cls: "diexar-keep-edit-chip-x", text: "×" });
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

  async save(): Promise<void> {
    let content = this.textArea.value.trim();
    if (!content) {
      new Notice("Niets te bewaren — kaartje is leeg.");
      return;
    }

    // Als de tekst een URL bevat, haal OG-meta op en bed de thumbnail in.
    // Soft-fail: bij timeout of fout slaan we gewoon de originele tekst op.
    const url = detectUrl(content);
    if (url) {
      const notice = new Notice("Preview ophalen…", 0);
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
        console.error("Diexar Keep: preview ophalen mislukt:", e);
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
      new Notice(`Opgeslagen: ${file.basename}`);
      this.plugin.refreshViews();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Fout bij opslaan: ${message}`);
      return;
    }
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
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

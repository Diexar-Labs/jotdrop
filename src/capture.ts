import { App, Modal, Notice, Setting, TFile, normalizePath } from "obsidian";
import type DiexarKeepPlugin from "./main";

export class QuickCaptureModal extends Modal {
  plugin: DiexarKeepPlugin;
  textArea!: HTMLTextAreaElement;

  constructor(app: App, plugin: DiexarKeepPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Snelle notitie");
    contentEl.addClass("diexar-keep-capture");

    this.textArea = contentEl.createEl("textarea", {
      cls: "diexar-keep-capture-textarea",
      attr: { placeholder: "Dump hier je gedachte, idee of taak…\n\nGebruik #tags om te ordenen." },
    });
    this.textArea.rows = 8;

    const footer = contentEl.createDiv({ cls: "diexar-keep-capture-footer" });
    const hint = footer.createSpan({ cls: "diexar-keep-capture-hint" });
    hint.setText("Ctrl/Cmd + Enter = opslaan • Esc = sluiten");

    new Setting(footer)
      .addButton((b) =>
        b.setButtonText("Annuleren").onClick(() => this.close())
      )
      .addButton((b) =>
        b
          .setButtonText("Opslaan")
          .setCta()
          .onClick(() => this.save())
      );

    this.textArea.addEventListener("keydown", (evt) => {
      if ((evt.ctrlKey || evt.metaKey) && evt.key === "Enter") {
        evt.preventDefault();
        this.save();
      }
    });

    setTimeout(() => this.textArea.focus(), 50);
  }

  async save(): Promise<void> {
    const content = this.textArea.value.trim();
    if (!content) {
      new Notice("Niets te bewaren — kaartje is leeg.");
      return;
    }
    try {
      const file = await createNoteInFolder(this.app, this.plugin.settings.notesFolder, content);
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

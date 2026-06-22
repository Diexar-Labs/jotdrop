import { App, FileSystemAdapter, Modal, Notice, TFile } from "obsidian";
import type JotDropPlugin from "./main";
import { EditNoteModal } from "./edit";
import { voidAsync } from "./asyncUtil";
import { t } from "./i18n";

/**
 * Modal that shows the card's associated image at full size. Opened when the
 * user clicks a card with a thumbnail; provides buttons to edit the note or
 * open the image in an Obsidian tab.
 */
export class LightboxModal extends Modal {
  private plugin: JotDropPlugin;
  private noteFile: TFile;
  private imageResourcePath: string;
  private attachmentFile: TFile | null;
  private vaultPath: string | null;

  constructor(
    app: App,
    plugin: JotDropPlugin,
    noteFile: TFile,
    imageResourcePath: string,
    attachmentFile: TFile | null,
    vaultPath: string | null = null,
  ) {
    super(app);
    this.plugin = plugin;
    this.noteFile = noteFile;
    this.imageResourcePath = imageResourcePath;
    this.attachmentFile = attachmentFile;
    this.vaultPath = vaultPath ?? attachmentFile?.path ?? null;
  }

  onOpen(): void {
    this.titleEl.setText(this.noteFile.basename);
    const root = this.contentEl;
    root.addClass("jotdrop-lightbox");

    const figure = root.createDiv({ cls: "jotdrop-lightbox-figure" });
    const img = figure.createEl("img", { cls: "jotdrop-lightbox-img" });
    img.src = this.imageResourcePath;
    img.alt = this.noteFile.basename;
    img.addEventListener("error", () => {
      figure.empty();
      figure.createEl("p", {
        cls: "jotdrop-lightbox-error",
        text: t("lightbox_load_failed"),
      });
    });

    const actions = root.createDiv({ cls: "jotdrop-lightbox-actions" });

    const editBtn = actions.createEl("button", {
      text: t("action_edit_note"),
    });
    editBtn.addEventListener("click", () => {
      this.close();
      new EditNoteModal(this.app, this.plugin, this.noteFile).open();
    });

    if (this.attachmentFile) {
      const openBtn = actions.createEl("button", {
        text: t("lightbox_open_in_tab"),
      });
      openBtn.addEventListener("click", voidAsync(async () => {
        try {
          await this.app.workspace.getLeaf("tab").openFile(this.attachmentFile!);
          this.close();
        } catch (err) {
          new Notice(t("notice_error", err instanceof Error ? err.message : String(err)));
        }
      }));
    }

    const adapter = this.app.vault.adapter;
    if (this.vaultPath && adapter instanceof FileSystemAdapter) {
      const externalBtn = actions.createEl("button", {
        cls: "jotdrop-lightbox-external",
        text: t("lightbox_open_external"),
      });
      externalBtn.addEventListener("click", voidAsync(async () => {
        try {
          const fullPath = adapter.getFullPath(this.vaultPath!);
          // Electron's shell — desktop only; not part of Obsidian's plugin TS types.
          // eslint-disable-next-line @typescript-eslint/no-require-imports -- desktop-only "open in system app"; Electron's shell has no Obsidian-typed equivalent
          const { shell } = require("electron") as { shell: { openPath(path: string): Promise<string> } };
          const err = await shell.openPath(fullPath);
          if (err) {
            new Notice(t("notice_error", err));
          } else {
            this.close();
          }
        } catch (err) {
          new Notice(t("notice_error", err instanceof Error ? err.message : String(err)));
        }
      }));
    }

    const closeBtn = actions.createEl("button", {
      cls: "mod-cta",
      text: t("action_close"),
    });
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

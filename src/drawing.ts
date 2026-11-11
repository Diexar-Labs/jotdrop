import { App, Modal, TFile } from "obsidian";
import type JotDropPlugin from "./main";
import { createDrawingEditor } from "../cloud/shared/drawing-editor.mjs";
import { drawingFileName, isDrawingName, read as readDrawing } from "../cloud/shared/drawing.mjs";
import { ConfirmModal } from "./confirmModal";
import { t } from "./i18n";

export { isDrawingName };

/** A drawing as the shared format reads it: lines in pixels of a 1080 x 1440 picture. */
export interface Drawing {
  width: number;
  height: number;
  strokes: { color: string; size: number; points: number[] }[];
}

/** Yes or no through the plugin's own confirm modal, as a promise for the shared editor. */
function ask(app: App, title: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    let yes = false;
    const modal = new ConfirmModal(app, { title, message: "", confirmLabel, destructive: true }, () => { yes = true; });
    const close = modal.onClose.bind(modal);
    // The confirm modal closes itself before it calls back, so the answer is read a tick later.
    modal.onClose = () => { close(); window.setTimeout(() => resolve(yes), 0); };
    modal.open();
  });
}

/**
 * The drawing screen (shared with the web app and the Joplin plugin, see cloud/shared/drawing-editor.mjs) in an
 * Obsidian modal. Works with mouse, pen and finger. `onSave` gets the PNG with the lines inside; it saves the file
 * and puts it in a note, and may throw to show a message and keep the drawing open.
 */
export class DrawingModal extends Modal {
  private leaving = false;
  private editor: ReturnType<typeof createDrawingEditor> | null = null;

  constructor(app: App, private initial: Drawing | null, private onSave: (png: Uint8Array) => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("jotdrop-drawing-modal");
    const labels = {
      title: t("drawing_title"), save: t("action_save"), cancel: t("action_cancel"), canvas: t("drawing_canvas"),
      colors: t("drawing_colors"), widths: t("drawing_widths"),
      black: t("drawing_color_black"), blue: t("drawing_color_blue"), red: t("drawing_color_red"),
      green: t("drawing_color_green"), orange: t("drawing_color_orange"), purple: t("drawing_color_purple"),
      thin: t("drawing_size_thin"), medium: t("drawing_size_medium"), thick: t("drawing_size_thick"),
      eraser: t("drawing_eraser"), undo: t("drawing_undo"), redo: t("drawing_redo"), clear: t("drawing_clear"),
      clearAsk: t("drawing_clear_title"), discardAsk: t("drawing_discard_title"), saving: t("drawing_saving"),
    };
    this.editor = createDrawingEditor({
      initial: this.initial,
      labels,
      confirm: (text: string) => ask(this.app, text, text === labels.clearAsk ? labels.clear : t("drawing_discard")),
      onSave: async ({ png }: { png: Uint8Array }) => {
        await this.onSave(png);
        this.leaving = true;
        this.close();
      },
      onCancel: () => { this.leaving = true; this.close(); },
    });
    this.contentEl.append(this.editor.element);
  }

  /** The X and Escape go through the editor, which asks first when there is unsaved work. */
  close(): void {
    if (this.editor && !this.leaving) { void this.editor.close(); return; }
    super.close();
  }

  onClose(): void {
    this.editor = null;
    this.contentEl.empty();
  }
}

/** Writes a drawing as a new file drawing-<date time>.png in the attachments folder of [note]; the basename for its embed. */
export async function saveDrawingFile(plugin: JotDropPlugin, png: Uint8Array, note?: TFile): Promise<string> {
  return plugin.saveAttachment(drawingFileName(), png, note);
}

/** The lines inside an attachment, or null when the file is not a JotDrop drawing (or cannot be read). */
export async function readDrawingAt(app: App, vaultPath: string): Promise<Drawing | null> {
  try {
    return readDrawing(new Uint8Array(await app.vault.adapter.readBinary(vaultPath))) as Drawing | null;
  } catch {
    return null;
  }
}

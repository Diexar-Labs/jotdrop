import { App, Modal } from "obsidian";
import { t } from "./i18n";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
}

/**
 * Simple yes/no confirmation modal. Closes on Cancel or confirm; on confirm
 * the callback is invoked. Counterpart of Android's AlertDialog with
 * "Cancel" + action button.
 */
export class ConfirmModal extends Modal {
  private opts: ConfirmOptions;
  private onConfirm: () => void;

  constructor(app: App, opts: ConfirmOptions, onConfirm: () => void) {
    super(app);
    this.opts = opts;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.opts.title);
    contentEl.createEl("p", { text: this.opts.message });

    const footer = contentEl.createDiv({ cls: "jotdrop-confirm-footer" });
    const cancel = footer.createEl("button", {
      cls: "jotdrop-confirm-cancel",
      text: t("action_cancel"),
    });
    cancel.addEventListener("click", () => this.close());

    const confirm = footer.createEl("button", {
      cls: `jotdrop-confirm-ok${this.opts.destructive ? " is-destructive" : ""}`,
      text: this.opts.confirmLabel,
    });
    confirm.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
    window.setTimeout(() => confirm.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

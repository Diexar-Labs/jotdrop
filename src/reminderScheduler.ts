import { Notice, TFile, normalizePath } from "obsidian";
import type JotDropPlugin from "./main";
import { LightboxModal } from "./lightbox";
import { EditNoteModal } from "./edit";
import { parseReminderMs, readMeta } from "./metadata";
import { t } from "./i18n";

/**
 * Tracks window timeouts per note path so reminders can be rescheduled
 * when a note changes, and cleaned up properly on plugin unload.
 * setTimeout has a max delay of ~24.8 days — for reminders further away
 * we reschedule every day instead of one giant timeout.
 */
export class ReminderScheduler {
  private plugin: JotDropPlugin;
  private timers: Map<string, number> = new Map();
  private static readonly MAX_DELAY_MS = 24 * 60 * 60 * 1000; // 24 h, ruim onder browser-limiet

  constructor(plugin: JotDropPlugin) {
    this.plugin = plugin;
  }

  scheduleAll(): void {
    this.cancelAll();
    const root = normalizePath(this.plugin.settings.notesFolder);
    const files = this.plugin.app.vault.getMarkdownFiles().filter((f) =>
      f.path === root || f.path.startsWith(`${root}/`),
    );
    for (const file of files) this.scheduleFile(file);
  }

  scheduleFile(file: TFile): void {
    this.cancelFile(file.path);
    // Archived notes never fire — parity with the Android app, which cancels
    // the alarm on archive. Covers load, modify AND rename-into-archive.
    const archive = normalizePath(this.plugin.settings.archiveFolder);
    if (archive && (file.path === archive || file.path.startsWith(`${archive}/`))) return;
    const meta = readMeta(this.plugin.app, file);
    const ms = parseReminderMs(meta.reminder);
    if (!Number.isFinite(ms)) return;

    const delay = ms - Date.now();
    if (delay <= 0) return; // Already overdue — card shows "Overdue" badge; we do not fire retroactively.

    if (delay > ReminderScheduler.MAX_DELAY_MS) {
      // Wait 24 h and re-evaluate; avoids browser setTimeout overflow for
      // far-future dates and makes restart after sleep more robust.
      const id = window.setTimeout(() => {
        this.timers.delete(file.path);
        this.scheduleFile(file);
      }, ReminderScheduler.MAX_DELAY_MS);
      this.timers.set(file.path, id);
      return;
    }

    const id = window.setTimeout(() => {
      this.timers.delete(file.path);
      this.fire(file);
    }, delay);
    this.timers.set(file.path, id);
  }

  cancelFile(path: string): void {
    const id = this.timers.get(path);
    if (id !== undefined) {
      window.clearTimeout(id);
      this.timers.delete(path);
    }
  }

  cancelAll(): void {
    for (const id of this.timers.values()) window.clearTimeout(id);
    this.timers.clear();
  }

  private fire(file: TFile): void {
    // Notice with click handler → opens lightbox if there is an attachment,
    // otherwise the edit modal.
    const notice = new Notice(t("notice_reminder_fired", file.basename), 30_000);
    notice.messageEl.addClass("jotdrop-reminder-notice");
    notice.messageEl.addEventListener("click", () => {
      notice.hide();
      void this.openCard(file);
    });
  }

  private async openCard(file: TFile): Promise<void> {
    // Try to find an embedded image for the lightbox; otherwise edit modal.
    const content = await this.plugin.app.vault.cachedRead(file);
    const m = content.match(/!\[\[([^\]|]+?)\]\]/);
    if (m) {
      const basename = m[1].trim().split("|")[0].trim();
      const resourcePath = this.plugin.app.vault.adapter.getResourcePath(
        normalizePath(`${file.parent?.path ?? ""}/.attachments/${basename}`),
      );
      new LightboxModal(this.plugin.app, this.plugin, file, resourcePath, null).open();
      return;
    }
    new EditNoteModal(this.plugin.app, this.plugin, file).open();
  }
}

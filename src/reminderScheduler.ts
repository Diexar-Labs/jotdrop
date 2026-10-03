import { Notice, TFile, normalizePath } from "obsidian";
import type JotDropPlugin from "./main";
import { LightboxModal } from "./lightbox";
import { EditNoteModal } from "./edit";
import { parseReminderMs, readMeta, updateMeta } from "./metadata";
import {
  advanceRecurrence,
  isRecurrenceExpired,
  parseLocalDateTime,
  parseRepeat,
  RecurrenceState,
} from "./recurrence";
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
    if (!Number.isFinite(ms) || !meta.reminder) return;

    if (meta.reminderRepeat) {
      const spec = parseRepeat(meta.reminderRepeat);
      const cur = spec ? parseLocalDateTime(meta.reminder) : null;
      if (!spec || !cur) {
        // Not a recurrence we can advance (bad repeat or a non-local reminder
        // format): keep the reminder as one-time, drop the repeat config.
        void updateMeta(this.plugin.app, file, {
          reminderRepeat: null,
          reminderUntil: null,
          reminderLimit: null,
          reminderDone: 0,
        });
        this.scheduleDelay(file, ms - Date.now());
        return;
      }
      const state: RecurrenceState = {
        reminder: meta.reminder,
        repeat: meta.reminderRepeat,
        until: meta.reminderUntil,
        limit: meta.reminderLimit,
        done: meta.reminderDone,
      };
      const now = Date.now();
      if (isRecurrenceExpired(state, now)) {
        void this.clearSeries(file);
        return;
      }
      if (ms <= now) {
        // Overdue on startup: fire once, then advance to the next future occurrence.
        void this.fireAndAdvance(file, state, now);
        return;
      }
      this.scheduleDelay(file, ms - now);
      return;
    }

    this.scheduleDelay(file, ms - Date.now());
  }

  /** Schedules a one-time (or already-advanced) timer; non-positive delay = do nothing. */
  private scheduleDelay(file: TFile, delay: number): void {
    if (delay <= 0) return;
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
      void this.fire(file);
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

  private async fire(file: TFile): Promise<void> {
    this.showFireNotice(file);
    await this.advanceIfRecurring(file);
  }

  private async fireAndAdvance(file: TFile, state: RecurrenceState, now: number): Promise<void> {
    this.showFireNotice(file);
    const result = advanceRecurrence(state, now);
    if (result.kind === "expired") {
      await this.clearSeries(file);
    } else {
      await updateMeta(this.plugin.app, file, { reminder: result.reminder, reminderDone: result.done });
      this.scheduleFile(file);
    }
    this.plugin.refreshViews();
  }

  private async advanceIfRecurring(file: TFile): Promise<void> {
    const meta = readMeta(this.plugin.app, file);
    if (!meta.reminderRepeat || !meta.reminder) return;
    const spec = parseRepeat(meta.reminderRepeat);
    if (!spec) return;
    const state: RecurrenceState = {
      reminder: meta.reminder,
      repeat: meta.reminderRepeat,
      until: meta.reminderUntil,
      limit: meta.reminderLimit,
      done: meta.reminderDone,
    };
    const result = advanceRecurrence(state, Date.now());
    if (result.kind === "expired") {
      await this.clearSeries(file);
    } else {
      await updateMeta(this.plugin.app, file, { reminder: result.reminder, reminderDone: result.done });
      this.scheduleFile(file);
    }
    this.plugin.refreshViews();
  }

  /** Expiry clears the series (reminder + all repeat keys) — never archives/deletes the note. */
  private async clearSeries(file: TFile): Promise<void> {
    await updateMeta(this.plugin.app, file, { reminder: null });
    this.plugin.refreshViews();
  }

  private showFireNotice(file: TFile): void {
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
      const candidates = this.plugin.resolveAssetCandidates(file, basename);
      const first = candidates[0];
      if (first) {
        const resourcePath = first.file
          ? this.plugin.app.vault.getResourcePath(first.file)
          : this.plugin.app.vault.adapter.getResourcePath(first.vaultPath);
        new LightboxModal(
          this.plugin.app,
          this.plugin,
          file,
          resourcePath,
          first.file,
          first.vaultPath,
        ).open();
        return;
      }
    }
    new EditNoteModal(this.plugin.app, this.plugin, file).open();
  }
}

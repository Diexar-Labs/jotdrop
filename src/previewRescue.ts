import { Notice, TAbstractFile, TFile } from "obsidian";
import { fetchOg, buildLinkNote, detectUrl } from "./ogfetch";
import type JotDropPlugin from "./main";
import { t } from "./i18n";

/**
 * Picks up placeholder notes sent by Android v0.6.0+ via Syncthing
 * (identified by `<!-- jotdrop-preview: pending -->` or the older
 * `diexar-preview` format) that the Android-side `PreviewWorker` could not
 * finish for whatever reason — e.g. the phone was offline, battery died,
 * or WorkManager retries were exhausted.
 *
 * Strategy: rescue only when the file mtime is older than `MIN_RESCUE_AGE_MS`.
 * On every modify event the timer deadline is recalculated from the fresh
 * mtime — Android's own OG update bumps mtime and thereby resets our wait
 * time, so we never overwrite their fresh version. Prevents Syncthing
 * conflicts with slow OG endpoints (TikTok oEmbed sometimes runs 30s+).
 */

// Accept all three markers — `obsidrop-preview` and `diexar-preview` are kept
// for placeholders that arrived from older Android builds (before each rename).
const PENDING_MARKER_REGEX = /<!--\s*(?:jotdrop|obsidrop|diexar)-preview:\s*pending\s*-->/;
function hasPendingMarker(content: string): boolean {
  return PENDING_MARKER_REGEX.test(content);
}

// Marker must be at least 5 min old (by file mtime) before we intervene.
// Gives Android plenty of room to finish its own PreviewWorker, even with
// slow OG endpoints + Syncthing propagation delay.
const MIN_RESCUE_AGE_MS = 5 * 60 * 1000;

export class PreviewRescue {
  private pending = new Map<string, number>();

  constructor(private plugin: JotDropPlugin) {}

  start(): void {
    const { vault } = this.plugin.app;
    this.plugin.registerEvent(vault.on("create", this.onChange));
    this.plugin.registerEvent(vault.on("modify", this.onChange));
    this.plugin.registerEvent(vault.on("delete", this.onDelete));

    // On plugin load: scan existing pending notes. May have arrived via
    // Syncthing while the plugin was off.
    this.plugin.app.workspace.onLayoutReady(() => {
      void this.scanExisting();
    });
  }

  private onChange = (file: TAbstractFile): void => {
    if (!(file instanceof TFile)) return;
    if (file.extension !== "md") return;
    void this.maybeSchedule(file);
  };

  private onDelete = (file: TAbstractFile): void => {
    const timer = this.pending.get(file.path);
    if (timer != null) {
      window.clearTimeout(timer);
      this.pending.delete(file.path);
    }
  };

  private async scanExisting(): Promise<void> {
    const files = this.plugin.app.vault.getMarkdownFiles();
    for (const file of files) {
      await this.maybeSchedule(file);
    }
  }

  /**
   * Attempts to rescue all pending notes immediately, without the 15s wait.
   * Useful for manual testing/debugging via a command.
   */
  async rescueAllNow(): Promise<number> {
    const files = this.plugin.app.vault.getMarkdownFiles();
    let count = 0;
    for (const file of files) {
      let content: string;
      try {
        content = await this.plugin.app.vault.read(file);
      } catch {
        continue;
      }
      if (!hasPendingMarker(content)) continue;
      const t = this.pending.get(file.path);
      if (t != null) {
        window.clearTimeout(t);
        this.pending.delete(file.path);
      }
      await this.rescue(file);
      count++;
    }
    new Notice(t("notice_pending_attempted", String(count)));
    return count;
  }

  private async maybeSchedule(file: TFile): Promise<void> {
    let content: string;
    try {
      content = await this.plugin.app.vault.read(file);
    } catch {
      return;
    }
    if (!hasPendingMarker(content)) {
      const t = this.pending.get(file.path);
      if (t != null) {
        window.clearTimeout(t);
        this.pending.delete(file.path);
      }
      return;
    }
    // On modify event: cancel the old timer and reschedule with the fresh
    // mtime — Android OG updates thereby reset our wait time, and with it
    // the race that causes Syncthing conflicts.
    const existing = this.pending.get(file.path);
    if (existing != null) {
      window.clearTimeout(existing);
      this.pending.delete(file.path);
    }
    const age = Date.now() - file.stat.mtime;
    // Wait at least 1s to debounce rapid burst events; max = the remaining
    // time until mtime + MIN_RESCUE_AGE_MS.
    const wait = Math.max(MIN_RESCUE_AGE_MS - age, 1_000);
    const timer = window.setTimeout(() => {
      this.pending.delete(file.path);
      void this.rescue(file);
    }, wait);
    this.pending.set(file.path, timer);
  }

  private async rescue(file: TFile): Promise<void> {
    let content: string;
    try {
      content = await this.plugin.app.vault.read(file);
    } catch {
      return;
    }
    if (!hasPendingMarker(content)) return; // Android got there first.

    // Mtime may have been refreshed during our fetch by an incoming
    // Syncthing update — reschedule instead of continuing, otherwise conflict risk.
    if (Date.now() - file.stat.mtime < MIN_RESCUE_AGE_MS) {
      void this.maybeSchedule(file);
      return;
    }

    const url = detectUrl(content);
    if (!url) return;

    const attachmentsFolder = `${this.plugin.settings.notesFolder}/.attachments`;
    const preview = await fetchOg(this.plugin.app, attachmentsFolder, url, this.plugin.settings.downloadImages);
    if (!preview) return;

    // Race check: read once more just before the write — if the marker
    // disappeared between fetch and write, do not overwrite.
    let latest: string;
    try {
      latest = await this.plugin.app.vault.read(file);
    } catch {
      return;
    }
    if (!hasPendingMarker(latest)) return;

    // Preserve frontmatter set while the preview was pending (tags/color/pin
    // added to the fresh card would otherwise be wiped by the rewrite).
    const fmMatch = latest.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    const fm = fmMatch ? fmMatch[0] : "";
    const newContent = fm + buildLinkNote(url, preview, url);
    try {
      await this.plugin.app.vault.modify(file, newContent);
    } catch (e) {
      console.error("JotDrop preview-rescue: write failed for", file.path, e);
    }
  }
}

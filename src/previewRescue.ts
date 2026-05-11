import { Notice, TAbstractFile, TFile } from "obsidian";
import { fetchOg, buildLinkNote, detectUrl } from "./ogfetch";
import type DiexarKeepPlugin from "./main";

/**
 * Pakt placeholder-notities op die Android v0.6.0+ via Syncthing binnenstuurt
 * (gekenmerkt door `<!-- diexar-preview: pending -->`) en die de Android-side
 * `PreviewWorker` om wat voor reden ook niet kon afronden — bv. omdat de
 * telefoon offline was, de batterij leeg ging, of WorkManager-retries op zijn.
 *
 * Wachttijd: 15s voor we ingrijpen, zodat Android-PreviewWorker eerst zijn
 * kans krijgt en we geen Syncthing-conflicts triggeren. Marker-check vóór elke
 * write voorkomt dat we user-edits of een net-succesvolle Android-update
 * overschrijven.
 */

const PENDING_MARKER = "<!-- diexar-preview: pending -->";
const RESCUE_DELAY_MS = 15_000;

export class PreviewRescue {
  private pending = new Map<string, number>();

  constructor(private plugin: DiexarKeepPlugin) {}

  start(): void {
    const { vault } = this.plugin.app;
    this.plugin.registerEvent(vault.on("create", this.onChange));
    this.plugin.registerEvent(vault.on("modify", this.onChange));
    this.plugin.registerEvent(vault.on("delete", this.onDelete));

    // Bij plugin-load: scan bestaande pending-notities. Kunnen via Syncthing
    // zijn binnengekomen toen plugin uit was.
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
   * Probeert nu meteen alle pending-notities op te halen, zonder de 15s
   * wachttijd. Handig voor handmatige test/debug via een command.
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
      if (!content.includes(PENDING_MARKER)) continue;
      const t = this.pending.get(file.path);
      if (t != null) {
        window.clearTimeout(t);
        this.pending.delete(file.path);
      }
      await this.rescue(file);
      count++;
    }
    new Notice(`Diexar Keep: ${count} pending-notitie(s) geprobeerd`);
    return count;
  }

  private async maybeSchedule(file: TFile): Promise<void> {
    let content: string;
    try {
      content = await this.plugin.app.vault.read(file);
    } catch {
      return;
    }
    if (!content.includes(PENDING_MARKER)) {
      const t = this.pending.get(file.path);
      if (t != null) {
        window.clearTimeout(t);
        this.pending.delete(file.path);
      }
      return;
    }
    // Al gepland — een nieuwe modify hoeft 'm niet opnieuw te starten,
    // anders schuift de timer eindeloos op bij snelle Syncthing-updates.
    if (this.pending.has(file.path)) return;
    const timer = window.setTimeout(() => {
      this.pending.delete(file.path);
      void this.rescue(file);
    }, RESCUE_DELAY_MS);
    this.pending.set(file.path, timer);
  }

  private async rescue(file: TFile): Promise<void> {
    let content: string;
    try {
      content = await this.plugin.app.vault.read(file);
    } catch {
      return;
    }
    if (!content.includes(PENDING_MARKER)) return; // Android was 'm voor.

    const url = detectUrl(content);
    if (!url) return;

    const attachmentsFolder = `${this.plugin.settings.notesFolder}/.attachments`;
    const preview = await fetchOg(this.plugin.app, attachmentsFolder, url);
    if (!preview) return;

    // Race-check: lees nog een keer vlak voor de write — als de marker tussen
    // fetch en write verdween, niet overschrijven.
    let latest: string;
    try {
      latest = await this.plugin.app.vault.read(file);
    } catch {
      return;
    }
    if (!latest.includes(PENDING_MARKER)) return;

    const newContent = buildLinkNote(url, preview, url);
    try {
      await this.plugin.app.vault.modify(file, newContent);
    } catch (e) {
      console.error("Diexar Keep preview-rescue: write faalde voor", file.path, e);
    }
  }
}

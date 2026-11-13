// Find duplicates in Obsidian (Ask JotDrop v2, part E, phase 7): the same flow as the web app (cloud/web/app.js). The
// notes are compared on this device with the shared code (cloud/shared/similar.mjs), without AI and without sending
// anything. Per pair: Compare, move one note to the trash, Keep both, and, when the AI is on, Merge with AI (the Ask
// window takes over). Moving a note to the trash is always the user's own click.
import { type App, Modal, TFile, setIcon } from "obsidian";
import type JotDropPlugin from "./main";
import { type AiNote, DuplicatesKept, collectAiNotes } from "./ai";
import { diffLines, findDuplicates, foldUnchanged, pairKey } from "./aiShared";

export type DuplicatesOptions = {
  /** The board's own way to move a note to the JotDrop trash. */
  trash: (file: TFile) => Promise<void>;
  /** "Merge with AI…": the Ask window with both notes and a fixed request. */
  merge: (older: AiNote, newer: AiNote) => void;
};

const when = (note: AiNote): string => (note.updatedAt ? `edited ${new Date(note.updatedAt).toLocaleDateString()}` : "no edit date");

export class DuplicatesModal extends Modal {
  private kept: string[] = [];
  private store: DuplicatesKept;
  private statusEl!: HTMLElement;
  private listEl!: HTMLElement;
  private closed = false;

  constructor(app: App, private plugin: JotDropPlugin, private options: DuplicatesOptions, store?: DuplicatesKept) {
    super(app);
    this.store = store ?? new DuplicatesKept(app);
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass("jotdrop-ai-modal");
    this.titleEl.setText("Find duplicates");
    const root = this.contentEl;
    root.empty();
    root.createEl("p", {
      cls: "setting-item-description",
      text: "JotDrop compares your notes on this device. Finding duplicates uses no AI and sends nothing. \"Merge with AI\" is a separate choice: it sends the two notes you pick to your AI service. Notes from shared groups and notes with a live list link are left out, and so are very short notes and the trash.",
    });
    this.statusEl = root.createEl("p", { cls: "jotdrop-ai-status", attr: { role: "status", "aria-live": "polite" } });
    this.listEl = root.createEl("ul", { cls: "jotdrop-dup-list" });
    this.say("Looking for duplicates on this device...");
    this.kept = await this.store.load();
    // Let the window show first: many notes can take a few seconds.
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    if (!this.closed) await this.render();
  }

  private say(text: string): void { this.statusEl.setText(text); }

  private fileOf(id: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(id);
    return file instanceof TFile ? file : null;
  }

  private async render(): Promise<void> {
    const { notes, texts } = await collectAiNotes(this.plugin);
    if (this.closed) return;
    const byId = new Map(notes.map((note) => [note.id, note]));
    const { pairs, complete } = findDuplicates(notes, { dismissed: this.kept });
    const more = complete ? "" : " The search stopped early, so this list may not be complete. Deal with these, then search again.";
    this.say(pairs.length ? `${pairs.length} ${pairs.length === 1 ? "pair" : "pairs"} found.${more}` : complete ? "No duplicate notes found." : "Nothing found yet, and the search stopped early. Try again.");
    this.listEl.empty();
    const aiOn = Boolean((await this.plugin.aiStore.load()).provider);
    for (const pair of pairs) {
      const older = byId.get(pair.a), newer = byId.get(pair.b), drop = byId.get(pair.drop);
      if (!older || !newer || !drop) continue;
      const item = this.listEl.createEl("li", { cls: "jotdrop-dup-item" });
      // Words, not color: the kind is written out.
      item.createEl("h4", { text: pair.kind === "same" ? "Same text" : pair.kind === "near" ? `Almost the same (${Math.round(pair.score * 100)}%)` : `One note is inside the other (${Math.round(pair.score * 100)}% of "${drop.title}")` });
      item.createEl("p", { text: `Older: "${older.title}", ${when(older)}` });
      item.createEl("p", { text: `Newer: "${newer.title}", ${when(newer)}` });
      const buttons = item.createDiv({ cls: "jotdrop-ai-buttons" });
      const box = item.createDiv({ cls: "jotdrop-dup-compare" });
      box.hide();
      buttons.createEl("button", { text: "Compare" }).addEventListener("click", () => {
        if (box.isShown()) { box.hide(); return; }
        this.showCompare(box, older, newer, texts.get(pair.a) ?? "", texts.get(pair.b) ?? "");
        box.show();
      });
      // The button names the note: the older one, or for "inside" the shorter one, never the note that holds more.
      buttons.createEl("button", { text: `Move "${drop.title}" to the trash` }).addEventListener("click", () => void this.trash(pair.drop));
      buttons.createEl("button", { text: "Keep both" }).addEventListener("click", () => void this.keepBoth(pair.a, pair.b));
      if (aiOn) buttons.createEl("button", { text: "Merge with AI…" }).addEventListener("click", () => { this.close(); this.options.merge(older, newer); });
    }
  }

  private showCompare(box: HTMLElement, older: AiNote, newer: AiNote, before: string, after: string): void {
    box.empty();
    const lines = diffLines(before, after);
    if (!lines) { box.createEl("p", { text: "These notes are too long to compare here." }); return; }
    box.createEl("p", { cls: "setting-item-description", text: `From the older note "${older.title}" to the newer note "${newer.title}": + was added, - was removed.` });
    for (const line of foldUnchanged(lines.map((one) => ({ ...one, sign: one.type === "added" ? "+ " : one.type === "removed" ? "- " : "  " })))) {
      box.createDiv({ cls: `jotdrop-diff-line ${line.type}`, text: line.type === "gap" ? `${line.count} unchanged ${line.count === 1 ? "line" : "lines"}` : `${line.sign}${line.text}` });
    }
  }

  private async trash(id: string): Promise<void> {
    const file = this.fileOf(id);
    if (!file) { await this.render(); return; }
    await this.options.trash(file);
    await this.render();
  }

  private async keepBoth(a: string, b: string): Promise<void> {
    this.kept = [...this.kept, pairKey(a, b)];
    try { await this.store.save(this.kept); } catch { this.say("Could not remember this on this device. Try again."); return; }
    await this.render();
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }
}

/** The toolbar button on the board, next to Ask JotDrop. */
export function addDuplicatesButton(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
  const button = parent.createEl("button", { cls: "jotdrop-mic-btn jotdrop-ask-btn", attr: { "aria-label": label, title: label } });
  setIcon(button, "copy");
  button.addEventListener("click", onClick);
  return button;
}

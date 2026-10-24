import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import type { CloudController, CloudMoment } from "./cloud";
import { ConfirmModal } from "./confirmModal";

const errorText = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Try again.";
const decoder = new TextDecoder();
const when = (at: string) => new Date(at).toLocaleString();

/** A file as text for the comparison; attachments only by size. */
function preview(el: HTMLElement, path: string, bytes: Uint8Array | null, missing: string): void {
  if (!bytes) { el.createEl("p", { cls: "jotdrop-conflict-missing", text: missing }); return; }
  if (!/\.md$/i.test(path)) { el.createEl("p", { text: `Attachment, ${(bytes.length / 1024).toFixed(1)} KB.` }); return; }
  el.createEl("pre", { cls: "jotdrop-conflict-text", text: decoder.decode(bytes) || "(empty note)" });
}

/** One conflict at a time: this vault's version next to the cloud version, then a choice, like Android. */
export class ConflictReviewModal extends Modal {
  constructor(app: App, private cloud: CloudController) { super(app); }

  onOpen(): void { this.titleEl.setText("Review conflicts"); void this.next(); }
  onClose(): void { this.contentEl.empty(); }

  private async next(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.createEl("p", { text: "Loading..." });
    try {
      const conflicts = await this.cloud.conflicts();
      if (!conflicts.length) {
        el.empty();
        el.createEl("p", { text: "No conflicts. Every note has one version." });
        new Setting(el).addButton((button) => button.setButtonText("Close").setCta().onClick(() => this.close()));
        return;
      }
      const { path, local } = conflicts[0];
      const versions = await this.cloud.compare(path);
      el.empty();
      el.createEl("p", { text: `${conflicts.length === 1 ? "1 note was" : `${conflicts.length} notes were`} changed in two places. This one: ${local}` });
      const compare = el.createDiv({ cls: "jotdrop-conflict-compare" });
      const mine = compare.createDiv();
      mine.createEl("h4", { text: "This vault" });
      preview(mine, path, versions.local, "Removed in this vault.");
      const theirs = compare.createDiv();
      theirs.createEl("h4", { text: "Cloud version" });
      preview(theirs, path, versions.cloud, "Moved to the trash in the cloud.");
      el.createEl("p", { cls: "setting-item-description", text: "The version you do not choose goes to the trash, so it can always come back. The cloud also keeps its history." });
      const message = el.createEl("p", { attr: { role: "status" } });
      const buttons: ButtonComponent[] = [];
      const choose = (keepLocal: boolean) => async () => {
        for (const button of buttons) button.setDisabled(true);
        message.setText("Working...");
        try { await this.cloud.resolve(path, keepLocal); await this.next(); }
        catch (error) { message.setText(errorText(error)); for (const button of buttons) button.setDisabled(false); }
      };
      new Setting(el)
        .addButton((button) => { buttons.push(button); button.setButtonText("Not now").onClick(() => this.close()); })
        .addButton((button) => { buttons.push(button); button.setButtonText("Use the cloud version").onClick(choose(false)); })
        .addButton((button) => { buttons.push(button); button.setButtonText("Keep this vault's version").setCta().onClick(choose(true)); });
    } catch (error) {
      el.empty();
      el.createEl("p", { text: errorText(error) });
    }
  }
}

/** Slide back through the moments with a change, see the notes from then, and restore a moment as a whole. */
export class TimeMachineModal extends Modal {
  private steps: string[] = [];
  private index = 0;
  private request = 0;
  private label!: HTMLElement;
  private body!: HTMLElement;
  private range!: HTMLInputElement;

  constructor(app: App, private cloud: CloudController) { super(app); }

  onOpen(): void { this.titleEl.setText("Time machine"); void this.load(); }
  onClose(): void { this.request++; this.contentEl.empty(); }

  private async load(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.createEl("p", { text: "Loading moments..." });
    try { this.steps = await this.cloud.timeline(); }
    catch (error) { el.empty(); el.createEl("p", { text: errorText(error) }); return; }
    el.empty();
    el.createEl("p", { text: "Slide back to see your notes as they were in the cloud. Each step is a minute with a change." });
    if (this.steps.length < 2) { el.createEl("p", { text: "Earlier moments appear here after your next changes." }); return; }
    this.index = this.steps.length - 1;
    const controls = el.createDiv({ cls: "jotdrop-time-controls" });
    const go = (index: number) => { this.index = Math.max(0, Math.min(this.steps.length - 1, index)); this.range.value = String(this.index); void this.show(); };
    new ButtonComponent(controls).setButtonText("Earlier").onClick(() => go(this.index - 1));
    this.range = controls.createEl("input", { type: "range", attr: { min: "0", max: String(this.steps.length - 1), step: "1", "aria-label": "Moment to show" } });
    this.range.value = String(this.index);
    this.range.addEventListener("input", () => { this.index = Number(this.range.value); this.label.setText(this.name()); });
    this.range.addEventListener("change", () => go(Number(this.range.value)));
    new ButtonComponent(controls).setButtonText("Later").onClick(() => go(this.index + 1));
    this.label = el.createEl("p", { cls: "jotdrop-time-label", text: this.name() });
    this.body = el.createDiv();
  }

  private atNow(): boolean { return this.index >= this.steps.length - 1; }
  private name(): string { return this.atNow() ? "Now" : when(this.steps[this.index]); }

  private async show(): Promise<void> {
    const request = ++this.request, at = this.steps[this.index];
    this.label.setText(this.name());
    this.body.empty();
    if (this.atNow()) return;
    this.body.createEl("p", { text: `Opening ${when(at)}...` });
    let moment: CloudMoment;
    try { moment = await this.cloud.moment(at, () => request === this.request); }
    catch (error) { if (request === this.request) { this.body.empty(); this.body.createEl("p", { text: errorText(error) }); } return; }
    if (request !== this.request) return;
    this.body.empty();
    const notes = moment.files.filter((file) => /\.md$/i.test(file.path));
    this.body.createEl("p", { text: `Read-only. ${notes.length} ${notes.length === 1 ? "note" : "notes"}${moment.files.length > notes.length ? `, ${moment.files.length - notes.length} attachment(s)` : ""}${moment.trashed ? `, ${moment.trashed} in the cloud trash` : ""}.` });
    if (moment.locked) this.body.createEl("p", { text: `${moment.locked} file(s) from then changed more than 30 days ago. JotDrop Plus shows and restores them.` });
    if (moment.cleared) this.body.createEl("p", { text: `${moment.cleared} file(s) from then were cleared to make room in the free storage, so this moment cannot be restored.` });
    new Setting(this.body).addButton((button) => button.setButtonText("Restore this moment").setCta().setDisabled(moment.locked + moment.cleared > 0).onClick(() => this.restore(moment)));
    const list = this.body.createDiv({ cls: "jotdrop-time-notes" });
    for (const file of notes) {
      const item = list.createDiv({ cls: "jotdrop-time-note" });
      const place = file.path.startsWith("notes/Archive/") ? " (archived)" : file.path.startsWith("notes/Trash/") ? " (in the trash)" : "";
      item.createEl("strong", { text: `${(file.path.split("/").pop() || "").replace(/\.md$/i, "")}${place}` });
      const text = decoder.decode(file.bytes).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
      if (text) item.createEl("p", { text: text.length > 200 ? `${text.slice(0, 200)}...` : text });
    }
  }

  private restore(moment: CloudMoment): void {
    new ConfirmModal(this.app, {
      title: `Restore ${when(moment.at)}?`,
      message: "Your notes and files go back to how they were then. Files made after that move to the trash. Every change is a new version, so the time machine can undo this. Notes changed on this device meanwhile are kept as conflict copies.",
      confirmLabel: "Restore",
    }, () => {
      this.body.empty();
      this.body.createEl("p", { text: "Restoring..." });
      void this.cloud.restoreMoment(moment).then(
        (done) => { new Notice(`Restored ${done} file(s) to ${when(moment.at)}.`); void this.load(); },
        (error) => { new Notice(errorText(error), 10000); void this.load(); },
      );
    }).open();
  }
}

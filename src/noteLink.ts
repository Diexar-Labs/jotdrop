import { App, ButtonComponent, DropdownComponent, Modal, Notice, Setting, TFile } from "obsidian";
import { cloudFetch, type CloudController, type ListLink } from "./cloud";
import { createLink, listLinks, removeLink } from "../cloud/shared/links.mjs";
import { createListLink, hasChecklist, listListLinks, openList, removeListLink } from "../cloud/shared/list-links.mjs";

type Link = { id: string; expiresAt: string | null; title: string; address: string | null };
type Line = { task: boolean; text: string; ticked?: boolean; mark?: { by: string; at: number; added: boolean } | null };
// A list link holds about this much text; the sealed list and its marks must stay under the server's 64 KB.
const LIST_TEXT_BYTES = 48 * 1024;
const errorText = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Try again.";
const ago = (iso: string | null): string => {
  const seconds = Math.round((Date.now() - Date.parse(iso ?? "")) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min. ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr. ago`;
  return new Date(iso as string).toLocaleDateString();
};

/** Frontmatter, the first heading as the title, and the body under it: the same split as the website. */
export function splitNote(text: string): { front: string; title: string; body: string } {
  const front = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)?.[0] ?? "";
  const rest = text.slice(front.length);
  const heading = /^#[ \t]+(.*?)[ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)?/.exec(rest);
  return heading ? { front, title: heading[1], body: rest.slice(heading[0].length) } : { front, title: "", body: rest };
}

/** A copy link's text: the body without embedded images; the file's name when the note has no heading. */
function linkNote(file: TFile, text: string): { title: string; text: string } {
  const { title, body } = splitNote(text);
  return { title: title || file.basename, text: body.split(/\r?\n/).filter((line) => !/^\s*!\[/.test(line)).join("\n") };
}

/**
 * A copy of a note anyone with the link can read, or a live list anyone with the link can tick. The key is in the
 * link, so the server only keeps sealed text.
 */
export class NoteLinkModal extends Modal {
  private days = "7";
  private kind = "copy";

  constructor(app: App, private cloud: CloudController, private file: TFile) { super(app); }

  onOpen(): void { this.titleEl.setText("Share as a link"); void this.draw(); }
  onClose(): void { this.contentEl.empty(); }

  private async draw(): Promise<void> {
    const el = this.contentEl;
    const checklist = hasChecklist(await this.app.vault.read(this.file));
    if (!checklist) this.kind = "copy";
    el.empty();
    const explain = el.createEl("p");
    const explained = () => explain.setText(this.kind === "list"
      ? "Anyone with the link can tick items and add items, without an account, and gives a name so you see who did what. Their ticks go into this note on your devices, and what you tick goes to the list. Photos and other attachments stay behind."
      : "Anyone with the link can read a copy of this note's text, without an account. Photos and other attachments stay behind. Later changes to the note are not in the copy.");
    explained();
    new Setting(el).setName("Share")
      .setDesc(checklist ? "" : "This note has no checklist.")
      .addDropdown((dropdown: DropdownComponent) => {
        dropdown.addOption("copy", "Send a copy (read only)");
        if (checklist) dropdown.addOption("list", "Share a live list (people can tick items)");
        dropdown.setValue(this.kind).onChange((value) => { this.kind = value; explained(); });
      });
    const message = el.createEl("p");
    const made = el.createDiv();
    new Setting(el).setName("Link works for")
      .addDropdown((dropdown: DropdownComponent) => dropdown
        .addOptions({ "1": "1 day", "7": "7 days", "30": "30 days", "0": "Until I remove it" })
        .setValue(this.days).onChange((value) => { this.days = value; }))
      .addButton((button) => button.setButtonText("Make link").setCta().onClick(async () => {
        const client = this.cloud.connection;
        if (!client) { message.setText("Connect JotDrop Cloud first."); return; }
        button.setDisabled(true);
        message.setText("Encrypting and sending...");
        try {
          const text = await this.app.vault.read(this.file);
          let link: { address: string };
          if (this.kind === "list") {
            const { title, body } = splitNote(text);
            const list = body.replace(/\r\n?/g, "\n");
            if (new TextEncoder().encode(list).length > LIST_TEXT_BYTES) throw new Error("This list is too large for a link. A link holds about 48 KB of text.");
            const note = await this.cloud.uploadedNote(this.file.path, text);
            if (!note) throw new Error("Sync first, then make the link.");
            link = await createListLink(client, { title, text: list }, { origin: client.credentials.url, days: Number(this.days), path: note.path, noteRevision: note.revision });
          } else {
            link = await createLink(client, linkNote(this.file, text), { origin: client.credentials.url, days: Number(this.days) }) as { address: string };
          }
          made.empty();
          const field = made.createEl("input", { type: "text", cls: "jotdrop-link-field", attr: { readonly: "true", "aria-label": "Link" } });
          field.value = link.address;
          new ButtonComponent(made).setButtonText("Copy").onClick(async () => { await navigator.clipboard.writeText(link.address); new Notice("Link copied."); });
          message.setText("Send this link yourself. It holds the key, so we never see it.");
          void this.list(listEl, message);
        } catch (error) {
          const plus = (error as { code?: string }).code === "plus-required";
          message.setText(plus ? `${errorText(error)} You can try JotDrop Plus free for 14 days on the website.` : errorText(error));
          if (plus) new ButtonComponent(message).setButtonText("JotDrop Plus on the website").onClick(() => window.open(client.credentials.url, "_blank"));
        } finally { button.setDisabled(false); }
      }));
    const listEl = el.createDiv();
    void this.list(listEl, message);
  }

  private async list(el: HTMLElement, message: HTMLElement): Promise<void> {
    const client = this.cloud.connection;
    if (!client) return;
    try {
      const [links, lists] = await Promise.all([listLinks(client) as Promise<Link[]>, listListLinks(client) as Promise<ListLink[]>]);
      this.cloud.listLinks = lists;
      el.empty();
      if (!links.length && !lists.length) return;
      el.createEl("h4", { text: "Your links" });
      for (const link of links) {
        const row = new Setting(el).setName(link.title || "Untitled note")
          .setDesc(link.expiresAt ? `Ends ${new Date(link.expiresAt).toLocaleDateString()}` : "Until you remove it");
        if (link.address) row.addButton((button) => button.setButtonText("Copy").onClick(async () => { await navigator.clipboard.writeText(link.address as string); new Notice("Link copied."); }));
        row.addButton((button) => button.setButtonText("Remove").setWarning().onClick(async () => {
          try { await removeLink(client, link.id); message.setText("The link no longer works."); }
          catch (error) { message.setText(errorText(error)); }
          void this.list(el, message);
        }));
      }
      // A live list: who ticked or added what, from the sealed list itself, newest first.
      for (const link of lists) {
        const row = new Setting(el).setName(link.title || "Untitled note")
          .setDesc(`Live list, ${link.expiresAt ? `ends ${new Date(link.expiresAt).toLocaleDateString()}` : "until you end it"}, updated ${ago(link.updatedAt)}`);
        if (link.address) row.addButton((button) => button.setButtonText("Copy").onClick(async () => { await navigator.clipboard.writeText(link.address as string); new Notice("Link copied."); }));
        row.addButton((button) => button.setButtonText("End link").setWarning().onClick(async () => {
          try { await removeListLink(client, link.id); message.setText("The link no longer works."); }
          catch (error) { message.setText(errorText(error)); }
          void this.list(el, message);
        }));
        if (!link.key) continue;
        openList(client.credentials.url, link.id, link.key, { fetcher: cloudFetch }).then((opened) => {
          const marks = (opened.lines as Line[]).filter((line) => line.task && line.mark && (line.ticked || line.mark.added)).sort((a, b) => b.mark!.at - a.mark!.at).slice(0, 5);
          for (const line of marks) row.descEl.createDiv({ text: `${line.mark!.added && !line.ticked ? `${line.mark!.by} added` : `✓ ${line.mark!.by} ticked`} "${line.text}" ${ago(new Date(line.mark!.at).toISOString())}` });
        }).catch(() => {});
      }
    } catch (error) { message.setText(errorText(error)); }
  }
}

/** Who throws away a note with a live list link is asked whether the link ends with it. Either way the note goes on. */
export class EndListLinkModal extends Modal {
  constructor(app: App, private cloud: CloudController, private links: ListLink[], private proceed: () => void) { super(app); }

  onOpen(): void {
    this.titleEl.setText("Live list link");
    this.contentEl.createEl("p", { text: "This note has a live list link. End the link too?" });
    const footer = this.contentEl.createDiv({ cls: "jotdrop-confirm-footer" });
    footer.createEl("button", { cls: "jotdrop-confirm-cancel", text: "Keep the link" }).addEventListener("click", () => { this.close(); this.proceed(); });
    const end = footer.createEl("button", { cls: "jotdrop-confirm-ok", text: "End the link" });
    end.addEventListener("click", async () => {
      this.close();
      try { await this.cloud.endListLinks(this.links); } catch (error) { new Notice(errorText(error)); return; }
      this.proceed();
    });
    window.setTimeout(() => end.focus(), 0);
  }

  onClose(): void { this.contentEl.empty(); }
}

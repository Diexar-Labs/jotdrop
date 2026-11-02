import { App, ButtonComponent, DropdownComponent, Modal, Notice, Setting, TFile } from "obsidian";
import type { CloudController } from "./cloud";
import { createLink, listLinks, removeLink } from "../cloud/shared/links.mjs";

type Link = { id: string; expiresAt: string | null; title: string; address: string | null };
const errorText = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Try again.";

/** Title and body like the website: without frontmatter, the first heading as the title, no embedded images. */
function linkNote(file: TFile, text: string): { title: string; text: string } {
  const rest = text.slice(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)?.[0].length ?? 0);
  const heading = /^#[ \t]+(.*?)[ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)?/.exec(rest);
  const body = heading ? rest.slice(heading[0].length) : rest;
  return { title: heading ? heading[1] : file.basename, text: body.split(/\r?\n/).filter((line) => !/^\s*!\[/.test(line)).join("\n") };
}

/** A copy of a note anyone with the link can read. The key is in the link, so the server only keeps sealed text. */
export class NoteLinkModal extends Modal {
  private days = "7";

  constructor(app: App, private cloud: CloudController, private file: TFile) { super(app); }

  onOpen(): void { this.titleEl.setText("Share as a link"); this.draw(); }
  onClose(): void { this.contentEl.empty(); }

  private draw(): void {
    const el = this.contentEl;
    el.empty();
    el.createEl("p", { text: "Anyone with the link can read a copy of this note's text, without an account. Photos and other attachments stay behind. Later changes to the note are not in the copy." });
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
          const link = await createLink(client, linkNote(this.file, await this.app.vault.read(this.file)), { origin: client.credentials.url, days: Number(this.days) }) as { address: string };
          made.empty();
          const field = made.createEl("input", { type: "text", attr: { readonly: "true", "aria-label": "Link" } });
          field.value = link.address;
          field.style.width = "100%";
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
      const links = await listLinks(client) as Link[];
      el.empty();
      if (!links.length) return;
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
    } catch (error) { message.setText(errorText(error)); }
  }
}

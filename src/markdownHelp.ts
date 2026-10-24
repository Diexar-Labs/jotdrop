import { App, Modal } from "obsidian";
import { t } from "./i18n";

/**
 * Markdown help: the codes most people forget, the same list as the web app
 * and the Android app. Each row shows the code and what it turns into.
 */
type Result = "h1" | "h2" | "strong" | "em" | "del" | "mark" | "quote" | "code" | "link" | "text";
const ROWS: [code: string, result: Result, key: string][] = [
  ["# Heading", "h1", "md_help_heading"],
  ["## Smaller heading", "h2", "md_help_smaller_heading"],
  ["**bold**", "strong", "md_help_bold"],
  ["*italic*", "em", "md_help_italic"],
  ["~~strikethrough~~", "del", "md_help_strikethrough"],
  ["==highlight==", "mark", "md_help_highlight"],
  ["- item", "text", "md_help_bullet"],
  ["1. item", "text", "md_help_numbered"],
  ["- [ ] task", "text", "md_help_task"],
  ["- [x] done", "text", "md_help_done"],
  ["> quote", "quote", "md_help_quote"],
  ["`code`", "code", "md_help_code"],
  ["[text](https://example.com)", "link", "md_help_web_link"],
  ["[[Note name]]", "link", "md_help_note_link"],
  ["#tag", "text", "md_help_tag"],
  ["---", "text", "md_help_divider"],
  ["| A | B |\n| --- | --- |\n| 1 | 2 |", "text", "md_help_table"],
];

export class MarkdownHelpModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("md_help_title"));
    this.contentEl.addClass("jotdrop-md-help");
    this.contentEl.createEl("p", { text: t("md_help_intro"), cls: "jotdrop-md-help-intro" });
    const table = this.contentEl.createEl("table");
    const head = table.createEl("thead").createEl("tr");
    head.createEl("th", { text: t("md_help_type"), attr: { scope: "col" } });
    head.createEl("th", { text: t("md_help_result"), attr: { scope: "col" } });
    const body = table.createEl("tbody");
    for (const [code, result, key] of ROWS) {
      const row = body.createEl("tr");
      const codeCell = row.createEl("td");
      code.split("\n").forEach((line, index) => {
        if (index) codeCell.createEl("br");
        codeCell.createEl("code", { text: line });
      });
      const cell = row.createEl("td");
      const text = t(key);
      const tag = { h1: "strong", h2: "strong", strong: "strong", em: "em", del: "del", mark: "mark", quote: "span", code: "code", link: "u", text: "span" }[result] as keyof HTMLElementTagNameMap;
      cell.createEl(tag, { text, cls: `jotdrop-md-help-${result}` });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

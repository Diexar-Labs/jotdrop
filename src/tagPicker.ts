import { App, Modal } from "obsidian";
import { t } from "./i18n";

export interface TagItem {
  tag: string;
  count: number;
}

/**
 * Multi-select tag picker. Shows a searchable alphabetical list of all
 * tags in the current note set with a ✓ marker per selected tag.
 * Click = toggle; modal stays open until the user closes it (so multiple
 * tags can be checked in succession). Counterpart of the Android `TagPickerSheet`.
 */
export class TagPickerModal extends Modal {
  private items: TagItem[];
  private selected: Set<string>;
  private onToggle: (tag: string) => void;
  private listEl!: HTMLElement;
  private inputEl!: HTMLInputElement;
  private query = "";

  constructor(
    app: App,
    items: TagItem[],
    selected: Set<string>,
    onToggle: (tag: string) => void,
  ) {
    super(app);
    this.items = items;
    // Own copy so toggling in the modal is immediately visually correct
    // without needing to re-query the outside world.
    this.selected = new Set(selected);
    this.onToggle = onToggle;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(t("tag_sheet_title"));
    contentEl.addClass("jotdrop-tagpicker");

    this.inputEl = contentEl.createEl("input", {
      cls: "jotdrop-tagpicker-search",
      attr: { type: "search", placeholder: t("tag_sheet_search") },
    });
    this.inputEl.addEventListener("input", () => {
      this.query = this.inputEl.value.toLowerCase().trim();
      this.renderList();
    });

    this.listEl = contentEl.createDiv({ cls: "jotdrop-tagpicker-list" });
    this.renderList();
    // Focus the search field so the user can filter immediately.
    window.setTimeout(() => this.inputEl.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderList(): void {
    this.listEl.empty();
    const filtered = this.query
      ? this.items.filter((i) => i.tag.toLowerCase().includes(this.query))
      : this.items;

    if (filtered.length === 0) {
      this.listEl.createDiv({
        cls: "jotdrop-tagpicker-empty",
        text: t("tag_sheet_empty"),
      });
      return;
    }

    for (const item of filtered) {
      const row = this.listEl.createDiv({ cls: "jotdrop-tagpicker-row" });
      const isSelected = this.selected.has(item.tag);
      if (isSelected) row.addClass("is-selected");

      const check = row.createSpan({ cls: "jotdrop-tagpicker-check" });
      check.setText(isSelected ? "✓" : "");
      row.createSpan({ cls: "jotdrop-tagpicker-name", text: `#${item.tag}` });
      row.createSpan({
        cls: "jotdrop-tagpicker-count",
        text: String(item.count),
      });

      row.addEventListener("click", () => {
        this.onToggle(item.tag);
        if (this.selected.has(item.tag)) this.selected.delete(item.tag);
        else this.selected.add(item.tag);
        this.renderList();
      });
    }
  }
}

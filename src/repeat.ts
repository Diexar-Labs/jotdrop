import { parseRepeat } from "./recurrence";
import { t } from "./i18n";

/** Serializable repeat configuration (mirrors the flat YAML keys). */
export interface RepeatConfig {
  /** `reminder_repeat` value; "" = no repeat. */
  repeat: string;
  /** `reminder_until` inclusive date (YYYY-MM-DD), or null. */
  until: string | null;
  /** `reminder_limit` total occurrences (positive integer), or null. */
  limit: number | null;
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

/**
 * Shared repeat picker for the edit and capture modals. Renders a type select
 * (none / daily / weekly / monthly / yearly / every / ordinal), the sub-controls
 * for each type, and the end controls (never / after N / until date). Every
 * change mutates the internal config, notifies the owner via `onChange`, and
 * re-renders itself so the active state stays visible.
 */
export class RepeatEditor {
  private root: Element;
  private config: RepeatConfig;
  private onChange: () => void;

  constructor(root: Element, config: RepeatConfig, onChange: () => void) {
    this.root = root;
    this.config = { ...config };
    this.onChange = onChange;
  }

  getConfig(): RepeatConfig {
    return { ...this.config };
  }

  private changed(): void {
    this.onChange();
    this.render();
  }

  render(): void {
    const root = this.root;
    root.empty();
    root.addClass("jotdrop-repeat-editor");

    const spec = parseRepeat(this.config.repeat);
    const type = this.config.repeat === "" ? "none" : (spec?.type ?? "none");

    const typeRow = root.createDiv({ cls: "jotdrop-edit-row jotdrop-repeat-type-row" });
    typeRow.createSpan({ text: t("label_repeat"), cls: "jotdrop-edit-label" });
    const typeSel = typeRow.createEl("select", { cls: "jotdrop-edit-repeat-type" });
    const typeOptions: [string, string][] = [
      ["none", t("repeat_none")],
      ["daily", t("repeat_daily")],
      ["weekly", t("repeat_weekly")],
      ["monthly", t("repeat_monthly")],
      ["yearly", t("repeat_yearly")],
      ["every", t("repeat_every")],
      ["ordinal", t("repeat_ordinal")],
    ];
    for (const [value, label] of typeOptions) {
      typeSel.createEl("option", { text: label, value });
    }
    typeSel.value = type;
    typeSel.addEventListener("change", () => {
      this.applyType(typeSel.value);
      this.changed();
    });

    if (type === "weekly") {
      this.renderWeekdays(root, spec?.weekdays ?? [1]);
    } else if (type === "every") {
      this.renderEvery(root, spec?.every ?? { n: 1, unit: "days" });
    } else if (type === "ordinal") {
      this.renderOrdinal(root, spec?.ordinal ?? { k: 1, weekday: 1 });
    }

    if (type !== "none") this.renderEnd(root);
  }

  private applyType(type: string): void {
    switch (type) {
      case "none":
        this.config = { repeat: "", until: null, limit: null };
        break;
      case "daily":
        this.config = { ...this.config, repeat: "daily" };
        break;
      case "monthly":
        this.config = { ...this.config, repeat: "monthly" };
        break;
      case "yearly":
        this.config = { ...this.config, repeat: "yearly" };
        break;
      case "weekly":
        this.config = { ...this.config, repeat: "weekly:1" };
        break;
      case "every":
        this.config = { ...this.config, repeat: "every:1:days" };
        break;
      case "ordinal":
        this.config = { ...this.config, repeat: "ordinal:1:1" };
        break;
    }
  }

  private renderWeekdays(root: Element, selected: number[]): void {
    const set = new Set(selected);
    const row = root.createDiv({ cls: "jotdrop-repeat-weekdays" });
    for (const wd of WEEKDAYS) {
      const btn = row.createEl("button", {
        cls: `jotdrop-repeat-weekday${set.has(wd) ? " is-active" : ""}`,
        text: t(`weekday_${wd}`),
        attr: { type: "button", "aria-pressed": String(set.has(wd)) },
      });
      btn.addEventListener("click", () => {
        const cur = new Set(set);
        if (cur.has(wd)) cur.delete(wd);
        else cur.add(wd);
        if (cur.size === 0) return; // keep at least one selected weekday
        const sorted = Array.from(cur).sort((a, b) => a - b);
        this.config = { ...this.config, repeat: `weekly:${sorted.join(",")}` };
        this.changed();
      });
    }
  }

  private renderEvery(root: Element, every: { n: number; unit: "days" | "weeks" | "months" }): void {
    const row = root.createDiv({ cls: "jotdrop-repeat-every" });
    const nInput = row.createEl("input", {
      cls: "jotdrop-edit-repeat-n",
      attr: {
        type: "number",
        min: "1",
        max: "999",
        step: "1",
        "aria-label": t("repeat_every"),
      },
    });
    nInput.value = String(every.n);
    const unitSel = row.createEl("select", {
      cls: "jotdrop-edit-repeat-unit",
      attr: { "aria-label": t("repeat_every") },
    });
    for (const u of ["days", "weeks", "months"] as const) {
      unitSel.createEl("option", { text: t(`repeat_unit_${u}`), value: u });
    }
    unitSel.value = every.unit;
    const commit = () => {
      // Cap at 999 to match the Android UI's interval bound.
      const n = Math.min(999, Math.max(1, Math.floor(Number(nInput.value) || 1)));
      this.config = { ...this.config, repeat: `every:${n}:${unitSel.value}` };
      this.changed();
    };
    nInput.addEventListener("change", commit);
    unitSel.addEventListener("change", commit);
  }

  private renderOrdinal(root: Element, ordinal: { k: number; weekday: number }): void {
    const row = root.createDiv({ cls: "jotdrop-repeat-ordinal" });
    const kSel = row.createEl("select", {
      cls: "jotdrop-edit-repeat-k",
      attr: { "aria-label": t("repeat_ordinal") },
    });
    for (let k = 1; k <= 5; k++) {
      kSel.createEl("option", { text: t(`ordinal_${k}`), value: String(k) });
    }
    kSel.value = String(ordinal.k);
    const wdSel = row.createEl("select", {
      cls: "jotdrop-edit-repeat-weekday",
      attr: { "aria-label": t("repeat_ordinal") },
    });
    for (const wd of WEEKDAYS) {
      wdSel.createEl("option", { text: t(`weekday_${wd}`), value: String(wd) });
    }
    wdSel.value = String(ordinal.weekday);
    const commit = () => {
      this.config = { ...this.config, repeat: `ordinal:${kSel.value}:${wdSel.value}` };
      this.changed();
    };
    kSel.addEventListener("change", commit);
    wdSel.addEventListener("change", commit);
  }

  private renderEnd(root: Element): void {
    const row = root.createDiv({ cls: "jotdrop-edit-row jotdrop-repeat-end" });
    row.createSpan({ text: t("label_repeat_ends"), cls: "jotdrop-edit-label" });
    const mode = this.config.limit !== null ? "after" : this.config.until ? "until" : "never";
    const endSel = row.createEl("select", {
      cls: "jotdrop-edit-repeat-end",
      attr: { "aria-label": t("label_repeat_ends") },
    });
    endSel.createEl("option", { text: t("repeat_end_never"), value: "never" });
    // Fill the count so the {0} placeholder never renders literally.
    endSel.createEl("option", {
      text: t("repeat_end_after", String(this.config.limit ?? 1)),
      value: "after",
    });
    endSel.createEl("option", { text: t("repeat_end_until"), value: "until" });
    endSel.value = mode;
    endSel.addEventListener("change", () => {
      if (endSel.value === "never") this.config = { ...this.config, limit: null, until: null };
      else if (endSel.value === "after") this.config = { ...this.config, limit: 1, until: null };
      else this.config = { ...this.config, limit: null, until: this.today() };
      this.changed();
    });

    if (mode === "after") {
      const nInput = row.createEl("input", {
        cls: "jotdrop-edit-repeat-limit",
        attr: {
          type: "number",
          min: "1",
          step: "1",
          "aria-label": t("repeat_end_after", String(this.config.limit ?? 1)),
        },
      });
      nInput.value = String(this.config.limit ?? 1);
      nInput.addEventListener("change", () => {
        this.config = { ...this.config, limit: Math.max(1, Math.floor(Number(nInput.value) || 1)) };
        this.changed();
      });
    } else if (mode === "until") {
      const dInput = row.createEl("input", {
        cls: "jotdrop-edit-repeat-until",
        attr: { type: "date", "aria-label": t("repeat_end_until") },
      });
      dInput.value = this.config.until ?? "";
      dInput.addEventListener("change", () => {
        this.config = { ...this.config, until: dInput.value || null };
        this.changed();
      });
    }
  }

  private today(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
}

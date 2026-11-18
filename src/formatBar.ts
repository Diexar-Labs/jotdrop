import { App, Menu, Modal, Platform, Scope, getIcon, setIcon } from "obsidian";
import { activeFormats, applyFormat, blocks, indentEdit, parseTable, tableEdit } from "../cloud/shared/format.mjs";
import { createTableGrid } from "../cloud/shared/table-grid.mjs";
import { ConfirmModal } from "./confirmModal";
import { t } from "./i18n";
import { applyTextEdit, toggleChecklistOnTextArea } from "./listEditor";

interface TextEdit { from: number; to: number; insert: string; selFrom?: number; selTo?: number }
interface TableRun { kind: string; fromLine: number; toLine: number; from: number; to: number }
type TableGrid = ReturnType<typeof createTableGrid>;

/**
 * The formatting bar of the edit window (design opmaak-editor, part 5.3 and 8; kaarten-en-lijsten, part 7), in the
 * order of the web app. Every button is one replacement from the shared core (cloud/shared/format.mjs) in the text
 * box, so the Markdown codes stay visible and Ctrl+Z undoes it. A button that is "on" is pressed: a thicker edge and a
 * line under it, never only a color.
 */
const BUTTONS: { command: string; icons: string[]; text: string; label: string; key?: string; pressable?: boolean }[] = [
  { command: "bold", icons: ["bold"], text: "B", label: "format_bold", key: "B", pressable: true },
  { command: "italic", icons: ["italic"], text: "I", label: "format_italic", key: "I", pressable: true },
  { command: "heading", icons: ["heading"], text: "H", label: "format_heading", pressable: true },
  { command: "bullet", icons: ["list"], text: "•", label: "format_bullet", pressable: true },
  { command: "ordered", icons: ["list-ordered"], text: "1.", label: "format_ordered", pressable: true },
  { command: "checklist", icons: ["check-square", "square-check"], text: "☑", label: "format_checklist", pressable: true },
  { command: "indent", icons: ["indent-increase", "indent"], text: "⇥", label: "format_indent", key: "Tab" },
  { command: "outdent", icons: ["indent-decrease", "outdent"], text: "⇤", label: "format_outdent", key: "Shift+Tab" },
  { command: "highlight", icons: ["highlighter"], text: "A", label: "format_highlight", pressable: true },
  { command: "table", icons: ["table"], text: "▦", label: "format_table", pressable: true },
  { command: "emoji", icons: ["smile"], text: "☺", label: "format_emoji" },
  { command: "more", icons: ["more-horizontal", "ellipsis"], text: "⋯", label: "format_more" },
];
const MORE: [command: string, label: string][] = [
  ["strike", "format_strike"], ["quote", "format_quote"], ["code", "format_code"], ["rule", "format_rule"],
];

// Emoji (design part 10b, Eric's choice "a button with a panel"): the same set as the web app (cloud/web/app.js).
// The full set is the system's own: Windows key + . on Windows, Ctrl + Cmd + Space on a Mac, the keyboard on a phone.
const EMOJI: [group: string, list: [emoji: string, name: string][]][] = [
  ["emoji_smileys", [["😀", "grinning face"], ["😂", "tears of joy"], ["😊", "smiling face"], ["😍", "heart eyes"], ["🤔", "thinking face"], ["😎", "sunglasses"], ["😢", "crying face"], ["😮", "surprised face"], ["😴", "sleeping face"], ["🥳", "party face"]]],
  ["emoji_hands", [["👍", "thumbs up"], ["👎", "thumbs down"], ["👏", "clapping hands"], ["🙏", "folded hands"], ["👋", "waving hand"], ["💪", "flexed biceps"], ["🤝", "handshake"], ["✌️", "victory hand"]]],
  ["emoji_hearts", [["❤️", "red heart"], ["🧡", "orange heart"], ["💛", "yellow heart"], ["💚", "green heart"], ["💙", "blue heart"], ["💜", "purple heart"], ["🖤", "black heart"], ["💔", "broken heart"]]],
  ["emoji_ticks", [["✅", "check mark button"], ["✔️", "check mark"], ["☑️", "ticked box"], ["❌", "cross mark"], ["⭐", "star"], ["🌟", "glowing star"], ["✨", "sparkles"], ["⚡", "lightning"], ["🔥", "fire"], ["💯", "hundred points"]]],
  ["emoji_food", [["☕", "coffee"], ["🍕", "pizza"], ["🍎", "apple"], ["🥗", "salad"], ["🍰", "cake"], ["🍷", "wine"], ["🥖", "bread"], ["🧀", "cheese"]]],
  ["emoji_travel", [["✈️", "airplane"], ["🚗", "car"], ["🚲", "bicycle"], ["🏠", "house"], ["🏖️", "beach"], ["🗺️", "map"], ["🧳", "luggage"], ["⛰️", "mountain"]]],
  ["emoji_symbols", [["📌", "pin"], ["📅", "calendar"], ["⏰", "alarm clock"], ["💡", "light bulb"], ["📝", "memo"], ["🎁", "gift"], ["🎉", "party popper"], ["⚠️", "warning"], ["❓", "question mark"], ["💬", "speech balloon"]]],
];
const EMOJI_NAMES = new Map(EMOJI.flatMap(([, list]) => list));
const RECENT_EMOJI = "jotdrop-emoji-recent";

/** Obsidian's icon when it has one, else the same sign as on the web. */
function drawIcon(button: HTMLElement, icons: string[], text: string): void {
  const icon = icons.find((id) => getIcon(id));
  if (icon) setIcon(button, icon);
  else button.setText(text);
}

const shortcut = (key: string): string => (key.length === 1 ? `${Platform.isMacOS ? "Cmd" : "Ctrl"}+${key}` : key);

/** The table that holds this position in the text, as a run from `blocks`. */
function tableAt(text: string, pos: number): TableRun | undefined {
  const line = text.slice(0, pos).split("\n").length - 1;
  return (blocks(text) as TableRun[]).find((run) => run.kind === "table" && line >= run.fromLine && line <= run.toLine);
}

let panelCount = 0;

export interface FormatBar {
  element: HTMLElement;
  destroy(): void;
}

/**
 * The bar for `ta`. `parentScope` is the window's own key scope, so Esc closes the emoji panel first and the next Esc
 * does what it does in the window (save and close).
 */
export function createFormatBar(
  app: App,
  ta: HTMLTextAreaElement,
  options: { moveChecked: () => boolean; parentScope: () => Scope | null },
): FormatBar {
  const element = createDiv({ cls: "jotdrop-format" });
  const bar = element.createDiv({ cls: "jotdrop-format-bar", attr: { role: "toolbar", "aria-label": t("format_bar") } });
  const panelId = `jotdrop-emoji-panel-${++panelCount}`;
  const panel = element.createDiv({ cls: "jotdrop-emoji-panel", attr: { id: panelId, role: "group", "aria-label": t("format_emoji") } });
  panel.hide();

  const buttons = new Map<string, HTMLButtonElement>();
  for (const spec of BUTTONS) {
    const button = bar.createEl("button", { cls: "jotdrop-format-btn", attr: { type: "button", "data-format": spec.command } });
    drawIcon(button, spec.icons, spec.text);
    const name = t(spec.label);
    button.setAttribute("aria-label", name);
    button.setAttribute("title", spec.key ? `${name} (${shortcut(spec.key)})` : name);
    if (spec.pressable) button.setAttribute("aria-pressed", "false");
    if (spec.command === "emoji") { button.setAttribute("aria-expanded", "false"); button.setAttribute("aria-controls", panelId); }
    if (spec.command === "more") button.setAttribute("aria-haspopup", "menu");
    buttons.set(spec.command, button);
  }

  function refresh(): void {
    const active: string[] = activeFormats(ta.value, ta.selectionStart, ta.selectionEnd);
    for (const [command, button] of buttons) {
      if (button.hasAttribute("aria-pressed")) button.setAttribute("aria-pressed", String(active.includes(command)));
    }
    // In a table the button opens the grid of that table.
    const name = t(active.includes("table") ? "format_table_edit" : "format_table");
    buttons.get("table")?.setAttribute("aria-label", name);
    buttons.get("table")?.setAttribute("title", name);
  }

  function run(command: string, button?: HTMLElement): void {
    if (command === "emoji") { togglePanel(); return; }
    if (command === "more" && button) { showMore(button); return; }
    if (command === "table") { openTable(); return; }
    if (command === "checklist") {
      // The Checklist button of the window, with "Move checked items to the bottom".
      toggleChecklistOnTextArea(ta, options.moveChecked());
      refresh();
      return;
    }
    const from = ta.selectionStart, to = ta.selectionEnd;
    const edit = command === "indent" || command === "outdent"
      ? indentEdit(ta.value, from, to, command === "indent" ? "in" : "out")
      : applyFormat(ta.value, from, to, command);
    ta.focus();
    if (edit) applyTextEdit(ta, edit as TextEdit);
    refresh();
  }

  function showMore(button: HTMLElement): void {
    const menu = new Menu();
    for (const [command, label] of MORE) menu.addItem((item) => item.setTitle(t(label)).onClick(() => run(command)));
    const box = button.getBoundingClientRect();
    menu.showAtPosition({ x: box.left, y: box.bottom }, button.ownerDocument);
  }

  function openTable(): void {
    let table = tableAt(ta.value, ta.selectionStart);
    if (!table) {
      // A new table of 3 columns, with an empty line before and after it; then its grid opens.
      const edit = applyFormat(ta.value, ta.selectionStart, ta.selectionEnd, "table") as TextEdit | null;
      ta.focus();
      if (!edit) return;
      applyTextEdit(ta, edit);
      table = tableAt(ta.value, edit.selFrom ?? edit.from);
    }
    if (table) new TableGridModal(app, ta, table.fromLine, refresh).open();
  }

  // Emoji: about 60 common ones and the last 8 used on this device.
  let panelScope: Scope | null = null;
  function recentEmoji(): string[] {
    const saved: unknown = app.loadLocalStorage(RECENT_EMOJI);
    return (Array.isArray(saved) ? saved : []).filter((emoji): emoji is string => EMOJI_NAMES.has(emoji)).slice(0, 8);
  }
  function renderPanel(): void {
    panel.empty();
    const group = (title: string, list: [string, string][]): void => {
      const section = panel.createEl("section");
      section.createEl("h3", { text: title });
      const row = section.createDiv({ cls: "jotdrop-emoji-row" });
      for (const [emoji, name] of list) {
        row.createEl("button", { text: emoji, attr: { type: "button", title: name, "aria-label": name, "data-emoji": emoji } });
      }
    };
    const recent = recentEmoji();
    if (recent.length) group(t("emoji_recent"), recent.map((emoji) => [emoji, EMOJI_NAMES.get(emoji) ?? emoji]));
    for (const [title, list] of EMOJI) group(t(title), list);
    panel.createEl("p", { cls: "jotdrop-emoji-hint", text: t("emoji_hint") });
  }
  function openPanel(): void {
    renderPanel();
    panel.show();
    buttons.get("emoji")?.setAttribute("aria-expanded", "true");
    panelScope = new Scope(options.parentScope() ?? undefined);
    panelScope.register([], "Escape", () => { closePanel(); ta.focus(); return false; });
    app.keymap.pushScope(panelScope);
  }
  function closePanel(): void {
    panel.hide();
    buttons.get("emoji")?.setAttribute("aria-expanded", "false");
    if (panelScope) app.keymap.popScope(panelScope);
    panelScope = null;
  }
  function togglePanel(): void {
    if (panel.isShown()) closePanel();
    else openPanel();
  }

  // Pressing a button keeps the caret and the selection in the text.
  const keepCaret = (event: MouseEvent): void => { if ((event.target as HTMLElement).closest("button")) event.preventDefault(); };
  bar.addEventListener("mousedown", keepCaret);
  panel.addEventListener("mousedown", keepCaret);
  bar.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-format]");
    if (button?.dataset.format) run(button.dataset.format, button);
  });
  panel.addEventListener("click", (event) => {
    const emoji = (event.target as HTMLElement).closest<HTMLElement>("button[data-emoji]")?.dataset.emoji;
    if (!emoji) return;
    // An emoji is plain text in the note: one insertion at the caret, as any other button.
    ta.focus();
    const from = ta.selectionStart, to = ta.selectionEnd;
    applyTextEdit(ta, { from, to, insert: emoji, selFrom: from + emoji.length });
    app.saveLocalStorage(RECENT_EMOJI, [emoji, ...recentEmoji().filter((own) => own !== emoji)].slice(0, 8));
    closePanel();
    refresh();
  });

  // Ctrl+B and Ctrl+I (Cmd on a Mac), as on the web.
  const keydown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key !== "b" && key !== "i") return;
    event.preventDefault();
    event.stopPropagation();
    run(key === "b" ? "bold" : "italic");
  };
  const events = ["keyup", "mouseup", "input", "focus", "select"];
  ta.addEventListener("keydown", keydown);
  for (const type of events) ta.addEventListener(type, refresh);
  refresh();

  return {
    element,
    destroy() {
      closePanel();
      ta.removeEventListener("keydown", keydown);
      for (const type of events) ta.removeEventListener(type, refresh);
      element.remove();
    },
  };
}

const TABLE_BUTTONS: [command: string, text: string, label: string][] = [
  ["addRow", "table_add_row", "table_add_row_label"],
  ["addColumn", "table_add_column", "table_add_column_label"],
  ["deleteRow", "table_delete_row", "table_delete_row_label"],
  ["deleteColumn", "table_delete_column", "table_delete_column_label"],
  ["alignLeft", "table_align_left", "table_align_left_label"],
  ["alignCenter", "table_align_center", "table_align_center_label"],
  ["alignRight", "table_align_right", "table_align_right_label"],
  ["bold", "", "format_bold"],
  ["italic", "", "format_italic"],
  ["highlight", "", "format_highlight"],
  ["deleteTable", "table_delete", "table_delete"],
];
const CELL_COMMANDS = new Set(["bold", "italic", "highlight"]);

/**
 * The table grid (cloud/shared/table-grid.mjs) in a small window of its own, with the table bar above it (design
 * part 5.4 and 8). Every change goes into the note's text box at once as one tableEdit, rewriting as few lines as
 * possible; the text box stays the only source. Those changes are not in the text box's Ctrl+Z, because the focus is
 * in the grid while they happen.
 */
class TableGridModal extends Modal {
  private grid: TableGrid | null = null;
  private pressable = new Map<string, HTMLButtonElement>();
  private caret: number | null = null;
  private outside: TextEdit | null = null;
  private escapeScope: Scope | null = null;
  private discard = false;

  constructor(app: App, private ta: HTMLTextAreaElement, private fromLine: number, private done: () => void) {
    super(app);
  }

  private run(): TableRun | undefined {
    return (blocks(this.ta.value) as TableRun[]).find((run) => run.kind === "table" && run.fromLine === this.fromLine);
  }

  private table(): ReturnType<typeof parseTable> | null {
    const run = this.run();
    return run ? parseTable(this.ta.value.slice(run.from, run.to).split("\n")) : null;
  }

  /** A strip to type above or below the table only where it is at the very start or end of the text. */
  private edges(): { top: boolean; bottom: boolean } {
    const run = this.run();
    return { top: run?.from === 0, bottom: run !== undefined && run.to >= this.ta.value.length };
  }

  private write(op: Record<string, unknown>): TextEdit | null {
    const edit = tableEdit(this.ta.value, this.fromLine, op) as TextEdit | null;
    if (!edit) return null;
    this.ta.setRangeText(edit.insert, edit.from, edit.to);
    this.ta.dispatchEvent(new Event("input", { bubbles: true }));
    return edit;
  }

  private redraw(): void {
    const table = this.table();
    if (!table) { this.close(); return; }
    this.grid?.update(table, this.edges());
  }

  onOpen(): void {
    const table = this.table();
    if (!table) { this.close(); return; }
    this.titleEl.setText(t("table_title"));
    this.modalEl.addClass("jotdrop-table-modal");
    // On phones the keyboard does not shrink the screen, so the window must stay above it (styles.css).
    this.containerEl.addClass("jotdrop-table-modal-container");
    // Esc closes this window and throws away what was typed in the open cell (design part 5.4); the cells left
    // before stay in the text. A child scope, because the window's own Escape is registered first and would win.
    this.escapeScope = new Scope(this.scope);
    this.escapeScope.register([], "Escape", () => { this.discard = true; this.close(); return false; });
    this.app.keymap.pushScope(this.escapeScope);
    const bar = this.contentEl.createDiv({ cls: "jotdrop-format-bar jotdrop-table-bar", attr: { role: "toolbar", "aria-label": t("table_bar") } });
    for (const [command, text, label] of TABLE_BUTTONS) {
      const button = bar.createEl("button", { cls: "jotdrop-format-btn", attr: { type: "button", "data-table": command, "aria-label": t(label), title: t(label) } });
      if (CELL_COMMANDS.has(command)) {
        drawIcon(button, [command === "highlight" ? "highlighter" : command], command === "bold" ? "B" : command === "italic" ? "I" : "A");
        button.setAttribute("aria-pressed", "false");
        this.pressable.set(command, button);
      } else button.setText(t(text));
      if (command === "deleteTable") button.addClass("mod-warning");
    }
    // Pressing a button keeps the open cell and its selection.
    bar.addEventListener("mousedown", (event) => { if ((event.target as HTMLElement).closest("button")) event.preventDefault(); });
    bar.addEventListener("click", (event) => {
      const command = (event.target as HTMLElement).closest<HTMLElement>("button[data-table]")?.dataset.table;
      if (command) this.command(command);
    });

    this.grid = createTableGrid(this.contentEl.ownerDocument, {
      table,
      edges: this.edges(),
      labels: {
        table: t("table_title"),
        cell: (row: number, column: number) => (row === 0 ? t("table_cell_header", String(column + 1)) : t("table_cell", String(row), String(column + 1))),
        typeAbove: t("table_type_above"),
        typeBelow: t("table_type_below"),
      },
      // After Esc nothing goes in any more: Obsidian gives the focus back before onClose, and the open cell would
      // then save itself on losing the focus.
      onEdit: (op: Record<string, unknown>) => { if (!this.discard && this.write(op)) this.redraw(); },
      onFocusCell: () => this.showPressed(),
      onBlurCell: () => this.showPressed(),
      onLeave: (where: "before" | "after") => this.leave(where),
      onTypeOutside: (where: "before" | "after") => this.typeOutside(where),
    });
    this.contentEl.append(this.grid.element);
    for (const type of ["keyup", "mouseup", "input"]) this.grid.element.addEventListener(type, () => this.showPressed());

    const footer = this.contentEl.createDiv({ cls: "jotdrop-edit-footer" });
    footer.createEl("button", { text: t("table_done"), cls: "mod-cta" }).addEventListener("click", () => this.close());
    // After Obsidian has put the focus in the window: the first cell is ready for typing.
    window.setTimeout(() => this.grid?.focusCell(0, 0), 0);
  }

  private showPressed(): void {
    const active: string[] = this.grid?.activeFormats() ?? [];
    for (const [command, button] of this.pressable) button.setAttribute("aria-pressed", String(active.includes(command)));
  }

  private command(command: string): void {
    const grid = this.grid;
    if (!grid) return;
    if (CELL_COMMANDS.has(command)) { grid.applyToCell(command); this.showPressed(); return; }
    if (command === "deleteTable") {
      grid.flush();
      new ConfirmModal(this.app, { title: t("table_delete"), message: t("table_delete_confirm"), confirmLabel: t("table_delete"), destructive: true }, () => {
        const edit = this.write({ type: "deleteTable" });
        if (edit) this.caret = edit.selFrom ?? edit.from;
        this.close();
      }).open();
      return;
    }
    const cell = grid.activeCell() || grid.lastCell() || { row: 0, column: 0 };
    grid.flush();
    const current = this.table();
    if (!current) return;
    const align = ({ alignLeft: "left", alignCenter: "center", alignRight: "right" } as Record<string, string>)[command];
    const op = ({
      addRow: { type: "addRow", after: cell.row },
      addColumn: { type: "addColumn", at: cell.column + 1 },
      deleteRow: { type: "deleteRow", row: cell.row },
      deleteColumn: { type: "deleteColumn", column: cell.column },
    } as Record<string, Record<string, unknown>>)[command]
      || (align ? { type: "setAlign", column: cell.column, align: current.align[cell.column] === align ? "" : align } : null);
    if (op && this.write(op)) this.redraw();
    const next = ({
      addRow: [cell.row + 1, cell.column],
      addColumn: [cell.row, cell.column + 1],
      deleteRow: [Math.min(cell.row, current.rows.length - 1), cell.column],
      deleteColumn: [cell.row, Math.max(0, Math.min(cell.column, current.header.length - 2))],
    } as Record<string, number[]>)[command] || [cell.row, cell.column];
    grid.focusCell(next[0], next[1]);
  }

  /** Out of the grid: back in the text box, on the line right before or after the table. */
  private leave(where: "before" | "after"): void {
    const run = this.run();
    if (run) this.caret = where === "before" ? Math.max(0, run.from - 1) : Math.min(this.ta.value.length, run.to + 1);
    this.close();
  }

  /** The strip above or below a table at the edge of the text: a new line, with one empty line next to the table. */
  private typeOutside(where: "before" | "after"): void {
    const end = this.ta.value.length;
    this.outside = where === "before" ? { from: 0, to: 0, insert: "\n\n", selFrom: 0 } : { from: end, to: end, insert: "\n\n", selFrom: end + 2 };
    this.close();
  }

  onClose(): void {
    if (this.escapeScope) this.app.keymap.popScope(this.escapeScope);
    this.escapeScope = null;
    // An open cell goes into the text first, as on Save; after Esc it does not.
    if (!this.discard) this.grid?.flush();
    this.grid?.destroy();
    this.grid = null;
    this.contentEl.empty();
    this.ta.focus();
    if (this.outside) applyTextEdit(this.ta, this.outside);
    else {
      const at = this.caret ?? this.run()?.from;
      if (at !== undefined) this.ta.setSelectionRange(at, at);
    }
    this.done();
  }
}

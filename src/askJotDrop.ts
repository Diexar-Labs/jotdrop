// The screens of Ask JotDrop in Obsidian: the question window and the settings. The same flow as the web app
// (cloud/web/app.js): the list "What goes along" before anything leaves, a new note at once, a change to a note only
// after Apply, the answer as simple formatting built with textContent (never innerHTML), a Report button. The AI
// service is reached straight from this device through cloudFetch (Obsidian's requestUrl), never through JotDrop.
import { type App, Modal, Notice, Setting, TFile, getLanguage, setIcon } from "obsidian";
import type JotDropPlugin from "./main";
import { cloudFetch } from "./cloud";
import { createNoteInFolder } from "./capture";
import { AI_OFF, AI_PROVIDER_IDS, type AiConfig, type AiNote, aiExecutor, aiLabels, aiSettings, aiToday, collectAiNotes } from "./ai";
import { AiError, type AiAction, type AiChange, type AiReport, PROVIDERS, appendedText, createProvider, describeChange, editorRequest, foldUnchanged, modelGroups, newNoteText, parseMarkdown, pickDefaultModel, runAssistant, selectNotes } from "./aiShared";

type Spec = { name: string; needsKey: boolean; defaultModel: string | null };
const spec = (id: string): Spec | undefined => (PROVIDERS as Record<string, Spec>)[id];
type Report = AiReport;
type Change = AiChange;
type Model = { id: string; name: string; tools: boolean | null };

const withTimeout = (ms: number): AbortSignal => { const controller = new AbortController(); window.setTimeout(() => controller.abort(new DOMException("The AI service took too long.", "TimeoutError")), ms); return controller.signal; };

/** The service's words come along, with every key in them hidden by the shared core. */
export function aiErrorText(error: unknown, provider: string): string {
  if (error instanceof AiError || (error && typeof error === "object" && "code" in error && "detail" in error)) {
    const { message, detail, code } = error as { message: string; detail?: string; code: string };
    const ollama = provider === "ollama" && code === "network" ? " Is Ollama running on this computer, at http://127.0.0.1:11434?" : "";
    return `${message}${detail ? ` The service said: ${detail}` : ""}${ollama}`;
  }
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function providerNote(provider: string): string {
  return ({
    ollama: "Your request and notes stay on this device: they go to Ollama running here. Choose a model that can use tools.",
    anthropic: "Make an API key in your Anthropic account (Claude Console). The default model is Claude Haiku 5.5.",
    openai: "Make an API key in your OpenAI account (platform.openai.com).",
    gemini: "Make an API key in Google AI Studio. Outside the EEA, Switzerland and the UK, Google may use what you send on the free tier to improve its products; on the paid tier it does not.",
    openrouter: "One key for many models. OpenRouter passes your request on to the company behind the model you choose. Load the models and pick one that can use tools.",
    custom: "Any OpenAI-compatible service, such as LM Studio, a local server or Mistral. Use an https address, or an http address on this computer. A key is only needed if the service asks for one.",
  } as Record<string, string>)[provider] ?? "";
}

/** Ollama, or an own address on this computer (LM Studio and the like): nothing leaves the computer. */
const onThisComputer = (config: AiConfig): boolean => config.provider === "ollama" || (config.provider === "custom" && /^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:|\/|$)/i.test(config.baseUrl));

const via = (config: AiConfig): string => {
  const service = spec(config.provider);
  if (!service) return "";
  const model = config.model || service.defaultModel || "no model chosen";
  if (onThisComputer(config)) return `Goes to ${config.provider === "ollama" ? "Ollama" : config.baseUrl} on this device, model ${model}. Your request and notes stay on this device.`;
  if (config.provider === "custom") return `Goes straight to ${config.baseUrl}, model ${model}. Nothing goes to JotDrop.`;
  return `Goes straight to ${service.name}, model ${model}. Nothing goes to JotDrop.`;
};

const openSettings = (app: App, id: string) => {
  const setting = (app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
  setting.open();
  setting.openTabById(id);
};

export type AskOptions = {
  /** Ask about this note: it goes along first. */
  file?: TFile;
  /** Summarize this note: only this note goes, and the request is fixed. */
  summarize?: boolean;
  /** The editor's draft: only the draft goes, nothing is changed; the answer waits for Replace or Add below. */
  editor?: { title: string; text: string; kind: "rewrite" | "checklist" | "summarize"; use: (answer: string, replace: boolean) => void };
  /** How the board opens a note (open_note, sources, a new note). */
  openNote: (file: TFile) => void;
};

/** The answer as simple formatting: bold, italic, code, headings, bullets. textContent only; links stay as typed. */
function showAnswer(target: HTMLElement, text: string): void {
  target.empty();
  let list: HTMLElement | null = null;
  let pre: HTMLElement | null = null;
  for (const block of parseMarkdown(text)) {
    if (block.kind !== "bullet") list = null;
    if (block.kind !== "code") pre = null;
    if (block.kind === "space") continue;
    const spans = (parent: HTMLElement) => {
      for (const span of block.spans) {
        let node: HTMLElement = parent;
        if (span.bold) node = node.createEl("strong");
        if (span.italic) node = node.createEl("em");
        if (span.code) node = node.createEl("code");
        node.appendText(span.text);
      }
    };
    if (block.kind === "bullet") {
      if (!list) list = target.createEl("ul", { cls: "jotdrop-ai-list" });
      const item = list.createEl("li");
      item.style.marginLeft = `${block.level * 1.2}em`;
      spans(item);
    } else if (block.kind === "code") {
      if (!pre) pre = target.createEl("pre", { cls: "jotdrop-ai-code" }); else pre.appendText("\n");
      pre.appendText(block.spans[0].text);
    } else {
      spans(target.createEl("p", { cls: block.kind === "heading" ? `jotdrop-ai-h jotdrop-ai-h${block.level}` : "" }));
    }
  }
}

export class AskJotDropModal extends Modal {
  private config: AiConfig = { ...AI_OFF };
  private notes: AiNote[] = [];
  private texts = new Map<string, string>();
  private excluded = new Set<string>();
  private pinned: string[] = [];
  private controller?: AbortController;
  private confirming?: (yes: boolean) => void;
  private toOpen?: TFile;
  private last?: { report: Report; request: string; model: string; provider: string };
  private goesTimer?: number;
  private el!: {
    off: HTMLElement; via: HTMLElement; request: HTMLTextAreaElement; goes: HTMLDetailsElement; goesSummary: HTMLElement; goesList: HTMLElement;
    send: HTMLButtonElement; stop: HTMLButtonElement; status: HTMLElement; confirm: HTMLElement; confirmTitle: HTMLElement; confirmBody: HTMLElement;
    apply: HTMLButtonElement; result: HTMLElement; badge: HTMLElement; answer: HTMLElement; sources: HTMLElement; actions: HTMLElement; also: HTMLElement;
    usage: HTMLElement; useButtons: HTMLElement; reportBox: HTMLElement;
  };

  constructor(app: App, private plugin: JotDropPlugin, private options: AskOptions) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass("jotdrop-ai-modal");
    this.titleEl.setText("Ask JotDrop");
    this.config = await this.plugin.aiStore.load();
    const { editor, file, summarize } = this.options;
    if (editor) this.notes = [{ id: "draft", title: editor.title || "Untitled", text: editor.text, labels: [], updatedAt: "", shared: false }];
    else {
      ({ notes: this.notes, texts: this.texts } = await collectAiNotes(this.plugin));
      if (file && summarize) this.notes = this.notes.filter((note) => note.id === file.path);
    }
    this.pinned = editor ? ["draft"] : file ? [file.path] : [];
    this.build();
    const request = editor ? editorRequest(editor.kind, editor.title || "Untitled") : summarize ? editorRequest("summarize", this.notes[0]?.title ?? file?.basename ?? "") : "";
    this.el.request.value = request;
    this.el.request.readOnly = Boolean(editor || summarize);
    this.renderGoes();
    const off = this.offReason();
    if (off) return;
    if (request) void this.send();
    else this.el.request.focus();
  }

  private offReason(): string {
    if (!this.config.provider) return "Ask JotDrop is off. Choose an AI service, and add your own key, in the JotDrop settings.";
    if (this.options.file && !this.options.editor && !this.config.includeShared && this.notes.find((note) => note.id === this.options.file?.path)?.shared) {
      return "This note is in a shared group or has a list link. Ask JotDrop keeps those out, unless you switch on \"Also use notes from shared groups and list links\" in its settings.";
    }
    if (this.options.summarize && !this.notes.length) return "This note cannot go to Ask JotDrop.";
    return "";
  }

  private build(): void {
    const root = this.contentEl;
    root.empty();
    const off = this.offReason();
    const offEl = root.createDiv({ cls: "jotdrop-ai-off" });
    offEl.createEl("p", { text: off });
    if (!this.config.provider) offEl.createEl("button", { text: "Open settings", cls: "mod-cta" }).addEventListener("click", () => { this.close(); openSettings(this.app, this.plugin.manifest.id); });
    offEl.toggle(Boolean(off));

    const viaEl = root.createEl("p", { cls: "jotdrop-ai-via", text: off ? "" : via(this.config) });
    const form = root.createDiv({ cls: "jotdrop-ai-ask" });
    form.toggle(!off);
    const request = form.createEl("textarea", { cls: "jotdrop-ai-request", attr: { rows: "3", placeholder: "Ask about your notes, or tell JotDrop what to do. For example: put milk and bread on the shopping list.", "aria-label": "Your request" } });
    request.addEventListener("input", () => { window.clearTimeout(this.goesTimer); this.goesTimer = window.setTimeout(() => this.renderGoes(), 200); });
    request.addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void this.send(); } });

    const goes = form.createEl("details", { cls: "jotdrop-ai-goes" });
    const goesSummary = goes.createEl("summary");
    goes.createEl("p", { cls: "setting-item-description", text: "These notes go along with your question. Clear a note to keep it out. While answering, the AI can search and read more notes; you see which ones afterwards." });
    const goesList = goes.createEl("ul", { cls: "jotdrop-ai-goes-list" });
    goes.toggle(!this.options.editor);

    const buttons = form.createDiv({ cls: "jotdrop-ai-buttons" });
    const send = buttons.createEl("button", { text: "Send", cls: "mod-cta" });
    send.addEventListener("click", () => void this.send());
    const stop = buttons.createEl("button", { text: "Stop" });
    stop.hide();
    stop.addEventListener("click", () => { this.confirming?.(false); this.controller?.abort(new DOMException("Stopped.", "AbortError")); });
    const status = root.createEl("p", { cls: "jotdrop-ai-status", attr: { role: "status", "aria-live": "polite" } });

    const confirm = root.createDiv({ cls: "jotdrop-ai-confirm" });
    confirm.hide();
    const confirmTitle = confirm.createEl("h3");
    const confirmBody = confirm.createDiv();
    const confirmButtons = confirm.createDiv({ cls: "jotdrop-ai-buttons" });
    const apply = confirmButtons.createEl("button", { text: "Apply", cls: "mod-cta" });
    apply.addEventListener("click", () => this.confirming?.(true));
    confirmButtons.createEl("button", { text: "Do not change" }).addEventListener("click", () => this.confirming?.(false));

    const result = root.createDiv({ cls: "jotdrop-ai-result" });
    result.hide();
    const badge = result.createEl("p", { cls: "jotdrop-ai-badge" });
    const answer = result.createDiv({ cls: "jotdrop-ai-answer" });
    const sources = result.createDiv({ cls: "jotdrop-ai-sources" });
    const actions = result.createEl("ul", { cls: "jotdrop-ai-actions" });
    const also = result.createEl("p", { cls: "setting-item-description" });
    const usage = result.createEl("p", { cls: "setting-item-description" });
    const useButtons = result.createDiv({ cls: "jotdrop-ai-buttons" });
    const reportBox = result.createDiv({ cls: "jotdrop-ai-report" });
    reportBox.hide();

    this.el = { off: offEl, via: viaEl, request, goes, goesSummary, goesList, send, stop, status, confirm, confirmTitle, confirmBody, apply, result, badge, answer, sources, actions, also, usage, useButtons, reportBox };
  }

  // The list is what really goes: the same choice the assistant makes, minus the notes the user cleared.
  private pick(request: string) {
    return selectNotes(this.notes.filter((note) => !this.excluded.has(note.id)), request, { includeShared: this.config.includeShared, pinned: this.pinned });
  }

  private renderGoes(): void {
    const picked = this.pick(this.el.request.value).notes;
    const kept = this.notes.filter((note) => this.excluded.has(note.id));
    this.el.goesList.empty();
    const row = (note: { id: string; title: string; truncated?: boolean }, on: boolean) => {
      const label = this.el.goesList.createEl("li").createEl("label");
      const box = label.createEl("input", { attr: { type: "checkbox" } });
      box.checked = on;
      box.addEventListener("change", () => { if (box.checked) this.excluded.delete(note.id); else this.excluded.add(note.id); this.renderGoes(); });
      label.appendText(` ${note.title || "Untitled"}${on && note.truncated ? " (shortened)" : ""}${on ? "" : " (kept out)"}`);
    };
    for (const note of picked) row(note, true);
    for (const note of kept) row(note, false);
    this.el.goesSummary.setText(picked.length ? `What goes along: ${picked.length} ${picked.length === 1 ? "note" : "notes"}` : "What goes along: your question, no notes yet");
  }

  private confirmChange(change: Change): Promise<boolean> {
    const shown = describeChange(change);
    this.el.confirmTitle.setText(shown.heading);
    const body = this.el.confirmBody;
    body.empty();
    if (shown.lines) {
      body.createEl("p", { cls: "setting-item-description", text: "+ is added, - is removed." });
      for (const line of foldUnchanged(shown.lines)) {
        body.createDiv({ cls: `jotdrop-diff-line ${line.type}`, text: line.type === "gap" ? `${line.count} unchanged ${line.count === 1 ? "line" : "lines"}` : `${line.sign} ${line.text}` });
      }
    } else {
      const list = body.createEl("dl", { cls: "jotdrop-ai-facts" });
      for (const [name, value] of shown.facts ?? []) { list.createEl("dt", { text: name }); list.createEl("dd", { text: value }); }
    }
    this.el.confirm.show();
    this.el.status.setText("Waiting for you: the AI asks to change a note.");
    this.el.apply.focus();
    return new Promise((resolve) => {
      this.confirming = (yes) => {
        this.confirming = undefined;
        this.el.confirm.hide();
        this.el.status.setText(yes ? "Changing the note, then asking on..." : "Not changed. Asking on...");
        resolve(yes);
      };
    });
  }

  private setBusy(busy: boolean): void {
    this.el.send.disabled = busy;
    this.el.stop.toggle(busy);
    this.el.request.readOnly = busy || Boolean(this.options.editor || this.options.summarize);
  }

  private resetResult(): void {
    this.last = undefined;
    this.toOpen = undefined;
    this.el.result.hide();
    this.el.reportBox.hide();
    this.el.confirm.hide();
    this.el.status.setText("");
    for (const el of [this.el.answer, this.el.sources, this.el.actions, this.el.useButtons, this.el.reportBox]) el.empty();
  }

  private async send(): Promise<void> {
    const request = this.el.request.value.trim();
    if (!request || this.controller || this.offReason()) return;
    const { editor } = this.options;
    const notes = this.notes.filter((note) => !this.excluded.has(note.id));
    const first = new Set(this.pick(request).notes.map((note) => note.id));
    const before = new Map([...this.texts].filter(([id]) => notes.some((note) => note.id === id)));
    this.controller = new AbortController();
    this.resetResult();
    this.setBusy(true);
    const name = spec(this.config.provider)?.name ?? "the AI service";
    this.el.status.setText(`Asking ${name}...`);
    try {
      const report = await runAssistant({
        request, notes, labels: aiLabels(this.plugin, this.notes), pinned: this.pinned, includeShared: this.config.includeShared,
        settings: { language: getLanguage() || "en", date: aiToday(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        config: { provider: this.config.provider, key: this.config.key, model: this.config.model, baseUrl: this.config.baseUrl },
        fetcher: cloudFetch,
        executor: editor ? {} : aiExecutor(this.plugin, before, (file) => { this.toOpen = file; }),
        confirm: editor ? async () => false : (change: Change) => this.confirmChange(change),
        signal: this.controller.signal,
      });
      this.showReport(report, request, first);
    } catch (error) {
      this.el.status.setText(aiErrorText(error, this.config.provider));
    } finally {
      this.controller = undefined;
      this.confirming?.(false);
      this.setBusy(false);
      this.plugin.refreshViews();
    }
    if (this.toOpen && !editor) {
      const file = this.toOpen;
      this.close();
      this.options.openNote(file);
    }
  }

  private fileOf(id: string | undefined): TFile | null {
    const file = id ? this.app.vault.getAbstractFileByPath(id) : null;
    return file instanceof TFile ? file : null;
  }

  private titleOf(id: string | undefined): string {
    return this.notes.find((note) => note.id === id)?.title ?? this.fileOf(id)?.basename ?? "a note";
  }

  private actionLine(action: AiAction): string {
    const input = (action.input ?? {}) as { id?: string; title?: string };
    const title = action.tool === "create_note" ? input.title ?? "a note" : this.titleOf(input.id);
    const words = ({
      create_note: `Made the note "${title}"`, append_to_note: `Added to "${title}"`, replace_note_text: `Replaced the text of "${title}"`,
      set_labels: `Set the labels of "${title}"`, set_reminder: `Set a reminder on "${title}"`, set_expiry: `Set an expiry date on "${title}"`, open_note: `Opened "${title}"`,
    } as Record<string, string>)[action.tool] ?? `Asked for "${action.tool}"`;
    const lower = words.charAt(0).toLowerCase() + words.slice(1);
    if (action.status === "done") return `Done: ${words}.`;
    if (action.status === "declined") return `Not changed: you said no (${lower}).`;
    if (action.reason === "unknown_tool") return `Refused: the AI asked for "${action.tool}", which Ask JotDrop cannot do. Deleting, archiving and sharing stay yours to do.`;
    if (action.reason === "not_allowed") return "Left alone: that note is shared, and shared notes are kept out.";
    return `Did not work: ${lower}.`;
  }

  private showReport(report: Report, request: string, first: Set<string>): void {
    const service = spec(this.config.provider);
    const name = this.config.provider === "custom" ? this.config.baseUrl : service?.name ?? "";
    const model = this.config.model || service?.defaultModel || "";
    this.last = { report, request, model, provider: name };
    const stops: Record<string, string> = {
      refusal: "The AI service declined to answer this.",
      max_rounds: "Ask JotDrop stopped after 6 rounds, so the AI cannot run up your bill. Try a shorter request.",
    };
    const problem = report.error ? aiErrorText(report.error, this.config.provider) : stops[report.stop] ?? "";
    this.el.status.setText(problem);
    this.el.result.toggle(Boolean(report.answer || report.actions.length || report.sent.length));
    this.el.badge.setText(`AI answer from ${name}, model ${model}. Check it before you rely on it.`);
    showAnswer(this.el.answer, report.answer || (problem ? "" : "The AI gave no answer in words."));
    const { editor } = this.options;
    if (!editor) {
      for (const note of report.sources) {
        const file = this.fileOf(note.id);
        if (file) this.el.sources.createEl("button", { text: `Open "${note.title}"` }).addEventListener("click", () => { this.close(); this.options.openNote(file); });
      }
      for (const action of report.actions.filter((a) => !["search_notes", "read_note"].includes(a.tool))) {
        const item = this.el.actions.createEl("li", { text: this.actionLine(action) });
        const made = action.tool === "create_note" && action.status === "done" ? this.fileOf((action.result as { id?: string } | undefined)?.id) : null;
        if (made) item.createEl("button", { text: "Open", cls: "jotdrop-ai-inline" }).addEventListener("click", () => { this.close(); this.options.openNote(made); });
      }
    }
    const also = report.sent.filter((note) => !first.has(note.id));
    this.el.also.setText(report.stop === "off" ? "Nothing was sent." : `${report.error ? "Tried to send" : "Sent"} to ${name}: your question${first.size ? ` and ${first.size} ${first.size === 1 ? "note" : "notes"}` : ""}${also.length ? `. While answering it also read: ${also.map((note) => `"${note.title}"`).join(", ")}` : ""}.`);
    this.el.usage.setText(onThisComputer(this.config)
      ? `Tokens: ${report.usage.input} in, ${report.usage.output} out, on this device.`
      : `Tokens: ${report.usage.input} in, ${report.usage.output} out. ${name} bills these to your account.`);

    const answered = Boolean(report.answer.trim());
    if (!answered) return;
    const buttons = this.el.useButtons;
    if (editor && editor.kind !== "summarize") buttons.createEl("button", { text: "Replace the text", cls: "mod-cta" }).addEventListener("click", () => { editor.use(report.answer, true); this.close(); });
    if (editor) buttons.createEl("button", { text: "Add below" }).addEventListener("click", () => { editor.use(report.answer, false); this.close(); });
    if (!editor && this.options.summarize) {
      const below = buttons.createEl("button", { text: "Add below the note", cls: "mod-cta" });
      below.addEventListener("click", () => void this.addBelow(below));
    }
    const save = buttons.createEl("button", { text: "Save as a new note" });
    save.addEventListener("click", () => void this.saveAnswer(save));
    buttons.createEl("button", { text: "Report" }).addEventListener("click", () => this.toggleReport());
  }

  private async addBelow(button: HTMLButtonElement): Promise<void> {
    try {
      const file = this.fileOf(this.options.file?.path);
      if (!file || !this.last) throw new Error("This note is gone.");
      const answer = this.last.report.answer;
      await this.app.vault.process(file, (text) => appendedText(text, { text: answer }));
      this.el.status.setText("Added below the note.");
      button.remove();
    } catch (error) { this.el.status.setText(aiErrorText(error, this.config.provider)); }
  }

  private async saveAnswer(button: HTMLButtonElement): Promise<void> {
    try {
      if (!this.last) return;
      const target = this.options.editor?.title || (this.options.file ? this.titleOf(this.options.file.path) : "");
      const kind = this.options.editor?.kind ?? (this.options.summarize ? "summarize" : "ask");
      const title = kind === "summarize" && target ? `Summary of ${target}` : this.last.request.split("\n")[0].slice(0, 80);
      await createNoteInFolder(this.app, this.plugin.settings.notesFolder, newNoteText({ title, text: this.last.report.answer }));
      this.el.status.setText(`Saved as the note "${title}".`);
      button.remove();
      this.plugin.refreshViews();
    } catch (error) { this.el.status.setText(aiErrorText(error, this.config.provider)); }
  }

  // A report holds the question and the answer, never the notes or the key.
  private reportText(): string {
    const last = this.last;
    if (!last) return "";
    return `Ask JotDrop report\nAI service: ${last.provider}\nModel: ${last.model}\nDate: ${new Date().toISOString()}\nApp: JotDrop for Obsidian ${this.plugin.manifest.version}\n\nQuestion:\n${last.request}\n\nAnswer:\n${last.report.answer}\n\nWhat is wrong with it:\n`;
  }

  private toggleReport(): void {
    const box = this.el.reportBox;
    if (box.isShown()) { box.hide(); return; }
    box.empty();
    box.createEl("p", { text: "Is this answer wrong, harmful or strange? Send it to us with a few words about what is wrong. The report holds your question and the answer, not your notes or your key." });
    const row = box.createDiv({ cls: "jotdrop-ai-buttons" });
    row.createEl("a", { text: "Write an email", cls: "mod-cta", href: `mailto:hello@jotdrop.net?subject=${encodeURIComponent("Ask JotDrop report")}&body=${encodeURIComponent(this.reportText())}` });
    row.createEl("button", { text: "Copy the report" }).addEventListener("click", () => {
      void navigator.clipboard.writeText(this.reportText()).then(() => new Notice("Report copied."), () => new Notice("Could not copy the report."));
    });
    box.show();
  }

  onClose(): void {
    window.clearTimeout(this.goesTimer);
    this.confirming?.(false);
    this.controller?.abort(new DOMException("Stopped.", "AbortError"));
    this.contentEl.empty();
  }
}

/** The settings section "Ask JotDrop": service, key, address, model, shared notes. Saved only on Save. */
export function renderAiSettings(el: HTMLElement, plugin: JotDropPlugin): void {
  let saved: AiConfig = { ...AI_OFF };
  let draft: AiConfig = { ...AI_OFF };
  let models: Model[] = [];
  let message = "";
  let problem = false;

  const say = (text: string, isProblem = false) => { message = text; problem = isProblem; render(); };
  // What the form says now; an empty key field keeps the saved key of the same service.
  const formConfig = (): AiConfig => aiSettings({ ...draft, key: draft.key || (draft.provider === saved.provider ? saved.key : "") });

  const render = () => {
    el.empty();
    new Setting(el).setName("Ask JotDrop (AI with your own key)").setHeading();
    el.createEl("p", { text: "Optional and free. Ask JotDrop sends your question, and the notes it shows you first, straight from this device to the AI service you choose, with your own key. JotDrop never sees them. A paid service bills you for what you use. New notes are made at once; a change to a note waits until you apply it." });
    el.createEl("p", { cls: "setting-item-description", text: "Your key stays on this device, outside the vault: it does not sync and is not in the plugin's data.json. On each device you add it again." });

    new Setting(el).setName("AI service").setDesc(draft.provider ? providerNote(draft.provider) : "Ask JotDrop is off. Choose an AI service to turn it on.")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "Off");
        for (const id of AI_PROVIDER_IDS) dropdown.addOption(id, PROVIDERS[id].name);
        dropdown.setValue(draft.provider).onChange((value) => {
          const provider = value as AiConfig["provider"];
          draft = { ...draft, provider, key: "", model: provider === saved.provider ? saved.model : "", baseUrl: provider === saved.provider ? saved.baseUrl : draft.baseUrl };
          models = [];
          message = "";
          render();
        });
      });
    const service = spec(draft.provider);
    if (!service) { renderFooter(); return; }

    if (draft.provider === "custom") {
      new Setting(el).setName("Address").setDesc("The service's base address, for example http://127.0.0.1:1234/v1 for LM Studio.")
        .addText((text) => text.setPlaceholder("https://...").setValue(draft.baseUrl).onChange((value) => { draft.baseUrl = value.trim(); }));
    }
    if (service.needsKey || draft.provider === "custom") {
      const hasKey = draft.provider === saved.provider && Boolean(saved.key);
      new Setting(el).setName(service.needsKey ? "API key" : "API key (if the service asks for one)")
        .addText((text) => {
          text.inputEl.type = "password";
          text.inputEl.autocomplete = "off";
          text.setPlaceholder(hasKey ? "Saved. Type a new key to replace it." : "Paste your key here").setValue(draft.key).onChange((value) => { draft.key = value.trim(); });
        });
    }
    const modelSetting = new Setting(el).setName("Model").setDesc(service.defaultModel ? `Empty means the default, ${service.defaultModel}.` : "Load the models and choose one that can use tools.")
      .addText((text) => text.setPlaceholder(service.defaultModel ?? "model id").setValue(draft.model).onChange((value) => { draft.model = value.trim(); }))
      .addButton((button) => button.setButtonText("Test and load models").onClick(() => void loadModels(button.buttonEl)));
    if (models.length) {
      // A plain list in groups: 400 models in one flat list cannot be read (Eric, 9 Nov 2026).
      const select = modelSetting.controlEl.createEl("select", { cls: "dropdown jotdrop-ai-models", attr: { "aria-label": "Models of this service" } });
      select.createEl("option", { text: `Choose one of ${models.length} models`, value: "" });
      const preferred = pickDefaultModel(draft.provider, models);
      for (const group of modelGroups(draft.provider, models, preferred)) {
        const optgroup = select.createEl("optgroup", { attr: { label: group.label === "Cannot use tools" ? "Cannot use tools: answers only, no changes" : group.label } });
        for (const model of group.models) optgroup.createEl("option", { text: model.name === model.id ? model.id : `${model.name} (${model.id})`, value: model.id });
      }
      select.value = models.some((model) => model.id === draft.model) ? draft.model : "";
      select.addEventListener("change", () => { if (select.value) { draft.model = select.value; render(); } });
    }
    new Setting(el).setName("Also use notes from shared groups and list links")
      .setDesc("Off: notes that others can read stay out of Ask JotDrop.")
      .addToggle((toggle) => toggle.setValue(draft.includeShared).onChange((value) => { draft.includeShared = value; }));
    renderFooter();
  };

  const renderFooter = () => {
    new Setting(el)
      .addButton((button) => button.setButtonText("Save").setCta().onClick(() => void save()))
      .addButton((button) => button.setButtonText("Remove key and turn off").setWarning().setDisabled(!saved.provider).onClick(() => void remove()));
    if (message) el.createEl("p", { cls: problem ? "jotdrop-ai-problem" : "jotdrop-ai-said", text: problem ? `Problem: ${message}` : message, attr: { role: "status" } });
  };

  const save = async () => {
    try {
      const next = formConfig();
      if (next.provider && PROVIDERS[next.provider].needsKey && !next.key) throw new Error("Paste your API key first.");
      if (next.provider === "custom" && !next.baseUrl) throw new Error("Fill in the address of the service first.");
      await plugin.aiStore.save(next);
      saved = next;
      draft = { ...next, key: "" };
      say(next.provider ? "Saved. Ask JotDrop is on on this device." : "Saved. Ask JotDrop is off.");
    } catch (error) { say(aiErrorText(error, draft.provider), true); }
  };

  const remove = async () => {
    try {
      await plugin.aiStore.remove();
      saved = { ...AI_OFF };
      draft = { ...AI_OFF };
      models = [];
      say("Ask JotDrop is off, and the key is removed from this device.");
    } catch (error) { say(aiErrorText(error, draft.provider), true); }
  };

  // Asking for the model list checks key and connection; no note goes along.
  const loadModels = async (button: HTMLButtonElement) => {
    button.disabled = true;
    button.setText("Asking...");
    try {
      const config = formConfig();
      const list = await createProvider({ ...config, model: config.model || "any" }, cloudFetch).listModels({ signal: withTimeout(20000) }) as Model[];
      const preferred = pickDefaultModel(config.provider, list);
      const picked = !draft.model;
      if (picked) draft.model = preferred ?? "";
      models = list;
      const chosen = draft.model, found = list.find((model) => model.id === chosen);
      const about = !chosen ? "Choose a model." : !found ? `"${chosen}" is not in the list of this service.` : found.tools === false ? `"${chosen}" cannot use tools: it can answer, but not make or change notes.` : picked && config.provider === "openrouter" ? `Model: ${chosen}, the cheapest one here that can use tools. Choose another one from the list if you like.` : `Model: ${chosen}.`;
      say(`Connected: ${list.length} ${list.length === 1 ? "model" : "models"}. ${about} Select Save to keep this.`);
    } catch (error) { say(aiErrorText(error, draft.provider), true); }
  };

  el.createEl("p", { text: "Loading..." });
  void plugin.aiStore.load().then((config) => { saved = config; draft = { ...config, key: "" }; render(); });
}

/** The toolbar button on the board. */
export function addAskButton(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
  const button = parent.createEl("button", { cls: "jotdrop-mic-btn jotdrop-ask-btn", attr: { "aria-label": label, title: label } });
  setIcon(button, "sparkles");
  button.addEventListener("click", onClick);
  return button;
}

// The screens of Ask JotDrop in Obsidian: the question window and the settings. The same flow as the web app
// (cloud/web/app.js): the list "What goes along" before anything leaves, a new note at once, a change to a note only
// after Apply, the answer as simple formatting built with textContent (never innerHTML), a Report button. The AI
// service is reached straight from this device through cloudFetch (Obsidian's requestUrl), never through JotDrop.
import { type App, Modal, Notice, Setting, TFile, getLanguage, setIcon } from "obsidian";
import type JotDropPlugin from "./main";
import { cloudFetch } from "./cloud";
import { createNoteInFolder } from "./capture";
import { FILE_KIND_ICON, formatFileSize } from "./fileKinds";
import { readMeta } from "./metadata";
import { PAPER_DRAWER, SUGGESTED_DRAWERS, drawerName, validExpires } from "../cloud/shared/paper.mjs";
import { AI_OFF, AI_PROVIDER_IDS, type AiConfig, type AiFile, type AiNote, FILE_ACTIONS, type FileAction, aiExecutor, aiLabels, aiSettings, aiTitle, aiToday, applyReceipt, collectAiFiles, collectAiNotes, readAiPart } from "./ai";
import {
  AiError, type AiAction, type AiChange, type AiPart, type AiReceipt, type AiReport, FILE_TIMEOUT_MS, KEEP_YEARS, LIMITS, PHOTO_SYSTEM, PROVIDERS, TRANSCRIBE_MODEL,
  appendedText, capabilities, createProvider, decodedLength, describeChange, editorRequest, explain, fileRequest, foldUnchanged, keepUntil, modelGroups, newNoteText,
  parseMarkdown, parseReceipt, pickDefaultModel, receiptLines, receiptRequest, runAssistant, selectNotes,
} from "./aiShared";

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

// OpenAI writes out a recording with its own model, which the lines name.
const modelFor = (config: AiConfig, action?: FileAction): string =>
  action === "transcribe" && config.provider === "openai" ? TRANSCRIBE_MODEL : config.model || spec(config.provider)?.defaultModel || "";

const FILE_WORDS: Record<string, string> = { image: "Photo", pdf: "PDF", audio: "Recording" };

const via = (config: AiConfig, action?: FileAction, files = false): string => {
  const service = spec(config.provider);
  if (!service) return "";
  const model = modelFor(config, action) || "no model chosen";
  if (onThisComputer(config)) return `Goes to ${config.provider === "ollama" ? "Ollama" : config.baseUrl} on this device, model ${model}. Your request${files ? ", notes and files" : " and notes"} stay on this device.`;
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
  /**
   * Version 2, with a file: one of the note's files goes, no notes, a fixed request and no tools. transcribe writes
   * out a recording, photo reads the text on a photo, receipt reads a receipt for the Paper drawer.
   */
  action?: FileAction;
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
  // Version 2: the note's files (ticked ones go along), the labels for the receipt screen, and whether the note is shared.
  private files: AiFile[] = [];
  private filesOn = new Set<string>();
  private labels: string[] = [];
  private targetShared = false;
  private receipt?: { receipt: AiReceipt; before: string; path: string };
  private groupName = `jotdrop-ai-file-${Math.random().toString(36).slice(2)}`;
  private el!: {
    off: HTMLElement; via: HTMLElement; request: HTMLTextAreaElement; goes: HTMLDetailsElement; goesSummary: HTMLElement; goesList: HTMLElement; goesFiles: HTMLElement;
    send: HTMLButtonElement; stop: HTMLButtonElement; status: HTMLElement; confirm: HTMLElement; confirmTitle: HTMLElement; confirmBody: HTMLElement;
    apply: HTMLButtonElement; receipt: HTMLElement; result: HTMLElement; badge: HTMLElement; answer: HTMLElement; sources: HTMLElement; actions: HTMLElement; also: HTMLElement;
    usage: HTMLElement; useButtons: HTMLElement; reportBox: HTMLElement;
  };

  constructor(app: App, private plugin: JotDropPlugin, private options: AskOptions) {
    super(app);
  }

  /** The language for a hint to the service: Obsidian's own, else the system's. */
  private language(): string {
    return getLanguage() || navigator.language || "en";
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass("jotdrop-ai-modal");
    this.titleEl.setText("Ask JotDrop");
    this.config = await this.plugin.aiStore.load();
    const { editor, file, summarize, action } = this.options;
    if (editor) {
      this.notes = [{ id: "draft", title: editor.title || "Untitled", text: editor.text, labels: [], updatedAt: "", shared: false }];
      this.labels = aiLabels(this.plugin, this.notes);
    } else {
      ({ notes: this.notes, texts: this.texts } = await collectAiNotes(this.plugin));
      this.labels = aiLabels(this.plugin, this.notes);
      this.targetShared = Boolean(file && this.notes.find((note) => note.id === file.path)?.shared);
      if (file && summarize) this.notes = this.notes.filter((note) => note.id === file.path);
      // Asking about a note lists its files unticked; a file action sends one of them and no notes. A shared note's
      // files stay home like the note itself, unless the user allows shared notes.
      if (file && !summarize) {
        const own = this.targetShared && !this.config.includeShared ? [] : await collectAiFiles(this.plugin, file, this.texts.get(file.path) ?? await this.app.vault.cachedRead(file));
        if (action) {
          this.notes = [];
          this.files = own.filter((one) => (FILE_ACTIONS[action] as readonly string[]).includes(one.kind));
          const first = this.files.find((one) => !this.fileProblem(one));
          if (first) this.filesOn.add(first.id);
        } else this.files = own;
      }
    }
    this.pinned = editor ? ["draft"] : file && !action ? [file.path] : [];
    this.build();
    const request = editor ? editorRequest(editor.kind, editor.title || "Untitled")
      : summarize ? editorRequest("summarize", this.notes[0]?.title ?? file?.basename ?? "")
      : action === "receipt" ? receiptRequest(this.language()).text
      : action ? fileRequest(action) : "";
    this.el.request.value = request;
    this.el.request.readOnly = Boolean(editor || summarize || action);
    // A file action shows the file at once: the user sends it, or chooses another one first.
    this.el.goes.open = Boolean(action);
    this.renderGoes();
    const off = this.offReason();
    if (off) return;
    if (request && !action) void this.send();
    else if (action) this.el.send.focus();
    else this.el.request.focus();
  }

  /** Why a file cannot go with this service, in words, or "". The limits before reading; a photo is made small first. */
  private fileProblem(file: AiFile): string {
    const use = this.options.action === "transcribe" ? "transcribe" : "ask";
    const caps = capabilities(this.config.provider, { id: this.config.model || spec(this.config.provider)?.defaultModel || "" });
    if (caps[file.kind === "audio" && use === "transcribe" ? "transcribe" : file.kind] === false) return explain(this.config.provider, file.kind, use);
    if (file.kind !== "image" && file.bytes > LIMITS[file.kind]) return `Larger than ${Math.round(LIMITS[file.kind] / 1048576)} MiB, too large to send.`;
    return "";
  }

  private offReason(): string {
    if (!this.config.provider) return "Ask JotDrop is off. Choose an AI service, and add your own key, in the JotDrop settings.";
    if (this.options.file && !this.options.editor && !this.config.includeShared && this.targetShared) {
      return this.options.action
        ? "This note is in a shared group or has a list link. Ask JotDrop keeps those notes and their files out, unless you switch on \"Also use notes from shared groups and list links\" in its settings."
        : "This note is in a shared group or has a list link. Ask JotDrop keeps those out, unless you switch on \"Also use notes from shared groups and list links\" in its settings.";
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

    const viaEl = root.createEl("p", { cls: "jotdrop-ai-via", text: off ? "" : via(this.config, this.options.action, this.files.length > 0) });
    const form = root.createDiv({ cls: "jotdrop-ai-ask" });
    form.toggle(!off);
    const request = form.createEl("textarea", { cls: "jotdrop-ai-request", attr: { rows: "3", placeholder: "Ask about your notes, or tell JotDrop what to do. For example: put milk and bread on the shopping list.", "aria-label": "Your request" } });
    request.addEventListener("input", () => { window.clearTimeout(this.goesTimer); this.goesTimer = window.setTimeout(() => this.renderGoes(), 200); });
    request.addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void this.send(); } });

    const goes = form.createEl("details", { cls: "jotdrop-ai-goes" });
    const goesSummary = goes.createEl("summary");
    goes.createEl("p", {
      cls: "setting-item-description",
      text: this.options.action
        ? "Only the chosen file goes, with the fixed request above. No notes go along, and the AI cannot change anything."
        : `These notes go along with your question. Clear a note to keep it out. While answering, the AI can search and read more notes; you see which ones afterwards.${this.files.length ? " A file of the note goes only when you tick it." : ""}`,
    });
    const goesList = goes.createEl("ul", { cls: "jotdrop-ai-goes-list" });
    const goesFiles = goes.createEl("p", { cls: "setting-item-description", text: "The ticked file goes to the AI service as it is; a photo is made smaller first. A photo or recording can hold other people's details, so only send what you may share." });
    goesFiles.hide();
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

    const receipt = root.createDiv({ cls: "jotdrop-ai-confirm jotdrop-ai-receipt" });
    receipt.hide();

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

    this.el = { off: offEl, via: viaEl, request, goes, goesSummary, goesList, goesFiles, send, stop, status, confirm, confirmTitle, confirmBody, apply, receipt, result, badge, answer, sources, actions, also, usage, useButtons, reportBox };
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
    // A file row: a mark, the name, the kind in words and the size; one that cannot go says why and cannot be ticked.
    // A file action sends one file, so there the rows are a choice of one.
    const one = Boolean(this.options.action);
    for (const file of this.files) {
      const label = this.el.goesList.createEl("li").createEl("label", { cls: "jotdrop-ai-file" });
      // A name of this window's own: radio buttons with one name form one group across the whole page.
      const box = label.createEl("input", { attr: { type: one ? "radio" : "checkbox", name: this.groupName } });
      const problem = this.fileProblem(file);
      box.disabled = Boolean(problem);
      box.checked = !problem && this.filesOn.has(file.id);
      box.addEventListener("change", () => {
        if (one) this.filesOn = new Set([file.id]);
        else if (box.checked) this.filesOn.add(file.id);
        else this.filesOn.delete(file.id);
        this.renderGoes();
      });
      setIcon(label.createSpan({ cls: "jotdrop-ai-file-icon", attr: { "aria-hidden": "true" } }), FILE_KIND_ICON[file.kind]);
      label.appendText(` ${file.name} · ${FILE_WORDS[file.kind]} · ${formatFileSize(file.bytes)}${problem ? ` (cannot go: ${problem})` : box.checked ? "" : " (stays home)"}`);
    }
    const sending = this.files.filter((file) => this.filesOn.has(file.id) && !this.fileProblem(file));
    this.el.goesFiles.toggle(sending.length > 0);
    this.el.via.setText(this.offReason() ? "" : via(this.config, this.options.action, sending.length > 0));
    const noteWords = picked.length ? `${picked.length} ${picked.length === 1 ? "note" : "notes"}` : "";
    const fileWords = sending.length ? `${sending.length} ${sending.length === 1 ? "file" : "files"}` : "";
    this.el.goesSummary.setText(noteWords || fileWords ? `What goes along: ${[noteWords, fileWords].filter(Boolean).join(" and ")}` : one ? "What goes along: no file yet" : "What goes along: your question, no notes yet");
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
    this.el.request.readOnly = busy || Boolean(this.options.editor || this.options.summarize || this.options.action);
  }

  private resetResult(): void {
    this.last = undefined;
    this.toOpen = undefined;
    this.receipt = undefined;
    this.el.result.hide();
    this.el.reportBox.hide();
    this.el.confirm.hide();
    this.el.receipt.hide();
    this.el.status.setText("");
    for (const el of [this.el.answer, this.el.sources, this.el.actions, this.el.useButtons, this.el.reportBox, this.el.receipt]) el.empty();
  }

  // Writing out a recording, reading a photo and reading a receipt are one request each, without tools, with the
  // longer AI time of files. The result takes the form of the assistant's report, so the answer, the report and the
  // "sent" line work the same.
  private async once(request: string, parts: AiPart[], run: (ai: ReturnType<typeof createProvider>, signal: AbortSignal) => Promise<{ text?: string; usage?: { input?: number; output?: number; seconds?: number }; stop?: string }>, signal: AbortSignal): Promise<Report> {
    const report: Report = { answer: "", sent: [], sources: [], actions: [], files: parts.map((part) => ({ name: part.name, kind: part.kind, bytes: decodedLength(part.data) })), rounds: 1, usage: { input: 0, output: 0 }, stop: "done" };
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(new DOMException("The AI service took too long.", "TimeoutError")), FILE_TIMEOUT_MS);
    const passOn = () => controller.abort(signal.reason);
    signal.addEventListener("abort", passOn, { once: true });
    try {
      const { provider, key, model, baseUrl } = this.config;
      const answer = await run(createProvider({ provider, key, model, baseUrl }, cloudFetch), controller.signal);
      report.answer = answer.text ?? "";
      report.usage = { input: answer.usage?.input ?? 0, output: answer.usage?.output ?? 0, ...(answer.usage?.seconds ? { seconds: answer.usage.seconds } : {}) };
      if (answer.stop === "refusal") report.stop = "refusal";
    } catch (error) {
      const known = error instanceof AiError ? error as AiError & { code: string; detail: string; status: number } : new AiError("bad_response", String((error as Error)?.message ?? "")) as AiError & { code: string; detail: string; status: number };
      // JotDrop's own check stops a file before anything goes out.
      if (!known.status && ["unsupported_input", "too_large", "bad_request"].includes(known.code)) report.rounds = 0;
      report.stop = known.code === "timeout" || known.code === "cancelled" ? known.code : known.code === "refusal" ? "refusal" : ["no_key", "no_model", "no_provider", "bad_address"].includes(known.code) ? "off" : "error";
      if (report.stop !== "refusal") report.error = { code: known.code, message: known.message, detail: known.detail };
    } finally {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", passOn);
    }
    return report;
  }

  private async send(): Promise<void> {
    const request = this.el.request.value.trim();
    if (!request || this.controller || this.offReason()) return;
    const { editor, action, file } = this.options;
    const notes = this.notes.filter((note) => !this.excluded.has(note.id));
    const first = new Set(this.pick(request).notes.map((note) => note.id));
    const before = new Map([...this.texts].filter(([id]) => notes.some((note) => note.id === id)));
    const chosen = this.files.filter((one) => this.filesOn.has(one.id) && !this.fileProblem(one));
    if (action && !chosen.length) { this.el.status.setText(this.files.length ? "Choose a file first." : "This note has no such file on this device."); return; }
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.resetResult();
    this.setBusy(true);
    const name = spec(this.config.provider)?.name ?? "the AI service";
    try {
      // The note as it is now: the receipt screen changes it only when nothing changed meanwhile.
      const target = action === "receipt" && file ? await this.app.vault.read(file) : "";
      let parts: AiPart[] = [];
      if (chosen.length) {
        this.el.status.setText(chosen.some((one) => one.kind === "image") ? "Making the photo smaller on this device..." : "Getting the file ready...");
        parts = await Promise.all(chosen.map((one) => readAiPart(this.plugin, one)));
        signal.throwIfAborted();
      }
      this.el.status.setText(`Asking ${name}...`);
      let report: Report;
      if (action === "transcribe") {
        report = await this.once(request, parts, (ai, s) => ai.transcribe({ audio: parts[0], language: this.language(), signal: s }), signal);
      } else if (action === "receipt") {
        const { system, text } = receiptRequest(this.language());
        report = await this.once(request, parts, (ai, s) => ai.complete({ system, messages: [{ role: "user", text, parts }], tools: [], signal: s }), signal);
      } else if (action === "photo") {
        // A fixed action has no tools: text on a photo can never make or change a note.
        report = await this.once(request, parts, (ai, s) => ai.complete({ system: PHOTO_SYSTEM, messages: [{ role: "user", text: request, parts }], tools: [], signal: s }), signal);
      } else {
        report = await runAssistant({
          request, notes, labels: this.labels, pinned: this.pinned, includeShared: this.config.includeShared,
          settings: { language: getLanguage() || "en", date: aiToday(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
          config: { provider: this.config.provider, key: this.config.key, model: this.config.model, baseUrl: this.config.baseUrl },
          fetcher: cloudFetch,
          executor: editor ? {} : aiExecutor(this.plugin, before, (opened) => { this.toOpen = opened; }),
          confirm: editor ? async () => false : (change: Change) => this.confirmChange(change),
          signal, parts,
        });
      }
      this.showReport(report, request, first);
      if (action === "receipt" && file && report.stop === "done") this.showReceipt(parseReceipt(report.answer), target, file);
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
    const model = modelFor(this.config, this.options.action);
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
    // In words what went: the question (a recording goes on its own), the notes, and each file by name.
    const went = [...(this.options.action === "transcribe" ? [] : ["your question"]), ...(first.size ? [`${first.size} ${first.size === 1 ? "note" : "notes"}`] : []),
      ...(report.files ?? []).map((file) => `the ${FILE_WORDS[file.kind]?.toLowerCase() ?? "file"} "${file.name}"`)];
    const wentText = went.length > 1 ? `${went.slice(0, -1).join(", ")} and ${went[went.length - 1]}` : went[0];
    this.el.also.setText(report.stop === "off" || (report.error && report.rounds === 0) ? "Nothing was sent." : `${report.error ? "Tried to send" : "Sent"} to ${name}: ${wentText}${also.length ? `. While answering it also read: ${also.map((note) => `"${note.title}"`).join(", ")}` : ""}.`);
    const counted = report.usage.seconds ? `Recording: ${Math.round(report.usage.seconds)} seconds` : `Tokens: ${report.usage.input} in, ${report.usage.output} out`;
    this.el.usage.setText(onThisComputer(this.config)
      ? `${counted}, on this device.`
      : `${counted}. ${name} bills these to your account.`);

    const answered = Boolean(report.answer.trim());
    if (!answered) return;
    const buttons = this.el.useButtons;
    if (editor && editor.kind !== "summarize") buttons.createEl("button", { text: "Replace the text", cls: "mod-cta" }).addEventListener("click", () => { editor.use(report.answer, true); this.close(); });
    if (editor) buttons.createEl("button", { text: "Add below" }).addEventListener("click", () => { editor.use(report.answer, false); this.close(); });
    if (!editor && (this.options.summarize || this.options.action)) {
      const below = buttons.createEl("button", { text: "Add below the note", cls: "mod-cta" });
      below.addEventListener("click", () => void this.addBelow(below));
    }
    const save = buttons.createEl("button", { text: "Save as a new note" });
    save.addEventListener("click", () => void this.saveAnswer(save));
    buttons.createEl("button", { text: "Report" }).addEventListener("click", () => this.toggleReport());
  }

  /**
   * "Receipt to Paper drawer": the AI's fields in one screen to check and change. Nothing is saved before Apply, and
   * the AI's answer is only data here: parseReceipt checked every field and the app works out the date itself.
   * Nothing usable in the answer: it stays as plain text with the usual buttons.
   */
  private showReceipt(receipt: AiReceipt | null, before: string, file: TFile): void {
    if (!receipt) return;
    this.receipt = { receipt, before, path: file.path };
    this.el.answer.empty();
    this.el.useButtons.empty();
    const box = this.el.receipt;
    box.empty();
    box.createEl("h3", { text: "Receipt to Paper drawer" });
    box.createEl("p", { cls: "setting-item-description", text: "What the AI read from the receipt. Change what is wrong; nothing is saved until you select Apply." });
    const field = (label: string, make: (row: HTMLElement) => HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
      const row = box.createDiv({ cls: "jotdrop-ai-receipt-row" });
      const id = `jotdrop-ai-receipt-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
      row.createEl("label", { text: label, attr: { for: id } });
      const input = make(row);
      input.id = id;
      return input;
    };
    const current = readMeta(this.app, file);
    const name = field("Title", (row) => row.createEl("input", { attr: { type: "text", maxlength: "120", autocomplete: "off", placeholder: aiTitle(before, file.basename) || "Title" } })) as HTMLInputElement;
    name.value = receipt.title ?? "";
    const drawer = field("Drawer", (row) => row.createEl("select", { cls: "dropdown" })) as HTMLSelectElement;
    drawer.createEl("option", { text: PAPER_DRAWER, value: "" });
    const drawers = this.labels.map((label) => drawerName(label)).filter(Boolean);
    for (const one of [...new Set([...drawers, ...SUGGESTED_DRAWERS])]) drawer.createEl("option", { text: `${PAPER_DRAWER} / ${one}`, value: one });
    drawer.value = current.labels.map((label) => drawerName(label)).find(Boolean) ?? "";
    const bought = field("Day of purchase", (row) => row.createEl("input", { attr: { type: "date" } })) as HTMLInputElement;
    bought.value = receipt.bought ?? "";
    const keep = box.createEl("fieldset", { cls: "jotdrop-ai-receipt-keep" });
    keep.createEl("legend", { text: "Keep it for" });
    const years = keep.createDiv({ cls: "jotdrop-ai-buttons" });
    const yearsNote = keep.createEl("p", { cls: "setting-item-description", text: "Fill in the day of purchase to use these." });
    const until = field("Keep until", (row) => row.createEl("input", { attr: { type: "date" } })) as HTMLInputElement;
    until.value = receipt.warrantyUntil ?? keepUntil(receipt.bought, 2);
    const lines = field("Added below the note", (row) => row.createEl("textarea", { attr: { rows: "3", maxlength: "400" } })) as HTMLTextAreaElement;
    lines.value = receiptLines(receipt);
    // The keep buttons count from the day of purchase; the pressed one carries a ✓, not only a colour.
    const renderYears = () => {
      years.empty();
      const choice = (text: string, date: string) => {
        const pressed = Boolean(date) && date === until.value;
        const button = years.createEl("button", { text: `${pressed ? "✓ " : ""}${text}`, attr: { type: "button", "aria-pressed": String(pressed) } });
        button.disabled = !date;
        button.addEventListener("click", () => { until.value = date; renderYears(); });
      };
      for (const count of KEEP_YEARS) choice(`${count} ${count === 1 ? "year" : "years"}`, keepUntil(bought.value, count));
      if (receipt.warrantyUntil) choice("Date on the receipt", receipt.warrantyUntil);
      yearsNote.toggle(!bought.value);
    };
    for (const input of [bought, until]) input.addEventListener("input", renderYears);
    renderYears();
    const buttons = box.createDiv({ cls: "jotdrop-ai-buttons" });
    const apply = buttons.createEl("button", { text: "Apply", cls: "mod-cta" });
    apply.addEventListener("click", async () => {
      try {
        if (!this.receipt) return;
        if (!validExpires(until.value)) throw new Error("Choose how long to keep it, or fill in a date.");
        await applyReceipt(this.plugin, this.receipt.path, this.receipt.before, { title: name.value, lines: lines.value, expires: until.value, drawer: drawer.value });
        box.hide();
        this.receipt = undefined;
        this.el.status.setText(`Done: in the ${drawer.value ? `${PAPER_DRAWER} / ${drawer.value}` : PAPER_DRAWER}, kept until ${until.value}.`);
        this.plugin.refreshViews();
      } catch (error) { this.el.status.setText(aiErrorText(error, this.config.provider)); }
    });
    buttons.createEl("button", { text: "Do not change" }).addEventListener("click", () => {
      box.hide();
      this.receipt = undefined;
      this.el.status.setText("Not changed: the note stays as it was.");
    });
    // The report stays: what went out and what it cost.
    const reportButton = this.el.useButtons.createEl("button", { text: "Report" });
    reportButton.addEventListener("click", () => this.toggleReport());
    box.show();
    this.el.status.setText("Check what the AI read. Nothing is saved until you select Apply.");
    name.focus();
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
      const file = this.options.file;
      const target = this.options.editor?.title || (file ? (this.texts.has(file.path) ? aiTitle(this.texts.get(file.path) ?? "", file.basename) : this.titleOf(file.path)) : "");
      const kind = this.options.editor?.kind ?? (this.options.summarize ? "summarize" : this.options.action ?? "ask");
      const titles: Record<string, string> = { summarize: "Summary of", transcribe: "Recording in", photo: "Text from the photo in", receipt: "Receipt in" };
      const title = titles[kind] && target ? `${titles[kind]} ${target}` : this.last.request.split("\n")[0].slice(0, 80);
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

// Ask JotDrop in the Obsidian plugin: AI with the user's own key (Hand-off/ontwerp-ai-eigen-sleutel.md, phase 4).
// The plugin talks straight to the AI service the user chose, through Obsidian's requestUrl (cloudFetch), never
// through a JotDrop server. Settings and key stay on this device in IndexedDB, sealed like the cloud session; never
// in data.json, which lives in the vault and can travel to other devices. This file holds the parts without a
// screen: the stored settings, the notes in the form the shared assistant reads them, and the changes it asks for.
import { type App, TFile, normalizePath } from "obsidian";
import type JotDropPlugin from "./main";
import { CloudStore, type KeyValues, type Sealed, seal, unseal } from "./cloud";
import { type ColorName, isColorName, readLabels, readMeta, updateMeta } from "./metadata";
import { createNoteInFolder } from "./capture";
import { PROVIDERS, appendedText, expiryChanges, newNoteText, replacedText, splitNote } from "./aiShared";

/** The services in the order the settings show them: a local model first, because nothing leaves the computer. */
export const AI_PROVIDER_IDS = ["ollama", "anthropic", "openai", "gemini", "openrouter", "custom"] as const;
export type AiProviderId = typeof AI_PROVIDER_IDS[number];
export type AiConfig = { provider: AiProviderId | ""; key: string; model: string; baseUrl: string; includeShared: boolean };
export const AI_OFF: AiConfig = { provider: "", key: "", model: "", baseUrl: "", includeShared: false };

/** What is stored, cleaned: only known fields and a known service; an address only for an own address. */
export function aiSettings(stored: unknown): AiConfig {
  const value = stored && typeof stored === "object" ? stored as Record<string, unknown> : {};
  const provider = (AI_PROVIDER_IDS as readonly string[]).includes(value.provider as string) ? value.provider as AiProviderId : "";
  if (!provider) return { ...AI_OFF };
  // Ollama needs no key; an own address may have one (Mistral, a proxy) or not (LM Studio).
  const keeps = PROVIDERS[provider].needsKey || provider === "custom";
  return {
    provider,
    key: keeps ? String(value.key ?? "").trim() : "",
    model: String(value.model ?? "").trim(),
    baseUrl: provider === "custom" ? String(value.baseUrl ?? "").trim() : "",
    includeShared: Boolean(value.includeShared),
  };
}

/** The settings on this device: one sealed value in a store of its own, apart from the cloud connection. */
export class AiSettingsStore {
  private store: KeyValues;
  constructor(app: App, store?: KeyValues) {
    const id = (app as unknown as { appId?: string }).appId || app.vault.getName();
    this.store = store ?? new CloudStore(`jotdrop-ai-${id}`);
  }
  async load(): Promise<AiConfig> {
    try {
      const saved = await this.store.get<Sealed>("settings");
      return aiSettings(saved ? await unseal<unknown>(saved) : undefined);
    } catch {
      return { ...AI_OFF };
    }
  }
  async save(config: AiConfig): Promise<void> { await this.store.put("settings", await seal(aiSettings(config))); }
  async remove(): Promise<void> { await this.store.delete("settings"); }
}

/** A note as the shared assistant reads it; id is the vault path. */
export type AiNote = { id: string; title: string; text: string; labels: string[]; updatedAt: string; shared: boolean };

const isUnder = (path: string, folder: string) => !!folder && (path === folder || path.startsWith(`${folder}/`));

/** The title the AI sees: the first heading, else the first line of text, else the file name. */
export function aiTitle(text: string, basename: string): string {
  const { title, body } = splitNote(text);
  if (title.trim()) return title.trim();
  const line = body.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|#+\s*)/, "").trim()).find((l) => l && !/^!\[/.test(l));
  return line ? line.slice(0, 80) : basename;
}

/**
 * The notes Ask JotDrop may look at: the JotDrop folder with its archive, not the trash, and no Excalidraw drawings
 * (their text is drawing data, not words). shared marks a note in a shared group or with a live list link, which
 * stays home unless the user allows it. Labels come from Obsidian's cache, the text from cachedRead: nothing else
 * is searched or parsed per note.
 */
export async function collectAiNotes(plugin: JotDropPlugin): Promise<{ notes: AiNote[]; texts: Map<string, string> }> {
  const { app, settings } = plugin;
  const folder = normalizePath(settings.notesFolder);
  const archive = normalizePath(settings.archiveFolder);
  const trash = normalizePath(`${settings.notesFolder}/Trash`);
  const files = app.vault.getMarkdownFiles().filter((file) =>
    (isUnder(file.path, folder) || isUnder(file.path, archive)) && !isUnder(file.path, trash) && !plugin.excalidraw.isDrawingFile(file));
  const notes: AiNote[] = [];
  const texts = new Map<string, string>();
  for (const file of files) {
    const text = await app.vault.cachedRead(file);
    texts.set(file.path, text);
    const cloud = plugin.cloud;
    notes.push({
      id: file.path,
      title: aiTitle(text, file.basename),
      text: splitNote(text).body,
      labels: readMeta(app, file).labels,
      updatedAt: new Date(file.stat.mtime).toISOString(),
      shared: Boolean(cloud?.spaceOf(file.path)) || (cloud?.listLinksOf(file.path).length ?? 0) > 0,
    });
  }
  return { notes, texts };
}

/** The user's labels: those on notes plus those made on this device and not used yet. */
export function aiLabels(plugin: JotDropPlugin, notes: AiNote[]): string[] {
  return readLabels([...notes.flatMap((note) => note.labels), ...(plugin.settings.localLabels ?? [])]).sort((a, b) => a.localeCompare(b));
}

type CreateInput = { title: string; text?: string; items?: string[]; color?: string; label?: string };

/**
 * The tools that change notes, on the vault through Obsidian's own file API, so a change is an ordinary edit (and
 * syncs encrypted like any other when the cloud is on). `before` holds each note's text as the AI saw it: a note
 * that changed meanwhile is left alone. open_note only records the wish; the screen opens it after the answer.
 */
export function aiExecutor(plugin: JotDropPlugin, before: Map<string, string>, onOpen: (file: TFile) => void) {
  const { app } = plugin;
  const fileOf = (id: string): TFile => {
    const file = app.vault.getAbstractFileByPath(id);
    if (!(file instanceof TFile)) throw new Error("This note is gone.");
    return file;
  };
  const current = async (id: string): Promise<TFile> => {
    const file = fileOf(id);
    if (before.has(id) && before.get(id) !== await app.vault.read(file)) throw new Error("This note changed while Ask JotDrop worked, so it was left as it is.");
    return file;
  };
  const personal = (file: TFile) => {
    if (plugin.cloud?.spaceOf(file.path)) throw new Error("Reminders and expiry dates are personal, and this note belongs to a shared group, so it was left as it is.");
  };
  const writeText = async (id: string, make: (text: string) => string) => {
    const file = await current(id);
    const text = await app.vault.process(file, (data) => make(data));
    before.set(id, text);
    return "Done.";
  };
  const writeMeta = async (id: string, patch: Parameters<typeof updateMeta>[2], check?: (file: TFile) => void) => {
    const file = await current(id);
    check?.(file);
    await updateMeta(app, file, patch);
    before.set(id, await app.vault.read(file));
    return "Done.";
  };
  return {
    async create_note(input: CreateInput) {
      // Title and text first, so the file name comes from the title; color and label then go in the front matter.
      const text = newNoteText({ title: input.title, text: input.text, items: input.items });
      const file = await createNoteInFolder(app, plugin.settings.notesFolder, text);
      const color: ColorName | null = isColorName(input.color) && input.color !== "default" ? input.color : null;
      if (color || input.label) await updateMeta(app, file, { ...(color ? { color } : {}), ...(input.label ? { labels: [input.label] } : {}) });
      before.set(file.path, await app.vault.read(file));
      return { id: file.path, title: input.title };
    },
    append_to_note: (input: { id: string; text?: string; items?: string[] }) => writeText(input.id, (text) => appendedText(text, input)),
    replace_note_text: (input: { id: string; text: string }) => writeText(input.id, (text) => replacedText(text, input.text)),
    set_labels: (input: { id: string; labels: string[] }) => writeMeta(input.id, { labels: input.labels }),
    // A one-time reminder, as the editor's reminder field writes it; a repeat the note had ends.
    set_reminder: (input: { id: string; at: string }) => writeMeta(input.id, { reminder: input.at, reminderRepeat: null, reminderUntil: null, reminderLimit: null }, personal),
    // An expiry date puts the note in the Paper drawer; without a reminder it gets the usual warning.
    async set_expiry(input: { id: string; date: string; drawer?: string }) {
      const file = await current(input.id);
      const changes = expiryChanges(await app.vault.read(file), input.date, input.drawer);
      return writeMeta(input.id, {
        expires: changes.expires,
        labels: changes.jotdrop_labels,
        ...(changes.reminder ? { reminder: changes.reminder, reminderRepeat: null, reminderUntil: null, reminderLimit: null } : {}),
      }, personal);
    },
    async open_note(input: { id: string }) {
      onOpen(fileOf(input.id));
      return "The note opens for the user after this answer.";
    },
  };
}

/** Today in words for the system prompt, with the time. */
export function aiToday(now = new Date()): string {
  return `${now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}, ${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/** The editor's AI buttons work on the draft: the title and text in the editor; the answer replaces or follows the text. */
export function draftAnswer(title: string, body: string, answer: string, replace: boolean): string {
  const joined = `${title.trim() ? `# ${title.trim()}\n\n` : ""}${body}`;
  const next = replace ? replacedText(joined, answer) : appendedText(joined, { text: answer });
  return splitNote(next).body.replace(/\n+$/, "");
}

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
import { bytesToBase64 } from "../cloud/shared/crypto.mjs";
import {
  type AiFileKind, type AiPart, type KeyAction, type KeyClient, type KeyRemote, LIMITS, PROVIDERS, type SharedKey, aiFileKind, appendedText, decideKeySync, expiryChanges,
  joinNote, newNoteText, plainBase64, readSharedKey, removeSharedKey, replacedText, sameService, saveSharedKey, sharedKey, splitNote,
} from "./aiShared";

/** The services in the order the settings show them: a local model first, because nothing leaves the computer. */
export const AI_PROVIDER_IDS = ["ollama", "anthropic", "openai", "gemini", "openrouter", "custom"] as const;
export type AiProviderId = typeof AI_PROVIDER_IDS[number];
export type AiConfig = {
  provider: AiProviderId | ""; key: string; model: string; baseUrl: string; includeShared: boolean;
  /** One key on all your devices: the server's time of the shared key this device follows, 0 when its key is its own. */
  synced: number;
  /** The workspace of that shared key: signed in to another account, the key here is this device's own again. */
  syncedVault: string;
};
export const AI_OFF: AiConfig = { provider: "", key: "", model: "", baseUrl: "", includeShared: false, synced: 0, syncedVault: "" };

const isProvider = (value: unknown): value is AiProviderId => (AI_PROVIDER_IDS as readonly unknown[]).includes(value);

/** What is stored, cleaned: only known fields and a known service; an address only for an own address. */
export function aiSettings(stored: unknown): AiConfig {
  const value = stored && typeof stored === "object" ? stored as Record<string, unknown> : {};
  const provider = isProvider(value.provider) ? value.provider : "";
  if (!provider) return { ...AI_OFF };
  // Ollama needs no key; an own address may have one (Mistral, a proxy) or not (LM Studio).
  const keeps = PROVIDERS[provider].needsKey || provider === "custom";
  const synced = Number.isSafeInteger(value.synced) && (value.synced as number) > 0 && typeof value.syncedVault === "string" && value.syncedVault ? value.synced as number : 0;
  return {
    provider,
    key: keeps ? String(value.key ?? "").trim() : "",
    model: String(value.model ?? "").trim(),
    baseUrl: provider === "custom" ? String(value.baseUrl ?? "").trim() : "",
    includeShared: Boolean(value.includeShared),
    synced,
    syncedVault: synced ? value.syncedVault as string : "",
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
  /** When this device last looked at the shared key of this workspace; no key in it. */
  async checkedAt(vaultId: string): Promise<number> {
    const saved = await this.store.get<{ vaultId: string; at: number }>("key-checked").catch(() => undefined);
    return saved?.vaultId === vaultId && Number.isFinite(saved.at) ? saved.at : 0;
  }
  async markChecked(vaultId: string): Promise<void> { await this.store.put("key-checked", { vaultId, at: Date.now() }); }
}

// "Use this key on all my devices" (JotDrop Plus; Hand-off/ontwerp-ask-jotdrop-v2.md 4.8), as the web app (cloud/web/app.js)
// and Android (AiKeyCloud.kt) do it: the calls to /ai-key of the own account, never a shared group's, and the copy in
// AiSettingsStore. The rules are keysync.mjs's. The key is never shown, logged or put in a message.

const DAY_MS = 24 * 60 * 60 * 1000;
const PLUS_TEXT = "Using one key on all your devices is part of JotDrop Plus.";
const UNREACHABLE = "Could not reach JotDrop for the key. Try again in a moment.";
export const KEY_REPLACED = "The key was replaced on another device. This device now uses the new one.";
export const KEY_REMOVED = "The key was removed on another device, so Ask JotDrop is off on this device. Add a key to turn it on again.";

/** What the server said, and for which workspace. The screens keep this and judge it against the settings saved now. */
export type KeyLook = { remote: KeyRemote; vaultId: string };

/** A step that did not happen, in words for the user; `remote` is the server's answer when the screen needs it. */
export class KeyRefused extends Error {
  constructor(message: string, readonly reason: string, readonly remote?: KeyRemote) { super(message); }
}

function refusal(error: unknown): KeyRefused {
  if (error instanceof KeyRefused) return error;
  const { code, status, message } = (error ?? {}) as { code?: string; status?: number; message?: string };
  if (code === "plus-required") return new KeyRefused(PLUS_TEXT, "plus");
  return typeof status === "number" && message ? new KeyRefused(message, "server") : new KeyRefused(UNREACHABLE, "unreachable");
}

/** Whether this device follows the shared key of this workspace. */
export const follows = (config: AiConfig, vaultId: string | undefined): boolean => Boolean(vaultId) && config.synced > 0 && config.syncedVault === vaultId;

/** What to do with what the server said, for these settings: those saved now, never those of the moment of looking. */
export function keyAction(config: AiConfig, look: KeyLook | undefined): KeyAction {
  return look ? decideKeySync({ hasKey: Boolean(config.provider), synced: follows(config, look.vaultId) ? config.synced : 0 }, look.remote) : "none";
}

/** A key that is ready here ("Use it here?"): one from another device, or a newer one for another service (switched). */
export function keyOffered(config: AiConfig, look: KeyLook | undefined): { config: SharedKey; switched: boolean } | undefined {
  const remote = look?.remote;
  if (remote?.status !== "found" || !remote.config) return undefined;
  const action = keyAction(config, look);
  if (action === "offer") return { config: remote.config, switched: false };
  return action === "update" && !sameService(remote.config, config) ? { config: remote.config, switched: true } : undefined;
}

/**
 * What the server has right after this device saved its own settings there. A screen that kept the answer from before
 * would offer or name the wrong key (found 13 Nov 2026 in Android's two-device test).
 */
export function ownLook(config: AiConfig): KeyLook | undefined {
  if (!config.synced) return undefined;
  try { return { remote: { status: "found", updatedAt: config.synced, config: sharedKey(config) }, vaultId: config.syncedVault }; } catch { return undefined; }
}

const followed = (shared: SharedKey, includeShared: boolean, synced: number, syncedVault: string): AiConfig => aiSettings({ ...shared, includeShared, synced, syncedVault });

export class AiKeyCloud {
  constructor(private store: AiSettingsStore, private connection: () => KeyClient | undefined) {}

  /** The workspace of the own account, or undefined when this device is not signed in to JotDrop Cloud. */
  get vaultId(): string | undefined { return this.connection()?.credentials.vaultId; }

  private client(): KeyClient {
    const client = this.connection();
    if (!client) throw new KeyRefused("Sign in to JotDrop Cloud on this device to use this.", "cloud");
    return client;
  }

  /**
   * Looks at what the server has and follows it: a newer shared key for the same service replaces the copy here, a
   * removed one takes it away and turns Ask JotDrop off. Undefined when not signed in, or signed in to another account meanwhile.
   */
  async look(): Promise<{ look: KeyLook; settings: AiConfig; changed?: "replaced" | "removed" } | undefined> {
    const client = this.connection();
    if (!client) return undefined;
    const remote = await readSharedKey(client);
    if (this.connection() !== client) return undefined;
    const look = { remote, vaultId: client.credentials.vaultId };
    if (remote.status !== "unavailable") await this.store.markChecked(look.vaultId).catch(() => {});
    const settings = await this.store.load();
    const action = keyAction(settings, look);
    if (action === "update" && remote.status === "found" && remote.config && sameService(remote.config, settings)) {
      const next = followed(remote.config, settings.includeShared, remote.updatedAt, look.vaultId);
      await this.store.save(next);
      return { look, settings: next, changed: "replaced" };
    }
    if (action === "remove") {
      await this.store.remove();
      return { look, settings: { ...AI_OFF }, changed: "removed" };
    }
    return { look, settings };
  }

  /** Once a day, after an ordinary sync, and only on a device that follows a shared key. Returns what to say, or "". */
  async daily(): Promise<string> {
    const vaultId = this.vaultId;
    if (!vaultId || !follows(await this.store.load(), vaultId)) return "";
    const since = Date.now() - await this.store.checkedAt(vaultId);
    if (since >= 0 && since < DAY_MS) return "";
    const found = await this.look();
    return found?.changed === "replaced" ? KEY_REPLACED : found?.changed === "removed" ? KEY_REMOVED : "";
  }

  /** One tap: this device keeps its own sealed copy of the shared key and follows it from now on. A fresh look, so it is the key of this moment. */
  async use(): Promise<AiConfig> {
    const client = this.client();
    const remote = await readSharedKey(client);
    if (remote.status === "plus") throw new KeyRefused(PLUS_TEXT, "plus", remote);
    if (remote.status === "unavailable") throw new KeyRefused(UNREACHABLE, "unreachable", remote);
    if (remote.status !== "found" || !remote.config || !isProvider(remote.config.provider)) throw new KeyRefused("That key is no longer there.", "gone", remote);
    const next = followed(remote.config, (await this.store.load()).includeShared, remote.updatedAt, client.credentials.vaultId);
    await this.store.save(next);
    return next;
  }

  /**
   * The switch on: the key of this device goes to the other devices. When they already share another key it is never
   * replaced without a word: KeyRefused "other", with the answer, so the screen can ask.
   */
  async turnOn(settings: AiConfig): Promise<AiConfig> {
    const client = this.client();
    try { sharedKey(settings); } catch (error) { throw new KeyRefused((error as Error).message, "share"); }
    const remote = await readSharedKey(client);
    if (remote.status === "plus") throw new KeyRefused(PLUS_TEXT, "plus", remote);
    if (remote.status === "unavailable") throw new KeyRefused(UNREACHABLE, "unreachable", remote);
    // A blob this version cannot open may come from a newer app: never write over it.
    if (remote.status === "found" && !remote.config) throw new KeyRefused("Your other devices share a key that this version of JotDrop cannot open. Update JotDrop here or on your other devices, and try again.", "unopened", remote);
    if (remote.status === "found" && remote.config && (remote.config.provider !== settings.provider || remote.config.key !== settings.key)) throw new KeyRefused("Your other devices already share a key.", "other", remote);
    const next = { ...settings, synced: await saveSharedKey(client, settings).catch((error) => { throw refusal(error); }), syncedVault: client.credentials.vaultId };
    await this.store.save(next);
    return next;
  }

  /** The switch off: JotDrop removes its sealed copy; this device keeps its key, the devices that followed it lose theirs. */
  async turnOff(settings: AiConfig): Promise<AiConfig> {
    await removeSharedKey(this.client()).catch((error) => { throw refusal(error); });
    const next = { ...settings, synced: 0, syncedVault: "" };
    await this.store.save(next);
    return next;
  }

  /**
   * After Save on a device that follows the shared key: the other devices get the new settings, or, when there is
   * nothing to share (Off, a local model, an address on this device), this device lets go and they keep theirs.
   * Returns the settings kept now, what to say, and what the server has after this when that is known.
   */
  async shareSaved(settings: AiConfig): Promise<{ settings: AiConfig; said: string; look?: KeyLook }> {
    const client = this.client();
    try { sharedKey(settings); } catch (error) {
      const next = { ...settings, synced: 0, syncedVault: "" };
      await this.store.save(next);
      const letGo = "This device no longer follows the key of your other devices. They keep it.";
      return { settings: next, said: settings.provider ? `${(error as Error).message} ${letGo}` : letGo };
    }
    try {
      const next = { ...settings, synced: await saveSharedKey(client, settings), syncedVault: client.credentials.vaultId };
      await this.store.save(next);
      return { settings: next, said: "Your other devices get the same key.", look: ownLook(next) };
    } catch (error) {
      // The server did not take the new key: never act as if it had (it still has the earlier one, or says Plus).
      const refused = refusal(error);
      return { settings, said: `Your other devices keep the earlier key: ${refused.message}`, look: refused.reason === "plus" ? { remote: { status: "plus" }, vaultId: client.credentials.vaultId } : undefined };
    }
  }

  /** "On all my devices": first the sealed copy on the server; if that fails, nothing is removed and the user can try again. */
  async removeEverywhere(): Promise<void> {
    await removeSharedKey(this.client()).catch((error) => { throw refusal(error); });
    await this.store.remove();
  }
}

/**
 * "Keep both" of Find duplicates: the pairs the user said to leave alone, by vault path (pairKey). On this device only:
 * one sealed value in a store of its own, never in data.json and never synced. A renamed note forgets its pair.
 */
export class DuplicatesKept {
  private store: KeyValues;
  constructor(app: App, store?: KeyValues) {
    const id = (app as unknown as { appId?: string }).appId || app.vault.getName();
    this.store = store ?? new CloudStore(`jotdrop-duplicates-${id}`);
  }
  async load(): Promise<string[]> {
    try {
      const saved = await this.store.get<Sealed>("kept");
      const list = saved ? await unseal<unknown>(saved) : [];
      return Array.isArray(list) ? list.filter((key): key is string => typeof key === "string") : [];
    } catch {
      return [];
    }
  }
  async save(keys: string[]): Promise<void> { await this.store.put("kept", await seal([...new Set(keys)])); }
}

/** A note as the shared assistant reads it; id is the vault path. */
export type AiNote = { id: string; title: string; text: string; labels: string[]; updatedAt: string; shared: boolean; reminder?: string; expires?: string };

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
    const meta = readMeta(app, file);
    notes.push({
      id: file.path,
      title: aiTitle(text, file.basename),
      text: splitNote(text).body,
      labels: meta.labels,
      updatedAt: new Date(file.stat.mtime).toISOString(),
      // The week overview reads these two (cloud/shared/ai/digest.mjs).
      reminder: meta.reminder ?? "",
      expires: meta.expires ?? "",
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

// Version 2 (Hand-off/ontwerp-ask-jotdrop-v2.md, phase 4): the photos, PDFs and recordings a note links to, which
// can go along to the AI service when the user ticks them. Nothing here goes out by itself.

/** A file of a note that can go along: id and vaultPath are its place in the vault, bytes its size on this device. */
export type AiFile = { id: string; name: string; kind: AiFileKind; mime: string; bytes: number; vaultPath: string };

/** The fixed actions on a card, with the kinds of file each one takes. */
export const FILE_ACTIONS = { transcribe: ["audio"], photo: ["image"], receipt: ["image", "pdf"] } as const;
export type FileAction = keyof typeof FILE_ACTIONS;

// Both link forms, like the web app: ![[name]] (with a size or a page after | or #) and [Voice memo](../attachments/…),
// the way the web app links a recording. An embed with ![](…) is the second form with a "!".
const FILE_LINK_RE = /!\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]|!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** The names of the files a note's text links to that can go along, once each, in the note's own order. */
export function aiFileNames(text: string): string[] {
  const names: string[] = [];
  for (const match of splitNote(text).body.matchAll(FILE_LINK_RE)) {
    const target = (match[1] ?? match[2] ?? "").trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // a web address is not a file of this note
    let name = (target.split("/").pop() ?? "").split("?")[0].split("#")[0].trim();
    try { name = decodeURIComponent(name); } catch { /* a name with a lone % stays as typed */ }
    if (name && aiFileKind(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The kinds of file a note links to, from its text only: enough to choose the card's menu items. */
export function aiFileKinds(text: string): Set<AiFileKind> {
  return new Set(aiFileNames(text).map((name) => aiFileKind(name)?.kind).filter((kind): kind is AiFileKind => Boolean(kind)));
}

/**
 * The files of a note that are on this device, as the card finds them (plugin.resolveAssetCandidates: the hidden
 * .attachments folder has no TFile, so the adapter answers). A link to a file that is not here is left out.
 */
export async function collectAiFiles(plugin: JotDropPlugin, note: TFile, text: string): Promise<AiFile[]> {
  const adapter = plugin.app.vault.adapter;
  const found: AiFile[] = [];
  for (const name of aiFileNames(text)) {
    const type = aiFileKind(name);
    if (!type) continue;
    for (const candidate of plugin.resolveAssetCandidates(note, name)) {
      if (candidate.file?.extension === "md") continue;
      const stat = candidate.file ? candidate.file.stat : await adapter.stat(candidate.vaultPath).catch(() => null);
      if (!stat || ("type" in stat && stat.type !== "file")) continue;
      if (!found.some((file) => file.vaultPath === candidate.vaultPath)) found.push({ id: candidate.vaultPath, name, ...type, bytes: stat.size, vaultPath: candidate.vaultPath });
      break;
    }
  }
  return found;
}

/**
 * A photo as a JPEG of at most 2048 pixels on its long side: small, one type, the same on every service. Obsidian
 * runs in a browser engine on desktop and mobile, so a canvas does it, as in the web app.
 */
export async function photoJpeg(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime })); } catch { throw new Error("This photo cannot be read on this device."); }
  const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This photo cannot be read on this device.");
  // JPEG has no transparency: a see-through PNG gets a white background, not a black one.
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.5]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size <= LIMITS.image) return new Uint8Array(await blob.arrayBuffer());
  }
  throw new Error("This photo stays too large, even made smaller.");
}

/**
 * A file as a part for the shared core, read from the vault on this device. A photo is made small first (shrink is
 * photoJpeg; the check passes its own). The size is checked before reading, so a large file is never read for nothing.
 */
export async function readAiPart(plugin: JotDropPlugin, file: AiFile, shrink: (bytes: Uint8Array, mime: string) => Promise<Uint8Array> = photoJpeg): Promise<AiPart> {
  if (file.kind !== "image" && file.bytes > LIMITS[file.kind]) throw new Error(`${file.name} is larger than ${Math.round(LIMITS[file.kind] / 1048576)} MiB.`);
  const bytes = new Uint8Array(await plugin.app.vault.adapter.readBinary(file.vaultPath));
  if (file.kind !== "image") return { kind: file.kind, mime: file.mime, name: file.name, data: plainBase64(bytesToBase64(bytes)) };
  const photo = await shrink(bytes, file.mime);
  return { kind: "image", mime: "image/jpeg", name: file.name.replace(/\.[^.]+$/, ".jpg"), data: plainBase64(bytesToBase64(photo)) };
}

/**
 * "Receipt to Paper drawer": after Apply, in one go and with the same code as the tools, the new title (empty keeps
 * the old), the lines below the note (as append_to_note), then the expiry date with its drawer and warning (as
 * set_expiry). before is the text the AI saw: a note changed meanwhile is left alone. Throws on a bad date.
 */
export async function applyReceipt(plugin: JotDropPlugin, path: string, before: string, fields: { title: string; lines: string; expires: string; drawer: string }): Promise<void> {
  const { app } = plugin;
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error("This note is gone.");
  if (await app.vault.read(file) !== before) throw new Error("This note changed while Ask JotDrop worked, so it was left as it is.");
  if (plugin.cloud?.spaceOf(file.path)) throw new Error("Expiry dates are personal, and this note belongs to a shared group, so it was left as it is.");
  const title = fields.title.replace(/[\r\n]+/g, " ").trim();
  const lines = fields.lines.trim();
  // The date first: a bad one changes nothing.
  expiryChanges(before, fields.expires, fields.drawer || undefined);
  if (title || lines) {
    await app.vault.process(file, (text) => {
      const named = title ? joinNote({ ...splitNote(text), title }) : text;
      return lines ? appendedText(named, { text: lines }) : named;
    });
  }
  const changes = expiryChanges(await app.vault.read(file), fields.expires, fields.drawer || undefined);
  await updateMeta(app, file, {
    expires: changes.expires,
    labels: changes.jotdrop_labels,
    ...(changes.reminder ? { reminder: changes.reminder, reminderRepeat: null, reminderUntil: null, reminderLimit: null } : {}),
  });
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

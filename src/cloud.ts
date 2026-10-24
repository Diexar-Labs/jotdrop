import { FileSystemAdapter, Modal, Notice, Platform, Setting, TFile, normalizePath, requestUrl } from "obsidian";
import type JotDropPlugin from "./main";
import { ConfirmModal } from "./confirmModal";
import { CloudClient } from "../cloud/shared/client.mjs";
import { confirmLogin, confirmSignup, logIn, signUp } from "../cloud/shared/account.mjs";
import { base64ToBytes, decryptEnvelope, MAX_FILE_BYTES, objectId } from "../cloud/shared/crypto.mjs";
import { copyName, hash, isPreserved, MAX_SYNC_BYTES, MAX_SYNC_FILES, remoteFiles, syncFolder, syncPath } from "../cloud/shared/sync.mjs";

export const DEFAULT_CLOUD_SERVER = "https://api.jotdrop.net";
const SYNCTHING = [".stfolder", ".stignore", ".stversions"];
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type Base = { revision: number; hash: string; deleted: boolean };
type Prepared = { id: string; baseRevision: number; envelope: string };
type RemoteIndex = { cursor: number; objects: Record<string, { path: string; revision: number; deleted: boolean; hash: string }> };
type SyncState = {
  vaultId: string; enabled: boolean; binding: string; tracked: Record<string, Base>; index: RemoteIndex;
  upload?: Prepared; lastSynced?: string; message: string; conflicts: number;
};
type Session = { credentials: CloudClient["credentials"]; email: string };
type Sealed = { key: CryptoKey; iv: Uint8Array; data: ArrayBuffer };

/** fetch() on top of Obsidian's requestUrl: no CORS, so the same code works on desktop and mobile. */
async function cloudFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const signal = init.signal ?? undefined;
  signal?.throwIfAborted();
  const headers = { ...(init.headers as Record<string, string> | undefined) };
  const raw = init.body;
  const body = raw instanceof Uint8Array ? new Uint8Array(raw).buffer : raw as string | ArrayBuffer | undefined;
  const pending = requestUrl({ url, method: init.method || "GET", headers, contentType: headers["Content-Type"], body, throw: false });
  let response;
  try {
    response = await (signal ? Promise.race([pending, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]) : pending);
  } catch (error) {
    if (signal?.aborted) throw error;
    // fetch reports an unreachable server as a TypeError; the upload code retries on that.
    throw new TypeError(error instanceof Error ? error.message : "Network request failed");
  }
  return new Response(response.status === 204 ? null : response.arrayBuffer, { status: response.status, headers: response.headers });
}

/** Per device and per vault, outside data.json: that file lives in the vault and can travel to other devices. */
type KeyValues = { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> };
class CloudStore implements KeyValues {
  private db: Promise<IDBDatabase>;
  constructor(name: string) {
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("values");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Local storage for JotDrop Cloud is unavailable."));
    });
  }
  private async run<T>(mode: IDBTransactionMode, action: (values: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("values", mode);
      const request = action(transaction.objectStore("values"));
      transaction.oncomplete = () => resolve(request.result as T);
      transaction.onerror = transaction.onabort = () => reject(new Error("Could not save JotDrop Cloud data on this device."));
    });
  }
  get<T>(key: string): Promise<T | undefined> { return this.run("readonly", (values) => values.get(key)); }
  put(key: string, value: unknown): Promise<void> { return this.run("readwrite", (values) => values.put(value, key)); }
  delete(key: string): Promise<void> { return this.run("readwrite", (values) => values.delete(key)); }
}

// Signed in until Log out, like Keep: the connection is sealed with a key this device keeps but cannot export.
async function seal(value: Session): Promise<Sealed> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { key, iv, data: await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(value))) };
}
async function unseal(saved: Sealed): Promise<Session> {
  return JSON.parse(decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(saved.iv) }, saved.key, saved.data)));
}

const deviceName = () => `Obsidian on ${Platform.isWin ? "Windows" : Platform.isMacOS ? "Mac" : Platform.isLinux ? "Linux" : Platform.isAndroidApp ? "Android" : Platform.isIosApp ? "iPhone or iPad" : "this device"}`;
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);

/** The JotDrop folders as the cloud sees them: `notes/` (with Archive and Trash) and `attachments/`, like Android. */
class VaultFolder {
  readonly notes: string;
  readonly assets: string;
  readonly legacy: string;
  readonly binding: string;

  constructor(private plugin: JotDropPlugin, private editing: Set<string>) {
    const { settings } = plugin;
    this.notes = normalizePath(settings.notesFolder).replace(/\/+$/, "");
    this.assets = plugin.resolveAssetsFolder().replace(/\/+$/, "");
    this.legacy = `${this.notes}/.attachments`;
    this.binding = [this.notes, this.assets].join("\n");
    if (!this.notes || this.notes === "/") throw new Error("Choose a notes folder before turning on cloud sync.");
    if (normalizePath(settings.archiveFolder) !== `${this.notes}/Archive`) throw new Error(`Cloud sync keeps archived notes in ${this.notes}/Archive, like the website and Android. Set the archive folder to that first.`);
    if (this.assets === this.notes || this.notes.startsWith(`${this.assets}/`) || this.assets === `${this.notes}/Archive` || this.assets === `${this.notes}/Trash`) throw new Error("The notes and attachments folders overlap. Choose separate folders.");
    if (this.assets !== this.legacy && this.assets.startsWith(`${this.notes}/`)) throw new Error("Keep a custom attachments folder outside the notes folder.");
  }

  private get adapter() { return this.plugin.app.vault.adapter; }

  /** Two sync systems on the same files make duplicates or lose changes, so the cloud refuses to start. */
  async guard(): Promise<void> {
    const app = this.plugin.app as unknown as { internalPlugins?: { plugins?: Record<string, { enabled?: boolean; instance?: { vaultId?: string | null } }> } };
    // The Sync core plugin is on by default; only a connected remote vault means Obsidian Sync is in use.
    const sync = app.internalPlugins?.plugins?.sync;
    if (sync?.enabled && sync.instance?.vaultId) throw new Error("Obsidian Sync is on for this vault. Use either Obsidian Sync or JotDrop Cloud, not both: two sync systems on the same notes make duplicates. Turn one of them off.");
    const folders = new Set([""]);
    for (const path of [this.notes, this.assets, this.legacy]) {
      let parent = "";
      for (const part of path.split("/")) { parent = parent ? `${parent}/${part}` : part; folders.add(parent); }
    }
    for (const folder of folders) {
      for (const marker of SYNCTHING) {
        if (await this.adapter.exists(folder ? `${folder}/${marker}` : marker)) throw syncthing();
      }
    }
    // Desktop: a Syncthing folder can also start above the vault.
    if (this.adapter instanceof FileSystemAdapter) {
      const fs = (window as unknown as { require: (name: string) => typeof import("fs") }).require("fs");
      const path = (window as unknown as { require: (name: string) => typeof import("path") }).require("path");
      for (let dir = this.adapter.getBasePath(); ; dir = path.dirname(dir)) {
        if (SYNCTHING.some((marker) => fs.existsSync(path.join(dir, marker)))) throw syncthing();
        if (path.dirname(dir) === dir) break;
      }
    }
  }

  local(path: string): string {
    syncPath(path, true);
    return path.startsWith("notes/") ? `${this.notes}/${path.slice(6)}` : `${this.assets}/${path.slice(12)}`;
  }

  private candidates(path: string): string[] {
    const mapped = this.local(path);
    return path.startsWith("attachments/") ? [...new Set([mapped, `${this.legacy}/${path.slice(12)}`])] : [mapped];
  }

  private async read(path: string): Promise<Uint8Array> {
    const stat = await this.adapter.stat(path);
    if (!stat || stat.type !== "file") throw new Error("Expected a local file. No deletions were inferred.");
    if (stat.size > MAX_FILE_BYTES) throw new Error(`${path} is larger than the 4 MiB cloud limit.`);
    return new Uint8Array(await this.adapter.readBinary(path));
  }

  async list(): Promise<Map<string, Uint8Array>> {
    await this.guard();
    const result = new Map<string, Uint8Array>();
    let total = 0;
    const walk = async (folder: string, prefix: string, attachments: boolean, depth = 0): Promise<void> => {
      if (depth > 16) throw new Error("Cloud folder nesting exceeds the sync limit.");
      const listing = await this.adapter.list(folder);
      for (const child of listing.folders) {
        const name = child.split("/").pop() || "";
        if (SYNCTHING.includes(name.toLowerCase())) throw syncthing();
        if (!name.startsWith(".")) await walk(child, `${prefix}/${name}`, attachments, depth + 1);
      }
      for (const file of listing.files) {
        const name = file.split("/").pop() || "";
        if (SYNCTHING.includes(name.toLowerCase())) throw syncthing();
        if (name.startsWith(".") || isPreserved(name) || (!attachments && !/\.md$/i.test(name))) continue;
        const path = syncPath(`${prefix}/${name}`);
        const bytes = await this.read(file);
        const old = result.get(path);
        if (old) { if (!sameBytes(old, bytes)) throw new Error("The legacy and configured attachments folders hold different files with the same name. Resolve them before syncing."); continue; }
        total += bytes.length;
        if (total > MAX_SYNC_BYTES || result.size >= MAX_SYNC_FILES) throw new Error(`Cloud sync supports up to ${MAX_SYNC_FILES} files and 64 MiB for now.`);
        result.set(path, bytes);
      }
    };
    if (await this.adapter.exists(this.notes)) await walk(this.notes, "notes", false);
    for (const folder of new Set([this.assets, this.legacy])) if (await this.adapter.exists(folder)) await walk(folder, "attachments", true);
    return result;
  }

  private async ensureParent(path: string): Promise<void> {
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent && !await this.adapter.exists(parent)) await this.adapter.mkdir(parent);
  }

  private async write(path: string, bytes: Uint8Array, expected: Uint8Array | null): Promise<boolean> {
    const vault = this.plugin.app.vault;
    const file = vault.getAbstractFileByPath(path);
    if (file instanceof TFile && file.extension === "md" && expected) {
      // Compare and replace in one step, so a change typed in Obsidian meanwhile is never overwritten.
      let original: string, replacement: string;
      try { original = decoder.decode(expected); replacement = decoder.decode(bytes); } catch { original = ""; replacement = ""; }
      if (original || replacement) {
        let replaced = false;
        await vault.process(file, (current) => { if (current !== original) return current; replaced = true; return replacement; });
        return replaced;
      }
    }
    const data = bytes.slice().buffer;
    if (file instanceof TFile) await vault.modifyBinary(file, data);
    else if (!expected && !path.split("/").some((part) => part.startsWith("."))) { await this.ensureParent(path); await vault.createBinary(path, data); }
    else { await this.ensureParent(path); await this.adapter.writeBinary(path, data); }
    if (!sameBytes(await this.read(path), bytes)) throw new Error("A local write could not be verified. Your notes were kept.");
    return true;
  }

  async compareAndSet(path: string, expected: Uint8Array | null, replacement: Uint8Array | null): Promise<boolean> {
    await this.guard();
    const files: string[] = [];
    for (const candidate of this.candidates(path)) if (await this.adapter.exists(candidate)) files.push(candidate);
    const actual = files.length ? await this.read(files[0]) : null;
    if ((actual === null) !== (expected === null) || (actual && expected && !sameBytes(actual, expected))) return false;
    for (const file of files) {
      if (this.editing.has(file) || !sameBytes(await this.read(file), expected as Uint8Array)) return false;
    }
    if (!replacement) {
      // Removed notes go to the trash Obsidian is set to use, so they can always come back.
      for (const file of files) {
        const indexed = this.plugin.app.vault.getAbstractFileByPath(file);
        if (indexed instanceof TFile) await this.plugin.app.fileManager.trashFile(indexed);
        else await this.adapter.trashLocal(file);
      }
      return true;
    }
    if (!files.length) {
      const target = this.local(path);
      if (await this.adapter.exists(target)) return false;
      return this.write(target, replacement, null);
    }
    for (const file of files) if (!await this.write(file, replacement, expected)) return false;
    return true;
  }

  private async preserve(path: string, bytes: Uint8Array, suffix: string): Promise<void> {
    let target = this.local(copyName(path, suffix));
    if (await this.adapter.exists(target)) {
      if (sameBytes(await this.read(target), bytes)) return;
      target = this.local(copyName(path, `${suffix}-${crypto.randomUUID()}`));
    }
    await this.write(target, bytes, null);
  }

  async conflict(path: string, revision: number, bytes: Uint8Array): Promise<void> {
    await this.guard();
    await this.preserve(path, bytes, `.cloud-conflict-r${revision}`);
  }

  async recover(path: string, bytes: Uint8Array): Promise<void> {
    await this.preserve(path, bytes, `.cloud-recovery-${(await hash(bytes)).slice(0, 12)}`);
  }
}

const syncthing = () => new Error("Syncthing is syncing this vault. Use either Syncthing or JotDrop Cloud for these notes, not both: two sync systems on the same notes make duplicates.");

/** JotDrop Cloud in Obsidian: the same account, encryption and sync rules as the website and Android. */
export class CloudController {
  status = "Not signed in.";
  email = "";
  private client?: CloudClient;
  private state?: SyncState;
  private store: KeyValues;
  private running?: Promise<void>;
  private again = false;
  private timer?: number;
  private abort?: AbortController;
  private generation = 0;
  private readonly editing = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private ready: Promise<void>;

  constructor(private plugin: JotDropPlugin, store?: KeyValues) {
    const app = plugin.app as unknown as { appId?: string };
    this.store = store ?? new CloudStore(`jotdrop-cloud-${app.appId || plugin.app.vault.getName()}`);
    this.ready = this.restore().catch(() => { this.status = "Could not open the saved cloud connection. Log in again."; });
  }

  get signedIn(): boolean { return !!this.client; }
  get enabled(): boolean { return !!this.state?.enabled; }
  get lastSynced(): string | undefined { return this.state?.lastSynced; }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  // A copy: a listener may re-register itself, and a live Set would then call it forever.
  private changed(): void { for (const listener of [...this.listeners]) listener(); }

  register(): void {
    const plugin = this.plugin;
    plugin.addCommand({ id: "cloud-sync-now", name: "JotDrop Cloud: sync now", callback: () => { void this.syncNow().catch((error) => new Notice(error instanceof Error ? error.message : String(error))); } });
    const touched = (path: string) => {
      if (!this.enabled) return;
      const folder = (value: string) => value.replace(/\/+$/, "");
      const notes = folder(normalizePath(plugin.settings.notesFolder)), assets = folder(plugin.resolveAssetsFolder());
      if ([notes, assets].some((root) => path === root || path.startsWith(`${root}/`))) this.request();
    };
    plugin.registerEvent(plugin.app.vault.on("create", (file) => touched(file.path)));
    plugin.registerEvent(plugin.app.vault.on("modify", (file) => touched(file.path)));
    plugin.registerEvent(plugin.app.vault.on("delete", (file) => touched(file.path)));
    plugin.registerEvent(plugin.app.vault.on("rename", (file, old) => { touched(file.path); touched(old); }));
    plugin.registerInterval(window.setInterval(() => this.request(0), 60_000));
    plugin.registerDomEvent(window, "focus", () => this.request(0));
    plugin.app.workspace.onLayoutReady(() => { void this.ready.then(() => this.request(0)); });
  }

  private async restore(): Promise<void> {
    const saved = await this.store.get<Sealed>("session");
    if (!saved) return;
    const session = await unseal(saved);
    this.client = new CloudClient({ ...session.credentials, fetcher: cloudFetch });
    this.email = session.email;
    this.state = await this.store.get<SyncState>("state");
    if (this.state?.vaultId !== this.client.credentials.vaultId) this.state = undefined;
    this.status = this.state?.message || "Signed in. Cloud sync is off.";
    this.changed();
  }

  /** Called by the sign-in window with a connected device. */
  async finishSignIn(client: CloudClient, email: string): Promise<void> {
    await this.ready;
    await this.stop();
    this.client = new CloudClient({ ...client.credentials, fetcher: cloudFetch });
    this.email = email;
    await this.store.put("session", await seal({ credentials: this.client.credentials, email }));
    const old = await this.store.get<SyncState>("state");
    // Same cloud as before: keep its baselines. Another cloud starts fresh.
    this.state = old && old.vaultId === client.credentials.vaultId ? { ...old, enabled: false, message: "Signed in. Cloud sync is off." } : undefined;
    if (this.state) await this.store.put("state", this.state);
    this.status = "Signed in. Turn on cloud sync to sync this vault.";
    this.changed();
  }

  /** Checks the folders before asking the person to confirm. */
  async checkFolders(): Promise<string> {
    const folder = new VaultFolder(this.plugin, this.editing);
    await folder.guard();
    const files = await folder.list();
    return `${[...files.keys()].filter((path) => path.startsWith("notes/")).length} notes in ${folder.notes}`;
  }

  async setEnabled(on: boolean): Promise<void> {
    if (!this.client) throw new Error("Log in first.");
    if (!on) {
      await this.stop();
      if (this.state) { this.state = { ...this.state, enabled: false, message: "Cloud sync is off. Your notes stay on this device." }; await this.store.put("state", this.state); }
      this.status = this.state?.message || "Cloud sync is off.";
      this.changed();
      return;
    }
    const folder = new VaultFolder(this.plugin, this.editing);
    await folder.guard();
    await folder.list();
    const vaultId = this.client.credentials.vaultId;
    let state = this.state;
    if (state && state.binding !== folder.binding) {
      if (state.upload) throw new Error("A change from the previous folders is still waiting to upload. Switch back to those folders and sync once before changing them.");
      // Baselines name cloud paths; for other folders they would make every note look deleted.
      state = undefined;
    }
    this.state = { ...(state ?? { vaultId, tracked: {}, index: { cursor: 0, objects: {} }, conflicts: 0 }), enabled: true, binding: folder.binding, message: "Cloud sync is on." };
    await this.store.put("state", this.state);
    this.status = "Cloud sync is on. Syncing...";
    this.changed();
    this.request(0);
  }

  beginEdit(path: string): void { this.editing.add(path); }
  endEdit(path: string): void { this.editing.delete(path); this.request(); }

  /** Sync soon; changes in quick succession share one sync. */
  request(delay = 2000): void {
    if (!this.client || !this.state?.enabled) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { void this.syncNow().catch(() => {}); }, delay);
  }

  async syncNow(): Promise<void> {
    await this.ready;
    if (!this.client) throw new Error("Log in to JotDrop Cloud first.");
    if (!this.state?.enabled) throw new Error("Turn on cloud sync first.");
    if (this.running) { this.again = true; return this.running; }
    this.running = this.run().finally(() => {
      this.running = undefined;
      if (this.again) { this.again = false; this.request(500); }
    });
    return this.running;
  }

  private async run(): Promise<void> {
    const client = this.client!, generation = this.generation, abort = this.abort = new AbortController();
    const state = this.state!;
    const active = () => { abort.signal.throwIfAborted(); if (this.generation !== generation) throw new Error("Cloud sync stopped. Your notes were kept."); };
    const save = () => this.store.put("state", state);
    this.status = "Syncing...";
    this.changed();
    try {
      const folder = new VaultFolder(this.plugin, this.editing);
      if (folder.binding !== state.binding) throw new Error("The notes or attachments folder changed. Turn cloud sync off and on again for the new folder.");
      await folder.guard();
      const { vaultKey, vaultId } = client.credentials;
      if (state.upload) {
        // An upload cut off by a restart: finish it, or keep it as a copy when the cloud moved on.
        const prepared = state.upload;
        const file = await decryptEnvelope(vaultKey, JSON.parse(prepared.envelope), `jotdrop:object:v1:${vaultId}:${prepared.id}`);
        const path = syncPath(file.path), bytes = base64ToBytes(file.content);
        try {
          const saved = await client.commitWrite(prepared, { resumable: true, signal: abort.signal });
          if ((state.tracked[path]?.revision ?? 0) < saved.revision) state.tracked[path] = { revision: saved.revision, hash: await hash(bytes), deleted: false };
        } catch (error) {
          if ((error as { status?: number }).status !== 409) throw error;
          await folder.recover(path, bytes);
          await client.discardWrite(prepared);
        }
        state.upload = undefined;
        await save();
      }
      const remote = {
        list: () => remoteFiles(client, state.index, active),
        write: async (path: string, bytes: Uint8Array, baseRevision: number) => {
          active();
          const prepared = state.upload = await client.prepareWrite(path, bytes, baseRevision);
          await save();
          const saved = await client.commitWrite(prepared, { resumable: true, signal: abort.signal });
          state.upload = undefined;
          const object = { path, revision: saved.revision, deleted: false, hash: await hash(bytes) };
          state.index.objects[prepared.id] = object;
          return object;
        },
        delete: async (path: string, baseRevision: number) => {
          active();
          const id = await objectId(vaultKey, path);
          const saved = await client.remove(id, baseRevision);
          const object = { path, revision: saved.revision, deleted: true, hash: state.index.objects[id]?.hash ?? "" };
          state.index.objects[id] = object;
          return object;
        },
      };
      const report = await syncFolder(remote, folder, state.tracked, (next: Record<string, Base>) => this.store.put("state", { ...state, tracked: next }), active);
      state.lastSynced = new Date().toISOString();
      state.conflicts = report.conflicts;
      state.message = report.conflicts
        ? `${report.conflicts} ${report.conflicts === 1 ? "note was" : "notes were"} changed in two places. Both versions are kept: compare the ".cloud-conflict" copy with the original.`
        : `Synced. ${report.uploaded} up, ${report.downloaded} down, ${report.deleted} removed.`;
      await save();
      this.status = state.message;
    } catch (error) {
      if (this.generation !== generation) return;
      const status = (error as { status?: number }).status;
      state.message = status === 401 ? "This device no longer has access. Your notes were kept. Log out and log in again."
        : error instanceof TypeError ? "The cloud is unreachable. Your changes stay on this device and sync later."
        : error instanceof Error ? error.message : "Cloud sync failed. Your notes were kept.";
      if (status === 401) state.enabled = false;
      await save().catch(() => {});
      this.status = state.message;
      throw error;
    } finally {
      if (this.abort === abort) this.abort = undefined;
      this.changed();
      this.plugin.refreshViews();
    }
  }

  private async stop(): Promise<void> {
    window.clearTimeout(this.timer);
    this.generation++;
    this.abort?.abort();
    await this.running?.catch(() => {});
  }

  /** Forget this device's keys; the notes stay in the vault and in the cloud. */
  async logOut(): Promise<void> {
    await this.ready;
    if (this.state?.upload) throw new Error("A change is still waiting to upload. Sync first, then log out.");
    await this.stop();
    const client = this.client;
    this.client = undefined;
    this.email = "";
    this.state = undefined;
    await this.store.delete("session");
    await this.store.delete("state");
    // Give the device slot back, like the website; the server keeps the last active device.
    if (client) void client.revokeDevice(client.credentials.deviceId).catch(() => {});
    this.status = "Logged out. Your notes stay in this vault and in the cloud.";
    this.changed();
  }

  /** Plugin unload: stop syncing, keep the session for next time. */
  lock(): void {
    window.clearTimeout(this.timer);
    this.generation++;
    this.abort?.abort();
  }

  showSignIn(signup = false): void { new CloudSignInModal(this.plugin, this, signup).open(); }

  /** `onDone` runs when the question closes either way, so the settings toggle shows the real state. */
  confirmEnable(onDone: () => void): void {
    const fail = (error: unknown) => { new Notice(error instanceof Error ? error.message : String(error), 10000); onDone(); };
    void this.checkFolders().then((found) => {
      const modal = new ConfirmModal(this.plugin.app, {
        title: "Turn on cloud sync for this vault?",
        message: `${found}. Notes and attachments sync with your JotDrop Cloud, end-to-end encrypted. Changes from your other devices can update and remove notes here; removed notes go to the trash. Do not use Syncthing or Obsidian Sync on these folders at the same time.`,
        confirmLabel: "Turn on cloud sync",
      }, () => { void this.setEnabled(true).catch(fail); });
      const close = modal.onClose.bind(modal);
      modal.onClose = () => { close(); onDone(); };
      modal.open();
    }, fail);
  }
}

type Pending = Awaited<ReturnType<typeof logIn>> & { secondFactor?: string };

/** Log in or create an account, with the email code, the free device limit and the recovery code. */
class CloudSignInModal extends Modal {
  private message!: HTMLElement;

  constructor(private plugin: JotDropPlugin, private cloud: CloudController, private signup: boolean) { super(plugin.app); }

  onOpen(): void { this.form(); }
  onClose(): void { this.contentEl.empty(); }

  private start(title: string): HTMLElement {
    this.contentEl.empty();
    this.titleEl.setText(title);
    return this.contentEl;
  }

  private status(text: string): void { this.message.setText(text); }

  private async busy(button: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
    button.disabled = true;
    this.status("Working securely on this device...");
    try { await action(); }
    catch (error) { this.status(error instanceof Error ? error.message : "Something went wrong. Try again."); }
    finally { button.disabled = false; }
  }

  private form(): void {
    const el = this.start(this.signup ? "Create a JotDrop Cloud account" : "Log in to JotDrop Cloud");
    el.createEl("p", { text: this.signup ? "Your notes are encrypted on this device with a key made from your password. The server never sees your password or your notes." : "Use the same email and password as on the website and in the Android app." });
    let email = "", password = "", confirm = "";
    new Setting(el).setName("Email").addText((input) => { input.inputEl.type = "email"; input.inputEl.autocomplete = "email"; input.onChange((value) => { email = value.trim(); }); });
    new Setting(el).setName("Password").setDesc(this.signup ? "At least 12 characters." : "").addText((input) => {
      input.inputEl.type = "password"; input.inputEl.autocomplete = this.signup ? "new-password" : "current-password"; input.onChange((value) => { password = value; });
    });
    if (this.signup) new Setting(el).setName("Repeat password").addText((input) => { input.inputEl.type = "password"; input.inputEl.autocomplete = "new-password"; input.onChange((value) => { confirm = value; }); });
    this.message = el.createEl("p", { attr: { role: "status" } });
    const url = this.plugin.settings.cloudServer || DEFAULT_CLOUD_SERVER;
    new Setting(el)
      .addButton((button) => button.setButtonText(this.signup ? "I have an account" : "Create an account").onClick(() => { this.signup = !this.signup; this.form(); }))
      .addButton((button) => button.setButtonText(this.signup ? "Create account" : "Log in").setCta().onClick(() => this.busy(button.buttonEl, async () => {
        if (this.signup && password !== confirm) throw new Error("The passwords do not match.");
        const pending = this.signup
          ? await signUp({ url, email, password, deviceName: deviceName(), fetcher: cloudFetch })
          : await logIn({ url, email, password, deviceName: deviceName(), fetcher: cloudFetch });
        this.code(pending as Pending, email);
      })));
  }

  private code(pending: Pending, email: string): void {
    const el = this.start("Enter your code");
    el.createEl("p", { text: pending.secondFactor === "totp" ? "Enter the 6-digit code from your authenticator app." : `Enter the 6-digit code we emailed to ${email}.` });
    let code = "";
    new Setting(el).setName("Code").addText((input) => { input.inputEl.inputMode = "numeric"; input.inputEl.autocomplete = "one-time-code"; input.onChange((value) => { code = value.trim(); }); });
    this.message = el.createEl("p", { attr: { role: "status" } });
    const choices = el.createDiv();
    new Setting(el).addButton((button) => button.setButtonText("Continue").setCta().onClick(() => this.busy(button.buttonEl, async () => {
      if (this.signup) {
        const { client, recoveryCode } = await confirmSignup(pending, code, { fetcher: cloudFetch });
        if (!client || !recoveryCode) throw new Error("The server did not finish creating the account. Try again.");
        await this.cloud.finishSignIn(client, email);
        this.recovery(recoveryCode);
        return;
      }
      // At the free device limit this device takes the place of one the person no longer uses.
      const connect = async (replaceDeviceId?: string) => {
        await this.cloud.finishSignIn(await confirmLogin(pending, code, { fetcher: cloudFetch, replaceDeviceId }), email);
        this.done();
      };
      try { await connect(); }
      catch (error) {
        const limit = error as { code?: string; message?: string; devices?: Array<{ id: string; name: string; lastSeenAt: string }> };
        if (limit.code !== "device-limit" || !limit.devices) throw error;
        choices.empty();
        choices.createEl("p", { text: `${limit.message} Choose the device this one replaces:` });
        for (const device of limit.devices) {
          new Setting(choices).setName(device.name).setDesc(`Last used ${new Date(device.lastSeenAt).toLocaleDateString()}`)
            .addButton((choice) => choice.setButtonText("Sign out that device").onClick(() => this.busy(choice.buttonEl, () => connect(device.id))));
        }
        this.status("");
      }
    })));
  }

  private recovery(recoveryCode: string): void {
    const el = this.start("Save your recovery code");
    el.createEl("p", { text: "If you forget your password, this code is the only way back into your notes. Store it in a password manager. Nobody, including JotDrop, can recover your notes without it." });
    const box = el.createEl("textarea", { cls: "jotdrop-recovery-code", attr: { readonly: "", rows: "4", "aria-label": "Recovery code" } });
    box.value = recoveryCode;
    let saved = false;
    let finish: HTMLButtonElement;
    new Setting(el).addButton((button) => button.setButtonText("Copy").onClick(async () => { await navigator.clipboard.writeText(recoveryCode); new Notice("Recovery code copied."); }));
    new Setting(el).setName("I saved my recovery code").addToggle((toggle) => toggle.onChange((value) => { saved = value; finish.disabled = !saved; }));
    new Setting(el).addButton((button) => { finish = button.buttonEl; button.setButtonText("Done").setCta().setDisabled(true).onClick(() => this.done()); });
  }

  private done(): void {
    this.close();
    new Notice("Signed in to JotDrop Cloud.");
  }
}

import { FileSystemAdapter, Modal, Notice, Platform, Setting, TFile, normalizePath, requestUrl } from "obsidian";
import type JotDropPlugin from "./main";
import { ConfirmModal } from "./confirmModal";
import { CloudClient } from "../cloud/shared/client.mjs";
import { availableProviders, checkApproval, completeApproval, confirmLogin, confirmSignup, logIn, providerApproval, providerRecover, providerSignUp, providerTicket, requestApproval, resetWithRecoveryCode, signUp, startOver, startProviderSignIn, startReset } from "../cloud/shared/account.mjs";
import { AuthenticatorModal, RecoveryCodeModal } from "./cloudAccount";
import { ConflictReviewModal, TimeMachineModal } from "./cloudReview";
import { base64ToBytes, decryptEnvelope, MAX_FILE_BYTES, objectId } from "../cloud/shared/crypto.mjs";
import { cloudTimeline, conflictOriginal, copyName, hash, isPreserved, remoteFiles, restorePlan, syncFolder, syncPath, unavailable } from "../cloud/shared/sync.mjs";

export const DEFAULT_CLOUD_SERVER = "https://app.jotdrop.net";
const PROVIDER_NAMES: Record<string, string> = { google: "Google", github: "GitHub" };
// The providers' own marks: Google's four-colour G and GitHub's Octocat.
const PROVIDER_LOGOS: Record<string, { viewBox: string; paths: Array<[string, string]> }> = {
  google: { viewBox: "0 0 48 48", paths: [
    ["#EA4335", "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"],
    ["#4285F4", "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"],
    ["#FBBC05", "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"],
    ["#34A853", "M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"],
  ] },
  github: { viewBox: "0 0 16 16", paths: [
    ["currentColor", "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"],
  ] },
};
const providerLogo = (name: string): SVGSVGElement => {
  const logo = PROVIDER_LOGOS[name];
  const svg = createSvg("svg", { cls: "jotdrop-provider-logo", attr: { viewBox: logo.viewBox, "aria-hidden": "true" } });
  for (const [fill, d] of logo.paths) svg.createSvg("path", { attr: { fill, d } });
  return svg;
};
/** The privacy policy lives on the cloud server itself. */
export const privacyLink = (el: HTMLElement, server: string): HTMLAnchorElement => el.createEl("a", { text: "Privacy policy", href: `${server.replace(/\/+$/, "")}/privacy` });
const SYNCTHING = [".stfolder", ".stignore", ".stversions"];
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type Base = { revision: number; hash: string; deleted: boolean };
type Prepared = { id: string; baseRevision: number; envelope: string };
type RemoteIndex = { cursor: number; objects: Record<string, { path: string; revision: number; deleted: boolean; hash: string }>; pending?: Record<string, number> };
type SyncState = {
  vaultId: string; enabled: boolean; binding: string; tracked: Record<string, Base>; index: RemoteIndex;
  seen?: Record<string, { size: number; modified: number; hash: string }>; upload?: Prepared; lastSynced?: string; message: string; conflicts: number;
};
type Session = { credentials: CloudClient["credentials"]; email: string };
type ProviderSignIn = Awaited<ReturnType<typeof providerTicket>> & { provider: string; email: string; account: boolean };
type MomentFile = { id: string; revision: number | null; deleted: boolean; locked: boolean; cleared: boolean };
export type CloudVersion = { revision: number; deleted: boolean; updatedAt: string; locked: boolean };
export type CloudMoment ={ at: string; then: MomentFile[]; files: Array<{ path: string; bytes: Uint8Array }>; trashed: number; locked: number; cleared: number };
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

  private async readFile(path: string): Promise<Uint8Array> {
    const stat = await this.adapter.stat(path);
    if (!stat || stat.type !== "file") throw new Error("Expected a local file. No deletions were inferred.");
    if (stat.size > MAX_FILE_BYTES) throw new Error(`${path} is larger than the 4 MiB cloud limit.`);
    return new Uint8Array(await this.adapter.readBinary(path));
  }

  /** Size and modification time of each file, without reading it: the sync reads only what changed. */
  async list(): Promise<Map<string, { size: number; modified: number }>> {
    await this.guard();
    const result = new Map<string, { size: number; modified: number; file: string }>();
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
        // Obsidian keeps the size and time of the files it shows; hidden folders like ".attachments" are asked for.
        const indexed = this.plugin.app.vault.getAbstractFileByPath(file);
        const stat = indexed instanceof TFile ? indexed.stat : await this.adapter.stat(file);
        if (!stat) throw new Error("Expected a local file. No deletions were inferred.");
        const old = result.get(path);
        if (old) {
          if (!sameBytes(await this.readFile(old.file), await this.readFile(file))) throw new Error("The legacy and configured attachments folders hold different files with the same name. Resolve them before syncing.");
          continue;
        }
        result.set(path, { size: stat.size, modified: stat.mtime, file });
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
    if (!sameBytes(await this.readFile(path), bytes)) throw new Error("A local write could not be verified. Your notes were kept.");
    return true;
  }

  async compareAndSet(path: string, expected: Uint8Array | null, replacement: Uint8Array | null): Promise<boolean> {
    await this.guard();
    const files: string[] = [];
    for (const candidate of this.candidates(path)) if (await this.adapter.exists(candidate)) files.push(candidate);
    const actual = files.length ? await this.readFile(files[0]) : null;
    if ((actual === null) !== (expected === null) || (actual && expected && !sameBytes(actual, expected))) return false;
    for (const file of files) {
      if (this.editing.has(file) || !sameBytes(await this.readFile(file), expected as Uint8Array)) return false;
    }
    if (!replacement) {
      for (const file of files) await this.trash(file);
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

  // Removed notes go to the trash Obsidian is set to use, so they can always come back.
  private async trash(file: string): Promise<void> {
    const indexed = this.plugin.app.vault.getAbstractFileByPath(file);
    if (indexed instanceof TFile) await this.plugin.app.fileManager.trashFile(indexed);
    else await this.adapter.trashLocal(file);
  }

  /** The cloud path of a file in the JotDrop folders, or null for any other file. */
  cloudPath(path: string): string | null {
    const under = (root: string) => path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
    const attachment = under(this.legacy) ?? under(this.assets);
    const note = under(this.notes);
    try { return attachment !== null ? syncPath(`attachments/${attachment}`) : note !== null ? syncPath(`notes/${note}`) : null; }
    catch { return null; }
  }

  /** The file at a cloud path in this vault, or null. */
  async get(path: string): Promise<Uint8Array | null> {
    for (const candidate of this.candidates(path)) if (await this.adapter.exists(candidate)) return this.readFile(candidate);
    return null;
  }

  /** The file at a cloud path, for the sync. */
  async read(path: string): Promise<Uint8Array> {
    const bytes = await this.get(path);
    if (!bytes) throw new Error("Expected a local file. No deletions were inferred.");
    return bytes;
  }

  /** The ".cloud-conflict" copies in the JotDrop folders, by the cloud path of their original. */
  async conflicts(): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    const walk = async (folder: string, prefix: string, depth = 0): Promise<void> => {
      if (depth > 16) return;
      const listing = await this.adapter.list(folder);
      for (const child of listing.folders) {
        const name = child.split("/").pop() || "";
        if (!name.startsWith(".")) await walk(child, `${prefix}/${name}`, depth + 1);
      }
      for (const file of listing.files) {
        const original = conflictOriginal(`${prefix}/${file.split("/").pop()}`);
        if (original) result.set(original, [...(result.get(original) ?? []), file]);
      }
    };
    if (await this.adapter.exists(this.notes)) await walk(this.notes, "notes");
    for (const folder of new Set([this.assets, this.legacy])) if (await this.adapter.exists(folder)) await walk(folder, "attachments");
    return result;
  }

  async trashConflicts(path: string): Promise<void> {
    for (const copy of (await this.conflicts()).get(path) ?? []) await this.trash(copy);
  }

  private async preserve(path: string, bytes: Uint8Array, suffix: string): Promise<void> {
    let target = this.local(copyName(path, suffix));
    if (await this.adapter.exists(target)) {
      if (sameBytes(await this.readFile(target), bytes)) return;
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
  /** The open sign-in window, so the way back from Google or GitHub continues in it. */
  signInWindow?: CloudSignInModal;

  constructor(private plugin: JotDropPlugin, store?: KeyValues) {
    const app = plugin.app as unknown as { appId?: string };
    this.store = store ?? new CloudStore(`jotdrop-cloud-${app.appId || plugin.app.vault.getName()}`);
    this.ready = this.restore().catch(() => { this.status = "Could not open the saved cloud connection. Log in again."; });
  }

  get signedIn(): boolean { return !!this.client; }
  /** The signed-in device, for the account screens. */
  get connection(): CloudClient | undefined { return this.client; }
  get enabled(): boolean { return !!this.state?.enabled; }
  get lastSynced(): string | undefined { return this.state?.lastSynced; }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  // A copy: a listener may re-register itself, and a live Set would then call it forever.
  private changed(): void { for (const listener of [...this.listeners]) listener(); }

  register(): void {
    const plugin = this.plugin;
    plugin.addCommand({ id: "cloud-sync-now", name: "JotDrop Cloud: sync now", callback: () => { void this.syncNow().catch((error) => new Notice(error instanceof Error ? error.message : String(error))); } });
    plugin.addCommand({ id: "cloud-review-conflicts", name: "JotDrop Cloud: review conflicts", callback: () => new ConflictReviewModal(plugin.app, this).open() });
    plugin.addCommand({ id: "cloud-time-machine", name: "JotDrop Cloud: time machine", callback: () => new TimeMachineModal(plugin.app, this).open() });
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
    // Google or GitHub sends the browser back here: obsidian://jotdrop-cloud?oauth=<ticket>
    plugin.registerObsidianProtocolHandler("jotdrop-cloud", (params) => {
      void this.providerReturn(params).then((signIn) => this.showSignIn(false, signIn), (error) => new Notice(error instanceof Error ? error.message : String(error), 10000));
    });
  }

  /** Sign in with Google or GitHub: the verifier waits on this device for the ticket that comes back. Returns the page to open. */
  async startProvider(url: string, provider: string): Promise<string> {
    const { verifier, href } = await startProviderSignIn({ url, provider, client: "obsidian" });
    await this.store.put("provider", { url, verifier });
    return href;
  }

  /** Back from the browser: the ticket only works with this device's verifier, and only once. */
  async providerReturn(params: Record<string, string>): Promise<ProviderSignIn> {
    const started = await this.store.get<{ url: string; verifier: string }>("provider");
    await this.store.delete("provider");
    if (!params.oauth) throw new Error(params["oauth-error"] || "The sign-in did not finish. Try again.");
    if (!started) throw new Error("This sign-in was started in another vault or app. Start again here.");
    return await providerTicket({ ...started, ticket: params.oauth, fetcher: cloudFetch }) as ProviderSignIn;
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
    // A big first sync takes a while: show how far it is, twice a second at most.
    let shownAt = 0;
    const progress = (label: string) => (done: number, total: number) => {
      if (Date.now() - shownAt < 500) return;
      shownAt = Date.now();
      this.status = `${label} ${done} / ${total}`;
      this.changed();
    };
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
        list: () => remoteFiles(client, state.index, { checkActive: active, save, progress: progress("Reading the cloud...") }),
        write: (path: string, bytes: Uint8Array, baseRevision: number) => { active(); return this.upload(client, state, path, bytes, baseRevision, abort.signal); },
        delete: async (path: string, baseRevision: number) => {
          active();
          const id = await objectId(vaultKey, path);
          const saved = await client.remove(id, baseRevision);
          const object = { path, revision: saved.revision, deleted: true, hash: state.index.objects[id]?.hash ?? "" };
          state.index.objects[id] = object;
          return object;
        },
      };
      const report = await syncFolder(remote, folder, state.tracked, (next: Record<string, Base>) => this.store.put("state", { ...state, tracked: next }), { checkActive: active, seen: state.seen ??= {}, progress: progress("Syncing...") });
      state.lastSynced = new Date().toISOString();
      state.conflicts = report.conflicts;
      const big = report.skipped.length
        ? ` ${report.skipped.length === 1 ? "1 file is" : `${report.skipped.length} files are`} larger than 4 MiB and ${report.skipped.length === 1 ? "stays" : "stay"} only on this device: ${report.skipped.slice(0, 3).map((path: string) => path.split("/").pop()).join(", ")}${report.skipped.length > 3 ? ` and ${report.skipped.length - 3} more` : ""}.`
        : "";
      state.message = (report.conflicts
        ? `${report.conflicts} ${report.conflicts === 1 ? "note was" : "notes were"} changed in two places. Both versions are kept: choose one with "Review conflicts".`
        : `Synced. ${report.uploaded} up, ${report.downloaded} down, ${report.deleted} removed.`) + big;
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

  /** An upload that survives a restart: the next sync finishes it, or keeps it as a copy when the cloud moved on. */
  private async upload(client: CloudClient, state: SyncState, path: string, bytes: Uint8Array, baseRevision: number, signal?: AbortSignal) {
    const prepared = state.upload = await client.prepareWrite(path, bytes, baseRevision);
    await this.store.put("state", state);
    const saved = await client.commitWrite(prepared, { resumable: true, signal });
    state.upload = undefined;
    const object = { path, revision: saved.revision, deleted: false, hash: await hash(bytes) };
    state.index.objects[prepared.id] = object;
    return object;
  }

  /** Runs `action` on its own, never during a sync; a sync asked for meanwhile runs afterwards. */
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    await this.ready;
    while (this.running) await this.running.catch(() => {});
    const result = action();
    this.running = result.then(() => {}, () => {}).finally(() => {
      this.running = undefined;
      if (this.again) { this.again = false; this.request(500); }
    });
    return result;
  }

  private syncing(): { client: CloudClient; state: SyncState; folder: VaultFolder } {
    if (!this.client) throw new Error("Log in to JotDrop Cloud first.");
    if (!this.state?.enabled) throw new Error("Turn on cloud sync first.");
    const folder = new VaultFolder(this.plugin, this.editing);
    if (folder.binding !== this.state.binding) throw new Error("The notes or attachments folder changed. Turn cloud sync off and on again for the new folder.");
    return { client: this.client, state: this.state, folder };
  }

  /** The notes changed in two places: each original with its ".cloud-conflict" copies, as vault paths. */
  async conflicts(): Promise<Array<{ path: string; local: string; copies: string[] }>> {
    await this.ready;
    const { folder } = this.syncing();
    return [...(await folder.conflicts())].sort(([a], [b]) => a.localeCompare(b)).map(([path, copies]) => ({ path, local: folder.local(path), copies }));
  }

  /** This vault's version and the newest cloud version of a file; null when it is not there or in the cloud trash. */
  async compare(path: string): Promise<{ local: Uint8Array | null; cloud: Uint8Array | null }> {
    await this.ready;
    const { client, folder } = this.syncing();
    const cloud = await this.newest(client, path);
    return { local: await folder.get(path), cloud: cloud.deleted ? null : cloud.bytes };
  }

  private async newest(client: CloudClient, path: string): Promise<{ id: string; revision: number; deleted: boolean; bytes: Uint8Array | null }> {
    const id = await objectId(client.credentials.vaultKey, path);
    try {
      const entry = await client.read(id);
      return { id, revision: entry.revision, deleted: Boolean(entry.deleted), bytes: base64ToBytes(entry.file.content) };
    } catch (error) {
      // Cleared from a full free cloud after 30 days in the trash: the name starts over.
      if ((error as { status?: number }).status === 404) return { id, revision: 0, deleted: true, bytes: null };
      throw error;
    }
  }

  /**
   * Settle a conflict like Android: keep this vault's version (it becomes the newest cloud version) or use the
   * cloud version (this vault's version goes to the trash). Then the ".cloud-conflict" copies go to the trash.
   */
  async resolve(path: string, keepLocal: boolean): Promise<void> {
    await this.exclusive(async () => {
      const { client, state, folder } = this.syncing();
      if (state.upload) throw new Error("A change is still waiting to upload. Sync first, then choose again.");
      const local = await folder.get(path);
      const cloud = await this.newest(client, path);
      if (keepLocal) {
        if (!local) { if (!cloud.deleted) await client.remove(cloud.id, cloud.revision); }
        else if (cloud.deleted || !cloud.bytes || !sameBytes(local, cloud.bytes)) await this.upload(client, state, path, local, cloud.revision);
      } else {
        const replacement = cloud.deleted ? null : cloud.bytes;
        if (!(local && replacement && sameBytes(local, replacement))) {
          const busy = "The note changed or is open in the editor. Close it and choose again.";
          if (local && !await folder.compareAndSet(path, local, null)) throw new Error(busy);
          if (replacement && !await folder.compareAndSet(path, null, replacement)) throw new Error(busy);
        }
      }
      await folder.trashConflicts(path);
      await this.store.put("state", state);
    });
    this.plugin.refreshViews();
    this.request(0);
  }

  /** The saved versions of a note in this vault, newest first, like "History" on the website and Android. */
  async history(vaultPath: string): Promise<{ path: string; id: string; versions: CloudVersion[] }> {
    await this.ready;
    const { client, folder } = this.syncing();
    const path = folder.cloudPath(vaultPath);
    if (!path) throw new Error("Only notes and attachments in the JotDrop folders have a cloud history.");
    const id = await objectId(client.credentials.vaultKey, path);
    try { return { path, id, versions: (await client.history(id) as { versions: CloudVersion[] }).versions }; }
    catch (error) {
      if ((error as { status?: number }).status === 404) throw new Error("This note is not in the cloud yet. Sync first.");
      throw error;
    }
  }

  async readVersion(id: string, revision: number): Promise<Uint8Array> {
    await this.ready;
    const { client } = this.syncing();
    return base64ToBytes((await client.read(id, revision)).file.content);
  }

  /** An older version becomes the newest one; history keeps every version, so this can be undone. */
  async restoreVersion(path: string, revision: number): Promise<void> {
    // Send this vault's changes first, so they become a version too.
    await this.syncNow();
    await this.exclusive(async () => {
      const { client } = this.syncing();
      const current = await this.newest(client, path);
      await client.restore(current.id, revision, current.revision);
    });
    await this.syncNow();
  }

  /** The moments of the time machine, oldest first; the last one is now. */
  async timeline(): Promise<string[]> {
    await this.ready;
    if (!this.client) throw new Error("Log in to JotDrop Cloud first.");
    return (await cloudTimeline(this.client)).steps;
  }

  /** The cloud as it was at `at`, read-only. Files the free plan cannot open are counted, not shown. */
  async moment(at: string, isCurrent: () => boolean = () => true): Promise<CloudMoment> {
    await this.ready;
    const client = this.client;
    if (!client) throw new Error("Log in to JotDrop Cloud first.");
    const { current } = await cloudTimeline(client);
    const { objects: then } = await client.snapshot(at) as { objects: MomentFile[] };
    const missing = unavailable(current, then) as MomentFile[];
    const now = new Map(current.map((file: { id: string; revision: number }) => [file.id, file.revision]));
    const open = then.filter((file) => !file.deleted && !missing.includes(file));
    const files: CloudMoment["files"] = [];
    // A few at a time: the server serves a limited number of requests at once.
    for (let start = 0; start < open.length; start += 8) {
      if (!isCurrent()) throw new Error("A newer moment was chosen.");
      // The newest version is always open; older ones by revision.
      const read = await Promise.all(open.slice(start, start + 8).map((file) => now.get(file.id) === file.revision ? client.read(file.id) : client.read(file.id, file.revision!)));
      for (const entry of read) files.push({ path: entry.file.path, bytes: base64ToBytes(entry.file.content) });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { at, then, files, trashed: then.filter((file) => file.deleted).length, locked: missing.filter((file) => !file.cleared).length, cleared: missing.filter((file) => file.cleared).length };
  }

  /** Back to a moment: files from then come back as new versions, files made later move to the trash. */
  async restoreMoment(moment: CloudMoment): Promise<number> {
    await this.ready;
    const client = this.client;
    if (!client) throw new Error("Log in to JotDrop Cloud first.");
    // Send this vault's changes first, then compare against the newest cloud versions.
    if (this.enabled) await this.syncNow();
    let done = 0;
    try {
      await this.exclusive(async () => {
        for (const step of restorePlan((await cloudTimeline(client)).current, moment.then) as Array<{ id: string; delete?: boolean; revision?: number; baseRevision: number }>) {
          if (step.delete) await client.remove(step.id, step.baseRevision);
          else await client.restore(step.id, step.revision, step.baseRevision);
          done++;
        }
      });
    } catch (error) {
      if (!done) throw error;
      throw new Error(`${done} file(s) were restored, then this stopped: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.request(0);
    }
    return done;
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
    const client = await this.forget("Logged out. Your notes stay in this vault and in the cloud.");
    // Give the device slot back, like the website; the server keeps the last active device.
    if (client) void client.revokeDevice(client.credentials.deviceId).catch(() => {});
  }

  /** After "Delete account": the cloud is gone, so a waiting upload is dropped too. The notes stay in this vault. */
  async forgetDeletedCloud(): Promise<void> {
    await this.ready;
    await this.forget("Your account and cloud were deleted. Your notes stay in this vault.");
  }

  private async forget(status: string): Promise<CloudClient | undefined> {
    await this.stop();
    const client = this.client;
    this.client = undefined;
    this.email = "";
    this.state = undefined;
    await this.store.delete("session");
    await this.store.delete("state");
    this.status = status;
    this.changed();
    return client;
  }

  /** Plugin unload: stop syncing, keep the session for next time. */
  lock(): void {
    window.clearTimeout(this.timer);
    this.generation++;
    this.abort?.abort();
  }

  showSignIn(signup = false, signIn?: ProviderSignIn): void {
    if (signIn && this.signInWindow) this.signInWindow.provider(signIn);
    else new CloudSignInModal(this.plugin, this, signup, signIn).open();
  }

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
type LimitError = { code?: string; message?: string; devices?: Array<{ id: string; name: string; lastSeenAt: string }> };

/** Log in or create an account, with the email code, the free device limit, the recovery code and "forgot password". */
class CloudSignInModal extends Modal {
  private message!: HTMLElement;

  constructor(private plugin: JotDropPlugin, private cloud: CloudController, private signup: boolean, private signIn?: ProviderSignIn) { super(plugin.app); }

  private get url(): string { return this.plugin.settings.cloudServer || DEFAULT_CLOUD_SERVER; }

  onOpen(): void {
    this.cloud.signInWindow = this;
    if (this.signIn) this.provider(this.signIn);
    else this.form();
  }
  onClose(): void {
    if (this.cloud.signInWindow === this) this.cloud.signInWindow = undefined;
    this.contentEl.empty();
  }

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

  private field(el: HTMLElement, name: string, type: string, autocomplete: AutoFill, set: (value: string) => void, desc = ""): void {
    new Setting(el).setName(name).setDesc(desc).addText((input) => { input.inputEl.type = type; input.inputEl.autocomplete = autocomplete; input.onChange(set); });
  }

  /** Off unless the person turns it on, like on the website. */
  private newsletter(el: HTMLElement, set: (value: boolean) => void): void {
    new Setting(el).setName("Email me news about JotDrop").addToggle((toggle) => toggle.setValue(false).onChange(set));
  }

  /** At the free device limit this device takes the place of one the person no longer uses; `connect` repeats the step. */
  private async withDeviceChoice(choices: HTMLElement, connect: (replaceDeviceId?: string) => Promise<void>): Promise<void> {
    try { await connect(); }
    catch (error) {
      const limit = error as LimitError;
      if (limit.code !== "device-limit" || !limit.devices) throw error;
      choices.empty();
      choices.createEl("p", { text: `${limit.message} Choose the device this one replaces:` });
      for (const device of limit.devices) {
        new Setting(choices).setName(device.name).setDesc(`Last used ${new Date(device.lastSeenAt).toLocaleDateString()}`)
          .addButton((choice) => choice.setButtonText("Sign out that device").onClick(() => this.busy(choice.buttonEl, () => connect(device.id))));
      }
      this.status("");
    }
  }

  private form(): void {
    const el = this.start(this.signup ? "Create a JotDrop Cloud account" : "Log in to JotDrop Cloud");
    el.createEl("p", { text: this.signup ? "Your notes are encrypted on this device with a key made from your password. The server never sees your password or your notes." : "Use the same email and password as on the website and in the Android app." });
    privacyLink(el.createEl("p"), this.url);
    // Google or GitHub only say who you are; the key to the notes still comes from your own devices.
    const providers = el.createDiv();
    void availableProviders(this.url, { fetcher: cloudFetch }).then((list: string[]) => {
      const known = list.filter((name) => PROVIDER_NAMES[name]);
      if (!known.length || !providers.isConnected) return;
      const row = new Setting(providers);
      for (const name of known) row.addButton((button) => {
        button.setButtonText(`Continue with ${PROVIDER_NAMES[name]}`).setClass(`jotdrop-provider-${name}`).onClick(() => this.busy(button.buttonEl, async () => {
          window.open(await this.cloud.startProvider(this.url, name));
          this.waiting(name);
        }));
        button.buttonEl.prepend(providerLogo(name));
      });
      providers.createEl("p", { text: "Or with email and password:" });
    }, () => {});
    let email = "", password = "", confirm = "", newsletter = false;
    this.field(el, "Email", "email", "email", (value) => { email = value.trim(); });
    this.field(el, "Password", "password", this.signup ? "new-password" : "current-password", (value) => { password = value; }, this.signup ? "At least 12 characters." : "");
    if (this.signup) this.field(el, "Repeat password", "password", "new-password", (value) => { confirm = value; });
    if (this.signup) this.newsletter(el, (value) => { newsletter = value; });
    this.message = el.createEl("p", { attr: { role: "status" } });
    const actions = new Setting(el);
    if (!this.signup) actions.addButton((button) => button.setButtonText("Forgot password?").onClick(() => this.forgot(email)));
    actions
      .addButton((button) => button.setButtonText(this.signup ? "I have an account" : "Create an account").onClick(() => { this.signup = !this.signup; this.form(); }))
      .addButton((button) => button.setButtonText(this.signup ? "Create account" : "Log in").setCta().onClick(() => this.busy(button.buttonEl, async () => {
        if (this.signup && password !== confirm) throw new Error("The passwords do not match.");
        const pending = this.signup
          ? await signUp({ url: this.url, email, password, deviceName: deviceName(), newsletter, fetcher: cloudFetch })
          : await logIn({ url: this.url, email, password, deviceName: deviceName(), fetcher: cloudFetch });
        this.code(pending as Pending, email, password);
      })));
  }

  private waiting(provider: string): void {
    const el = this.start(`Continue with ${PROVIDER_NAMES[provider]}`);
    el.createEl("p", { text: `Sign in with ${PROVIDER_NAMES[provider]} in your browser. Obsidian comes back here when you are done.` });
    this.message = el.createEl("p", { attr: { role: "status" } });
    new Setting(el).addButton((button) => button.setButtonText("Back").onClick(() => this.form()));
  }

  /** Back from Google or GitHub: a new cloud, or the key from a signed-in device or the recovery code. */
  provider(signIn: ProviderSignIn): void {
    const el = this.start(signIn.account ? "Open your notes in this vault" : "Create your JotDrop cloud");
    el.createEl("p", { text: `Signed in with ${PROVIDER_NAMES[signIn.provider] ?? signIn.provider} as ${signIn.email}.` });
    const options = { deviceName: deviceName() };
    const choices = createDiv();
    if (!signIn.account) {
      el.createEl("p", { text: "Your notes are encrypted on this device before they leave it. You get a recovery code: keep it safe, it opens your notes if you lose your devices." });
      let newsletter = false;
      this.newsletter(el, (value) => { newsletter = value; });
      new Setting(el).addButton((button) => button.setButtonText("Create my JotDrop cloud").setCta().onClick(() => this.busy(button.buttonEl, async () => {
        const { client, recoveryCode } = await providerSignUp(signIn, { ...options, newsletter }, { fetcher: cloudFetch });
        await this.cloud.finishSignIn(client, signIn.email);
        this.done(recoveryCode);
      })));
    } else {
      el.createEl("p", { text: "Only your own devices hold the key to your notes. Get it from a device that is signed in, or with your recovery code." });
      new Setting(el).addButton((button) => button.setButtonText("Approve on a signed-in device").setCta().onClick(() => this.busy(button.buttonEl, async () => {
        this.waitForApproval(await providerApproval(signIn, { fetcher: cloudFetch }), options, signIn.email);
      })));
      let recoveryCode = "";
      new Setting(el).setName("Or use your recovery code").addTextArea((input) => input.onChange((value) => { recoveryCode = value.trim(); }));
      new Setting(el).addButton((button) => button.setButtonText("Use recovery code").onClick(() => this.busy(button.buttonEl, () => this.withDeviceChoice(choices, async (replaceDeviceId) => {
        await this.cloud.finishSignIn(await providerRecover(signIn, { ...options, recoveryCode, replaceDeviceId }, { fetcher: cloudFetch }), signIn.email);
        this.done();
      }))));
    }
    this.message = el.createEl("p", { attr: { role: "status" } });
    el.appendChild(choices);
    new Setting(el).addButton((button) => button.setButtonText("Back").onClick(() => this.form()));
  }

  private code(pending: Pending, email: string, password: string): void {
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
        this.done(recoveryCode, password);
        return;
      }
      await this.withDeviceChoice(choices, async (replaceDeviceId) => {
        await this.cloud.finishSignIn(await confirmLogin(pending, code, { fetcher: cloudFetch, replaceDeviceId }), email);
        this.done();
      });
    })));
  }

  /** Forgot password: a mailed code, then one of the three routes the website offers. */
  private forgot(known: string): void {
    const el = this.start("Forgot your password?");
    el.createEl("p", { text: "We email you a code. Then you choose how to get back in." });
    let email = known;
    new Setting(el).setName("Email").addText((input) => { input.inputEl.type = "email"; input.inputEl.autocomplete = "email"; input.setValue(known).onChange((value) => { email = value.trim(); }); });
    this.message = el.createEl("p", { attr: { role: "status" } });
    new Setting(el)
      .addButton((button) => button.setButtonText("Back").onClick(() => this.form()))
      .addButton((button) => button.setButtonText("Email me a code").setCta().onClick(() => this.busy(button.buttonEl, async () => {
        this.reset(await startReset({ url: this.url, email, fetcher: cloudFetch }), email);
      })));
  }

  private reset(reset: Awaited<ReturnType<typeof startReset>>, email: string): void {
    const el = this.start("Choose a new password");
    el.createEl("p", { text: "If this address has an account, we emailed it a code." });
    let code = "", password = "", repeat = "", route = "approve", recoveryCode = "", confirmed = false;
    new Setting(el).setName("Code from the email").addText((input) => { input.inputEl.inputMode = "numeric"; input.inputEl.autocomplete = "one-time-code"; input.onChange((value) => { code = value.trim(); }); });
    this.field(el, "New password", "password", "new-password", (value) => { password = value; }, "At least 12 characters.");
    this.field(el, "Repeat new password", "password", "new-password", (value) => { repeat = value; });
    const extra = el.createDiv();
    const showRoute = () => {
      extra.empty();
      if (route === "recover") new Setting(extra).setName("Recovery code").addTextArea((input) => input.onChange((value) => { recoveryCode = value.trim(); }));
      if (route === "restart") {
        extra.createEl("p", { text: "This deletes the notes in your cloud for good and starts an empty cloud. Notes on your devices are not touched. Use it only when you have no signed-in device and no recovery code." });
        new Setting(extra).setName("Delete my old cloud notes").addToggle((toggle) => toggle.onChange((value) => { confirmed = value; }));
      }
    };
    new Setting(el).setName("How do you get back in?").addDropdown((dropdown) => dropdown
      .addOption("approve", "Approve on a device that is still signed in")
      .addOption("recover", "Use my recovery code")
      .addOption("restart", "Start over with an empty cloud")
      .setValue(route).onChange((value) => { route = value; showRoute(); }));
    showRoute();
    this.message = el.createEl("p", { attr: { role: "status" } });
    const choices = el.createDiv();
    new Setting(el).addButton((button) => button.setButtonText("Continue").setCta().onClick(() => this.busy(button.buttonEl, async () => {
      if (password !== repeat) throw new Error("The passwords do not match.");
      const options = { newPassword: password, deviceName: deviceName() };
      if (route === "recover") {
        await this.withDeviceChoice(choices, async (replaceDeviceId) => {
          await this.cloud.finishSignIn(await resetWithRecoveryCode(reset, { ...options, code, recoveryCode, replaceDeviceId }, { fetcher: cloudFetch }), email);
          this.done();
        });
      } else if (route === "restart") {
        if (!confirmed) throw new Error("Turn on \"Delete my old cloud notes\" to confirm.");
        const { client, recoveryCode: fresh } = await startOver(reset, { ...options, code }, { fetcher: cloudFetch });
        await this.cloud.finishSignIn(client, email);
        this.done(fresh);
      } else this.waitForApproval(await requestApproval(reset, code, { fetcher: cloudFetch }), options, email);
    })));
  }

  /** Without `newPassword` (Google or GitHub) the account keeps its password, or stays without one. */
  private waitForApproval(pending: Awaited<ReturnType<typeof requestApproval>>, options: { newPassword?: string; deviceName: string }, email: string): void {
    const el = this.start("Approve on your other device");
    el.createEl("p", { text: "On a device that is still signed in, open JotDrop Cloud (website: Devices & recovery; Obsidian: JotDrop settings). Approve only if it shows exactly these words:" });
    el.createEl("p", { cls: "jotdrop-approval-words", text: pending.words.join("  ") });
    this.message = el.createEl("p", { attr: { role: "status" }, text: "Waiting for approval..." });
    const choices = el.createDiv();
    let active = true;
    new Setting(el).addButton((button) => button.setButtonText("Cancel").onClick(() => { active = false; this.form(); }));
    const poll = async () => {
      if (!active || !this.contentEl.isConnected) return;
      try {
        const approved = await checkApproval(pending, { fetcher: cloudFetch });
        if (!active) return;
        if (!approved) { window.setTimeout(() => void poll(), 3000); return; }
        active = false;
        this.status(options.newPassword === undefined ? "Approved. Opening your notes..." : "Approved. Setting your new password...");
        await this.withDeviceChoice(choices, async (replaceDeviceId) => {
          await this.cloud.finishSignIn(await completeApproval(approved, { ...options, newPassword: options.newPassword, replaceDeviceId }, { fetcher: cloudFetch }), email);
          this.done();
        });
      } catch (error) {
        active = false;
        this.status((error as { status?: number }).status === 401 ? "The request was rejected or has expired. Go back and start again." : error instanceof Error ? error.message : "Something went wrong.");
      }
    };
    window.setTimeout(() => void poll(), 3000);
  }

  /** With `password` (a new account with a password) the recovery code is followed by the recommended authenticator step. */
  private done(recoveryCode?: string, password?: string): void {
    this.close();
    new Notice("Signed in to JotDrop Cloud.");
    const secure = password === undefined ? undefined : () => new AuthenticatorModal(this.app, this.cloud, { password }).open();
    if (recoveryCode) new RecoveryCodeModal(this.app, recoveryCode, secure).open();
  }
}

import { Modal, Notice, Setting, TFile, normalizePath, type ButtonComponent } from "obsidian";
import type JotDropPlugin from "./main";
import { ConfirmModal } from "./confirmModal";
import { CloudClient } from "../cloud/shared/client.mjs";
import { normalizePath as safeCloudPath, sealLocal, unsealLocal, decryptEnvelope, base64ToBytes, objectId, MAX_FILE_BYTES } from "../cloud/shared/crypto.mjs";
import { fingerprint, syncPreview } from "../cloud/shared/preview-sync.mjs";

const TEST_FOLDER = "JotDrop Cloud Test";
const decoder = new TextDecoder("utf-8", { fatal: true });
type Tracked = Record<string, { revision: number; hash: string; deleted: boolean }>;
type Pending = { prepared: { id: string; baseRevision: number; envelope: string }; hash: string };
type Progress = { phase: string; transferredBytes: number; totalBytes: number };

/** Manual isolated preview only; never attaches cloud sync to the user's notes folder. */
export class CloudController {
  status = "Cloud preview locked. Existing local storage and sync are unchanged.";
  private client?: CloudClient;
  private password = "";
  private tracked: Tracked = {};
  private generation = 0;
  private busy = false;
  private transfer?: AbortController;
  private pending?: Pending;

  constructor(private plugin: JotDropPlugin) {}

  register(): void {
    this.plugin.addCommand({ id: "cloud-preview-pair", name: "Cloud preview: pair a test workspace", callback: () => this.showPair() });
    this.plugin.addCommand({ id: "cloud-preview-unlock", name: "Cloud preview: unlock this device", callback: () => this.showUnlock() });
    this.plugin.addCommand({ id: "cloud-preview-sync", name: "Cloud preview: manually sync isolated test folder", callback: () => this.confirmSync() });
    this.plugin.addCommand({ id: "cloud-preview-lock", name: "Cloud preview: lock", callback: () => this.lock() });
    this.plugin.addCommand({ id: "cloud-preview-pause", name: "Cloud preview: pause current transfer", callback: () => this.cancel() });
  }

  lock(): void {
    this.transfer?.abort();
    this.generation++;
    this.client = undefined;
    this.password = "";
    this.tracked = {};
    this.status = "Cloud preview locked. No background cloud sync is running.";
  }

  showPair(): void { new CloudAccessModal(this, this.plugin, true).open(); }
  showUnlock(): void { new CloudAccessModal(this, this.plugin, false).open(); }
  get hasQueuedUpload(): boolean { return !!this.pending; }

  async recoverQueuedUpload(): Promise<string> {
    if (!this.client) throw new Error("Unlock the cloud preview first.");
    if (this.busy) throw new Error("Wait for the current preview operation to finish.");
    if (!this.pending) throw new Error("There is no queued upload to recover.");
    this.busy = true;
    const client = this.client, pending = this.pending, generation = this.generation;
    const transfer = this.transfer = new AbortController();
    const active = () => { transfer.signal.throwIfAborted(); if (this.generation !== generation) throw new Error("Cloud preview locked. The queued upload was kept."); };
    try {
      await this.assertSafeFolder();
      const { vaultKey, vaultId } = client.credentials, { id, envelope } = pending.prepared;
      const file = await decryptEnvelope(vaultKey, JSON.parse(envelope), `jotdrop:object:v1:${vaultId}:${id}`);
      const path = safeCloudPath(file.path), bytes = base64ToBytes(file.content);
      if (!/^(notes|attachments)\//.test(path) || bytes.length > MAX_FILE_BYTES || await objectId(vaultKey, path) !== id || await fingerprint(bytes) !== pending.hash) throw new Error("Invalid queued snapshot. Nothing was cleared.");
      const vault = this.plugin.app.vault;
      const target = normalizePath(`${TEST_FOLDER}/Recovered Uploads/${crypto.randomUUID()}/${path}`);
      let parent = "";
      for (const part of target.split("/").slice(0, -1)) {
        active();
        parent = parent ? `${parent}/${part}` : part;
        if (!await vault.adapter.exists(parent)) await vault.createFolder(parent);
      }
      active();
      await vault.createBinary(target, bytes.slice().buffer);
      if (await fingerprint(new Uint8Array(await vault.adapter.readBinary(target))) !== pending.hash) throw new Error("Recovery copy verification failed. The queued upload was kept.");
      active();
      await client.discardWrite(pending.prepared);
      active();
      const sealed = await sealLocal({ credentials: client.credentials, tracked: this.tracked }, this.password);
      active();
      const previous = this.plugin.settings.cloudConnection;
      this.plugin.settings.cloudConnection = JSON.stringify(sealed);
      try { await this.plugin.saveSettings(); }
      catch (error) { this.plugin.settings.cloudConnection = previous; throw error; }
      active();
      this.pending = undefined;
      this.status = `Queued snapshot saved to ${target}. Original local and cloud files unchanged. Resume sync manually.`;
      return target;
    } finally { this.busy = false; this.transfer = undefined; }
  }

  cancel(): void {
    if (!this.transfer) return;
    this.transfer?.abort();
    this.status = "Cloud transfer paused. Encrypted upload kept; manual sync resumes it.";
  }

  async connect(code: string, password: string): Promise<void> {
    if (password.length < 12) throw new Error("Use an unlock passphrase of at least 12 characters.");
    if (this.busy) throw new Error("Wait for the current preview operation to finish.");
    if (this.plugin.settings.cloudConnection && !this.client) throw new Error("Unlock the existing preview before pairing another workspace. Queued uploads must be preserved.");
    if (this.pending) throw new Error("Resume the queued upload before replacing this connection.");
    const client = await CloudClient.claim({ pairingCode: code });
    const sealed = await sealLocal({ credentials: client.credentials, tracked: {} }, password);
    this.plugin.settings.cloudConnection = JSON.stringify(sealed);
    await this.plugin.saveSettings();
    this.client = client;
    this.password = password;
    this.tracked = {};
    this.pending = undefined;
    this.status = "Paired. Manual test-folder sync only; no existing notes have been imported.";
  }

  async unlock(password: string): Promise<void> {
    if (!this.plugin.settings.cloudConnection) throw new Error("Pair a test workspace first.");
    if (this.busy) throw new Error("Wait for the current preview operation to finish.");
    const value = await unsealLocal(JSON.parse(this.plugin.settings.cloudConnection), password);
    this.client = new CloudClient(value.credentials);
    this.password = password;
    this.tracked = value.tracked || {};
    this.pending = value.pending;
    this.status = "Unlocked for manual test-folder sync. Automatic cloud sync is disabled.";
  }

  private async assertSafeFolder(): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    const folder = TEST_FOLDER.toLowerCase();
    for (const protectedFolder of [this.plugin.settings.notesFolder, this.plugin.settings.archiveFolder, this.plugin.resolveAssetsFolder()]) {
      const path = normalizePath(protectedFolder).replace(/\/+$/, "").toLowerCase();
      if (!path || folder === path || folder.startsWith(`${path}/`) || path.startsWith(`${folder}/`)) throw new Error("The cloud test folder overlaps existing JotDrop storage. Use an isolated test vault.");
    }
    for (const parent of ["", TEST_FOLDER, `${TEST_FOLDER}/notes`, `${TEST_FOLDER}/attachments`]) {
      for (const marker of [".stfolder", ".stignore", ".stversions"]) {
        if (await adapter.exists(parent ? `${parent}/${marker}` : marker)) throw new Error("Syncthing markers found. Use an isolated test vault; never run two sync systems on the same files.");
      }
    }
  }

  confirmSync(): void {
    if (!this.client) { this.showUnlock(); return; }
    new ConfirmModal(this.plugin.app, {
      title: "Sync isolated cloud test folder",
      message: `This preview only syncs ${TEST_FOLDER}/notes and ${TEST_FOLDER}/attachments. Confirm no other sync service manages this folder. Existing JotDrop folders are excluded. Conflicts are preserved separately; deletions are NOT automatically applied. Maximum 500 files, 4 MiB each.`,
      confirmLabel: "Sync test files manually",
    }, () => { new CloudTransferModal(this, this.plugin).open(); }).open();
  }

  async sync(onProgress?: (event: Progress) => void): Promise<void> {
    if (!this.client) throw new Error("Unlock the cloud preview first.");
    if (this.busy) throw new Error("A manual cloud preview sync is already running.");
    this.busy = true;
    const transfer = new AbortController();
    this.transfer = transfer;
    const { credentials, fetcher } = this.client, generation = this.generation;
    const client = new CloudClient({ ...credentials, fetcher: (url, options) => fetcher(url, { ...options, signal: options?.signal ? AbortSignal.any([transfer.signal, options.signal]) : transfer.signal }) });
    const active = () => { transfer.signal.throwIfAborted(); if (!this.client || this.generation !== generation) throw new Error("Cloud preview locked. Further local writes stopped."); };
    const persist = async () => {
      active();
      const pending = this.pending;
      const saved = pending && this.tracked[pending.prepared.id];
      const completed = saved && !saved.deleted && saved.revision === pending.prepared.baseRevision + 1 && saved.hash === pending.hash;
      const sealed = await sealLocal({ credentials, tracked: this.tracked, pending: completed ? undefined : pending }, this.password);
      active();
      this.plugin.settings.cloudConnection = JSON.stringify(sealed);
      await this.plugin.saveSettings();
      if (completed && this.pending === pending) this.pending = undefined;
    };
    const upload = (prepared: Pending["prepared"]) => client.commitWrite(prepared, { resumable: true, signal: transfer.signal, onProgress: (event: Progress) => {
      active();
      this.status = event.phase === "committed" ? "Cloud version confirmed." : event.phase === "committing" ? "Finalizing cloud version..." : `${Math.floor(event.transferredBytes / 1024)} / ${Math.ceil(event.totalBytes / 1024)} KiB encrypted bytes confirmed.`;
      onProgress?.(event);
    } });
    const vault = this.plugin.app.vault;
    const localPath = (path: string) => normalizePath(`${TEST_FOLDER}/${safeCloudPath(path)}`);
    const ensureParent = async (path: string) => {
      let parent = "";
      for (const part of path.split("/").slice(0, -1)) {
        active();
        parent = parent ? `${parent}/${part}` : part;
        if (!await vault.adapter.exists(parent)) await vault.createFolder(parent);
      }
    };
    try {
      await this.assertSafeFolder();
      this.status = "Syncing encrypted test files...";
      const adapter = {
        list: async () => {
          const items: Array<{ path: string; bytes: Uint8Array }> = [];
          let totalBytes = 0;
          const walk = async (folder: string): Promise<void> => {
            active();
            if (!await vault.adapter.exists(folder)) return;
            const listing = await vault.adapter.list(folder);
            if ([...listing.files, ...listing.folders].some((path) => [".stfolder", ".stignore", ".stversions"].includes(path.split("/").pop()?.toLowerCase() || ""))) throw new Error("Syncthing markers found. Use an isolated test vault; never run two sync systems on the same files.");
            for (const file of listing.files) {
              if (file.split("/").pop()?.startsWith(".") || /\.cloud-conflict-r\d+(?:\.|$)/.test(file)) continue;
              const stat = await vault.adapter.stat(file);
              if (!stat || stat.size > MAX_FILE_BYTES) throw new Error("A test file exceeds the 4 MiB preview limit.");
              totalBytes += stat.size;
              if (items.length >= 500 || totalBytes > 64 * 1024 * 1024) throw new Error("The local preview working set is limited to 500 files and 64 MiB.");
              items.push({ path: safeCloudPath(file.slice(TEST_FOLDER.length + 1)), bytes: new Uint8Array(await vault.adapter.readBinary(file)) });
            }
            for (const child of listing.folders) if (!child.split("/").pop()?.startsWith(".")) await walk(child);
          };
          await walk(`${TEST_FOLDER}/notes`);
          await walk(`${TEST_FOLDER}/attachments`);
          return items;
        },
        writeNew: async (path: string, bytes: Uint8Array) => {
          active();
          const target = localPath(path);
          if (await vault.adapter.exists(target)) return false;
          await ensureParent(target);
          active();
          await vault.createBinary(target, bytes.slice().buffer);
          return true;
        },
        replaceText: async (path: string, expected: Uint8Array, bytes: Uint8Array) => {
          active();
          if (!path.toLowerCase().endsWith(".md")) return false;
          const file = vault.getAbstractFileByPath(localPath(path));
          if (!(file instanceof TFile)) return false;
          const original = decoder.decode(expected), replacement = decoder.decode(bytes);
          let replaced = false;
          await vault.process(file, (current) => {
            active();
            if (current !== original) return current;
            replaced = true;
            return replacement;
          });
          return replaced;
        },
        writeConflict: async (path: string, bytes: Uint8Array) => {
          active();
          const target = localPath(path);
          if (await vault.adapter.exists(target)) return;
          await ensureParent(target);
          active();
          await vault.createBinary(target, bytes.slice().buffer);
        },
      };
      const items = await adapter.list();
      let resumed = 0;
      if (this.pending) {
        const pending = this.pending;
        await persist();
        const saved = await upload(pending.prepared);
        active();
        this.tracked[pending.prepared.id] = { revision: saved.revision, hash: pending.hash, deleted: false };
        await persist();
        resumed = 1;
      }
      const result = await syncPreview(client, { ...adapter, list: async () => items }, this.tracked, persist, { write: async (path: string, bytes: Uint8Array, revision: number) => {
        active();
        if (this.pending) throw new Error("A queued upload needs review before another file can upload. The encrypted snapshot was kept.");
        // One durable snapshot at a time bounds wrapped settings and survives app restarts.
        this.pending = { prepared: await client.prepareWrite(path, bytes, revision), hash: await fingerprint(bytes) };
        await persist();
        return upload(this.pending.prepared);
      } });
      active();
      result.uploaded += resumed;
      this.status = `Preview: ${result.uploaded} uploaded, ${result.downloaded} downloaded, ${result.conflicts} conflicts (${result.remoteDeletions} cloud deletions kept locally). No background sync.`;
      new Notice(this.status, 10000);
    } catch (error) {
      if (this.generation === generation) this.status = transfer.signal.aborted ? "Cloud transfer paused. Encrypted upload kept; manual sync resumes it." : error instanceof Error ? error.message : "Sync failed. Local files and the queued upload were kept.";
      throw error;
    } finally { this.busy = false; this.transfer = undefined; }
  }
}

class CloudTransferModal extends Modal {
  constructor(private cloud: CloudController, plugin: JotDropPlugin) { super(plugin.app); }

  onOpen(): void {
    this.titleEl.setText("Encrypted test-folder sync");
    const status = this.contentEl.createEl("p", { text: "Starting manual sync...", attr: { role: "status" } });
    const progress = this.contentEl.createEl("progress", { attr: { "aria-label": "Encrypted upload", hidden: "" } });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("Pause sync").onClick(() => this.cloud.cancel()));
    let recovery: ButtonComponent;
    new Setting(this.contentEl).setName("Queued upload recovery").setDesc("Save the exact queued version as a separate local copy, then clear its upload reservation. Original local files and cloud history stay unchanged.")
      .addButton((button) => {
        recovery = button;
        button.setButtonText("Keep local copy and clear queue").setDisabled(true).onClick(async () => {
          button.setDisabled(true);
          try { await this.cloud.recoverQueuedUpload(); status.setText(this.cloud.status); }
          catch (error) { status.setText(error instanceof Error ? error.message : "Recovery failed. The queued upload was kept."); }
          finally { button.setDisabled(!this.cloud.hasQueuedUpload); }
        });
      });
    new Setting(this.contentEl).addButton((button) => {
      const run = async () => {
        button.setDisabled(true);
        recovery.setDisabled(true);
        try {
          await this.cloud.sync((event) => { progress.hidden = false; progress.max = event.totalBytes; progress.value = event.transferredBytes; status.setText(this.cloud.status); });
          status.setText(this.cloud.status);
        } catch (error) { status.setText(error instanceof Error && error.name === "AbortError" ? "Paused. Encrypted upload kept; select Resume sync to continue." : error instanceof Error ? error.message : "Sync failed. Local files and the queued upload were kept."); }
        finally { progress.hidden = true; button.setDisabled(false); recovery.setDisabled(!this.cloud.hasQueuedUpload); }
      };
      button.setButtonText("Resume sync").onClick(() => { void run(); });
      void run();
    });
  }

  onClose(): void { this.cloud.cancel(); this.contentEl.empty(); }
}

class CloudAccessModal extends Modal {
  constructor(private cloud: CloudController, private plugin: JotDropPlugin, private pairing: boolean) { super(plugin.app); }

  onOpen(): void {
    this.titleEl.setText(this.pairing ? "Pair cloud development preview" : "Unlock cloud development preview");
    this.contentEl.createEl("p", { text: `Opt-in local preview, not a hosted service. Only ${TEST_FOLDER} can be synced manually. Existing folders and sync settings stay unchanged.` });
    let code = "", password = "";
    if (this.pairing) new Setting(this.contentEl).setName("One-time pairing code").addTextArea((input) => input.onChange((value) => { code = value.trim(); }));
    new Setting(this.contentEl).setName("Device unlock passphrase").setDesc("At least 12 characters. Keys are never stored in plaintext.").addText((input) => {
      input.inputEl.type = "password";
      input.inputEl.autocomplete = this.pairing ? "new-password" : "current-password";
      input.onChange((value) => { password = value; });
    });
    const status = this.contentEl.createEl("p", { attr: { role: "status" } });
    new Setting(this.contentEl).addButton((button) => button.setButtonText(this.pairing ? "Pair preview" : "Unlock").setCta().onClick(async () => {
      button.setDisabled(true);
      try {
        if (this.pairing) await this.cloud.connect(code, password);
        else await this.cloud.unlock(password);
        code = ""; password = "";
        this.close();
        new Notice(this.cloud.status, 8000);
      } catch (error) { status.setText(error instanceof Error ? error.message : "Could not connect. Check the passphrase and server origin allowlist."); }
      finally { button.setDisabled(false); }
    }));
  }

  onClose(): void { this.contentEl.empty(); }
}

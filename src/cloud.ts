import { Modal, Notice, Setting, TFile, normalizePath } from "obsidian";
import type JotDropPlugin from "./main";
import { ConfirmModal } from "./confirmModal";
import { CloudClient } from "../cloud/shared/client.mjs";
import { normalizePath as safeCloudPath, sealLocal, unsealLocal, MAX_FILE_BYTES } from "../cloud/shared/crypto.mjs";
import { syncPreview } from "../cloud/shared/preview-sync.mjs";

const TEST_FOLDER = "JotDrop Cloud Test";
const decoder = new TextDecoder("utf-8", { fatal: true });
type Tracked = Record<string, { revision: number; hash: string; deleted: boolean }>;

/** Manual isolated preview only; never attaches cloud sync to the user's notes folder. */
export class CloudController {
  status = "Cloud preview locked. Existing local storage and sync are unchanged.";
  private client?: CloudClient;
  private password = "";
  private tracked: Tracked = {};
  private generation = 0;
  private busy = false;

  constructor(private plugin: JotDropPlugin) {}

  register(): void {
    this.plugin.addCommand({ id: "cloud-preview-pair", name: "Cloud preview: pair a test workspace", callback: () => this.showPair() });
    this.plugin.addCommand({ id: "cloud-preview-unlock", name: "Cloud preview: unlock this device", callback: () => this.showUnlock() });
    this.plugin.addCommand({ id: "cloud-preview-sync", name: "Cloud preview: manually sync isolated test folder", callback: () => this.confirmSync() });
    this.plugin.addCommand({ id: "cloud-preview-lock", name: "Cloud preview: lock", callback: () => this.lock() });
  }

  lock(): void {
    this.generation++;
    this.client = undefined;
    this.password = "";
    this.tracked = {};
    this.status = "Cloud preview locked. No background cloud sync is running.";
  }

  showPair(): void { new CloudAccessModal(this, this.plugin, true).open(); }
  showUnlock(): void { new CloudAccessModal(this, this.plugin, false).open(); }

  async connect(code: string, password: string): Promise<void> {
    if (password.length < 12) throw new Error("Use an unlock passphrase of at least 12 characters.");
    if (this.busy) throw new Error("Wait for the current preview operation to finish.");
    const client = await CloudClient.claim({ pairingCode: code });
    const sealed = await sealLocal({ credentials: client.credentials, tracked: {} }, password);
    this.plugin.settings.cloudConnection = JSON.stringify(sealed);
    await this.plugin.saveSettings();
    this.client = client;
    this.password = password;
    this.tracked = {};
    this.status = "Paired. Manual test-folder sync only; no existing notes have been imported.";
  }

  async unlock(password: string): Promise<void> {
    if (!this.plugin.settings.cloudConnection) throw new Error("Pair a test workspace first.");
    if (this.busy) throw new Error("Wait for the current preview operation to finish.");
    const value = await unsealLocal(JSON.parse(this.plugin.settings.cloudConnection), password);
    this.client = new CloudClient(value.credentials);
    this.password = password;
    this.tracked = value.tracked || {};
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
    }, () => { void this.sync().catch((error) => { this.status = error.message || "Cloud preview failed. Local files were preserved."; new Notice(this.status, 10000); }); }).open();
  }

  async sync(): Promise<void> {
    if (!this.client) throw new Error("Unlock the cloud preview first.");
    if (this.busy) throw new Error("A manual cloud preview sync is already running.");
    this.busy = true;
    const client = this.client, generation = this.generation;
    const active = () => { if (!this.client || this.generation !== generation) throw new Error("Cloud preview locked. Further local writes stopped."); };
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
      const result = await syncPreview(client, {
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
      }, this.tracked, async () => {
        active();
        const sealed = await sealLocal({ credentials: client.credentials, tracked: this.tracked }, this.password);
        active();
        this.plugin.settings.cloudConnection = JSON.stringify(sealed);
        await this.plugin.saveSettings();
      });
      active();
      this.status = `Preview: ${result.uploaded} uploaded, ${result.downloaded} downloaded, ${result.conflicts} conflicts (${result.remoteDeletions} cloud deletions kept locally). No background sync.`;
      new Notice(this.status, 10000);
    } finally { this.busy = false; }
  }
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

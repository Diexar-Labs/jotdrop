import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type JotDropPlugin from "./main";
import { legacyAssetsPath, normalizeAssetsFolder } from "./attachments";
import { t } from "./i18n";
import { ConfirmModal } from "./confirmModal";
import { renderCloudAccount } from "./cloudAccount";
import { ConflictReviewModal, TimeMachineModal } from "./cloudReview";

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type SortMode = "modified-desc" | "modified-asc" | "created-desc" | "created-asc" | "title-asc" | "manual";

export interface JotDropSettings {
  notesFolder: string;
  archiveFolder: string;
  /**
   * Vault-relative folder for image/audio/preview attachments. Empty means the
   * dynamic default `<notesFolder>/.attachments` — kept dynamic on purpose so a
   * later notesFolder change keeps following it.
   */
  assetsFolder: string;
  sortMode: SortMode;
  cardWidth: number;
  showArchived: boolean;
  /** Download the article thumbnail when capturing a URL. */
  downloadImages: boolean;
  /** Whether the loopback HTTP server for the Chrome extension should be active. */
  clipServerEnabled: boolean;
  /** Port the loopback server listens on (127.0.0.1 only). */
  clipServerPort: number;
  /** Bearer token the extension must send. Generated automatically. */
  clipServerToken: string;
  /** JotDrop Cloud server; keys and sync state live per device outside data.json. */
  cloudServer: string;
  /**
   * One-time guard: older installs defaulted to "modified-desc", which made
   * cards jump on every edit. On first load we switch that old default to the
   * stable "created-desc". The flag stops us from overriding a later, deliberate
   * choice of "modified-desc" by the user.
   */
  sortMigratedToCreated: boolean;
  /**
   * Locally persisted label names that have no notes yet (empty collection).
   * Discovery for the menu comes only from `jotdrop_labels` in managed
   * folders; these persist separately so empty collections survive reloads.
   */
  localLabels: string[];
}

export const DEFAULT_SETTINGS: JotDropSettings = {
  notesFolder: "Mini Notes",
  archiveFolder: "Mini Notes/Archive",
  assetsFolder: "",
  sortMode: "manual",
  cardWidth: 240,
  showArchived: false,
  downloadImages: true,
  clipServerEnabled: false,
  clipServerPort: 27124,
  clipServerToken: "",
  cloudServer: "https://api.jotdrop.net",
  sortMigratedToCreated: false,
  localLabels: [],
};

export class JotDropSettingTab extends PluginSettingTab {
  plugin: JotDropPlugin;
  private lastInvalidNotice = 0;
  private cloudListener?: () => void;
  private cloudAccountStop?: () => void;

  constructor(app: App, plugin: JotDropPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** Throttled notice so invalid typing does not flood the user with popups. */
  private flashAssetsFolderInvalid(): void {
    const now = Date.now();
    if (now - this.lastInvalidNotice < 1500) return;
    this.lastInvalidNotice = now;
    new Notice(t("notice_assets_folder_invalid"));
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // JotDrop is a trio (plugin + Android app + Chrome clipper). Most installs
    // come from the in-app Browse listing and never see the README, so the
    // settings page is where the other two parts get discovered.
    const companions = containerEl.createDiv({ cls: "jotdrop-companions" });
    new Setting(companions).setName(t("section_companions")).setHeading();
    companions.createEl("p", { text: t("companions_blurb") });
    const companionsRow = companions.createDiv({ cls: "jotdrop-support-buttons" });
    const releasesLink = companionsRow.createEl("a", {
      cls: "jotdrop-support-button",
      attr: {
        href: "https://github.com/Diexar-Labs/jotdrop/releases/latest",
        target: "_blank",
        rel: "noopener noreferrer",
      },
    });
    releasesLink.setText(t("companions_download"));

    new Setting(containerEl)
      .setName(t("settings_notes_folder"))
      .setDesc(t("settings_notes_folder_desc"))
      .addText((text) =>
        text
          .setPlaceholder("Mini Notes")
          .setValue(this.plugin.settings.notesFolder)
          .onChange(async (value) => {
            this.plugin.settings.notesFolder = value.trim() || "Mini Notes";
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName(t("settings_assets_folder"))
      .setDesc(t("settings_assets_folder_desc"))
      .addText((text) =>
        text
          .setPlaceholder(this.plugin.resolveAssetsFolder())
          .setValue(this.plugin.settings.assetsFolder)
          .onChange(async (value) => {
            const normalized = normalizeAssetsFolder(value);
            if (normalized === null) {
              // Leave the previously saved value intact while the user types.
              this.flashAssetsFolderInvalid();
              return;
            }
            // Blank or the legacy default restores the dynamic default, so a
            // later notesFolder change keeps following it.
            if (normalized === "" || normalized === legacyAssetsPath(this.plugin.settings.notesFolder)) {
              this.plugin.settings.assetsFolder = "";
            } else {
              this.plugin.settings.assetsFolder = normalized;
            }
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName(t("settings_archive_folder"))
      .setDesc(t("settings_archive_folder_desc"))
      .addText((text) =>
        text
          .setPlaceholder("Mini Notes/Archive")
          .setValue(this.plugin.settings.archiveFolder)
          .onChange(async (value) => {
            this.plugin.settings.archiveFolder = value.trim() || "Mini Notes/Archive";
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName(t("settings_sort"))
      .setDesc(t("settings_sort_desc"))
      .addDropdown((dd) =>
        dd
          .addOptions({
            "modified-desc": t("sort_modified_desc"),
            "modified-asc": t("sort_modified_asc"),
            "created-desc": t("sort_created_desc"),
            "created-asc": t("sort_created_asc"),
            "title-asc": t("sort_title_asc"),
            "manual": t("sort_manual"),
          })
          .setValue(this.plugin.settings.sortMode)
          .onChange(async (value) => {
            this.plugin.settings.sortMode = value as SortMode;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName(t("settings_card_width"))
      .setDesc(t("settings_card_width_desc"))
      .addSlider((s) =>
        s
          .setLimits(180, 360, 10)
          .setValue(this.plugin.settings.cardWidth)
          .onChange(async (value) => {
            this.plugin.settings.cardWidth = value;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName(t("settings_show_archived"))
      .setDesc(t("settings_show_archived_desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showArchived).onChange(async (value) => {
          this.plugin.settings.showArchived = value;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName(t("settings_download_images"))
      .setDesc(t("settings_download_images_desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.downloadImages).onChange(async (value) => {
          this.plugin.settings.downloadImages = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("settings_import_keep"))
      .setDesc(t("settings_import_keep_desc"))
      .addButton((btn) =>
        btn.setButtonText(t("settings_import_keep_button")).onClick(() => this.plugin.importFromKeep())
      );

    new Setting(containerEl)
      .setName(t("settings_import_markdown"))
      .setDesc(t("settings_import_markdown_desc"))
      .addButton((btn) =>
        btn.setButtonText(t("settings_import_markdown_files")).onClick(() => this.plugin.importMarkdown())
      )
      .addButton((btn) =>
        btn.setButtonText(t("settings_import_markdown_folder")).onClick(() => this.plugin.importMarkdown(true))
      );

    new Setting(containerEl)
      .setName(t("settings_import_evernote"))
      .setDesc(t("settings_import_evernote_desc"))
      .addButton((btn) =>
        btn.setButtonText(t("settings_import_evernote_button")).onClick(() => this.plugin.importFromEvernote())
      );

    // Chrome-extension clip server — deliberately below the basics; not everyone
    // uses it and it does not need to shout for attention at the top.
    new Setting(containerEl).setName(t("settings_clip_server_section")).setHeading();
    const clipDesc = containerEl.createEl("p", {
      cls: "jotdrop-clip-desc",
      text: t("settings_clip_server_desc"),
    });
    void clipDesc;

    new Setting(containerEl)
      .setName(t("settings_clip_server_enabled"))
      .setDesc(t("settings_clip_server_enabled_desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.clipServerEnabled).onChange(async (value) => {
          this.plugin.settings.clipServerEnabled = value;
          if (value && !this.plugin.settings.clipServerToken) {
            this.plugin.settings.clipServerToken = generateToken();
          }
          await this.plugin.saveSettings();
          this.plugin.applyClipServerState();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName(t("settings_clip_server_port"))
      .setDesc(t("settings_clip_server_port_desc"))
      .addText((text) =>
        text
          .setPlaceholder("27124")
          .setValue(String(this.plugin.settings.clipServerPort))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (Number.isFinite(n) && n >= 1024 && n <= 65535) {
              this.plugin.settings.clipServerPort = n;
              await this.plugin.saveSettings();
              this.plugin.applyClipServerState();
            }
          }),
      );

    const tokenSetting = new Setting(containerEl)
      .setName(t("settings_clip_server_token"))
      .setDesc(t("settings_clip_server_token_desc"));
    tokenSetting.addText((text) => {
      text
        .setValue(this.plugin.settings.clipServerToken)
        .setDisabled(true);
      text.inputEl.addClass("jotdrop-clip-token-input");
    });
    tokenSetting.addButton((btn) =>
      btn
        .setButtonText(t("settings_clip_server_copy"))
        .onClick(async () => {
          await navigator.clipboard.writeText(this.plugin.settings.clipServerToken);
          new Notice(t("notice_token_copied"));
        }),
    );
    tokenSetting.addButton((btn) =>
      btn
        .setButtonText(t("settings_clip_server_regenerate"))
        .setWarning()
        .onClick(async () => {
          this.plugin.settings.clipServerToken = generateToken();
          await this.plugin.saveSettings();
          this.plugin.applyClipServerState();
          this.display();
          new Notice(t("notice_token_regenerated"));
        }),
    );

    this.displayCloud(containerEl.createDiv({ cls: "jotdrop-cloud-settings" }));

    // "About JotDrop" — unobtrusive, dismisses itself if the user has no
    // interest. No popups, no "premium" features. Open source +
    // optional thank-you button.
    const support = containerEl.createDiv({ cls: "jotdrop-support" });
    new Setting(support).setName(t("section_support")).setHeading();
    support.createEl("p", { text: t("support_blurb") });
    const buttonRow = support.createDiv({ cls: "jotdrop-support-buttons" });
    const kofiLink = buttonRow.createEl("a", {
      cls: "jotdrop-support-button",
      attr: { href: "https://ko-fi.com/L3L11ZETB9", target: "_blank", rel: "noopener noreferrer" },
    });
    kofiLink.setText(t("support_kofi"));
    // GitHub Sponsors will be added once the application is approved.
  }

  /** JotDrop Cloud: the same account as the website and the Android app. */
  private displayCloud(el: HTMLElement): void {
    const cloud = this.plugin.cloud;
    const refresh = () => { el.empty(); this.displayCloud(el); };
    this.cloudListener?.();
    this.cloudAccountStop?.();
    this.cloudAccountStop = undefined;
    // Sign-in and on/off redraw everything; a sync only updates the status line.
    const shown = { signedIn: cloud.signedIn, enabled: cloud.enabled };
    let statusRow: Setting | undefined;
    let showConflicts = () => {};
    const statusText = () => `${cloud.status}${cloud.lastSynced ? ` Last sync: ${new Date(cloud.lastSynced).toLocaleString()}.` : ""}`;
    this.cloudListener = cloud.onChange(() => {
      if (!el.isConnected) return;
      if (cloud.signedIn !== shown.signedIn || cloud.enabled !== shown.enabled || !statusRow) refresh();
      else { statusRow.setDesc(statusText()); showConflicts(); }
    });
    new Setting(el).setName("JotDrop Cloud").setHeading();
    el.createEl("p", { text: "Optional. Sync your JotDrop notes with the website and the Android app, end-to-end encrypted: notes are locked on this device before they leave it. Without the cloud, everything keeps working offline." });
    if (!cloud.signedIn) {
      new Setting(el).setName("Account").setDesc(cloud.status)
        .addButton((button) => button.setButtonText("Create account").onClick(() => cloud.showSignIn(true)))
        .addButton((button) => button.setButtonText("Log in").setCta().onClick(() => cloud.showSignIn(false)));
      new Setting(el).setName("Server").setDesc("Leave this as it is unless you run your own JotDrop Cloud server.")
        .addText((text) => text.setPlaceholder("https://api.jotdrop.net").setValue(this.plugin.settings.cloudServer).onChange(async (value) => {
          this.plugin.settings.cloudServer = value.trim() || "https://api.jotdrop.net";
          await this.plugin.saveSettings();
        }));
      return;
    }
    new Setting(el).setName("Account").setDesc(`Logged in as ${cloud.email}.`)
      .addButton((button) => button.setButtonText("Log out").onClick(() => {
        new ConfirmModal(this.app, {
          title: "Log out of JotDrop Cloud?",
          message: "Sync stops on this device. Your notes stay in this vault and in the cloud. To come back, log in with your email and password.",
          confirmLabel: "Log out",
        }, () => { void cloud.logOut().then(refresh, (error) => new Notice(error instanceof Error ? error.message : String(error), 10000)); }).open();
      }));
    new Setting(el).setName("Sync this vault").setDesc(cloud.enabled ? "On: notes and attachments sync automatically." : "Off: nothing in this vault is sent to the cloud.")
      .addToggle((toggle) => toggle.setValue(cloud.enabled).onChange((on) => {
        if (on) cloud.confirmEnable(refresh);
        else void cloud.setEnabled(false).then(refresh);
      }));
    statusRow = new Setting(el).setName("Status").setDesc(statusText())
      .addButton((button) => button.setButtonText("Sync now").setDisabled(!cloud.enabled).onClick(async () => {
        button.setDisabled(true);
        try { await cloud.syncNow(); } catch (error) { new Notice(error instanceof Error ? error.message : String(error), 10000); }
        finally { button.setDisabled(false); }
      }));
    const conflicts = el.createDiv();
    // After every sync: a conflict can appear, and a choice in the review window settles one.
    showConflicts = () => void cloud.conflicts().then((list) => {
      conflicts.empty();
      if (!list.length || !el.isConnected) return;
      new Setting(conflicts).setName("Conflicts").setDesc(`${list.length === 1 ? "1 note was" : `${list.length} notes were`} changed in two places. Choose which version to keep.`)
        .addButton((button) => button.setButtonText("Review conflicts").setCta().onClick(() => new ConflictReviewModal(this.app, cloud).open()));
    }, () => {});
    if (cloud.enabled) showConflicts();
    new Setting(el).setName("Time machine").setDesc("See your notes as they were at an earlier moment, and go back to it.")
      .addButton((button) => button.setButtonText("Open time machine").onClick(() => new TimeMachineModal(this.app, cloud).open()));
    this.cloudAccountStop = renderCloudAccount(this.app, el.createDiv(), cloud);
  }

  hide(): void {
    this.cloudListener?.();
    this.cloudListener = undefined;
    this.cloudAccountStop?.();
    this.cloudAccountStop = undefined;
  }
}

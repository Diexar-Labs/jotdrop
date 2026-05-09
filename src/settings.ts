import { App, PluginSettingTab, Setting } from "obsidian";
import type DiexarKeepPlugin from "./main";

export type SortMode = "modified-desc" | "modified-asc" | "created-desc" | "created-asc" | "title-asc";

export interface DiexarKeepSettings {
  notesFolder: string;
  archiveFolder: string;
  sortMode: SortMode;
  cardWidth: number;
  showArchived: boolean;
}

export const DEFAULT_SETTINGS: DiexarKeepSettings = {
  notesFolder: "Mini Notes",
  archiveFolder: "Mini Notes/Archive",
  sortMode: "modified-desc",
  cardWidth: 240,
  showArchived: false,
};

export class DiexarKeepSettingTab extends PluginSettingTab {
  plugin: DiexarKeepPlugin;

  constructor(app: App, plugin: DiexarKeepPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Notitie-map")
      .setDesc("Map waarin nieuwe Keep-notities komen.")
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
      .setName("Archief-map")
      .setDesc("Map waarheen gearchiveerde notities verplaatst worden.")
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
      .setName("Sortering")
      .setDesc("Volgorde waarin kaartjes verschijnen.")
      .addDropdown((dd) =>
        dd
          .addOptions({
            "modified-desc": "Laatst bewerkt eerst",
            "modified-asc": "Oudst bewerkt eerst",
            "created-desc": "Nieuwst aangemaakt eerst",
            "created-asc": "Oudst aangemaakt eerst",
            "title-asc": "Titel A-Z",
          })
          .setValue(this.plugin.settings.sortMode)
          .onChange(async (value) => {
            this.plugin.settings.sortMode = value as SortMode;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName("Kaart-breedte")
      .setDesc("Minimale breedte van een kaartje in pixels.")
      .addSlider((s) =>
        s
          .setLimits(180, 360, 10)
          .setValue(this.plugin.settings.cardWidth)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.cardWidth = value;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName("Toon archief")
      .setDesc("Laat ook gearchiveerde kaartjes zien in de hoofdweergave.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showArchived).onChange(async (value) => {
          this.plugin.settings.showArchived = value;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );
  }
}

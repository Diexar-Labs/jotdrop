import { Plugin, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS, DiexarKeepSettings, DiexarKeepSettingTab } from "./settings";
import { DiexarKeepView, VIEW_TYPE_DIEXAR_KEEP } from "./view";
import { QuickCaptureModal } from "./capture";
import { PreviewRescue } from "./previewRescue";

export default class DiexarKeepPlugin extends Plugin {
  settings!: DiexarKeepSettings;
  private refreshTimer: number | null = null;
  // Paden waarvan we de volgende modify-event willen negeren: gebruikt bij
  // in-place updates (bv. kleurwissel) zodat de grid niet hersorteert door mtime.
  private readonly suppressedPaths: Set<string> = new Set();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_DIEXAR_KEEP, (leaf) => new DiexarKeepView(leaf, this));

    this.addRibbonIcon("sticky-note", "Open Diexar Keep", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-diexar-keep",
      name: "Open Keep-weergave",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "quick-capture-keep",
      name: "Snelle notitie (quick capture)",
      callback: () => new QuickCaptureModal(this.app, this).open(),
    });

    this.addSettingTab(new DiexarKeepSettingTab(this.app, this));

    this.registerEvent(this.app.vault.on("create", () => this.refreshViews()));
    this.registerEvent(this.app.vault.on("delete", () => this.refreshViews()));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (this.suppressedPaths.has(file.path)) {
        this.suppressedPaths.delete(file.path);
        return;
      }
      this.refreshViews();
    }));
    this.registerEvent(this.app.vault.on("rename", () => this.refreshViews()));

    const rescue = new PreviewRescue(this);
    rescue.start();

    this.addCommand({
      id: "rescue-pending-previews",
      name: "Pending OG-previews nu ophalen",
      callback: () => { void rescue.rescueAllNow(); },
    });

    this.app.workspace.onLayoutReady(() => {
      // niets opdwingen — gebruiker opent zelf via ribbon of command
    });
  }

  onunload(): void {
    // Obsidian sluit de view automatisch
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_DIEXAR_KEEP);
    let leaf: WorkspaceLeaf | null;
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_DIEXAR_KEEP, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  /**
   * Markeer dat de eerstvolgende modify-event voor dit pad genegeerd moet worden.
   * Wordt gebruikt bij in-place metadata-updates (kleurwissel) zodat de grid
   * niet hersorteert vanwege de bumpende mtime. Auto-clear na 2s als veiligheid.
   */
  suppressModifyOnce(path: string): void {
    this.suppressedPaths.add(path);
    window.setTimeout(() => this.suppressedPaths.delete(path), 2000);
  }

  refreshViews(): void {
    if (this.refreshTimer != null) {
      window.clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DIEXAR_KEEP);
      for (const leaf of leaves) {
        const view = leaf.view;
        if (view instanceof DiexarKeepView) {
          void view.render();
        }
      }
    }, 150);
  }
}

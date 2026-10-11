import { App, TFile, normalizePath } from "obsidian";
import { readLabels, readMeta } from "./metadata";
import { t } from "./i18n";

export interface LabelInfo {
  name: string;
  count: number;
}

function isValidLabelName(name: string): boolean {
  if (!name || !name.trim()) return false;
  if (/[\x00-\x1f\x7f-\x9f]/.test(name)) return false;
  return true;
}

function labelsMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Discovers all labels from `jotdrop_labels` frontmatter in managed folders
 * (notesFolder + archiveFolder). Returns sorted by name. Does NOT discover
 * vault-wide tags — labels are strictly separated. Case-insensitive dedup
 * merges counts for case variants (e.g. "Work" and "work" count as one).
 */
export async function discoverLabels(
  app: App,
  notesFolder: string,
  archiveFolder: string,
): Promise<LabelInfo[]> {
  const root = normalizePath(notesFolder);
  const archive = normalizePath(archiveFolder);
  const freq = new Map<string, number>();
  const canonical = new Map<string, string>();

  for (const file of app.vault.getMarkdownFiles()) {
    if (!isUnder(file.path, root) && !isUnder(file.path, archive)) continue;
    try {
      const meta = readMeta(app, file);
      for (const label of meta.labels) {
        const lower = label.toLowerCase();
        const existing = canonical.get(lower);
        if (existing !== undefined) {
          freq.set(existing, freq.get(existing)! + 1);
        } else {
          canonical.set(lower, label);
          freq.set(label, 1);
        }
      }
    } catch {
      // Unreadable file must not block discovery.
    }
  }

  return Array.from(freq.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Creates a label: validates name, checks for case-insensitive collisions,
 * then persists it into `localLabels`. Does NOT create any files or folders —
 * labels are virtual collections. Returns the updated localLabels array on
 * success.
 */
export async function createLabel(
  app: App,
  name: string,
  notesFolder: string,
  archiveFolder: string,
  localLabels: string[],
): Promise<{ success: boolean; error?: string; labels?: string[] }> {
  if (!isValidLabelName(name)) return { success: false, error: t("label_placeholder") };
  const trimmed = name.trim();
  const discovered = await discoverLabels(app, notesFolder, archiveFolder);
  if (discovered.some((l) => labelsMatch(l.name, trimmed))) {
    return { success: false, error: t("notice_target_exists") };
  }
  if (localLabels.some((l) => labelsMatch(l, trimmed))) {
    return { success: false, error: t("notice_target_exists") };
  }
  const next = [...localLabels, trimmed];
  return { success: true, labels: next };
}

/**
 * Renames a label across all managed notes. Scans only managed folders
 * (notesFolder + archive). Updates fresh current metadata via processFrontMatter.
 * Does NOT delete notes or tags. Returns proper failure info on errors.
 * Case-insensitive: matches existing labels ignoring case.
 */
export async function renameLabel(
  app: App,
  oldName: string,
  newName: string,
  notesFolder: string,
  archiveFolder: string,
): Promise<{ success: boolean; updated: number; error?: string }> {
  if (!isValidLabelName(newName)) {
    return { success: false, updated: 0, error: t("label_placeholder") };
  }
  if (!oldName) {
    return { success: false, updated: 0, error: t("label_placeholder") };
  }
  const trimmed = newName.trim();
  const root = normalizePath(notesFolder);
  const archive = normalizePath(archiveFolder);
  let updated = 0;
  let failed = 0;

  for (const file of app.vault.getMarkdownFiles()) {
    if (!isUnder(file.path, root) && !isUnder(file.path, archive)) continue;
    try {
      let changed = false;
      await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        const current = readLabels(fm.jotdrop_labels);
        if (!current.some((label) => labelsMatch(label, oldName))) return;
        fm.jotdrop_labels = readLabels(current.map((label) => labelsMatch(label, oldName) ? trimmed : label));
        changed = true;
      });
      if (changed) updated++;
    } catch {
      failed++;
    }
  }

  if (failed > 0) {
    return { success: false, updated, error: t("notice_error", t("label_rename_error", String(failed))) };
  }
  return { success: true, updated };
}

/**
 * Deletes a label from all managed notes. Scans only managed folders.
 * Does NOT delete notes or tags. Case-insensitive: removes all case variants.
 */
export async function deleteLabel(
  app: App,
  name: string,
  notesFolder: string,
  archiveFolder: string,
): Promise<{ success: boolean; removed: number; error?: string }> {
  if (!name || !name.trim()) return { success: false, removed: 0, error: t("label_placeholder") };
  const root = normalizePath(notesFolder);
  const archive = normalizePath(archiveFolder);
  let removed = 0;
  let failed = 0;

  for (const file of app.vault.getMarkdownFiles()) {
    if (!isUnder(file.path, root) && !isUnder(file.path, archive)) continue;
    try {
      let changed = false;
      await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        const current = readLabels(fm.jotdrop_labels);
        if (!current.some((label) => labelsMatch(label, name))) return;
        const next = current.filter((label) => !labelsMatch(label, name));
        if (next.length) fm.jotdrop_labels = next;
        else delete fm.jotdrop_labels;
        changed = true;
      });
      if (changed) removed++;
    } catch {
      failed++;
    }
  }

  if (failed > 0) {
    return { success: false, removed, error: t("notice_error", t("label_delete_error", String(failed))) };
  }
  return { success: true, removed };
}

/**
 * Assigns a label to a note via processFrontMatter, reading the live frontmatter
 * (not a cached snapshot) so concurrent assignments are preserved. Case-insensitive:
 * no-op if a case variant already exists.
 */
export async function assignLabel(app: App, file: TFile, labelName: string): Promise<void> {
  if (!isValidLabelName(labelName)) throw new Error(t("label_placeholder"));
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    const current = readLabels(fm.jotdrop_labels);
    if (current.some((label) => labelsMatch(label, labelName))) return;
    fm.jotdrop_labels = [...current, labelName.trim()];
  });
}

/**
 * Removes a label from a note via processFrontMatter, reading the live
 * frontmatter so concurrent modifications are preserved. Case-insensitive.
 */
export async function removeLabel(app: App, file: TFile, labelName: string): Promise<void> {
  if (!isValidLabelName(labelName)) throw new Error(t("label_placeholder"));
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    const current = readLabels(fm.jotdrop_labels);
    if (!current.some((label) => labelsMatch(label, labelName))) return;
    const next = current.filter((label) => !labelsMatch(label, labelName));
    if (next.length) fm.jotdrop_labels = next;
    else delete fm.jotdrop_labels;
  });
}

function isUnder(filePath: string, folderPath: string): boolean {
  if (!folderPath) return false;
  const f = folderPath.replace(/\/+$/, "");
  return filePath === f || filePath.startsWith(`${f}/`);
}

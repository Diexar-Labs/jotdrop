import { normalizePath } from "obsidian";

/**
 * Normalizes a user-supplied, vault-relative assets folder. Mirrored by
 * `Storage.normalizeAssetsFolder()` in the Android app so both platforms
 * accept and canonicalize the same values.
 *
 * Returns:
 * - `""`   when the input is blank (meaning: reset to the dynamic default),
 * - the canonical forward-slash path when valid, or
 * - `null` when the input is invalid (vault escape, drive/URI path, absolute
 *   path, or characters that are illegal in a vault path).
 */
export function normalizeAssetsFolder(input: string): string | null {
  const trimmed = input.replace(/\\/g, "/").trim();
  if (trimmed === "") return "";
  // A colon marks a drive letter (C:) or a URI/scheme (https:, app:) — neither
  // is a valid vault-relative folder.
  if (trimmed.includes(":")) return null;
  if (trimmed.startsWith("/")) return null;
  if (trimmed.startsWith("~")) return null;
  const segments = trimmed.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  if (segments.some((s) => s === "." || s === "..")) return null;
  // Characters Obsidian refuses in vault paths.
  if (/[<>"|?*\u0000-\u001f]/.test(trimmed)) return null;
  return normalizePath(segments.join("/"));
}

/**
 * The legacy default assets location: `.attachments` inside the notes folder.
 * Used both as the dynamic fallback when no explicit folder is set and as the
 * "reset" comparison target in settings.
 */
export function legacyAssetsPath(notesFolder: string): string {
  return normalizePath(`${notesFolder}/.attachments`);
}

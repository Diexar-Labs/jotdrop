/**
 * Lightweight i18n module for ObsiDrop.
 *
 * Detects the user's Obsidian interface language and looks up strings against
 * the matching translation map. Falls back to English when a key is missing.
 *
 * Languages currently shipped: en (default), nl (Dutch). Stubs are present
 * for es/de/fr/it — fill them in and they take over automatically.
 *
 * Placeholders in strings use `{0}`, `{1}`, … and are replaced positionally
 * by extra args to `t()`.
 */

export type Lang = "en" | "nl" | "es" | "de" | "fr" | "it";

const SUPPORTED: ReadonlyArray<Lang> = ["en", "nl", "es", "de", "fr", "it"];

const EN: Record<string, string> = {
  // App / commands
  open_obsidrop: "Open ObsiDrop",
  cmd_open_view: "Open Keep view",
  cmd_quick_capture: "Quick note (quick capture)",
  cmd_rescue_previews: "Fetch pending OG previews now",
  view_title: "ObsiDrop",

  // Actions
  action_cancel: "Cancel",
  action_save: "Save",
  action_close: "Close",
  action_more: "More",
  action_edit: "Edit",
  action_archive: "Archive",
  action_unarchive: "Restore from archive",
  action_delete: "Delete card",
  action_open_in_tab: "Open in new tab",
  action_open_link: "Open link",
  action_color: "Color",
  action_pin: "Pin",
  action_unpin: "Unpin",
  action_pin_btn: "📍 Pin",
  action_unpin_btn: "📌 Pinned",
  action_insert_link: "🔗 Insert link",
  action_checklist: "☑ Checklist item",
  action_new_note: "New note",

  // Labels
  label_color: "Color:",
  label_tags: "Tags:",
  tag_input_placeholder: "Add tag…",
  search_placeholder: "Search notes…",
  link_picker_placeholder: "Search a note to link to…",

  // Capture modal
  capture_title: "Quick note",
  capture_placeholder:
    "Dump your thought, idea or task here…\n\nUse [[Link]] to wikilink.",
  capture_hint: "Ctrl/Cmd + Enter = save • Esc = close",

  // Empty / sections
  empty_no_notes_title: "No notes yet",
  empty_no_notes_desc:
    'Click "New note" or use the hotkey to create your first card.',
  section_pinned: "Pinned",
  section_other: "Other",

  // Notices
  notice_empty: "Nothing to save — card is empty.",
  notice_fetching_preview: "Fetching preview…",
  notice_saved: "Saved: {0}",
  notice_save_failed: "Save failed: {0}",
  notice_pending_attempted: "ObsiDrop: attempted {0} pending note(s)",
  notice_error: "Error: {0}",
  notice_deleted: "Deleted: {0}",
  notice_note_not_found: "Note not found: {0}",

  // Settings
  settings_notes_folder: "Notes folder",
  settings_notes_folder_desc: "Folder where new Keep notes are stored.",
  settings_archive_folder: "Archive folder",
  settings_archive_folder_desc:
    "Folder where archived notes are moved to.",
  settings_sort: "Sort order",
  settings_sort_desc: "Order in which cards appear.",
  sort_modified_desc: "Last edited first",
  sort_modified_asc: "Oldest edited first",
  sort_created_desc: "Newest created first",
  sort_created_asc: "Oldest created first",
  sort_title_asc: "Title A-Z",
  settings_card_width: "Card width",
  settings_card_width_desc: "Minimum width of a card in pixels.",
  settings_show_archived: "Show archive",
  settings_show_archived_desc:
    "Also show archived cards in the main view.",

  // Support section
  section_support: "About ObsiDrop",
  support_blurb:
    "ObsiDrop is free and open-source. Found it useful? A coffee or sponsorship makes my day — no obligations, no lock-ins.",
  support_kofi: "☕ Buy me a Ko-fi",
  support_sponsors: "❤ Sponsor on GitHub",

  // Note colors
  color_default: "Default",
  color_red: "Red",
  color_orange: "Orange",
  color_yellow: "Yellow",
  color_green: "Cream",
  color_teal: "Slate blue",
  color_blue: "Blue",
  color_purple: "Purple",
  color_pink: "Pink",
  color_brown: "Brown",
  color_gray: "Gray",
};

const NL: Record<string, string> = {
  open_obsidrop: "Open ObsiDrop",
  cmd_open_view: "Open Keep-weergave",
  cmd_quick_capture: "Snelle notitie (quick capture)",
  cmd_rescue_previews: "Pending OG-previews nu ophalen",
  view_title: "ObsiDrop",

  action_cancel: "Annuleren",
  action_save: "Opslaan",
  action_close: "Sluiten",
  action_more: "Meer",
  action_edit: "Bewerken",
  action_archive: "Archiveren",
  action_unarchive: "Terug uit archief",
  action_delete: "Verwijder kaartje",
  action_open_in_tab: "Open in nieuw tabblad",
  action_open_link: "Link openen",
  action_color: "Kleur",
  action_pin: "Vastzetten",
  action_unpin: "Losmaken",
  action_pin_btn: "📍 Vastzetten",
  action_unpin_btn: "📌 Vastgezet",
  action_insert_link: "🔗 Link invoegen",
  action_checklist: "☑ Checklist-item",
  action_new_note: "Nieuwe notitie",

  label_color: "Kleur:",
  label_tags: "Tags:",
  tag_input_placeholder: "Voeg tag toe…",
  search_placeholder: "Zoeken in notities…",
  link_picker_placeholder: "Zoek notitie om naar te linken…",

  capture_title: "Snelle notitie",
  capture_placeholder:
    "Dump hier je gedachte, idee of taak…\n\nGebruik [[Link]] om te koppelen.",
  capture_hint: "Ctrl/Cmd + Enter = opslaan • Esc = sluiten",

  empty_no_notes_title: "Nog geen notities",
  empty_no_notes_desc:
    'Klik op "Nieuwe notitie" of gebruik de hotkey om je eerste kaartje te maken.',
  section_pinned: "Vastgezet",
  section_other: "Overige",

  notice_empty: "Niets te bewaren — kaartje is leeg.",
  notice_fetching_preview: "Preview ophalen…",
  notice_saved: "Opgeslagen: {0}",
  notice_save_failed: "Fout bij opslaan: {0}",
  notice_pending_attempted: "ObsiDrop: {0} pending-notitie(s) geprobeerd",
  notice_error: "Fout: {0}",
  notice_deleted: "Verwijderd: {0}",
  notice_note_not_found: "Geen notitie gevonden: {0}",

  settings_notes_folder: "Notitie-map",
  settings_notes_folder_desc: "Map waarin nieuwe Keep-notities komen.",
  settings_archive_folder: "Archief-map",
  settings_archive_folder_desc:
    "Map waarheen gearchiveerde notities verplaatst worden.",
  settings_sort: "Sortering",
  settings_sort_desc: "Volgorde waarin kaartjes verschijnen.",
  sort_modified_desc: "Laatst bewerkt eerst",
  sort_modified_asc: "Oudst bewerkt eerst",
  sort_created_desc: "Nieuwst aangemaakt eerst",
  sort_created_asc: "Oudst aangemaakt eerst",
  sort_title_asc: "Titel A-Z",
  settings_card_width: "Kaart-breedte",
  settings_card_width_desc: "Minimale breedte van een kaartje in pixels.",
  settings_show_archived: "Toon archief",
  settings_show_archived_desc:
    "Laat ook gearchiveerde kaartjes zien in de hoofdweergave.",

  section_support: "Over ObsiDrop",
  support_blurb:
    "ObsiDrop is gratis en open-source. Vind je het waardevol? Een koffie of sponsorship maakt mijn dag — geen verplichting, geen lock-ins.",
  support_kofi: "☕ Trakteer op Ko-fi",
  support_sponsors: "❤ Word sponsor op GitHub",

  color_default: "Standaard",
  color_red: "Rood",
  color_orange: "Oranje",
  color_yellow: "Geel",
  color_green: "Crème",
  color_teal: "Leiblauw",
  color_blue: "Blauw",
  color_purple: "Paars",
  color_pink: "Roze",
  color_brown: "Bruin",
  color_gray: "Grijs",
};

// Stubs — values left empty, falls through to EN automatically.
const ES: Record<string, string> = {};
const DE: Record<string, string> = {};
const FR: Record<string, string> = {};
const IT: Record<string, string> = {};

const TABLES: Record<Lang, Record<string, string>> = {
  en: EN,
  nl: NL,
  es: ES,
  de: DE,
  fr: FR,
  it: IT,
};

let cachedLang: Lang | null = null;

/**
 * Reads Obsidian's interface language from localStorage. Strips region suffix
 * (en-US → en) and returns "en" when the language isn't supported. Cached on
 * first call; call `resetLangCache()` after a manual change.
 */
export function getLang(): Lang {
  if (cachedLang) return cachedLang;
  let raw = "";
  try {
    raw = window.localStorage.getItem("language") ?? "";
  } catch {
    // localStorage not available (rare)
  }
  const short = raw.split("-")[0].toLowerCase();
  cachedLang = (SUPPORTED as ReadonlyArray<string>).includes(short)
    ? (short as Lang)
    : "en";
  return cachedLang;
}

export function resetLangCache(): void {
  cachedLang = null;
}

/**
 * Translation lookup. Resolves `key` against the active language table, falls
 * back to English, then to the raw key. Positional `{0}`, `{1}`, … are
 * replaced by the extra args.
 */
export function t(key: string, ...args: string[]): string {
  const lang = getLang();
  const value = TABLES[lang]?.[key] || EN[key] || key;
  if (args.length === 0) return value;
  return args.reduce(
    (acc, arg, i) => acc.split(`{${i}}`).join(arg),
    value,
  );
}

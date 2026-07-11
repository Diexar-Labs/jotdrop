/**
 * Lightweight i18n module for JotDrop.
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

import { getLanguage } from "obsidian";

export type Lang = "en" | "nl" | "es" | "de" | "fr" | "it";

const SUPPORTED: ReadonlyArray<Lang> = ["en", "nl", "es", "de", "fr", "it"];

const EN: Record<string, string> = {
  // App / commands
  open_jotdrop: "Open JotDrop",
  cmd_open_view: "Open Keep view",
  cmd_quick_capture: "Quick note (quick capture)",
  cmd_rescue_previews: "Fetch pending OG previews now",
  cmd_neutralize_hashtags: "Neutralize inline hashtags in existing notes",
  view_title: "JotDrop",

  // Actions
  action_cancel: "Cancel",
  action_save: "Save",
  action_close: "Close",
  nav_prev_note: "Previous note",
  nav_next_note: "Next note",
  action_more: "More",
  action_edit: "Edit",
  action_archive: "Archive",
  action_unarchive: "Restore from archive",
  action_delete: "Delete card",
  action_move_to_folder: "Move to folder…",
  action_copy_to_folder: "Copy to folder…",
  action_open_in_tab: "Open in new tab",
  folder_picker_move_placeholder: "Move note to folder…",
  folder_picker_copy_placeholder: "Copy note to folder…",
  folder_root_label: "(vault root)",
  notice_moved: "Moved to: {0}",
  notice_copied: "Copied to: {0}",
  notice_target_exists: "A note with that name already exists in the target folder.",
  action_open_link: "Open link",
  action_color: "Color",
  action_pin: "Pin",
  action_unpin: "Unpin",
  action_pin_btn: "📍 Pin",
  action_unpin_btn: "📌 Pinned",
  action_insert_link: "🔗 Insert link",
  action_checklist: "☑ Checklist item",
  action_new_note: "New note",
  action_edit_note: "Edit note",
  action_start_recording: "Record voice memo",
  action_stop_recording: "Stop recording",
  record_start_failed: "Could not start recording: {0}",
  record_too_short: "Recording too short or failed.",
  record_save_failed: "Could not save voice memo: {0}",
  record_saved: "Voice memo saved.",
  record_confirm_title: "Save voice memo?",
  record_confirm_message: "Voice memo of {0} — save it as a new card?",
  audio_load_failed: "Audio unavailable",
  voice_memo_card_label: "Voice memo",
  lightbox_open_in_tab: "Open image in tab",
  lightbox_open_external: "Open externally",
  lightbox_load_failed: "Image could not be loaded.",

  // Labels
  label_color: "Color:",
  label_tags: "Tags:",
  tag_input_placeholder: "Add tag…",
  search_placeholder: "Search notes…",
  link_picker_placeholder: "Search a note to link to…",
  link_chip_more_tooltip: "Open card to see all links",
  tag_filter_clear: "Clear filter",
  tag_overflow_more: "+{0} more",
  tag_sheet_title: "All tags",
  tag_sheet_search: "Search tags…",
  tag_sheet_empty: "No tags found.",
  empty_no_results: "No notes match your search.",
  empty_no_results_clear: "Clear search & filter",
  selection_count: "{0} selected",
  action_select_all: "Select all",
  action_exit_selection: "Exit selection",
  bulk_archive_title: "Archive {0} notes?",
  bulk_archive_message: "The selected notes will be moved to the archive folder.",
  bulk_delete_title: "Delete {0} notes?",
  bulk_delete_message: "This cannot be undone. Make sure your sync (e.g. Syncthing) is running on all devices first — an offline peer may resurrect these files when it reconnects.",
  notice_bulk_archived: "{0} notes archived",
  notice_bulk_deleted: "{0} notes deleted",
  notice_bulk_partial: "{0} done, {1} failed",

  // Capture modal
  capture_title: "Quick note",
  title_input_placeholder: "Title (optional)",
  capture_placeholder:
    "Dump your thought, idea or task here…\n\nUse [[Link]] to wikilink.",
  capture_hint: "Ctrl/Cmd + Enter = save • Esc = close",

  // Empty / sections
  empty_no_notes_title: "No notes yet",
  empty_no_notes_desc:
    'Click "New note" or use the hotkey to create your first card.',
  empty_no_notes_app_hint:
    "Don't forget the Android app and the Chrome web clipper — together they give JotDrop that true Google Keep feeling.",
  empty_no_notes_app_link: "Get them →",
  section_pinned: "Pinned",
  section_other: "Other",

  // Notices
  notice_empty: "Nothing to save — card is empty.",
  notice_fetching_preview: "Fetching preview…",
  notice_saved: "Saved: {0}",
  notice_save_failed: "Save failed: {0}",
  notice_pending_attempted: "JotDrop: attempted {0} pending note(s)",
  notice_neutralized: "Neutralized hashtags in {0} note(s)",
  notice_neutralized_none: "No inline hashtags found — nothing to do.",
  notice_error: "Error: {0}",
  notice_deleted: "Deleted: {0}",
  notice_note_not_found: "Note not found: {0}",
  notice_archived: "Archived: {0}",
  notice_unarchived: "Restored from archive: {0}",

  // Reminders
  label_reminder: "Reminder:",
  action_clear_reminder: "Clear",
  reminder_now: "now",
  reminder_just_overdue: "just overdue",
  reminder_in_min: "in {0} min",
  reminder_min_overdue: "{0} min overdue",
  reminder_in_hr: "in {0} h",
  reminder_hr_overdue: "{0} h overdue",
  reminder_in_day: "in {0} d",
  reminder_day_overdue: "{0} d overdue",
  reminder_badge_due: "⏰ Due",
  reminder_badge_overdue: "⚠ Overdue",
  notice_reminder_fired: "Reminder: {0}",

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
  settings_download_images: "Save article images",
  settings_download_images_desc:
    "Download the article thumbnail and save it in your vault when capturing a URL. Turn off to save only the title and link.",

  // Companion apps (the JotDrop trio)
  section_companions: "JotDrop is a trio",
  companions_blurb:
    "This plugin is one third of JotDrop. For the full Google Keep experience, also install the free Android app (share-sheet capture, OCR, voice memos) and the Chrome web clipper. All three meet in your vault.",
  companions_download: "⬇ Get the Android app & web clipper",

  // Clip server (Chrome extension)
  settings_clip_server_section: "Web clipper (Chrome extension)",
  settings_clip_server_desc:
    "Run a tiny localhost server (127.0.0.1 only) so the JotDrop Chrome extension can save pages here. The extension needs the token below; paste it into the extension's options page.",
  settings_clip_server_enabled: "Enable clip server",
  settings_clip_server_enabled_desc:
    "Only binds to 127.0.0.1, never the network. Off by default.",
  settings_clip_server_port: "Port",
  settings_clip_server_port_desc: "1024–65535. Default 27124.",
  settings_clip_server_token: "Token",
  settings_clip_server_token_desc:
    "Shared secret between this plugin and the extension. Treat like a password.",
  settings_clip_server_copy: "Copy",
  settings_clip_server_regenerate: "Regenerate",
  notice_token_copied: "Token copied to clipboard.",
  notice_token_regenerated: "New token generated — paste it in the extension again.",
  notice_clip_server_started: "Clip server listening on 127.0.0.1:{0}",
  notice_clip_server_stopped: "Clip server stopped.",
  notice_clip_server_error: "Clip server error: {0}",
  notice_clip_saved: "Clipped: {0}",

  // Support section
  section_support: "About JotDrop",
  support_blurb:
    "JotDrop is free and open-source. Found it useful? A coffee or sponsorship makes my day — no obligations, no lock-ins.",
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
  open_jotdrop: "Open JotDrop",
  cmd_open_view: "Open Keep-weergave",
  cmd_quick_capture: "Snelle notitie (quick capture)",
  cmd_rescue_previews: "Pending OG-previews nu ophalen",
  cmd_neutralize_hashtags: "Inline hashtags in bestaande notities neutraliseren",
  view_title: "JotDrop",

  action_cancel: "Annuleren",
  action_save: "Opslaan",
  action_close: "Sluiten",
  nav_prev_note: "Vorige notitie",
  nav_next_note: "Volgende notitie",
  action_more: "Meer",
  action_edit: "Bewerken",
  action_archive: "Archiveren",
  action_unarchive: "Terug uit archief",
  action_delete: "Verwijder kaartje",
  action_move_to_folder: "Verplaats naar map…",
  action_copy_to_folder: "Kopieer naar map…",
  action_open_in_tab: "Open in nieuw tabblad",
  folder_picker_move_placeholder: "Verplaats notitie naar map…",
  folder_picker_copy_placeholder: "Kopieer notitie naar map…",
  folder_root_label: "(vault-hoofdmap)",
  notice_moved: "Verplaatst naar: {0}",
  notice_copied: "Gekopieerd naar: {0}",
  notice_target_exists: "Er bestaat al een notitie met die naam in de doelmap.",
  action_open_link: "Link openen",
  action_color: "Kleur",
  action_pin: "Vastzetten",
  action_unpin: "Losmaken",
  action_pin_btn: "📍 Vastzetten",
  action_unpin_btn: "📌 Vastgezet",
  action_insert_link: "🔗 Link invoegen",
  action_checklist: "☑ Checklist-item",
  action_new_note: "Nieuwe notitie",
  action_start_recording: "Voicememo opnemen",
  action_stop_recording: "Opname stoppen",
  record_start_failed: "Opname kon niet starten: {0}",
  record_too_short: "Opname te kort of mislukt.",
  record_save_failed: "Voicememo kon niet worden opgeslagen: {0}",
  record_saved: "Voicememo opgeslagen.",
  record_confirm_title: "Voicememo opslaan?",
  record_confirm_message: "Voicememo van {0} — opslaan als nieuwe kaart?",
  audio_load_failed: "Audio niet beschikbaar",
  voice_memo_card_label: "Voicememo",
  action_edit_note: "Notitie bewerken",
  lightbox_open_in_tab: "Afbeelding in tab openen",
  lightbox_open_external: "Extern openen",
  lightbox_load_failed: "Afbeelding kon niet geladen worden.",

  label_color: "Kleur:",
  label_tags: "Tags:",
  tag_input_placeholder: "Voeg tag toe…",
  search_placeholder: "Zoeken in notities…",
  link_picker_placeholder: "Zoek notitie om naar te linken…",
  link_chip_more_tooltip: "Open kaart om alle links te zien",
  tag_filter_clear: "Filter wissen",
  tag_overflow_more: "+{0} meer",
  tag_sheet_title: "Alle tags",
  tag_sheet_search: "Zoek tags…",
  tag_sheet_empty: "Geen tags gevonden.",
  empty_no_results: "Geen notities komen overeen met je zoekopdracht.",
  empty_no_results_clear: "Zoekopdracht & filter wissen",
  selection_count: "{0} geselecteerd",
  action_select_all: "Alles selecteren",
  action_exit_selection: "Selectie verlaten",
  bulk_archive_title: "{0} notities archiveren?",
  bulk_archive_message: "De geselecteerde notities worden verplaatst naar de archief-map.",
  bulk_delete_title: "{0} notities verwijderen?",
  bulk_delete_message: "Dit kan niet ongedaan worden gemaakt. Zorg dat je sync (bijv. Syncthing) op al je apparaten draait — een offline apparaat kan deze bestanden bij reconnect terugzetten.",
  notice_bulk_archived: "{0} notities gearchiveerd",
  notice_bulk_deleted: "{0} notities verwijderd",
  notice_bulk_partial: "{0} gedaan, {1} mislukt",

  capture_title: "Snelle notitie",
  title_input_placeholder: "Titel (optioneel)",
  capture_placeholder:
    "Dump hier je gedachte, idee of taak…\n\nGebruik [[Link]] om te koppelen.",
  capture_hint: "Ctrl/Cmd + Enter = opslaan • Esc = sluiten",

  empty_no_notes_title: "Nog geen notities",
  empty_no_notes_desc:
    'Klik op "Nieuwe notitie" of gebruik de hotkey om je eerste kaartje te maken.',
  empty_no_notes_app_hint:
    "Vergeet de Android-app en de Chrome-webclipper niet — samen geven ze JotDrop dat échte Google Keep-gevoel.",
  empty_no_notes_app_link: "Download ze →",
  section_pinned: "Vastgezet",
  section_other: "Overige",

  notice_empty: "Niets te bewaren — kaartje is leeg.",
  notice_fetching_preview: "Preview ophalen…",
  notice_saved: "Opgeslagen: {0}",
  notice_save_failed: "Fout bij opslaan: {0}",
  notice_pending_attempted: "JotDrop: {0} pending-notitie(s) geprobeerd",
  notice_neutralized: "Hashtags geneutraliseerd in {0} notitie(s)",
  notice_neutralized_none: "Geen inline hashtags gevonden — niets te doen.",
  notice_error: "Fout: {0}",
  notice_deleted: "Verwijderd: {0}",
  notice_note_not_found: "Geen notitie gevonden: {0}",
  notice_archived: "Gearchiveerd: {0}",
  notice_unarchived: "Terug uit archief: {0}",

  label_reminder: "Herinnering:",
  action_clear_reminder: "Wissen",
  reminder_now: "nu",
  reminder_just_overdue: "net verlopen",
  reminder_in_min: "over {0} min",
  reminder_min_overdue: "{0} min verlopen",
  reminder_in_hr: "over {0} u",
  reminder_hr_overdue: "{0} u verlopen",
  reminder_in_day: "over {0} d",
  reminder_day_overdue: "{0} d verlopen",
  reminder_badge_due: "⏰ Te doen",
  reminder_badge_overdue: "⚠ Verlopen",
  notice_reminder_fired: "Herinnering: {0}",

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
  settings_download_images: "Artikel-afbeeldingen opslaan",
  settings_download_images_desc:
    "Download de thumbnail van een artikel en sla die op in je vault bij het vastleggen van een URL. Zet uit om alleen titel en link op te slaan.",

  section_companions: "JotDrop is een trio",
  companions_blurb:
    "Deze plugin is een derde van JotDrop. Installeer voor de volledige Google Keep-ervaring ook de gratis Android-app (delen vanuit elke app, OCR, spraakmemo's) en de Chrome-web-clipper. Alle drie komen samen in je vault.",
  companions_download: "⬇ Download de Android-app & web-clipper",

  settings_clip_server_section: "Web-clipper (Chrome-extensie)",
  settings_clip_server_desc:
    "Start een klein lokaal servertje (alleen 127.0.0.1) zodat de JotDrop Chrome-extensie pagina's hier kan opslaan. De extensie heeft het token hieronder nodig; plak het in de optie-pagina van de extensie.",
  settings_clip_server_enabled: "Clip-server aanzetten",
  settings_clip_server_enabled_desc:
    "Bindt alleen op 127.0.0.1, nooit op het netwerk. Standaard uit.",
  settings_clip_server_port: "Poort",
  settings_clip_server_port_desc: "1024–65535. Standaard 27124.",
  settings_clip_server_token: "Token",
  settings_clip_server_token_desc:
    "Gedeeld geheim tussen plugin en extensie. Behandel als wachtwoord.",
  settings_clip_server_copy: "Kopiëren",
  settings_clip_server_regenerate: "Opnieuw genereren",
  notice_token_copied: "Token naar klembord gekopieerd.",
  notice_token_regenerated: "Nieuw token aangemaakt — plak 'm opnieuw in de extensie.",
  notice_clip_server_started: "Clip-server luistert op 127.0.0.1:{0}",
  notice_clip_server_stopped: "Clip-server gestopt.",
  notice_clip_server_error: "Clip-server-fout: {0}",
  notice_clip_saved: "Geclipt: {0}",

  section_support: "Over JotDrop",
  support_blurb:
    "JotDrop is gratis en open-source. Vind je het waardevol? Een koffie of sponsorship maakt mijn dag — geen verplichting, geen lock-ins.",
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
 * Reads Obsidian's interface language via `getLanguage()`. Strips region suffix
 * (en-US → en) and returns "en" when the language isn't supported. Cached on
 * first call; call `resetLangCache()` after a manual change.
 */
export function getLang(): Lang {
  if (cachedLang) return cachedLang;
  // Obsidian's own language setting (popout- and platform-safe).
  const raw = getLanguage();
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

<div align="center">

<img src="docs/banner.png" alt="ObsiDrop - Google Keep-style quick-capture for Obsidian and Android" width="720" />

# ObsiDrop

**Google Keep, on your own files.**

A card-grid quick-capture for [Obsidian](https://obsidian.md/) with a matching Android share-target app - sync them with [Syncthing](https://syncthing.net/) and you have Keep, fully offline, fully yours.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Obsidian plugin](https://img.shields.io/badge/Obsidian-plugin-7c3aed)](https://github.com/Diexar-Labs/obsidrop/releases)
[![Android APK](https://img.shields.io/badge/Android-APK-3ddc84)](https://github.com/Diexar-Labs/obsidrop/releases)
[![Build APK](https://github.com/Diexar-Labs/obsidrop/actions/workflows/android-build.yml/badge.svg)](https://github.com/Diexar-Labs/obsidrop/actions/workflows/android-build.yml)

[Download](#install) · [Screenshots](#screenshots) · [How it works](#how-it-works) · [Roadmap](#roadmap)

</div>

---

## Why ObsiDrop?

Google Keep is great - until you remember Google reads everything you put in there. ObsiDrop gives you the same fast, friction-free "dump a thought" experience, but every note is a plain Markdown file in your own Obsidian vault. No cloud account, no ads, no telemetry, no lock-in. Sync between phone and laptop with Syncthing (free) or any folder-sync you already use.

- **Quick capture, anywhere.** Share a link from any Android app → ObsiDrop turns it into a note with a preview card. Open the app, tap once, type, done.
- **Card grid in Obsidian.** A dedicated view shows your notes as Keep-style cards: titles, colors, tags, archived, pinned-on-top. Filter, sort, search.
- **Plain Markdown, always.** Notes are `.md` files with YAML frontmatter. They live in your vault. You can edit them anywhere - Obsidian, VS Code, Vim, mobile.
- **Offline by default.** No server. No account. Works on a plane.
- **Open source, free, no premium tier.** MIT-licensed.

## Screenshots

<!--
IMAGES - to be added to docs/screenshots/ folder:

1. plugin-grid.png   - Obsidian desktop, ObsiDrop card view filled with a handful of colored notes (mix of text, checklist, link-preview cards). 1600×1000 ideal.
2. plugin-edit.png   - A single card open in the edit modal, showing the toolbar (color, tag, checklist toggle, archive).
3. android-capture.png - Android phone screenshot, share-target sheet on a webpage with "ObsiDrop" selected.
4. android-list.png  - Android home screen of ObsiDrop showing the 2-col staggered card grid.
5. android-editor.png - Android editor view with a checklist + photo embed.

For each: use a real-looking dataset (no Lorem Ipsum), warm lighting, no system clutter (turn on Do Not Disturb before screencap).
-->

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/plugin-grid.png" alt="ObsiDrop card grid in Obsidian" width="380" /><br/><sub>Obsidian - card grid</sub></td>
    <td align="center"><img src="docs/screenshots/android-list.png" alt="ObsiDrop Android home screen" width="220" /><br/><sub>Android - home</sub></td>
    <td align="center"><img src="docs/screenshots/android-capture.png" alt="Android share sheet capturing into ObsiDrop" width="220" /><br/><sub>Android - share-to-note</sub></td>
  </tr>
</table>

## Features

### Capture
- Android **share-target** - share any link, text, or image from any app
- **Standalone Android app** for typing/dictating notes directly
- **Voice-to-text** on Android (uses system speech recognizer)
- **OCR** on photos via ML Kit (text-recognition v2, bundled in APK - no Google Play Services needed)
- **Link previews** (Open Graph) - paste a URL, get a card with title, image, and source

### Organize
- **Colors** (11 swatches, colorblind-friendly labels)
- **Tags** - typed inline or picked from existing
- **Archive** with one tap, restore anytime
- **Pinned** notes float to the top
- **Search & filter** across body, title, tags

### Edit
- Inline **`- [ ]` checklists** with smart toolbar toggle
- **Image embeds** (`![[image.jpg]]`) hidden from view, kept on save
- **Auto-saves** as you type (and on back-button)
- **Live preview** of pasted links

### Sync
- Files written as `<date>-<slug>.md` with YAML frontmatter (color, tags, archived, pinned)
- Designed to coexist peacefully with [Syncthing](https://syncthing.net/) - placeholder + finalize handshake avoids edit-conflicts
- Works with the official Obsidian Sync, iCloud, Dropbox, or any folder sync

## Install

> **TL;DR:** grab the files from the [latest release](https://github.com/Diexar-Labs/obsidrop/releases/latest), drop them in the right place, done. No build tools needed.

### Obsidian plugin (desktop + mobile)

1. Go to the [latest release](https://github.com/Diexar-Labs/obsidrop/releases/latest).
2. Download `manifest.json`, `main.js`, and `styles.css`.
3. Put them in `<your-vault>/.obsidian/plugins/obsidrop/` (create the folder if it doesn't exist).
4. Open Obsidian → Settings → Community plugins → enable **ObsiDrop**.
5. Click the sticky-note icon in the left ribbon (or run command "ObsiDrop: Open Keep view").

### Android app

1. Download `obsidrop-debug.apk` from the [latest release](https://github.com/Diexar-Labs/obsidrop/releases/latest).
2. Open the file on your phone → Android will ask permission to install from unknown sources → grant it.
3. Open ObsiDrop → first screen lets you pick the vault folder (the same one you sync to your laptop).
4. From now on, the share-sheet in any app includes ObsiDrop.

> **Note:** the APK is debug-signed (so you can install over a previous version without uninstalling). It's safe - built by GitHub Actions in this repo, you can see the build log on the releases page.

### Syncing the two

Install [Syncthing](https://syncthing.net/) on phone + laptop, point both at your vault folder. Within 30 seconds of capturing on your phone, the note shows up in Obsidian. That's the entire setup.

## How it works

ObsiDrop is intentionally simple plumbing:

- Each note is a plain Markdown file in `<vault>/Mini Notes/` (folder configurable).
- Metadata lives in YAML frontmatter at the top:
  ```yaml
  ---
  color: amber
  tags: [idea, work]
  archived: false
  pinned: false
  ---
  ```
- The Android app writes the file. The Obsidian plugin reads it. They never talk to each other - they meet in the vault.
- Link-preview cards are written as a "pending" placeholder by Android, then the plugin (or Android) fetches the Open Graph data and rewrites the note. A race-safe marker check prevents either side from overwriting user edits.

This is why ObsiDrop **needs no server, no account, no API key** - and why anything that can write to the same folder (e.g. a `curl` script, a Shortcuts automation) can capture into it.

## Languages

UI in English (default) and Dutch. Skeletons exist for **Spanish, German, French, Italian** - empty files are present in [`src/i18n.ts`](src/i18n.ts) and [`android/app/src/main/res/values-*/`](android/app/src/main/res/). PRs with translations very welcome - see [Contributing](#contributing).

## Roadmap

- [x] Card grid in Obsidian
- [x] Android share-target
- [x] OCR + voice-to-text on Android
- [x] Link previews (Open Graph)
- [x] Checklists
- [x] Multi-language (EN/NL + skeletons)
- [ ] Submit to official Obsidian community-plugins register
- [ ] Reminders / due-dates
- [ ] iOS share-target (share-extension)
- [ ] Web clipper (browser extension)

## Contributing

This is a hobby project I share publicly. PRs welcome for:
- **Translations** - drop strings into `src/i18n.ts` and the matching `android/.../values-*/strings.xml`
- **Bug fixes**
- **Small features** that fit the "minimal" philosophy

For larger ideas, open an issue first to chat about it. No CLA, no commit-message gatekeeping; just keep it tidy.

## Support

Open source, MIT-licensed, no premium tiers. If ObsiDrop saves you time and you feel like saying thanks:

<a href="https://ko-fi.com/L3L11ZETB9"><img src="https://img.shields.io/badge/Ko--fi-Support%20me-FF5E5B?logo=ko-fi&logoColor=white" alt="Ko-fi" /></a>
&nbsp;
<!-- GitHub Sponsors badge will be added once approval is in -->

No subscriptions, no obligations, no DMs. Totally optional.

## Build from source

If you'd rather build yourself than trust a debug APK:

**Plugin:**
```bash
npm install
npm run build
# main.js + manifest.json + styles.css end up in repo root
```

**Android:**
```bash
cd android
gradle :app:assembleDebug
# APK at android/app/build/outputs/apk/debug/app-debug.apk
```

Requires JDK 17, Android SDK 34, and Gradle 8.7 (the wrapper jar isn't committed - either install Gradle system-wide or run `gradle wrapper` once to generate `./gradlew`).

## Credits

Built by [Diexar Labs](https://github.com/Diexar-Labs). Uses [Obsidian's plugin API](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin), [Jetpack Compose](https://developer.android.com/jetpack/compose), and Google's [ML Kit Text Recognition](https://developers.google.com/ml-kit/vision/text-recognition).

Inspired by Google Keep (the good parts) and by [the Obsidian community's](https://obsidian.md/community) belief that your notes belong to you.

## License

[MIT](LICENSE) - do whatever you want with it.

<div align="center">

<img src="https://raw.githubusercontent.com/Diexar-Labs/jotdrop/main/docs/readme/hero.png" alt="JotDrop, the open-source Google Keep alternative: Keep-style note cards, end-to-end encrypted sync and your own Markdown files" width="820" />

# JotDrop

### Your notes. Yours. Really.

The free, open-source **Google Keep alternative** for **Android**, **Obsidian**, the **web** and **Chrome**.<br/>
Keep-style note cards, end-to-end encrypted sync and plain Markdown files you own.<br/>
Keep the ease. Lose the lock-in.

[**Website**](https://jotdrop.net/) · [**Web app**](https://app.jotdrop.net/) · [**Get it**](#get-jotdrop) · [**Features**](#features) · [**Switch from Keep**](#switch-from-google-keep) · [**JotDrop Cloud**](#jotdrop-cloud) · [**FAQ**](#faq)

[![License: MIT](https://img.shields.io/badge/License-MIT-f4c458.svg)](LICENSE) [![Obsidian plugin](https://img.shields.io/badge/Obsidian-plugin-14213d)](https://community.obsidian.md/plugins/jotdrop) [![Android APK](https://img.shields.io/badge/Android-APK-14213d)](https://github.com/Diexar-Labs/jotdrop/releases/download/v0.28.26/jotdrop.apk) [![Chrome clipper](https://img.shields.io/badge/Chrome-clipper-14213d)](https://chromewebstore.google.com/detail/jotdrop-web-clipper/mkgcicjljogifeaccaclbcoemllmgjfo) [![Build](https://github.com/Diexar-Labs/jotdrop/actions/workflows/android-build.yml/badge.svg)](https://github.com/Diexar-Labs/jotdrop/actions/workflows/android-build.yml)

</div>

> ### Free forever. No cloud required.
>
> The JotDrop apps (the Android app, the Obsidian plugin and the Chrome clipper) are free and will always stay free. No ads, no trial, no paywall.
>
> You don't need our cloud to sync. Use your own: [Syncthing](https://syncthing.net/) with [Syncthing-Fork](https://github.com/researchxxl/syncthing-android) on Android, Obsidian Sync, iCloud, Dropbox or any folder sync. JotDrop Cloud is simply the easiest option, end-to-end encrypted, with a free plan.

---

## Why JotDrop? The private Google Keep alternative

Google Keep is great for dumping a thought in two seconds. But your notes live on Google's servers, in Google's format, and leaving means exporting. JotDrop is a **privacy-friendly Google Keep alternative** that keeps the fast, friendly cards and gives you back the rest:

- **Every note is your own file.** A plain Markdown `.md` file in your Obsidian vault or a folder on your phone. Open it in Obsidian, VS Code, Vim or any editor. Back it up any way you like.
- **Private sync, if you want it.** The optional JotDrop Cloud is end-to-end encrypted: your notes are encrypted on your device before they leave, and the server cannot read them. Even on the free plan.
- **Or no cloud at all.** Without JotDrop Cloud there is no account and no server. Sync with Syncthing (Syncthing-Fork on Android), Obsidian Sync, iCloud or any folder sync you already use, or don't sync at all.
- **Free forever.** The apps cost nothing and always will. Only the optional cloud has a paid plan, for people who want more storage.
- **One set of notes, four places.** Android app, Obsidian plugin, web app and Chrome clipper all show the same cards and do the same things.
- **Open source.** The apps and the sync server are MIT-licensed and public. Read the code, run it, change it.

## All the little things, in one place

Ideas, to-do lists, links, photos and voice memos land on colorful **Keep-style note cards**, just like you know from Google Keep.

<p align="center">
  <img src="https://raw.githubusercontent.com/Diexar-Labs/jotdrop/main/docs/readme/board.webp" alt="JotDrop web app, a Google Keep alternative, with colorful note cards, a checklist, a voice memo and a saved video link" width="820" />
</p>

A card shows what matters at a glance: its title and text, ticked tasks with a pen stroke through them, the first photo, a voice memo you can play right there, links as little chips that open at once, up to four labels and tags that filter your notes with one tap, a "Due" or "Overdue" badge for reminders and when it last changed. Pinned cards get a strip of tape and float to the top.

## Your notes, your way: Android, Obsidian, web and Chrome

<table>
  <tr>
    <td align="center" width="38%">
      <img src="https://raw.githubusercontent.com/Diexar-Labs/jotdrop/main/docs/readme/android.webp" alt="JotDrop Android app, a Google Keep alternative for Android, with a two-column grid of note cards" width="260" />
      <br/><b>Android</b>
      <br/><sub>Capture from anywhere: share sheet, voice, photos, reminders.</sub>
    </td>
    <td align="center" width="62%">
      <img src="https://raw.githubusercontent.com/Diexar-Labs/jotdrop/main/docs/readme/obsidian.webp" alt="JotDrop Google Keep-style card view inside Obsidian, ticking off a checklist" width="480" />
      <br/><b>Obsidian</b>
      <br/><sub>Your cards right inside your vault, desktop and mobile.</sub>
      <br/><br/>
      <img src="https://raw.githubusercontent.com/Diexar-Labs/jotdrop/main/docs/readme/clipper.webp" alt="JotDrop web clipper for Chrome saving a web page with a selection" width="240" />
      <br/><b>Chrome clipper</b>
      <br/><sub>That tab you meant to save, kept with a little context.</sub>
    </td>
  </tr>
</table>

And the **web app** at [app.jotdrop.net](https://app.jotdrop.net/) puts the same cards in any browser, with JotDrop Cloud.

Each part works on its own. Together they feel like Google Keep, on your own files.

## Get JotDrop

| Where | How | Link |
| --- | --- | --- |
| **Obsidian** | Settings → Community plugins → Browse → search **JotDrop** → Install → Enable | [Plugin page](https://community.obsidian.md/plugins/jotdrop) |
| **Android** | Download the APK and open it on your phone | [JotDrop 0.28.26 APK](https://github.com/Diexar-Labs/jotdrop/releases/download/v0.28.26/jotdrop.apk) |
| **Web** | Open the web app and sign in with Google, GitHub or email | [app.jotdrop.net](https://app.jotdrop.net/) |
| **Chrome** | One click from the Chrome Web Store; works together with the Obsidian desktop plugin | [JotDrop Web Clipper](https://chromewebstore.google.com/detail/jotdrop-web-clipper/mkgcicjljogifeaccaclbcoemllmgjfo) |

Step-by-step instructions for each part are under [Install](#install).

## Features

### Capture

- **Share from any app** on Android: links, text and images become a card. A shared link gets a preview with title, picture and source.
- **Type, dictate or record.** Write a note, use Android's speech recognition, or record a voice memo with one tap, on Android (`.m4a`), in Obsidian (`.webm`) and in the web app.
- **Text from photos (OCR).** Take or pick a photo and turn its text into a note. On Android this uses ML Kit on your phone; in Obsidian and the web app it runs on your own device too, for English and Dutch.
- **Photo notes.** Add a photo as a card from the camera or the gallery.
- **Clip the web.** Save the page you're on with Chrome, including your selected text, tags, color and pin.
- **Import your old notes.** Bring your notes over from Google Keep (Google Takeout), Evernote (`.enex`), Apple Notes and other Markdown exports, with colors, pins, labels, checklists, images and dates where the export has them. See [Switch from Google Keep](#switch-from-google-keep).

### Organize

- **Colors**, eleven of them, each with its name, so you never have to tell them apart by color alone.
- **Labels and #tags.** Labels work like folders in Keep; #tags can also sit in the text. Tap one on a card or in the filter strip to see only those notes.
- **Pin** what matters to the top.
- **Reminders** with a date and time, repeats (daily, weekly on chosen days, monthly, yearly, every N days or weeks, or "the last Friday") and an end date or count. Android notifies you, also after a restart.
- **Archive and trash**, each one tap away and one tap back.
- **Search** across titles, text, labels and tags.
- **Your own order.** Choose "Newest first", or drag cards to where you want them.
- **A menu on every card**: color, labels, archive, move or copy to another folder, delete.
- **Select many** with a long press, then color, label, archive or delete them together.

### Edit

- **Checklists** that you tick right on the card.
- **Photos and voice memos** inside a note, with a full-screen photo view and a player.
- **Markdown help** for headings, lists, links, quotes, code and tables, while the card itself shows clean text without Markdown signs.
- **Saves as you go**, and a note changed elsewhere is never silently overwritten.

### Find it. Undo it.

<table>
  <tr>
    <td align="center" width="50%">
      <img src="https://raw.githubusercontent.com/Diexar-Labs/jotdrop/main/docs/readme/find.webp" alt="Searching notes in the JotDrop web app" />
      <br/><sub>The note you can't find, found.</sub>
    </td>
    <td align="center" width="50%">
      <img src="https://raw.githubusercontent.com/Diexar-Labs/jotdrop/main/docs/readme/timeline.webp" alt="The JotDrop time machine sliding back to an earlier moment" />
      <br/><sub>The version you wish you hadn't changed, back.</sub>
    </td>
  </tr>
</table>

With JotDrop Cloud, the **time machine** shows your notes as they were at an earlier moment. Look around read-only, then restore that moment if you want it back. Every file also has its own version history.

## Switch from Google Keep

Moving from Google Keep to JotDrop takes a few minutes, and your notes keep their colors, pins, labels, checklists, images and dates.

1. Go to [takeout.google.com](https://takeout.google.com/), deselect everything, select only **Keep** and export.
2. Download the zip file(s) Google sends you.
3. Import them: in Obsidian with the command **"Import from Google Keep"** (or Settings → JotDrop → Import from Google Keep), or in the web app with **Import notes**.

Your Keep notes are now Markdown files in your own vault, and with JotDrop Cloud on your phone too.

### JotDrop vs Google Keep

| | **JotDrop** | **Google Keep** |
| --- | --- | --- |
| Quick note cards with colors, labels, checklists and reminders | Yes | Yes |
| Android app | Yes | Yes |
| End-to-end encrypted sync | Yes, also on the free plan | Not offered |
| Your notes as plain Markdown files | Yes, on Android and in Obsidian | Export only |
| Works without an account | Yes, without the cloud | No |
| Card view inside Obsidian | Yes | No |
| Open source (apps and sync server) | Yes, MIT | No |
| Time machine to restore an earlier moment | Yes, with JotDrop Cloud | No |

Also considering other note apps? [jotdrop.net](https://jotdrop.net/#why-switch) compares JotDrop with Apple Notes, Evernote, Notion, OneNote, Joplin, Standard Notes, Notesnook, Simplenote and Bear.

## JotDrop Cloud

JotDrop Cloud is the optional, **end-to-end encrypted note sync** that keeps your notes and attachments the same on your phone, in Obsidian and in the web app. It is built so that we can store your notes without being able to read them.

### Your thoughts. Not our business.

To you, a thought. To us, gibberish.

1. **On your device**, JotDrop encrypts each note and attachment with AES-256-GCM, using keys that only your devices hold.
2. **Our server** stores the encrypted result. It has no key to decrypt it, so there is no readable copy for us, for a hacker or for anyone who asks.
3. **Your other devices** download the encrypted file and decrypt it themselves.

The encryption code is in this repository ([`cloud/shared/crypto.mjs`](cloud/shared/crypto.mjs)), next to the server, so anyone can check it. What the server does keep, such as your email address, device names and file sizes and times, and why, is in the [JotDrop Cloud privacy policy](https://app.jotdrop.net/privacy).

### How it works for you

- **Start in a few taps.** On Android, the first screen offers **Continue with Google**. In Obsidian, use the JotDrop Cloud button in the JotDrop view or Settings → JotDrop → JotDrop Cloud. On the web, sign in at [app.jotdrop.net](https://app.jotdrop.net/). You can also use GitHub or an email address with a password.
- **Keep your recovery code.** When you create your cloud you get a recovery code, shown only once. Store it in a password manager. If you lose access to all your signed-in devices, it may be the only way back to your notes.
- **Add devices** by signing in on them, or with a one-time pairing code from a device that is already connected.
- **Extra protection**: add an authenticator app to your account in the web app.
- **Syncs by itself.** Changes go up when you save and come in when you open the app; Android also syncs in the background. You can pause sync, sync now, disconnect a device or revoke one that you lost.
- **Changed in two places?** If you edit the same note on two devices before they sync, JotDrop merges what it safely can and otherwise keeps both versions. The other version shows as its own card with **Resolve now**, where you compare and choose.
- **Big files are fine.** Photos and recordings are uploaded in encrypted pieces and continue after a broken connection.
- **Leave whenever you want.** Your local files stay yours. Export everything from the web app, or delete your cloud account in the app.

### Free to start. Yours to keep.

The apps are free and always will be. Pay only when you want more from the cloud.

| | **Free** | **Plus** |
| --- | --- | --- |
| Encrypted cloud storage | 250 MB | 10 GB |
| Connected devices | 2 | No plan limit |
| Largest synced file | 25 MB | 200 MB |
| Time machine | 30 days | Full available history |
| End-to-end encryption | Included | Included |

250 MB is more than it sounds: 10,000 notes of 5 KB are about 50 MB of text. Photos, encryption and history take extra space. The free plan needs no payment details. When both free devices are in use, signing in on a third asks which one it replaces. JotDrop Plus is bought on [jotdrop.net](https://jotdrop.net/), where the current prices are.

## Install

### Obsidian plugin (desktop and mobile)

1. Open Obsidian → Settings → Community plugins → **Browse**.
2. Search for **JotDrop**, click **Install**, then **Enable**.
3. Click the JotDrop icon in the left ribbon, or run the command "JotDrop: Open Keep view".

Notes go to the `Mini Notes` folder of your vault; you can choose another folder in the settings.

**Manual install** (offline or pre-release): download `manifest.json`, `main.js` and `styles.css` from the [latest plugin release](https://github.com/Diexar-Labs/jotdrop/releases/tag/0.22.0), put them in `<your-vault>/.obsidian/plugins/jotdrop/` and enable JotDrop under Community plugins.

### Android app

1. Download [`jotdrop.apk` for Android 0.28.26](https://github.com/Diexar-Labs/jotdrop/releases/download/v0.28.26/jotdrop.apk).
2. Open the file on your phone and allow installs from this source when Android asks.
3. Open JotDrop. Choose **Continue with Google** for a free JotDrop Cloud, or **Use without cloud** and pick a folder for your notes (for example the vault folder you sync to your computer).
4. From now on, the share menu of every app includes JotDrop.

> **About the signing key:** GitHub APKs use the repository's published compatibility key, so they update existing sideloaded installs. Because that key is public, it is not proof of authenticity. Download APKs only from the versioned `Diexar-Labs/jotdrop` release URL above and check the linked Actions build.

### Web app

Open [app.jotdrop.net](https://app.jotdrop.net/) and sign in. The web app has everything the cards do, plus file uploads, importing, exporting, devices and the time machine. It needs JotDrop Cloud.

### Chrome web clipper

<p align="center">
  <img src="https://raw.githubusercontent.com/Diexar-Labs/jotdrop/main/docs/screenshots/clipper-popup-cnn.webp" alt="JotDrop Web Clipper popup on a news article, with tags, color, pin and Save" width="760" />
</p>

1. Install the JotDrop plugin in Obsidian desktop.
2. Install the [JotDrop Web Clipper](https://chromewebstore.google.com/detail/jotdrop-web-clipper/mkgcicjljogifeaccaclbcoemllmgjfo) from the Chrome Web Store.
3. Click the JotDrop icon on any page and press **Save**. Obsidian opens and creates the card.

That's the whole setup: saving works through Obsidian's own `obsidian://` link, with no token or port.

**Optional: background connection.** To save silently without bringing Obsidian to the front, enable the clip server in Obsidian (Settings → JotDrop → Web clipper) and copy the token. In the clipper, right-click the icon → **Background connection**, paste the token and choose **Save and test connection**. The server listens only on `127.0.0.1`, never on your network. If it cannot be reached, the clipper falls back to the direct link, so a clip is never lost.

**Manual ZIP install:** download the ZIP from the [latest clipper release](https://github.com/Diexar-Labs/jotdrop/releases?q=web-clipper-v&expanded=false), extract it to a permanent folder, open `chrome://extensions` (also in Edge and Brave), turn on **Developer mode** and choose **Load unpacked**.

| Problem | Fix |
| --- | --- |
| Obsidian does not open on Save | Open Obsidian desktop once so the `obsidian://` link is registered, then save again. |
| Background connection test fails | Obsidian desktop with the JotDrop plugin and its clip server must be running; copy the token again. |
| Wrong port or token | Open **Background connection → Advanced**, correct the port (default 27124) and paste the token again. |
| "Selection too long for direct mode" | Shorten the selection, or use the background connection, which handles much longer quotes. |

### Staying up to date

- **Obsidian:** a plugin from Community plugins updates with one click when Obsidian shows "Update available". For a manual install, [BRAT](https://github.com/TfTHacker/obsidian42-brat) with `Diexar-Labs/jotdrop` keeps it current.
- **Android:** an APK does not update itself. [Obtainium](https://github.com/ImranR98/Obtainium) can: add `https://github.com/Diexar-Labs/jotdrop`, use only releases tagged `v*` and the `jotdrop.apk` asset.
- **Chrome:** the store version updates automatically.
- **Everyone:** on this repository, choose **Watch → Custom → Releases** to hear about every new version.

## Syncing without JotDrop Cloud

JotDrop Cloud is optional. Every JotDrop app works with plain files, so any tool that syncs a folder keeps your phone and computer in step, and JotDrop needs nothing else. Point it at the same notes folder on every device.

**Syncthing: free, private and direct.** [Syncthing](https://syncthing.net/) syncs your devices with each other, without any server in between. A popular free setup:

1. On your computer, install Syncthing and share your Obsidian vault folder.
2. On Android, install [Syncthing-Fork](https://github.com/researchxxl/syncthing-android) and accept the shared folder.
3. In the JotDrop Android app, choose **Use without cloud** and pick that same folder.

A note you jot on your phone then shows up in Obsidian within seconds, and the other way round.

**Other options:** Obsidian Sync, iCloud, Dropbox, OneDrive or anything else that syncs a folder. Use one sync system per folder, though, not JotDrop Cloud and another one on the same notes.

With Syncthing, turn on **File Versioning** (Simple Versioning is fine) for the shared folder on every device. Deleted and overwritten files are then kept in `.stversions/`, so a mistake can always be undone.

## How it works

JotDrop is deliberately simple plumbing:

- Each note is a Markdown file in `<vault>/Mini Notes/` (the folder is configurable).
- Photos, voice memos and link-preview pictures go to an attachments folder you choose, by default `.attachments` inside the notes folder. Use the same setting in the plugin and the app.
- Color, labels, pin, reminder and order live in the frontmatter at the top, so any editor can read them:

  ```markdown
  ---
  color: yellow
  jotdrop_labels: [Personal]
  pinned: true
  reminder: 2026-11-02T09:00
  reminder_repeat: weekly:1,3
  ---

  A few good things
  - [ ] Coffee beans
  - [x] Fresh bread
  ```

- The Android app, the plugin and the web app never need to talk to each other: they meet in the files. Anything else that can write to the folder (a script, a Shortcuts automation) can add notes too.
- A shared link first becomes a card right away; JotDrop then fetches the page's preview and adds it, without overwriting what you typed in the meantime.

### Network use, accounts and payments

Without JotDrop Cloud, the Obsidian plugin goes online for only two things:

- It fetches the web page of a link you save, to build the preview card.
- The first time you use "Text from photo", it asks before downloading the English and Dutch language data (about 6 MB) once from the [`ocr-data-1` release](https://github.com/Diexar-Labs/jotdrop/releases/tag/ocr-data-1), checks it against a fixed SHA-256 and keeps it in the plugin folder. The recognition itself runs on your device, and your photos never leave it.

If you sign in to the optional JotDrop Cloud, the plugin also connects to `app.jotdrop.net` to sign in and to sync your notes and attachments, encrypted on your device first. The cloud needs an account. Its free plan needs no payment details; JotDrop Plus is a paid plan, bought on the website.

On Android, text recognition in photos runs on your phone with Google's ML Kit, which sends technical diagnostics to Google, as the [Android privacy policy](docs/android-privacy-policy.md) explains.

## FAQ

**Can JotDrop staff read my cloud notes?**
No. We don't hold the key that decrypts your notes and attachments; the server stores only the encrypted result. It does see account details such as your email address, your devices and the size and time of your files.

**What if I lose my password or recovery code?**
Resetting your login and opening your encrypted notes are two different things. A password reset gets you into your account; your notes open on a device that is still signed in, or with your recovery code. Keep that code somewhere safe outside JotDrop.

**Is my local notes folder encrypted too?**
Not by JotDrop. Local notes are readable Markdown files, which is the point. Use your device's encryption and screen lock.

**Can I use JotDrop Cloud and Obsidian Sync together?**
Not on the same notes. Two sync systems on one folder can produce conflicting changes. Pick one per folder.

**Are photos and voice memos encrypted as well?**
Yes. Attachments synced with JotDrop Cloud are encrypted on your device like notes.

**Does the Chrome clipper work without Obsidian?**
It works together with the Obsidian desktop plugin, which creates the card.

**Will every saved link get a picture?**
Not always. The website has to offer a preview picture and allow it to load.

**Can the time machine bring everything back?**
It can restore the versions that are still stored under your plan: 30 days on Free, the full available history on Plus. Restoring creates new versions, so it can be undone too.

## Known issues

**Deleting many notes while a Syncthing device is offline.** If you delete a lot of notes at once while another device running Syncthing is offline, that device can bring them back when it reconnects. That is how Syncthing reconciles, not something JotDrop does. Keep Syncthing running on every device while you delete many notes, and turn on File Versioning so nothing is ever lost. JotDrop Cloud does not have this problem.

## Languages

English and Dutch. Spanish, German, French and Italian are ready for translators in [`src/i18n.ts`](src/i18n.ts) and [`android/app/src/main/res/`](android/app/src/main/res/). Translations are very welcome.

## Roadmap

- [x] Card grid in Obsidian, Android app and web app
- [x] Share to JotDrop, text from photos, voice-to-text and voice memos
- [x] Link previews, checklists, labels, #tags and colors
- [x] Reminders with repeats
- [x] Chrome web clipper
- [x] Import from Google Keep, Evernote and Apple Notes
- [x] Listed in the official Obsidian community plugins
- [x] End-to-end encrypted JotDrop Cloud with a web app and a time machine
- [x] The same cards and card features on every platform
- [ ] JotDrop on Google Play for everyone (now in closed testing)
- [ ] Light and dark choice in the Android app
- [ ] iOS share extension
- [ ] Firefox and Edge clipper

## Contributing

This is a project shared in the open. PRs are welcome for:

- **Translations**: add strings to `src/i18n.ts` and the matching `android/app/src/main/res/values-*/strings.xml`.
- **Bug fixes**
- **Small features** that keep JotDrop simple.

For bigger ideas, open an issue first to talk about it.

## Contact

- Bugs and ideas: [open an issue](https://github.com/Diexar-Labs/jotdrop/issues/new/choose). Issues are public, so never paste passwords, recovery codes or private notes.
- Your JotDrop Cloud account, your data or JotDrop Plus: hello@jotdrop.net

## Support

The apps are free and always will be. If JotDrop saves you time and you feel like saying thanks:

<a href="https://ko-fi.com/L3L11ZETB9"><img src="https://img.shields.io/badge/Ko--fi-Support%20me-FF5E5B?logo=ko-fi&logoColor=white" alt="Ko-fi" /></a>

No obligations. Totally optional.

## Build from source

**Plugin**

```bash
npm install
npm run build
# main.js, manifest.json and styles.css end up in the repository root
```

**Android** (JDK 17, Android SDK 34; the Gradle wrapper pins Gradle 8.7)

```bash
npm run android:release
# APK at android/app/build/outputs/apk/release/app-release.apk
npm run android:verify -- android/app/build/outputs/apk/release/app-release.apk
npm run android:install -- android/app/build/outputs/apk/release/app-release.apk
```

Always use the optimized release build: debug APKs are disabled because Compose debug builds scroll too slowly. `npm run android:test-release` builds the same optimized variant for local testing; `android:release` requires a clean checkout at `origin/main`.

**Cloud server and web app** live in [`cloud/`](cloud/). `npm run check:cloud` runs their tests.

## Credits

Built by [Diexar Labs](https://github.com/Diexar-Labs) with [Obsidian's plugin API](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin), [Jetpack Compose](https://developer.android.com/jetpack/compose), Google's [ML Kit Text Recognition](https://developers.google.com/ml-kit/vision/text-recognition) and [Tesseract.js](https://github.com/naptha/tesseract.js). Inspired by Google Keep (the good parts) and by the belief that your notes belong to you.

The sample video card shows *Big Buck Bunny* by the Blender Foundation, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), used without endorsement.

## License

[MIT](LICENSE): do whatever you want with it.

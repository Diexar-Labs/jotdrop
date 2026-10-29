# JotDrop Web Clipper - Chrome Web Store Listing (0.1.4)

Existing item: `mkgcicjljogifeaccaclbcoemllmgjfo` (publisher `DiexarLabs`,
public contact `eric@diexar.com`). Version 0.1.3 was published publicly on
2026-09-13. For future updates, upload the exact GitHub ZIP from the verified
release, never create a new item, and keep public distribution enabled.

Version 0.1.4 brings the "Paper and ink" house style and the new logo. The
store package is local-only: `chrome-extension/cloud.mjs` is only loaded by the
separate cloud build (`npm run build:cloud-clipper`), not by the store ZIP.

## Store fields

- **Name:** JotDrop Web Clipper (renamed by the package manifest)
- **Short description:** `Clip any page, link or highlight into JotDrop as a Keep-style note card: plain Markdown in your Obsidian vault. Free.`
- **Publisher:** DiexarLabs
- **Contact:** eric@diexar.com
- **Category:** Tools → Productivity
- **Website:** `https://jotdrop.net/`
- **Support:** `https://github.com/Diexar-Labs/jotdrop/issues`
- **Privacy policy URL:** `https://raw.githubusercontent.com/Diexar-Labs/jotdrop/main/chrome-extension/privacy-policy.html`
- **Public distribution:** on

## Screenshots (1280x800) and promo tile

| File | Shows |
| --- | --- |
| `docs/store/screenshots/1-clip-any-page.png` | The 0.1.4 popup on an article, with selection, tags, color and pin |
| `docs/store/screenshots/2-lands-as-a-card.png` | The clip as a card in the JotDrop board in Obsidian |
| `docs/store/screenshots/3-plain-markdown.png` | The same note as a plain Markdown file |
| `docs/store/screenshots/4-free-and-private.png` | Free forever, no account, local-only clipping |
| `docs/store/screenshots/promo-tile-440x280.png` | Small promo tile |

Do not reuse the old screenshots in `docs/screenshots/` for the store.

## Full listing copy

**JotDrop Web Clipper: clip the web into your notes, the Google Keep way.**

JotDrop is the free, open-source Google Keep alternative. This clipper saves
any web page, link or selected text as a JotDrop note card, with tags, a
color, a pin and a preview image. Every clip lands as a plain Markdown file in
your own Obsidian vault, on your own computer.

**REQUIRES OBSIDIAN:** This extension works together with the free JotDrop
plugin in the Obsidian desktop app. Install that first.

### Free forever. No account needed.

The JotDrop apps are free and will always stay free. No ads, no trial, no
paywall. The clipper needs no account and no cloud: clips go straight from
your browser to Obsidian on your own computer, never through a server.

### Why a Google Keep alternative?

Google Keep is great for dumping a thought in two seconds. But your notes live
on Google's servers, in Google's format, and leaving means exporting. JotDrop
keeps the fast, friendly cards and gives you back the rest:

- **Plain Markdown, always.** Every clip is a normal `.md` file you can open in
  any editor, today or in 20 years.
- **Your files, your sync.** Notes land in a folder you control. Sync them with
  Syncthing, iCloud, Dropbox, Obsidian Sync or the optional, end-to-end
  encrypted JotDrop Cloud.
- **Open source (MIT).** Anyone can check the code. No ads, no tracking.
- **Everywhere you write.** JotDrop also has an Android app and a web app, with
  the same cards.

### How it works

1. Install the free JotDrop plugin in Obsidian.
2. Install this extension.
3. Click the JotDrop icon on any page and press Save. Obsidian opens and your
   card is there.

No token, no port, no settings needed.

### What gets saved

The page title and URL, the text you selected (if any), your tags, a color, a
pin and, if you like, a preview image. Everything arrives as an editable
Markdown note in your vault.

### Optional: background connection

Prefer quiet saves? Pair the clipper once with the JotDrop plugin's local clip
server and clips are saved in the background, without bringing Obsidian to the
front. If that connection fails, the clipper falls back to opening Obsidian, so
a clip is never lost.

### Requirements

- Obsidian desktop with the JotDrop plugin 0.20.3 or newer
- Google Chrome, Edge or Brave

### Privacy

The clipper only reads the current tab when you open it. Clips travel to your
own computer, either over `127.0.0.1` to the JotDrop plugin or through the
local `obsidian://` link. No account, no analytics, no ads. The optional token
and port stay in `chrome.storage.local` on this device. See the privacy policy
for the details.

### More

- Website: https://jotdrop.net/
- Source: https://github.com/Diexar-Labs/jotdrop
- Support: https://github.com/Diexar-Labs/jotdrop/issues

## Permission justifications

- **activeTab** - read the current tab's title/URL only after the user opens
  or clicks the extension.
- **scripting** - one-time read of the user's selected text from the active
  tab when the popup opens.
- **storage** - store the optional localhost port/token locally in
  `chrome.storage.local`.
- **Host permissions (127.0.0.1/localhost)** - send clipped data only to the
  JotDrop plugin running on this computer.

## Test instructions for reviewers

1. Install Obsidian desktop and add the JotDrop plugin from Obsidian's
   community plugin browser.
2. Click the extension icon on any page and press Save. Obsidian opens and
   creates a Markdown card. No configuration is needed.
3. Optionally enable the clip server in the plugin settings and paste the
   token in the extension's "Background connection" page; "Save and test
   connection" reports "Connection OK" while the server is running.

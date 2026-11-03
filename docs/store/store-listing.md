# JotDrop Web Clipper - Chrome Web Store Listing (0.2.0)

Existing item: `mkgcicjljogifeaccaclbcoemllmgjfo` (publisher `DiexarLabs`,
public contact `eric@diexar.com`). Version 0.1.3 was published publicly on
2026-09-13. For future updates, upload the exact ZIP built from the verified
release, never create a new item, and keep public distribution enabled.

Version 0.2.0 adds JotDrop Cloud as a destination. In the clipper settings
people choose where clips go: Obsidian (as before), JotDrop Cloud, or both.
Cloud clips are encrypted in the browser and land as notes in the web app at
app.jotdrop.net, so the clipper no longer needs Obsidian. The Obsidian route is
unchanged. `chrome-extension/cloud-client.js` is the committed build of
`chrome-extension/cloud.mjs` plus `cloud/shared` (`npm run build:web-clipper`);
the package script refuses a stale bundle and leaves `cloud.mjs` out of the ZIP.

## Server setting (done)

The production cloud must accept the store extension's origin, or every cloud
pairing and save is refused with "Origin not allowed". Production has
`JOTDROP_CLOUD_CORS_ORIGINS` with
`chrome-extension://mkgcicjljogifeaccaclbcoemllmgjfo` since 2026-11-03: an
`OPTIONS` request to `https://app.jotdrop.net/api/v1/status` with that `Origin`
header answers 204. Keep it there in every server deploy. Chrome sends this
origin with the POST and PUT requests that pair and save.

## Store fields

- **Name:** JotDrop Web Clipper (set by the package manifest)
- **Short description** (the manifest description, 122 characters; the store
  takes it from the package):
  `Clip any page into JotDrop, the Google Keep alternative: Markdown in Obsidian, or your end-to-end encrypted JotDrop Cloud.`
- **Publisher:** DiexarLabs
- **Contact:** eric@diexar.com
- **Category:** Tools → Productivity
- **Website:** `https://jotdrop.net/`
- **Support:** `https://github.com/Diexar-Labs/jotdrop/issues`
- **Privacy policy URL:** `https://raw.githubusercontent.com/Diexar-Labs/jotdrop/main/chrome-extension/privacy-policy.html`
  (unchanged; it only shows the 0.2.0 text once this branch is merged into main)
- **Public distribution:** on

## Screenshots (1280x800) and promo tile

| File | Shows |
| --- | --- |
| `docs/store/screenshots/1-clip-any-page.png` | The popup on an article, saving to JotDrop Cloud, with selection, tags, color and pin |
| `docs/store/screenshots/2-lands-as-a-card.png` | A clip as a card in the JotDrop board in Obsidian |
| `docs/store/screenshots/3-plain-markdown.png` | The same note as a plain Markdown file |
| `docs/store/screenshots/4-cloud-or-obsidian.png` | The settings: "Where clips go", connected to JotDrop Cloud |
| `docs/store/screenshots/5-cards-in-the-web-app.png` | The clip as a pinned card in the web app |
| `docs/store/screenshots/promo-tile-440x280.png` | Small promo tile (unchanged) |

In the dashboard, remove the old screenshots and upload these five in this
order. `4-free-and-private.png` ("local-only") is gone. Screenshots 1, 4 and 5
come from `python docs/store/make_screenshots.py`: real extension UI on a local
cloud with demo notes, framed by a template. The settings picture shows the
production address app.jotdrop.net instead of the local one. Do not reuse the
old screenshots in `docs/screenshots/` for the store.

## Full listing copy (paste as the description)

```
Clip any web page, link or bit of selected text into JotDrop as a note card, with tags, a color and a pin. JotDrop is a free, open-source Google Keep alternative.

You decide where clips go, in the clipper's settings:

• Obsidian: the clip becomes a plain Markdown file in your own vault, through the free JotDrop plugin for Obsidian desktop. No account needed.
• JotDrop Cloud: no Obsidian needed. The clip goes straight into your end-to-end encrypted cloud and shows up in the web app at app.jotdrop.net, on Android, and in Obsidian if your vault syncs with it.
• Both, if your vault does not already sync with JotDrop Cloud.

HOW IT WORKS WITH OBSIDIAN
1. Install the free JotDrop plugin in Obsidian desktop.
2. Install this extension.
3. Click the JotDrop icon on any page and press Save. Obsidian opens and the card is there. No token, no port, no setup.

Prefer quiet saves? Turn on the plugin's local clip server and paste its token in the clipper settings. Clips then save in the background without bringing Obsidian to the front. If that connection fails, the clipper opens Obsidian instead, so you don't lose the clip.

HOW IT WORKS WITH JOTDROP CLOUD
1. Sign in at app.jotdrop.net, or create a free account.
2. In the web app, open Devices & recovery and create a one-time pairing code.
3. In the clipper settings, choose JotDrop Cloud, paste the code and pick an unlock passphrase for this browser. Chrome asks once for access to app.jotdrop.net.
4. Click the JotDrop icon on any page and press Save. The card appears in the web app.

The clipper counts as one of your cloud devices. The Free plan has room for two.

WHAT GETS SAVED
The page title and link, the text you selected (if any), your tags, a color and a pin. In Obsidian the plugin can also add the page's preview picture.

PRIVATE BY DESIGN
The clipper only reads the current tab when you open it. In Obsidian mode the clip never leaves your computer. In cloud mode it is encrypted in your browser before it is sent to app.jotdrop.net, so the server stores something it cannot read. The cloud keys stay in this browser, locked with your passphrase. There are no analytics and no ads, and the code is open source (MIT), so you can check all of this yourself.

Requirements: Google Chrome, Edge or Brave, plus either Obsidian desktop with the JotDrop plugin 0.20.3 or newer, or a JotDrop Cloud account (free plan available).

Website: https://jotdrop.net/
Source: https://github.com/Diexar-Labs/jotdrop
Support: https://github.com/Diexar-Labs/jotdrop/issues
```

## Privacy practices tab

- **Single purpose:** `Save the current web page, its link and the text the user selected as a note in JotDrop, either in the user's Obsidian vault through the local JotDrop plugin or in the user's end-to-end encrypted JotDrop Cloud.`
- **Data usage:** the extension handles "Website content" (title, link, selected
  text) only to save the clip the user asked for. In cloud mode that content is
  encrypted in the browser before it is sent, so the developer cannot read it.
  No data is sold, used for advertising or credit decisions, or used for
  anything other than the single purpose. Tick the three certification boxes.
- **Remote code:** No. All scripts are in the package.

## Permission justifications (paste per field)

- **activeTab:** `Reads the title and address of the tab the user is on, only after the user clicks the JotDrop icon, so that page can be saved as a note.`
- **scripting:** `Runs one short read on the active tab when the popup opens, to get the text the user selected. No content script stays on the page.`
- **storage:** `Keeps the user's settings on this device in chrome.storage.local: where clips go, the optional port and token for the local Obsidian plugin, and for JotDrop Cloud the pairing keys sealed with the user's passphrase plus encrypted clips that wait to be uploaded. If the user chooses "stay unlocked", the unsealed keys are kept in chrome.storage.session, which is memory only and is cleared when the browser closes. Nothing is stored in chrome.storage.sync.`
- **Host permissions http://127.0.0.1/* and http://localhost/*:** `Sends a clip to the JotDrop plugin's clip server, which runs inside Obsidian on the user's own computer and listens only on 127.0.0.1.`
- **Optional host permission https://app.jotdrop.net/*:** `Requested only when the user connects JotDrop Cloud in the settings. Used to pair with the user's own cloud and to upload clips that are already end-to-end encrypted in the browser. The extension talks to no other server.`

## Test instructions for reviewers (paste into "Test instructions")

```
The clipper saves to Obsidian or to JotDrop Cloud. The cloud route needs no extra software, so it is the quickest to test.

JotDrop Cloud (no Obsidian needed):
1. Open https://app.jotdrop.net and create a free account with an email address you can read, a password, and the code we send to that address.
2. In the web app, open "Devices & recovery". Type "Web clipper" as the name of the new device and press "Create one-time pairing code". Copy the code. It works once, for 10 minutes.
3. Right-click the JotDrop icon in the toolbar and choose Options. Under "Where clips go" choose "JotDrop Cloud". Paste the code, type an unlock passphrase of at least 12 characters twice and press "Connect to JotDrop Cloud". Allow access to app.jotdrop.net when Chrome asks.
4. Open any web page, select some text and click the JotDrop icon. Type the unlock passphrase, keep "Stay unlocked until the browser closes" ticked and press "Save to JotDrop". The popup says "Encrypted clip saved to cloud".
5. In the web app, press "Sync now". The page is there as a note card. A second clip from the popup needs no passphrase while the browser stays open.

Obsidian:
1. Install Obsidian desktop and add the JotDrop plugin from Obsidian's community plugin browser.
2. In the clipper's Options choose "Obsidian".
3. Click the JotDrop icon on any page and press "Save to JotDrop". Obsidian opens and creates a Markdown card.
4. Optional: enable the clip server in the plugin settings, paste its token under "Obsidian: background connection" in the clipper's Options and press "Save and test connection". It reports "Connection OK" while Obsidian runs.
```

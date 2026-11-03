# JotDrop Web Clipper - Chrome Web Store Listing (0.2.0)

Existing item: `mkgcicjljogifeaccaclbcoemllmgjfo` (publisher `DiexarLabs`,
public contact `eric@diexar.com`). Version 0.1.3 was published publicly on
2026-09-13. For future updates, upload the exact GitHub ZIP from the verified
release, never create a new item, and keep public distribution enabled.

Version 0.2.0 adds JotDrop Cloud as a destination. In the clipper settings
people choose where clips go: Obsidian (as before), JotDrop Cloud, or both.
Cloud clips are encrypted in the browser and land as notes in the web app at
app.jotdrop.net, so the clipper no longer needs Obsidian. The Obsidian route is
unchanged. `chrome-extension/cloud-client.js` is the committed build of
`chrome-extension/cloud.mjs` plus `cloud/shared` (`npm run build:web-clipper`);
the package script refuses a stale bundle and leaves `cloud.mjs` out of the ZIP.

## Before uploading 0.2.0

- The production cloud must accept the store extension's origin, or every
  cloud pairing and save is refused with "Origin not allowed": set
  `JOTDROP_CLOUD_CORS_ORIGINS=chrome-extension://mkgcicjljogifeaccaclbcoemllmgjfo`
  (comma separated, next to any origin already listed) on the server for
  app.jotdrop.net and restart it. Chrome sends this origin with the POST and PUT
  requests that pair and save. Check afterwards: an `OPTIONS` request to
  `https://app.jotdrop.net/api/v1/status` with that `Origin` header answers 204.
- Add a screenshot of the cloud settings (see below) and update the short
  description in the dashboard.

## Store fields

- **Name:** JotDrop Web Clipper (renamed by the package manifest)
- **Short description:** `Clip any page into JotDrop, the Google Keep alternative: Markdown in Obsidian, or your end-to-end encrypted JotDrop Cloud.`
  (the manifest description, 122 characters)
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
| `docs/store/screenshots/1-clip-any-page.png` | The popup on an article, with selection, tags, color and pin |
| `docs/store/screenshots/2-lands-as-a-card.png` | The clip as a card in the JotDrop board in Obsidian |
| `docs/store/screenshots/3-plain-markdown.png` | The same note as a plain Markdown file |
| `docs/store/screenshots/4-free-and-private.png` | Free forever, no account, local-only clipping |
| `docs/store/screenshots/promo-tile-440x280.png` | Small promo tile |

Still to make for 0.2.0: one screenshot of the settings page with "Where clips
go" set to JotDrop Cloud, and one of the clip as a card in the web app. Screenshot
4 says "local-only"; replace it or keep it as the Obsidian story. Do not reuse
the old screenshots in `docs/screenshots/` for the store.

## Full listing copy

**JotDrop Web Clipper: clip the web into your notes, the Google Keep way.**

JotDrop is the free, open-source Google Keep alternative. This clipper saves
any web page, link or selected text as a JotDrop note card, with tags, a color
and a pin. You choose where clips go: your Obsidian vault, your JotDrop Cloud,
or both.

### Two ways to save

- **Obsidian.** Every clip lands as a plain Markdown file in your own vault, on
  your own computer, through the free JotDrop plugin for Obsidian desktop. No
  account needed.
- **JotDrop Cloud.** No Obsidian? Clips go straight into your end-to-end
  encrypted JotDrop Cloud and show up in the web app at app.jotdrop.net, on
  Android and in Obsidian if you sync it there. The clip is encrypted in your
  browser before it is sent, so the server only stores data it cannot read.

### Free, no ads

The JotDrop apps are free and will stay free. No ads, no tracking. Obsidian
mode needs no account at all. JotDrop Cloud has a free plan; the clipper counts
as one of your cloud devices.

### Why a Google Keep alternative?

Google Keep is great for dumping a thought in two seconds. But your notes live
on Google's servers, in Google's format, and leaving means exporting. JotDrop
keeps the fast, friendly cards and gives you back the rest:

- **Plain Markdown, always.** Every clip is a normal `.md` file you can open in
  any editor, today or in 20 years. Cloud notes can be exported the same way.
- **Your files, your sync.** In Obsidian, notes land in a folder you control.
  Sync them however you like, or use JotDrop Cloud, which is end-to-end
  encrypted.
- **Open source (MIT).** Anyone can check the code.
- **Everywhere you write.** JotDrop also has an Android app and a web app, with
  the same cards.

### How it works

With Obsidian:

1. Install the free JotDrop plugin in Obsidian desktop.
2. Install this extension.
3. Click the JotDrop icon on any page and press Save. Obsidian opens and your
   card is there. No token, no port, no settings needed.

With JotDrop Cloud:

1. Sign in at app.jotdrop.net (or create a free account).
2. In the web app, open Devices & recovery and create a one-time pairing code.
3. In the clipper settings, choose JotDrop Cloud, paste the code and pick an
   unlock passphrase for this browser. Chrome asks once for access to
   app.jotdrop.net.
4. Click the JotDrop icon on any page and press Save. The card appears in the
   web app.

### What gets saved

The page title and URL, the text you selected (if any), your tags, a color and
a pin. In Obsidian the plugin can also add the page's preview image.

### Optional: background connection for Obsidian

Prefer quiet saves? Pair the clipper once with the JotDrop plugin's local clip
server and clips are saved in the background, without bringing Obsidian to the
front. If that connection fails, the clipper falls back to opening Obsidian, so
a clip is never lost.

### Requirements

- For Obsidian: Obsidian desktop with the JotDrop plugin 0.20.3 or newer
- For JotDrop Cloud: a JotDrop Cloud account (free plan available)
- Google Chrome, Edge or Brave

### Privacy

The clipper only reads the current tab when you open it and press Save. In
Obsidian mode clips travel only to your own computer, over `127.0.0.1` to the
JotDrop plugin or through the local `obsidian://` link. In cloud mode the clip
is encrypted in your browser and sent only to app.jotdrop.net. The cloud keys
are stored in this browser, sealed with your unlock passphrase, and never sent
anywhere. No analytics, no ads. See the privacy policy for the details.

### More

- Website: https://jotdrop.net/
- Source: https://github.com/Diexar-Labs/jotdrop
- Support: https://github.com/Diexar-Labs/jotdrop/issues

## Permission justifications

- **activeTab** - read the current tab's title and URL, only after the user
  opens the extension from the toolbar.
- **scripting** - a one-time read of the text the user selected on the active
  tab when the popup opens. No content script stays on the page.
- **storage** - keep the user's settings in `chrome.storage.local` on this
  device: where clips go, the optional localhost port and token for the
  Obsidian plugin, and for JotDrop Cloud the pairing keys sealed with the
  user's passphrase plus encrypted clips that wait to be uploaded. If the user
  chooses "stay unlocked", the unsealed keys are kept in
  `chrome.storage.session`, which is memory only and cleared when the browser
  closes. Nothing is stored in `chrome.storage.sync`.
- **Host permissions `http://127.0.0.1/*` and `http://localhost/*`** - send a
  clip to the JotDrop plugin's clip server running in Obsidian on the user's
  own computer.
- **Optional host permission `https://app.jotdrop.net/*`** - only requested
  when the user connects JotDrop Cloud in the settings. Used to pair with the
  user's cloud and upload end-to-end encrypted clips. The clipper talks to no
  other server.
- **Remote code:** none. All scripts are in the package; `cloud-client.js` is
  the bundled, unminified encryption and upload code from the open-source repo.

## Test instructions for reviewers

Obsidian mode:

1. Install Obsidian desktop and add the JotDrop plugin from Obsidian's
   community plugin browser.
2. Click the extension icon on any page and press Save. Obsidian opens and
   creates a Markdown card. No configuration is needed.
3. Optionally enable the clip server in the plugin settings and paste the
   token in the extension's settings under "Obsidian: background connection";
   "Save and test connection" reports "Connection OK" while the server is
   running.

JotDrop Cloud mode (no Obsidian needed):

1. Open https://app.jotdrop.net and create a free account (email and a code
   sent by email), or sign in with the review account given in the private
   test notes.
2. In the web app open "Devices & recovery", type "Web clipper" as the name of
   the new device and press "Create one-time pairing code". Copy the code.
   On the Free plan, sign out an older device first if the web app says the
   device limit is reached.
3. Right-click the extension icon, open Options, choose "JotDrop Cloud", paste
   the code, choose an unlock passphrase of at least 12 characters (twice) and
   press "Connect to JotDrop Cloud". Allow access to app.jotdrop.net when
   Chrome asks.
4. Open any web page, click the extension icon, enter the unlock passphrase and
   press "Save to JotDrop". The popup says "Encrypted clip saved to cloud" and
   the note appears in the web app (press "Sync now" if it is already open).

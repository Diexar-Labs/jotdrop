# JotDrop Web Clipper (Chrome extension)

Save the current browser page as a JotDrop note card: in your Obsidian vault,
in your end-to-end encrypted JotDrop Cloud, or in both. You pick the
destination in the clipper's settings.

## Install from the Chrome Web Store (recommended)

Install directly from the store: [JotDrop Web Clipper](https://chromewebstore.google.com/detail/jotdrop-web-clipper/mkgcicjljogifeaccaclbcoemllmgjfo) - one click to install, and updates arrive automatically.

## Where clips go

Right-click the JotDrop icon → **Options** (or press **Settings** in the popup)
and choose under **Where clips go**:

- **Obsidian** (default): plain Markdown in your vault, through the JotDrop
  plugin in Obsidian desktop. No account needed.
- **JotDrop Cloud**: straight into your encrypted cloud at app.jotdrop.net,
  without Obsidian. The note shows up in the web app, on Android, and in
  Obsidian if it syncs with JotDrop Cloud.
- **Both**: JotDrop Cloud and Obsidian. Only useful when your vault does not
  already sync with JotDrop Cloud, otherwise every clip arrives twice.

## Obsidian: zero-config quick start

No token, no port, no options page needed:

1. Install the JotDrop plugin in Obsidian (Community plugins → **JotDrop**).
2. Install the [Web Clipper](https://chromewebstore.google.com/detail/jotdrop-web-clipper/mkgcicjljogifeaccaclbcoemllmgjfo) from the Chrome Web Store.
3. Click the JotDrop icon on any page and press **Save** - Obsidian opens and creates the card.

### Optional: Background connection

By default, every save brings Obsidian to the foreground. If you prefer silent,
background clipping, connect the clipper to the plugin:

1. In Obsidian, open **Settings → JotDrop → Web clipper**.
2. Toggle **Enable clip server** on, then click **Copy** next to the token.
3. In the clipper settings, under **Obsidian: background connection**, paste the token and click **Save and test connection** - it should report "Connection OK".

Saves now go straight into the vault without focusing Obsidian. If the
connection ever fails, the clipper automatically falls back to opening Obsidian
as usual, so a clip is never lost.

## JotDrop Cloud

1. Open [app.jotdrop.net](https://app.jotdrop.net/) and sign in, or create a free account.
2. Open **Devices & recovery**, name the new device "Web clipper" and press **Create one-time pairing code**. Copy the code (it works once, for 10 minutes).
3. In the clipper settings choose **JotDrop Cloud**, paste the code, choose an unlock passphrase for this browser (at least 12 characters, twice) and press **Connect to JotDrop Cloud**. Chrome asks once to allow access to app.jotdrop.net.
4. Click the JotDrop icon on any page, enter the unlock passphrase and press **Save to JotDrop**. With **Stay unlocked until the browser closes** ticked, you only type it once per browser session.

The clipper becomes one of your cloud devices. On the Free plan it counts
toward the device limit; if the web app says the limit is reached, sign out an
older device first. To stop, open the settings, **Disconnect this browser**
and give the unlock passphrase: the clipper removes its keys and signs itself
out of your cloud. Forgot the passphrase? Disconnect without it, sign out "Web
clipper" in the web app and pair again.

If a save is interrupted, the encrypted clip is kept in the browser and the
popup offers **Resume saved drafts**.

## Manual installation (ZIP fallback)

For browsers without the store, or if you prefer installing by hand:

1. Download the ZIP from the [latest clipper release](https://github.com/Diexar-Labs/jotdrop/releases?q=web-clipper-v&expanded=false) and extract it into a permanent folder.
2. Open `chrome://extensions` in Chrome / Edge / Brave.
3. Toggle **Developer mode** on.
4. Click **Load unpacked** and select the extracted folder that contains `manifest.json`.
5. The extension icon (puzzle piece by default) appears in the toolbar.

**Manual updates:** download a newer ZIP, replace the files in the same
permanent folder, and click **Reload** on the extension card in
`chrome://extensions`. Store installations update automatically.

A manually installed copy has a different extension ID than the store version.
JotDrop Cloud only accepts the store version's ID, so cloud mode needs the
store installation; Obsidian mode works in both.

## Use

Click the extension icon on any page. The popup shows the page title, where
the clip goes, and lets you add tags, pick a color, or pin the card before
saving. **Save to JotDrop** writes the card; in Obsidian, with article-image
handling enabled in JotDrop, the page's preview image is embedded.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Obsidian does not open on Save | Make sure Obsidian desktop is installed and opened at least once so the `obsidian://` protocol is registered; then try the save again. |
| Background connection test fails | Obsidian desktop, the JotDrop plugin, and its clip server must be running; re-copy the token from the plugin settings. |
| Wrong port or token | Open the settings, **Obsidian: background connection → Advanced**, correct the port (default 27124), and paste the token again. |
| "Selection too long for direct mode" | Shorten the selected text, or enable the Background connection (it supports much larger quotes). |
| "Invalid pairing code" or "already used" | Pairing codes work once, for 10 minutes. Create a new one in the web app. |
| "The free plan includes 2 devices" | Sign out a device in the web app under **Devices & recovery**, or try JotDrop Plus, then create a new code. |
| "Open Settings and allow access to app.jotdrop.net" | The site access was removed in Chrome. Open the clipper settings and press **Allow access to app.jotdrop.net**. |
| "Wrong unlock passphrase" | Use the passphrase you chose for this browser (not your account password). |

## Privacy & security

- The plugin's server binds only to `127.0.0.1`, never the network.
- Every request to it must include the bearer token; without it the server
  returns 401. In direct mode the `obsidian://` URI never contains the token.
- In cloud mode the clip is encrypted in the browser (AES-GCM) before it is
  sent, and only to app.jotdrop.net. The cloud keys are kept in
  `chrome.storage.local`, sealed with your unlock passphrase. "Stay unlocked"
  keeps the unsealed keys only in `chrome.storage.session`, in memory, until the
  browser closes.
- Nothing is stored in `chrome.storage.sync` or sent to any other server.

The full privacy policy is in [privacy-policy.html](privacy-policy.html).

## For developers

`cloud-client.js` is generated from `cloud.mjs` and `../cloud/shared` with
`npm run build:web-clipper`; commit both. `npm run package:web-clipper` builds
the store ZIP from the committed tree and refuses a stale bundle. Checks:
`npm run check:web-clipper`, `node --test cloud/clipper.test.mjs`,
`npm run check:web-clipper-cloud` (popup against a local cloud) and
`npm run check:web-clipper-extension` (the real extension in Edge, paired from
the web app, against a local cloud).

A local cloud (`npm run cloud:dev`) refuses the extension until its origin is
allowed: start it with
`JOTDROP_CLOUD_CORS_ORIGINS=chrome-extension://<your extension ID>`.

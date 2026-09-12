# JotDrop Web Clipper (Chrome extension)

Save the current browser page as a card in your JotDrop vault.

## Install from the Chrome Web Store (recommended)

Install directly from the store: [JotDrop Web Clipper](https://chromewebstore.google.com/detail/obsidrop-web-clipper/mkgcicjljogifeaccaclbcoemllmgjfo) — one click to install, and updates arrive automatically.

## Zero-config quick start

No token, no port, no options page needed:

1. Install the JotDrop plugin in Obsidian (Community plugins → **JotDrop**).
2. Install the [Web Clipper](https://chromewebstore.google.com/detail/obsidrop-web-clipper/mkgcicjljogifeaccaclbcoemllmgjfo) from the Chrome Web Store.
3. Click the JotDrop icon on any page and press **Save** — Obsidian opens and creates the card.

## Optional: Background connection

By default, every save brings Obsidian to the foreground. If you prefer silent,
background clipping, connect the clipper to the plugin:

1. In Obsidian, open **Settings → JotDrop → Web clipper**.
2. Toggle **Enable clip server** on, then click **Copy** next to the token.
3. In the extension: right-click the icon → **Background connection**, paste the token, click **Save and test connection** — it should report "Connection OK".

Saves now go straight into the vault without focusing Obsidian. If the
connection ever fails, the clipper automatically falls back to opening Obsidian
as usual, so a clip is never lost.

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

## Use

Click the extension icon on any page. The popup shows the page title and lets
you add tags, pick a color, or pin the card before saving. **Save to JotDrop**
writes a card into your vault's notes folder; with article-image handling
enabled in JotDrop, the page's preview image is embedded.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Obsidian does not open on Save | Make sure Obsidian desktop is installed and opened at least once so the `obsidian://` protocol is registered; then try the save again. |
| Background connection test fails | Obsidian desktop, the JotDrop plugin, and its clip server must be running; re-copy the token from the plugin settings. |
| Wrong port or token | Open **Background connection → Advanced**, correct the port (default 27124), and paste the token again. |
| "Selection too long for direct mode" | Shorten the selected text, or enable the Background connection (it supports much larger quotes). |

## Privacy & security

- The plugin's server binds only to `127.0.0.1`, never the network.
- Every request must include the bearer token; without it the server returns
  401.
- In direct mode the `obsidian://` URI never contains the bearer token.
- The extension only stores `port` and `token` (both optional) in
  `chrome.storage.local`, never synced to your Google account.
- If you regenerate the token in the plugin, paste the new one in **Background
  connection** here.

The full privacy policy is in [privacy-policy.html](privacy-policy.html).
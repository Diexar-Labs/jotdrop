# JotDrop Web Clipper (Chrome extension)

Save the current browser page as a card in your JotDrop vault.

## Install (developer mode, until published)

1. Open `chrome://extensions` in Chrome / Edge / Brave.
2. Toggle **Developer mode** on.
3. Click **Load unpacked** and select this `chrome-extension/` folder.
4. The extension icon (puzzle piece by default) appears in the toolbar.

## Pair with the plugin

1. In Obsidian, open **Settings → JotDrop → Web clipper**.
2. Toggle **Enable clip server** on. A token is generated.
3. Click **Copy** next to the token.
4. In the extension: right-click the icon → **Options**, paste the token, click **Save**.
5. Click **Test connection** — should report "Connection OK".

## Use

Click the extension icon on any page. The popup shows the page title and lets
you add tags / pick a color before saving. **Save to JotDrop** writes a card
into your vault's notes folder with an OG-image preview.

If Obsidian is closed or the plugin is disabled, the popup falls back to
opening an `obsidian://jotdrop-clip?...` URI — Obsidian launches and the
plugin handles the clip on load.

## Privacy & security

- The plugin's server binds only to `127.0.0.1`, never the network.
- Every request must include the bearer token; without it the server returns
  401.
- The extension only stores `port` and `token` in `chrome.storage.local`,
  never syncs to your Google account.
- If you regenerate the token in the plugin, paste the new one in **Options**
  here.

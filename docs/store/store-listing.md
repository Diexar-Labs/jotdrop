# JotDrop Web Clipper - Chrome Web Store Listing (0.1.3)

Existing item: `mkgcicjljogifeaccaclbcoemllmgjfo` (publisher `DiexarLabs`,
public contact `eric@diexar.com`). Upload the exact GitHub ZIP
`jotdrop-web-clipper-0.1.3.zip` from the verified
`web-clipper-v0.1.3` release. Never create a new item; keep public
distribution; 0.1.2 stays live while 0.1.3 is pending review.

## Store fields

- **Name:** JotDrop Web Clipper (renamed by the package manifest)
- **Short description:** `Save pages, links, selected text, tags, colors, and preview images directly to JotDrop in your Obsidian vault.`
- **Publisher:** DiexarLabs
- **Contact:** eric@diexar.com
- **Category:** Tools → Productivity
- **Website/source:** `https://github.com/Diexar-Labs/jotdrop`
- **Support:** `https://github.com/Diexar-Labs/jotdrop/issues`
- **Privacy policy URL:** `https://raw.githubusercontent.com/Diexar-Labs/jotdrop/main/chrome-extension/privacy-policy.html`
- **Public distribution:** on

## Screenshots (640x400 – 1280x800)

| File | Shows |
| --- | --- |
| `docs/screenshots/plugin-grid-1280.webp` (1280x772) | JotDrop card grid in Obsidian |
| `docs/screenshots/clipper-popup-cnn-1280.webp` (1280x646) | Web Clipper popup on a real article, direct-mode badge visible |
| `docs/screenshots/clipper-background-connection.webp` (1280x634) | Optional Background connection page |

Do not reuse the old ObsiDrop-branded screenshots.

## Full listing copy

**JotDrop Web Clipper - Google Keep-style clipping, straight into Obsidian.**

Save any web page, link, or selected text into your Obsidian vault as a clean
Markdown card - with tags, colors, pinning, and an automatic preview image.
No account, no cloud, no telemetry: your clips land as plain `.md` files in
your own vault.

### Setup in three steps (zero-config)

1. Install the JotDrop plugin in Obsidian.
2. Install this extension.
3. Click Save - Obsidian opens and your card is there.

No token, no port, no settings screen required.

### What gets captured

Page title and URL, your text selection (if any), tags, a color, a pin flag,
and an optional preview image (controlled by JotDrop's settings). Everything
arrives as an editable Markdown note with YAML frontmatter, so it stays yours
- editable in Obsidian, VS Code, or any text editor.

### Optional: Background connection

Prefer silent saves? Pair the clipper once with the JotDrop plugin's local
clip server and saves run quietly in the background - Obsidian never jumps to
the foreground. If the connection ever fails, the clipper automatically falls
back to the direct URI, so a clip is never lost.

### Requirements

- Obsidian desktop with the JotDrop plugin 0.20.3 or newer
- Google Chrome, Edge, or Brave

### Privacy

Everything stays local: clips travel either over `127.0.0.1` to the JotDrop
plugin on your own computer, or through the local `obsidian://` protocol -
never through a cloud relay. No account, no analytics, no telemetry, no ads.
The optional token and port are stored only in `chrome.storage.local` on your
device. See our privacy policy for the full details.

### Open source & support

- Source: https://github.com/Diexar-Labs/jotdrop
- Support/issues: https://github.com/Diexar-Labs/jotdrop/issues

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
2. Click the extension icon on any page and press Save - Obsidian opens and
   creates a Markdown card. No configuration is needed.
3. Optionally enable the clip server in the plugin settings and paste the
   token in the extension's "Background connection" page; "Save and test
   connection" reports "Connection OK" while the server is running.
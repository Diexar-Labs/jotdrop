# JotDrop Web Clipper - Chrome Web Store Listing (0.1.3)

Existing item: `mkgcicjljogifeaccaclbcoemllmgjfo` (publisher `DiexarLabs`,
public contact `eric@diexar.com`). Version 0.1.3 was published publicly on
2026-09-13. For future updates, upload the exact GitHub ZIP from the verified
release, never create a new item, and keep public distribution enabled.

## Store fields

- **Name:** JotDrop Web Clipper (renamed by the package manifest)
- **Short description:** `Google Keep-style clipping straight into Obsidian. Save pages, links, and selected text as Markdown notes in your own vault.`
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

**JotDrop Web Clipper - the Google Keep alternative that saves straight into Obsidian.**

JotDrop is a private, open-source Google Keep alternative built for Obsidian.
Save any web page, link, or selected text into your vault as a clean Markdown
note - with tags, colors, pinning, and an automatic preview image. No account,
no cloud, no telemetry: your clips land as plain `.md` files in your own vault.

**REQUIRES OBSIDIAN:** This extension does nothing on its own. It only works
when the JotDrop plugin is installed and running inside the Obsidian desktop
app. Do not install if you don't use Obsidian.

### Why a Google Keep alternative?

Google Keep is a great tool - until you look at what you give up for it:

- Your notes live on Google's servers, tied to a Google account, under
  Google's terms - not yours.
- Keep notes are not plain Markdown, and getting them out later is never
  trivial.
- No real files, no folder you control, no open format you can edit in any
  editor.
- Your notes app is one product decision away from ads and upsells.

JotDrop keeps the part of Google Keep everyone loves - the fast, friction-free
"dump a thought" card - and changes where your notes live: your own Obsidian
vault, as plain Markdown files that you own forever.

### What JotDrop does better than Google Keep

- **Plain Markdown, always** - every clip is an editable `.md` file with YAML
  frontmatter, readable in Obsidian, VS Code, Vim, or any text editor.
- **Local-first privacy** - clips travel over `127.0.0.1` or the local
  `obsidian://` protocol. They never touch a cloud relay.
- **Your vault, your files** - notes land in a folder you control. Sync them
  with Syncthing, iCloud, Obsidian Sync, or any folder sync you already use.
- **Open source (MIT)** - auditable, free, no premium tier, no ads, ever.
- **Part of a trio** - JotDrop is a Google Keep-style card grid in Obsidian,
  plus a companion Android app with share-sheet capture, OCR, and voice memos.

If you have ever wished Google Keep saved straight into Obsidian as Markdown,
JotDrop is exactly that.

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

### Who is JotDrop for?

- Obsidian users who miss Google Keep's quick-capture cards
- Google Keep users who want out of the cloud without losing the speed
- Privacy-minded note-takers who want plain files instead of a proprietary
  export
- Researchers and writers who clip the web all day and want it in their
  vault, not in a walled garden

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

# ObsiDrop

Google Keep–style quick-capture for [Obsidian](https://obsidian.md/). One product, two clients that share a single vault folder:

- **Obsidian plugin** — card-grid view, fast capture, tags, archive, colors, checklists, link previews (root of this repo).
- **Android app** — share-target + standalone capture with OCR, voice-to-text, image embeds, link previews ([`android/`](android/)).

Both write plain Markdown notes with YAML frontmatter into the same vault folder. Sync them with [Syncthing](https://syncthing.net/) (or any folder sync) and you have Google Keep, on your own files, on every device.

## Status

Pre-1.0. Working end-to-end. Plugin v0.10.0, Android v0.15.0.

## Installation

### Obsidian plugin (manual)

1. Download `manifest.json`, `main.js`, `styles.css` from the latest [release](https://github.com/Diexar-Labs/obsidrop/releases).
2. Drop them in `<vault>/.obsidian/plugins/obsidrop/`.
3. Enable in Obsidian → Settings → Community plugins.

### Android app

Download the latest `obsidrop-debug.apk` from [releases](https://github.com/Diexar-Labs/obsidrop/releases) and install (you'll need to allow installs from this source). Point it at the same vault folder you sync with Obsidian.

## Languages

UI in English (default) and Dutch. Skeletons exist for Spanish, German, French, Italian — contributions welcome.

## Support

Open source, MIT-licensed. No premium tiers. If it saves you time and you'd like to say thanks:

- [Ko-fi](https://ko-fi.com/L3L11ZETB9)
- GitHub Sponsors (pending approval)

## License

MIT

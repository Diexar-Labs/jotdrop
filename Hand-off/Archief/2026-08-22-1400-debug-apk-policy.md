ARCHIEF - NIET ACTUEEL

# JotDrop Handoff

## Source Of Truth

Verified on 2026-08-22 against the live GitHub remote:

- Repository: `https://github.com/Diexar-Labs/jotdrop.git`
- Canonical ref: `origin/main`
- Canonical commit: `6f37f983720944eb34e50c904273243f338b622d`
- Obsidian plugin version: `0.20.0`
- Android app version: `0.28.0`, versionCode `54`
- Tags: `0.20.0` and `v0.28.0`

Refresh the remote before relying on these values. This clean clone is the
only permitted implementation base for the latest-source port.

## Unsafe Checkouts

The primary checkout at `F:\New Dee\My Business\App IDE\Obsidian Keep Plugin`
was behind `origin/main` and contains unrelated uncommitted work. Do not reset,
clean, build releases, or deploy from it.

The temporary checkout at
`C:\Users\Proteus\AppData\Local\Temp\kilo\jotdrop-ime-release` has the
canonical commit but uncommitted deletions of multiple `src/*.ts` files. Do not
use that working tree as a build or recovery source.

## Release Safety

- `npm run verify:release` is required before release builds.
- `npm run deploy:local` is the only local plugin deploy path and requires a
  clean checkout based on live main plus `JOTDROP_VAULT_PLUGIN_DIR`.
- A release artifact must record its source commit, plugin version, Android
  version, versionCode, and verification result.
- Never solve an Android install warning by increasing versionCode on older
  source.

## Pending Port

The approved patch branch ports the mobile loading, tag input, Android focus,
horizontal overflow, and release provenance fixes onto this verified commit.
Target versions are Obsidian `0.20.1` and Android `0.28.1` / versionCode `55`.

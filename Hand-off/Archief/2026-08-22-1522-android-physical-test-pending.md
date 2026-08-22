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
- Debug APK generation and debug installation are disabled. `compileDebugKotlin`
  remains available only for compile validation.
- Build the optimized APK with `npm run android:release`; its only accepted
  output is `android/app/build/outputs/apk/release/app-release.apk`.
- For local Android testing before merge, use `npm run android:test-release`.
  This still builds the optimized release variant, but is explicitly not a
  production release and uses `verify:base` instead of the final release gate.
- Verify an existing artifact with `npm run android:verify -- <release-apk>` and
  install only with `npm run android:install -- <release-apk>`. Installation
  uses `adb install -r` and never uninstalls or downgrades.
- A release artifact must record its source commit, plugin version, Android
  version, and versionCode.
- Never solve an Android install warning by increasing versionCode on older
  source.

## Pending Port

The approved patch branch ports the mobile loading, tag input, Android focus,
horizontal overflow, and release provenance fixes onto this verified commit.
Target versions are Obsidian `0.20.1` and Android `0.28.1` / versionCode `55`.

## Android Test Status

- The local R8 test-release APK was built and verified from this clone.
- APK path: `android/app/build/outputs/apk/release/app-release.apk`
- Verified package: `com.diexar.keepcapture`
- Verified version: `0.28.1`, versionCode `55`, signer valid.
- The list now creates the configured notes subfolder on first load when the
  selected vault is writable, so a missing default `Mini Notes` folder no
  longer blocks startup.
- Empty-state text now explicitly uses the theme's light-on-dark content color.
- Physical-device installation and behavior testing remain pending because ADB
  reported no connected device in this environment.

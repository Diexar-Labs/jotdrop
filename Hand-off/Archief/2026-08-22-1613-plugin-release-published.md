ARCHIEF - NIET ACTUEEL

# JotDrop Handoff

## Source Of Truth

Verified on 2026-08-22 against the live GitHub remote:

- Repository: `https://github.com/Diexar-Labs/jotdrop.git`
- Canonical ref: `origin/main`
- Canonical commit: `2594f0ac0c71303d8c184188aaab788fbc3e510a`
- Obsidian plugin version: `0.20.1`
- Android app version: `0.28.1`, versionCode `55`
- CI fix commit pushed to GitHub: `2594f0a` (`main`)

Refresh the remote before relying on these values. The clean port checkout is
the only permitted implementation base for the latest-source work.

## CI Status

- Failed run `32577098153` was diagnosed as a provenance race: it built
  `2530426` while `origin/main` had already moved to `ae8ebfa`.
- The release verifier now uses the immutable GitHub Actions event SHA in CI,
  while local release checks still require `HEAD == origin/main`.
- Corrected run `32577388257` succeeded and produced the release APK and plugin
  artifacts.
- GitHub Actions cache/service and Node 20 deprecation annotations were
  warnings only and did not fail the corrected job.

## Unsafe Checkouts

The primary checkout at `F:\New Dee\My Business\App IDE\Obsidian Keep Plugin`
is behind `origin/main` and contains unrelated uncommitted work. Do not reset,
clean, build releases, or deploy from it.

The temporary checkout at
`C:\Users\Proteus\AppData\Local\Temp\kilo\jotdrop-ime-release` has stale
uncommitted source deletions. Do not use that working tree as a build or
recovery source.

## Verification

- `npm run verify:release` passed locally on the clean pushed source.
- Corrected GitHub Actions run `32577388257` passed in 4m51s.
- The R8 Android artifact is `android/app/build/outputs/apk/release/app-release.apk`.
- Verified package: `com.diexar.keepcapture`.
- Verified version: `0.28.1`, versionCode `55`, signer valid.
- Plugin and Android app physical tests passed, including Android tag entry with
  comma separators and renewed SAF access to the vault.

# JotDrop Source-of-Truth Gate

This project has a strict version gate. Read `Hand-off/HANDOFF.md` before
implementation or release work.

1. Run `git fetch origin main --tags --prune` before relying on source status.
2. Compare `git rev-parse HEAD` with `git ls-remote origin refs/heads/main`.
3. Stop if the remote SHA changed while using a plan pinned to another commit.
4. A dirty checkout is never a release source and must not be deployed.
5. Run `npm run verify:base` for a feature branch based on current main.
6. Run `npm run verify:deploy` only from a clean, committed feature branch.
7. Run `npm run verify:release` before release builds; it requires exact
   `HEAD == origin/main` and a clean tree.
8. `npm run build` must never copy files into an Obsidian vault. Use the
   explicit `JOTDROP_VAULT_PLUGIN_DIR=... npm run deploy:local` command for a
   clean, committed local deployment.
9. `npm run dev` and `npm run build` both execute `verify:base` first. Never
   bypass that gate with `build:plugin`; it exists only as the internal build
   step after provenance verification.
10. Never increase Android `versionCode` to force-install an older source tree.
11. Debug APK generation and installation are disabled because debug Compose
    builds have unusable scroll performance. Use `compileDebugKotlin` only for
    compile validation.
12. Use `npm run android:release` for the R8 release APK. Use only the printed
    `android/app/build/outputs/apk/release/app-release.apk` path.
13. Before merge, use `npm run android:test-release` for a local R8 test APK;
    it is never a production release and remains distinct from
    `npm run android:release`.
14. Use `npm run android:verify -- <apk>` before handling an APK and
    `npm run android:install -- <apk>` for update installation. Never use
    `adb uninstall`, `-d`, or an APK from an `apk/debug` directory.
15. Plugin release tags must exactly match `manifest.json` without a `v` prefix.
    Android release tags must exactly match `v<versionName>`. Run
    `npm run verify:tag -- <tag>` before pushing any release tag.

The canonical source is `https://github.com/Diexar-Labs/jotdrop.git` at
`origin/main`. The verified revision and unsafe checkouts are recorded in the
handoff.

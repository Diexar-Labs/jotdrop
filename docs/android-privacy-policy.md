# JotDrop Android Privacy Policy

Last updated: October 8, 2026

JotDrop (`com.diexar.keepcapture`) is a local-first Android notes app from Diexar Labs. Contact us at [eric@diexar.com](mailto:eric@diexar.com) about privacy questions.

## Your notes and media

JotDrop does not require an account and does not send your notes, photos, voice memos, or OCR results to a Diexar Labs server. Markdown notes and their attachments are stored in the vault folder you select on your device. Photos you capture or share are saved there in their original quality; voice memos are recorded there as audio files. OCR runs on the device. JotDrop does not include advertising, its own analytics, or a crash-reporting service.

OCR uses Google's bundled ML Kit SDK. Google documents that this SDK sends limited device and app information, a per-installation identifier, and performance and usage metrics to Google over HTTPS for diagnostics and usage analytics. Images supplied for OCR and the recognized text are processed on-device, not sent to Google. See [ML Kit's data disclosure](https://developers.google.com/ml-kit/android-data-disclosure) and [privacy terms](https://developers.google.com/ml-kit/terms).

If you choose to sync your vault with another app or service, such as Syncthing or Obsidian Sync, that service handles your files under its own privacy policy. The vault is not automatically encrypted by JotDrop. You can edit, export, or delete your files in your chosen folder at any time.

## When JotDrop connects to the internet

- When you save a web link, JotDrop may request the page and its Open Graph preview image from the website you chose. Some links use a public preview endpoint, including TikTok oEmbed or fxtwitter.com for X links. Those sites receive the requested URL, your IP address, and a browser-style user-agent. The downloaded preview is stored in your vault. You can turn off preview-image downloads in the app settings.
- JotDrop checks the public GitHub releases API for updates, at most once per day unless you request another check. GitHub receives the connection's IP address and the `JotDrop-Android` user-agent. No note contents are included.
- Links to the voluntary Google Play tester group or Ko-fi open in your external browser only when you tap them. Those services process visits under their own policies; joining the tester group shares your Google account address with the group owner, not with other members.

Starting with Android 0.28.9, JotDrop enforces HTTPS for preview requests, including redirects and preview images, and explicitly blocks cleartext traffic on all supported Android versions. Plain HTTP links can still be saved as notes, but their previews are not fetched. Version 0.28.8 and earlier builds may fetch HTTP previews without transport encryption on Android 8; update to 0.28.9 or later for this protection. GitHub update checks and ML Kit diagnostics use HTTPS. Device storage encryption does not encrypt network traffic. External browsers, speech services and vault-sync providers manage their own connections.

## Speech recognition

Recording a voice memo stores audio in your vault without uploading it through JotDrop. Separately, if you tap speech-to-text, JotDrop opens the recognition app installed on your device. That app, often provided by Google, captures your speech directly and may process audio online under its own privacy policy. Speech-to-text is optional; JotDrop does not send audio to that app or receive an audio copy from it, only the recognized text you choose to put in your note.

## Device access and backups

JotDrop asks for microphone access when recording audio, notification access for reminders, internet access for link previews and update checks, and boot events to restore reminders. The Android system picker grants access only to the vault or media you select. App preferences, including the selected vault-folder reference, can be included in your device's Android backup if backup is enabled. Your vault files are outside JotDrop's app-private backup; their backup and deletion depend on the folder and sync services you choose.

You can revoke app permissions in Android settings, remove app preferences by clearing app data or uninstalling, and delete notes and attachments from your own vault. Google or other external services may retain data under their own policies. JotDrop is not designed for children under 13.

We may update this policy as the app changes. The current version is published in this repository. Questions: [eric@diexar.com](mailto:eric@diexar.com).

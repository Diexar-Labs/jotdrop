# JotDrop Android Privacy Policy

Last updated: November 12, 2026

JotDrop (`com.diexar.keepcapture`) is a local-first Android notes app from Diexar Labs. Contact us at [eric@diexar.com](mailto:eric@diexar.com) about privacy questions.

## Your notes and media

JotDrop does not require an account. Unless you turn on the optional JotDrop Cloud described below, it does not send your notes, photos, voice memos, or OCR results to a Diexar Labs server. Markdown notes and their attachments are stored in the vault folder you select on your device. Photos and other files you capture, attach or share to JotDrop are saved there as they are (photos in their original quality); voice memos are recorded there as audio files. OCR runs on the device. JotDrop does not include advertising, its own analytics, or a crash-reporting service.

OCR uses Google's bundled ML Kit SDK. Google documents that this SDK sends limited device and app information, a per-installation identifier, and performance and usage metrics to Google over HTTPS for diagnostics and usage analytics. Images supplied for OCR and the recognized text are processed on-device, not sent to Google. See [ML Kit's data disclosure](https://developers.google.com/ml-kit/android-data-disclosure) and [privacy terms](https://developers.google.com/ml-kit/terms).

Scanning a document uses Google's ML Kit document scanner, which Google Play services provides. It opens the camera, finds the edges of the page and gives JotDrop only the pages you keep, as images and a PDF; JotDrop itself does not need camera access for this. Google [documents](https://developers.google.com/ml-kit/vision/doc-scanner) that the scanning runs on the device. Google Play services downloads the scanner the first time you use it, and the ML Kit data disclosure above applies. JotDrop then reads the text and looks for an expiry date on the device. It only suggests that date: nothing is saved until you choose Save.

If you choose to sync your vault with another app or service, such as Syncthing or Obsidian Sync, that service handles your files under its own privacy policy. The vault is not automatically encrypted by JotDrop. You can edit, export, or delete your files in your chosen folder at any time.

## JotDrop Cloud (optional)

You can create a free JotDrop Cloud account to sync your notes between devices, with Google, GitHub, or an email address and password. Your notes and attachments are encrypted on your device before they are uploaded; the server stores them encrypted and cannot read them. The server does keep your account email address, your device names, which JotDrop app and version each device uses, and the size and save time of each encrypted file. The full details, retention periods, processors and your rights are in the [JotDrop Cloud privacy policy](https://app.jotdrop.net/privacy).

- **Continue with Google** uses Android's own Google account picker, provided by Google Play services. Google learns that you signed in to JotDrop; JotDrop receives only your Google account ID and your verified email address. If that picker is unavailable, the sign-in opens in your browser instead.
- **New email accounts** may open a Cloudflare Turnstile check in your browser to confirm that you are a person.
- **Keys on this phone:** the connection to your cloud and the key to your notes are stored in JotDrop's private storage, encrypted with a key from the Android Keystore, and are excluded from Android backups. Your recovery code is shown once; JotDrop cannot show it again.
- **Sync** runs in the background over HTTPS when you have turned it on, and only for the notes and attachment folders in your chosen vault. You can pause it, disconnect this phone, or delete your cloud account in the app.
- **Shared groups:** the people you invite can read and change the notes you share with them. The notes, the group's name and the names people choose are encrypted on your device. Our server stores which accounts are in which group, when something changed, how large the files are and which device saved a version. The owner of a group can see the email addresses of everyone in it. What you wrote stays with the others after you leave. A report you send from a group reaches us with your email address, the email address of the person you report, the group's ID and what you wrote. If you block someone, our server stores which account blocked which until either account is deleted.

## Ask JotDrop: AI with your own key (optional)

Ask JotDrop is an assistant you can give tasks to in your own words, typed or dictated. It is off until you choose an AI service in Settings and enter your own key: Anthropic (Claude), OpenAI, Google (Gemini), OpenRouter, or an https address of your own that speaks the OpenAI API, such as a server that runs Ollama. When you send a request, the app sends it straight from your phone to that service, together with the notes listed under "What goes along" and any note the AI reads while it answers, at most 20 notes or 30,000 characters at a time. You see that list before you send and can take notes off it. If you use "Rewrite with AI", "Make a checklist with AI" or "Summarize with AI" in the editor, only the text of that note is sent. Notes in shared groups and notes with a live list link stay out unless you switch them on. A photo, PDF or recording from a note goes along only when you pick it: you tick it in that list, or you choose Transcribe with AI, Read photo with AI or Receipt to Paper drawer in the note's menu, and the file shows by name before you send. The app makes a photo smaller on your phone first and sends it as a JPEG; a PDF or a recording goes as it is. OpenAI writes out a recording at its own address, with its own transcription model. On OpenRouter, a model that cannot read PDFs gets the text of the PDF instead, which OpenRouter makes with a conversion service it works with. A photo or recording can hold details of other people, so only send what you may share. Reading text from a photo with OCR, described above, is different: it stays on the phone and sends nothing to an AI service. Nothing of this passes through our servers, and we never see your key.

- **Your key** is stored in JotDrop's private storage on this phone, encrypted with a key from the Android Keystore, and excluded from Android backups. It is not synced to your other devices. "Turn off and remove key" deletes it.
- **The AI service** handles what you send under your own agreement with it; we are not part of that and do not process it for you. Some services may use what you send, files included, to improve their products, Google for example on the free tier of the Gemini API outside the EEA, Switzerland and the UK, so read the terms of the service you pick.
- **Changes to your notes** happen only on your phone. A new note is made at once; a change to a note you already have, a label, a reminder or an expiry date waits until you say yes.
- **Dictating** a request uses the speech recognition app on your phone, as described under Speech recognition below.
- **Reporting an answer** opens your mail app with an email to hello@jotdrop.net that holds the question and the answer. We use it only to look into the report and reply.

## When JotDrop connects to the internet

- If you use Ask JotDrop, the app connects over HTTPS to the AI service you chose, only when you send a request or load the list of models in Settings.
- When you save a web link, JotDrop may request the page and its Open Graph preview image from the website you chose. Some links use a public preview endpoint, including TikTok oEmbed or fxtwitter.com for X links. Those sites receive the requested URL, your IP address, and a browser-style user-agent. The downloaded preview is stored in your vault. You can turn off preview-image downloads in the app settings.
- If you use JotDrop Cloud, JotDrop connects to `app.jotdrop.net` to sign in and to sync encrypted files, as described above.
- JotDrop checks the public GitHub releases API for updates, at most once per day unless you request another check. GitHub receives the connection's IP address and the `JotDrop-Android` user-agent. No note contents are included.
- Versions 0.28.23 and earlier also offered an email link to join the Google Play test; it was removed in 0.28.24.

Starting with Android 0.28.9, JotDrop enforces HTTPS for preview requests, including redirects and preview images, and explicitly blocks cleartext traffic on all supported Android versions. Plain HTTP links can still be saved as notes, but their previews are not fetched. Version 0.28.8 and earlier builds may fetch HTTP previews without transport encryption on Android 8; update to 0.28.9 or later for this protection. GitHub update checks and ML Kit diagnostics use HTTPS. Device storage encryption does not encrypt network traffic. External browsers, speech services and vault-sync providers manage their own connections.

## Speech recognition

Recording a voice memo stores audio in your vault without uploading it through JotDrop. If you choose Transcribe with AI on a note, the app sends that recording straight to the AI service you chose, as described under Ask JotDrop above. Separately, if you tap speech-to-text, JotDrop opens the recognition app installed on your device. That app, often provided by Google, captures your speech directly and may process audio online under its own privacy policy. Speech-to-text is optional; JotDrop does not send audio to that app or receive an audio copy from it, only the recognized text you choose to put in your note.

## Device access and backups

JotDrop asks for microphone access when recording audio, notification access for reminders, internet access for link previews, update checks, JotDrop Cloud and Ask JotDrop, and boot events to restore reminders. The Android system picker grants access only to the vault or media you select. App preferences, including the selected vault-folder reference, can be included in your device's Android backup if backup is enabled. Your vault files are outside JotDrop's app-private backup; their backup and deletion depend on the folder and sync services you choose.

You can revoke app permissions in Android settings, remove app preferences by clearing app data or uninstalling, and delete notes and attachments from your own vault. Google or other external services may retain data under their own policies. JotDrop is not designed for children under 13.

We may update this policy as the app changes. The current version is published in this repository. Questions: [eric@diexar.com](mailto:eric@diexar.com).

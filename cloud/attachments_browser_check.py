"""Run: python cloud/attachments_browser_check.py [browser-channel]. Any file in a note: attached from the editor, shown as a chip
on the card and in the editor, downloaded whole; and a mail note (date only in its name) sorts on top of its day. Synthetic files only."""
import os
import sys
from pathlib import Path
sys.dont_write_bytecode = True
from browser_check import main

SHOTS = os.environ.get("JOTDROP_SHOTS_DIR")
PDF = b"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n" + bytes(range(256)) * 40


def shot(page, name):
    if SHOTS:
        page.screenshot(path=str(Path(SHOTS) / f"{name}.png"), full_page=True)


def check_attachments(browser, url, token):
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" and "Failed to load resource" not in message.text else None)
    page.on("dialog", lambda dialog: dialog.accept())

    def synced():
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

    def card(text):
        return page.locator(".note-card").filter(has_text=text)

    def titles():
        return page.locator(".note-card h3").all_text_contents()

    def new_note(path, content):
        page.locator("#new-note").click()
        page.locator("#editor[open]").wait_for()
        page.locator("#note-path").fill(path)
        page.locator("#note-content").fill(content)
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#editor:not([open])").wait_for(state="attached")
        synced()

    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic attachments passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()

        # Attach a file to a new note from the editor: it is kept, linked as ![[name]] and the note gets the file's name as title.
        page.locator("#new-note").click()
        page.locator("#editor[open]").wait_for()
        page.locator("#note-path").fill("notes/2026-11-03 090000 Report.md")
        page.locator("#attach-file").set_input_files({"name": "Quarterly [draft] #2.pdf", "mimeType": "application/pdf", "buffer": PDF})
        page.locator("#editor-message").filter(has_text="File kept as encrypted attachments").wait_for()
        content = page.locator("#note-content").input_value()
        assert content == "# Quarterly _draft_ _2\n\n![[Quarterly _draft_ _2.pdf]]\n", content
        page.locator("#note-content").fill("# Report\n\nThe figures are in the file.\n\n![[Quarterly _draft_ _2.pdf]]\n")
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#editor:not([open])").wait_for(state="attached")
        synced()
        shot(page, "attachments-card")

        # The card shows the file as a chip with name and size, not as a Markdown line; a click downloads the same bytes.
        chip = card("Report").locator(".file-chip")
        chip.wait_for()
        assert chip.count() == 1, chip.count()
        text = chip.inner_text()
        assert text.startswith("Quarterly _draft_ _2.pdf") and "KiB" in text, text
        assert "![[" not in card("Report").inner_text()
        with page.expect_download() as download:
            chip.click()
        assert Path(download.value.path()).read_bytes() == PDF
        assert download.value.suggested_filename == "Quarterly _draft_ _2.pdf"
        # The chip never opened the note.
        assert not page.locator("#editor[open]").count()

        # The editor shows the same chip above the text and downloads from there too.
        card("Report").hover()
        card("Report").get_by_role("button", name="Open note", exact=True).click()
        page.locator("#editor[open]").wait_for()
        strip = page.locator("#note-media")
        assert strip.is_visible() and strip.locator(".file-chip").count() == 1
        with page.expect_download() as again:
            strip.locator(".file-chip").click()
        assert Path(again.value.path()).read_bytes() == PDF
        shot(page, "attachments-editor")

        # A second file with the same name but other bytes gets the next number; the same bytes reuse the file.
        page.locator("#attach-file").set_input_files([
            {"name": "Quarterly [draft] #2.pdf", "mimeType": "application/pdf", "buffer": PDF + b"v2"},
            {"name": "Quarterly [draft] #2.pdf", "mimeType": "application/pdf", "buffer": PDF},
        ])
        page.locator("#editor-message").filter(has_text="Files kept as encrypted attachments").wait_for()
        content = page.locator("#note-content").input_value()
        assert content.count("![[Quarterly _draft_ _2.pdf]]") == 2 and "![[Quarterly _draft_ _2 2.pdf]]" in content, content
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#editor:not([open])").wait_for(state="attached")
        synced()
        assert card("Report").locator(".file-chip").count() == 2, card("Report").locator(".file-chip").all_text_contents()
        page.locator('[data-view="files"]').click()
        names = page.locator(".note-card h3").all_text_contents()
        assert sorted(names) == ["Quarterly _draft_ _2 2.pdf", "Quarterly _draft_ _2.pdf"], names
        page.locator('[data-view="notes"]').click()

        # Manual order: a mail note, named with the day only, sits on top of that day, under the next day.
        new_note("notes/2026-11-03 080000 Typed early.md", "# Typed early\n\nMorning.")
        new_note("notes/Mail/2026-11-03 Dit is een test a1b2c3.md", "# Dit is een test\n\nFrom mail.\n\n#mail")
        new_note("notes/2026-11-04 070000 Next day.md", "# Next day\n\nLater.")
        assert page.locator("#sort").input_value() == "manual"
        assert titles() == ["Next day", "Dit is een test", "Report", "Typed early"], titles()
        shot(page, "attachments-order")
        assert not errors, errors
        return {"chips": 2, "order": titles()}
    finally:
        context.close()


if __name__ == "__main__":
    main(check_attachments, history_limit=100)

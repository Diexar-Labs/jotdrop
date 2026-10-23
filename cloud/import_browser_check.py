"""Run: python cloud/import_browser_check.py. Synthetic import and plain-card checks only."""
import base64
import io
import json
import sys
import tempfile
import zipfile
from pathlib import Path
sys.dont_write_bytecode = True
from browser_check import main

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
USEC = 1760000000000000


def fixtures(folder):
    takeout = io.BytesIO()
    with zipfile.ZipFile(takeout, "w") as archive:
        archive.writestr("Takeout/Keep/Groceries.json", json.dumps({
            "title": "Keep groceries", "textContent": "Milk and bread #weekend", "color": "YELLOW", "isPinned": False,
            "isArchived": False, "isTrashed": False, "labels": [{"name": "Home"}], "attachments": [{"filePath": "photo.png"}],
            "createdTimestampUsec": USEC, "userEditedTimestampUsec": USEC + 1000000}))
        archive.writestr("Takeout/Keep/Old.json", json.dumps({
            "title": "Keep archived", "textContent": "Old idea", "isArchived": True, "isTrashed": False,
            "createdTimestampUsec": USEC, "userEditedTimestampUsec": USEC}))
        archive.writestr("Takeout/Keep/Gone.json", json.dumps({
            "title": "Keep trashed", "textContent": "Gone", "isTrashed": True, "createdTimestampUsec": USEC, "userEditedTimestampUsec": USEC}))
        archive.writestr("Takeout/Keep/photo.png", PNG)
    paths = {"keep": folder / "takeout.zip", "enex": folder / "Work.enex", "markdown": folder / "Idea.md"}
    paths["keep"].write_bytes(takeout.getvalue())
    paths["enex"].write_text(
        '<?xml version="1.0" encoding="UTF-8"?><en-export><note><title>Evernote plan</title><created>20251001T080000Z</created>'
        '<updated>20251002T080000Z</updated><tag>project x</tag><content><![CDATA[<en-note><div><b>Bold</b> start</div>'
        '<table><tr><td>Step</td><td>Owner</td></tr><tr><td>Draft</td><td>Eric</td></tr></table></en-note>]]></content></note></en-export>',
        encoding="utf-8")
    paths["markdown"].write_text("# Apple idea\n\nA *simple* idea with #realtag\n", encoding="utf-8")
    return paths


def check_import(browser, url, token):
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    dialogs = []
    page.on("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.accept()))
    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic import passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        page.locator("#new-note").click()
        page.locator("#note-path").fill("notes/format.md")
        page.locator("#note-content").fill("# Shopping and **stuff**\n\n**Note:** buy `milk` and ==eggs==\n> quoted *text*\n\n| Item | Qty |\n| --- | --- |\n| Bread | 2 |\n\n- [ ] **buy** cheese\n\\#escaped")
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        card = page.locator(".note-card").filter(has_text="Shopping")
        assert card.locator("h3").inner_text() == "Shopping and stuff", card.locator("h3").inner_text()
        text = card.inner_text()
        for part in ("Note: buy milk and eggs", "quoted text", "Item · Qty", "Bread · 2", "buy cheese", "#escaped"):
            assert part in text, (part, text)
        for mark in ("**", "`", "==", "|", "\\#", "> "):
            assert mark not in text, (mark, text)

        with tempfile.TemporaryDirectory() as temp:
            paths = fixtures(Path(temp))

            def run_import(files, expect):
                page.locator("#import-notes").set_input_files([str(path) for path in files])
                page.locator("#workspace-message").filter(has_text=expect).wait_for(timeout=20000)
                page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for(timeout=20000)

            run_import([paths["keep"]], "Import: 2 imported, 0 already there, 0 could not be imported.")
            assert "Import 2 notes with 1 attachments from Google Keep" in dialogs[-1] and "1 notes in the Keep trash are left out" in dialogs[-1], dialogs
            keep = page.locator(".note-card").filter(has_text="Keep groceries")
            assert "Milk and bread #weekend" in keep.inner_text() and "\\#" not in keep.inner_text(), keep.inner_text()
            assert keep.locator("img").count() == 1, keep.inner_html()
            assert "note-yellow" in keep.get_attribute("class")
            assert page.locator(".note-card").filter(has_text="Keep trashed").count() == 0
            assert page.locator(".note-card").filter(has_text="Keep archived").count() == 0
            page.locator('[data-view="archive"]').click()
            page.locator(".note-card").filter(has_text="Keep archived").wait_for()
            page.locator('[data-view="notes"]').click()

            run_import([paths["enex"]], "Import: 1 imported, 0 already there, 0 could not be imported.")
            plan = page.locator(".note-card").filter(has_text="Evernote plan").inner_text()
            assert "Bold start" in plan and "Step · Owner" in plan and "**" not in plan and "|" not in plan, plan
            run_import([paths["markdown"]], "Import: 1 imported, 0 already there, 0 could not be imported.")
            assert "A simple idea with #realtag" in page.locator(".note-card").filter(has_text="Apple idea").inner_text()

            # Importing the same export again adds nothing.
            run_import([paths["keep"]], "Import: 0 imported, 2 already there, 0 could not be imported.")
            names = page.evaluate("[...document.querySelectorAll('.note-card')].map(card => card.dataset.path)")
            assert sorted(names) == sorted(set(names)), names
            assert any(name.startswith("notes/2025-10-09 ") and name.endswith(" Keep groceries.md") for name in names), names
        assert not errors, errors
        return {"plain_card_text": True, "keep_import": True, "keep_archive_and_trash": True, "keep_photo": True, "evernote_import": True, "markdown_import": True, "reimport_adds_nothing": True}
    finally:
        if sys.exc_info()[0]:
            print({"sync": page.locator("#sync-status").text_content(), "message": page.locator("#workspace-message").text_content(), "dialogs": dialogs, "errors": errors})
        context.close()


if __name__ == "__main__":
    main(check_import, history_limit=100)

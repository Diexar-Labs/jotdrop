"""Run: python cloud/photo_view_browser_check.py. Synthetic check: a photo on a card opens large, with its note and a download."""
import base64
import sys
sys.dont_write_bytecode = True
from browser_check import main


def check_photo_view(browser, url, token):
    context = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))

    def synced():
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

    viewer = page.locator("#photo-viewer")

    def loaded():
        return page.evaluate("() => { const image = document.getElementById('photo-large'); return image.complete && image.naturalWidth === 800; }")

    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic photo view passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        image = base64.b64decode(page.evaluate("""() => {
          const c = document.createElement('canvas'); c.width = 800; c.height = 600;
          const x = c.getContext('2d'); x.fillStyle = '#4a7'; x.fillRect(0, 0, c.width, c.height);
          return c.toDataURL('image/png').split(',')[1];
        }"""))
        page.locator("#upload").set_input_files({"name": "view.png", "mimeType": "image/png", "buffer": image})
        synced()
        page.locator("#new-note").click()
        page.locator("#note-path").fill("notes/2026-10-27 120000 Photo note.md")
        page.locator("#note-content").fill("# Photo note\n\n![](../attachments/view.png)\n\nA note with a photo.")
        page.locator('#editor-form button[type="submit"]').click()
        synced()

        # A click on the photo opens it large, not the editor; the note and a download are one click away.
        card = page.locator(".note-card").filter(has_text="Photo note")
        card.locator("img").click()
        viewer.wait_for()
        assert page.locator("#editor[open]").count() == 0
        assert page.locator("#photo-title").inner_text() == "view.png"
        page.wait_for_function("() => document.getElementById('photo-large').complete")
        assert loaded()
        with page.expect_download() as download:
            page.get_by_role("button", name="Download", exact=True).last.click()
        assert download.value.suggested_filename == "view.png"
        assert download.value.path().read_bytes() == image
        page.get_by_role("button", name="Open note", exact=True).last.click()
        page.locator("#editor[open]").wait_for()
        assert not viewer.is_visible()

        # The editor shows the note's photo above the text; it opens large, without "Open note", and the editor stays.
        thumbnail = page.locator("#note-media .note-media-photo")
        assert thumbnail.count() == 1
        thumbnail.click()
        viewer.wait_for()
        assert page.locator("#photo-open-note").is_hidden()
        page.locator("#close-photo").click()
        viewer.wait_for(state="hidden")
        assert page.locator("#editor[open]").count() == 1
        page.locator("#close-editor").click()
        page.locator("#editor:not([open])").wait_for(state="attached")
        assert page.locator("#note-media").is_hidden()

        # Escape closes the photo; in Files a photo opens large too, without a note to open.
        card.locator("img").click()
        viewer.wait_for()
        page.keyboard.press("Escape")
        viewer.wait_for(state="hidden")
        page.locator('[data-view="files"]').click()
        page.locator(".note-card img").first.click()
        viewer.wait_for()
        assert page.locator("#photo-open-note").is_hidden()
        page.locator("#close-photo").click()
        page.locator('[data-view="notes"]').click()

        # While choosing notes, a click on the photo chooses the card instead.
        card.hover()
        card.get_by_role("button", name="Select note", exact=True).click()
        card.get_by_role("button", name="Select note", exact=True).click()
        assert card.locator(".card-select").get_attribute("aria-pressed") == "false"
        card.get_by_role("button", name="Select note", exact=True).click()
        page.locator(".note-card").filter(has_text="Photo note").locator("img").click()
        assert viewer.is_hidden()
        assert card.locator(".card-select").get_attribute("aria-pressed") == "false"
        page.keyboard.press("Escape")

        # On a phone the photo fits the screen.
        page.set_viewport_size({"width": 390, "height": 800})
        card.locator("img").click()
        viewer.wait_for()
        box = page.locator("#photo-large").bounding_box()
        assert box["x"] >= 0 and box["x"] + box["width"] <= 390, box
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
        assert not errors, errors
        return {"photo_opens_large": True, "download": True, "open_note": True, "editor_shows_photo": True, "files_view": True, "selection_still_selects": True, "phone_fits": True}
    finally:
        if sys.exc_info()[0]:
            page.screenshot(path="photo-view-failure.png")
            print({"sync": page.locator("#sync-status").text_content(), "message": page.locator("#workspace-message").text_content(), "errors": errors})
        context.close()


if __name__ == "__main__":
    main(check_photo_view, history_limit=100)

"""Run: python cloud/attach_everywhere_browser_check.py [browser-channel]. Attach file on the web (phase 3 of the attachments design): from a
card's menu without opening the note, dropped on a card or in the editor, pasted as a screenshot, a too-large file refused before upload,
and the storage meter with its own line for attachments and the Plus sentence from 80%. Synthetic files only."""
import os
import sys
from pathlib import Path
sys.dont_write_bytecode = True
from browser_check import main

SHOTS = os.environ.get("JOTDROP_SHOTS_DIR")
PDF = b"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n" + bytes(range(256)) * 40
PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201a5f645400000000049454e44ae426082")
MEBI = 1048576


def shot(page, name):
    if SHOTS:
        page.screenshot(path=str(Path(SHOTS) / f"{name}.png"), full_page=True)


def check_attach_everywhere(browser, url, token):
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

    def new_note(path, content):
        page.locator("#new-note").click()
        page.locator("#editor[open]").wait_for()
        page.locator("#note-path").fill(path)
        page.locator("#note-content").fill(content)
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#editor:not([open])").wait_for(state="attached")
        synced()

    def drag(selector, kind, name, data, mime):
        """Dispatch a drag event that carries a file, like the operating system does."""
        page.locator(selector).first.evaluate(
            """(element, [kind, name, bytes, mime]) => {
                const transfer = new DataTransfer();
                transfer.items.add(new File([new Uint8Array(bytes)], name, { type: mime }));
                element.dispatchEvent(new DragEvent(kind, { dataTransfer: transfer, bubbles: true, cancelable: true }));
            }""",
            [kind, name, list(data), mime],
        )

    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic attach everywhere passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        new_note("notes/2026-11-11 100000 Offerte.md", "# Offerte\n\nWaiting for the invoice.")
        new_note("notes/2026-11-11 100100 Boodschappen.md", "# Boodschappen\n\n- [ ] Melk\n- [ ] Brood")

        # 1. The card's menu has "Attach file…": the file is kept and linked in the note, and the note is not opened.
        card("Offerte").hover()
        card("Offerte").get_by_role("button", name="More", exact=True).click()
        with page.expect_file_chooser() as chooser:
            page.get_by_role("menuitem", name="Attach file…").click()
        chooser.value.set_files({"name": "Offerte [def] #1.pdf", "mimeType": "application/pdf", "buffer": PDF})
        card("Offerte").locator(".file-chip").wait_for()
        assert not page.locator("#editor[open]").count(), "the menu must not open the editor"
        synced()
        text = card("Offerte").locator(".file-chip").inner_text()
        assert text.startswith("Offerte _def_ _1.pdf") and "KiB" in text, text
        assert "Waiting for the invoice." in card("Offerte").inner_text()
        with page.expect_download() as download:
            card("Offerte").locator(".file-chip").click()
        assert Path(download.value.path()).read_bytes() == PDF
        # Same name, other bytes: the next number, like the editor.
        card("Offerte").hover()
        card("Offerte").get_by_role("button", name="More", exact=True).click()
        with page.expect_file_chooser() as chooser:
            page.get_by_role("menuitem", name="Attach file…").click()
        chooser.value.set_files([{"name": "Offerte [def] #1.pdf", "mimeType": "application/pdf", "buffer": PDF + b"v2"}, {"name": "Foto.png", "mimeType": "image/png", "buffer": PNG}])
        page.wait_for_function("() => document.querySelectorAll('.note-card .file-chip').length >= 2")
        synced()
        chips = card("Offerte").locator(".file-chip").all_text_contents()
        assert len(chips) == 2 and any("Offerte _def_ _1 2.pdf" in chip for chip in chips), chips
        assert card("Offerte").locator("img").count() == 1, "a photo shows on the card as a photo"

        # 2. A file dragged over a card shows a dashed edge and words; dropping it attaches the file.
        drag(".note-card:has-text('Boodschappen')", "dragover", "Ontvangstbewijs.pdf", PDF, "application/pdf")
        target = card("Boodschappen")
        assert "is-file-target" in target.get_attribute("class")
        style = target.evaluate("element => [getComputedStyle(element).outlineStyle, getComputedStyle(element, '::after').content]")
        assert style[0] == "dashed" and "Drop to attach" in style[1], style
        shot(page, "attach-drag-over-card")
        drag(".note-card:has-text('Boodschappen')", "drop", "Ontvangstbewijs.pdf", PDF, "application/pdf")
        card("Boodschappen").locator(".file-chip").wait_for()
        assert "is-file-target" not in card("Boodschappen").get_attribute("class")
        assert not page.locator("#editor[open]").count()
        synced()
        # A card that is dragged around in manual order is not mistaken for a file: nothing is attached to Offerte by it.
        assert card("Offerte").locator(".file-chip").count() == 2
        shot(page, "attach-cards")

        # 3. In the editor: a drop and a pasted screenshot go into the note; text that is pasted stays text.
        card("Boodschappen").hover()
        card("Boodschappen").get_by_role("button", name="Open note", exact=True).click()
        page.locator("#editor[open]").wait_for()
        drag("#editor", "dragover", "Bijlage.pdf", PDF, "application/pdf")
        assert "is-file-target" in page.locator("#editor").get_attribute("class")
        drag("#editor", "drop", "Bijlage.pdf", PDF, "application/pdf")
        page.locator("#editor-message").filter(has_text="File kept as encrypted attachments").wait_for()
        assert "![[Bijlage.pdf]]" in page.locator("#note-content").input_value()
        assert "is-file-target" not in page.locator("#editor").get_attribute("class")
        page.locator("#note-content").evaluate(
            """(element, bytes) => {
                const transfer = new DataTransfer();
                transfer.items.add(new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' }));
                element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
            }""",
            list(PNG),
        )
        page.wait_for_function("() => /!\\[\\[Pasted [0-9-]+\\.png\\]\\]/.test(document.querySelector('#note-content').value)")
        before = page.locator("#note-content").input_value()
        page.locator("#note-content").evaluate(
            """element => {
                const transfer = new DataTransfer();
                transfer.setData('text/plain', 'plain words');
                transfer.items.add(new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' }));
                const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
                element.dispatchEvent(event);
                window.__textPasteHandled = event.defaultPrevented;
            }"""
        )
        assert page.evaluate("window.__textPasteHandled") is False
        assert page.locator("#note-content").input_value() == before
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#editor:not([open])").wait_for(state="attached")
        synced()
        assert card("Boodschappen").locator(".file-chip").count() == 2 and card("Boodschappen").locator("img").count() == 1

        # 4. The storage meter: its own line for attachments next to the notes. Only what the cloud holds counts.
        usage = page.locator("#storage-usage").inner_text()
        assert "MiB encrypted storage" in usage, usage
        split = page.locator("#storage-split").inner_text()
        assert split.startswith("Notes ") and "· Attachments " in split, split
        small = float(split.split("Attachments ")[1].split(" ")[0])
        card("Offerte").hover()
        card("Offerte").get_by_role("button", name="More", exact=True).click()
        with page.expect_file_chooser() as chooser:
            page.get_by_role("menuitem", name="Attach file…").click()
        chooser.value.set_files({"name": "Scan.bin", "mimeType": "application/octet-stream", "buffer": os.urandom(3 * MEBI)})
        page.wait_for_function("() => document.querySelectorAll('.note-card .file-chip').length >= 3")
        synced()
        page.wait_for_function("small => parseFloat(document.querySelector('#storage-split').textContent.split('Attachments ')[1]) >= small + 2.5", arg=small)
        split = page.locator("#storage-split").inner_text()
        shot(page, "attach-storage-meter")

        # 5. From 80% a sentence offers Plus, mentioning the files when they are most of the space. The status is faked: 90% full, mostly files. A too-large error would take the place of this sentence, so it comes last.
        files_now = float(split.split("Attachments ")[1].split(" ")[0]) * MEBI

        def full(route):
            response = route.fetch()
            body = response.json()
            body["quotaBytes"] = int(files_now / 0.8)
            body["usedBytes"] = int(body["quotaBytes"] * 0.9)
            body["plan"].update({"checkout": True, "subscribed": False, "trialAvailable": False})
            route.fulfill(response=response, json=body)

        page.route("**/status", full)
        page.locator("#sync").click()
        page.locator("#plus-reason").filter(has_text="90% full").wait_for()
        reason = page.locator("#plus-reason").inner_text()
        assert "mostly with attached files" in reason and reason.endswith("JotDrop Plus has 10 GB and takes files up to 200 MB."), reason
        assert page.locator("#get-plus").is_visible()
        page.locator("#get-plus").click()
        assert page.evaluate("document.activeElement.id") == "buy-month", "the offer leads to the prices"
        shot(page, "attach-plus-nudge")
        # 6. A file over the plan's limit is refused at once with the Plus sentence, and nothing is uploaded.
        card("Offerte").hover()
        card("Offerte").get_by_role("button", name="More", exact=True).click()
        with page.expect_file_chooser() as chooser:
            page.get_by_role("menuitem", name="Attach file…").click()
        chooser.value.set_files({"name": "Huge.bin", "mimeType": "application/octet-stream", "buffer": b"\0" * (26 * MEBI)})
        page.locator("#workspace-message").filter(has_text="Huge.bin").wait_for()
        message = page.locator("#workspace-message").inner_text()
        assert "larger than 25 MB" in message and "has not been uploaded" in message, message
        assert card("Offerte").locator(".file-chip").count() == 3
        assert "JotDrop Plus takes files up to 200 MB." in page.locator("#plus-reason").inner_text()
        page.locator('[data-view="files"]').click()
        assert "Huge.bin" not in " ".join(page.locator(".note-card h3").all_text_contents())
        page.locator('[data-view="notes"]').click()

        assert not errors, errors
        return {"chips": chips, "split": split, "reason": reason}
    finally:
        context.close()


if __name__ == "__main__":
    main(check_attach_everywhere, history_limit=100)

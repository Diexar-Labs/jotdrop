"""Run: python cloud/selection_browser_check.py. Synthetic multi-select checks: color, labels, archive, trash, restore."""
import sys
sys.dont_write_bytecode = True
from browser_check import main


def check_selection(browser, url, token):
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors, prompts, questions = [], [], []
    page.on("pageerror", lambda error: errors.append(str(error)))

    def dialog(d):
        questions.append(d.message)
        if d.type == "prompt":
            d.accept(prompts.pop(0))
        else:
            d.accept()
    page.on("dialog", dialog)

    def synced():
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

    def card(text):
        return page.locator(".note-card").filter(has_text=text)

    def bar(name):
        return page.locator("#selection-bar").get_by_role("button", name=name, exact=True)

    def count():
        return page.locator("#selection-bar .selection-count").inner_text()

    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic selection passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        for name in ["Alpha", "Bravo", "Charlie"]:
            page.locator("#new-note").click()
            page.locator("#note-path").fill(f"notes/{name.lower()}.md")
            page.locator("#note-content").fill(f"# {name}\n\nText.")
            page.locator('#editor-form button[type="submit"]').click()
            synced()

        # The check in the corner starts choosing; then a click on a card chooses it instead of opening it.
        assert page.locator("#selection-bar").is_hidden()
        card("Alpha").hover()
        card("Alpha").get_by_role("button", name="Select note").click()
        assert count() == "1 selected"
        assert card("Alpha").get_by_role("button", name="Select note").get_attribute("aria-pressed") == "true"
        card("Bravo").locator("h3").click()
        assert count() == "2 selected" and not page.locator("#editor").evaluate("dialog => dialog.open")
        assert "is-selected" in card("Bravo").get_attribute("class")

        # Color for both, the choice stays.
        bar("Color").click()
        page.get_by_role("menu").get_by_role("menuitemradio", name="Blue", exact=True).click()
        page.locator('.note-card.note-blue').nth(1).wait_for()
        synced()
        assert count() == "2 selected"
        bar("Color").click()
        assert page.get_by_role("menu").get_by_role("menuitemradio", name="Blue", exact=True).get_attribute("aria-checked") == "true"
        page.keyboard.press("Escape")
        assert count() == "2 selected"

        # Labels: a new label goes on both; unticking one they both have takes it off.
        prompts.append("Batch")
        bar("Labels").click()
        page.get_by_role("menu").get_by_role("menuitem", name="New label…").click()
        card("Alpha").get_by_role("button", name="Batch").wait_for()
        card("Bravo").get_by_role("button", name="Batch").wait_for()
        synced()
        bar("Labels").click()
        page.get_by_role("menu").get_by_role("menuitemcheckbox", name="Batch").click()
        card("Bravo").get_by_role("button", name="Batch").wait_for(state="detached")
        assert card("Alpha").get_by_role("button", name="Batch").count() == 0
        synced()

        # Archive both with one question; the choice ends.
        bar("Archive").click()
        card("Alpha").wait_for(state="detached")
        card("Bravo").wait_for(state="detached")
        assert page.locator("#selection-bar").is_hidden()
        assert page.locator(".note-card").count() == 1
        page.locator('[data-view="archive"]').click()
        card("Alpha").hover()
        card("Alpha").get_by_role("button", name="Select note").click()
        bar("Select all").click()
        assert count() == "2 selected"
        # With everything chosen, the button turns into Deselect all, which ends the choice.
        bar("Deselect all").click()
        assert page.locator("#selection-bar").is_hidden()
        card("Alpha").hover()
        card("Alpha").get_by_role("button", name="Select note").click()
        bar("Select all").click()
        assert count() == "2 selected"
        bar("Unarchive").click()
        page.locator('[data-view="notes"]').click()
        card("Bravo").wait_for()
        synced()
        assert page.locator(".note-card").count() == 3

        # Trash and restore.
        card("Charlie").hover()
        card("Charlie").get_by_role("button", name="Select note").click()
        bar("Move to trash").click()
        card("Charlie").wait_for(state="detached")
        synced()
        page.locator('[data-view="trash"]').click()
        card("Charlie").hover()
        card("Charlie").get_by_role("button", name="Select note").click()
        assert bar("Color").count() == 0
        bar("Restore").click()
        synced()
        page.locator('[data-view="notes"]').click()
        card("Charlie").wait_for()

        # Delete forever: notes moved to the trash, the archived copies the moves above left there, and a note saved
        # straight into notes/Trash/, chosen with Select all.
        for name, path in [("Delta", "notes/delta.md"), ("Echo", "notes/echo.md"), ("Golf", "notes/Trash/golf.md"), ("Hotel", "notes/hotel.md")]:
            page.locator("#new-note").click()
            page.locator("#note-path").fill(path)
            page.locator("#note-content").fill(f"# {name}\n\nText.")
            page.locator('#editor-form button[type="submit"]').click()
            synced()
        for name in ["Delta", "Echo", "Hotel"]:
            card(name).hover()
            card(name).get_by_role("button", name="Select note").click()
        bar("Move to trash").click()
        card("Delta").wait_for(state="detached")
        synced()
        page.locator('[data-view="trash"]').click()
        for name in ["Delta", "Echo", "Golf", "Hotel"]:
            card(name).wait_for()
        assert page.locator(".note-card").count() == 6, page.locator(".note-card h3").all_inner_texts()
        # One card on its own, with its own question.
        card("Hotel").hover()
        card("Hotel").get_by_role("button", name="Delete forever").click()
        card("Hotel").wait_for(state="detached")
        assert questions[-1] == 'Delete "Hotel" forever? It is removed from your cloud and its history. This cannot be undone.', questions[-1]
        card("Delta").hover()
        card("Delta").get_by_role("button", name="Select note").click()
        bar("Select all").click()
        assert count() == "5 selected"
        bar("Delete forever").click()
        for name in ["Alpha", "Bravo", "Delta", "Echo", "Golf"]:
            card(name).wait_for(state="detached")
        assert questions[-1] == "Delete 5 notes forever? They are removed from your cloud and its history. This cannot be undone.", questions[-1]
        synced()
        assert page.locator(".note-card").count() == 0 and page.locator("#selection-bar").is_hidden()
        # Still gone after a reload that reads every note from the cloud again, not from this browser's copy.
        page.evaluate("""() => new Promise((done, fail) => {
            const open = indexedDB.open('jotdrop-cloud-v1');
            open.onsuccess = () => {
                const values = open.result.transaction('values', 'readwrite').objectStore('values'), cursor = values.openCursor();
                cursor.onsuccess = () => { const entry = cursor.result; if (!entry) return done(); if (String(entry.key).startsWith('cache:')) entry.delete(); entry.continue(); };
                cursor.onerror = fail;
            };
            open.onerror = fail;
        })""")
        page.reload()
        synced()
        card("Charlie").wait_for()
        assert page.locator(".note-card").count() == 3
        page.locator('[data-view="trash"]').click()
        page.wait_for_timeout(300)
        assert page.locator(".note-card").count() == 0, page.locator(".note-card").all_inner_texts()
        page.locator('[data-view="notes"]').click()
        card("Charlie").wait_for()

        # Escape ends choosing.
        card("Charlie").hover()
        card("Charlie").get_by_role("button", name="Select note").click()
        page.keyboard.press("Escape")
        assert page.locator("#selection-bar").is_hidden()

        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_function("() => innerWidth === 390")
        card("Charlie").get_by_role("button", name="Select note").click()
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
        assert not errors, errors
        return {"corner_check_and_card_click": True, "bulk_color": True, "bulk_labels_add_remove": True, "bulk_archive_unarchive": True, "select_all": True, "bulk_trash_restore": True, "delete_forever_card_and_bulk": True, "gone_after_cloud_reload": True, "escape_ends": True, "mobile_overflow": False}
    finally:
        if sys.exc_info()[0]:
            print({"sync": page.locator("#sync-status").text_content(), "message": page.locator("#workspace-message").text_content(), "errors": errors})
        context.close()


if __name__ == "__main__":
    main(check_selection, history_limit=100)

"""Run: python cloud/selection_browser_check.py. Synthetic multi-select checks: color, labels, archive, trash, restore."""
import sys
sys.dont_write_bytecode = True
from browser_check import main


def check_selection(browser, url, token):
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors, prompts = [], []
    page.on("pageerror", lambda error: errors.append(str(error)))

    def dialog(d):
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
        return {"corner_check_and_card_click": True, "bulk_color": True, "bulk_labels_add_remove": True, "bulk_archive_unarchive": True, "select_all": True, "bulk_trash_restore": True, "escape_ends": True, "mobile_overflow": False}
    finally:
        if sys.exc_info()[0]:
            print({"sync": page.locator("#sync-status").text_content(), "message": page.locator("#workspace-message").text_content(), "errors": errors})
        context.close()


if __name__ == "__main__":
    main(check_selection, history_limit=100)

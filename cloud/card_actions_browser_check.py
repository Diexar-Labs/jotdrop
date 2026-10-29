"""Run: python cloud/card_actions_browser_check.py. Synthetic card action checks: pin, color, labels, more menu."""
import sys
sys.dont_write_bytecode = True
from browser_check import main


def check_card_actions(browser, url, token):
    context = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
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

    def raw(path):
        target = page.locator(f'.note-card[data-path="{path}"]')
        target.hover()
        target.get_by_role("button", name="Open note", exact=True).click()
        page.locator("#editor[open]").wait_for()
        value = page.locator("#note-content").input_value()
        page.locator("#close-editor").click()
        page.locator("#editor:not([open])").wait_for(state="attached")
        return value

    def action(text, name):
        target = card(text)
        target.hover()
        target.get_by_role("button", name=name, exact=True).click()

    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic card passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        for name, content in [("a", "# Card A\n\nFirst."), ("b", "# Card B\n\nSecond.")]:
            page.locator("#new-note").click()
            page.locator("#note-path").fill(f"notes/{name}.md")
            page.locator("#note-content").fill(content)
            page.locator('#editor-form button[type="submit"]').click()
            synced()

        # Pin from the card, like the plugin and Android.
        action("Card A", "Pin")
        synced()
        assert page.locator("#items > h2").all_text_contents() == ["Pinned", "Others"]
        assert "pinned: true" in raw("notes/a.md")
        card("Card A").hover()
        assert card("Card A").get_by_role("button", name="Unpin", exact=True).get_attribute("aria-pressed") == "true"

        # Color menu: every color has its name and the current one is marked, not only by color.
        action("Card A", "Color")
        menu = page.get_by_role("menu")
        items = menu.get_by_role("menuitemradio")
        assert [text.replace("✓", "").strip() for text in items.all_inner_texts()] == ["Default", "Red", "Orange", "Yellow", "Cream", "Slate blue", "Blue", "Purple", "Pink", "Brown", "Gray"], items.all_inner_texts()
        assert menu.get_by_role("menuitemradio", name="Default", exact=True).get_attribute("aria-checked") == "true"
        menu.get_by_role("menuitemradio", name="Blue", exact=True).click()
        synced()
        assert "note-blue" in card("Card A").get_attribute("class")
        assert 'color: "blue"' in raw("notes/a.md")
        action("Card A", "Color")
        assert page.get_by_role("menu").get_by_role("menuitemradio", name="Blue", exact=True).get_attribute("aria-checked") == "true"
        page.keyboard.press("Escape")
        assert page.get_by_role("menu").count() == 0

        # Labels menu: create, then see it checked, then remove it again.
        prompts.append("Work")
        action("Card A", "Labels")
        page.get_by_role("menu").get_by_role("menuitem", name="New label…").click()
        synced()
        assert card("Card A").get_by_role("button", name="Work", exact=True).count() == 1
        assert "Work" in raw("notes/a.md")
        action("Card B", "Labels")
        work = page.get_by_role("menu").get_by_role("menuitemcheckbox", name="Work", exact=True)
        assert work.get_attribute("aria-checked") == "false"
        work.click()
        synced()
        assert card("Card B").get_by_role("button", name="Work", exact=True).count() == 1
        action("Card B", "Labels")
        page.get_by_role("menu").get_by_role("menuitemcheckbox", name="Work", exact=True).click()
        synced()
        assert card("Card B").get_by_role("button", name="Work", exact=True).count() == 0
        # An outside click closes a menu too.
        action("Card B", "Labels")
        page.mouse.click(5, 300)
        assert page.get_by_role("menu").count() == 0

        # More menu: download, then move to trash.
        action("Card B", "More")
        with page.expect_download() as download:
            page.get_by_role("menu").get_by_role("menuitem", name="Download").click()
        assert open(download.value.path(), encoding="utf-8").read() == "# Card B\n\nSecond."
        action("Card B", "More")
        page.get_by_role("menu").get_by_role("menuitem", name="Move to trash").click()
        synced()
        assert card("Card B").count() == 0
        page.locator('[data-view="trash"]').click()
        assert card("Card B").count() == 1
        page.locator('[data-view="notes"]').click()

        # A menu stays inside a phone screen.
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_function("() => innerWidth === 390")
        action("Card A", "Color")
        box = page.get_by_role("menu").bounding_box()
        assert box["x"] >= 0 and box["x"] + box["width"] <= 390 and box["y"] + box["height"] <= 844, box
        page.keyboard.press("Escape")
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
        assert not errors, errors
        return {"pin_from_card": True, "color_menu_named_and_marked": True, "labels_menu": True, "more_download_trash": True, "menus_close": True, "mobile_menu_fits": True}
    finally:
        if sys.exc_info()[0]:
            print({"sync": page.locator("#sync-status").text_content(), "message": page.locator("#workspace-message").text_content(), "errors": errors})
        context.close()


if __name__ == "__main__":
    main(check_card_actions, history_limit=100)

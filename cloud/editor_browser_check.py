"""Run: python cloud/editor_browser_check.py. Synthetic checks of the plugin-like note editor."""
import re
import sys
sys.dont_write_bytecode = True
from browser_check import main
from playwright.sync_api import expect


def check_editor(browser, url, token):
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    # This check is about the simple title/text editor, the default for new viewers.
    context.add_init_script("try { localStorage.setItem('jotdrop-editor-mode', 'simple'); } catch {}")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("dialog", lambda dialog: dialog.accept())

    def synced():
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

    def raw():
        return page.locator("#note-content").input_value()

    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic editor passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()

        # A first note to link to, written in the simple editor.
        page.locator("#new-note").click()
        assert page.locator("#markdown-editor").is_hidden() and page.locator("#note-title").is_visible()
        assert page.evaluate("document.activeElement.id") == "note-title"
        page.locator("#note-title").fill("Pasta recipe")
        page.locator("#note-body").fill("Boil water.")
        page.locator('#editor-form button[type="submit"]').click()
        synced()
        recipe = page.locator(".note-card").filter(has_text="Pasta recipe")
        assert re.fullmatch(r"notes/\d{4}-\d\d-\d\d \d{6} Pasta recipe\.md", recipe.get_attribute("data-path")), recipe.get_attribute("data-path")

        page.locator("#new-note").click()
        page.locator("#note-title").fill("Groceries")
        page.locator("#note-title").press("Enter")
        assert page.evaluate("document.activeElement.id") == "note-body"
        page.keyboard.type("milk")
        page.locator("#insert-checklist").click()
        assert page.locator("#note-body").input_value() == "- [ ] milk"
        page.locator("#insert-checklist").click()
        assert page.locator("#note-body").input_value() == "- [x] milk"
        page.locator("#note-body").press("End")
        page.keyboard.type("\nsee ")
        page.locator("#insert-link").click()
        page.get_by_role("menu").get_by_role("menuitem", name="Pasta recipe").click()
        assert page.locator("#note-body").input_value().endswith("see [[" + recipe.get_attribute("data-path")[6:-3] + "]]"), page.locator("#note-body").input_value()

        # Color, pin, labels and tags are buttons and chips, not raw YAML.
        colors = page.locator("#note-colors").get_by_role("radio")
        assert colors.count() == 11
        page.locator("#note-colors").get_by_role("radio", name="Pink", exact=True).click()
        assert [colors.nth(i).get_attribute("aria-checked") for i in range(11)].count("true") == 1
        assert page.locator("#note-colors").get_by_role("radio", name="Pink", exact=True).get_attribute("aria-checked") == "true"
        page.locator("#note-pinned").click()
        assert page.locator("#note-pinned").get_attribute("aria-pressed") == "true"
        page.locator("#label-input").fill("Home")
        page.locator("#label-input").press("Enter")
        page.locator("#tag-input").fill("#errands")
        page.locator("#tag-input").press("Enter")
        page.locator("#tag-input").fill("weekly shop")
        page.locator("#tag-input").press("Enter")
        assert page.locator("#tag-chips .chip").all_inner_texts() == ["#errands\n×", "#weekly-shop\n×"], page.locator("#tag-chips .chip").all_inner_texts()
        page.get_by_role("button", name="Remove #weekly-shop").click()
        assert page.locator("#label-chips .chip").count() == 1 and page.locator("#tag-chips .chip").count() == 1

        # The plugin's repeat picker: only with a reminder, then weekdays, ends.
        assert page.locator("#repeat-type").is_disabled()
        page.locator("#note-reminder").fill("2028-10-16T14:30")
        page.locator("#note-reminder").press("Tab")
        page.locator("#repeat-type").select_option("weekly")
        days = page.locator("#repeat-editor .weekday")
        assert days.count() == 7 and days.nth(0).get_attribute("aria-pressed") == "true"
        days.nth(2).click()
        page.locator("#repeat-editor").get_by_label("Ends").select_option("after")
        times = page.locator("#repeat-editor").get_by_label("Number of times")
        times.fill("3")
        times.press("Tab")
        text = raw()
        for expected in ["# Groceries\n\n- [x] milk", 'color: "pink"', "pinned: true", 'jotdrop_labels: ["Home"]', 'tags: ["errands"]', 'reminder: "2028-10-16T14:30"', 'reminder_repeat: "weekly:1,3"', "reminder_limit: 3"]:
            assert expected in text, (expected, text)
        page.locator("#repeat-type").select_option("ordinal")
        page.locator("#repeat-editor").get_by_label("Which week").select_option("5")
        page.locator("#repeat-editor").get_by_label("Weekday").select_option("5")
        assert 'reminder_repeat: "ordinal:5:5"' in raw()
        page.locator("#repeat-type").select_option("every")
        count = page.locator("#repeat-editor").get_by_label("Every how many")
        count.fill("2")
        count.press("Tab")
        page.locator("#repeat-editor").get_by_label("Unit").select_option("weeks")
        assert 'reminder_repeat: "every:2:weeks"' in raw()

        # Markdown help lists the codes people forget.
        help_toggle = page.get_by_role("button", name="Markdown help", exact=True)
        assert page.locator("#markdown-help").is_hidden()
        help_toggle.click()
        assert help_toggle.get_attribute("aria-expanded") == "true"
        help_text = page.locator("#markdown-help").inner_text()
        for code in ["# Heading", "**bold**", "*italic*", "- [ ] task", "[[Note name]]", "#tag"]:
            assert code in help_text, code
        help_toggle.click()
        assert page.locator("#markdown-help").is_hidden()

        # The Markdown view shows the whole file; edits there show up in the simple view.
        page.locator("#markdown-mode").click()
        assert page.locator("#markdown-mode").get_attribute("aria-pressed") == "true" and page.locator("#note-content").is_visible()
        page.locator("#note-content").fill(raw().replace("- [x] milk", "- [x] milk\n- [ ] bread"))
        page.locator("#markdown-mode").click()
        assert page.locator("#note-title").input_value() == "Groceries"
        assert "- [ ] bread" in page.locator("#note-body").input_value()
        page.locator('#editor-form button[type="submit"]').click()
        synced()
        card = page.locator(".note-card").filter(has_text="Groceries")
        assert "note-pink" in card.get_attribute("class")
        assert page.locator("#items > h2").all_text_contents() == ["Pinned", "Others"]

        # Previous/next follow the card order and save edits first.
        card.locator("h3").click()
        assert page.locator("#note-prev").is_disabled() and not page.locator("#note-next").is_disabled()
        page.locator("#note-body").fill(page.locator("#note-body").input_value() + "\n- [ ] eggs")
        page.locator("#note-next").click()
        expect(page.locator("#note-title")).to_have_value("Pasta recipe")
        page.keyboard.press("Alt+ArrowLeft")
        expect(page.locator("#note-title")).to_have_value("Groceries")
        assert "- [ ] eggs" in page.locator("#note-body").input_value()
        page.locator("#close-editor").click()
        synced()

        # A note without a heading shows its text on the card, not its filename.
        page.locator("#new-note").click()
        page.locator("#note-body").fill("Just a quick thought")
        page.locator('#editor-form button[type="submit"]').click()
        synced()
        thought = page.locator(".note-card").filter(has_text="Just a quick thought")
        assert thought.locator("h3").count() == 0
        assert thought.get_attribute("data-path").endswith(" Just a quick thought.md")

        page.set_viewport_size({"width": 390, "height": 844})
        thought.locator(".note-preview").click()
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
        assert page.evaluate("(() => { const d = document.getElementById('editor'); return d.scrollWidth <= d.clientWidth; })()")
        page.locator("#close-editor").click()
        assert not errors, errors
        return {"title_and_text": True, "plugin_filenames": True, "checklist_button": True, "insert_link": True, "color_pin_labels_tags": True, "repeat_picker": True, "markdown_view": True, "previous_next_saves": True, "untitled_card_shows_text": True, "mobile_editor_fits": True}
    finally:
        if sys.exc_info()[0]:
            print({"sync": page.locator("#sync-status").text_content(), "message": page.locator("#editor-message").text_content(), "errors": errors})
        context.close()


if __name__ == "__main__":
    main(check_editor, history_limit=100)

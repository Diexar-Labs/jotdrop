"""Run: python cloud/tags_browser_check.py. Synthetic #tag checks: chips on cards, filter bar, overflow menu."""
import sys
sys.dont_write_bytecode = True
from browser_check import main


def check_tags(browser, url, token):
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))

    def synced():
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

    def card(text):
        return page.locator(".note-card").filter(has_text=text)

    def bar_chips():
        return [text.replace("✓", "").strip() for text in page.locator("#tag-filter button[aria-pressed]").all_inner_texts()]

    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic tags passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        for name, content in [
            ("shop", "# Shop\n\nBuy milk #errands #home"),
            ("renovate", "---\ntags: [Home]\n---\n# Renovate\n\nPaint `#notatag` \\#shared"),
            ("plain", "# Plain\n\nNo tags here."),
            ("many", "# Many\n\n#alpha #bravo #charlie #delta #echo #foxtrot #golf"),
        ]:
            page.locator("#new-note").click()
            page.locator("#note-path").fill(f"notes/{name}.md")
            page.locator("#note-content").fill(content)
            page.locator('#editor-form button[type="submit"]').click()
            synced()

        # Chips on the card: frontmatter and typed #tags, never code or escaped shared text.
        assert card("Shop").locator("button.label-chip").all_inner_texts() == ["#errands", "#home"]
        assert card("Renovate").locator("button.label-chip").all_inner_texts() == ["#Home"]
        assert card("Plain").locator("button.label-chip").count() == 0

        # Filter bar: the 8 most used tags, the rest under "+1 more", like the plugin and Android.
        assert page.locator("#tag-filter").is_visible()
        chips = bar_chips()
        assert len(chips) == 8 and chips[0].lower() == "#home" and "#golf" not in chips, chips
        assert page.locator("#tag-filter").get_by_role("button", name="+1 more", exact=True).is_visible()
        assert page.locator("#tag-filter .filter-clear").count() == 0

        # Choosing a tag: a ✓ and aria-pressed, not only a colour; Home matches both spellings.
        home = page.locator("#tag-filter button[aria-pressed]").first
        home.click()
        home = page.locator("#tag-filter button[aria-pressed]").first
        assert home.get_attribute("aria-pressed") == "true" and home.inner_text().startswith("✓"), home.inner_text()
        assert page.locator(".note-card").count() == 2
        assert card("Shop").count() == 1 and card("Renovate").count() == 1

        # The overflow menu adds a tag; any chosen tag matches.
        page.locator("#tag-filter").get_by_role("button", name="+1 more", exact=True).click()
        menu = page.get_by_role("menu")
        assert menu.get_by_role("menuitemcheckbox").count() == 9
        assert menu.get_by_role("menuitemcheckbox", name="#home (2)").get_attribute("aria-checked") == "true"
        menu.get_by_role("menuitemcheckbox", name="#golf (1)").click()
        assert page.locator(".note-card").count() == 3
        assert "#golf" in bar_chips() and page.locator("#tag-filter").get_by_role("button", name="+1 more").count() == 0

        page.locator("#tag-filter .filter-clear").click()
        assert page.locator(".note-card").count() == 4
        assert page.locator('#tag-filter button[aria-pressed="true"]').count() == 0

        # A tag chip on a card filters on that tag, like the label chips.
        card("Shop").get_by_role("button", name="#errands", exact=True).click()
        assert page.locator(".note-card").count() == 1
        assert page.locator('#tag-filter button[aria-pressed="true"]').inner_text().replace("✓", "").strip() == "#errands"

        # A view without those tags hides the bar and drops the choice, so nothing filters unseen.
        page.locator('[data-view="archive"]').click()
        assert page.locator("#tag-filter").is_hidden()
        page.locator('[data-view="notes"]').click()
        assert page.locator(".note-card").count() == 4

        # The editor still shows only frontmatter tags; saving does not move typed #tags into it.
        card("Shop").hover()
        card("Shop").get_by_role("button", name="Open note", exact=True).click()
        page.locator("#editor[open]").wait_for()
        assert page.locator("#tag-chips > *").count() == 0
        assert "tags:" not in page.locator("#note-content").input_value()
        page.locator("#close-editor").click()

        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_function("() => innerWidth === 390")
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
        assert not errors, errors
        return {"tag_chips_on_cards": True, "code_and_escaped_ignored": True, "top_8_and_overflow": True, "selected_marked_not_only_colour": True, "any_tag_matches": True, "card_chip_filters": True, "hidden_choice_dropped": True, "editor_unchanged": True, "mobile_overflow": False}
    finally:
        if sys.exc_info()[0]:
            print({"sync": page.locator("#sync-status").text_content(), "message": page.locator("#workspace-message").text_content(), "errors": errors})
        context.close()


if __name__ == "__main__":
    main(check_tags, history_limit=100)

"""Run: python cloud/link_chips_browser_check.py. Synthetic link chip checks only."""
import os
import sys
sys.dont_write_bytecode = True
from browser_check import main


def check_link_chips(browser, url, token):
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic link chip passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        notes = [
            ("many", "# Reading list\n\nStart with https://www.example.com/a and [the docs](https://docs.example.org/guide).\n"
                     "Then https://github.com/Diexar-Labs/jotdrop, https://news.example.net/x and https://www.example.com/a/ again."),
            ("plain", "# Plain\n\nNo links in this one."),
        ]
        for name, content in notes:
            page.locator("#new-note").click()
            page.locator("#note-path").fill(f"notes/{name}.md")
            page.locator("#note-content").fill(content)
            page.locator('#editor-form button[type="submit"]').click()
            page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        card = page.locator(".note-card").filter(has_text="Reading list")
        chips = card.locator(".link-chip")
        # Like the plugin and Android: links with a label first, three chips with the site's name, the rest as "+N", each link once.
        assert chips.all_text_contents() == ["docs.example.org", "example.com", "github.com"], chips.all_text_contents()
        assert [chips.nth(index).get_attribute("href") for index in range(3)] == ["https://docs.example.org/guide", "https://www.example.com/a", "https://github.com/Diexar-Labs/jotdrop"]
        assert card.locator(".link-more").inner_text() == "+1"
        # The addresses leave the card text; a link's label stays.
        preview = card.locator(".note-preview").inner_text()
        assert "https://" not in preview and "the docs" in preview, preview
        assert page.locator(".note-card").filter(has_text="Plain").locator(".link-chips").count() == 0
        # A chip opens its link in a new tab, not the note.
        with context.expect_page() as popup:
            chips.nth(2).click()
        popup.value.close()
        assert page.locator("#editor").is_hidden()
        # Anywhere else on the card still opens the note.
        card.locator(".note-preview").click()
        page.locator("#editor").wait_for()
        if os.environ.get("JOTDROP_SHOT"):
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            card.screenshot(path=os.environ["JOTDROP_SHOT"])
        assert not errors, errors
        return {"link_chips": True, "urls_out_of_text": True, "chip_opens_link": True, "card_opens_note": True}
    finally:
        if sys.exc_info()[0]:
            print({"sync": page.locator("#sync-status").text_content(), "message": page.locator("#workspace-message").text_content(), "errors": errors})
        context.close()


if __name__ == "__main__":
    main(check_link_chips, history_limit=100)

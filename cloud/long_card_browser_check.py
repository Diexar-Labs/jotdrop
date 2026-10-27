"""Run: python cloud/long_card_browser_check.py. Synthetic check: a note with a lot of text, such as a clipped post
whose whole caption became its heading, makes a card of limited height (Eric, 27 Oct: some cards became gigantically long)."""
import sys
sys.dont_write_bytecode = True
from browser_check import main

POST = " ".join(["Comment EDIT and I'll send you the free setup I use to make videos with Claude Code."] * 18)


def check_long_card(browser, url, token):
    context = browser.new_context(viewport={"width": 1200, "height": 900})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic long passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        page.locator("#new-note").click()
        page.locator("#note-path").fill("notes/2026-10-27 143000 Post.md")
        # The clipper saves a page title as the heading; on Instagram that is the whole post.
        page.locator("#note-content").fill(f"# {POST}\n\n{POST}")
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        card = page.locator(".note-card").filter(has_text="Comment EDIT").first
        title = card.locator("h3")
        sizes = title.evaluate("(element) => ({ height: element.getBoundingClientRect().height, line: parseFloat(getComputedStyle(element).lineHeight), card: element.closest('.note-card').offsetHeight })")
        # Three lines of title at most, and the whole card stays within a screen.
        assert sizes["height"] <= sizes["line"] * 3 + 2, sizes
        assert sizes["card"] < 520, sizes
        # The note itself keeps the whole text.
        card.click()
        assert page.locator("#editor").is_visible()
        assert not errors, errors
        return {"title_lines_max_3": True, "card_height": round(sizes["card"])}
    finally:
        context.close()


if __name__ == "__main__":
    main(check_long_card)

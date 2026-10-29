"""Run: python cloud/open_card_scroll_browser_check.py. Synthetic check: while a card is open, scrolling in it
or on the dimmed page around it never scrolls the cards behind it (Eric, 27 Oct), and nothing shifts sideways."""
import sys
sys.dont_write_bytecode = True
from browser_check import main


def check_open_card_scroll(browser, url, token):
    context = browser.new_context(viewport={"width": 1100, "height": 700})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))

    def synced():
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic scroll passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        synced()

        long_text = "\n".join(f"Line {n} of a long note." for n in range(120))
        for n in range(14):
            page.locator("#new-note").click()
            page.locator("#note-path").fill(f"notes/Card {n:02}.md")
            page.locator("#note-content").fill(f"# Card {n:02}\n\n{long_text if n == 0 else 'Short.'}")
            page.locator('#editor-form button[type="submit"]').click()
            synced()

        page.mouse.wheel(0, 400)
        page.wait_for_timeout(300)
        before = page.evaluate("window.scrollY")
        assert before > 0, "the page should scroll for this check"
        left = page.locator(".note-card").first.bounding_box()["x"]

        page.locator(".note-card").filter(has_text="Card 00").locator("h3").click()
        page.locator("#editor[open]").wait_for()
        # Nothing behind the open card moves sideways when the page's scrollbar is held still.
        assert page.locator(".note-card").first.bounding_box()["x"] == left

        # Scroll through the open card, well past its end, then on the dimmed page around it.
        box = page.locator("#editor").bounding_box()
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + 40)
        for _ in range(12):
            page.mouse.wheel(0, 600)
            page.wait_for_timeout(40)
        page.mouse.move(10, 350)
        for _ in range(6):
            page.mouse.wheel(0, 600)
            page.wait_for_timeout(40)
        page.wait_for_timeout(300)
        after = page.evaluate("window.scrollY")
        assert after == before, (before, after)

        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        # Closed again, the page scrolls as before.
        page.mouse.wheel(0, 300)
        page.wait_for_timeout(300)
        assert page.evaluate("window.scrollY") > before
        assert not errors, errors
        return {"open_card_holds_page": True, "no_sideways_shift": True, "scrolls_after_close": True}
    finally:
        context.close()


if __name__ == "__main__":
    main(check_open_card_scroll, history_limit=200)

"""Run: python cloud/paper_browser_check.py [browser-channel]. Paper drawer in the web app: an expiry date with a warning
writes `expires`, the warning reminder and the Paper drawer label; the card says "Expires ..." in words; the sidebar shows
the label with its drawer icon; clearing the date removes only `expires`. Synthetic notes only."""
import os
import sys
from pathlib import Path
sys.dont_write_bytecode = True
from browser_check import main

SHOT = os.environ.get("JOTDROP_PAPER_SHOT")


def check_paper(browser, url, token):
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

    def save():
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#editor:not([open])").wait_for(state="attached")
        synced()

    def open_note(text):
        card(text).get_by_role("button", name="Open note", exact=True).click()
        page.locator("#editor[open]").wait_for()

    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic paper passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()

        # A note with a label and an old repeating reminder: the warning replaces the reminder, the label stays.
        page.locator("#new-note").click()
        page.locator("#editor[open]").wait_for()
        page.locator("#note-path").fill("notes/Passport.md")
        page.locator("#note-content").fill('---\njotdrop_labels: ["Home"]\nreminder: "2026-12-01T08:00"\nreminder_repeat: "monthly"\n---\n# Passport\n\nNumber on page 2.\n')
        save()

        open_note("Passport")
        assert page.locator("#note-warn option").all_text_contents() == ["No warning", "1 week before", "1 month before", "2 months before", "3 months before"]
        page.locator("#note-warn").select_option("1m")
        page.locator("#note-expires").fill("2030-03-31")
        page.locator("#note-expires").dispatch_event("change")
        content = page.locator("#note-content").input_value()
        assert 'expires: "2030-03-31"' in content, content
        assert 'jotdrop_labels: ["Home","Paper drawer"]' in content, content
        assert 'reminder: "2030-02-28T09:00"' in content, content
        assert "reminder_repeat" not in content, content
        save()

        badge = card("Passport").locator(".card-expires")
        assert badge.inner_text() == "📄 Expires 31 Mar 2030", badge.inner_text()
        assert "is-expired" not in (badge.get_attribute("class") or "")
        drawer = page.locator(".label-nav").filter(has_text="Paper drawer")
        assert drawer.count() == 1
        assert 'd="M3 12h18"' in drawer.inner_html(), drawer.inner_html()
        assert 'd="M3 12h18"' not in page.locator(".label-nav").filter(has_text="Home").inner_html()
        drawer.click()
        assert [title for title in page.locator(".note-card h3").all_text_contents()] == ["Passport"]
        if SHOT:
            page.screenshot(path=SHOT, full_page=False)
        page.locator('[data-view="notes"]').click()

        # An old date reads "Expired" in words; with no warning chosen the reminder is left alone.
        page.locator("#new-note").click()
        page.locator("#editor[open]").wait_for()
        page.locator("#note-path").fill("notes/Old card.md")
        page.locator("#note-content").fill("# Old card\n")
        page.locator("#note-expires").fill("2020-01-05")
        page.locator("#note-expires").dispatch_event("change")
        content = page.locator("#note-content").input_value()
        assert 'expires: "2020-01-05"' in content and "reminder" not in content, content
        save()
        expired = card("Old card").locator(".card-expires")
        assert expired.inner_text() == "⚠ Expired 5 Jan 2020", expired.inner_text()
        assert "is-expired" in expired.get_attribute("class")

        # Clearing the date removes only `expires`: the label and the reminder stay.
        open_note("Passport")
        assert page.locator("#note-expires").input_value() == "2030-03-31"
        assert page.locator("#note-warn").input_value() == ""
        page.locator("#clear-expires").click()
        content = page.locator("#note-content").input_value()
        assert "expires" not in content and "Paper drawer" in content and 'reminder: "2030-02-28T09:00"' in content, content
        save()
        assert card("Passport").locator(".card-expires").count() == 0
        assert not errors, errors
        return {"badges": ["Expires 31 Mar 2030", "Expired 5 Jan 2020"], "drawer": True}
    finally:
        context.close()


if __name__ == "__main__":
    main(check_paper)

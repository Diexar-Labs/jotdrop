"""Run: python cloud/paper_browser_check.py [browser-channel]. Paper drawer in the web app: the drawer always has its place
in the sidebar and an empty drawer explains itself; a small drawer made with "+ New drawer" sits below it; a note with
"Paper drawer/Work" shows in the drawer and in Work, not among the ordinary labels; the tip above the papers stays closed
after a reload; an expiry date warns a week before by default, writes `expires`, the warning reminder and the Paper
drawer label; the card says "Expires ..." in words; clearing the date removes only `expires`. Synthetic notes only."""
import os
import sys
from pathlib import Path
sys.dont_write_bytecode = True
from browser_check import main

SHOT = os.environ.get("JOTDROP_PAPER_SHOT")
SHOTS = Path(os.environ["JOTDROP_PAPER_SHOTS"]) if os.environ.get("JOTDROP_PAPER_SHOTS") else None
DRAWER_ICON = 'd="M3 12h18"'


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

    def titles():
        return page.locator(".note-card h3").all_text_contents()

    def save():
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#editor:not([open])").wait_for(state="attached")
        synced()

    def open_note(text):
        card(text).get_by_role("button", name="Open note", exact=True).click()
        page.locator("#editor[open]").wait_for()

    def new_note(path, content):
        page.locator('[data-view="notes"]').click()
        page.locator("#new-note").click()
        page.locator("#editor[open]").wait_for()
        page.locator("#note-path").fill(path)
        page.locator("#note-content").fill(content)

    paper = page.locator("#drawer-list .paper-nav")

    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic paper passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        synced()

        # Before the first paper the drawer is already there, under Notes, and opening it explains what it does.
        assert paper.count() == 1 and paper.is_visible()
        assert paper.inner_text().split("\n") == ["Paper drawer", "0"], paper.inner_text()
        assert DRAWER_ICON in paper.inner_html()
        assert page.locator("#label-list .label-nav").count() == 0
        paper.click()
        assert page.locator("#view-title").inner_text() == "Paper drawer"
        intro = page.locator("#items .paper-intro")
        assert intro.locator("h2").inner_text() == "Your paper drawer"
        points = intro.locator(".paper-points li")
        assert points.count() == 3 and points.locator("svg").count() == 3
        assert "finds the edges" in points.nth(0).inner_text() and "a week before" in points.nth(2).inner_text()
        assert "app on your phone" in intro.inner_text()
        assert "🔍" not in intro.inner_text() and "📄" not in intro.inner_text()
        assert page.locator("#paper-tip").is_hidden()
        if SHOTS:
            page.screenshot(path=str(SHOTS / "paper2-web-empty.png"), full_page=False)

        # "+ New drawer" opens an inline field (no browser prompt) and makes the small drawer right away.
        page.locator("#add-drawer").click()
        assert page.locator("#new-drawer").is_visible() and page.locator("#add-drawer").is_hidden()
        assert page.locator("#drawer-suggestions option").evaluate_all("o => o.map(x => x.value)") == ["Personal", "Work", "Home"]
        page.locator("#new-drawer").fill("Work")
        page.locator("#new-drawer").press("Enter")
        work = page.locator("#drawer-list .drawer-sub").filter(has_text="Work")
        work.wait_for()
        assert work.get_attribute("aria-current") == "page"
        assert page.locator("#view-title").inner_text() == "Work"
        assert page.locator("#items .paper-intro").count() == 1
        assert page.locator("#new-drawer-form").is_hidden()
        # A slash would make a drawer inside a drawer: refused in words.
        page.locator("#add-drawer").click()
        page.locator("#new-drawer").fill("A/B")
        page.locator("#new-drawer").press("Enter")
        page.get_by_text("Type a drawer name, without a slash.").wait_for()
        page.locator("#cancel-drawer").click()

        # A note in the small drawer: in Paper drawer and in Work, never among the ordinary labels.
        new_note("notes/Contract.md", '---\njotdrop_labels: ["Paper drawer/Work","Home"]\n---\n# Contract\n\nSigned copy.\n')
        save()
        new_note("notes/Groceries.md", '---\njotdrop_labels: ["Home"]\n---\n# Groceries\n')
        save()
        assert [item.split("\n")[0] for item in page.locator("#label-list .label-nav").all_inner_texts()] == ["Home"]
        assert paper.inner_text().split("\n") == ["Paper drawer", "1"], paper.inner_text()
        assert work.inner_text().split("\n") == ["Work", "1"], work.inner_text()
        paper.click()
        assert titles() == ["Contract"], titles()
        work.click()
        assert titles() == ["Contract"], titles()
        assert page.locator("#view-title").inner_text() == "Work"

        # With papers in it, the drawer shows the same points as a short tip; closed stays closed after a reload.
        paper.click()
        tip = page.locator("#paper-tip")
        assert tip.is_visible() and tip.locator(".paper-points li svg").count() == 3
        if SHOTS:
            page.screenshot(path=str(SHOTS / "paper2-web-tip.png"), full_page=False)
        tip.get_by_role("button", name="Close tip").click()
        assert tip.is_hidden()
        page.reload()
        page.locator("#workspace").wait_for()
        synced()
        paper.click()
        assert titles() == ["Contract"] and tip.is_hidden()

        # A note with a label and an old repeating reminder: the warning replaces the reminder, the label stays.
        new_note("notes/Passport.md", '---\njotdrop_labels: ["Home"]\nreminder: "2026-12-01T08:00"\nreminder_repeat: "monthly"\n---\n# Passport\n\nNumber on page 2.\n')
        save()

        open_note("Passport")
        assert page.locator("#note-warn option").all_text_contents() == ["No warning", "1 week before", "1 month before", "2 months before", "3 months before"]
        # Without an expiry date yet, the warning is a week before.
        assert page.locator("#note-warn").input_value() == "1w"
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
        paper.click()
        assert sorted(titles()) == ["Contract", "Passport"], titles()
        if SHOT:
            page.screenshot(path=SHOT, full_page=False)

        # The default: a new note with a date warns a week before.
        new_note("notes/Lease.md", "# Lease\n")
        assert page.locator("#note-warn").input_value() == "1w"
        page.locator("#note-expires").fill("2031-03-12")
        page.locator("#note-expires").dispatch_event("change")
        content = page.locator("#note-content").input_value()
        assert 'expires: "2031-03-12"' in content and 'reminder: "2031-03-05T09:00"' in content and '"Paper drawer"' in content, content
        save()

        # An old date reads "Expired" in words; with "No warning" chosen the reminder is left alone.
        new_note("notes/Old card.md", "# Old card\n")
        page.locator("#note-warn").select_option("")
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
        assert page.locator("#note-warn").input_value() == "1w"
        save()
        assert card("Passport").locator(".card-expires").count() == 0
        assert not errors, errors
        return {"badges": ["Expires 31 Mar 2030", "Expired 5 Jan 2020"], "drawer_always_there": True, "small_drawers": ["Work"], "tip_stays_closed": True, "default_warning": "1w"}
    finally:
        context.close()


if __name__ == "__main__":
    # Six notes and their edits: more history than the default test limit of 5 entries.
    main(check_paper, history_limit=40)

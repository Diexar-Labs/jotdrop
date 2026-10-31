"""Run: python cloud/space_browser_check.py. A shared space's folder in the vault shows no card; an ordinary folder called Shared does."""
import sys
sys.dont_write_bytecode = True
from browser_check import main


def check_spaces(browser, url, token):
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic spaces passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        for path, content in [
            ("notes/Shared/3f2a1c9e-8b7d-4e6f-a5c4-1d2e3f4a5b6c/List.md", "# From a space"),
            ("notes/Shared/Holiday.md", "# My own note"),
        ]:
            page.locator("#new-note").click()
            page.locator("#note-path").fill(path)
            page.locator("#note-content").fill(content)
            page.locator('#editor-form button[type="submit"]').click()
            page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        assert page.locator(".note-card").filter(has_text="My own note").count() == 1
        assert page.locator(".note-card").filter(has_text="From a space").count() == 0
        assert page.locator("#note-count").inner_text() == "1", page.locator("#note-count").inner_text()
        assert not errors, errors
    finally:
        context.close()
    return {"space_hidden": True, "ordinary_shared_folder_shown": True}


if __name__ == "__main__":
    main(check_spaces)

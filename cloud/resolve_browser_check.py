"""Run: python cloud/resolve_browser_check.py. Local synthetic check: a note changed in two browsers shows "Resolve now", which settles it."""
import sys
sys.dont_write_bytecode = True
from browser_check import main


def check_resolve(browser, url, token):
    first_context, second_context = browser.new_context(), browser.new_context()
    first, second = first_context.new_page(), second_context.new_page()
    errors = []
    for page in [first, second]:
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("dialog", lambda dialog: dialog.accept())
    password = "synthetic resolve passphrase"
    try:
        first.goto(url, wait_until="networkidle")
        first.locator("#show-connect").click()
        first.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            first.locator(field).fill(password)
        first.locator('#connect-form button[type="submit"]').click()
        first.locator("#recovery-saved").check()
        first.locator("#finish-recovery").click()
        first.locator("#new-note").click()
        first.locator("#note-path").fill("notes/list.md")
        first.locator("#note-content").fill("# List\n\nVersion one.")
        first.locator('#editor-form button[type="submit"]').click()
        first.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        assert first.locator("#resolve-now").is_hidden()
        first.locator('[data-view="devices"]').click()
        first.locator("#pair-name").fill("Second test browser")
        first.locator("#pair-form button").click()
        first.wait_for_function("() => document.getElementById('pair-code').value.length > 20")
        code = first.locator("#pair-code").input_value()
        second.goto(url, wait_until="networkidle")
        second.locator("#show-connect").click()
        second.locator("#connect-method").select_option("pair")
        second.locator("#access-code").fill(code)
        for field in ["#new-password", "#confirm-password"]:
            second.locator(field).fill(password)
        second.locator('#connect-form button[type="submit"]').click()
        second.locator(".note-card").filter(has_text="Version one.").wait_for()

        # The first browser saves offline; the second saves the same note to the cloud.
        offline = lambda route: route.abort("failed") if route.request.method != "GET" else route.continue_()
        first_context.route("**/api/v1/objects/**", offline)
        first.locator('[data-view="notes"]').click()
        first.locator(".note-card").get_by_role("button", name="Open note", exact=True).click()
        first.locator("#note-content").fill("# List\n\nEdited in the first browser.")
        first.locator('#editor-form button[type="submit"]').click()
        first.locator("#sync-status").filter(has_text="Cloud unavailable").wait_for()
        second.locator(".note-card").get_by_role("button", name="Open note", exact=True).click()
        second.locator("#note-content").fill("# List\n\nEdited in the second browser.")
        second.locator('#editor-form button[type="submit"]').click()
        second.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

        first_context.unroute("**/api/v1/objects/**", offline)
        first.locator("#sync").click()
        first.locator("#sync-status").filter(has_text="1 note was changed in two places").wait_for()
        first.locator("#resolve-now").wait_for()
        assert first.locator(".note-card").get_by_role("button", name="Resolve now").count() == 1
        with first.expect_download() as download:
            first.locator("#resolve-now").click()
        assert download.value.suggested_filename == "local-draft-list.md"
        first.locator(".note-card").filter(has_text="Edited in the second browser.").wait_for()
        first.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        assert first.locator("#resolve-now").is_hidden()
        assert not errors, errors
        return {"resolve_now_shown": True, "resolved_to_cloud_version": True, "hidden_after": True}
    finally:
        first_context.close()
        second_context.close()


if __name__ == "__main__":
    main(check_resolve, history_limit=100)

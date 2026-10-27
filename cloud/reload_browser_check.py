"""Run: python cloud/reload_browser_check.py. Synthetic check: F5 on a browser that stays signed in goes straight
to the notes and never shows the login form first (Eric, 27 Oct), also when the scripts load slowly."""
import sys
import time
sys.dont_write_bytecode = True
from browser_check import main

# From the first frame of every page: is the login screen or the opening line on screen?
WATCH = """() => {
  window.seen = [];
  const loop = () => {
    const shown = (id) => { const element = document.getElementById(id); return Boolean(element && element.offsetParent); };
    window.seen.push([shown('access'), shown('opening'), shown('workspace')]);
    if (!shown('workspace') || window.seen.length < 5) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}"""


def check_reload(browser, url, token):
    context = browser.new_context(viewport={"width": 1100, "height": 900})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic reload passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

        # A slow connection: the app's script takes a while to arrive after F5.
        page.add_init_script(f"({WATCH})()")
        page.route("**/app.js", lambda route: (time.sleep(0.8), route.continue_()))
        page.reload()
        page.locator("#workspace").wait_for()
        page.wait_for_timeout(300)
        seen = page.evaluate("window.seen")
        assert not any(access for access, _, _ in seen), f"login screen shown before the notes in {sum(a for a, _, _ in seen)} of {len(seen)} frames"
        assert any(opening for _, opening, _ in seen), "nothing said the notes are opening"
        assert page.locator("#opening").is_hidden()

        # Logged out, F5 shows the login form, without the opening line.
        page.once("dialog", lambda dialog: dialog.accept())
        page.get_by_role("button", name="Log out", exact=True).click()
        page.locator("#login-form").wait_for()
        page.reload()
        page.locator("#login-form").wait_for()
        assert page.locator("#opening").is_hidden() and page.locator("#workspace").is_hidden()
        assert not errors, errors
        return {"frames_checked": len(seen), "no_login_flash_after_reload": True, "logged_out_shows_login": True}
    finally:
        context.close()


if __name__ == "__main__":
    main(check_reload)

"""Run: python cloud/human_browser_check.py. With Turnstile on (Cloudflare's test keys, so it needs the internet): the person check
shows only on the form for a new account, an email account is made after it, and a throwaway address is refused (Eric, 27 Oct)."""
import os
import queue
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

PASSWORD = "synthetic person check passphrase"


def check_human(browser, url, codes):
    errors, outside = [], []
    page = browser.new_context(viewport={"width": 1280, "height": 900}).new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("request", lambda request: outside.append(request.url) if "challenges.cloudflare.com" in request.url else None)
    page.goto(url, wait_until="networkidle")
    # Nothing comes from Cloudflare until someone opens the form for a new account.
    assert not outside, outside
    page.get_by_role("button", name="Create an account").click()
    # Turnstile draws its frame in a closed shadow root; its token lands in this hidden field.
    page.locator('#signup-human [name="cf-turnstile-response"]').wait_for(state="attached")
    assert outside

    def sign_up(email):
        page.locator("#signup-email").fill(email)
        page.locator("#signup-password").fill(PASSWORD)
        page.locator("#signup-confirm").fill(PASSWORD)
        page.wait_for_function("() => window.turnstile && document.querySelector('#signup-human [name=\"cf-turnstile-response\"]')?.value")
        page.locator('#signup-form button[type="submit"]').click()

    sign_up("someone@mailinator.com")
    page.locator("#access-message").filter(has_text="throwaway addresses are not accepted").wait_for()
    sign_up("person@example.com")
    page.locator("#code-input").fill(next(code for kind, code in iter(lambda: codes.get(timeout=30), None) if kind == "verify"))
    page.locator('#code-form button[type="submit"]').click()
    page.locator("#recovery-saved").check()
    page.locator("#finish-recovery").click()
    page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
    # Obsidian and the Android app do the check on this page; the token goes back to the app that asked.
    app_page = browser.new_context().new_page()
    app_page.on("pageerror", lambda error: errors.append(str(error)))
    app_page.goto(url + "/human")
    app_page.locator("#human-message").filter(has_text="Open this page from JotDrop").wait_for()
    app_page.goto(url + "/human?client=obsidian")
    app_page.locator("#human-message").filter(has_text="Back to JotDrop").wait_for()
    assert not errors, errors
    return {"only_on_signup_form": True, "throwaway_refused": True, "account_after_check": True, "app_page_hands_back": True}


def main():
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="jotdrop-human-test-") as directory:
        with socket.socket() as candidate:
            candidate.bind(("127.0.0.1", 0))
            port = candidate.getsockname()[1]
        environment = dict(os.environ, JOTDROP_CLOUD_DATA_DIR=directory, JOTDROP_CLOUD_PORT=str(port), JOTDROP_CLOUD_SERVER_KEY=secrets.token_urlsafe(32),
                           # Cloudflare's published test keys: the widget always passes and siteverify always says yes.
                           JOTDROP_CLOUD_TURNSTILE_SITE_KEY="1x00000000000000000000AA", JOTDROP_CLOUD_TURNSTILE_SECRET="1x0000000000000000000000000000000AA")
        process = subprocess.Popen(["node", "cloud/server.mjs"], cwd=root, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        codes = queue.Queue()

        def read_mail():
            # The development mailer prints "[mail] <kind> to <address>: <code>".
            for line in process.stdout:
                match = re.match(r"\[mail\] (\w+) to \S+: (\d{6})", line)
                if match:
                    codes.put((match.group(1), match.group(2)))

        try:
            assert "JotDrop Cloud listening" in process.stdout.readline(), "Local test server did not start."
            threading.Thread(target=read_mail, daemon=True).start()
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True, channel=sys.argv[1] if len(sys.argv) > 1 else "msedge")
                try:
                    print(check_human(browser, f"http://127.0.0.1:{port}", codes))
                finally:
                    browser.close()
        finally:
            process.terminate()
            process.wait(timeout=10)
            process.stdout.close()


if __name__ == "__main__":
    main()

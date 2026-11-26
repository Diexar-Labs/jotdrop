"""Run: python cloud/login_error_browser_check.py. A wrong password or unlock passphrase says so where the person looks:
the message is in view without scrolling, on a laptop-sized window and on a phone (#110)."""
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

PASSWORD = "synthetic login error passphrase"
LAPTOP = {"width": 1366, "height": 650}
# A phone with the keyboard still open after pressing Go: little of the page shows.
PHONE = {"width": 390, "height": 360}


def check_login_error(browser, url, codes):
    errors = []

    def open_page(viewport):
        page = browser.new_context(viewport=viewport).new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(url, wait_until="networkidle")
        return page

    def message_in_view(page, text):
        message = page.locator("#access-message").filter(has_text=text)
        message.wait_for()
        box = message.bounding_box()
        height = page.viewport_size["height"]
        # One pixel of slack: scrolling into view can leave a fraction of a pixel above the edge.
        assert box and box["y"] >= -1 and box["y"] + box["height"] <= height + 1, (text, box, height)

    def log_in(page, email):
        page.locator("#login-email").fill(email)
        page.locator("#login-password").fill(PASSWORD + " but wrong")
        page.locator("#login-forget").check()
        page.locator('#login-form button[type="submit"]').click()

    laptop = open_page(LAPTOP)
    laptop.get_by_role("button", name="Create an account").click()
    laptop.locator("#signup-email").fill("owner@example.com")
    laptop.locator("#signup-password").fill(PASSWORD)
    laptop.locator("#signup-confirm").fill(PASSWORD)
    laptop.locator("#signup-remember").check()
    laptop.locator('#signup-form button[type="submit"]').click()
    laptop.locator("#code-input").fill(next(code for kind, code in iter(lambda: codes.get(timeout=30), None) if kind == "verify"))
    laptop.locator('#code-form button[type="submit"]').click()
    laptop.locator("#recovery-saved").check()
    laptop.locator("#finish-recovery").click()
    laptop.locator("#secure-later").click()
    laptop.get_by_role("button", name="Lock workspace", exact=True).click()

    laptop.locator("#unlock-password").fill(PASSWORD + " but wrong")
    laptop.locator('#unlock-form button[type="submit"]').click()
    message_in_view(laptop, "Could not unlock this device")

    laptop.locator("#use-another").click()
    log_in(laptop, "owner@example.com")
    message_in_view(laptop, "Invalid email or password")

    phone = open_page(PHONE)
    log_in(phone, "owner@example.com")
    message_in_view(phone, "Invalid email or password")
    assert not errors, errors
    return {"unlockLaptop": True, "loginLaptop": True, "loginPhone": True}


def main():
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="jotdrop-login-error-test-") as directory:
        with socket.socket() as candidate:
            candidate.bind(("127.0.0.1", 0))
            port = candidate.getsockname()[1]
        environment = dict(os.environ, JOTDROP_CLOUD_DATA_DIR=directory, JOTDROP_CLOUD_PORT=str(port), JOTDROP_CLOUD_SERVER_KEY=secrets.token_urlsafe(32))
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
                    print(check_login_error(browser, f"http://127.0.0.1:{port}", codes))
                finally:
                    browser.close()
        finally:
            process.terminate()
            process.wait(timeout=10)
            process.stdout.close()


if __name__ == "__main__":
    main()

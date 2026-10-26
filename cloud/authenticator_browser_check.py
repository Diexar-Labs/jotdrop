"""Run: python cloud/authenticator_browser_check.py. The recommended authenticator step after signing up, and the QR code in settings."""
import base64
import hashlib
import hmac
import os
import queue
import re
import secrets
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

PASSWORD = "synthetic authenticator passphrase"


def totp(secret, steps_ahead=0):
    """RFC 6238 as authenticator apps compute it; `steps_ahead` stays clear of a code the server already used."""
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    digest = hmac.new(key, struct.pack(">Q", int(time.time() // 30) + steps_ahead), hashlib.sha1).digest()
    offset = digest[-1] & 15
    return str((struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1000000).zfill(6)


def check_authenticator(browser, url, codes):
    def code(kind):
        while True:
            entry = codes.get(timeout=30)
            if entry[0] == kind:
                return entry[1]

    errors = []

    def open_page():
        page = browser.new_context(viewport={"width": 1280, "height": 900}).new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(url, wait_until="networkidle")
        return page

    def sign_up(page, email):
        page.get_by_role("button", name="Create an account").click()
        page.locator("#signup-email").fill(email)
        page.locator("#signup-password").fill(PASSWORD)
        page.locator("#signup-confirm").fill(PASSWORD)
        page.locator('#signup-form button[type="submit"]').click()
        page.locator("#code-input").fill(code("verify"))
        page.locator('#code-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()

    def qr_rows(page, selector):
        # The drawn QR code must hold every dark module the server sent, inside a white quiet zone.
        svg = page.locator(f"{selector} svg")
        svg.wait_for()
        assert svg.get_attribute("viewBox").split()[2] == svg.get_attribute("viewBox").split()[3]
        return svg.locator("path").get_attribute("d").count("h1v1h-1z")

    phone = open_page()
    sign_up(phone, "secure@example.com")
    offer = phone.locator("#secure-dialog")
    offer.wait_for()
    assert "recommended" in offer.locator("h2").inner_text()
    phone.locator("#secure-start").click()
    assert qr_rows(phone, "#secure-qr") > 100
    secret = phone.locator("#secure-secret").input_value()
    assert re.fullmatch(r"[A-Z2-7]{32}", secret), secret
    phone.locator("#secure-code").fill(str((int(totp(secret)) + 1) % 1000000).zfill(6))
    phone.locator('#secure-form button[type="submit"]').click()
    phone.locator("#secure-message").filter(has_text="Invalid").wait_for()
    assert offer.is_visible()
    phone.locator("#secure-code").fill(totp(secret))
    phone.locator('#secure-form button[type="submit"]').click()
    offer.wait_for(state="hidden")
    assert "Authenticator app turned on" in phone.locator("#workspace-message").inner_text()
    phone.locator('[data-view="devices"]').click()
    phone.locator("#totp-status").filter(has_text="On:").wait_for()

    laptop = open_page()
    laptop.locator("#login-email").fill("secure@example.com")
    laptop.locator("#login-password").fill(PASSWORD)
    laptop.locator('#login-form button[type="submit"]').click()
    laptop.locator("#code-label").filter(has_text="authenticator app").wait_for()
    laptop.locator("#code-input").fill(totp(secret, 1))
    laptop.locator('#code-form button[type="submit"]').click()
    laptop.locator("#workspace").wait_for()

    later = open_page()
    sign_up(later, "later@example.com")
    later.locator("#secure-later").click()
    later.locator("#secure-dialog").wait_for(state="hidden")
    later.locator('[data-view="devices"]').click()
    later.locator("#totp-status").filter(has_text="Off:").wait_for()
    later.locator("#totp-setup").click()
    assert qr_rows(later, "#totp-qr") > 100
    settings_secret = later.locator("#totp-secret").input_value()
    later.locator("#totp-code").fill(totp(settings_secret))
    later.locator("#totp-password").fill(PASSWORD)
    later.locator("#totp-submit").click()
    later.locator("#totp-status").filter(has_text="On:").wait_for()
    assert later.locator("#totp-qr svg").count() == 0
    assert not errors, errors
    return {"offerAfterSignup": True, "wrongCodeRefused": True, "loginWithApp": True, "laterThenSettings": True}


def main():
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="jotdrop-authenticator-test-") as directory:
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
                    print(check_authenticator(browser, f"http://127.0.0.1:{port}", codes))
                finally:
                    browser.close()
        finally:
            process.terminate()
            process.wait(timeout=10)
            process.stdout.close()


if __name__ == "__main__":
    main()

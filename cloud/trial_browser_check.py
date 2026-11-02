"""Run: python cloud/trial_browser_check.py. Synthetic check of the sign-up trial (Eric, 2 Nov 2026): a new account
starts with 14 days of Plus, the web app counts down, and in the last 3 days it says what Free keeps, with a way to buy."""
import os
import queue
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.dont_write_bytecode = True
from browser_check import use_markdown_editor  # noqa: E402

EMAIL = "trial@example.com"
PASSWORD = "synthetic trial passphrase"


def check_trial(browser, url, codes, shots):
    def code(kind):
        while True:
            entry = codes.get(timeout=30)
            if entry[0] == kind:
                return entry[1]

    errors = []
    page = browser.new_context(viewport={"width": 1280, "height": 900}).new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url, wait_until="networkidle")
    page.get_by_role("button", name="Create an account").click()
    page.locator("#signup-email").fill(EMAIL)
    page.locator("#signup-password").fill(PASSWORD)
    page.locator("#signup-confirm").fill(PASSWORD)
    page.locator('#signup-form button[type="submit"]').click()
    page.locator("#code-input").fill(code("verify"))
    page.locator('#code-form button[type="submit"]').click()
    page.locator("#recovery-saved").check()
    page.locator("#finish-recovery").click()
    page.locator("#secure-later").click()

    # 1. Right after signing up: Plus, counting down from 14 days, no nudge yet and no trial button anywhere.
    status = page.locator("#plan-status")
    status.filter(has_text="JotDrop Plus trial: 14 days left").wait_for()
    nudge = page.locator("#plus-nudge")
    assert nudge.is_hidden(), "No nudge in the first days of the trial."
    assert page.locator("#plus-offer").is_visible(), "The buy buttons stay in the sidebar during the trial."
    if shots:
        page.screenshot(path=str(Path(shots) / "trial-day-1.png"))

    # 2. Two days left: the nudge says what Free keeps and offers Plus, not another trial.
    def two_days_left(route):
        response = route.fetch()
        body = response.json()
        body["plan"]["trialEnds"] = (datetime.now(timezone.utc) + timedelta(days=1, hours=20)).isoformat().replace("+00:00", "Z")
        route.fulfill(response=response, json=body)
    page.route("**/status", two_days_left)
    page.locator("#sync").click()
    page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
    status.filter(has_text="JotDrop Plus trial: 2 days left").wait_for()
    nudge.filter(has_text="Your JotDrop Plus trial ends in 2 days").wait_for()
    assert "nothing is deleted" in nudge.inner_text()
    assert nudge.get_by_role("button", name="Get JotDrop Plus").is_visible()
    assert nudge.get_by_role("button", name="Try JotDrop Plus free for 14 days").is_hidden()
    if shots:
        page.screenshot(path=str(Path(shots) / "trial-2-days-left.png"))
    # The button opens the sidebar on the buy buttons, as at every other limit.
    nudge.get_by_role("button", name="Get JotDrop Plus").click()
    page.wait_for_function("document.activeElement && document.activeElement.id === 'buy-month'")

    # 3. Not now keeps it away for this visit.
    nudge.get_by_role("button", name="Not now").click()
    assert nudge.is_hidden()
    page.locator("#sync").click()
    page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
    assert nudge.is_hidden(), "Not now holds for the rest of the visit."
    page.unroute("**/status")

    assert not errors, errors
    return {"trialCountdown": True, "lastDaysNudge": True, "notNow": True}


def main():
    root = Path(__file__).resolve().parent.parent
    shots = os.environ.get("JOTDROP_SHOTS_DIR")
    with tempfile.TemporaryDirectory(prefix="jotdrop-trial-test-") as directory:
        with socket.socket() as candidate:
            candidate.bind(("127.0.0.1", 0))
            port = candidate.getsockname()[1]
        environment = dict(os.environ, JOTDROP_CLOUD_DATA_DIR=directory, JOTDROP_CLOUD_PORT=str(port), JOTDROP_CLOUD_SERVER_KEY=secrets.token_urlsafe(32),
                           JOTDROP_CLOUD_STRIPE_SECRET_KEY="sk_test_synthetic", JOTDROP_CLOUD_STRIPE_WEBHOOK_SECRET="whsec_synthetic", JOTDROP_CLOUD_STRIPE_PRICE_MONTH="price_month", JOTDROP_CLOUD_STRIPE_PRICE_YEAR="price_year")
        process = subprocess.Popen(["node", "cloud/server.mjs"], cwd=root, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        codes = queue.Queue()

        def read_mail():
            for line in process.stdout:
                match = re.match(r"\[mail\] (\w+) to \S+: (\d{6})", line)
                if match:
                    codes.put((match.group(1), match.group(2)))

        try:
            assert "JotDrop Cloud listening" in process.stdout.readline(), "Local test server did not start."
            threading.Thread(target=read_mail, daemon=True).start()
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True, channel=sys.argv[1] if len(sys.argv) > 1 else "msedge")
                use_markdown_editor(browser)
                try:
                    print(check_trial(browser, f"http://127.0.0.1:{port}", codes, shots))
                finally:
                    browser.close()
        finally:
            process.terminate()
            process.wait(timeout=10)
            process.stdout.close()


if __name__ == "__main__":
    main()

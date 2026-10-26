"""Run: python cloud/plans_browser_check.py. Synthetic JotDrop Plus limit checks: device limit at login, locked versions, trial."""
import os
import queue
import re
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.dont_write_bytecode = True
from browser_check import use_markdown_editor  # noqa: E402

EMAIL = "plans@example.com"
PASSWORD = "synthetic plans passphrase"


def check_plans(browser, url, codes, database):
    def code(kind):
        while True:
            entry = codes.get(timeout=30)
            if entry[0] == kind:
                return entry[1]

    def open_page():
        page = browser.new_context(viewport={"width": 1280, "height": 900}).new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(url, wait_until="networkidle")
        return page

    def log_in(page):
        page.locator("#login-email").fill(EMAIL)
        page.locator("#login-password").fill(PASSWORD)
        page.locator('#login-form button[type="submit"]').click()
        page.locator("#code-input").fill(code("login"))
        page.locator('#code-form button[type="submit"]').click()

    errors = []
    phone = open_page()
    phone.get_by_role("button", name="Create an account").click()
    phone.locator("#signup-email").fill(EMAIL)
    phone.locator("#signup-password").fill(PASSWORD)
    phone.locator("#signup-confirm").fill(PASSWORD)
    phone.locator('#signup-form button[type="submit"]').click()
    phone.locator("#code-input").fill(code("verify"))
    phone.locator('#code-form button[type="submit"]').click()
    phone.locator("#recovery-saved").check()
    phone.locator("#finish-recovery").click()
    phone.locator("#secure-later").click()  # The authenticator offer after signing up.
    phone.locator("#plan-status").filter(has_text="Free plan: 2 devices, 30 days of history").wait_for()
    assert phone.locator("#start-trial").is_visible()
    # Buy buttons only; a click would contact Stripe with the synthetic settings below.
    phone.locator("#plus-offer").filter(has_text="€3.99 per month").wait_for()
    assert phone.locator("#buy-year").inner_text() == "€29 per year (founder price)"
    assert phone.locator("#plus-manage").is_hidden()

    for content in ["# List\n\nmilk", "# List\n\nmilk, eggs", "# List\n\nmilk, eggs, bread"]:
        card = phone.locator('.note-card[data-path="notes/list.md"]')
        if card.count():
            card.locator("h3").click()
        else:
            phone.locator("#new-note").click()
            phone.locator("#note-path").fill("notes/list.md")
        phone.locator("#note-content").fill(content)
        phone.locator('#editor-form button[type="submit"]').click()
        phone.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
    # Make every version 60 days old: the two replaced ones fall outside the free 30 days.
    old = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    with closing(sqlite3.connect(database)) as db, db:
        db.execute("UPDATE revisions SET updatedAt=?", (old,))

    def history(page):
        page.locator('.note-card[data-path="notes/list.md"] h3').click()
        page.locator("#note-history").click()
        rows = page.locator("#history-list .history-row")
        rows.first.wait_for()
        return rows

    rows = history(phone)
    assert rows.count() == 3, rows.count()
    locked = phone.locator("#history-list .history-row.locked")
    assert locked.count() == 2
    assert "JotDrop Plus restores it" in locked.first.inner_text()
    assert locked.get_by_role("button").count() == 0
    assert rows.first.get_by_role("button", name="Download version").count() == 1
    phone.keyboard.press("Escape")

    laptop = open_page()
    log_in(laptop)
    laptop.locator("#plan-status").wait_for(state="visible")

    tablet = open_page()
    log_in(tablet)
    choices = tablet.locator("#device-limit button")
    choices.first.wait_for()
    assert "The free plan includes 2 devices" in tablet.locator("#device-limit").inner_text()
    assert choices.count() == 2
    choices.first.click()
    tablet.locator("#plan-status").filter(has_text="Free plan").wait_for()
    with closing(sqlite3.connect(database)) as db:
        assert db.execute("SELECT COUNT(*) FROM devices WHERE revoked=0").fetchone()[0] == 2
        assert db.execute("SELECT COUNT(*) FROM devices WHERE revoked=1").fetchone()[0] == 1

    tablet.locator("#start-trial").click()
    tablet.locator("#plan-status").filter(has_text="JotDrop Plus until").wait_for()
    assert tablet.locator("#start-trial").is_hidden()
    rows = history(tablet)
    assert rows.count() == 3 and tablet.locator("#history-list .history-row.locked").count() == 0
    assert rows.nth(2).get_by_role("button", name="Restore version").count() == 1
    tablet.keyboard.press("Escape")

    # A subscriber finds how to cancel folded away at the bottom of Devices & recovery (Eric).
    with closing(sqlite3.connect(database)) as db, db:
        vault = db.execute("SELECT vaultId FROM devices LIMIT 1").fetchone()[0]
        db.execute("INSERT INTO subscriptions VALUES ('sub_check', ?, 'active', 0)", (vault,))
    tablet.locator("#sync").click()
    manage = tablet.locator("#plus-manage")
    tablet.locator("#plus-manage:not([hidden])").wait_for(state="attached")
    assert tablet.locator(".sidebar-bottom #plus-manage").count() == 0
    tablet.locator('[data-view="devices"]').click()
    assert manage.is_visible() and manage.get_attribute("open") is None
    assert not manage.get_by_text("link.com").is_visible()
    manage.locator("summary").click()
    assert manage.get_by_text("Manage or cancel your subscription at link.com.").is_visible()

    # This browser was not remembered: locking gives its device slot back.
    tablet.locator("#lock").click()
    tablet.locator("#login-form").wait_for()
    for _ in range(50):
        with closing(sqlite3.connect(database)) as db:
            if db.execute("SELECT COUNT(*) FROM devices WHERE revoked=0").fetchone()[0] == 1:
                break
        tablet.wait_for_timeout(100)
    else:
        raise AssertionError("The browser that was not remembered kept its device slot.")
    assert not errors, errors
    return {"lockedVersions": 2, "deviceChoices": 2, "trial": "on", "releasedOnLock": True}


def main():
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="jotdrop-plans-test-") as directory:
        with socket.socket() as candidate:
            candidate.bind(("127.0.0.1", 0))
            port = candidate.getsockname()[1]
        environment = dict(os.environ, JOTDROP_CLOUD_DATA_DIR=directory, JOTDROP_CLOUD_PORT=str(port), JOTDROP_CLOUD_SERVER_KEY=secrets.token_urlsafe(32),
                           JOTDROP_CLOUD_STRIPE_SECRET_KEY="sk_test_synthetic", JOTDROP_CLOUD_STRIPE_WEBHOOK_SECRET="whsec_synthetic", JOTDROP_CLOUD_STRIPE_PRICE_MONTH="price_month", JOTDROP_CLOUD_STRIPE_PRICE_YEAR="price_year", JOTDROP_CLOUD_STRIPE_PRICE_FOUNDER_YEAR="price_founder")
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
                use_markdown_editor(browser)
                try:
                    print(check_plans(browser, f"http://127.0.0.1:{port}", codes, str(Path(directory) / "cloud.db")))
                finally:
                    browser.close()
        finally:
            process.terminate()
            process.wait(timeout=10)
            process.stdout.close()


if __name__ == "__main__":
    main()

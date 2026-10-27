"""Run: python cloud/plans_browser_check.py. Synthetic JotDrop Plus limit checks: the trial only at a limit (storage, file size, full cloud, old versions, device limit), then the trial itself."""
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
TRIAL = "Try JotDrop Plus free for 14 days"


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
    # The trial shows only where a free limit is in the way, never as a standing button (Eric, 27 Oct).
    nudge = phone.locator("#plus-nudge")
    assert nudge.is_hidden() and phone.get_by_role("button", name=TRIAL).count() == 0
    # Buy buttons only; a click would contact Stripe with the synthetic settings below.
    phone.locator("#plus-offer").filter(has_text="€3.99 per month").wait_for()
    assert phone.locator("#buy-year").inner_text() == "€29 per year (founder price)"
    assert phone.locator("#plus-manage").is_hidden()

    def synced(page):
        page.locator("#sync").click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

    def status_with(change):
        def handle(route):
            response = route.fetch()
            body = response.json()
            change(body)
            route.fulfill(response=response, json=body)
        return handle

    # 1. Storage 85% full.
    phone.route("**/status", status_with(lambda body: body.update(usedBytes=int(body["quotaBytes"] * 0.85))))
    synced(phone)
    nudge.filter(has_text="85% full").wait_for()
    assert "10 GB" in nudge.inner_text() and nudge.get_by_role("button", name=TRIAL).is_visible()
    nudge.get_by_role("button", name="Not now").click()
    assert nudge.is_hidden()
    synced(phone)
    assert nudge.is_hidden(), "Not now keeps the storage offer away for this visit."
    phone.unroute("**/status")

    # 2. A file larger than the free maximum; this time the trial was used, so it says Get JotDrop Plus.
    def small_files(body):
        body["pieces"]["maxFileBytes"] = 1024 * 1024
        body["plan"]["trialAvailable"] = False
    phone.route("**/status", status_with(small_files))
    synced(phone)
    assert nudge.is_hidden()
    phone.locator("#upload").set_input_files({"name": "big.bin", "mimeType": "application/octet-stream", "buffer": b"x" * (2 * 1024 * 1024)})
    phone.locator("#workspace-message").filter(has_text="larger than 1 MB").wait_for()
    nudge.filter(has_text="200 MB").wait_for()
    assert nudge.get_by_role("button", name=TRIAL).count() == 0
    nudge.get_by_role("button", name="Get JotDrop Plus").click()
    assert phone.evaluate("document.activeElement.id") == "buy-month"
    nudge.get_by_role("button", name="Not now").click()
    phone.unroute("**/status")

    # 3. Cloud storage full while saving a note.
    full = re.compile(r".*/objects/[^/?]+$")
    phone.route(full, lambda route: route.fulfill(status=507, json={"error": "Cloud storage is full. Your local files remain available.", "code": "storage-full"}) if route.request.method == "PUT" else route.fallback())
    phone.locator("#new-note").click()
    phone.locator("#note-path").fill("notes/full.md")
    phone.locator("#note-content").fill("# Full\n\nwaiting")
    phone.locator('#editor-form button[type="submit"]').click()
    phone.locator("#workspace-message").filter(has_text="Cloud storage is full").wait_for()
    nudge.filter(has_text="10 GB").wait_for()
    assert nudge.get_by_role("button", name=TRIAL).is_visible()
    nudge.get_by_role("button", name="Not now").click()
    phone.unroute(full)
    synced(phone)

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
    # 4. One offer under the list, not one per locked version.
    assert phone.locator("#history-list").get_by_role("button", name=TRIAL).count() == 1
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

    # 5. The third device: the offer waits in the workspace after the choice.
    tablet_nudge = tablet.locator("#plus-nudge")
    tablet_nudge.filter(has_text="no device limit").wait_for()
    tablet_nudge.get_by_role("button", name=TRIAL).click()
    tablet.locator("#plan-status").filter(has_text="JotDrop Plus until").wait_for()
    assert tablet_nudge.is_hidden() and tablet.get_by_role("button", name=TRIAL).count() == 0
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

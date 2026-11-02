"""Run: python cloud/family_browser_check.py. Synthetic family plan: the offer, inviting by link, joining after signing up, removing and leaving."""
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
import time
from contextlib import closing
from pathlib import Path

from playwright.sync_api import sync_playwright

PASSWORD = "synthetic family passphrase"


def check_family(browser, url, codes, database):
    errors = []

    def code(kind):
        while True:
            entry = codes.get(timeout=30)
            if entry[0] == kind:
                return entry[1]

    def sign_up(email, path="/"):
        page = browser.new_context(viewport={"width": 1280, "height": 900}).new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(url + path, wait_until="networkidle")
        page.get_by_role("button", name="Create an account").click()
        page.locator("#signup-email").fill(email)
        page.locator("#signup-password").fill(PASSWORD)
        page.locator("#signup-confirm").fill(PASSWORD)
        page.locator('#signup-form button[type="submit"]').click()
        page.locator("#code-input").fill(code("verify"))
        page.locator('#code-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        page.locator("#secure-later").click()
        return page

    ana = sign_up("ana@example.com")
    ana.locator("#family-offer").filter(has_text="€6.99 per month").wait_for()
    assert ana.locator("#buy-family-year").inner_text() == "€45 per year (founder price)"
    assert ana.locator("#open-family").is_hidden()

    # Stripe confirmed a family plan for Ana (written directly; a click would contact Stripe).
    with closing(sqlite3.connect(database)) as db, db:
        vault = db.execute("SELECT vaultId FROM accounts WHERE email='ana@example.com'").fetchone()[0]
        db.execute("INSERT INTO subscriptions VALUES ('sub_family', ?, 'active', ?)", (vault, int(time.time() * 1000) + 30 * 86400000))
        db.execute("INSERT INTO family_subscriptions VALUES ('sub_family')")
    ana.locator("#sync").click()
    ana.locator("#open-family:not([hidden])").wait_for()
    assert ana.locator("#plus-offer").is_hidden()
    ana.locator("#open-family").click()
    dialog = ana.locator("#family-dialog")
    dialog.filter(has_text="up to 5 others").wait_for()
    dialog.get_by_role("button", name="Invite someone").click()
    ana.locator("#family-invite").wait_for()
    link = ana.locator("#family-link").input_value()
    assert re.fullmatch(re.escape(url) + r"/family#[\w-]{43}", link), link
    dialog.get_by_role("button", name="Done").click()

    # Ben opens the link without an account, signs up, and is asked to join.
    path = link[len(url):]
    ben = sign_up("ben@example.com", path)
    join = ben.locator("#family-join-dialog")
    join.filter(has_text="sees your email address").wait_for()
    assert "/family" not in ben.url and "#" not in ben.url, ben.url
    join.get_by_role("button", name="Join").click()
    ben.locator("#workspace-message").filter(has_text="family plan of ana@example.com").wait_for()
    ben.locator("#plan-status").filter(has_text="JotDrop Plus through your family").wait_for()
    assert ben.locator("#plus-offer").is_hidden()

    # The same link does not work twice.
    cas = sign_up("cas@example.com", path)
    cas_join = cas.locator("#family-join-dialog")
    cas_join.wait_for()
    cas_join.get_by_role("button", name="Join").click()
    cas_join.filter(has_text="does not work any more").wait_for()
    cas_join.get_by_role("button", name="Not now").click()
    cas.locator("#plan-status").filter(has_text="Free plan").wait_for()

    # Ana sees Ben; Ben leaves himself.
    ana.locator("#open-family").click()
    dialog.filter(has_text="ben@example.com").wait_for()
    dialog.get_by_role("button", name="Done").click()
    ben.locator("#open-family").click()
    ben_dialog = ben.locator("#family-dialog")
    ben_dialog.filter(has_text="through the family plan of ana@example.com").wait_for()
    ben.once("dialog", lambda prompt: prompt.accept())
    ben_dialog.get_by_role("button", name="Leave the family").click()
    ben.locator("#workspace-message").filter(has_text="You left the family plan.").wait_for()
    ben.locator("#plan-status").filter(has_text="Free plan").wait_for()

    # Ana invites Cas, who joins, and removes Cas again.
    ana.locator("#open-family").click()
    dialog.get_by_role("button", name="Invite someone").click()
    ana.locator("#family-invite").wait_for()
    second = ana.locator("#family-link").input_value()
    dialog.get_by_role("button", name="Done").click()
    # An open link leaves this browser signed out (not remembered): Cas logs in, then joins.
    cas.goto(second, wait_until="networkidle")
    cas.locator("#login-email").fill("cas@example.com")
    cas.locator("#login-password").fill(PASSWORD)
    cas.locator('#login-form button[type="submit"]').click()
    cas.locator("#code-input").fill(code("login"))
    cas.locator('#code-form button[type="submit"]').click()
    cas_join.get_by_role("button", name="Join").click()
    cas.locator("#plan-status").filter(has_text="through your family").wait_for()
    ana.locator("#open-family").click()
    dialog.filter(has_text="cas@example.com").wait_for()
    ana.once("dialog", lambda prompt: prompt.accept())
    dialog.get_by_role("button", name="Remove").click()
    dialog.locator("#family-members").filter(has_text="cas@example.com").wait_for(state="detached")
    cas.locator("#sync").click()
    cas.locator("#plan-status").filter(has_text="Free plan").wait_for()
    # A plan chosen on jotdrop.net is shown before signing up and offered right after; payment goes to Stripe.
    dan_page = browser.new_context(viewport={"width": 390, "height": 844}).new_page()
    dan_page.on("pageerror", lambda error: errors.append(str(error)))
    dan_page.goto(url + "/?plan=family&billing=year", wait_until="networkidle")
    dan_page.locator("#access-choice").filter(has_text="You chose JotDrop Family, €59 per year.").wait_for()
    assert "plan=" not in dan_page.url, dan_page.url
    dan_page.context.close()
    dan = sign_up("dan@example.com", "/?plan=family&billing=year")
    offer = dan.locator("#plan-dialog")
    offer.filter(has_text="€59 per year").wait_for()
    assert "up to 5 others" in offer.inner_text()
    checkout = []
    dan.route("**/account/checkout", lambda route: (checkout.append(route.request.post_data_json), route.fulfill(status=200, content_type="application/json", body='{"url": "%s/?plus=welcome"}' % url)))
    with dan.expect_navigation(url=re.compile(r".*[?]plus=welcome$")):
        offer.get_by_role("button", name="Continue to payment").click()
    assert checkout == [{"interval": "year", "plan": "family"}], checkout
    eve = sign_up("eve@example.com", "/?plan=plus&billing=month")
    eve.locator("#plan-dialog").filter(has_text="€3.99 per month").wait_for()
    eve.get_by_role("button", name="Not now").click()
    assert eve.locator("#plan-dialog").is_hidden()
    assert eve.evaluate("sessionStorage.getItem('jotdrop-plan-choice')") is None, "Not now forgets the choice"
    # Someone who already pays for a family is told so instead of being offered a second plan.
    ana.goto(url + "/?plan=family&billing=month", wait_until="networkidle")
    ana.locator("#access-choice").filter(has_text="JotDrop Family").wait_for()
    ana.locator("#login-email").fill("ana@example.com")
    ana.locator("#login-password").fill(PASSWORD)
    ana.locator('#login-form button[type="submit"]').click()
    ana.locator("#code-input").fill(code("login"))
    ana.locator('#code-form button[type="submit"]').click()
    ana.locator("#workspace-message").filter(has_text="already in a family plan").wait_for()
    assert ana.locator("#plan-dialog").is_hidden()
    assert not errors, errors
    return {"siteChoice": True, "offer": True, "invite": True, "joinAfterSignup": True, "linkOnce": True, "leave": True, "remove": True}


def main():
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="jotdrop-family-test-") as directory:
        with socket.socket() as candidate:
            candidate.bind(("127.0.0.1", 0))
            port = candidate.getsockname()[1]
        environment = dict(os.environ, JOTDROP_CLOUD_DATA_DIR=directory, JOTDROP_CLOUD_PORT=str(port), JOTDROP_CLOUD_SERVER_KEY=secrets.token_urlsafe(32),
                           JOTDROP_CLOUD_STRIPE_SECRET_KEY="sk_test_synthetic", JOTDROP_CLOUD_STRIPE_WEBHOOK_SECRET="whsec_synthetic", JOTDROP_CLOUD_STRIPE_PRICE_MONTH="price_month", JOTDROP_CLOUD_STRIPE_PRICE_YEAR="price_year",
                           JOTDROP_CLOUD_STRIPE_PRICE_FOUNDER_YEAR="price_founder", JOTDROP_CLOUD_STRIPE_PRICE_FAMILY_MONTH="price_family_month", JOTDROP_CLOUD_STRIPE_PRICE_FAMILY_YEAR="price_family_year",
                           JOTDROP_CLOUD_STRIPE_PRICE_FAMILY_FOUNDER_YEAR="price_family_founder")
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
                    print(check_family(browser, f"http://127.0.0.1:{port}", codes, str(Path(directory) / "cloud.db")))
                finally:
                    browser.close()
        finally:
            process.terminate()
            process.wait(timeout=10)
            process.stdout.close()


if __name__ == "__main__":
    main()

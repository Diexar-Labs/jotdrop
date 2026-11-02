"""Run: python cloud/roadmap_browser_check.py. Synthetic check of "Plus gets it first" (Eric, 2 Nov 2026): Plus votes
on what comes next (3 votes, can take one back), Free sees the list and the counts, and paying accounts carry a supporter label."""
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

EMAIL = "roadmap@example.com"
PASSWORD = "synthetic roadmap passphrase"


def check_roadmap(browser, url, codes, shots):
    def code(kind):
        while True:
            entry = codes.get(timeout=30)
            if entry[0] == kind:
                return entry[1]

    def synced():
        page.locator("#sync").click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

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
    page.locator("#plan-status").filter(has_text="JotDrop Plus trial").wait_for()

    # 1. A trial is Plus, but no support: no label.
    assert page.locator("#supporter-badge").is_hidden(), "A trial shows no supporter label."

    # 2. Vote for three ideas; the fourth waits until a vote is taken back.
    page.get_by_role("button", name="Vote on what's next").click()
    dialog = page.locator("#roadmap-dialog")
    dialog.filter(has_text="You have 3 of 3 votes left").wait_for()
    items = dialog.locator("#roadmap-items li")
    assert items.count() >= 4, "The list shows every idea."
    first, second, third, fourth = (items.nth(index) for index in range(4))
    for item in (first, second, third):
        item.get_by_role("button", name="Vote").click()
        item.get_by_role("button", name="Voted").wait_for()
    dialog.filter(has_text="You have 0 of 3 votes left").wait_for()
    assert first.get_by_role("button").get_attribute("aria-describedby") == first.locator("strong").get_attribute("id"), "The vote button names its idea."
    assert "✓ Voted" in first.get_by_role("button").inner_text(), "The state is in words and a check mark, not only colour."
    assert "1 vote" in first.inner_text()
    assert fourth.get_by_role("button").is_disabled(), "No fourth vote."
    if shots:
        page.screenshot(path=str(Path(shots) / "roadmap-voted.png"))
    second.get_by_role("button", name="Voted").click()
    dialog.filter(has_text="Your vote is taken back").wait_for()
    assert fourth.get_by_role("button").is_enabled()
    assert "0 votes" in second.inner_text()
    dialog.get_by_role("button", name="Close").click()

    # 3. On Free the list and counts stay visible, voting is off and the dialog offers Plus.
    def free_list(route):
        response = route.fetch()
        body = response.json()
        if route.request.method == "GET":
            body["canVote"] = False
        route.fulfill(response=response, json=body)
    page.route("**/account/roadmap", free_list)
    page.get_by_role("button", name="Vote on what's next").click()
    dialog.filter(has_text="Voting is part of JotDrop Plus").wait_for()
    assert fourth.get_by_role("button").is_disabled()
    assert first.get_by_role("button").is_enabled(), "Taking back a vote stays possible."
    assert dialog.locator("#roadmap-plus").is_visible()
    if shots:
        page.screenshot(path=str(Path(shots) / "roadmap-free.png"))
    dialog.get_by_role("button", name="Close").click()
    page.unroute("**/account/roadmap")

    # 4. A paying account carries the label.
    def paying(route):
        response = route.fetch()
        body = response.json()
        body["plan"]["supporter"] = True
        route.fulfill(response=response, json=body)
    page.route("**/status", paying)
    synced()
    page.locator("#supporter-badge").filter(has_text="Plus supporter").wait_for()
    if shots:
        page.locator("#sidebar").screenshot(path=str(Path(shots) / "supporter-label.png"))
    page.unroute("**/status")

    assert not errors, errors
    return {"votes": 3, "takeBack": True, "freeSeesList": True, "supporterLabel": True}


def main():
    root = Path(__file__).resolve().parent.parent
    shots = os.environ.get("JOTDROP_SHOTS_DIR")
    with tempfile.TemporaryDirectory(prefix="jotdrop-roadmap-test-") as directory:
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
                    print(check_roadmap(browser, f"http://127.0.0.1:{port}", codes, shots))
                finally:
                    browser.close()
        finally:
            process.terminate()
            process.wait(timeout=10)
            process.stdout.close()


if __name__ == "__main__":
    main()

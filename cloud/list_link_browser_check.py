"""Run: python cloud/list_link_browser_check.py. A live list link: the owner in the web app, two guests on the page without an account."""
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

PASSWORD = "synthetic list link passphrase"


def check_list_link(browser, url, codes):
    def code(kind):
        while True:
            entry = codes.get(timeout=30)
            if entry[0] == kind:
                return entry[1]

    errors = []
    contexts = []

    def open_page(address):
        context = browser.new_context(viewport={"width": 1280, "height": 900})
        context.grant_permissions(["clipboard-read", "clipboard-write"], origin=url)
        contexts.append(context)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("dialog", lambda dialog: dialog.accept())
        page.goto(address, wait_until="networkidle")
        return page

    def synced(page):
        page.locator("#sync").click()
        page.locator("#sync-status").filter(has_text="up to date").wait_for()

    def guest_item(page, text):
        return page.locator(".list-link-task").filter(has_text=text)

    def card_item(card, text):
        return card.locator(".task-row").filter(has_text=text).locator("input")

    owner = open_page(url)
    try:
        # Links need an account, so the owner signs up like the sharing check does.
        owner.get_by_role("button", name="Create an account").click()
        owner.locator("#signup-email").fill("eric@example.com")
        owner.locator("#signup-password").fill(PASSWORD)
        owner.locator("#signup-confirm").fill(PASSWORD)
        owner.locator("#signup-remember").check()
        owner.locator('#signup-form button[type="submit"]').click()
        owner.locator("#code-input").fill(code("verify"))
        owner.locator('#code-form button[type="submit"]').click()
        owner.locator("#recovery-saved").check()
        owner.locator("#finish-recovery").click()
        owner.locator("#secure-later").click()
        owner.locator("#new-note").click()
        owner.locator("#note-title").fill("Groceries")
        owner.locator("#note-body").fill("- [ ] milk\n- [ ] eggs\n- [ ] bread\n")
        owner.locator('#editor-form button[type="submit"]').click()
        owner.locator("#editor").wait_for(state="hidden")
        owner.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        card = owner.locator(".note-card").filter(has_text="Groceries")

        # --- The owner makes a live list link from the card menu.
        card.hover()
        card.get_by_role("button", name="More").click()
        owner.get_by_role("menuitem", name="Share list by link…").click()
        dialog = owner.locator("#link-dialog")
        dialog.wait_for()
        assert owner.locator('input[name="link-kind"][value="list"]').is_checked()
        assert owner.locator("#link-about-list").is_visible() and owner.locator("#link-about-copy").is_hidden()
        owner.locator("#link-create").click()
        owner.locator("#link-made").wait_for()
        address = owner.locator("#link-address").input_value()
        assert re.fullmatch(re.escape(url) + r"/l/[0-9a-f-]{36}#[\w-]{43}", address), address
        owner.locator("#link-list").get_by_text("live list").wait_for()
        owner.locator("#link-close").click()
        dialog.wait_for(state="hidden")
        card.get_by_role("button", name="Live list link").wait_for()

        # --- A guest opens the page: real boxes, a name field, and a tick with the name next to it.
        anna = open_page(address)
        anna.locator("#list-article").wait_for()
        assert anna.locator("#list-title").inner_text() == "Groceries"
        assert anna.locator(".list-link-task").count() == 3
        anna.locator("#list-name").fill("Anna")
        anna.locator("#list-name").dispatch_event("change")
        guest_item(anna, "milk").locator("input").check()
        guest_item(anna, "milk").locator(".list-link-by").filter(has_text="✓ Anna").wait_for()
        # The name stays in this browser only.
        assert anna.evaluate("localStorage.getItem('jotdrop-list-name')") == "Anna"

        # --- A second guest reads the version with Anna's tick, then writes against a stale number: 409, retry, both ticks stay.
        ben = open_page(address)
        ben.locator("#list-article").wait_for()
        assert guest_item(ben, "milk").locator("input").is_checked()
        guest_item(anna, "eggs").locator("input").check()
        guest_item(anna, "eggs").locator(".list-link-by").filter(has_text="✓ Anna").wait_for()
        ben.locator("#list-name").fill("Ben")
        guest_item(ben, "bread").locator("input").check()
        guest_item(ben, "bread").locator(".list-link-by").filter(has_text="✓ Ben").wait_for()
        assert guest_item(ben, "eggs").locator("input").is_checked(), "Ben's page did not come back with the newest version after the 409."
        # Ben adds an item.
        ben.locator("#list-item").fill("butter")
        ben.locator('#list-add button[type="submit"]').click()
        guest_item(ben, "butter").locator(".list-link-by").filter(has_text="added by Ben").wait_for()
        assert ben.locator("#list-item").input_value() == ""
        # Anna's page picks it up by itself within the 15 second refresh.
        guest_item(anna, "butter").wait_for(timeout=20000)
        assert guest_item(anna, "bread").locator("input").is_checked()

        # --- The owner's sync carries the guests' ticks and the new item into the note.
        synced(owner)
        card_item(card, "milk").wait_for(timeout=45000)
        owner.locator(".note-card").filter(has_text="butter").wait_for(timeout=45000)
        owner.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for(timeout=45000)
        assert card_item(card, "milk").is_checked() and card_item(card, "eggs").is_checked() and card_item(card, "bread").is_checked()
        card.hover()
        card.get_by_role("button", name="More").click()
        owner.get_by_role("menuitem", name="Share list by link…").click()
        owner.locator("#link-list").get_by_text(re.compile(r'✓ Anna ticked "milk"')).wait_for()
        owner.locator("#link-list").get_by_text(re.compile(r'Ben added "butter"')).wait_for()
        owner.locator("#link-close").click()
        dialog.wait_for(state="hidden")

        # --- The owner unticks milk on the card; the next sync writes it to the link, and the guest's page follows.
        card_item(card, "milk").uncheck()
        owner.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for(timeout=45000)
        synced(owner)
        anna.wait_for_function("() => { const row = [...document.querySelectorAll('.list-link-task')].find((r) => r.textContent.includes('milk')); return row && !row.querySelector('input').checked; }", timeout=40000)

        if os.environ.get("JOTDROP_SHOT"):
            anna.screenshot(path=os.environ["JOTDROP_SHOT"], full_page=True)

        # --- Trash the note and end the link with it: the guests see that the link has ended.
        card.hover()
        card.get_by_role("button", name="More").click()
        owner.get_by_role("menuitem", name="Move to trash").click()
        owner.locator(".note-card").filter(has_text="Groceries").wait_for(state="hidden")
        anna.locator("#list-state").filter(has_text="This link has ended").wait_for(timeout=40000)

        assert not errors, errors
        return {"list_link_made": True, "guest_ticks_with_name": True, "stale_guest_retries": True, "guest_adds_item": True, "owner_takes_over": True, "owner_change_reaches_guest": True, "trash_ends_link": True}
    finally:
        if sys.exc_info()[0]:
            print({"sync": owner.locator("#sync-status").text_content(), "message": owner.locator("#workspace-message").text_content(), "link": owner.locator("#link-message").text_content(), "errors": errors})
        for context in contexts:
            context.close()


def main():
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="jotdrop-list-link-test-") as directory:
        with socket.socket() as candidate:
            candidate.bind(("127.0.0.1", 0))
            port = candidate.getsockname()[1]
        environment = dict(os.environ, JOTDROP_CLOUD_SIGNUP_TRIAL_DAYS="0", JOTDROP_CLOUD_DATA_DIR=directory, JOTDROP_CLOUD_PORT=str(port), JOTDROP_CLOUD_SERVER_KEY=secrets.token_urlsafe(32))
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
                    print(check_list_link(browser, f"http://127.0.0.1:{port}", codes))
                finally:
                    browser.close()
        finally:
            process.terminate()
            process.wait(timeout=10)
            process.stdout.close()


if __name__ == "__main__":
    main()

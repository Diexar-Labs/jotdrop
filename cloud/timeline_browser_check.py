"""Run: python cloud/timeline_browser_check.py. Synthetic time machine checks: earlier moments, Plus lock, restore, cleared notes."""
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

EMAIL = "timeline@example.com"
PASSWORD = "synthetic timeline passphrase"


def check_timeline(browser, url, codes, database):
    def code(kind):
        while True:
            entry = codes.get(timeout=30)
            if entry[0] == kind:
                return entry[1]

    def open_page():
        page = browser.new_context(viewport={"width": 1280, "height": 900}).new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("dialog", lambda dialog: dialog.accept())
        page.goto(url, wait_until="networkidle")
        return page

    def save(page, path, content):
        card = page.locator(f'.note-card[data-path="{path}"]')
        if card.count():
            card.locator("h3").click()
        else:
            page.locator("#new-note").click()
            page.locator("#note-path").fill(path)
        page.locator("#note-content").fill(content)
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

    def card_text(page, path):
        return page.locator(f'.note-card[data-path="{path}"]').inner_text()

    def pick(page, step):
        page.locator("#timeline-range").evaluate("(range, step) => { range.value = step; range.dispatchEvent(new Event('input')); range.dispatchEvent(new Event('change')); }", step)
        page.locator("#timeline-moment").filter(has_text="Read-only").wait_for()

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
    phone.locator("#plan-status").filter(has_text="Free plan").wait_for()

    save(phone, "notes/a.md", "# Shopping\n\nmilk")
    save(phone, "notes/b.md", "# Ideas\n\nfirst idea")
    save(phone, "notes/a.md", "# Shopping\n\nmilk, eggs")
    phone.locator('.note-card[data-path="notes/b.md"] h3').click()
    phone.locator("#note-delete").click()
    phone.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
    save(phone, "notes/c.md", "# Later\n\nmade after")

    # Spread the five changes over five days, 45 to 41 days ago.
    start = datetime.now(timezone.utc) - timedelta(days=45)
    with closing(sqlite3.connect(database)) as db, db:
        for index, (sequence, vault, object_id, revision) in enumerate(db.execute("SELECT sequence,vaultId,id,revision FROM changes ORDER BY sequence").fetchall()):
            moment = (start + timedelta(days=index)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            db.execute("UPDATE changes SET updatedAt=? WHERE sequence=?", (moment, sequence))
            db.execute("UPDATE revisions SET updatedAt=? WHERE vaultId=? AND id=? AND revision=?", (moment, vault, object_id, revision))

    laptop = open_page()
    laptop.locator("#login-email").fill(EMAIL)
    laptop.locator("#login-password").fill(PASSWORD)
    laptop.locator('#login-form button[type="submit"]').click()
    laptop.locator("#code-input").fill(code("login"))
    laptop.locator('#code-form button[type="submit"]').click()
    laptop.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
    laptop.locator("#time-machine").click()
    assert laptop.locator("#timeline-range").get_attribute("max") == "4"
    assert laptop.locator("#timeline-moment").inner_text() == "Now"

    # Free plan: both notes of that moment changed more than 30 days ago.
    pick(laptop, 1)
    assert "2 file(s) from then changed more than 30 days ago" in laptop.locator("#timeline-moment").inner_text()
    assert laptop.locator("#timeline-restore").is_disabled()

    laptop.locator("#start-trial").click()
    laptop.locator("#plan-status").filter(has_text="JotDrop Plus until").wait_for()
    pick(laptop, 1)
    assert "30 days" not in laptop.locator("#timeline-moment").inner_text()
    assert "eggs" not in card_text(laptop, "notes/a.md") and "milk" in card_text(laptop, "notes/a.md")
    assert "first idea" in card_text(laptop, "notes/b.md")
    assert laptop.locator('.note-card[data-path="notes/c.md"]').count() == 0
    assert laptop.locator(".note-card .card-actions").count() == 0
    assert laptop.locator(".note-card.opens").count() == 0

    laptop.locator("#timeline-restore").click()
    laptop.locator("#workspace-message").filter(has_text="Restored 3 file(s)").wait_for()
    assert laptop.locator("#timeline").is_hidden()
    assert "eggs" not in card_text(laptop, "notes/a.md")
    assert "first idea" in card_text(laptop, "notes/b.md")
    assert laptop.locator('.note-card[data-path="notes/c.md"]').count() == 0
    with closing(sqlite3.connect(database)) as db:
        latest = dict((row[0], row[1:]) for row in db.execute("SELECT id,revision,deleted FROM revisions r WHERE revision=(SELECT MAX(revision) FROM revisions m WHERE m.id=r.id)"))
        assert sorted(latest.values()) == [(2, 1), (3, 0), (3, 0)], latest
        assert db.execute("SELECT COUNT(*) FROM revisions").fetchone()[0] == 8

    # A note cleared from a full free cloud: its card leaves the trash without an error.
    laptop.locator('nav button[data-view="trash"]').click()
    laptop.locator('.note-card[data-path="notes/c.md"]').wait_for()
    with closing(sqlite3.connect(database)) as db, db:
        vault, object_id, revision = db.execute("SELECT vaultId,id,revision FROM revisions r WHERE deleted=1 AND revision=(SELECT MAX(revision) FROM revisions m WHERE m.id=r.id)").fetchone()
        db.execute("DELETE FROM revisions WHERE id=?", (object_id,))
        db.execute("DELETE FROM envelopes WHERE id=?", (object_id,))
        device = db.execute("SELECT id FROM devices WHERE revoked=0 LIMIT 1").fetchone()[0]
        now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        db.execute("INSERT INTO changes(vaultId,id,revision,deleted,size,updatedAt,deviceId) VALUES(?,?,?,1,0,?,?)", (vault, object_id, revision, now, device))
    laptop.locator("#sync").click()
    laptop.locator('.note-card[data-path="notes/c.md"]').wait_for(state="detached")
    laptop.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
    assert laptop.locator("#workspace-message").inner_text() == ""
    laptop.locator('nav button[data-view="notes"]').click()
    assert laptop.locator(".note-card").count() == 2

    # An edit to a note the cloud cleared in the meantime starts over as a new note instead of blocking sync.
    # Both living notes are cleared out of band; one of them was being edited.
    with closing(sqlite3.connect(database)) as db, db:
        object_ids = [row[0] for row in db.execute("SELECT id FROM revisions WHERE revision=3")]
        for object_id in object_ids:
            db.execute("DELETE FROM revisions WHERE id=?", (object_id,))
            db.execute("DELETE FROM envelopes WHERE id=?", (object_id,))
    path = laptop.locator(".note-card").first.get_attribute("data-path")
    laptop.locator(".note-card").first.locator("h3").click()
    laptop.locator("#note-content").fill("# Kept\n\nedited after clearing")
    laptop.locator('#editor-form button[type="submit"]').click()
    laptop.locator("#sync-status").filter(has_text="waiting to upload").wait_for()
    laptop.locator("#sync").click()
    laptop.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
    assert "edited after clearing" in card_text(laptop, path)
    with closing(sqlite3.connect(database)) as db:
        assert sorted(db.execute("SELECT revision,deleted FROM revisions WHERE id=?", (object_id,)).fetchall() for object_id in object_ids) == [[], [(1, 0)]]
    assert not errors, errors
    return {"moments": 5, "lockedOnFree": 2, "restored": 3, "clearedNoteLeftTrash": True}


def main():
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="jotdrop-timeline-test-") as directory:
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
                use_markdown_editor(browser)
                try:
                    print(check_timeline(browser, f"http://127.0.0.1:{port}", codes, str(Path(directory) / "cloud.db")))
                finally:
                    browser.close()
        finally:
            process.terminate()
            process.wait(timeout=10)
            process.stdout.close()


if __name__ == "__main__":
    main()

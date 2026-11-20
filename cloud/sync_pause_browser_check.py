"""Run: python cloud/sync_pause_browser_check.py. Synthetic check of sync on hold in the web app (Hand-off/ontwerp-sync-
pauzeren-boven-free.md, deel 8): a free cloud with three devices, this browser the one that goes on hold. Before the
pause a notice names it; on hold the board says so in one line that stays, the notes are read-only, nothing more goes
to the cloud than /status (and that at most every 30 minutes), logging out still works and says what stays behind, and
"Sync here instead" brings the waiting change up. The server is real; the pause is set up in its database."""
import json
import os
import re
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from contextlib import closing
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.dont_write_bytecode = True
from browser_check import use_markdown_editor  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PASSPHRASE = "synthetic sync pause passphrase"
DAY_MS = 24 * 60 * 60 * 1000
# Claims a pairing code as another device, or lists what a device can reach, with the shared client (no app needed).
CLAIM = "import { CloudClient } from './cloud/shared/client.mjs'; console.log(JSON.stringify((await CloudClient.claim({ pairingCode: process.argv[1] })).credentials));"
REACH = """import { CloudClient } from './cloud/shared/client.mjs';
const client = new CloudClient(JSON.parse(process.argv[1]));
try {
  const paths = [];
  for (const change of (await client.listChanges()).changes) paths.push((await client.read(change.id)).file.path);
  console.log(JSON.stringify({ paths }));
} catch (error) { console.log(JSON.stringify({ status: error.status, code: error.code })); }"""


def node(code, *args):
    return json.loads(subprocess.run(["node", "--input-type=module", "-e", code, *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout)


def check_sync_pause(browser, url, token, data, shots):
    database = data / "cloud.db"

    def sql(statement, *args):
        with closing(sqlite3.connect(database, timeout=10)) as db:
            rows = db.execute(statement, args).fetchall()
            db.commit()
            return rows

    def shot(name):
        if shots:
            page.screenshot(path=str(Path(shots) / f"sync-pause-{name}.png"))

    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors, dialogs, requests = [], [], []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("request", lambda request: requests.append(request.url) if "/api/v1/" in request.url else None)

    def dialog(d):
        dialogs.append(d.message)
        # Logging out is only looked at, never done.
        if d.message.startswith("Log out"):
            d.dismiss()
        else:
            d.accept()
    page.on("dialog", dialog)

    def synced():
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

    def to_devices():
        page.locator('[data-view="devices"]').click()
        page.locator("#device-list .device-row").first.wait_for()

    def to_notes():
        page.locator('[data-view="notes"]').click()

    def new_note(path, content):
        page.locator("#new-note").click()
        page.locator("#note-path").fill(path)
        page.locator("#note-content").fill(content)
        page.locator('#editor-form button[type="submit"]').click()

    try:
        # This browser makes the cloud; with Plus for a moment, a phone and a tablet join it.
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill(PASSPHRASE)
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        synced()
        vault = sql("SELECT id FROM vaults")[0][0]
        sql("INSERT INTO plans(vaultId,plusUntil) VALUES(?,?) ON CONFLICT(vaultId) DO UPDATE SET plusUntil=excluded.plusUntil", vault, int(time.time() * 1000) + 30 * DAY_MS)
        devices = {}
        to_devices()
        for name in ["Phone", "Tablet"]:
            page.locator("#pair-name").fill(name)
            page.locator('#pair-form button[type="submit"]').click()
            page.wait_for_function("() => document.querySelector('#pair-code').value.length > 100")
            devices[name] = node(CLAIM, page.locator("#pair-code").input_value())
            page.locator("#pair-code").evaluate("element => { element.value = ''; }")
        to_notes()
        new_note("notes/shopping.md", "# Shopping\n\n- [ ] milk\n- [ ] bread")
        synced()
        web = sql("SELECT id FROM devices WHERE name='Web browser'")[0][0]

        # Plus ends with three devices: the grace runs, the phone and the tablet go on, this browser goes on hold in 5 days.
        now = int(time.time() * 1000)
        sql("UPDATE plans SET plusUntil=0 WHERE vaultId=?", vault)
        sql("INSERT INTO sync_pauses(vaultId,createdAt,pauseAt,mailed) VALUES(?,?,?,1)", vault, now, now + 5 * DAY_MS)
        sql("UPDATE devices SET keepSync=CASE WHEN id=? THEN 0 ELSE 1 END WHERE vaultId=?", web, vault)
        page.locator("#sync").click()
        synced()
        notice = page.locator("#sync-hold")
        notice.filter(has_text="Your plan syncs 2 devices.").wait_for()
        text = notice.inner_text()
        assert "sync goes on hold on: this browser. Your notes stay on them." in text, text
        assert notice.get_by_role("button", name="Choose devices").is_visible()
        assert "Sync goes on hold on this browser on" in page.locator("#plan-status").inner_text()
        shot("grace")
        to_devices()
        rows = page.locator("#device-list .device-row").all_inner_texts()
        assert any(row.startswith("Phone") and "✓ Syncing" in row and "last used" in row for row in rows), rows
        assert any(row.startswith("Web browser (this device)") and "web app" in row and "On hold from" in row for row in rows), rows
        choice = page.locator("#sync-choice")
        assert choice.is_visible() and "Your plan syncs 2 devices. Choose which ones." in choice.inner_text()
        assert [box.is_checked() for box in choice.locator('input[type="checkbox"]').all()].count(True) == 2
        to_notes()
        # "Not now" hides the notice; more than 3 days before the pause it stays away.
        notice.get_by_role("button", name="Not now").click()
        assert notice.is_hidden()
        page.locator("#sync").click()
        synced()
        assert notice.is_hidden()

        # A change that could not go up yet waits in this browser when the pause starts.
        page.route("**/api/v1/objects/**", lambda route: route.abort() if route.request.method == "PUT" else route.continue_())
        new_note("notes/waiting.md", "# Waiting\n\nTyped before the pause.")
        page.locator("#sync-status").filter(has_text="Cloud unavailable").wait_for()
        sql("UPDATE sync_pauses SET pauseAt=? WHERE vaultId=?", int(time.time() * 1000) - 60000, vault)
        page.unroute("**/api/v1/objects/**")

        # On hold: one line on the board that stays, and only /status goes to the cloud.
        page.locator("#sync").click()
        page.locator("#sync-status").filter(has_text="Sync is on hold on this browser.").wait_for()
        notice.filter(has_text="Sync is on hold on this browser.").wait_for()
        text = notice.inner_text()
        assert "Your plan syncs 2 devices, and this browser is not one of them." in text and "read-only" in text, text
        for name in ["Sync here instead", "Devices", "Check again"]:
            assert notice.get_by_role("button", name=name).is_visible(), name
        assert "Sync is on hold on this browser." in page.locator("#plan-status").inner_text()
        requests.clear()
        devices_button = notice.get_by_role("button", name="Devices").element_handle()
        with page.expect_response(lambda response: response.url.endswith("/api/v1/status")):
            notice.get_by_role("button", name="Check again").click()
        page.wait_for_timeout(1000)
        called = sorted({re.sub(r"\?.*$", "", entry.split("/api/v1", 1)[1]) for entry in requests})
        assert called == ["/status"], called
        # The same line stays: not built again, so a screen reader does not read it out every round.
        assert devices_button.evaluate("element => element.isConnected")
        shot("on-hold")

        # Read-only: no ticking, no trash, and the editor says why it cannot save.
        card = page.locator(".note-card").filter(has_text="Shopping")
        assert all(box.is_disabled() for box in card.locator('input[type="checkbox"]').all())
        card.hover()
        card.get_by_role("button", name="More", exact=True).click()
        assert page.get_by_role("menu").get_by_role("menuitem", name="Move to trash").count() == 0
        page.keyboard.press("Escape")
        card.hover()
        card.get_by_role("button", name="Open note", exact=True).click()
        page.locator("#editor[open]").wait_for()
        assert "changes cannot be saved here" in page.locator("#editor-message").inner_text()
        page.locator("#note-content").fill("# Shopping\n\n- [ ] milk\n- [ ] bread\n- [ ] eggs")
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#editor-message").filter(has_text="Sync is on hold on this browser, so notes are read-only here.").wait_for()
        page.locator("#note-content").fill("# Shopping\n\n- [ ] milk\n- [ ] bread")
        page.locator("#close-editor").click()
        page.locator("#editor:not([open])").wait_for(state="attached")

        # It stops trying: the 30-second round asks nothing of the notes, groups or status.
        requests.clear()
        page.wait_for_timeout(31000)
        called = sorted({re.sub(r"\?.*$", "", entry.split("/api/v1", 1)[1]) for entry in requests})
        assert not [path for path in called if path != "/account/approvals"], called

        # Logging out is possible and says what stays on this browser (dismissed here).
        page.locator("#log-out").click()
        for _ in range(50):
            if dialogs:
                break
            page.wait_for_timeout(100)
        assert any("1 change made on this browser has not reached the cloud. It stays encrypted on this browser" in entry for entry in dialogs), dialogs
        assert page.locator("#workspace").is_visible(), "Dismissed: still signed in."

        # "Sync here instead": this browser is ticked first, the tablet makes room, and the waiting note goes up.
        notice.get_by_role("button", name="Sync here instead").click()
        choice.filter(has_text="untick the device that makes room").wait_for()
        save = choice.get_by_role("button", name="Save choice")
        assert save.is_disabled()
        choice.get_by_role("checkbox", name=re.compile("^Tablet")).uncheck()
        assert save.is_enabled()
        shot("choose")
        save.click()
        page.locator("#workspace-message").filter(has_text="Saved. The devices you chose sync from now on.").wait_for()
        choice.filter(has_text="You can change your devices again from").wait_for()
        assert all(box.is_disabled() for box in choice.locator('input[type="checkbox"]').all())
        rows = page.locator("#device-list .device-row").all_inner_texts()
        assert any(row.startswith("Tablet") and "· On hold" in row and "✓" not in row for row in rows), rows
        assert any(row.startswith("Web browser (this device)") and "✓ Syncing" in row for row in rows), rows
        to_notes()
        synced()
        assert notice.is_hidden()
        assert "✓ This browser syncs." in page.locator("#plan-status").inner_text()
        assert page.locator(".note-card").filter(has_text="Waiting").count() == 1
        assert "notes/waiting.md" in node(REACH, json.dumps(devices["Phone"]))["paths"]
        assert node(REACH, json.dumps(devices["Tablet"])) == {"status": 403, "code": "device-paused"}
        shot("syncing-again")
        assert not errors, errors
        return {"grace_notice": True, "on_hold_line": True, "only_status": True, "read_only": True, "stops_trying": True, "log_out_says_what_stays": True, "sync_here_instead": True}
    finally:
        if sys.exc_info()[0]:
            print({"sync": page.locator("#sync-status").text_content(), "message": page.locator("#workspace-message").text_content(), "hold": page.locator("#sync-hold").text_content(), "errors": errors, "dialogs": dialogs})
        context.close()


def main():
    shots = os.environ.get("JOTDROP_SHOTS_DIR")
    with tempfile.TemporaryDirectory(prefix="jotdrop-sync-pause-test-") as directory:
        with socket.socket() as candidate:
            candidate.bind(("127.0.0.1", 0))
            port = candidate.getsockname()[1]
        token = secrets.token_urlsafe(32)
        environment = dict(os.environ, JOTDROP_CLOUD_DATA_DIR=directory, JOTDROP_CLOUD_ENROLLMENT_TOKEN=token, JOTDROP_CLOUD_PORT=str(port), JOTDROP_CLOUD_SYNC_PAUSE_FROM="2020-01-01",
                           JOTDROP_CLOUD_STRIPE_SECRET_KEY="sk_test_synthetic", JOTDROP_CLOUD_STRIPE_WEBHOOK_SECRET="whsec_synthetic", JOTDROP_CLOUD_STRIPE_PRICE_MONTH="price_month", JOTDROP_CLOUD_STRIPE_PRICE_YEAR="price_year")
        process = subprocess.Popen(["node", "cloud/server.mjs"], cwd=ROOT, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            assert "JotDrop Cloud listening" in process.stdout.readline(), "Local test server did not start."
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True, channel=sys.argv[1] if len(sys.argv) > 1 else "msedge")
                use_markdown_editor(browser)
                try:
                    print(json.dumps(check_sync_pause(browser, f"http://127.0.0.1:{port}", token, Path(directory), shots)))
                finally:
                    browser.close()
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
            process.stdout.close()


if __name__ == "__main__":
    main()

"""Run: python cloud/browser_check.py [browser-channel]. Uses installed Playwright."""
from contextlib import closing
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright


def check_browser(browser, url, enrollment_token):
    password = "synthetic browser test passphrase"
    first_context = browser.new_context()
    second_context = browser.new_context()
    first = first_context.new_page()
    second = second_context.new_page()
    first.on("dialog", lambda dialog: dialog.accept())
    second.on("dialog", lambda dialog: dialog.accept())
    try:
        first.goto(url, wait_until="networkidle")
        def check_theme(page, expected):
            page.wait_for_function("expected => getComputedStyle(document.body).backgroundColor === expected", arg=expected)

        first.emulate_media(color_scheme="light")
        assert first.locator("#theme").input_value() == "system"
        check_theme(first, "rgb(248, 249, 250)")
        first.emulate_media(color_scheme="dark")
        check_theme(first, "rgb(25, 28, 33)")
        first.locator("#theme").select_option("light")
        check_theme(first, "rgb(248, 249, 250)")
        first.reload(wait_until="networkidle")
        assert first.locator("#theme").input_value() == "light"
        check_theme(first, "rgb(248, 249, 250)")
        first.locator("#theme").select_option("dark")
        first.emulate_media(color_scheme="light")
        check_theme(first, "rgb(25, 28, 33)")
        first.reload(wait_until="networkidle")
        assert first.locator("#theme").input_value() == "dark"
        check_theme(first, "rgb(25, 28, 33)")
        first.locator("#theme").select_option("system")
        check_theme(first, "rgb(248, 249, 250)")
        first.reload(wait_until="networkidle")
        assert first.locator("#theme").input_value() == "system"
        first.emulate_media(color_scheme="dark")
        check_theme(first, "rgb(25, 28, 33)")
        first.emulate_media(color_scheme="light")
        check_theme(first, "rgb(248, 249, 250)")
        blocked_context = browser.new_context()
        try:
            blocked_context.add_init_script("Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });")
            blocked = blocked_context.new_page()
            blocked.goto(url, wait_until="networkidle")
            blocked.locator("#theme").select_option("dark")
            check_theme(blocked, "rgb(25, 28, 33)")
            blocked.locator("#theme").select_option("light")
            check_theme(blocked, "rgb(248, 249, 250)")
        finally:
            blocked_context.close()
        first.locator("#show-connect").click()
        first.locator("#access-code").fill(enrollment_token)
        first.locator("#new-password").fill(password)
        first.locator("#confirm-password").fill(password)
        first.locator('#connect-form button[type="submit"]').click()
        first.locator("#recovery-dialog").wait_for()
        first.locator("#recovery-saved").check()
        first.locator("#finish-recovery").click()
        first.locator("#new-note").click()
        first.locator("#note-path").fill("notes/test.md")
        first.locator("#note-content").fill("# Browser check\n\nSynthetic private browser text.")
        first.locator('#editor-form button[type="submit"]').click()
        first.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        first.locator(".note-card").filter(has_text="Synthetic private browser text.").wait_for()
        first.locator("#new-note").click()
        first.locator("#note-path").fill("notes/test.md")
        first.locator("#note-content").fill("# Must not overwrite an existing file")
        first.locator('#editor-form button[type="submit"]').click()
        first.locator("#editor-message").filter(has_text="filename already exists").wait_for()
        first.locator("#close-editor").click()
        first.locator('[data-view="devices"]').click()
        first.locator("#pair-name").fill("Second test browser")
        first.locator("#pair-form button").click()
        first.wait_for_function("() => document.getElementById('pair-code').value.length > 20")
        code = first.locator("#pair-code").input_value()
        second.goto(url, wait_until="networkidle")
        second.locator("#show-connect").click()
        second.locator("#connect-method").select_option("pair")
        second.locator("#access-code").fill(code)
        second.locator("#new-password").fill(password)
        second.locator("#confirm-password").fill(password)
        second.locator('#connect-form button[type="submit"]').click()
        second.locator(".note-card").filter(has_text="Synthetic private browser text.").wait_for()

        first.locator('[data-view="notes"]').click()
        first.locator(".note-card").get_by_role("button", name="Open note", exact=True).click()
        first.locator("#note-content").fill("# Browser check\n\nUnsaved draft based on version one.")
        second.locator(".note-card").get_by_role("button", name="Open note", exact=True).click()
        second.locator("#note-content").fill("# Browser check\n\nSaved on second browser.")

        def busy_upload(route):
            if route.request.method == "PUT":
                route.fulfill(status=503, content_type="application/json", headers={"Retry-After": "1"}, body=json.dumps({"error": "Cloud is busy. Retry later; your local draft was not uploaded."}))
            else:
                route.continue_()

        second_context.route("**/api/v1/objects/**", busy_upload)
        second.locator('#editor-form button[type="submit"]').click()
        second.locator("#workspace-message").filter(has_text="Cloud is busy").wait_for()
        second.locator(".note-card").filter(has_text="Saved on second browser.").filter(has_text="Waiting for cloud").wait_for()
        second_context.unroute("**/api/v1/objects/**", busy_upload)

        def lose_upload_response(route):
            if route.request.method != "POST" or not route.request.url.endswith("/commit"):
                route.continue_()
                return
            assert route.fetch().status == 200
            route.abort("failed")

        second_context.route("**/api/v1/objects/**", lose_upload_response)
        second.locator("#sync").click()
        second.locator("#sync-status").filter(has_text="Cloud unavailable").wait_for()
        second.locator(".note-card").filter(has_text="Saved on second browser.").filter(has_text="Waiting for cloud").wait_for()
        assert second.evaluate("""async () => {
          const db = await new Promise(done => { const r = indexedDB.open('jotdrop-cloud-v1', 1); r.onsuccess = () => done(r.result); });
          const rows = await new Promise(done => { const r = db.transaction('values').objectStore('values').getAll(); r.onsuccess = () => done(r.result); });
          const keys = await new Promise(done => { const r = db.transaction('values').objectStore('values').getAllKeys(); r.onsuccess = () => done(r.result); });
          db.close(); return keys.filter(key => key.startsWith('pending:')).length === 1 && !JSON.stringify(rows).includes('Saved on second browser.');
        }""")
        second_context.unroute("**/api/v1/objects/**", lose_upload_response)
        second.locator("#sync").click()
        second.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        first.locator("#editor").evaluate("dialog => dialog.close()")
        first.locator("#sync").click()
        first.locator(".note-card").filter(has_text="Saved on second browser.").wait_for()
        first.locator("#editor").evaluate("dialog => dialog.showModal()")
        first.locator('#editor-form button[type="submit"]').click()
        first.locator("#editor-message").filter(has_text="changed while you were editing").wait_for()
        assert "Unsaved draft" in first.locator("#note-content").input_value()
        first.locator("#close-editor").click()
        first.locator(".note-card").get_by_role("button", name="Open note", exact=True).click()
        first.locator("#note-history").click()
        first.locator(".history-row").nth(1).wait_for()
        assert first.locator(".history-row").count() == 2

        def lose_delete_response(route):
            if route.request.method != "DELETE":
                route.continue_()
                return
            assert route.fetch().status == 200
            route.abort("failed")

        first_context.route("**/api/v1/objects/*", lose_delete_response)
        first.locator("#note-delete").click()
        first.locator("#sync-status").filter(has_text="Cloud unavailable").wait_for()
        first_context.unroute("**/api/v1/objects/*", lose_delete_response)
        first.locator("#sync").click()
        first.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        first.locator('[data-view="trash"]').click()
        first.locator(".note-card").get_by_role("button", name="Restore", exact=True).click()
        first.locator('[data-view="notes"]').click()
        first.locator(".note-card").filter(has_text="Saved on second browser.").wait_for()
        first.locator(".note-card").get_by_role("button", name="Open note", exact=True).click()
        first.locator("#note-history").click()
        first.locator(".history-row").nth(3).wait_for()
        assert first.locator(".history-row").count() == 4
        first.locator("#close-editor").click()
        assert first.evaluate("""async () => {
          const db = await new Promise(done => { const r = indexedDB.open('jotdrop-cloud-v1', 1); r.onsuccess = () => done(r.result); });
          const rows = await new Promise(done => { const r = db.transaction('values').objectStore('values').getAll(); r.onsuccess = () => done(r.result); });
          db.close(); return !JSON.stringify(rows).includes('Saved on second browser.');
        }""")
        first_context.set_offline(True)
        first.locator("#new-note").click()
        first.locator("#note-path").fill("notes/offline.md")
        first.locator("#note-content").fill("# Offline draft\n\nEncrypted queue test.")
        first.locator('#editor-form button[type="submit"]').click()
        first.locator(".note-card").filter(has_text="Offline draft").filter(has_text="Waiting for cloud").wait_for()
        first.locator("#sync-status").filter(has_text="Cloud unavailable").wait_for()
        first_context.set_offline(False)
        first.locator("#sync").click()
        first.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        first.locator('.note-card[data-revision="1"]').filter(has_text="Offline draft").wait_for()
        first.set_viewport_size({"width": 390, "height": 844})
        assert not first.evaluate("document.documentElement.scrollWidth > innerWidth")
        first.locator("#lock").click()
        first.locator("#unlock-password").fill(password)
        first.locator('#unlock-form button[type="submit"]').click()
        first.locator(".note-card").filter(has_text="Saved on second browser.").wait_for()
        first.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        first.locator("#new-note").click()
        first.locator("#note-path").fill("notes/history-limit.md")
        first.locator("#note-content").fill("# Preserved at history limit\n\nSynthetic blocked private draft.")
        first.locator('#editor-form button[type="submit"]').click()
        first.locator("#workspace-message").filter(has_text="history safety limit").wait_for()
        first.locator(".note-card").filter(has_text="Preserved at history limit").filter(has_text="Waiting for cloud").wait_for()
        first.locator("#lock").click()
        first.locator("#unlock-password").fill(password)
        first.locator('#unlock-form button[type="submit"]').click()
        first.locator("#workspace-message").filter(has_text="history safety limit").wait_for()
        first.locator(".note-card").filter(has_text="Preserved at history limit").filter(has_text="Waiting for cloud").wait_for()
        second.locator("#sync").click()
        second.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        second.locator(".note-card").filter(has_text="Saved on second browser.").get_by_role("button", name="Open note", exact=True).click()
        second.locator("#note-delete").click()
        second.locator("#workspace-message").filter(has_text="history safety limit").wait_for()
        first.locator(".note-card").filter(has_text="Saved on second browser.").get_by_role("button", name="Open note", exact=True).click()
        first.locator("#note-history").click()
        first.locator(".history-row").nth(3).wait_for()
        assert first.locator(".history-row").count() == 4
        first.locator("#close-editor").click()
        for page in [first, second]:
            assert page.evaluate("""async () => {
              const db = await new Promise(done => { const r = indexedDB.open('jotdrop-cloud-v1', 1); r.onsuccess = () => done(r.result); });
              const rows = await new Promise(done => { const r = db.transaction('values').objectStore('values').getAll(); r.onsuccess = () => done(r.result); });
              const keys = await new Promise(done => { const r = db.transaction('values').objectStore('values').getAllKeys(); r.onsuccess = () => done(r.result); });
              db.close(); return keys.filter(key => key.startsWith('pending:')).length === 1 && !JSON.stringify(rows).includes('Synthetic blocked private draft.') && !JSON.stringify(rows).includes('Saved on second browser.');
            }""")
        assert not first.evaluate("document.documentElement.scrollWidth > innerWidth")
        return {"system_light_dark_theme": True, "theme_persisted": True, "theme_without_storage": True, "paired_browsers": True, "stale_editor_protected": True, "history_trash_restore": True, "busy_upload_retried": True, "lost_upload_response_retried": True, "lost_delete_response_retried": True, "encrypted_browser_storage": True, "offline_queue_replayed": True, "history_limit_drafts_preserved": True, "history_readable_at_limit": True, "mobile_overflow": False, "unlock": True}
    finally:
        if sys.exc_info()[0]:
            for page in [first, second]:
                if page.locator("#sync-status").count():
                    print(json.dumps({"sync": page.locator("#sync-status").text_content(), "message": page.locator("#workspace-message").text_content()}))
        first_context.close()
        second_context.close()


def use_markdown_editor(browser):
    """Most checks type whole Markdown files, so open the editor in its Markdown view.
    The simple title/text view has its own check (editor_browser_check.py)."""
    new_context = browser.new_context

    def with_markdown_editor(*args, **kwargs):
        context = new_context(*args, **kwargs)
        context.add_init_script("try { localStorage.setItem('jotdrop-editor-mode', 'markdown'); } catch {}")
        return context
    browser.new_context = with_markdown_editor


def main(check=check_browser, history_limit=5, camera=False):
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="jotdrop-browser-test-") as directory:
        with socket.socket() as candidate:
            candidate.bind(("127.0.0.1", 0))
            port = candidate.getsockname()[1]
        token = secrets.token_urlsafe(32)
        environment = dict(os.environ, JOTDROP_CLOUD_DATA_DIR=directory, JOTDROP_CLOUD_ENROLLMENT_TOKEN=token, JOTDROP_CLOUD_PORT=str(port), JOTDROP_CLOUD_MAX_HISTORY_ENTRIES=str(history_limit), JOTDROP_CLOUD_MAX_DEVICE_ENTRIES="2", JOTDROP_CLOUD_MAX_PAIRING_ENTRIES="1", JOTDROP_CLOUD_MAX_CONCURRENT_REQUESTS="8")
        process = subprocess.Popen(["node", "cloud/server.mjs"], cwd=root, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            line = process.stdout.readline()
            assert "Local cloud preview" in line, "Local test server did not start."
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True, channel=sys.argv[1] if len(sys.argv) > 1 else "msedge", args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] if camera else [])
                use_markdown_editor(browser)
                try:
                    result = check(browser, f"http://127.0.0.1:{port}", token)
                    with closing(sqlite3.connect((Path(directory) / "cloud.db").as_uri() + "?mode=ro", uri=True)) as database:
                        if check is check_browser:
                            for table, count in [("revisions", 5), ("changes", 5), ("envelopes", 3), ("devices", 2), ("pairings", 1)]:
                                assert database.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == count
                        assert database.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
                        assert not database.execute("PRAGMA foreign_key_check").fetchall()
                    print(json.dumps(result))
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

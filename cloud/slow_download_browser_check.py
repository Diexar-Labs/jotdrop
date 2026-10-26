"""Run: python cloud/slow_download_browser_check.py. Local synthetic check: a 4 MiB note downloads on a slow line."""
import secrets
import sys
import time
sys.dont_write_bytecode = True
from browser_check import main


def check_slow_download(browser, url, token):
    context = browser.new_context(viewport={"width": 1280, "height": 800})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    password = "synthetic slow download passphrase"
    try:
        page.goto(url, wait_until="networkidle")
        assert page.locator("#storage-usage.checking").count() == 1
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill(password)
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        page.locator('[data-view="files"]').click()
        page.locator("#upload").set_input_files({"name": "synthetic-large.bin", "mimeType": "application/octet-stream", "buffer": secrets.token_bytes(4 * 1024 * 1024)})
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for(timeout=120000)
        # Reopen: sync starts from the beginning and downloads the large note again.
        page.evaluate("""async () => {
          const db = await new Promise(done => { const r = indexedDB.open('jotdrop-cloud-v1', 1); r.onsuccess = () => done(r.result); });
          await new Promise(done => { const t = db.transaction('values', 'readwrite'); t.objectStore('values').delete('session'); t.oncomplete = done; });
          db.close();
        }""")
        page.reload(wait_until="networkidle")
        # About 100 KB/s: the encrypted note (~5.6 MB) needs close to a minute.
        cdp = context.new_cdp_session(page)
        cdp.send("Network.enable")
        cdp.send("Network.emulateNetworkConditions", {"offline": False, "latency": 20, "downloadThroughput": 100 * 1024, "uploadThroughput": 100 * 1024})
        page.locator("#unlock-password").fill(password)
        page.locator('#unlock-form button[type="submit"]').click()
        started = time.monotonic()
        # Storage and plan show before the slow download finishes.
        page.locator("#storage-usage").filter(has_text="MiB encrypted storage").wait_for(timeout=15000)
        assert page.locator("#storage-usage.checking").count() == 0
        assert page.locator("#plan-status").inner_text().strip()
        assert "up to date" not in page.locator("#sync-status").inner_text()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for(timeout=180000)
        seconds = round(time.monotonic() - started)
        assert seconds > 35, f"Download was not slow enough to prove the fix ({seconds}s)"
        assert not errors, errors
        return {"storage_before_download": True, "large_note_over_slow_line_seconds": seconds}
    finally:
        context.close()


if __name__ == "__main__":
    main(check_slow_download, history_limit=100)

"""Run: python cloud/load_browser_check.py. Local synthetic check: a big cloud shows a spinner, a counter and early cards on a slow line, and a reopen downloads nothing it already has."""
import re
import secrets
import sys
import time
sys.dont_write_bytecode = True
from browser_check import main

NOTES, ATTACHMENTS = 200, 20


def check_load(browser, url, token):
    context = browser.new_context(viewport={"width": 1280, "height": 800})
    page = context.new_page()
    errors, reads = [], []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("request", lambda request: reads.append(request.url) if "/objects/" in request.url and request.method == "GET" else None)
    password = "synthetic load passphrase"
    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill(password)
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        uploads = [{"name": f"note-{index:03}.md", "mimeType": "text/markdown", "buffer": f"# Note {index}\n\nSynthetic text.".encode()} for index in range(NOTES)]
        uploads += [{"name": f"large-{index:02}.bin", "mimeType": "application/octet-stream", "buffer": secrets.token_bytes(1024 * 1024)} for index in range(ATTACHMENTS)]
        page.locator('[data-view="files"]').click()
        page.locator("#upload").set_input_files(uploads)
        page.wait_for_function(f"() => document.querySelector('#note-count').textContent === '{NOTES}' && document.querySelectorAll('.note-card').length === {ATTACHMENTS}", timeout=120000)
        # Every queued upload confirmed by the cloud.
        deadline = time.monotonic() + 300
        while not page.evaluate("""async () => {
          if (!/Cloud copy up to date/.test(document.querySelector('#sync-status').textContent)) return false;
          const db = await new Promise(done => { const r = indexedDB.open('jotdrop-cloud-v1', 1); r.onsuccess = () => done(r.result); });
          const keys = await new Promise(done => { const r = db.transaction('values').objectStore('values').getAllKeys(); r.onsuccess = () => done(r.result); });
          db.close();
          return !keys.some((key) => /^(pending|upload):/.test(String(key)));
        }"""):
            assert time.monotonic() < deadline, "Uploads did not finish"
            time.sleep(1)
        page.locator('[data-view="notes"]').click()
        cards = page.locator(".note-card").count()
        assert cards >= NOTES, f"Expected at least {NOTES} cards, saw {cards}"

        # A new browser: no session and no cached notes.
        page.evaluate("""async () => {
          const db = await new Promise(done => { const r = indexedDB.open('jotdrop-cloud-v1', 1); r.onsuccess = () => done(r.result); });
          await new Promise(done => {
            const t = db.transaction('values', 'readwrite'), values = t.objectStore('values');
            values.delete('session');
            values.openCursor().onsuccess = (event) => { const c = event.target.result; if (!c) return; if (String(c.key).startsWith('cache:')) c.delete(); c.continue(); };
            t.oncomplete = done;
          });
          db.close();
        }""")
        page.reload(wait_until="networkidle")
        # About 1 MB/s: the attachments (~37 MB encrypted) need more than half a minute.
        cdp = context.new_cdp_session(page)
        cdp.send("Network.enable")
        cdp.send("Network.emulateNetworkConditions", {"offline": False, "latency": 20, "downloadThroughput": 1024 * 1024, "uploadThroughput": 1024 * 1024})
        reads.clear()
        page.locator("#unlock-password").fill(password)
        page.locator('#unlock-form button[type="submit"]').click()
        started = time.monotonic()
        seen = []
        while time.monotonic() - started < 15 and not re.search(r"Loading your notes\.\.\. \d+ / \d+", seen[-1] if seen else ""):
            seen.append(page.locator("#sync-status").evaluate("node => `${node.className}|${node.textContent}`"))
            time.sleep(0.2)
        assert re.search(r"^checking\|Loading your notes\.\.\. \d+ / \d+$", seen[-1]), seen[-5:]
        page.locator(".note-card").first.wait_for(timeout=15000)
        first_card = round(time.monotonic() - started, 1)
        assert "up to date" not in page.locator("#sync-status").inner_text(), "Load finished too fast to prove early cards"
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for(timeout=300000)
        full_load = round(time.monotonic() - started)
        assert page.locator("#sync-status.checking").count() == 0
        assert page.locator(".note-card").count() == cards
        first_reads = len(reads)
        assert first_reads >= NOTES + ATTACHMENTS, f"Expected every object read once, saw {first_reads}"
        assert full_load > 20, f"Download was not slow enough to prove early cards ({full_load}s)"

        # Reopen in the same browser: cached notes are not downloaded again.
        page.evaluate("""async () => {
          const db = await new Promise(done => { const r = indexedDB.open('jotdrop-cloud-v1', 1); r.onsuccess = () => done(r.result); });
          await new Promise(done => { const t = db.transaction('values', 'readwrite'); t.objectStore('values').delete('session'); t.oncomplete = done; });
          db.close();
        }""")
        page.reload(wait_until="networkidle")
        reads.clear()
        page.locator("#unlock-password").fill(password)
        page.locator('#unlock-form button[type="submit"]').click()
        started = time.monotonic()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for(timeout=60000)
        reopen = round(time.monotonic() - started, 1)
        assert page.locator(".note-card").count() == cards
        assert not reads, f"Reopen downloaded {len(reads)} cached object(s)"
        assert not errors, errors
        return {"cards": cards, "first_card_seconds": first_card, "full_load_seconds": full_load, "objects_read": first_reads, "reopen_seconds": reopen, "reopen_reads": len(reads)}
    finally:
        context.close()


if __name__ == "__main__":
    main(check_load, history_limit=1000)

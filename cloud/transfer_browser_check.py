"""Run: python cloud/transfer_browser_check.py. Local synthetic upload/resume checks."""
import secrets
import sys
from pathlib import Path
sys.dont_write_bytecode = True
from browser_check import main


def check_transfer(browser, url, token):
    context = browser.new_context(viewport={"width": 390, "height": 844})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    password = "synthetic resumable browser passphrase"
    # Hold the next chunk before fetch, while the first real server ack remains durable.
    context.add_init_script("""(() => {
      const fetch = window.fetch;
      window.transferCheck = { hold: true, held: false, requests: [], starts: [], legacyWrites: 0 };
      window.fetch = async (url, options = {}) => {
        const state = window.transferCheck;
        if (String(url).includes('/objects/') && !String(url).includes('/uploads/') && options.method === 'PUT') state.legacyWrites++;
        if (String(url).includes('/uploads/')) {
          state.requests.push({ url: String(url), method: options.method, size: options.body?.byteLength || 0 });
          if (options.method === 'PUT' && Number(new URL(url).searchParams.get('offset')) >= 65536 && state.hold) {
            state.held = true;
            await new Promise((resolve, reject) => {
              const abort = () => reject(options.signal.reason);
              if (options.signal.aborted) abort();
              else options.signal.addEventListener('abort', abort, { once: true });
            });
          }
          const response = await fetch(url, options);
          if (options.method === 'POST' && !String(url).endsWith('/commit')) state.starts.push(await response.clone().json());
          if (String(url).endsWith('/commit') && response.ok && window.ackGate && !window.ackGate.held) window.ackGate.armed = true;
          return response;
        }
        const response = await fetch(url, options);
        if (String(url).endsWith('/api/v1/status')) state.status = await response.clone().json();
        return response;
      };
    })();""")

    def draft():
        return page.evaluate("""async () => {
          const db = await new Promise(done => { const r = indexedDB.open('jotdrop-cloud-v1', 1); r.onsuccess = () => done(r.result); });
          const rows = await new Promise(done => { const r = db.transaction('values').objectStore('values').openCursor();
            const entries = []; r.onsuccess = () => { const c = r.result; if (c) { if (String(c.key).startsWith('pending:')) entries.push(c.value); c.continue(); } else done(entries); }; });
          db.close(); return rows;
        }""")

    def unlock():
        page.locator("#unlock-password").fill(password)
        page.locator('#unlock-form button[type="submit"]').click()

    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill(password)
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        data = secrets.token_bytes(4 * 1024 * 1024)
        page.locator('[data-view="files"]').click()
        page.locator("#upload").set_input_files({"name": "synthetic-resume.bin", "mimeType": "application/octet-stream", "buffer": data})
        page.wait_for_function("() => window.transferCheck.held")
        prepared = draft()[0]["prepared"]
        assert page.get_by_role("progressbar", name="Encrypted upload").evaluate("p => p.value") == 65536
        assert "confirmed" in page.locator("#sync-status").inner_text()
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
        page.get_by_role("button", name="Pause sync", exact=True).click()
        page.locator("#sync-status").filter(has_text="Sync paused").wait_for()
        assert draft()[0]["prepared"] == prepared
        page.evaluate("window.dispatchEvent(new Event('online'))")
        assert page.get_by_role("button", name="Resume sync", exact=True).is_enabled()
        assert page.evaluate("window.transferCheck.requests.length") == 3  # start, acknowledged chunk, held chunk
        # Explicit resume and lock must use the same prepared data and stop the active request.
        page.get_by_role("button", name="Resume sync", exact=True).click()
        page.wait_for_function("() => window.transferCheck.starts.length === 2 && window.transferCheck.held")
        page.locator("#lock").click()
        page.locator("#access").wait_for()
        assert draft()[0]["prepared"] == prepared
        page.reload(wait_until="networkidle")
        page.evaluate("window.transferCheck.hold = false")
        # Lose both successful commit responses: no local acknowledgment may erase the draft.
        def lose_commit(route):
            assert route.fetch().status == 200
            route.abort("failed")
        context.route("**/api/v1/objects/**/commit", lose_commit)
        unlock()
        page.locator("#sync-status").filter(has_text="Cloud unavailable").wait_for(timeout=60000)
        assert draft()[0]["prepared"] == prepared
        assert page.evaluate("window.transferCheck.starts[0].offset") == 65536
        assert max(page.evaluate("window.transferCheck.requests.map(r => r.size)")) == 65536
        context.unroute("**/api/v1/objects/**/commit", lose_commit)
        page.reload(wait_until="networkidle")
        page.evaluate("window.transferCheck.hold = false")
        unlock()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for(timeout=60000)
        assert draft() == []
        assert page.evaluate("window.transferCheck.requests.filter(r => r.method === 'PUT').length") == 0
        page.locator('[data-view="files"]').click()
        card = page.locator(".note-card").filter(has_text="synthetic-resume.bin")
        card.filter(has_text="Cloud version 1").wait_for()
        with page.expect_download() as download:
            card.get_by_role("button", name="Download", exact=True).click()
        assert Path(download.value.path()).read_bytes() == data
        before = page.evaluate("window.transferCheck.requests.length")
        def no_capability(route):
            response = route.fetch()
            status = response.json()
            status.pop("transport")
            route.fulfill(response=response, json=status)
        context.route("**/api/v1/status", no_capability)
        page.locator("#new-note").click()
        page.locator("#note-path").fill("notes/unsupported.md")
        page.locator("#note-content").fill("# Synthetic retained encrypted draft")
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#workspace-message").filter(has_text="does not support resumable").wait_for()
        assert page.evaluate("window.transferCheck.requests.length") == before
        assert page.evaluate("window.transferCheck.legacyWrites") == 0
        assert len(draft()) == 1 and "Synthetic retained" not in str(draft())
        context.unroute("**/api/v1/status", no_capability)
        page.locator("#sync").click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        assert draft() == []
        # Editing a paused upload must keep its original snapshot until acknowledgment.
        page.locator('[data-view="notes"]').click()
        page.evaluate("Object.assign(window.transferCheck, { hold: true, held: false })")
        page.locator("#new-note").click()
        page.locator("#note-path").fill("notes/edited-during-pause.md")
        page.locator("#note-content").fill("# Paused edit\n\n" + "old bytes " * 16000)
        page.locator('#editor-form button[type="submit"]').click()
        page.wait_for_function("() => window.transferCheck.held")
        page.locator("#pause-sync").click()
        page.locator("#sync-status").filter(has_text="Sync paused").wait_for()
        paused = draft()[0]["prepared"]
        # Crash/reopen with sync unavailable, then edit while no transfer is running.
        def unavailable(route):
            route.fulfill(status=503, json={"error": "Synthetic server busy"})
        context.route("**/api/v1/status", unavailable)
        page.reload(wait_until="networkidle")
        unlock()
        page.locator("#sync-status").filter(has_text="Cloud unavailable").wait_for()
        assert draft()[0]["prepared"] == paused
        context.unroute("**/api/v1/status", unavailable)
        edited = page.locator(".note-card").filter(has_text="edited-during-pause.md")
        edited.get_by_role("button", name="Open note", exact=True).click()
        page.locator("#note-content").fill("# Newer local edit\n\nThe latest local content must also be kept.")
        page.evaluate("window.transferCheck.hold = false")
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#sync-status").filter(has_text="1 encrypted change(s) waiting").wait_for()
        page.locator("#sync").click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        edited.filter(has_text="Cloud version 2").filter(has_text="latest local content").wait_for()
        assert draft() == []
        assert page.evaluate("window.transferCheck.status.transport.reservedBytes") == 0
        # Delay real cache encryption after commit, then durably save a newer draft.
        page.evaluate("""() => {
          const gate = window.ackGate = { armed: false, held: false };
          const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
          crypto.subtle.encrypt = async (...args) => {
            if (gate.armed && !gate.held && new TextDecoder().decode(args[2]).includes('notes/edited-during-ack.md')) {
              gate.held = true;
              await new Promise(resolve => { gate.release = resolve; });
            }
            return encrypt(...args);
          };
        }""")
        original = "# Acknowledged snapshot"
        newer = "# Newer edit during acknowledgment\n\nKeep this exact local content."
        page.locator("#new-note").click()
        page.locator("#note-path").fill("notes/edited-during-ack.md")
        page.locator("#note-content").fill(original)
        page.locator('#editor-form button[type="submit"]').click()
        page.wait_for_function("() => window.ackGate.held")
        acknowledged = draft()[0]
        ack_card = page.locator(".note-card").filter(has_text="edited-during-ack.md")
        ack_card.get_by_role("button", name="Open note", exact=True).click()
        page.locator("#note-content").fill(newer)
        page.locator('#editor-form button[type="submit"]').click()
        ack_card.filter(has_text="Keep this exact local content.").wait_for()
        latest = draft()[0]
        assert latest["queueId"] != acknowledged["queueId"]
        page.evaluate("window.ackGate.release()")
        page.wait_for_function("() => !document.getElementById('sync').disabled")
        remaining = draft()
        assert len(remaining) == 1 and remaining[0]["queueId"] == latest["queueId"], "Acknowledgment must not erase a newer durable draft"
        assert remaining[0]["prepared"]["envelope"] == latest["prepared"]["envelope"]
        assert remaining[0]["prepared"]["baseRevision"] == 1
        page.reload(wait_until="networkidle")
        unlock()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        ack_card.filter(has_text="Cloud version 2").filter(has_text="Keep this exact local content.").wait_for()
        versions = page.evaluate("""async ({ password, id }) => {
          const { CloudClient } = await import('/shared/client.mjs');
          const { unsealLocal, base64ToBytes } = await import('/shared/crypto.mjs');
          const db = await new Promise(done => { const r = indexedDB.open('jotdrop-cloud-v1', 1); r.onsuccess = () => done(r.result); });
          const connection = await new Promise(done => { const r = db.transaction('values').objectStore('values').get('connection'); r.onsuccess = () => done(r.result); });
          db.close();
          const client = new CloudClient(await unsealLocal(connection, password));
          const history = await client.history(id);
          return Promise.all(history.versions.map(async version => new TextDecoder().decode(base64ToBytes((await client.read(id, version.revision)).file.content))));
        }""", {"password": password, "id": latest["prepared"]["id"]})
        assert versions == [newer, original]
        assert draft() == []
        page.set_viewport_size({"width": 1280, "height": 800})
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
        assert not errors, errors
        return {"real_4mib_roundtrip": True, "confirmed_progress": True, "pause_and_lock_stop_upload": True, "same_envelope_after_reload": True, "resumes_at_confirmed_offset": True, "lost_commit_ack_preserves_draft": True, "receipt_replay_without_upload": True, "unsupported_server_keeps_draft_no_fallback": True, "edit_after_restart_while_sync_unavailable_keeps_both_versions_no_orphan": True, "edit_during_ack_cache_survives_reload_with_both_versions": True, "mobile_desktop_overflow": False}
    finally:
        context.close()


if __name__ == "__main__":
    main(check_transfer, history_limit=100)

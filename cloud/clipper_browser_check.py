"""Run: python cloud/clipper_browser_check.py. Real popup sources, mocked Chrome API, no extension build."""
import sys
from pathlib import Path
from urllib.parse import urlparse
sys.dont_write_bytecode = True
from browser_check import main


def check_clipper(browser, url, token):
    root = Path(__file__).resolve().parent.parent
    context = browser.new_context()
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    context.add_init_script("""(() => {
      const read = () => JSON.parse(localStorage.getItem('synthetic-chrome-storage') || '{}');
      window.chrome = {
        storage: { local: {
          async get(keys) { const data = read(); return keys === null ? data : Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]])); },
          async set(value) { localStorage.setItem('synthetic-chrome-storage', JSON.stringify({ ...read(), ...value })); },
          async remove(key) { const data = read(); delete data[key]; localStorage.setItem('synthetic-chrome-storage', JSON.stringify(data)); }
        } },
        tabs: { async query() { return [{ id: 1, url: 'https://example.com', title: 'Synthetic popup' }]; }, update() { throw new Error('Cloud must not fall back to local mode'); } },
        scripting: { async executeScript() { return [{ result: { title: 'Synthetic popup', selection: 'Private synthetic selection' } }]; } },
        runtime: { id: 'synthetic-clipper', openOptionsPage() {} }
      };
      const fetch = window.fetch;
      window.holdCommit = true;
      // The step that saves the version: one PUT of the encrypted manifest (pieces, if any, went up before it).
      const saving = (url, options) => options?.method === 'PUT' && /[/]objects[/][0-9a-f]{64}$/.test(String(url));
      window.fetch = async (url, options) => {
        if (saving(url, options) && window.holdCommit) {
          await new Promise((resolve, reject) => {
            const abort = () => reject(options.signal.reason);
            if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
          });
        }
        const response = await fetch(url, options);
        if (saving(url, options) && window.loseCommitResponse) {
          await response.arrayBuffer();
          throw new TypeError('Synthetic lost commit response');
        }
        return response;
      };
    })();""")

    def source(route):
        path = urlparse(route.request.url).path
        relative = path.removeprefix("/")
        if path.startswith("/clipper/"):
            relative = "chrome-extension/" + path.removeprefix("/clipper/")
        if path.endswith("/popup.js") and not route.request.url.endswith("?test"):
            route.fulfill(status=200, content_type="text/javascript", body="")
        else:
            route.fulfill(path=str(root / relative), content_type="text/javascript" if path.endswith((".js", ".mjs")) else "text/css" if path.endswith(".css") else "text/html")

    context.route("**/clipper/**", source)
    context.route("**/cloud/shared/**", source)

    def load():
        page.goto(url + "/clipper/popup/popup.html", wait_until="networkidle")
        page.add_script_tag(url=url + "/clipper/cloud.mjs", type="module")
        page.wait_for_selector("#cloudUnlock", state="attached")
        page.add_script_tag(url=url + "/clipper/popup/popup.js?test")

    try:
        load()
        page.evaluate("""async token => {
          const { CloudClient } = await import('/cloud/shared/client.mjs');
          const { client } = await CloudClient.create({ url: location.origin, enrollmentToken: token, deviceName: 'Synthetic popup owner' });
          await JotDropCloud.connect((await client.makePairing('Synthetic popup')).pairingCode, 'synthetic clipper browser passphrase');
        }""", token)
        load()
        page.locator("#cloudUnlock").fill("synthetic clipper browser passphrase")
        page.locator("#saveBtn").click()
        page.get_by_role("progressbar", name="Encrypted upload").wait_for()
        page.locator("#status").filter(has_text="Finalizing cloud version").wait_for()
        page.get_by_role("button", name="Pause upload", exact=True).click()
        page.locator("#status").filter(has_text="Upload paused").wait_for()
        draft = page.evaluate("Object.entries(JSON.parse(localStorage.getItem('synthetic-chrome-storage'))).filter(([k]) => k.startsWith('cloudDraft:'))")
        assert len(draft) == 1 and "Private synthetic selection" not in str(draft)
        load()
        page.evaluate("window.holdCommit = false")
        page.locator("#cloudUnlock").fill("synthetic clipper browser passphrase")
        page.get_by_role("button", name="Resume saved drafts", exact=True).click()
        page.locator("#status").filter(has_text="Current page was not clipped").wait_for()
        assert page.locator("#cloudUnlock").input_value() == ""
        assert page.evaluate("Object.keys(JSON.parse(localStorage.getItem('synthetic-chrome-storage'))).filter(k => k.startsWith('cloudDraft:')).length") == 0
        restored = page.evaluate("""async () => {
          const { CloudClient } = await import('/cloud/shared/client.mjs');
          const { unsealLocal } = await import('/cloud/shared/crypto.mjs');
          const { cloudConnection } = await chrome.storage.local.get(['cloudConnection']);
          const client = new CloudClient(await unsealLocal(cloudConnection, 'synthetic clipper browser passphrase'));
          const changes = (await client.listChanges()).changes;
          return { count: changes.length, envelope: (await client.read(changes[0].id)).envelope };
        }""")
        assert restored == {"count": 1, "envelope": draft[0][1]["envelope"]}
        # Keep this popup open: an acknowledged resume must retire its capture ID.
        page.evaluate("window.loseCommitResponse = true")
        page.locator("#selection").fill("Capture with a lost acknowledgment")
        page.locator("#cloudUnlock").fill("synthetic clipper browser passphrase")
        page.locator("#saveBtn").click()
        page.locator("#status").filter(has_text="Any queued encrypted draft is kept unchanged").wait_for()
        uncertain = page.evaluate("Object.entries(JSON.parse(localStorage.getItem('synthetic-chrome-storage'))).filter(([k]) => k.startsWith('cloudDraft:'))")
        assert len(uncertain) == 1
        page.evaluate("window.loseCommitResponse = false")
        page.get_by_role("button", name="Resume saved drafts", exact=True).click()
        page.locator("#status").filter(has_text="Current page was not clipped").wait_for()
        page.locator("#selection").fill("A fresh capture after confirmed resume")
        page.locator("#cloudUnlock").fill("synthetic clipper browser passphrase")
        page.locator("#saveBtn").click()
        page.locator("#status").filter(has_text="Encrypted clip saved to cloud").wait_for()
        captures = page.evaluate("""async () => {
          const { CloudClient } = await import('/cloud/shared/client.mjs');
          const { unsealLocal } = await import('/cloud/shared/crypto.mjs');
          const { cloudConnection } = await chrome.storage.local.get(['cloudConnection']);
          const client = new CloudClient(await unsealLocal(cloudConnection, 'synthetic clipper browser passphrase'));
          const changes = (await client.listChanges()).changes;
          return { count: changes.length, ids: changes.map(c => c.id), revisions: changes.map(c => c.revision) };
        }""")
        assert captures["count"] == 3 and len(set(captures["ids"])) == 3
        assert captures["revisions"] == [1, 1, 1]
        assert page.evaluate("Object.keys(JSON.parse(localStorage.getItem('synthetic-chrome-storage'))).filter(k => k.startsWith('cloudDraft:')).length") == 0
        assert not errors, errors
        return {"popup_pause_resume_after_reopen": True, "lost_ack_same_capture": True, "new_capture_after_resume": True, "encrypted_storage": True, "unlock_cleared": True, "no_local_fallback": True}
    finally:
        context.close()


if __name__ == "__main__":
    main(check_clipper, history_limit=100)

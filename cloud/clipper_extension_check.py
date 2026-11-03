"""Run: python cloud/clipper_extension_check.py [browser-channel] [extension-zip]

End to end with the real, unpacked web clipper in Edge (or Chrome Canary/Chromium with that channel name):
the web app on a local cloud makes a pairing code, the clipper's settings page pairs with it, the popup saves
an encrypted clip, and the web app shows it as a note. Then "both" and "Obsidian" against a stand-in for the
Obsidian plugin's clip server, the CORS rule production needs, and disconnecting.

Only the active-tab lookup of the popup is pointed at the test article, because a popup opened as a tab would
otherwise clip itself; storage, permissions, page reading and every request are the browser's own.
With an extension ZIP (the store package) that is what gets loaded; otherwise chrome-extension/ as committed.
"""
from contextlib import closing
import http.server
import json
import os
import re
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import zipfile

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PASSPHRASE = "synthetic clipper e2e passphrase"
CLIP_TOKEN = secrets.token_urlsafe(24)
ARTICLE_TITLE = "Clipper e2e article"
SELECTION = "Selected words with a #hashtag that must stay text"


def shot(page, name):
    """JOTDROP_CLIPPER_SHOTS=<folder> keeps screenshots of the settings and the popup for a visual review."""
    folder = os.environ.get("JOTDROP_CLIPPER_SHOTS")
    if folder:
        Path(folder).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(Path(folder) / f"{name}.png"), full_page=True)


def free_port():
    with socket.socket() as candidate:
        candidate.bind(("127.0.0.1", 0))
        return candidate.getsockname()[1]


class FakeObsidian(http.server.BaseHTTPRequestHandler):
    """Answers like the plugin's clip server (src/clipServer.ts) and also serves the page to clip."""
    clips = []

    def log_message(self, *args):
        pass

    def reply(self, status, body, content_type="application/json"):
        data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/article.html":
            self.reply(200, f"<!doctype html><title>{ARTICLE_TITLE}</title><h1>{ARTICLE_TITLE}</h1><p id='quote'>{SELECTION}</p>", "text/html")
        elif self.path == "/ping" and self.headers.get("Authorization") == f"Bearer {CLIP_TOKEN}":
            self.reply(200, {"ok": True, "app": "jotdrop"})
        else:
            self.reply(401, {"error": "unauthorized"})

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.path != "/clip" or self.headers.get("Authorization") != f"Bearer {CLIP_TOKEN}":
            self.reply(401, {"error": "unauthorized"})
            return
        FakeObsidian.clips.append({"origin": self.headers.get("Origin"), "payload": json.loads(body)})
        self.reply(200, {"ok": True, "path": "JotDrop/clip.md"})


def start_cloud(directory, port, token, cors):
    environment = dict(os.environ, JOTDROP_CLOUD_DATA_DIR=directory, JOTDROP_CLOUD_ENROLLMENT_TOKEN=token, JOTDROP_CLOUD_PORT=str(port), JOTDROP_CLOUD_CORS_ORIGINS=cors)
    process = subprocess.Popen(["node", "cloud/server.mjs"], cwd=ROOT, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    line = process.stdout.readline()
    assert "JotDrop Cloud listening" in line, f"Local test server did not start: {line}"
    return process


def stop(process):
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)
    process.stdout.close()


def extension_id(context, channel):
    page = context.new_page()
    page.goto(("edge" if channel == "msedge" else "chrome") + "://extensions-internals")
    found = [item["id"] for item in json.loads(page.inner_text("body")) if item["name"] == "JotDrop Web Clipper"]
    page.close()
    assert len(found) == 1, found
    return found[0]


def run(channel, extension_dir, workdir):
    fake_port = free_port()
    fake = http.server.ThreadingHTTPServer(("127.0.0.1", fake_port), FakeObsidian)
    threading.Thread(target=fake.serve_forever, daemon=True).start()
    article = f"http://127.0.0.1:{fake_port}/article.html"
    servers = []
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            str(Path(workdir) / "profile"), channel=channel, headless=True,
            ignore_default_args=["--disable-extensions"],
            args=[f"--disable-extensions-except={extension_dir}", f"--load-extension={extension_dir}"])
        try:
            ext = extension_id(context, channel)
            origin = f"chrome-extension://{ext}"
            # Popup pages opened as tabs: clip the article tab, as the real popup would after a toolbar click.
            context.add_init_script("""(() => {
              if (location.protocol !== 'chrome-extension:' || !location.pathname.endsWith('/popup/popup.html')) return;
              const query = chrome.tabs.query.bind(chrome.tabs);
              chrome.tabs.query = () => query({ url: 'http://127.0.0.1/article*' });
            })();""")
            token = secrets.token_urlsafe(32)
            port, other_port = free_port(), free_port()
            data_dir, other_dir = Path(workdir) / "cloud", Path(workdir) / "cloud-without-cors"
            data_dir.mkdir()
            other_dir.mkdir()
            servers.append(start_cloud(str(data_dir), port, token, origin))
            servers.append(start_cloud(str(other_dir), other_port, token, ""))
            url = f"http://127.0.0.1:{port}"
            errors = []

            def page(address=None):
                created = context.new_page()
                created.on("pageerror", lambda error: errors.append(str(error)))
                created.on("dialog", lambda dialog: dialog.accept())
                if address:
                    created.goto(address, wait_until="networkidle")
                return created

            # The web app: a new local cloud, then a one-time pairing code for the clipper.
            web = page(url)
            web.locator("#show-connect").click()
            web.locator("#access-code").fill(token)
            web.locator("#new-password").fill(PASSPHRASE)
            web.locator("#confirm-password").fill(PASSPHRASE)
            web.locator('#connect-form button[type="submit"]').click()
            web.locator("#recovery-saved").check()
            web.locator("#finish-recovery").click()
            web.locator('[data-view="devices"]').click()
            web.locator("#pair-name").fill("Web clipper")
            web.locator("#pair-form button").click()
            web.wait_for_function("() => document.getElementById('pair-code').value.length > 20")
            code = web.locator("#pair-code").input_value()

            # The clipper's settings: Obsidian by default; choose JotDrop Cloud and pair.
            options = page(f"{origin}/options/options.html")
            manifest = options.evaluate("chrome.runtime.getManifest()")
            assert manifest["version"] == "0.2.0", manifest["version"]
            assert manifest["optional_host_permissions"] == ["https://app.jotdrop.net/*"], manifest
            assert manifest["host_permissions"] == ["http://127.0.0.1/*", "http://localhost/*"], manifest
            assert sorted(manifest["permissions"]) == ["activeTab", "scripting", "storage"], manifest
            assert options.locator("#destObsidian").is_checked()
            assert options.locator("#cloudSection").is_hidden() and options.locator("#obsidianSection").is_visible()
            options.locator("#destCloud").check()
            options.locator("#destinationStatus").filter(has_text="Connect JotDrop Cloud below").wait_for()
            assert options.locator("#obsidianSection").is_hidden()
            options.locator("#cloudState").filter(has_text="Not connected.").wait_for()
            shot(options, "1-settings-cloud-not-connected")
            options.locator("#cloudPairCode").fill(code)
            options.locator("#cloudPairPassword").fill(PASSPHRASE)
            options.locator("#cloudPairRepeat").fill(PASSPHRASE + "x")
            options.locator("#cloudConnect").click()
            options.locator("#cloudMessage").filter(has_text="not the same").wait_for()
            options.locator("#cloudPairRepeat").fill(PASSPHRASE)
            options.locator("#cloudConnect").click()
            options.locator("#cloudMessage").filter(has_text="Connected ✓").wait_for()
            options.locator("#cloudState").filter(has_text=f"Connected to 127.0.0.1:{port}.").wait_for()
            stored = options.evaluate("chrome.storage.local.get(null)")
            assert set(stored) == {"destination", "cloudConnection", "cloudServer"}, list(stored)
            assert stored["destination"] == "cloud" and set(stored["cloudConnection"]) == {"v", "salt", "iterations", "envelope"}
            assert options.evaluate("chrome.storage.sync.get(null)") == {}
            assert options.evaluate("chrome.storage.session.get(null)") == {}

            # The article, with a selection, then the popup: unlock once and keep it unlocked for this session.
            source = page(article)
            source.evaluate("getSelection().selectAllChildren(document.getElementById('quote'))")
            popup = page(f"{origin}/popup/popup.html")
            popup.locator("#status").filter(has_text="Cloud: unlock to save").wait_for()
            assert popup.locator("#destinationName").text_content() == "JotDrop Cloud (encrypted)"
            assert popup.locator("#selection").input_value() == SELECTION
            assert popup.locator("#cloudKeep").is_checked()
            popup.locator("#tags").fill("e2e")
            popup.locator("#tags").press("Enter")
            popup.locator("#saveBtn").click()
            popup.locator("#status").filter(has_text="Enter your cloud unlock passphrase").wait_for()
            shot(popup, "2-popup-cloud-locked")
            popup.locator("#cloudUnlock").fill(PASSPHRASE)
            popup.locator("#saveBtn").click()
            popup.locator("#status").filter(has_text="Encrypted clip saved to cloud").wait_for()
            session = options.evaluate("chrome.storage.session.get(null)")
            credentials = session["cloudSession"]["credentials"]
            local_after = json.dumps(options.evaluate("chrome.storage.local.get(null)"))
            assert credentials["vaultKey"] not in local_after and credentials["token"] not in local_after and SELECTION not in local_after

            # The web app shows the clip as a note card, and the note is the expected Markdown.
            web.locator('[data-view="notes"]').click()
            web.locator("#sync").click()
            card = web.locator(".note-card").filter(has_text=ARTICLE_TITLE)
            card.wait_for()
            notes = web.evaluate("""async credentials => {
              const { CloudClient } = await import('/shared/client.mjs');
              const client = new CloudClient(credentials);
              const out = [];
              for (const change of (await client.listChanges()).changes) {
                const { file } = await client.read(change.id);
                out.push({ path: file.path, text: new TextDecoder().decode(file.bytes) });
              }
              return out;
            }""", credentials)
            assert len(notes) == 1, notes
            note = notes[0]
            assert note["path"].startswith("notes/") and re.fullmatch(rf"notes/\d{{4}}-\d\d-\d\d \d{{6}} {ARTICLE_TITLE} [0-9a-f]{{4}}\.md", note["path"]) and note["path"].count("/") == 1, note["path"]
            assert note["text"].startswith('---\ntags: ["e2e"]\npinned: false\ncolor: default\n---\n'), note["text"]
            assert f"# {ARTICLE_TITLE}" in note["text"] and "> Selected words with a \\#hashtag that must stay text" in note["text"], note["text"]
            assert f"[{ARTICLE_TITLE}](<{article}>)" in note["text"], note["text"]
            assert "#e2e" in card.inner_text(), card.inner_text()

            # Both, with the Obsidian background connection: no passphrase needed while unlocked.
            options.reload(wait_until="networkidle")
            options.locator("#destBoth").check()
            options.locator("#destinationStatus").filter(has_text="JotDrop Cloud and Obsidian").wait_for()
            assert options.locator("#obsidianSection").is_visible() and options.locator("#cloudSection").is_visible()
            options.locator("#cloudState").filter(has_text="Unlocked until the browser closes.").wait_for()
            options.locator("#token").fill(CLIP_TOKEN)
            options.locator("#obsidianSection summary").click()
            options.locator("#port").fill(str(fake_port))
            options.locator("#saveTest").click()
            options.locator("#status").filter(has_text="Connection OK").wait_for()
            shot(options, "3-settings-both-connected")
            popup = page(f"{origin}/popup/popup.html")
            popup.locator("#status").filter(has_text="Ready").wait_for()
            assert popup.locator("#cloudUnlockField").is_hidden() and popup.locator("#cloudUnlocked").is_visible()
            assert popup.locator("#destinationName").text_content() == "JotDrop Cloud and Obsidian"
            shot(popup, "4-popup-both-unlocked")
            popup.locator("#saveBtn").click()
            popup.locator("#status").filter(has_text="Saved to JotDrop Cloud and Obsidian ✓").wait_for()
            assert len(FakeObsidian.clips) == 1 and FakeObsidian.clips[0]["origin"] == origin
            assert FakeObsidian.clips[0]["payload"] == {"url": article, "title": ARTICLE_TITLE, "selection": SELECTION, "tags": [], "color": "default", "pinned": False}, FakeObsidian.clips[0]

            # Obsidian only: exactly the 0.1 background route, nothing more in the cloud.
            options.locator("#destObsidian").check()
            options.locator("#destinationStatus").filter(has_text="Saved: clips go to Obsidian.").wait_for()
            assert options.locator("#cloudSection").is_hidden()
            popup = page(f"{origin}/popup/popup.html")
            popup.locator("#status").filter(has_text="Ready").wait_for()
            assert popup.locator("#cloudBox").is_hidden() and popup.locator("#destinationName").text_content() == "Obsidian"
            popup.locator("#pinned").check()
            popup.locator("#saveBtn").click()
            popup.locator("#status").filter(has_text="Saved ✓").wait_for()
            assert len(FakeObsidian.clips) == 2 and FakeObsidian.clips[1]["payload"]["pinned"] is True
            count = web.evaluate("async credentials => { const { CloudClient } = await import('/shared/client.mjs'); return (await new CloudClient(credentials).listChanges()).changes.length; }", credentials)
            assert count == 2, count

            # The clipper is a device of the cloud (it takes one of the Free plan's places).
            with closing(sqlite3.connect((data_dir / "cloud.db").as_uri() + "?mode=ro", uri=True)) as database:
                devices = database.execute("SELECT name, revoked FROM devices ORDER BY createdAt").fetchall()
            assert [name for name, _ in devices][-1] == "Web clipper" and len(devices) == 2, devices

            # A server that does not list the extension origin refuses it: production needs JOTDROP_CLOUD_CORS_ORIGINS.
            # (Chrome sends the extension origin with POST and PUT, the requests that pair and save; not with GET.)
            refused = options.evaluate("async address => { const response = await fetch(address, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claimToken: 'x' }) }); return { status: response.status, body: await response.json() }; }", f"http://127.0.0.1:{other_port}/api/v1/pairings/{'0' * 8}-0000-4000-8000-{'0' * 12}/claim")
            assert refused == {"status": 403, "body": {"error": "Origin not allowed"}}, refused

            # Disconnect while unlocked: the clipper signs itself out and its keys are gone from the browser.
            options.locator("#destCloud").check()
            options.locator("#cloudDisconnectBox summary").click()
            options.locator("#cloudDisconnect").click()
            options.locator("#destinationStatus").filter(has_text="The clipper signed itself out of your cloud.").wait_for()
            assert options.locator("#destObsidian").is_checked()
            left = options.evaluate("chrome.storage.local.get(null)")
            assert not any(key.startswith("cloud") for key in left), list(left)
            assert options.evaluate("chrome.storage.session.get(null)") == {}
            revoked = web.evaluate("async credentials => { const { CloudClient } = await import('/shared/client.mjs'); try { await new CloudClient(credentials).status(); return 'still allowed'; } catch (error) { return error.status; } }", credentials)
            assert revoked == 401, revoked
            web.locator(".note-card").filter(has_text=ARTICLE_TITLE).first.wait_for()
            assert not errors, errors
            return {"extension_loaded": ext, "paired_from_web_app": True, "clip_in_web_app": True, "markdown_and_hashtags": True, "keys_sealed_in_local_storage": True, "stay_unlocked_session_only": True, "both_destinations": True, "obsidian_background_unchanged": True, "clipper_is_a_device": True, "cors_allowlist_required": True, "disconnect_signs_out": True}
        finally:
            context.close()
            for process in servers:
                stop(process)
            fake.shutdown()


def main():
    channel = sys.argv[1] if len(sys.argv) > 1 else "msedge"
    with tempfile.TemporaryDirectory(prefix="jotdrop-clipper-e2e-") as workdir:
        extension_dir = ROOT / "chrome-extension"
        if len(sys.argv) > 2:
            extension_dir = Path(workdir) / "extension"
            with zipfile.ZipFile(sys.argv[2]) as archive:
                archive.extractall(extension_dir)
        print(json.dumps(run(channel, str(extension_dir), workdir)))


if __name__ == "__main__":
    main()

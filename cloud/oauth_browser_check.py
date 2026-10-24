"""Run: python cloud/oauth_browser_check.py. Sign in with Google or GitHub on the website, against stand-in providers."""
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.dont_write_bytecode = True
from browser_check import use_markdown_editor  # noqa: E402

# The real cloud server, with Google and GitHub replaced by a local page that signs in whoever /as names.
SERVER = r"""
import http from 'node:http';
import { createCloudServer } from './cloud/server.mjs';
import { randomToken } from './cloud/shared/crypto.mjs';
const people = {
  ann: { google: { sub: 'g-ann', email: 'ann@example.com', email_verified: true }, github: { id: 7, emails: [{ email: 'ann@example.com', primary: true, verified: true }] } },
  bob: { google: { sub: 'g-bob', email: 'bob@example.com', email_verified: false } },
};
let who = 'ann';
const provider = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/as') { who = url.searchParams.get('who'); res.end('ok'); return; }
  const back = new URL(url.searchParams.get('redirect_uri'));
  back.search = new URLSearchParams({ state: url.searchParams.get('state'), code: who }).toString();
  res.writeHead(302, { Location: back.toString() }); res.end();
}).listen(0, '127.0.0.1');
await new Promise((resolve) => provider.once('listening', resolve));
const base = `http://127.0.0.1:${provider.address().port}`;
const json = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const fetcher = async (url, init = {}) => {
  if (url.endsWith('/token')) return json({ access_token: `token-${new URLSearchParams(init.body).get('code')}` });
  const person = people[/token-(\w+)/.exec(init.headers.Authorization)[1]];
  if (url.endsWith('/userinfo')) return json(person.google);
  if (url.endsWith('/user')) return json({ id: person.github.id });
  return json(person.github.emails);
};
const app = await createCloudServer({ dataDir: process.env.DATA_DIR, serverKey: randomToken(), mailer: async (mail) => console.log(`[mail] ${mail.kind} to ${mail.to}`), fetcher,
  oauth: { google: { clientId: 'g', clientSecret: 'g', authorize: `${base}/authorize`, token: `${base}/token`, api: `${base}/userinfo` }, github: { clientId: 'h', clientSecret: 'h', authorize: `${base}/authorize`, token: `${base}/token`, api: base } } });
console.log(JSON.stringify({ url: `http://127.0.0.1:${app.port}`, provider: base }));
"""


def check(browser, url, provider):
    errors = []

    def as_person(who):
        urllib.request.urlopen(f"{provider}/as?who={who}").read()

    def open_page():
        page = browser.new_context(viewport={"width": 1100, "height": 900}).new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("dialog", lambda dialog: dialog.accept())
        page.goto(url, wait_until="networkidle")
        return page

    # First browser: no account yet. Google, then a new cloud with a recovery code.
    laptop = open_page()
    laptop.get_by_role("button", name="Continue with Google").wait_for()
    assert laptop.get_by_role("button", name="Continue with GitHub").is_visible()
    as_person("ann")
    laptop.get_by_role("button", name="Continue with Google").click()
    laptop.locator("#provider-title").filter(has_text="Create your JotDrop cloud").wait_for()
    assert "Signed in with Google as ann@example.com." in laptop.locator("#provider-text").inner_text()
    laptop.screenshot(path=str(Path(tempfile.gettempdir()) / "jotdrop-oauth-new.png"))
    laptop.get_by_role("button", name="Create my JotDrop cloud").click()
    laptop.locator("#recovery-saved").check()
    laptop.locator("#finish-recovery").click()
    laptop.locator("#workspace").wait_for()
    # Without a password nothing could unlock a locked browser: only Log out.
    assert not laptop.locator("#lock").is_visible() and laptop.locator("#log-out").is_visible()
    laptop.locator("#new-note").click()
    laptop.locator("#note-content").fill("Shopping from the laptop")
    laptop.locator('#editor-form button[type="submit"]').click()
    laptop.locator("#items").filter(has_text="Shopping from the laptop").wait_for()
    laptop.get_by_role("button", name="Devices & recovery").click()
    laptop.locator("#no-password-note").wait_for()
    assert not laptop.locator("#password-form").is_visible() and not laptop.locator("#new-recovery-form").is_visible()
    assert "You can also sign in with Google." in laptop.locator("#account-status").inner_text()

    # Second browser: GitHub with the same address opens the same account after approval with the four words.
    phone = open_page()
    phone.get_by_role("button", name="Continue with GitHub").click()
    phone.locator("#provider-title").filter(has_text="Open your notes on this browser").wait_for()
    phone.get_by_role("button", name="Approve on a signed-in device").click()
    phone.locator("#approval-words").wait_for()
    words = phone.locator("#approval-words").inner_text().split()
    request = laptop.locator("#approval-requests .device-row")
    for _ in range(3):
        laptop.get_by_role("button", name="Devices & recovery").click()
        if request.count():
            break
        laptop.wait_for_timeout(1000)
    assert all(word in request.inner_text() for word in words), "Both screens show the same four words"
    request.get_by_role("button", name="Approve").click()
    phone.locator("#items").filter(has_text="Shopping from the laptop").wait_for(timeout=20000)

    # A provider without a verified address: a clear message, no account.
    stranger = open_page()
    as_person("bob")
    stranger.get_by_role("button", name="Continue with Google").click()
    stranger.locator("#access-message").filter(has_text="no verified email").wait_for()

    # The laptop stays signed in after a reload.
    laptop.reload(wait_until="networkidle")
    laptop.locator("#items").filter(has_text="Shopping from the laptop").wait_for()
    assert not errors, errors
    return "PASS: Google and GitHub sign-in, approval with four words, unverified address refused, stays signed in"


def main():
    root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="jotdrop-oauth-browser-") as directory:
        process = subprocess.Popen(["node", "--input-type=module", "-e", SERVER], cwd=root, env=dict(os.environ, DATA_DIR=directory), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            started = json.loads(process.stdout.readline())
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True, channel=sys.argv[1] if len(sys.argv) > 1 else "msedge")
                use_markdown_editor(browser)
                try:
                    print(check(browser, started["url"], started["provider"]))
                finally:
                    browser.close()
        finally:
            process.terminate()
            process.wait(timeout=10)
            process.stdout.close()


if __name__ == "__main__":
    main()

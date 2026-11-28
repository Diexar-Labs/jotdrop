"""Run: python cloud/page_session_browser_check.py [browser]. Issue #80 (Hand-off/ontwerp-afmelden-bij-sluiten-80.md, part 8):
"Sign me out when I close this page" survives a reload and ends when the page is closed. The page keeps a sealed packet in
its tab; the server keeps the packet's key and decides with its own clock. The server's clock cannot be moved from here,
so the check moves the deadline in the server's database instead, as the node tests do with their clock."""
import hashlib
import json
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
import time
from contextlib import closing
from pathlib import Path

from playwright.sync_api import sync_playwright

PASSWORD = "synthetic page session passphrase"
PACKET = "jotdrop-page-session"
ENDED = "You were signed out because the page was closed."
# From the first frame of the page: is the login screen on screen before the notes?
WATCH = """() => {
  window.seen = [];
  const loop = () => {
    const shown = (id) => { const element = document.getElementById(id); return Boolean(element && element.offsetParent); };
    window.seen.push([shown('access'), shown('opening'), shown('workspace')]);
    if (!shown('workspace') || window.seen.length < 5) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}"""


def check_page_session(browser, url, codes, database):
    errors = []

    def sql(statement, *args):
        with closing(sqlite3.connect(database, timeout=5)) as db:
            rows = db.execute(statement, args).fetchall()
            db.commit()
            return rows

    def code(kind):
        while True:
            got, value = codes.get(timeout=30)
            if got == kind:
                return value

    def new_page(context, packet=None):
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        if packet is not None:
            # A tab that kept the packet: as after reopening a closed tab, or a browser that restores its tabs.
            page.add_init_script(f"try {{ if (location.protocol === 'http:') sessionStorage.setItem({json.dumps(PACKET)}, {json.dumps(packet)}); }} catch {{}}")
        page.goto(url, wait_until="networkidle")
        return page

    def sign_up(page, email, stay):
        page.get_by_role("button", name="Create an account").click()
        page.locator("#signup-email").fill(email)
        page.locator("#signup-password").fill(PASSWORD)
        page.locator("#signup-confirm").fill(PASSWORD)
        page.locator("#signup-remember" if stay else "#signup-forget").check()
        page.locator('#signup-form button[type="submit"]').click()
        page.locator("#code-input").fill(code("verify"))
        page.locator('#code-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        page.locator("#secure-later").click()
        page.locator("#workspace").wait_for()

    def log_in(page, email, stay):
        page.locator("#login-email").fill(email)
        page.locator("#login-password").fill(PASSWORD)
        page.locator("#login-remember" if stay else "#login-forget").check()
        page.locator('#login-form button[type="submit"]').click()
        page.locator("#code-input").fill(code("login"))
        page.locator('#code-form button[type="submit"]').click()
        page.locator("#workspace").wait_for()

    packet_of = lambda page: page.evaluate(f"sessionStorage.getItem({json.dumps(PACKET)})")
    active = lambda: sql("SELECT COUNT(*) FROM devices WHERE revoked=0")[0][0]
    revoked = lambda device: sql("SELECT revoked FROM devices WHERE id=?", device)[0][0] == 1
    now_ms = lambda: int(time.time() * 1000)
    result = {}

    # 8. The choice stays required, without a preselection, with the new words.
    context = browser.new_context(viewport={"width": 1100, "height": 900})
    page = new_page(context)
    assert not page.locator("#login-remember").is_checked() and not page.locator("#login-forget").is_checked()
    assert page.locator("label", has=page.locator("#login-forget")).inner_text().strip() == "Sign me out when I close this page"
    result["choice_required"] = True

    # 1. Signed up without "Stay signed in": a reload opens the notes without the login screen, as the same device.
    sign_up(page, "owner@example.com", stay=False)
    raw = packet_of(page)
    packet = json.loads(raw)
    device = packet["deviceId"]
    assert set(packet) == {"deviceId", "resumeToken", "envelope"}, packet.keys()
    token_hash = sql("SELECT tokenHash FROM devices WHERE id=?", device)[0][0]
    pieces = re.findall(r"[A-Za-z0-9_-]{43}", raw)
    assert "vaultKey" not in raw and all(hashlib.sha256(piece.encode()).hexdigest() != token_hash for piece in pieces), "the device token is readable in sessionStorage"
    before = active()
    page.add_init_script(f"({WATCH})()")
    page.reload()
    page.locator("#workspace").wait_for()
    page.wait_for_timeout(300)
    seen = page.evaluate("window.seen")
    assert not any(access for access, _, _ in seen), f"login screen shown before the notes in {sum(a for a, _, _ in seen)} of {len(seen)} frames"
    assert json.loads(packet_of(page))["deviceId"] == device and active() == before and not revoked(device)
    result["reload_keeps_device"] = True

    # 2. The page closed, a new tab opened: the login screen.
    page.close()
    other = new_page(context)
    other.locator("#login-form").wait_for()
    assert other.locator("#workspace").is_hidden()
    other.close()
    result["new_tab_logs_in"] = True

    # 4. The packet in a new page within the time (a closed tab reopened quickly): the same device again.
    back = new_page(context, raw)
    back.locator("#workspace").wait_for()
    assert json.loads(packet_of(back))["deviceId"] == device and not revoked(device)
    back.close()
    result["back_within_time"] = True

    # 3. The same after the deadline (the server's clock three minutes on): the login screen says why, the device is gone.
    # The goodbye is a keepalive request: give the server a moment, and keep what it saw in the meantime.
    seen_deadlines, until = [], time.time() + 5
    while time.time() < until:
        seen_deadlines.append(sql("SELECT deadline FROM page_sessions WHERE deviceId=?", device)[0][0])
        if seen_deadlines[-1] and len(seen_deadlines) > 10:
            break
        time.sleep(0.1)
    deadline = seen_deadlines[-1]
    # Playwright's own Firefox sends no request at all when it closes the signed-in app's page, not even this goodbye
    # (Hand-off/werk-issue-80/proef-s0/LEESMIJ.md); then the server has the case "no goodbye", which step 3 covers too.
    if browser.browser_type.name == "firefox" and deadline is None:
        result["firefox_close_goodbye"] = "not sent by Playwright's Firefox"
    else:
        assert deadline and now_ms() < deadline <= now_ms() + 2 * 60 * 1000 + 5000, [value and value - now_ms() for value in seen_deadlines]
    sql("UPDATE page_sessions SET deadline=? WHERE deviceId=?", now_ms() - 60 * 1000, device)
    late = new_page(context, raw)
    late.locator("#access-message").filter(has_text=ENDED).wait_for()
    assert late.locator("#workspace").is_hidden() and late.evaluate(f"sessionStorage.getItem({json.dumps(PACKET)})") is None
    assert revoked(device)
    late.close()
    context.close()
    result["too_late_signs_out"] = True

    # Two tabs: A is a page session, B then stays signed in. A's reload must not take over B's remembered browser.
    context = browser.new_context(viewport={"width": 1100, "height": 900})
    a = new_page(context)
    log_in(a, "owner@example.com", stay=False)
    a_device = json.loads(packet_of(a))["deviceId"]
    b = new_page(context)
    log_in(b, "owner@example.com", stay=True)
    a.reload()
    a.locator("#workspace").wait_for()
    # 5. Log out in session mode: the packet and the device go; the remembered browser of tab B stays.
    a.once("dialog", lambda dialog: dialog.accept())
    a.get_by_role("button", name="Log out", exact=True).click()
    # Tab B made this browser a remembered one, and A leaves that alone: A offers to unlock it.
    a.locator("#unlock-form").wait_for()
    assert packet_of(a) is None
    deadline = time.time() + 5
    while not revoked(a_device) and time.time() < deadline:
        time.sleep(0.1)
    assert revoked(a_device), "Log out did not sign the page session out"
    b.reload()
    b.locator("#workspace").wait_for()
    # With A's device in its place, B would open and then fail to sync with a token that was just revoked.
    b.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for(timeout=15000)
    assert b.locator("#access").is_hidden(), "tab B lost its remembered browser"
    result["other_tab_stays_remembered"] = True

    # 5. Lock in session mode: signs out too.
    a.locator("#use-another").click()
    log_in(a, "owner@example.com", stay=False)
    a_device = json.loads(packet_of(a))["deviceId"]
    a.get_by_role("button", name="Lock workspace", exact=True).click()
    a.locator("#access").wait_for()
    assert packet_of(a) is None
    deadline = time.time() + 5
    while not revoked(a_device) and time.time() < deadline:
        time.sleep(0.1)
    assert revoked(a_device), "Lock did not sign the page session out"
    result["lock_and_log_out_sign_out"] = True

    # 6. To the payment page: the goodbye says "away" and is the page's last request; the deadline is 30 minutes away.
    log_in(a, "owner@example.com", stay=False)
    a_device = json.loads(packet_of(a))["deviceId"]
    sent = []
    a.on("request", lambda request: sent.append((request.method, request.url.split("/api/v1")[-1], request.post_data)) if "/api/v1/" in request.url else None)
    # Another site, as Stripe is: that is where WebKit sends no goodbye of its own (proef S0).
    payment = "https://pay.example.test/check"
    a.route("**/api/v1/account/checkout", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"url": payment})))
    context.route(f"{payment}*", lambda route: route.fulfill(status=200, content_type="text/html", body="<p>payment page</p>"))
    with a.expect_navigation(url=payment):
        a.evaluate("document.getElementById('buy-month').click()")
    a.wait_for_timeout(500)
    deadline = sql("SELECT deadline FROM page_sessions WHERE deviceId=?", a_device)[0][0]
    assert deadline and deadline > now_ms() + 25 * 60 * 1000, deadline
    leaves = [body for method, path, body in sent if path == "/devices/session/leave"]
    assert leaves and all(json.loads(body) == {"away": True} for body in leaves), leaves
    # The goodbye comes after the checkout; a request still on its way just after it does not take it back (deadline above).
    after_checkout = [path for _, path, _ in sent[[path for _, path, _ in sent].index("/account/checkout") + 1:]]
    assert "/devices/session/leave" in after_checkout and "/changes" not in " ".join(after_checkout[after_checkout.index("/devices/session/leave"):]), after_checkout
    context.close()
    result["payment_goodbye_away"] = True

    # 7. The server refuses the page session: signing in works, and the page works as before (memory only).
    context = browser.new_context(viewport={"width": 1100, "height": 900})
    c = new_page(context)
    c.route("**/api/v1/devices/session", lambda route: route.fulfill(status=500, content_type="application/json", body='{"error":"no"}') if route.request.method == "PUT" else route.continue_())
    log_in(c, "owner@example.com", stay=False)
    assert packet_of(c) is None
    c.reload()
    c.locator("#login-form").wait_for()
    context.close()
    result["refused_session_falls_back"] = True

    assert not errors, errors
    return result


def main():
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="jotdrop-page-session-test-") as directory:
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
                choice = sys.argv[1] if len(sys.argv) > 1 else "msedge"
                browser = getattr(playwright, choice).launch(headless=True) if choice in ("firefox", "webkit") else playwright.chromium.launch(headless=True, channel=choice)
                try:
                    print(json.dumps(check_page_session(browser, f"http://127.0.0.1:{port}", codes, str(Path(directory) / "cloud.db"))))
                finally:
                    browser.close()
        finally:
            process.terminate()
            process.wait(timeout=10)
            process.stdout.close()


if __name__ == "__main__":
    main()

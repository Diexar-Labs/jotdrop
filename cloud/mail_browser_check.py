"""Run: python cloud/mail_browser_check.py. Synthetic end-to-end check of Mail to JotDrop: turning it on
(and what someone without Plus sees), the secret address, a real SMTP mail with attachment becoming a note,
the item leaving the server only after upload, rotating the address, and the strict sender filter."""
import os
import queue
import re
import secrets
import smtplib
import socket
import subprocess
import sys
import tempfile
import threading
from email.message import EmailMessage
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.dont_write_bytecode = True

EMAIL = "mail@example.com"
PASSWORD = "synthetic mail passphrase"
DOMAIN = "in.test.jotdrop.net"


def send_mail(port, sender, to, subject, text, attachment=None):
    message = EmailMessage()
    message["From"] = f"Anna Voss <{sender}>"
    message["To"] = to
    message["Subject"] = subject
    message["Date"] = "Mon, 2 Nov 2026 21:14:55 +0100"
    message.set_content(text)
    if attachment:
        message.add_attachment(attachment, maintype="application", subtype="pdf", filename="bon.pdf")
    with smtplib.SMTP("127.0.0.1", port, timeout=30) as smtp:
        smtp.send_message(message, from_addr=sender, to_addrs=[to])


def check_mail(browser, url, smtp_port, codes, shots):
    def code(kind):
        while True:
            entry = codes.get(timeout=30)
            if entry[0] == kind:
                return entry[1]

    errors = []
    context = browser.new_context(viewport={"width": 1280, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url, wait_until="networkidle")
    page.get_by_role("button", name="Create an account").click()
    page.locator("#signup-email").fill(EMAIL)
    page.locator("#signup-password").fill(PASSWORD)
    page.locator("#signup-confirm").fill(PASSWORD)
    page.locator('#signup-form button[type="submit"]').click()
    page.locator("#code-input").fill(code("verify"))
    page.locator('#code-form button[type="submit"]').click()
    page.locator("#recovery-saved").check()
    page.locator("#finish-recovery").click()
    page.locator("#secure-later").click()
    page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

    # 1. The section sits under Devices & recovery; without Plus the button explains instead of enabling.
    page.locator('button[data-view="devices"]').click()
    section = page.locator("#mail-section")
    section.wait_for()
    assert "seals every incoming mail" in section.inner_text()

    def refuse_without_plus(route):
        if route.request.method == "POST":
            route.fulfill(status=402, json={"error": "Mail to JotDrop is part of JotDrop Plus.", "code": "plus-required"})
        else:
            route.fallback()
    page.route("**/api/v1/mail", refuse_without_plus)
    page.locator("#mail-enable").click()
    page.locator("#mail-message").filter(has_text="part of JotDrop Plus").wait_for()
    page.unroute("**/api/v1/mail")
    if shots:
        page.screenshot(path=str(Path(shots) / "mail-1-without-plus.png"))

    # 2. Turning it on shows a secret address, and the copy button copies it.
    page.locator("#mail-enable").click()
    address_box = page.locator("#mail-address")
    address_box.wait_for(state="visible")
    page.wait_for_function(f"/^[a-km-np-z2-9]{{12}}@{DOMAIN.replace('.', '[.]')}$/.test(document.getElementById('mail-address').value)")
    address = address_box.input_value()
    page.locator("#mail-copy").click()
    page.locator("#mail-message").filter(has_text="Address copied.").wait_for()
    assert page.evaluate("navigator.clipboard.readText()") == address
    if shots:
        page.screenshot(path=str(Path(shots) / "mail-2-address.png"))

    # 3. A real SMTP mail with a PDF becomes a note with the attachment, and the sealed item leaves the server.
    send_mail(smtp_port, "anna.voss@gmail.com", address, "Bon van de lamp", "De bon zit erbij.", b"%PDF-1.4 synthetic receipt")
    page.locator("#sync").click()
    page.locator("#workspace-message").filter(has_text="1 email was saved as a note.").wait_for()
    page.locator('button[data-view="notes"]').click()
    card = page.locator("#items .note-card", has_text="Bon van de lamp")
    card.first.wait_for()
    assert "De bon zit erbij." in card.first.inner_text()
    if shots:
        page.screenshot(path=str(Path(shots) / "mail-3-note.png"))
    card.first.click()
    page.locator("#markdown-mode").click()
    content = page.locator("#note-content").input_value()
    assert "From Anna Voss <anna.voss@gmail.com>" in content
    assert re.search(r"!\[\[mail-[0-9a-f]{6}-1 bon\.pdf\]\]", content), content
    assert content.rstrip().endswith("#mail"), content
    page.locator("#close-editor").click()
    page.locator('button[data-view="files"]').click()
    page.locator("#items .note-card", has_text="bon.pdf").first.wait_for()
    page.locator('button[data-view="devices"]').click()
    page.locator("#sync").click()
    page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
    page.locator("#sync").click()
    page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
    assert page.locator("#mail-pending").inner_text() == "", "The sealed item is deleted once the note is confirmed."

    # 4. A new address turns the old one off at once.
    page.once("dialog", lambda dialog: dialog.accept())
    page.locator("#mail-rotate").click()
    page.locator("#mail-message").filter(has_text="This is your new address.").wait_for()
    rotated = address_box.input_value()
    assert rotated != address
    try:
        send_mail(smtp_port, "anna.voss@gmail.com", address, "Oud adres", "Mag niet aankomen.")
        raise AssertionError("The old address must refuse mail.")
    except smtplib.SMTPRecipientsRefused:
        pass

    # 5. The strict stand is a sender filter: listed senders come through, strangers stop at RCPT.
    page.locator("#mail-strict").check()
    page.locator("#mail-senders-row").wait_for(state="visible")
    page.locator("#mail-senders").fill("Mother@Example.test")
    page.locator("#mail-senders-save").click()
    page.locator("#mail-message").filter(has_text="Sender list saved: 1 address.").wait_for()
    try:
        send_mail(smtp_port, "stranger@example.test", rotated, "Vreemde", "Stopt bij RCPT.")
        raise AssertionError("A sender outside the list must be refused.")
    except smtplib.SMTPRecipientsRefused:
        pass
    send_mail(smtp_port, "mother@example.test", rotated, "Van mama", "Dag lieverd.")
    page.locator("#sync").click()
    page.locator("#workspace-message").filter(has_text="1 email was saved as a note.").wait_for()
    if shots:
        page.screenshot(path=str(Path(shots) / "mail-4-strict.png"))

    assert not errors, errors
    return {"withoutPlus": True, "address": True, "noteWithAttachment": True, "itemDeleted": True, "rotate": True, "strictSenders": True}


def main():
    root = Path(__file__).resolve().parent.parent
    shots = os.environ.get("JOTDROP_SHOTS_DIR")
    mailin_token = secrets.token_urlsafe(32)
    with tempfile.TemporaryDirectory(prefix="jotdrop-mail-test-") as directory:
        with socket.socket() as candidate:
            candidate.bind(("127.0.0.1", 0))
            port = candidate.getsockname()[1]
        environment = dict(os.environ, JOTDROP_CLOUD_DATA_DIR=directory, JOTDROP_CLOUD_PORT=str(port), JOTDROP_CLOUD_SERVER_KEY=secrets.token_urlsafe(32),
                           JOTDROP_CLOUD_MAIL_DOMAIN=DOMAIN, JOTDROP_CLOUD_MAILIN_TOKEN=mailin_token)
        process = subprocess.Popen(["node", "cloud/server.mjs"], cwd=root, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        mailin = None
        codes = queue.Queue()

        def read_mail():
            for line in process.stdout:
                match = re.match(r"\[mail\] (\w+) to \S+: (\d{6})", line)
                if match:
                    codes.put((match.group(1), match.group(2)))

        try:
            assert "JotDrop Cloud listening" in process.stdout.readline(), "Local test server did not start."
            threading.Thread(target=read_mail, daemon=True).start()
            mailin_env = dict(os.environ, JOTDROP_MAILIN_HOSTNAME=DOMAIN, JOTDROP_MAILIN_API=f"http://127.0.0.1:{port}",
                              JOTDROP_MAILIN_TOKEN=mailin_token, JOTDROP_MAILIN_PORT="0")
            mailin = subprocess.Popen(["node", "cloud/mailin.mjs"], cwd=root, env=mailin_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            started = mailin.stdout.readline()
            smtp_port = int(re.search(r"listening on port (\d+)", started).group(1))
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True, channel=sys.argv[1] if len(sys.argv) > 1 else "msedge")
                try:
                    print(check_mail(browser, f"http://127.0.0.1:{port}", smtp_port, codes, shots))
                finally:
                    browser.close()
        finally:
            if mailin:
                mailin.terminate()
                mailin.wait(timeout=10)
                mailin.stdout.close()
            process.terminate()
            process.wait(timeout=10)
            process.stdout.close()


if __name__ == "__main__":
    main()

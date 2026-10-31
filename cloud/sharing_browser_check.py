"""Run: python cloud/sharing_browser_check.py. Shared groups in the web app, with three real accounts in separate browsers."""
import base64
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
from contextlib import closing
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

PASSWORD = "synthetic sharing passphrase"
HOSTILE = '<img src=x onerror="window.__xss=1"> <script>window.__xss=1</script> [click](javascript:window.__xss=1) ![pic](javascript:window.__xss=1)'


def check_sharing(browser, url, codes, directory):
    def code(kind):
        while True:
            entry = codes.get(timeout=30)
            if entry[0] == kind:
                return entry[1]

    errors = []
    own_vault = {}

    def open_page(address=url):
        context = browser.new_context(viewport={"width": 1280, "height": 900})
        context.grant_permissions(["clipboard-read", "clipboard-write"], origin=url)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("dialog", lambda dialog: dialog.accept())
        # Asking which groups there are always goes with the account's own cloud.
        page.on("request", lambda request: own_vault.__setitem__(page, request.headers.get("x-jotdrop-vault")) if request.url.endswith("/api/v1/spaces") and request.method == "GET" else None)
        page.goto(address, wait_until="networkidle")
        return page

    def sign_up(page, email):
        page.get_by_role("button", name="Create an account").click()
        page.locator("#signup-email").fill(email)
        page.locator("#signup-password").fill(PASSWORD)
        page.locator("#signup-confirm").fill(PASSWORD)
        page.locator("#signup-remember").check()
        page.locator('#signup-form button[type="submit"]').click()
        page.locator("#code-input").fill(code("verify"))
        page.locator('#code-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        page.locator("#secure-later").click()

    def new_note(page, title, body):
        page.locator("#new-note").click()
        page.locator("#note-title").fill(title)
        page.locator("#note-body").fill(body)
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#editor").wait_for(state="hidden")

    def card(page, text):
        return page.locator(".note-card").filter(has_text=text)

    def menu(page, text, item):
        target = card(page, text).first
        target.hover()
        target.get_by_role("button", name="More").click()
        page.get_by_role("menuitem", name=item).click()

    def synced(page):
        page.locator("#sync").click()
        page.locator("#sync-status").filter(has_text=re.compile("up to date|read-only")).wait_for()

    def group_row(page, name):
        return page.locator("#space-list button").filter(has_text=name)

    def invite_link(page):
        people(page).get_by_role("button", name="Invite someone").click()
        return take_link(page)

    def take_link(page):
        dialog = page.locator("#invite-dialog")
        dialog.wait_for()
        link = page.locator("#invite-link").input_value()
        assert re.fullmatch(re.escape(url) + r"/join#v1\.[0-9a-f-]{36}\.[\w-]{43}\.[\w-]{43}", link), link
        assert page.locator("#invite-mail").get_attribute("href").startswith("mailto:?")
        page.locator("#invite-copy").click()
        page.locator("#invite-message").filter(has_text="Link copied").wait_for()
        assert page.evaluate("navigator.clipboard.readText()") == link
        page.locator("#invite-close").click()
        dialog.wait_for(state="hidden")
        return link

    def join(page, name):
        page.locator("#join-dialog").wait_for()
        page.locator("#join-name").fill(name)
        page.locator("#join-accept").click()
        page.locator("#join-dialog").wait_for(state="hidden")
        page.locator("#space-panel").wait_for()

    def people(page):
        if not page.locator("#space-panel details").evaluate("(element) => element.open"):
            page.locator("#space-panel summary").click()
        return page.locator("#space-panel details")

    # --- Sharing a note. Eric has a pinned note with a label and a reminder; those stay behind.
    eric = open_page()
    sign_up(eric, "eric@example.com")
    new_note(eric, "Groceries", "- [ ] milk\n- [ ] bread\n- [ ] eggs")
    card(eric, "Groceries").wait_for()
    synced(eric)
    menu(eric, "Groceries", "Share…")
    eric.locator("#share-dialog").wait_for()
    assert eric.locator("#share-name").input_value() == "Groceries"
    eric.locator("#share-name").fill("Family lists")
    eric.locator("#share-me").fill("Eric")
    eric.locator('#share-form button[type="submit"]').click()
    link = take_link(eric)
    assert "#" not in eric.url and "join" not in eric.url
    assert eric.locator("#view-title").inner_text() == "Family lists"
    assert "Only you so far" in eric.locator("#view-description").inner_text()
    card(eric, "Groceries").wait_for()
    assert not eric.locator("#time-machine").is_visible() and not eric.locator("#import-label").is_visible()
    # Per person in a group: no pin or labels on the card, and not in the editor either.
    target = card(eric, "Groceries")
    target.hover()
    assert target.get_by_role("button", name="Pin").count() == 0 and target.get_by_role("button", name="Labels").count() == 0
    assert "Only you so far" in target.locator(".card-shared").inner_text()
    target.get_by_role("button", name="Open note").click()
    assert not eric.locator("#note-pinned").is_visible() and not eric.locator("#label-input").is_visible() and not eric.locator("#note-reminder").is_visible()
    eric.locator("#editor").evaluate("(dialog) => dialog.close()")
    # Out of his own notes, in the trash there.
    eric.get_by_role("button", name=re.compile("^Notes")).first.click()
    eric.locator("#view-title").filter(has_text="Notes").wait_for()
    assert card(eric, "Groceries").count() == 0
    assert eric.locator("#import-label").is_visible()
    group_row(eric, "Family lists").click()
    card(eric, "Groceries").wait_for()

    # --- Accepting. A stranger's link preview only opens the page: nothing is claimed until the button.
    ana = open_page(link)
    assert "/join" not in ana.url and "#" not in ana.url, ana.url
    assert "join the shared group" in ana.locator("#access-message").inner_text()
    sign_up(ana, "ana@example.com")
    join(ana, "Ana")
    card(ana, "Groceries").wait_for()
    assert "Shared with Eric" in ana.locator("#view-description").inner_text()
    assert ana.evaluate("sessionStorage.getItem('jotdrop-invitation')") is None
    # A used link says so, for anyone.
    carl = open_page(link)
    sign_up(carl, "carl@example.com")
    carl.locator("#join-dialog").wait_for()
    carl.locator("#join-name").fill("Carl")
    carl.locator("#join-accept").click()
    carl.locator("#join-message").filter(has_text="already used").wait_for()
    carl.locator("#join-later").click()
    assert carl.locator("#sidebar-spaces").is_hidden()
    # Emails only for the owner; only the owner removes and invites.
    eric.reload(wait_until="networkidle")
    group_row(eric, "Family lists").click()
    expect(people(eric)).to_contain_text("ana@example.com")
    expect(people(ana)).not_to_contain_text("eric@example.com")
    assert people(ana).get_by_role("button", name="Remove").count() == 0
    assert people(ana).get_by_role("button", name="Invite someone").count() == 0

    # --- Both tick a different line without having seen the other: one note with both.
    ana.get_by_role("checkbox", name="milk").check()
    ana.locator("#sync-status").filter(has_text="up to date").wait_for()
    assert not eric.get_by_role("checkbox", name="milk").is_checked()
    eric.get_by_role("checkbox", name="bread").check()
    eric.get_by_role("checkbox", name="milk").and_(eric.locator(":checked")).wait_for()
    eric.locator("#sync-status").filter(has_text="up to date").wait_for()
    assert card(eric, "Groceries").locator(".message").count() == 0
    synced(ana)
    ana.get_by_role("checkbox", name="bread").and_(ana.locator(":checked")).wait_for()
    assert ana.get_by_role("checkbox", name="milk").is_checked() and not ana.get_by_role("checkbox", name="eggs").is_checked()
    assert eric.locator("#resolve-now").is_hidden()

    # --- A tick placed while a merge is running stays: the merge never overwrites the newer draft.
    synced(eric)
    synced(ana)
    ana.get_by_role("checkbox", name="eggs").check()
    ana.locator("#sync-status").filter(has_text="up to date").wait_for()
    release = []

    def slow_base(route):
        release.append(route)

    eric.route(re.compile(r"/api/v1/objects/[0-9a-f]{64}\?revision="), slow_base)
    eric.get_by_role("checkbox", name="milk").uncheck()
    while not release:
        eric.wait_for_timeout(50)
    # The other box, while the merge waits for the version both last shared.
    eric.get_by_role("checkbox", name="bread").uncheck()
    for route in release:
        route.continue_()
    eric.unroute(re.compile(r"/api/v1/objects/[0-9a-f]{64}\?revision="))
    eric.get_by_role("checkbox", name="eggs").and_(eric.locator(":checked")).wait_for()
    eric.locator("#sync-status").filter(has_text="up to date").wait_for()
    synced(eric)
    assert not eric.get_by_role("checkbox", name="milk").is_checked() and not eric.get_by_role("checkbox", name="bread").is_checked(), "Both ticks after the merge began are still there"
    synced(ana)
    ana.get_by_role("checkbox", name="milk").and_(ana.locator(":not(:checked)")).wait_for()
    assert not ana.get_by_role("checkbox", name="bread").is_checked() and ana.get_by_role("checkbox", name="eggs").is_checked()

    # --- The free plan shares one note; the app says so.
    ana.locator("#new-note").click()
    ana.locator("#note-title").fill("Second")
    ana.locator("#note-body").fill("Second note")
    ana.locator('#editor-form button[type="submit"]').click()
    ana.locator("#editor-message").filter(has_text="free plan").wait_for()
    ana.locator("#editor").evaluate("(dialog) => dialog.close()")

    # --- What a member writes is untrusted on the other screen.
    menu_target = card(ana, "Groceries")
    menu_target.hover()
    menu_target.get_by_role("button", name="Open note").click()
    ana.locator("#note-body").fill(f"- [ ] milk\n{HOSTILE}\nhttps://example.com/x\n")
    ana.locator('#editor-form button[type="submit"]').click()
    ana.locator("#editor").wait_for(state="hidden")
    ana.locator("#sync-status").filter(has_text="up to date").wait_for()
    # An SVG can hold a script, so it never shows inline.
    ana.locator("#space-panel").get_by_role("button", name="Files", exact=True).click()
    ana.locator("#upload").set_input_files({"name": "bad.svg", "mimeType": "image/svg+xml", "buffer": b'<svg xmlns="http://www.w3.org/2000/svg"><script>window.__xss=1</script></svg>'})
    card(ana, "bad.svg").wait_for()
    ana.locator("#sync-status").filter(has_text="up to date").wait_for()
    synced(eric)
    card(eric, "click").wait_for()
    assert eric.evaluate("window.__xss") is None
    assert eric.locator('#items img[src="x"]').count() == 0 and eric.locator('#items a[href^="javascript"]').count() == 0 and eric.locator("#items script").count() == 0
    assert card(eric, "click").locator("a.link-chip").get_attribute("href") == "https://example.com/x"
    eric.locator("#space-panel").get_by_role("button", name="Files", exact=True).click()
    card(eric, "bad.svg").wait_for()
    assert eric.locator("#items svg script").count() == 0 and card(eric, "bad.svg").locator("img").count() == 0
    assert eric.evaluate("window.__xss") is None
    eric.locator("#space-panel").get_by_role("button", name="Notes", exact=True).click()

    # --- A third person, then removing one: new key, the other gets a new link, unsent work is safe.
    link_carl = invite_link(eric)
    carl.goto(link_carl, wait_until="networkidle")
    join(carl, "Carl")
    card(carl, "click").wait_for()
    synced(eric)
    carl.context.set_offline(True)
    carl.get_by_role("checkbox", name="milk").check()
    eric.reload(wait_until="networkidle")
    group_row(eric, "Family lists").click()
    row = people(eric).locator(".space-person").filter(has_text="Ana")
    row.get_by_role("button", name="Remove").click()
    eric.locator("#workspace-message").filter(has_text="Send the others a new link: Carl").wait_for()
    eric.locator("#view-title").filter(has_text="Family lists").wait_for()
    card(eric, "click").wait_for()
    assert "Only you so far" in eric.locator("#view-description").inner_text()
    # Ana is out at once and keeps her copy if she wants.
    ana.reload(wait_until="networkidle")
    group_row(ana, "Family lists").filter(has_text="no access").click()
    ana.locator("#gone-keep").click()
    ana.locator("#gone-dialog").wait_for(state="hidden")
    card(ana, "click").wait_for()
    assert ana.locator("#sidebar-spaces").is_hidden()
    # Carl comes back online in a read-only group: his tick is not lost and goes nowhere by itself.
    carl.context.set_offline(False)
    carl.reload(wait_until="networkidle")
    group_row(carl, "Family lists").filter(has_text="read-only").click()
    carl.locator("#space-panel .space-notice").filter(has_text="new link").wait_for()
    carl.locator("#workspace-message").filter(has_text="Not sent").wait_for()
    assert carl.get_by_role("checkbox", name="milk").first.is_disabled()
    new_link = invite_link(eric)
    carl.goto(new_link, wait_until="networkidle")
    join(carl, "Carl")
    assert carl.locator("#space-panel .space-notice").count() == 0
    card(carl, "click").wait_for()
    carl.get_by_role("button", name=re.compile("^Notes")).first.click()
    carl.locator("#view-title").filter(has_text="Notes").wait_for()
    card(carl, "milk").first.wait_for()
    assert carl.get_by_role("checkbox", name="milk").first.is_checked(), "The rescued copy holds the tick that could not be sent"
    group_row(carl, "Family lists").filter(has_not_text="read-only").click()
    carl.locator("#space-panel .space-notice").wait_for(state="detached")

    # --- A member moves the note to their own notes; it leaves the group for everyone.
    menu(carl, "click", "Move to my notes")
    carl.locator("#workspace-message").filter(has_text="Moved to your own notes").wait_for()
    card(carl, "click").wait_for(state="hidden")
    synced(eric)
    card(eric, "click").wait_for(state="hidden")

    # --- Leaving: nothing is removed without asking.
    people(carl).get_by_role("button", name="Leave group").click()
    carl.locator("#gone-dialog").wait_for()
    carl.locator("#gone-remove").click()
    carl.locator("#gone-dialog").wait_for(state="hidden")
    assert group_row(carl, "Family lists").filter(has_text="no access").count() == 0

    # --- The owner deletes the group.
    people(eric).get_by_role("button", name="Delete group").click()
    eric.locator("#workspace-message").filter(has_text="The group is deleted").wait_for()
    assert eric.locator("#view-title").inner_text() == "Notes"

    # --- A note with a photo: the photo goes along, and comes back. Only two people, so removing one needs no new group.
    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==")
    eric.locator("#upload").set_input_files({"name": "photo.png", "mimeType": "image/png", "buffer": png})
    eric.locator("#sync-status").filter(has_text="up to date").wait_for()
    new_note(eric, "Trip", "Packing\n\n![](../attachments/photo.png)")
    card(eric, "Trip").locator("img").wait_for()
    eric.locator("#sync-status").filter(has_text="up to date").wait_for()
    menu(eric, "Trip", "Share…")
    eric.locator("#share-name").fill("Holiday")
    eric.locator("#share-me").fill("Eric")
    eric.locator('#share-form button[type="submit"]').click()
    link = take_link(eric)
    card(eric, "Trip").locator("img").wait_for()
    eric.get_by_role("button", name="Files", exact=True).first.click()
    eric.locator("#view-title").filter(has_text="Files").wait_for()
    assert card(eric, "photo.png").count() == 0, "Used by no other note, so it moved along"
    group_row(eric, "Holiday").click()
    ana.goto(link, wait_until="networkidle")
    join(ana, "Ana")
    card(ana, "Trip").locator("img").wait_for()
    # --- The same line two ways: nothing is lost, and it says so.
    for page, text in [(ana, "Packing for two"), (eric, "Packing for three")]:
        target = card(page, "Trip")
        target.hover()
        target.get_by_role("button", name="Open note").click()
        page.locator("#note-body").fill(f"{text}\n\n![](../attachments/photo.png)")
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#editor").wait_for(state="hidden")
        page.locator("#sync-status").filter(has_text=re.compile("up to date|changed in two places")).wait_for()
    card(eric, "Packing for three").get_by_role("button", name="Resolve now").wait_for()
    with eric.expect_download():
        card(eric, "Packing for three").get_by_role("button", name="Resolve now").click()
    card(eric, "Packing for two").wait_for()
    assert eric.locator("#resolve-now").is_hidden()
    # His change cannot reach the cloud when he removes her: it comes back as a note of his own.
    block = re.compile(r"/api/v1/objects/[0-9a-f]{64}$")
    eric.route(block, lambda route: route.abort() if route.request.method == "PUT" and route.request.headers.get("x-jotdrop-vault") != own_vault[eric] else route.continue_())
    target = card(eric, "Packing for two")
    target.hover()
    target.get_by_role("button", name="Open note").click()
    eric.locator("#note-body").fill("Packing unsent\n\n![](../attachments/photo.png)")
    eric.locator('#editor-form button[type="submit"]').click()
    eric.locator("#editor").wait_for(state="hidden")
    card(eric, "Packing unsent").wait_for()
    people(eric).locator(".space-person").filter(has_text="Ana").get_by_role("button", name="Remove").click()
    eric.locator("#workspace-message").filter(has_text="back in your own notes").wait_for()
    eric.unroute(block)
    card(eric, "Packing unsent").wait_for()
    assert eric.locator("#view-title").inner_text() == "Notes"
    card(eric, "Packing for two").locator("img").wait_for()
    assert eric.locator("#sidebar-spaces").is_hidden()

    # --- The owner leaves: read-only for the others, the longest member can take over, and it is theirs.
    menu(eric, "Packing for two", "Share…")
    eric.locator("#share-name").fill("Passed on")
    eric.locator("#share-me").fill("Eric")
    eric.locator('#share-form button[type="submit"]').click()
    link = take_link(eric)
    ana.goto(link, wait_until="networkidle")
    join(ana, "Ana")
    people(eric).get_by_role("button", name="Leave group").click()
    eric.locator("#gone-dialog").wait_for()
    eric.locator("#gone-later").click()
    ana.reload(wait_until="networkidle")
    group_row(ana, "Passed on").filter(has_text="read-only").click()
    ana.get_by_role("button", name="Take over this group").click()
    ana.locator("#workspace-message").filter(has_text="yours now").wait_for()
    ana.locator("#space-panel .space-notice").wait_for(state="detached")
    expect(people(ana)).to_contain_text("(owner)")
    assert people(ana).get_by_role("button", name="Invite someone").count() == 1

    # --- Eric's browser still has the copy, under "no access", until he decides.
    group_row(eric, "Passed on").filter(has_text="no access").click()
    eric.locator("#gone-remove").click()
    eric.locator("#gone-dialog").wait_for(state="hidden")

    # --- A copy that an older app put in the own cloud shows nowhere, and can be cleared.
    eric.locator("#new-note").click()
    eric.locator("#markdown-mode").click()
    eric.locator("#note-path").fill("notes/Shared/3f2a1c9e-8b7d-4e6f-a5c4-1d2e3f4a5b6c/Left behind.md")
    eric.locator("#note-content").fill("Left behind")
    eric.locator('#editor-form button[type="submit"]').click()
    eric.locator("#editor").wait_for(state="hidden")
    eric.locator("#sync-status").filter(has_text="up to date").wait_for()
    assert card(eric, "Left behind").count() == 0
    eric.locator('[data-view="devices"]').click()
    eric.locator("#old-shared-copies").filter(has_text="1 old copy").wait_for()
    eric.get_by_role("button", name="Remove old copies").click()
    eric.locator("#old-shared-copies").wait_for(state="hidden")

    assert not errors, errors
    with closing(sqlite3.connect((Path(directory) / "cloud.db").as_uri() + "?mode=ro", uri=True)) as database:
        assert database.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert not database.execute("PRAGMA foreign_key_check").fetchall()
    stored = b"".join(path.read_bytes() for path in Path(directory).glob("cloud.db*"))
    for word in [b"Family lists", b"Groceries", b"milk", b"bread", b"Carl", b"onerror"]:
        assert word not in stored, word
    return {"share": True, "join": True, "usedLink": True, "emailsOnlyOwner": True, "linesMerged": True, "freeOneNote": True, "hostileContentInert": True, "removeWithNewKey": True, "unsentRescued": True, "goneKeepsCopy": True, "leave": True, "deleteGroup": True, "photoGoesAlong": True, "sameLineKeepsBoth": True, "backToOwnNotes": True, "takeOver": True, "oldCopiesCleared": True}


def main():
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="jotdrop-sharing-test-") as directory:
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
                browser = playwright.chromium.launch(headless=True, channel=sys.argv[1] if len(sys.argv) > 1 else "msedge")
                try:
                    print(check_sharing(browser, f"http://127.0.0.1:{port}", codes, directory))
                finally:
                    browser.close()
        finally:
            process.terminate()
            process.wait(timeout=10)
            process.stdout.close()


if __name__ == "__main__":
    main()

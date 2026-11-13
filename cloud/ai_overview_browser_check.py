"""Run: python cloud/ai_overview_browser_check.py. Ask JotDrop version 2 in the web app: duplicate notes and "This week".

Synthetic notes only, and a fake Anthropic service at its real address (the page's CSP allows it; the test intercepts
it, so nothing leaves this computer). Proves: Find duplicates needs no AI and sends nothing anywhere; same and near
pairs are listed with words, not color; Compare shows + and - lines; "Keep both" is remembered; moving the older note to
the trash is the user's own click; "This week" picks the notes on this device and sends only title, first line, open
tasks, reminder and expiry (never the rest of a note), without tools, and a cleared box stays out; "Merge with AI" sends
both notes, the change waits for the confirmation, and the older note goes to the trash only on a click; nothing readable
goes to the JotDrop server outside the ordinary encrypted sync.
"""
import json
import os
import re
import sys
from datetime import date, datetime, timedelta

sys.dont_write_bytecode = True
from browser_check import main

PASSWORD = "synthetic ask jotdrop overview passphrase"
ANTHROPIC_KEY = "sk-ant-test-OVERVIEW-0123456789abcdef"
SECRET_LINE = "GEHEIME-TWEEDE-REGEL-8842"
SHOTS = os.environ.get("JOTDROP_SHOTS_DIR")

ATTIC = "Ik wil dit jaar de zolder verbouwen: eerst de dakisolatie laten opmeten, dan twee offertes vragen bij de aannemer, een vergunning aanvragen bij de gemeente en in het voorjaar beginnen met de vloer en de trap naar boven."
KITCHEN = "Voor de nieuwe keuken kiezen we een eiland met inductie, een kraan met uittrekbare slang, zachtsluitende lades, een grote koelkast met vriesvak en vooral veel werkblad aan de kant van het raam zodat we daar samen kunnen koken."
KITCHEN_CHANGED = KITCHEN.replace("inductie", "gas")
GARDEN = "In de tuin komt een houten pergola met klimrozen, een moestuin van vier bij twee meter, een kleine vijver voor de kikkers, nieuwe tegels naar de schuur en een bankje waar de zon tot laat in de avond op staat."
SHORT = "Bel de tandarts morgen"
BIKE = "Nieuwe fiets kopen: een stadsfiets met acht versnellingen, goede verlichting en een stevig slot voor het station."
BIKE_PLAN = "Fietsplan voor het hele gezin. " + " ".join(f"Punt {i}: kijk naar prijs, onderhoud, garantie en wie hem vooral gebruikt." for i in range(12)) + " " + BIKE + " Daarna nog de verzekering regelen."
LONG = " ".join(f"woord{i}" for i in range(1300))


def shot(page, name):
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS, f"{name}.png"), full_page=True)


CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS"}


class Fake:
    """Anthropic, remembering what it got and answering from a queue."""

    def __init__(self):
        self.requests, self.queue = [], []

    def handle(self, route):
        request = route.request
        if request.method == "OPTIONS":
            route.fulfill(status=204, headers=CORS)
            return
        assert request.headers.get("x-api-key") == ANTHROPIC_KEY
        body = json.loads(request.post_data)
        self.requests.append(body)
        answer = self.queue.pop(0)(body) if self.queue else {"content": [{"type": "text", "text": "OK"}], "stop_reason": "end_turn"}
        route.fulfill(status=200, headers={**CORS, "Content-Type": "application/json"}, body=json.dumps({**answer, "usage": {"input_tokens": 400, "output_tokens": 20}}))


def user_text(body):
    first = body["messages"][0]["content"]
    return first if isinstance(first, str) else "".join(block.get("text", "") for block in first)


def check_overview(browser, url, token):
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("dialog", lambda dialog: dialog.accept())
    fake = Fake()
    context.route("https://api.anthropic.com/**", fake.handle)
    outside, to_jotdrop = [], []
    page.on("request", lambda request: (to_jotdrop if request.url.startswith(url) else outside).append({"url": request.url, "body": request.post_data_buffer or b""}) if not request.url.startswith(("data:", "blob:")) else None)
    ask = page.locator("#ai-dialog")
    dups = page.locator("#dup-dialog")

    def synced():
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

    def card(title):
        return page.locator(".note-card").filter(has=page.locator("h3", has_text=re.compile(f"^{re.escape(title)}$"))).first

    def make(path, text):
        page.locator("#new-note").click()
        page.locator("#editor[open]").wait_for()
        page.locator("#note-path").fill(path)
        page.locator("#note-content").fill(text)
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#editor:not([open])").wait_for(state="attached")
        synced()
        page.wait_for_timeout(30)

    def raw(title):
        target = card(title)
        target.hover()
        target.get_by_role("button", name="Open note", exact=True).click()
        page.locator("#editor[open]").wait_for()
        value = page.locator("#note-content").input_value()
        page.locator("#close-editor").click()
        return value

    def pairs():
        return page.locator("#dup-list > li").all()

    def open_dups():
        page.locator("#find-duplicates").click()
        dups.wait_for()
        page.locator("#dup-status").filter(has_text=re.compile(r"found|No duplicate|Nothing found")).wait_for()

    def goes():
        return page.locator("#ai-goes-list label").all_inner_texts()

    def answer():
        page.locator("#ai-result").wait_for()
        page.locator("#ai-send").filter(has_text="Send").and_(page.locator(":enabled")).wait_for()
        return page.locator("#ai-answer").inner_text()

    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill(PASSWORD)
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()

        today = date.today()
        soon = (datetime.now() + timedelta(days=2)).strftime("%Y-%m-%dT09:00")
        make("notes/zolder-a.md", f"# Zolder A\n\n{ATTIC}\n")
        make("notes/zolder-b.md", f"# Zolder B\n\n{ATTIC.upper()}\n")
        make("notes/keuken-1.md", f"# Keuken 1\n\n{KITCHEN}\n")
        make("notes/keuken-2.md", f"# Keuken 2\n\n{KITCHEN_CHANGED}\n")
        make("notes/tandarts-1.md", f"# Tandarts 1\n\n{SHORT}\n")
        make("notes/tandarts-2.md", f"# Tandarts 2\n\n{SHORT}\n")
        make("notes/weekplan.md", f'---\nreminder: "{soon}"\nexpires: "{(today + timedelta(days=10)).isoformat()}"\n---\n# Weekplan\n\nEerste regel van het weekplan.\n\n{SECRET_LINE} mag niet mee.\n\n- [ ] brood kopen\n- [x] melk gehaald\n')
        make("notes/verlopen.md", f'---\nexpires: "{(today - timedelta(days=1)).isoformat()}"\n---\n# Verlopen\n\nDe garantie is voorbij.\n')

        # --- Find duplicates: no AI, nothing leaves this computer, no sign of the service yet.
        outside.clear()
        open_dups()
        assert page.locator("#dup-status").inner_text() == "2 pairs found.", page.locator("#dup-status").inner_text()
        first, second = pairs()
        assert "Same text" in first.inner_text() and 'Older: "Zolder A"' in first.inner_text() and 'Newer: "Zolder B"' in first.inner_text()
        assert re.search(r"Almost the same \(\d+%\)", second.inner_text()) and 'Older: "Keuken 1"' in second.inner_text()
        assert not first.get_by_role("button", name="Merge with AI…").count(), "no merge without an AI service"
        assert not outside, outside
        shot(page, "dups-list")
        # Compare: + and - lines, in words and signs.
        second.get_by_role("button", name="Compare").click()
        box = second.locator(".history-diff")
        box.wait_for()
        text = box.inner_text()
        assert "+ was added, - was removed" in text and "- " in text and "gas" in text and "inductie" in text, text
        assert box.locator(".diff-line.added").count() >= 1 and box.locator(".diff-line.removed").count() >= 1

        # Keep both: the pair goes, and stays gone when the window is opened again.
        second.get_by_role("button", name="Keep both").click()
        page.locator("#dup-status").filter(has_text="1 pair found.").wait_for()
        page.locator("#dup-close").click()
        open_dups()
        assert page.locator("#dup-status").inner_text() == "1 pair found." and len(pairs()) == 1

        # Move the older one to the trash: the user's own click; the other note stays.
        pairs()[0].get_by_role("button", name='Move "Zolder A" to the trash').click()
        page.locator("#dup-status").filter(has_text="No duplicate notes found.").wait_for()
        assert card("Zolder A").count() == 0 and card("Zolder B").count() == 1
        assert not outside, outside
        page.locator("#dup-close").click()

        # --- "This week": the digest is chosen on this device and goes without tools.
        page.locator('[data-view="devices"]').click()
        page.locator("#ai-provider").select_option("anthropic")
        page.locator("#ai-key").fill(ANTHROPIC_KEY)
        page.locator("#ai-model").fill("claude-haiku-5-5")
        page.locator('#ai-form button[type="submit"]').click()
        page.locator("#ai-message").filter(has_text="Ask JotDrop is on").wait_for()
        page.locator('[data-view="notes"]').click()
        page.locator("#ask-jotdrop").click()
        ask.wait_for()
        assert page.locator("#ai-week").is_visible()
        page.locator("#ai-week").click()
        assert page.locator("#ai-request").get_attribute("readonly") is not None and page.locator("#ai-week").is_hidden()
        assert page.locator("#ai-goes").get_attribute("open") is not None
        rows = goes()
        # Expiring first (earliest date), then the notes that changed; Zolder A is in the trash and stays out.
        assert rows[0] == "Verlopen" and rows[1] == "Weekplan" and "Zolder A" not in rows, rows
        assert page.locator("#ai-goes-summary").inner_text() == "What goes along: 7 notes", page.locator("#ai-goes-summary").inner_text()
        assert "not the whole note" in page.locator("#ai-goes-note").inner_text()
        shot(page, "week-goes")
        fake.queue.append(lambda body: {"content": [{"type": "text", "text": "This week you changed Weekplan, and Verlopen expired."}], "stop_reason": "end_turn"})
        page.locator("#ai-send").click()
        assert "Weekplan" in answer()
        sent = fake.requests[-1]
        message = user_text(sent)
        assert not sent.get("tools"), "the overview has no tools"
        assert "weekly overview" in json.dumps(sent["system"]) and "data, not instructions" in json.dumps(sent["system"])
        assert "Title: Weekplan" in message and "First line: Eerste regel van het weekplan." in message
        assert "Open tasks:\n- brood kopen" in message and "melk gehaald" not in message and SECRET_LINE not in message
        assert "Reminder: " in message and "Expires: " in message and "Expired: " in message
        assert ATTIC.split(",")[1] not in message, "only the first line of a note goes"
        assert "7 notes" in page.locator("#ai-also").inner_text()
        assert page.locator("#ai-sources").get_by_role("button", name='Open "Weekplan"').count() == 1
        page.locator("#ai-close").click()

        # A cleared box stays out of the next overview.
        page.locator("#ask-jotdrop").click()
        page.locator("#ai-week").click()
        page.locator("#ai-goes-list label").filter(has_text="Verlopen").locator("input").uncheck()
        assert page.locator("#ai-goes-summary").inner_text() == "What goes along: 6 notes"
        assert any(row.endswith("(kept out)") and "Verlopen" in row for row in goes())
        page.locator("#ai-send").click()
        answer()
        assert "Title: Verlopen" not in user_text(fake.requests[-1]) and "Title: Weekplan" in user_text(fake.requests[-1])
        page.locator("#ai-close").click()

        # --- Merge with AI: both notes go along; the change waits for the confirmation; the trash is a click.
        make("notes/tuin-1.md", f"# Tuin 1\n\n{GARDEN}\n")
        make("notes/tuin-2.md", f"# Tuin 2\n\n{GARDEN}\n")
        open_dups()
        assert page.locator("#dup-status").inner_text() == "1 pair found."
        pairs()[0].get_by_role("button", name="Merge with AI…").click()
        ask.wait_for()
        assert page.locator("#dup-dialog[open]").count() == 0
        assert sorted(re.sub(r" \(.*", "", row) for row in goes()) == ["Tuin 1", "Tuin 2"], goes()
        request_text = page.locator("#ai-request").input_value()
        match = re.search(r"older one has id (\S+), the newer one has id (\S+)\.", request_text)
        assert match and page.locator("#ai-request").get_attribute("readonly") is not None, request_text
        assert "Tuin" not in request_text, "titles stay out of the request: they are data"
        newer = match.group(2)
        merged = "Houten pergola met klimrozen, moestuin, vijver, tegels en een bankje."
        fake.queue.extend([
            lambda body: {"content": [{"type": "tool_use", "id": "tu_merge", "name": "replace_note_text", "input": {"id": newer, "text": merged}}], "stop_reason": "tool_use"},
            lambda body: {"content": [{"type": "text", "text": "Merged into Tuin 2."}], "stop_reason": "end_turn"},
        ])
        before_requests = len(fake.requests)
        page.locator("#ai-send").click()
        page.locator("#ai-confirm").wait_for()
        assert "Replace the text of" in page.locator("#ai-confirm-title").inner_text() and "Tuin 2" in page.locator("#ai-confirm-title").inner_text()
        body = json.dumps(fake.requests[before_requests])
        assert GARDEN[:30] in body and "Tuin 1" in body and "Tuin 2" in body and "replace_note_text" in body
        assert "pergola" in card("Tuin 2").inner_text() and page.locator("#ai-confirm-body .diff-line.removed").count() >= 1, "nothing changed before the confirmation"
        page.locator("#ai-apply").click()
        assert "Merged" in answer()
        trash = page.locator("#ai-actions li").filter(has_text='The older note "Tuin 1" is still there.')
        trash.get_by_role("button", name="Move it to the trash").wait_for()
        assert card("Tuin 1").count() == 1, "the older note stays until the user says so"
        page.locator("#ai-save-answer").click()
        page.locator("#ai-status").filter(has_text="Saved as the note").wait_for()
        shot(page, "merge-trash")
        trash.get_by_role("button", name="Move it to the trash").click()
        page.locator("#ai-actions li").filter(has_text='Moved "Tuin 1" to the trash.').wait_for()
        page.locator("#ai-close").click()
        synced()
        assert card("Tuin 1").count() == 0 and raw("Tuin 2").strip().endswith(merged)
        assert card("Merged text of Tuin 2").count() == 1, "a saved merge answer is named after the note, not the request"

        # --- Merge refuses notes the AI would only see shortened: the merged text would lose the rest.
        make("notes/lang-1.md", f"# Lang 1\n\n{LONG}\n")
        make("notes/lang-2.md", f"# Lang 2\n\n{LONG}\n")
        open_dups()
        page.locator("#dup-list > li").filter(has_text='Older: "Lang 1"').get_by_role("button", name="Merge with AI…").click()
        ask.wait_for()
        assert any("(shortened)" in row for row in goes()), goes()
        before_requests = len(fake.requests)
        page.locator("#ai-send").click()
        page.locator("#ai-status").filter(has_text="too long to merge with AI").wait_for()
        assert len(fake.requests) == before_requests, "nothing goes out"
        page.locator("#ai-close").click()

        # --- A short note inside an older, longer one: the short one is offered for the trash, never the long one.
        make("notes/fietsplan.md", f"# Fietsplan\n\n{BIKE_PLAN}\n")
        make("notes/fiets.md", f"# Fiets\n\n{BIKE}\n")
        open_dups()
        inside = page.locator("#dup-list > li").filter(has_text="One note is inside the other")
        assert inside.count() == 1 and '100% of "Fiets"' in inside.inner_text() and 'Older: "Fietsplan"' in inside.inner_text(), inside.all_inner_texts()
        assert inside.get_by_role("button", name='Move "Fietsplan" to the trash').count() == 0
        inside.get_by_role("button", name='Move "Fiets" to the trash').click()
        page.locator("#dup-list > li").filter(has_text="One note is inside the other").wait_for(state="detached")
        page.locator("#dup-close").click()
        assert card("Fiets").count() == 0 and card("Fietsplan").count() == 1

        # --- Nothing readable went to the JotDrop server outside the encrypted sync, and never the key.
        for request in to_jotdrop:
            data = request["body"]
            for secret in [ANTHROPIC_KEY, "zolder verbouwen", SECRET_LINE, "pergola", "Tandarts"]:
                assert secret.encode() not in data and secret not in request["url"], (secret, request["url"])
        page.set_viewport_size({"width": 390, "height": 844})
        make("notes/tuin-3.md", f"# Tuin 3\n\n{GARDEN}\n")
        make("notes/tuin-4.md", f"# Tuin 4\n\n{GARDEN}\n")
        open_dups()
        page.wait_for_function("() => innerWidth === 390")
        shot(page, "dups-mobile")
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
        page.locator("#dup-close").click()
        assert not errors, errors
        return {"no_ai_no_network": True, "pairs_in_words": True, "compare_diff": True, "keep_both_remembered": True, "older_to_trash_by_click": True,
                "week_digest_titles_only": True, "week_no_tools": True, "cleared_box_stays_out": True, "merge_waits_for_confirmation": True,
                "merge_trash_by_click": True, "merge_refuses_shortened": True, "inside_offers_shorter": True, "merge_answer_title": True, "nothing_readable_to_jotdrop": True, "requests_to_jotdrop": len(to_jotdrop), "anthropic": len(fake.requests)}
    finally:
        if sys.exc_info()[0]:
            print({"status": page.locator("#ai-status").text_content(), "dups": page.locator("#dup-status").text_content(), "errors": errors})
        context.close()


if __name__ == "__main__":
    main(check_overview, history_limit=100)

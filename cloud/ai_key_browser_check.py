"""Run: python cloud/ai_key_browser_check.py. Ask JotDrop, "Use this key on all my devices" (JotDrop Plus), in the web app.

Two browsers on one account, fake keys only, and a fake Anthropic service at its real address (the page's CSP allows
it; the test intercepts it, so nothing leaves this computer). Proves: the switch needs a saved key and JotDrop Plus;
the other browser gets "Use it here?" and works with the key after one tap; a new key, turning the switch off and
"remove on all my devices" work through; when Plus ends nothing is taken away; an older server (a plain 404), a
server error and a blob that does not open leave the key in the browser alone; and the JotDrop server never gets
the key in a form it can read: not in a request, not in its database.
"""
import json
import os
import re
import sqlite3
import sys
import time
from contextlib import closing

sys.dont_write_bytecode = True
from browser_check import main

PASSWORD = "synthetic ask jotdrop key sync passphrase"
KEYS = [f"sk-ant-test-NOT-A-REAL-KEY-{n}-0123456789abcdef" for n in range(1, 7)]
OPENAI_KEY = "sk-test-openai-NOT-A-REAL-KEY-0123456789"
SHOTS = os.environ.get("JOTDROP_SHOTS_DIR")
TRIAL = "Try JotDrop Plus free for 14 days"
CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS"}


def shot(page, name):
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS, f"{name}.png"), full_page=True)


class Fake:
    """Anthropic: remembers the key of every request and answers OK."""

    def __init__(self):
        self.keys = []

    def handle(self, route):
        request = route.request
        if request.method == "OPTIONS":
            route.fulfill(status=204, headers=CORS)
            return
        self.keys.append(request.headers.get("x-api-key"))
        route.fulfill(status=200, headers={**CORS, "Content-Type": "application/json"}, body=json.dumps({"content": [{"type": "text", "text": "OK"}], "stop_reason": "end_turn", "usage": {"input_tokens": 10, "output_tokens": 2}}))


def check_key_sync(browser, url, token, data_dir):
    fake = Fake()
    errors, to_jotdrop, key_calls = [], [], {"a": [], "b": []}
    contexts = [browser.new_context(viewport={"width": 1280, "height": 900}) for _ in range(2)]
    a, b = [context.new_page() for context in contexts]
    for name, context, page in [("a", contexts[0], a), ("b", contexts[1], b)]:
        context.route("https://api.anthropic.com/**", fake.handle)
        page.on("pageerror", lambda error, name=name: errors.append(f"{name}: {error}"))
        page.on("dialog", lambda dialog: dialog.accept())

        def seen(request, name=name):
            if not request.url.startswith(url):
                return
            to_jotdrop.append({"url": request.url, "body": request.post_data_buffer or b""})
            if request.url.endswith("/api/v1/ai-key"):
                key_calls[name].append(request.method)
        page.on("request", seen)

    def rows():
        with closing(sqlite3.connect(data_dir / "cloud.db", timeout=5)) as database:
            return database.execute("SELECT sealed,updatedAt FROM ai_keys").fetchall()

    def set_plus(until):
        with closing(sqlite3.connect(data_dir / "cloud.db", timeout=5)) as database:
            database.execute("UPDATE plans SET plusUntil=?", (until,))
            database.commit()

    def synced(page):
        page.locator("#sync").click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

    def is_key_call(request):
        return request.url.endswith("/api/v1/ai-key")

    def settings(page, sends=True, fails=False):
        """Opens Devices & recovery again, which looks at what the server has, and waits until that is done.
        sends: with Plus the browser asks the server; on the free plan it knows the answer. fails: the request breaks."""
        page.locator('[data-view="notes"]').click()
        if fails:
            with page.expect_event("requestfailed", is_key_call):
                page.locator('[data-view="devices"]').click()
        elif sends:
            with page.expect_response(lambda response: is_key_call(response.request) and response.request.method == "GET"):
                page.locator('[data-view="devices"]').click()
        else:
            page.locator('[data-view="devices"]').click()
        page.wait_for_timeout(300)
        page.locator("#ai-section").scroll_into_view_if_needed()

    def said(page, text):
        page.locator("#ai-message").filter(has_text=text).wait_for()

    def save_key(page, key):
        page.locator("#ai-provider").select_option("anthropic")
        page.locator("#ai-key").fill(key)
        page.locator('#ai-form button[type="submit"]').click()
        said(page, "Saved. Ask JotDrop is on in this browser.")

    def ask(page):
        """One question; returns the key the AI service got with it."""
        before = len(fake.keys)
        page.locator('[data-view="notes"]').click()
        page.locator("#ask-jotdrop").click()
        page.locator("#ai-dialog[open]").wait_for()
        page.locator("#ai-request").fill("Say OK")
        page.locator("#ai-send").click()
        page.locator("#ai-result").wait_for()
        page.locator("#ai-send").and_(page.locator(":enabled")).wait_for()
        page.locator("#ai-close").click()
        assert len(fake.keys) == before + 1, fake.keys
        return fake.keys[-1]

    def is_off(page):
        page.locator('[data-view="notes"]').click()
        page.locator("#ask-jotdrop").click()
        page.locator("#ai-dialog[open]").wait_for()
        text = page.locator("#ai-off-text").inner_text()
        off = page.locator("#ai-off").is_visible() and page.locator("#ai-ask").is_hidden()
        page.locator("#ai-close").click()
        return off, text

    switch_a, switch_b = a.locator("#ai-sync"), b.locator("#ai-sync")
    try:
        # --- Browser A makes the workspace, B joins it with a pairing code.
        a.goto(url, wait_until="networkidle")
        a.locator("#show-connect").click()
        a.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            a.locator(field).fill(PASSWORD)
        a.locator('#connect-form button[type="submit"]').click()
        a.locator("#recovery-saved").check()
        a.locator("#finish-recovery").click()
        a.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        a.locator('[data-view="devices"]').click()
        a.locator("#pair-name").fill("Second browser")
        a.locator("#pair-form button").click()
        a.wait_for_function("() => document.getElementById('pair-code').value.length > 20")
        b.goto(url, wait_until="networkidle")
        b.locator("#show-connect").click()
        b.locator("#connect-method").select_option("pair")
        b.locator("#access-code").fill(a.locator("#pair-code").input_value())
        for field in ["#new-password", "#confirm-password"]:
            b.locator(field).fill(PASSWORD)
        b.locator('#connect-form button[type="submit"]').click()
        b.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

        # --- Without a saved key there is nothing to share.
        a.locator("#ai-section").scroll_into_view_if_needed()
        assert switch_a.is_disabled() and not switch_a.is_checked()
        assert a.locator("#ai-offer").is_hidden()
        save_key(a, KEYS[0])
        assert switch_a.is_enabled() and not switch_a.is_checked()
        assert key_calls["a"] in ([], ["GET"]), key_calls
        # A local model has no key to share.
        a.locator("#ai-provider").select_option("ollama")
        a.locator("#ai-model").fill("llama")
        a.locator('#ai-form button[type="submit"]').click()
        said(a, "Saved.")
        assert switch_a.is_disabled()
        save_key(a, KEYS[0])

        # --- Free plan: the switch says it is part of Plus, stays off, and nothing is kept.
        assert a.locator("#plus-nudge").is_hidden()
        switch_a.click()
        said(a, "Problem: Using one key on all your devices is part of JotDrop Plus.")
        assert not switch_a.is_checked() and switch_a.is_enabled()
        assert rows() == []
        assert "PUT" not in key_calls["a"], "a free plan is told so before anything is sent"
        nudge = a.locator("#plus-nudge")
        nudge.wait_for()
        assert "AI key on all your devices" in nudge.inner_text()
        # B, without a key and on the free plan, is offered nothing.
        off, text = is_off(b)
        assert off and "Choose an AI service" in text and "another device" not in text
        shot(a, "key-sync-free")

        # --- With Plus (the trial counts) the switch goes on: one sealed blob, no key in it that the server can read.
        nudge.get_by_role("button", name=TRIAL).click()
        a.locator("#plan-status").filter(has_text="JotDrop Plus trial").wait_for()
        switch_a.click()
        said(a, 'On. Open Ask JotDrop on your other devices and select "Use it here".')
        assert switch_a.is_checked()
        assert "On: your other devices can use this key." in a.locator("#ai-sync-status").inner_text()
        first = rows()
        assert len(first) == 1 and sorted(json.loads(first[0][0])) == ["ciphertext", "iv", "v"]
        shot(a, "key-sync-on")

        # --- B: Ask JotDrop is off and offers the key; one tap, and it works with that key.
        synced(b)  # B learns that the account has Plus now.
        b.locator('[data-view="notes"]').click()
        b.locator("#ask-jotdrop").click()
        b.locator("#ai-off-text").filter(has_text="A key from another device is ready: Claude (Anthropic). Use it here?").wait_for()
        use_here = b.locator("#ai-off-use")
        assert use_here.is_visible() and use_here.inner_text() == "Use it here"
        shot(b, "key-sync-offer")
        use_here.click()
        b.locator("#ai-request").wait_for()
        assert b.locator("#ai-off").is_hidden()
        b.locator("#ai-request").fill("Say OK")
        b.locator("#ai-send").click()
        b.locator("#ai-result").wait_for()
        b.locator("#ai-close").click()
        assert fake.keys[-1] == KEYS[0]
        settings(b)
        b.locator("#ai-sync-status").filter(has_text="On: your other devices can use this key.").wait_for()
        assert switch_b.is_checked() and b.locator("#ai-offer").is_hidden()
        assert b.locator("#ai-provider").input_value() == "anthropic" and b.locator("#ai-key").input_value() == ""
        # The key is never put on the page.
        for page in [a, b]:
            assert KEYS[0] not in page.content()

        # --- A new key on A works through to B when B opens its settings.
        save_key(a, KEYS[1])
        said(a, "Your other devices get the same key.")
        second = rows()
        assert len(second) == 1 and second[0][1] > first[0][1] and second[0][0] != first[0][0]
        assert ask(b) == KEYS[0], "B keeps its copy until it looks"
        settings(b)
        said(b, "The key was replaced on another device. This browser now uses the new one.")
        assert ask(b) == KEYS[1]

        # --- Once a day an ordinary sync looks too; within the day it does not ask again.
        save_key(a, KEYS[2])
        said(a, "Your other devices get the same key.")
        calls = len(key_calls["b"])
        synced(b)
        b.wait_for_timeout(300)
        assert len(key_calls["b"]) == calls, "no second look within a day"
        assert ask(b) == KEYS[1]
        b.evaluate("""() => new Promise((done, fail) => {
            const open = indexedDB.open('jotdrop-cloud-v1', 1);
            open.onerror = fail;
            open.onsuccess = () => {
                const values = open.result.transaction('values', 'readwrite').objectStore('values'), cursor = values.openCursor();
                let found = 0;
                cursor.onsuccess = () => {
                    const entry = cursor.result;
                    if (!entry) { found === 1 ? done() : fail(new Error(`found ${found}`)); return; }
                    if (String(entry.key).startsWith('ai-key-checked:')) { found++; entry.update(Date.now() - 25 * 60 * 60 * 1000); }
                    entry.continue();
                };
            };
        })""")
        with b.expect_response(lambda response: is_key_call(response.request)):
            synced(b)
        b.wait_for_timeout(300)
        assert len(key_calls["b"]) == calls + 1
        # B is on its notes: the settings say it, out of sight.
        b.locator("#ai-message").filter(has_text="The key was replaced on another device. This browser now uses the new one.").wait_for(state="attached")
        assert ask(b) == KEYS[2]

        # --- An older server (a plain 404 without a code), a server error and no connection leave B's key alone.
        answers = [(404, {"error": "Not found"}), (500, {"error": "Internal server error"}), None]

        def broken(route):
            answer = answers[0]
            if answer is None:
                route.abort()
            else:
                route.fulfill(status=answer[0], content_type="application/json", body=json.dumps(answer[1]))
        contexts[1].route(f"{url}/api/v1/ai-key", broken)
        while answers:
            calls = len(key_calls["b"])
            settings(b, fails=answers[0] is None)
            assert len(key_calls["b"]) == calls + 1, answers[0]
            assert switch_b.is_checked(), answers[0]
            assert ask(b) == KEYS[2], answers[0]
            answers.pop(0)
        contexts[1].unroute(f"{url}/api/v1/ai-key")

        # --- A blob that does not open (changed in the database, with a later time) is never taken and removes nothing.
        kept = rows()[0]
        envelope = json.loads(kept[0])
        envelope["ciphertext"] = envelope["ciphertext"][:-4] + ("AAAA" if not envelope["ciphertext"].endswith("AAAA") else "BBBB")
        with closing(sqlite3.connect(data_dir / "cloud.db", timeout=5)) as database:
            database.execute("UPDATE ai_keys SET sealed=?,updatedAt=?", (json.dumps(envelope), kept[1] + 1000))
            database.commit()
        calls = len(key_calls["b"])
        settings(b)
        assert len(key_calls["b"]) == calls + 1
        assert switch_b.is_checked() and ask(b) == KEYS[2]
        # The blob as it was.
        with closing(sqlite3.connect(data_dir / "cloud.db", timeout=5)) as database:
            database.execute("UPDATE ai_keys SET sealed=?,updatedAt=?", kept)
            database.commit()

        # --- Plus ends: nothing is taken away. B keeps its key; A's new key stays on A.
        set_plus(0)
        for page in [a, b]:
            synced(page)
            page.locator("#plan-status").filter(has_text="Free plan").wait_for()
        calls = len(key_calls["b"])
        settings(b, sends=False)
        b.locator("#ai-sync-status").filter(has_text="This waits for JotDrop Plus. This browser keeps its key, and nothing is removed.").wait_for()
        assert switch_b.is_checked() and ask(b) == KEYS[2]
        assert len(key_calls["b"]) == calls, "on the free plan the browser does not ask"
        settings(a, sends=False)
        save_key(a, KEYS[3])
        said(a, "Your other devices keep the earlier key: Using one key on all your devices is part of JotDrop Plus.")
        assert rows()[0] == kept, "the blob is as it was"
        assert ask(a) == KEYS[3] and ask(b) == KEYS[2]
        shot(a, "key-sync-plus-ended")

        # --- Plus is back: saving again passes the key on.
        set_plus(int(time.time() * 1000) + 30 * 86400000)
        for page in [a, b]:
            synced(page)
            page.locator("#plan-status").filter(has_text="JotDrop Plus").wait_for()
        settings(a)
        save_key(a, KEYS[3])
        said(a, "Your other devices get the same key.")
        settings(b)
        said(b, "The key was replaced on another device. This browser now uses the new one.")
        assert ask(b) == KEYS[3]

        # --- A shared key for another service is not taken without a question: it changes where questions and notes go.
        settings(a)
        a.locator("#ai-provider").select_option("openai")
        a.locator("#ai-key").fill(OPENAI_KEY)
        a.locator('#ai-form button[type="submit"]').click()
        said(a, "Your other devices get the same key.")
        # Found in Android's two-device test (13 Nov 2026): right after its own Save the screen must know what the server has
        # now. "In this browser only" then offers OpenAI, the key that is there, not Claude from when the settings opened.
        a.locator("#ai-remove").click()
        a.locator("#ai-remove-here").click()
        said(a, "Your other devices keep it.")
        a.locator("#ai-offer").filter(has_text="A key from another device is ready: OpenAI. Use it here?").wait_for()
        a.locator("#ai-offer-use").click()
        said(a, "Ask JotDrop is on in this browser, with the key for OpenAI.")
        settings(b)
        offer = b.locator("#ai-offer")
        offer.filter(has_text="Your other devices now use a key for OpenAI. Use it here too? Until then this browser keeps the key it has.").wait_for()
        assert b.locator("#ai-offer-use").is_visible() and b.locator("#ai-provider").input_value() == "anthropic"
        assert ask(b) == KEYS[3], "B keeps its key until the user says so"
        shot(b, "key-sync-switched")
        # Back to the same service: that is a replaced key again, taken without a question.
        settings(a)
        save_key(a, KEYS[3])
        said(a, "Your other devices get the same key.")
        settings(b)
        said(b, "The key was replaced on another device. This browser now uses the new one.")
        assert offer.is_hidden() and ask(b) == KEYS[3]

        # --- "Turn off and remove key" asks where; "on all my devices" removes the blob, and B drops its copy.
        settings(a)
        a.locator("#ai-remove").click()
        choice = a.locator("#ai-remove-choice")
        choice.wait_for()
        assert [button.inner_text() for button in choice.locator("button").all()] == ["On all my devices", "In this browser only", "Cancel"]
        a.locator("#ai-remove-cancel").click()
        assert choice.is_hidden() and ask(a) == KEYS[3]
        settings(a)
        a.locator("#ai-remove").click()
        a.locator("#ai-remove-all").click()
        said(a, "The key is removed from this browser and from JotDrop.")
        assert rows() == []
        assert is_off(a)[0]
        assert ask(b) == KEYS[3], "B still has its copy until it looks"
        settings(b)
        said(b, "The key was removed on another device, so Ask JotDrop is off in this browser.")
        b.locator("#workspace-message").filter(has_text="The key was removed on another device").wait_for()
        assert not switch_b.is_checked() and b.locator("#ai-provider").input_value() == ""
        off, text = is_off(b)
        assert off and "Choose an AI service" in text

        # --- The offer in the settings; "in this browser only" leaves the others their key.
        settings(a)
        save_key(a, KEYS[4])
        switch_a.click()
        said(a, "On. Open Ask JotDrop")
        settings(b)
        offer.filter(has_text="A key from another device is ready: Claude (Anthropic). Use it here?").wait_for()
        shot(b, "key-sync-offer-settings")
        b.locator("#ai-offer-use").click()
        said(b, "Ask JotDrop is on in this browser, with the key for Claude (Anthropic).")
        assert offer.is_hidden() and switch_b.is_checked() and ask(b) == KEYS[4]
        settings(b)
        b.locator("#ai-remove").click()
        b.locator("#ai-remove-here").click()
        said(b, "Your other devices keep it.")
        assert len(rows()) == 1 and ask(a) == KEYS[4]
        # B is offered the key again.
        settings(b)
        offer.wait_for()
        b.locator("#ai-offer-use").click()
        said(b, "Ask JotDrop is on in this browser")

        # --- A browser with its own key is told that the others share one, and takes theirs only after a question.
        settings(b)
        b.locator("#ai-remove").click()
        b.locator("#ai-remove-here").click()
        said(b, "Your other devices keep it.")
        save_key(b, KEYS[5])
        settings(b)
        b.locator("#ai-sync-status").filter(has_text="Your other devices share a key for Claude (Anthropic). Switch this on to use that key here too.").wait_for()
        assert not switch_b.is_checked() and b.locator("#ai-offer").is_hidden()
        assert ask(b) == KEYS[5]
        blob = rows()[0]
        settings(b)
        switch_b.click()  # The question is answered with OK (the dialog handler).
        said(b, "Ask JotDrop is on in this browser, with the key for Claude (Anthropic).")
        assert switch_b.is_checked() and ask(b) == KEYS[4]
        assert rows()[0] == blob, "the shared key was not written over"

        # --- Turning the switch off removes the sealed copy; this browser keeps its key, the other one loses it.
        settings(b)
        switch_b.click()
        said(b, "Off. The sealed copy is removed. This browser keeps its key.")
        assert rows() == [] and not switch_b.is_checked() and ask(b) == KEYS[4]
        settings(a)
        said(a, "The key was removed on another device, so Ask JotDrop is off in this browser.")
        assert is_off(a)[0]

        # --- The JotDrop server never got a key in a form it can read: not in a request, not in its files.
        for request in to_jotdrop:
            for key in [*KEYS, OPENAI_KEY]:
                assert key.encode() not in request["body"] and key not in request["url"], request["url"]
        puts = [request for request in to_jotdrop if request["url"].endswith("/api/v1/ai-key") and request["body"]]
        assert len(puts) >= 5
        for request in puts:
            body = json.loads(request["body"])
            assert list(body) == ["sealed"] and sorted(json.loads(body["sealed"])) == ["ciphertext", "iv", "v"]
        # Every blob has the same size, whatever is in it.
        assert len({len(request["body"]) for request in puts}) == 1
        stored = b"".join(path.read_bytes() for path in data_dir.iterdir() if path.is_file())
        for secret in [*KEYS, OPENAI_KEY, "sk-ant-test", "claude-haiku"]:
            assert secret.encode() not in stored, secret
        assert set(fake.keys) <= set(KEYS)

        # --- On a phone the settings fit the screen.
        a.set_viewport_size({"width": 390, "height": 844})
        settings(a)
        save_key(a, KEYS[0])
        a.wait_for_function("() => innerWidth === 390")
        shot(a, "key-sync-mobile")
        assert not a.evaluate("document.documentElement.scrollWidth > innerWidth")
        assert not errors, errors
        return {"needs_saved_key": True, "needs_plus": True, "offer_one_tap": True, "new_key_works_through": True, "daily_look": True, "old_server_keeps_key": True,
                "unreadable_blob_keeps_key": True, "plus_ended_keeps_key": True, "remove_everywhere": True, "remove_here_only": True, "own_key_not_overwritten": True,
                "switch_off_removes_blob": True, "other_service_asks_first": True, "server_never_reads_key": True, "equal_blob_size": True, "ai_key_requests": {name: len(calls) for name, calls in key_calls.items()}}
    finally:
        if sys.exc_info()[0]:
            for name, page in [("a", a), ("b", b)]:
                print({name: {"message": page.locator("#ai-message").text_content(), "status": page.locator("#ai-sync-status").text_content(), "off": page.locator("#ai-off-text").text_content()}, "errors": errors, "calls": key_calls})
                if SHOTS:
                    page.screenshot(path=os.path.join(SHOTS, f"key-sync-failed-{name}.png"), full_page=True)
        for context in contexts:
            context.close()


if __name__ == "__main__":
    main(check_key_sync, history_limit=100, with_data=True)

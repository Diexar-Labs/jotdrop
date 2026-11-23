"""Run: python cloud/taps_browser_check.py. Synthetic checks on a phone-sized touch screen: the choice to stay signed in
has no default (#80), only a task's box ticks it (#81), a toast uses the width it needs (#87), the tap that closes a card
menu does nothing else (#88), and an empty archive talks about the archive."""
import sys

sys.dont_write_bytecode = True
from browser_check import main

TOASTS = ["Note unpinned", "Note archived", "Note back in your notes", "Note moved to trash"]
LINES = """text => { const toast = document.getElementById('toast'); toast.firstChild.textContent = text;
  const range = document.createRange(); range.selectNodeContents(toast.firstChild);
  const box = toast.getBoundingClientRect();
  return { lines: new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size, left: box.left, right: box.right, width: innerWidth }; }"""


def check_taps(browser, url, token):
    context = browser.new_context(viewport={"width": 393, "height": 780}, has_touch=True, is_mobile=True)
    page = context.new_page()
    errors, sent, failed = [], [], []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("dialog", lambda dialog: dialog.accept())

    def expect(ok, what):
        # All of them are reported, so one run on an old copy shows every fix that is missing.
        if not ok:
            failed.append(what)

    def editor_open():
        return page.locator("#editor").evaluate("dialog => dialog.open")

    def close_editor():
        if editor_open():
            page.locator("#close-editor").click()
        page.wait_for_timeout(200)

    def synced():
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

    def card(title):
        return page.locator(".note-card").filter(has=page.locator("h3", has_text=title))

    def tap_at(x, y):
        page.touchscreen.tap(x, y)
        page.wait_for_timeout(500)

    try:
        page.goto(url, wait_until="networkidle")

        # #80: staying signed in is a choice, never a default (no consent by a ticked box).
        for form in ("login", "signup", "reset", "provider"):
            radios = page.locator(f'input[type="radio"][name="{form}-stay"]')
            expect(radios.count() == 2 and not any(radios.nth(i).is_checked() for i in range(radios.count())), f"80: {form} offers two choices and none is chosen")
            expect(not page.locator(f"#{form}-remember").is_checked(), f"80: {form} does not stay signed in by default")
        page.on("request", lambda request: sent.append(request.url) if request.method == "POST" else None)
        page.locator("#login-email").fill("taps@example.com")
        page.locator("#login-password").fill("synthetic taps passphrase")
        page.locator('#login-form button[type="submit"]').click()
        page.wait_for_timeout(700)
        expect(not sent, "80: login waits for the choice")

        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ("#new-password", "#confirm-password"):
            page.locator(field).fill("synthetic taps passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-dialog").wait_for()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        synced()
        notes = {"One": "first note", "Two": "second note", "Tasks": "- [ ] milk\n- [ ] bread\n  - [ ] rye\n- [ ] eggs\n- [ ] tea"}
        for title, body in notes.items():
            page.locator("#new-note").click()
            page.locator("#note-content").fill(f"# {title}\n\n{body}")
            page.locator('#editor-form button[type="submit"]').click()
            card(title).wait_for()
            synced()
            # A second apart: a file name holds seconds, and within one second the name decides which card is on top.
            page.wait_for_timeout(1100)

        # #81: the words open the note, the box ticks, and the box is wide enough for a finger.
        tasks = card("Tasks")
        tasks.locator(".task-text", has_text="milk").tap()
        page.wait_for_timeout(600)
        expect(editor_open(), "81: tapping a task's words opens the note")
        close_editor()
        expect(tasks.get_by_role("checkbox", name="milk").count() == 1 and not tasks.get_by_role("checkbox", name="milk").is_checked(), "81: tapping a task's words does not tick it")

        def edge(name, dx, dy):
            """Taps beside the middle of a box."""
            target = tasks.get_by_role("checkbox", name=name)
            if not target.count():
                return False
            target.scroll_into_view_if_needed()
            box = target.bounding_box()
            tap_at(box["x"] + box["width"] / 2 + dx, box["y"] + box["height"] / 2 + dy)
            page.wait_for_timeout(1200)
            ticked = not target.count() or target.is_checked()
            close_editor()
            return ticked

        expect(edge("bread", 0, 0), "81: the box itself ticks")
        expect(edge("eggs", -16, 0), "81: a tap left of the box ticks")
        expect(edge("tea", 15, 0), "81: a tap right of the box ticks")
        rye = tasks.get_by_role("checkbox", name="rye")
        if rye.count():
            rye.focus()
            page.keyboard.press("Space")
            page.wait_for_timeout(1200)
            expect(not rye.count() or rye.is_checked(), "81: Space still ticks")
        synced()

        # #88: a menu's own button closes it; a tap elsewhere only closes it.
        more = card("One").get_by_role("button", name="More", exact=True)
        more.tap()
        page.locator(".card-menu").wait_for()
        more.tap()
        page.wait_for_timeout(300)
        expect(page.locator(".card-menu").count() == 0, "88: the second tap on the menu's button closes it")
        page.keyboard.press("Escape")
        for pointer in ("touch", "mouse", "long press"):
            title = card("Two").locator("h3")
            anchor = card("One").get_by_role("button", name="More", exact=True)
            anchor.evaluate("node => node.scrollIntoView({ block: 'end' })")
            page.wait_for_timeout(300)
            anchor.evaluate("node => node.click()")
            page.locator(".card-menu").wait_for()
            box = title.bounding_box()
            # Clear of the menu, and of the Select button in the corner: WebKit gives a tap to the button near it.
            x, y = box["x"] + 40, box["y"] + box["height"] / 2
            assert page.evaluate("point => Boolean(document.elementFromPoint(...point)?.closest('.note-card'))", [x, y]), "the menu covers the tapped title"
            if pointer == "touch":
                tap_at(x, y)
            else:
                page.mouse.click(x, y, delay=750 if pointer == "long press" else 0)
                page.wait_for_timeout(500)
            expect(page.locator(".card-menu").count() == 0, f"88: {pointer} outside closes the menu")
            expect(not editor_open(), f"88: {pointer} outside does not open the note")
            expect(page.locator(".note-card.is-selected").count() == 0 and not page.locator(".selection-bar").is_visible(), f"88: {pointer} outside does not select the note")
            close_editor()
        card("One").get_by_role("button", name="More", exact=True).evaluate("node => node.click()")
        page.locator(".card-menu").wait_for()
        page.locator("#search").click(force=True)
        page.wait_for_timeout(300)
        expect(page.evaluate("document.activeElement.id") != "search", "88: the closing press focuses nothing")
        page.keyboard.press("Escape")
        card("Two").locator("h3").tap(position={"x": 40, "y": 8})
        page.wait_for_timeout(500)
        expect(editor_open(), "88: the next tap works as usual")
        close_editor()
        more.tap()
        page.get_by_role("menuitem", name="Summarize with AI").wait_for()
        page.keyboard.press("Escape")
        card("One").get_by_role("button", name="Color", exact=True).tap()
        page.get_by_role("menuitemradio", name="Blue", exact=True).click()
        synced()
        page.wait_for_timeout(500)
        expect(card("One").evaluate("node => node.classList.contains('note-blue')"), "88: choosing from a menu still works")

        # #87: short messages stay on one line, a long one stays on the screen.
        card("One").get_by_role("button", name="Archive", exact=True).tap()
        page.locator("#toast:not([hidden])").wait_for()
        for width in (393, 320):
            page.set_viewport_size({"width": width, "height": 780})
            for text in TOASTS:
                expect(page.evaluate(LINES, text)["lines"] == 1, f"87: '{text}' on one line at {width}px")
            long = page.evaluate(LINES, "A much longer message that really does need more than one line on any phone at all")
            expect(long["left"] >= 0 and long["right"] <= long["width"], f"87: a long message stays on screen at {width}px")
        page.set_viewport_size({"width": 393, "height": 780})
        synced()

        # An empty archive (seen in #87's screenshot).
        page.locator("#toast").get_by_role("button", name="Undo", exact=True).click()
        synced()
        page.locator('[data-view="archive"]').evaluate("node => node.click()")
        empty = page.locator(".empty-state")
        empty.wait_for()
        expect("trash" not in empty.inner_text() and "archive" in empty.inner_text().lower(), "archive: the empty text is about the archive")

        assert not failed, "\n".join(failed)
        assert not errors, errors
        return {"stay_is_a_choice": True, "only_the_box_ticks": True, "menu_closes_only": True, "toast_width": True, "archive_empty_text": True}
    finally:
        context.close()


if __name__ == "__main__":
    main(check_taps, history_limit=100)

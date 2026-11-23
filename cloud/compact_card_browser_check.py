"""Synthetic local-server regression for the actual web card renderer. No production data."""
import sys
import tempfile
from pathlib import Path
sys.dont_write_bytecode = True
from browser_check import main


def check_compact_cards(browser, url, token):
    context = browser.new_context(viewport={"width": 1200, "height": 1000})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic compact card passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

        def create(name, body):
            page.locator("#new-note").click()
            page.locator("#note-path").fill(f"notes/{name}.md")
            page.locator("#note-content").fill(f"# {name}\n\n{body}")
            page.locator('#editor-form button[type="submit"]').click()
            card = page.locator(f'.note-card[data-path="notes/{name}.md"]')
            card.locator('.compact-card-preview[data-visible-tasks]').wait_for()
            # The card first: until it is there the status still says "up to date" about the note before it.
            page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
            return card

        def state(card):
            preview = card.locator(".compact-card-preview")
            return {k: preview.get_attribute(f"data-{k}") for k in ["mode", "visible-tasks", "hidden-tasks", "checked-tasks"]}

        # Like Keep: up to 10 open tasks right away, no More/Less, the rest behind "Open note - N more tasks".
        for count in [1, 5, 10, 11, 12, 100]:
            body = "\n".join(f"- [ ] task {i + 1}" for i in range(count))
            card = create(f"tasks-{count}", body)
            assert state(card) == {"mode": "checklist", "visible-tasks": str(min(10, count)), "hidden-tasks": str(max(0, count - 10)), "checked-tasks": "0"}, (count, state(card))
            assert card.locator('input[type="checkbox"]').count() == min(10, count), count
            assert card.locator('[data-preview-action="toggle"]').count() == 0
            label = f"Open note - {count - 10} more {'task' if count == 11 else 'tasks'}"
            if count > 10:
                assert card.locator('[data-preview-action="open"]').inner_text() == label, count
            else:
                assert card.locator('[data-preview-action="open"]').count() == 0, count
        plain = create("plain", "Plain text")
        assert state(plain)["mode"] == "text" and plain.locator('input[type="checkbox"]').count() == 0
        # Checked tasks go to the back, folded into "+ N checked items"; the file order stays.
        mixed_body = "\n".join(f"- [{'x' if i % 2 else ' '}] task {i + 1}" for i in range(15))
        checked = create("checked", mixed_body)
        assert state(checked) == {"mode": "checklist", "visible-tasks": "8", "hidden-tasks": "0", "checked-tasks": "7"}, state(checked)
        assert checked.locator('[data-preview-action="checked"]').inner_text() == "+ 7 checked items"
        assert checked.locator('input[type="checkbox"]:checked').count() == 0
        # The writer's index stays right: ticking open task 13 changes line 13 of the file.
        checked.get_by_role("checkbox", name="task 13", exact=True).click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        page.wait_for_timeout(700)
        assert state(checked)["checked-tasks"] == "8", state(checked)
        checked.locator('[data-preview-action="checked"]').click()
        saved = page.locator("#note-content").input_value()
        expected = mixed_body.splitlines()
        expected[12] = "- [x] task 13"
        assert [line for line in saved.splitlines() if line.startswith('- [')] == expected
        page.locator("#close-editor").click()
        # A note with tasks and other text is a mixed card (design kaarten-en-lijsten, part 5): its rows in the note's
        # own order, real boxes that tick both ways, a ticked task struck through in its place.
        def rows(card):
            return card.locator(".compact-card-preview").evaluate("el => [...el.children].map(row => row.innerText.trim())")

        def saved(card):
            card.locator("h3").click()
            text = page.locator("#note-content").input_value()
            page.locator("#close-editor").click()
            return text

        def tick_card(card, name):
            card.get_by_role("checkbox", name=name, exact=True).click()
            page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
            page.wait_for_timeout(700)

        mixed = create("mixed", "Intro line\n- [ ] A\n- [x] B\nOutro")
        assert state(mixed) == {"mode": "mixed", "visible-tasks": "2", "hidden-tasks": "0", "checked-tasks": "0"}, state(mixed)
        assert rows(mixed) == ["Intro line", "A", "B", "Outro"], rows(mixed)
        assert mixed.locator('input[type="checkbox"]').count() == 2 and mixed.get_by_role("checkbox", name="B", exact=True).is_checked()
        # Ticked is ☑ and struck through, never only a colour.
        assert mixed.locator(".task-row").nth(1).evaluate("row => getComputedStyle(row.querySelector('.strike')).display") != "none"
        # The same box size as on a checklist card.
        sizes = page.evaluate("() => [...document.querySelectorAll('.note-card')].filter(c => ['mixed', 'tasks-5'].some(n => c.dataset.path === `notes/${n}.md`)).map(c => c.querySelector('.task-row input').getBoundingClientRect().width)")
        assert len(sizes) == 2 and abs(sizes[0] - sizes[1]) < .5, sizes
        # With the setting off (the default) a tick only changes the box, both ways; the card stays.
        before = mixed.bounding_box()["y"]
        tick_card(mixed, "B")
        tick_card(mixed, "A")
        assert saved(mixed) == "# mixed\n\nIntro line\n- [x] A\n- [ ] B\nOutro", saved(mixed)
        assert rows(mixed) == ["Intro line", "A", "B", "Outro"] and state(mixed)["mode"] == "mixed", rows(mixed)
        assert abs(mixed.bounding_box()["y"] - before) < 3
        # Bullets and numbers show as • and their number, in up to 3 levels; deeper items stay on the third.
        levels = create("levels", "- top\n\t- middle\n\t\t- deep\n\t\t\t- deeper\n1. first\n   - [ ] sub task")
        assert state(levels)["mode"] == "mixed", state(levels)
        assert rows(levels) == ["• top", "• middle", "• deep", "• deeper", "1. first", "sub task"], rows(levels)
        assert levels.locator(".compact-card-preview > *").evaluate_all("els => els.map(el => el.dataset.level)") == ["0", "1", "2", "2", "0", "1"]
        lefts = levels.locator(".compact-card-preview > *").evaluate_all("els => els.map(el => Math.round(el.getBoundingClientRect().left))")
        assert lefts[0] < lefts[1] < lefts[2] == lefts[3] and lefts[4] == lefts[0] and lefts[5] == lefts[1], lefts

        # "Move checked items to the bottom": off by default, per device; on, a tick moves the line in the note itself.
        switch = page.locator("#move-checked")
        assert switch.get_attribute("aria-pressed") == "false" and switch.inner_text() == "Move checked items to the bottom"
        switch.click()
        assert switch.get_attribute("aria-pressed") == "true" and switch.inner_text() == "✓ Move checked items to the bottom"
        assert page.evaluate("localStorage.getItem('jotdrop-move-checked')") == "on"
        moving = create("moving", "Before we go:\n- [ ] one\n\t- [ ] one sub\n- [ ] two\n- [x] done\n\nAfter")
        before = moving.bounding_box()["y"]
        moving.get_by_role("checkbox", name="one", exact=True).click()
        # The pen strikes the task in its own place first, then it moves.
        page.wait_for_timeout(120)
        assert rows(moving) == ["Before we go:", "one", "one sub", "two", "done", "After"], rows(moving)
        assert "just-struck" in moving.locator(".task-row").first.get_attribute("class")
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        page.wait_for_timeout(700)
        assert rows(moving) == ["Before we go:", "two", "one", "one sub", "done", "After"], rows(moving)
        assert saved(moving) == "# moving\n\nBefore we go:\n- [ ] two\n- [x] one\n\t- [ ] one sub\n- [x] done\n\nAfter", saved(moving)
        # Unticked, it goes back above the ticked ones: here it is already there.
        tick_card(moving, "one")
        tick_card(moving, "done")
        assert saved(moving) == "# moving\n\nBefore we go:\n- [ ] two\n- [ ] one\n\t- [ ] one sub\n- [ ] done\n\nAfter", saved(moving)
        tick_card(moving, "two")
        assert saved(moving) == "# moving\n\nBefore we go:\n- [ ] one\n\t- [ ] one sub\n- [ ] done\n- [x] two\n\nAfter", saved(moving)
        assert abs(moving.bounding_box()["y"] - before) < 3
        # On a checklist card a ticked task with an open sub-task stays, struck through, above it.
        heads = create("heads", "- [ ] pack\n\t- [x] socks\n\t- [ ] charger\n- [x] plants\n\t- [x] water\n- [ ] bread")
        assert state(heads)["mode"] == "checklist", state(heads)
        tick_card(heads, "pack")
        assert saved(heads) == "# heads\n\n- [x] plants\n\t- [x] water\n- [ ] bread\n- [x] pack\n\t- [x] socks\n\t- [ ] charger", saved(heads)
        assert rows(heads) == ["bread", "pack", "charger"], rows(heads)
        assert heads.get_by_role("checkbox", name="pack", exact=True).is_checked()
        assert state(heads)["checked-tasks"] == "3", state(heads)
        switch.click()
        assert switch.get_attribute("aria-pressed") == "false" and page.evaluate("localStorage.getItem('jotdrop-move-checked')") == "off"
        # A line of only hashtags is a tag, not text: the list stays a checklist card.
        tagged = create("tagged", "- [ ] milk\n- [ ] bread\n\\#groceries #shop")
        assert state(tagged)["mode"] == "checklist" and tagged.locator('input[type="checkbox"]').count() == 2, state(tagged)
        # The pen line draws once per tick; the ticked task then joins the checked ones and the card stays put.
        page.evaluate("""() => {
          window.strikes = [];
          document.addEventListener('change', (event) => { if (event.target.closest('.task-row')) window.tickAt = performance.now(); }, true);
          for (const type of ['animationstart', 'animationend', 'animationcancel']) document.addEventListener(type, (event) => {
            if (event.animationName === 'draw') window.strikes.push({type, at: performance.now(), elapsed: event.elapsedTime, task: event.target.closest('.task-row')?.querySelector('input')?.getAttribute('aria-label')});
          }, true);
        }""")
        strike_card = create("strike", "\n".join(f"- [ ] stroke {i + 1}" for i in range(12)))

        def tick(name, done):
            box = strike_card.get_by_role("checkbox", name=name, exact=True)
            # In view first: a click that scrolls the page would move the card on the screen.
            box.scroll_into_view_if_needed()
            before = strike_card.bounding_box()["y"]
            page.evaluate("window.strikes.length = 0")
            box.click()
            page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
            page.wait_for_timeout(700)
            events = page.evaluate("window.strikes.map(e => ({...e, at: e.at - window.tickAt}))")
            mine = [e for e in events if e["task"] == name]
            assert any(e["type"] == "animationend" for e in mine), (name, events)
            starts = [e for e in mine if e["type"] == "animationstart"]
            # A re-render may continue the stroke, never restart it.
            assert starts and all(e["elapsed"] > 0 for e in starts[1:]), (name, events)
            assert all(abs(e["at"] - e["elapsed"] * 1000) < 60 for e in starts), (name, events)
            assert [e for e in events if e["task"] != name] == [], (name, events)
            assert strike_card.get_by_role("checkbox", name=name, exact=True).count() == 0, name
            assert state(strike_card)["checked-tasks"] == str(done), (name, state(strike_card))
            assert abs(strike_card.bounding_box()["y"] - before) < 3, name

        tick("stroke 2", 1)
        assert state(strike_card)["visible-tasks"] == "10" and state(strike_card)["hidden-tasks"] == "1", state(strike_card)
        tick("stroke 1", 2)
        assert state(strike_card)["hidden-tasks"] == "0", state(strike_card)
        page.evaluate("window.strikes.length = 0")
        page.set_viewport_size({"width": 1100, "height": 1000})
        page.wait_for_timeout(500)
        page.set_viewport_size({"width": 1200, "height": 1000})
        page.wait_for_timeout(500)
        assert page.evaluate("window.strikes.length") == 0, page.evaluate("window.strikes")
        # mrjo118's case (Joplin forum 51337): much text, then 3 tasks. The text keeps the text card's room, so the card
        # stays as high as a text card and says how many tasks are behind "Open note".
        article = create("article", ("Long article sentence. " * 300) + "\n- [ ] A\n- [x] B\n- [ ] C")
        assert state(article) == {"mode": "mixed", "visible-tasks": "0", "hidden-tasks": "3", "checked-tasks": "0"}, state(article)
        assert article.locator('input[type="checkbox"]').count() == 0
        assert article.locator('[data-preview-action="open"]').inner_text() == "Open note - 3 more tasks"
        assert article.locator(".compact-card-preview").evaluate("el => el.getBoundingClientRect().height") <= 200.5
        intro = article.locator(".compact-card-preview").inner_text()
        assert intro.startswith("Long article sentence.") and intro.endswith("…"), intro[-80:]
        # A short text, then 12 tasks: up to 10 tasks on top of the text, then "Open note - N more tasks".
        many = create("many", "Before the list:\n" + "\n".join(f"- [{'x' if i == 1 else ' '}] item {i + 1}" for i in range(12)))
        assert state(many) == {"mode": "mixed", "visible-tasks": "10", "hidden-tasks": "2", "checked-tasks": "0"}, state(many)
        assert rows(many)[:3] == ["Before the list:", "item 1", "item 2"], rows(many)
        assert many.locator('[data-preview-action="open"]').inner_text() == "Open note - 2 more tasks"
        long = create("long-tasks", "\n".join("- [ ] " + ("Unicode café 漢字 🙂 " * 30) for _ in range(11)))
        shots = Path(tempfile.gettempdir()) / "kilo" / "compact-card-checks"
        shots.mkdir(parents=True, exist_ok=True)
        long.scroll_into_view_if_needed()
        page.screenshot(path=str(shots / "web-desktop.png"), full_page=True)
        for width, height, scale in [(390, 844, "100%"), (1200, 900, "200%"), (844, 390, "100%")]:
            page.set_viewport_size({"width": width, "height": height})
            page.locator("body").evaluate("(el, scale) => el.style.zoom = scale", scale)
            page.wait_for_timeout(250)
            for card in [long, article, checked]:
                sizes = card.locator(".compact-card-preview").evaluate("el => ({height: el.getBoundingClientRect().height / (parseFloat(getComputedStyle(document.body).zoom) || 1), cap: parseFloat(el.style.maxHeight), rows: [...el.querySelectorAll('.task-row')].map(r => ({bottom:r.getBoundingClientRect().bottom, end:el.getBoundingClientRect().bottom}))})")
                assert sizes["height"] <= sizes["cap"] + 1, sizes
                assert all(row["bottom"] <= row["end"] + 1 for row in sizes["rows"]), sizes
            assert long.locator('.task-text').evaluate_all("els=>els.every(el=>el.clientHeight<=2*parseFloat(getComputedStyle(el).lineHeight)+1)")
            if width == 390:
                page.screenshot(path=str(shots / "web-mobile.png"), full_page=True)
        assert not errors, errors
        return {"task_counts": "1/5/10/11/12/100", "checked_folded": True, "source_index_13": True, "strike_then_fold": True, "mixed_has_boxes": True, "levels": True, "move_checked": True, "head_with_open_sub_task": True, "tag_line_ignored": True, "responsive": True, "screenshots": str(shots), "article_card_height": article.evaluate('el=>el.offsetHeight')}
    except Exception:
        print('BROWSER DIAGNOSTICS', errors, page.locator('#sync-status').inner_text(), page.locator('#message').all_text_contents())
        raise
    finally:
        context.close()


if __name__ == "__main__":
    main(check_compact_cards, history_limit=100)

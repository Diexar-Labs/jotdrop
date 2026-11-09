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
            page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
            card = page.locator(f'.note-card[data-path="notes/{name}.md"]')
            card.locator('.compact-card-preview[data-visible-tasks]').wait_for()
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
        # A note with any other text is a plain text card: its tasks read as ☐/☑ text, without checkboxes.
        mixed = create("mixed", "Intro line\n- [ ] A\n- [x] B\nOutro")
        assert state(mixed)["mode"] == "text" and mixed.locator('input[type="checkbox"]').count() == 0, state(mixed)
        mixed_text = mixed.locator(".compact-card-preview").inner_text()
        assert "☐ A" in mixed_text and "☑ B" in mixed_text and "Intro line" in mixed_text, mixed_text
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
        article = create("article", ("Long article sentence. " * 300) + "\n- [ ] A\n- [x] B\n- [ ] C")
        assert state(article)["mode"] == "text" and article.locator('input[type="checkbox"]').count() == 0
        assert article.locator('[data-preview-action="open"]').inner_text() == "Open note"
        intro = article.locator(".compact-card-preview").inner_text()
        assert intro.startswith("Long article sentence.") and intro.endswith("…"), intro[-80:]
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
        return {"task_counts": "1/5/10/11/12/100", "checked_folded": True, "source_index_13": True, "strike_then_fold": True, "mixed_is_text": True, "tag_line_ignored": True, "responsive": True, "screenshots": str(shots), "article_card_height": article.evaluate('el=>el.offsetHeight')}
    except Exception:
        print('BROWSER DIAGNOSTICS', errors, page.locator('#sync-status').inner_text(), page.locator('#message').all_text_contents())
        raise
    finally:
        context.close()


if __name__ == "__main__":
    main(check_compact_cards, history_limit=100)

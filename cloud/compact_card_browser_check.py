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

        for count in [0, 1, 5, 6, 10, 11, 100]:
            body = "\n".join(f"- [{'x' if i % 2 else ' '}] task {i + 1}" for i in range(count)) or "Plain text"
            card = create(f"tasks-{count}", body)
            preview = card.locator(".compact-card-preview")
            assert int(preview.get_attribute("data-visible-tasks")) == min(5, count), count
            assert card.locator('input[type="checkbox"]').count() == min(5, count), count
            if count > 5:
                toggle = card.locator('[data-preview-action="toggle"]')
                toggle.click(trial=True)  # scrolls into view; retries if a sync re-render replaces the card
                before = card.bounding_box()["y"]
                toggle.click()
                assert int(preview.get_attribute("data-visible-tasks")) == min(10, count), count
                assert int(preview.get_attribute("data-hidden-tasks")) == max(0, count - 10), count
                assert abs(card.bounding_box()["y"] - before) < 3
                if count >= 10:
                    card.get_by_role("checkbox", name="task 10", exact=True).click()
                    page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
                    assert int(preview.get_attribute("data-visible-tasks")) == 10
                    card.get_by_role("button", name="Open note", exact=True).click()
                    saved = page.locator("#note-content").input_value()
                    expected = body.splitlines()
                    expected[9] = "- [ ] task 10"
                    assert [line for line in saved.splitlines() if line.startswith('- [')] == expected
                    page.locator("#close-editor").click()
                    assert int(preview.get_attribute("data-visible-tasks")) == 10
                card.locator('[data-preview-action="toggle"]').click()
                assert int(preview.get_attribute("data-visible-tasks")) == 5
                assert card.locator('[data-preview-action="toggle"]').evaluate('el=>el===document.activeElement')
            else:
                assert card.locator('[data-preview-action="toggle"]').count() == 0
        # The pen line must draw once per tick, compact and expanded, and survive re-measuring.
        page.evaluate("""() => {
          window.strikes = [];
          document.addEventListener('change', (event) => { if (event.target.closest('.task-row')) window.tickAt = performance.now(); }, true);
          for (const type of ['animationstart', 'animationend', 'animationcancel']) document.addEventListener(type, (event) => {
            if (event.animationName === 'draw') window.strikes.push({type, at: performance.now(), elapsed: event.elapsedTime, task: event.target.closest('.task-row')?.querySelector('input')?.getAttribute('aria-label')});
          }, true);
        }""")
        strike_card = create("strike", "\n".join(f"- [ ] stroke {i + 1}" for i in range(11)))
        strike_preview = strike_card.locator(".compact-card-preview")

        def tick(name, visible):
            box = strike_card.get_by_role("checkbox", name=name, exact=True)
            before = strike_card.bounding_box()["y"]
            page.evaluate("window.strikes.length = 0")
            box.click()
            page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
            page.wait_for_timeout(600)
            events = page.evaluate("window.strikes.map(e => ({...e, at: e.at - window.tickAt}))")
            mine = [e for e in events if e["task"] == name]
            assert any(e["type"] == "animationend" for e in mine), (name, events)
            starts = [e for e in mine if e["type"] == "animationstart"]
            # A re-render may continue the stroke, never restart it.
            assert starts and all(e["elapsed"] > 0 for e in starts[1:]), (name, events)
            # Every (continued) stroke dates from the tick itself.
            assert all(abs(e["at"] - e["elapsed"] * 1000) < 60 for e in starts), (name, events)
            assert [e for e in events if e["task"] != name] == [], (name, events)
            assert strike_card.get_by_role("checkbox", name=name, exact=True).is_checked()
            assert int(strike_preview.get_attribute("data-visible-tasks")) == visible, name
            assert abs(strike_card.bounding_box()["y"] - before) < 3, name

        tick("stroke 2", 5)
        strike_card.locator('[data-preview-action="toggle"]').click()
        tick("stroke 1", 10)
        tick("stroke 10", 10)
        page.evaluate("window.strikes.length = 0")
        page.set_viewport_size({"width": 1100, "height": 1000})
        page.wait_for_timeout(500)
        page.set_viewport_size({"width": 1200, "height": 1000})
        page.wait_for_timeout(500)
        assert page.evaluate("window.strikes.length") == 0, page.evaluate("window.strikes")
        assert int(strike_preview.get_attribute("data-visible-tasks")) == 10
        article = create("article", ("Long article sentence. " * 300) + "\n- [ ] A\n- [x] B\n- [ ] C")
        assert article.locator('input[type="checkbox"]').count() == 0
        assert article.locator('[data-preview-action="toggle"]').count() == 0
        assert article.locator('[data-preview-action="open"]').inner_text() == "Open note - 3 more tasks"
        long = create("long-tasks", "\n".join("- [ ] " + ("Unicode café 漢字 🙂 " * 30) for _ in range(11)))
        shots = Path(tempfile.gettempdir()) / "kilo" / "compact-card-checks"
        shots.mkdir(parents=True, exist_ok=True)
        long.scroll_into_view_if_needed()
        page.screenshot(path=str(shots / "web-desktop.png"), full_page=True)
        for width, height, scale in [(390, 844, "100%"), (1200, 900, "200%"), (844, 390, "100%")]:
            page.set_viewport_size({"width": width, "height": height})
            page.locator("body").evaluate("(el, scale) => el.style.zoom = scale", scale)
            page.wait_for_timeout(250)
            for card in [long, article]:
                sizes = card.locator(".compact-card-preview").evaluate("el => ({height: el.getBoundingClientRect().height / (parseFloat(getComputedStyle(document.body).zoom) || 1), cap: parseFloat(el.style.maxHeight), rows: [...el.querySelectorAll('.task-row')].map(r => ({bottom:r.getBoundingClientRect().bottom, end:el.getBoundingClientRect().bottom}))})")
                assert sizes["height"] <= sizes["cap"] + 1, sizes
                assert all(row["bottom"] <= row["end"] + 1 for row in sizes["rows"]), sizes
            assert long.locator('.task-text').evaluate_all("els=>els.every(el=>el.clientHeight<=2*parseFloat(getComputedStyle(el).lineHeight)+1)")
            if width == 390:
                page.screenshot(path=str(shots / "web-mobile.png"), full_page=True)
        assert not errors, errors
        return {"task_counts": "0/1/5/6/10/11/100", "source_index_10": True, "strike_once_compact_and_expanded": True, "mixed_article": True, "responsive": True, "screenshots": str(shots), "article_card_height": article.evaluate('el=>el.offsetHeight')}
    except Exception:
        print('BROWSER DIAGNOSTICS', errors, page.locator('#sync-status').inner_text(), page.locator('#message').all_text_contents())
        raise
    finally:
        context.close()


if __name__ == "__main__":
    main(check_compact_cards, history_limit=100)

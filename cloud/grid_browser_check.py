"""Run: python cloud/grid_browser_check.py. Synthetic Keep-style card grid checks only."""
import sys
sys.dont_write_bytecode = True
from browser_check import main


def check_grid(browser, url, token):
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic grid passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        # Newest first: the tall note is created last so it opens the first row.
        notes = [
            ("e", "# Short E\n\nFive."),
            ("d", "# Short D\n\nFour."),
            ("c", "# Short C\n\nThree."),
            ("b", "# Short B\n\n- [ ] Buy milk\n- [x] Call home"),
            ("pinned", "---\npinned: true\n---\n# Pinned one\n\nStays on top."),
            ("a", "# Tall A\n\n" + "\n".join(f"Line {number} of a long note." for number in range(1, 13))),
        ]
        for name, content in notes:
            page.locator("#new-note").click()
            page.locator("#note-path").fill(f"notes/{name}.md")
            page.locator("#note-content").fill(content)
            page.locator('#editor-form button[type="submit"]').click()
            page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        cards = page.locator(".note-card")
        assert cards.count() == 6
        headings = page.locator("#items > h2")
        assert headings.all_text_contents() == ["Pinned", "Others"], headings.all_text_contents()
        pinned = cards.filter(has_text="Pinned one")
        assert pinned.locator("h3").inner_text() == "Pinned one"

        # A re-render briefly resets row spans until the ResizeObserver runs (before paint),
        # so measure all cards in one go once every span matches its height.
        settled = """() => {
          const children = [...document.getElementById('items').children];
          if (!children.every(el => el.style.gridRowEnd === `span ${Math.ceil((el.getBoundingClientRect().height + 16) / 8)}`)) return false;
          return Object.fromEntries(children.filter(el => el.matches('.note-card')).map(el => [el.querySelector('h3').textContent, el.getBoundingClientRect().toJSON()]));
        }"""
        layout = page.wait_for_function(settled).json_value()
        tall, b, c, d = layout["Tall A"], layout["Short B"], layout["Short C"], layout["Short D"]
        # The first row of others still reads left to right.
        assert abs(tall["y"] - b["y"]) < 1 and abs(b["y"] - c["y"]) < 1, (tall, b, c)
        assert tall["x"] < b["x"] < c["x"], (tall, b, c)
        # Short cards stack under short cards instead of waiting for the tall one.
        assert d["y"] < tall["y"] + tall["height"], (tall, d)
        shortest = min(b, c, key=lambda item: item["y"] + item["height"])
        assert 0 < d["y"] - (shortest["y"] + shortest["height"]) <= 24, (shortest, d)
        assert abs(d["x"] - shortest["x"]) < 1, (shortest, d)

        checklist = cards.filter(has_text="Short B")
        assert checklist.locator(".task-row input").count() == 2
        assert checklist.inner_text().count("Buy milk") == 1, checklist.inner_text()
        assert "- [ ]" not in checklist.inner_text()

        # Actions appear on hover like Keep and the plugin; path and version stay off the card face.
        short = cards.filter(has_text="Short C")
        bar = short.locator(".card-actions")
        page.mouse.move(5, 5)
        # The bar fades (.15s) and a sync may re-render the card, so poll the current card.
        page.wait_for_function("""() => getComputedStyle(document.querySelector('.note-card[data-path="notes/c.md"] .card-actions')).opacity === '0'""")
        assert short.get_by_role("button", name="Download", exact=True).count() == 1
        assert "Cloud version" not in short.inner_text() and "notes/c.md" not in short.inner_text()
        assert short.get_attribute("data-path") == "notes/c.md" and short.get_attribute("data-revision") == "1"
        # One compact strip, so the hidden bar does not leave a big empty block on every card.
        assert bar.bounding_box()["height"] < 48, bar.bounding_box()
        short.hover()
        page.wait_for_function("element => getComputedStyle(element).opacity === '1'", arg=bar.element_handle())
        page.mouse.move(5, 5)
        short.get_by_role("button", name="Archive", exact=True).focus()
        page.wait_for_function("element => getComputedStyle(element).opacity === '1'", arg=bar.element_handle())
        page.locator("#search").focus()

        cards.filter(has_text="Short C").locator(".note-preview").click()
        page.locator("#editor[open]").wait_for()
        assert "Three." in page.locator("#note-content").input_value()
        page.locator("#close-editor").click()

        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_function("() => innerWidth === 390")
        boxes = sorted(page.wait_for_function(settled).json_value().values(), key=lambda item: item["y"])
        assert len({round(item["x"]) for item in boxes}) == 1, boxes
        assert all(upper["y"] + upper["height"] <= lower["y"] for upper, lower in zip(boxes, boxes[1:])), boxes
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
        assert not errors, errors
        touch = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
        try:
            phone = touch.new_page()
            phone.goto(url, wait_until="networkidle")
            assert phone.evaluate("matchMedia('(hover: none)').matches")
            # Without hover the bar must stay visible: reuse the page's own rule on a probe card.
            assert phone.evaluate("""() => {
              const card = document.createElement('article'); card.className = 'note-card';
              const bar = document.createElement('div'); bar.className = 'card-actions'; card.append(bar);
              document.body.append(card); return getComputedStyle(bar).opacity;
            }""") == "1"
        finally:
            touch.close()
        return {"masonry_packing": True, "row_reading_order": True, "pinned_sections": True, "checklist_once": True, "card_click_opens": True, "hover_actions": True, "touch_actions_visible": True, "mobile_single_column": True}
    finally:
        if sys.exc_info()[0]:
            print({"sync": page.locator("#sync-status").text_content(), "message": page.locator("#workspace-message").text_content(), "errors": errors})
        context.close()


if __name__ == "__main__":
    main(check_grid, history_limit=100)

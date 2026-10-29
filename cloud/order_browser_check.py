"""Run: python cloud/order_browser_check.py. Synthetic manual order checks: cards stay put, dragging moves them like the plugin."""
import sys
sys.dont_write_bytecode = True
from browser_check import main


def check_order(browser, url, token):
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))

    def synced():
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

    def card(text):
        return page.locator(".note-card").filter(has_text=text)

    def titles():
        return page.locator(".note-card h3").all_text_contents()

    def raw(text):
        target = card(text)
        target.hover()
        target.get_by_role("button", name="Open note", exact=True).click()
        page.locator("#editor[open]").wait_for()
        value = page.locator("#note-content").input_value()
        page.locator("#close-editor").click()
        page.locator("#editor:not([open])").wait_for(state="attached")
        return value

    def drag(text, onto, before):
        box = card(onto).bounding_box()
        card(text).drag_to(card(onto), source_position={"x": 20, "y": 10}, target_position={"x": box["width"] / 2, "y": 5 if before else box["height"] - 5})
        synced()

    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic order passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        for name, content in [("2026-10-27 080001 A", "# Card A\n\nFirst."), ("2026-10-27 080002 B", "# Card B\n\n- [ ] Task"), ("2026-10-27 080003 C", "# Card C\n\nThird.")]:
            page.locator("#new-note").click()
            page.locator("#note-path").fill(f"notes/{name}.md")
            page.locator("#note-content").fill(content)
            page.locator('#editor-form button[type="submit"]').click()
            synced()

        # Manual order is the default, like the plugin: newest first, then fixed.
        assert page.locator("#sort").input_value() == "manual"
        assert titles() == ["Card C", "Card B", "Card A"], titles()
        # A ticked box changes the note but never moves its card.
        card("Card B").locator(".task-row input").check()
        page.locator('.note-card[data-revision="2"]').filter(has_text="Card B").wait_for()
        synced()
        assert titles() == ["Card C", "Card B", "Card A"], titles()

        # Dragging writes `order` to the moved card only, as the plugin and Android read it.
        drag("Card A", "Card C", before=True)
        assert titles() == ["Card A", "Card C", "Card B"], titles()
        assert "order: -20261027080004" in raw("Card A")
        drag("Card B", "Card A", before=False)
        assert titles() == ["Card A", "Card B", "Card C"], titles()
        assert "order: -20261027080003.5" in raw("Card B")
        assert "order:" not in raw("Card C")

        # A pinned card and the others keep their own groups.
        card("Card C").hover()
        card("Card C").get_by_role("button", name="Pin", exact=True).click()
        synced()
        drag("Card A", "Card C", before=True)
        assert titles() == ["Card C", "Card A", "Card B"], titles()
        assert "order: -20261027080004" in raw("Card A")

        # Another sort shows no drag handles; manual comes back as it was.
        page.locator("#sort").select_option("title")
        assert page.locator('.note-card[draggable="true"]').count() == 0
        page.locator("#sort").select_option("manual")
        assert page.locator('.note-card[draggable="true"]').count() == 3
        assert not errors, errors
        return {"manual_default": True, "tick_stays_put": True, "drag_writes_order": True, "pinned_groups_kept": True, "drag_only_in_manual": True}
    finally:
        if sys.exc_info()[0]:
            print({"sync": page.locator("#sync-status").text_content(), "message": page.locator("#workspace-message").text_content(), "titles": titles(), "errors": errors})
        context.close()


if __name__ == "__main__":
    main(check_order, history_limit=100)

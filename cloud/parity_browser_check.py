"""Run: python cloud/parity_browser_check.py. Synthetic browser feature checks only."""
import base64
import sys
sys.dont_write_bytecode = True
from browser_check import main


def check_parity(browser, url, token):
    context = browser.new_context(permissions=["microphone"], viewport={"width": 390, "height": 844})
    page = context.new_page()
    errors = []
    requests = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("request", lambda request: requests.append(request.url))
    page.on("dialog", lambda dialog: dialog.accept())
    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic parity passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        image = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
        page.locator("#upload").set_input_files({"name": "pixel.png", "mimeType": "image/png", "buffer": image})
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        page.locator("#new-note").click()
        page.locator("#note-path").fill("notes/parity.md")
        page.locator("#note-content").fill('---\ncustom:\n  color: keep-me\ntags: [unchanged]\n---\n# Parity note\n\n- [ ] Real task\n\n```md\n- [ ] Example only\n```\n\n![Pixel](../attachments/pixel.png)')
        page.locator("#note-content").dispatch_event("input")
        page.locator("#note-properties summary").click()
        page.locator("#note-labels").fill("Work: notes\nIdeas")
        page.locator("#note-labels").press("Tab")
        page.locator("#note-color").select_option("teal")
        page.locator("#note-pinned").check()
        page.locator("#note-order").fill("-10")
        page.locator("#note-order").press("Tab")
        page.locator("#note-reminder").fill("2028-10-16T14:30")
        page.locator("#note-reminder").press("Tab")
        page.locator("#note-repeat").fill("daily")
        page.locator("#note-repeat").press("Tab")
        page.locator('#editor-form button[type="submit"]').click()
        card = page.locator(".note-card").filter(has_text="Parity note")
        page.locator('.note-card[data-revision="1"]').filter(has_text="Parity note").wait_for()
        assert card.locator(".task-row input").count() == 1
        assert "note-teal" in card.get_attribute("class")
        assert page.locator("#items > h2").all_text_contents() == ["Pinned"]
        assert "2028-10-16T14:30 (daily)" in card.inner_text()
        assert card.locator("img").count() == 1
        card.locator(".task-row input").check()
        page.locator('.note-card[data-revision="2"]').filter(has_text="Parity note").wait_for()
        page.locator("#label-filter").select_option("work: notes")
        page.locator("#search").fill("Real task")
        assert page.locator(".note-card").count() == 1
        page.locator("#sort").select_option("manual")
        page.locator("#search").fill("does-not-exist")
        assert page.locator(".note-card").count() == 0
        page.locator("#search").fill("")
        page.locator("#label-filter").select_option("")
        card.get_by_role("button", name="Archive", exact=True).click()
        page.locator(".note-card").filter(has_text="Parity note").wait_for(state="detached")
        page.locator('[data-view="archive"]').click()
        card = page.locator(".note-card").filter(has_text="Parity note")
        card.get_by_role("button", name="Unarchive", exact=True).wait_for()
        assert card.locator("img").count() == 1
        card.get_by_role("button", name="Unarchive", exact=True).click()
        card.wait_for(state="detached")
        page.locator('[data-view="notes"]').click()
        card = page.locator(".note-card").filter(has_text="Parity note")
        card.get_by_role("button", name="Open note", exact=True).click()
        raw = page.locator("#note-content").input_value()
        assert "custom:\n  color: keep-me\ntags: [unchanged]" in raw
        assert "- [x] Real task" in raw and "- [ ] Example only" in raw
        assert "../attachments/pixel.png" in raw
        page.locator("#start-voice").click()
        page.locator("#voice-message").filter(has_text="Recording on this device").wait_for()
        assert page.locator('#editor-form button[type="submit"]').is_disabled()
        page.wait_for_timeout(1200)
        page.locator("#stop-voice").click()
        page.locator("#voice-message").filter(has_text="Recording kept as an encrypted attachment").wait_for()
        assert "[Voice memo](../attachments/voice-" in page.locator("#note-content").input_value()
        page.locator('#editor-form button[type="submit"]').click()
        card.locator("audio").wait_for()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        card.get_by_role("button", name="Open note", exact=True).click()
        page.evaluate("() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); }; }")
        page.locator("#start-voice").click()
        page.locator("#voice-message").filter(has_text="Microphone permission was denied").wait_for()
        assert not page.locator('#editor-form button[type="submit"]').is_disabled()
        page.locator("#close-editor").click()
        context.set_offline(True)
        card.get_by_role("button", name="Archive", exact=True).click()
        page.locator("#workspace-message").filter(has_text="original is kept").wait_for()
        assert card.count() == 1
        context.set_offline(False)
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
        assert not errors, errors
        assert all(request.startswith(url + "/") or request.startswith("blob:") for request in requests), requests
        return {"metadata_and_reminder_editing": True, "unknown_yaml_preserved": True, "interactive_checklists": True, "archive_unarchive_with_media": True, "failed_move_preserves_original": True, "search_labels_sort": True, "real_voice_recording": True, "voice_permission_feedback": True, "inline_local_media": True, "no_external_requests": True, "mobile_overflow": False}
    finally:
        if sys.exc_info()[0]:
            print({"sync": page.locator("#sync-status").text_content(), "message": page.locator("#workspace-message").text_content(), "errors": errors})
        context.close()


if __name__ == "__main__":
    main(check_parity, history_limit=100, camera=True)

"""Run: python cloud/labels_browser_check.py. Synthetic sidebar label checks: list, filter, create, rename, delete, fold away."""
import sys
sys.dont_write_bytecode = True
from browser_check import main


def check_labels(browser, url, token):
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("dialog", lambda dialog: dialog.accept())
    password = "synthetic labels passphrase"

    def synced():
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

    def raw(path):
        target = page.locator(f'.note-card[data-path="{path}"]')
        target.hover()
        target.get_by_role("button", name="Open note", exact=True).click()
        page.locator("#editor[open]").wait_for()
        value = page.locator("#note-content").input_value()
        page.locator("#close-editor").click()
        return value

    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill(password)
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        for name, content in [
            ("notes/work.md", '---\njotdrop_labels: ["Work"]\n---\n# Work only'),
            ("notes/both.md", '---\njotdrop_labels: ["Work", "Home"]\n---\n# Both labels'),
            ("notes/Archive/old.md", '---\njotdrop_labels: ["Work"]\n---\n# Archived work'),
            ("notes/none.md", "# No label"),
        ]:
            page.locator("#new-note").click()
            page.locator("#note-path").fill(name)
            page.locator("#note-content").fill(content)
            page.locator('#editor-form button[type="submit"]').click()
            synced()

        # The sidebar lists labels A-Z with how many notes (not archived) have them; the toolbar has no label menu.
        assert page.locator("#label-filter").count() == 0
        labels = page.locator("#label-list button")
        assert [text.replace("\n", "") for text in labels.all_inner_texts()] == ["Home1", "Work2"], labels.all_inner_texts()
        page.locator("#label-list").get_by_role("button", name="Work").click()
        assert page.locator("#view-title").inner_text() == "Work"
        assert page.locator(".note-card").count() == 2
        assert page.locator("#label-list").get_by_role("button", name="Work").get_attribute("aria-current") == "page"
        assert page.locator('[data-view="notes"]').get_attribute("aria-current") is None
        page.locator('[data-view="notes"]').click()
        assert page.locator(".note-card").count() == 3 and page.locator("#view-title").inner_text() == "Notes"

        # Create: a new label shows with 0 notes, a duplicate is refused.
        page.locator("#edit-labels").click()
        page.locator("#new-label").fill("Ideas")
        page.locator("#new-label-form button").click()
        page.locator("#label-list").get_by_role("button", name="Ideas").wait_for()
        page.locator("#new-label").fill("work")
        page.locator("#new-label-form button").click()
        page.locator("#labels-message").filter(has_text="already exists").wait_for()

        # Rename on every note in Notes and Archive.
        page.get_by_role("textbox", name="New name for Work").fill("Job")
        page.get_by_role("textbox", name="New name for Work").press("Enter")
        page.locator("#label-list").get_by_role("button", name="Job").wait_for()
        synced()
        page.locator("#close-labels").click()
        both = raw("notes/both.md")
        assert "Job" in both and "Home" in both and "Work" not in both, both
        page.locator('[data-view="archive"]').click()
        assert "Job" in raw("notes/Archive/old.md") and "Work" not in raw("notes/Archive/old.md")
        page.locator('[data-view="notes"]').click()

        # Delete: the label goes from every note, the notes stay.
        page.locator("#edit-labels").click()
        page.get_by_role("button", name="Delete Home").click()
        page.locator("#label-list").get_by_role("button", name="Home").wait_for(state="detached")
        synced()
        page.locator("#close-labels").click()
        assert page.locator(".note-card").count() == 3
        assert "Home" not in raw("notes/both.md")

        # The made label stays on this device after locking, and its view explains how to fill it.
        page.locator("#lock").click()
        page.locator("#unlock-password").fill(password)
        page.locator('#unlock-form button[type="submit"]').click()
        page.locator("#label-list").get_by_role("button", name="Ideas").click()
        page.get_by_role("heading", name="No notes with this label yet").wait_for()

        # The sidebar folds away and comes back, remembered by this browser.
        page.locator("#toggle-sidebar").click()
        assert page.locator("#sidebar").is_hidden()
        assert page.locator("#toggle-sidebar").get_attribute("aria-expanded") == "false"
        page.reload(wait_until="networkidle")
        assert page.locator("#toggle-sidebar").get_attribute("aria-expanded") == "false"
        page.locator("#unlock-password").fill(password)
        page.locator('#unlock-form button[type="submit"]').click()
        page.locator(".note-card").first.wait_for()
        assert page.locator("#sidebar").is_hidden()
        page.locator("#toggle-sidebar").click()
        assert page.locator("#sidebar").is_visible()

        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_function("() => innerWidth === 390")
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
        assert not errors, errors
        return {"sidebar_list_and_counts": True, "label_view": True, "create_and_duplicate": True, "rename_everywhere": True, "delete_keeps_notes": True, "made_label_kept_after_lock": True, "sidebar_folds_and_remembers": True, "mobile_overflow": False}
    finally:
        if sys.exc_info()[0]:
            print({"sync": page.locator("#sync-status").text_content(), "message": page.locator("#workspace-message").text_content(), "labels": page.locator("#labels-message").text_content(), "errors": errors})
        context.close()


if __name__ == "__main__":
    main(check_labels, history_limit=100)

"""Run: python cloud/undo_browser_check.py. Synthetic Undo checks: archive, trash, restore and pin each with Undo, the
card back on its place, the toast for 10 seconds, a second action replacing the first, an open note hiding the toast,
several notes at once, and a note changed on another device that Undo leaves alone. Set JOTDROP_UNDO_SHOT to a folder
for a picture of the toast."""
import json
import os
import subprocess
import sys
import time
sys.dont_write_bytecode = True
from pathlib import Path
from browser_check import main

ROOT = Path(__file__).resolve().parent.parent
# Another device on the same cloud: it reads a note, or writes one on top of the version it reads.
OTHER = """
import { CloudClient } from './cloud/shared/client.mjs';
import { objectId } from './cloud/shared/crypto.mjs';
const job = JSON.parse(process.env.JOB);
const client = job.credentials ? new CloudClient(job.credentials) : await CloudClient.recover({ url: job.url, recoveryCode: job.code, deviceName: 'Other device' });
const read = async (path) => { try { const entry = await client.read(await objectId(client.credentials.vaultKey, path)); return { revision: entry.revision, deleted: entry.deleted, text: new TextDecoder().decode(entry.file.bytes) }; } catch (error) { if (error.status === 404) return null; throw error; } };
let result = {};
if (job.write) { const before = await read(job.write); await client.write(job.write, new TextEncoder().encode(job.text), before.revision); }
for (const path of job.read ?? []) result[path] = await read(path);
console.log(JSON.stringify({ credentials: client.credentials, ...result }));
"""


def check_undo(browser, url, token):
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors, dialogs = [], []
    page.on("pageerror", lambda error: errors.append(str(error)))

    def dialog(d):
        dialogs.append(d.message)
        d.accept()
    page.on("dialog", dialog)
    other = {}

    def device(**job):
        result = subprocess.run(["node", "--input-type=module", "-e", OTHER], cwd=ROOT, env=dict(os.environ, JOB=json.dumps({**job, **other})), capture_output=True, text=True, timeout=120)
        assert result.returncode == 0, result.stderr
        answer = json.loads(result.stdout.strip().splitlines()[-1])
        other["credentials"] = answer.pop("credentials")
        return answer

    def synced():
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

    def card(text):
        return page.locator(".note-card").filter(has_text=text)

    def paths():
        return page.eval_on_selector_all("#items .note-card[data-path]", "cards => cards.map((card) => card.dataset.path)")

    def action(text, name):
        target = card(text)
        target.hover()
        target.get_by_role("button", name=name, exact=True).click()

    def trash(text):
        action(text, "More")
        page.get_by_role("menu").get_by_role("menuitem", name="Move to trash").click()

    def shows(text):
        page.locator("#toast:not([hidden])").filter(has_text=text).wait_for()

    def undo(result="Undone"):
        page.locator("#toast").get_by_role("button", name="Undo", exact=True).click()
        shows(result)
        synced()

    def view(name):
        page.locator(f'[data-view="{name}"]').click()

    def notes():
        view("notes")
        synced()

    def stored(*names):
        found = device(read=[f"notes/{name}" for name in names])
        return {path.removeprefix("notes/"): (entry and (None if entry["deleted"] else entry["text"])) for path, entry in found.items()}

    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic undo passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.wait_for_function("() => document.querySelector('#recovery-code').value.length > 0")
        code = page.locator("#recovery-code").input_value()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        synced()
        texts = {}
        for name in "abcd":
            texts[f"{name}.md"] = f"# Card {name.upper()}\n\nNote {name}."
            page.locator("#new-note").click()
            page.locator("#note-path").fill(f"notes/{name}.md")
            page.locator("#note-content").fill(texts[f"{name}.md"])
            page.locator('#editor-form button[type="submit"]').click()
            synced()
        device(url=url, code=code)
        board = paths()
        assert len(board) == 4, board

        # Archive and Undo: the same note, byte for byte, on the same place; nothing left in the archive.
        action("Card B", "Archive")
        shows("Note archived")
        synced()
        assert card("Card B").count() == 0
        undo()
        assert paths() == board, paths()
        assert stored("b.md", "Archive/b.md") == {"b.md": texts["b.md"], "Archive/b.md": None}
        view("archive")
        assert card("Card B").count() == 0
        notes()

        # The Undo button is a bold, underlined word with a big enough target, not only a colour.
        action("Card B", "Archive")
        shows("Note archived")
        undo_button = page.locator("#toast").get_by_role("button", name="Undo", exact=True)
        style = undo_button.evaluate("(element) => { const s = getComputedStyle(element); return [Number(s.fontWeight), s.textDecorationLine]; }")
        box = undo_button.bounding_box()
        assert style[0] >= 700 and "underline" in style[1] and box["width"] >= 44 and box["height"] >= 44, (style, box)
        if os.environ.get("JOTDROP_UNDO_SHOT"):
            page.screenshot(path=str(Path(os.environ["JOTDROP_UNDO_SHOT"]) / "undo-toast-light.png"))
            page.emulate_media(color_scheme="dark")
            page.screenshot(path=str(Path(os.environ["JOTDROP_UNDO_SHOT"]) / "undo-toast-dark.png"))
            page.emulate_media(color_scheme="light")
        undo()
        assert paths() == board, paths()

        # Trash from the card asks nothing first, and Undo brings the note back where it was.
        trash("Card C")
        shows("Note moved to trash")
        synced()
        assert card("Card C").count() == 0 and not dialogs, dialogs
        undo()
        assert paths() == board, paths()
        assert stored("c.md")["c.md"] == texts["c.md"]

        # Restore from the trash asks nothing first; Undo puts the note back in the trash.
        trash("Card C")
        shows("Note moved to trash")
        synced()
        view("trash")
        action("Card C", "Restore")
        shows("Note restored")
        synced()
        assert card("Card C").count() == 0 and not dialogs, dialogs
        undo()
        assert card("Card C").count() == 1
        assert stored("c.md")["c.md"] is None
        action("Card C", "Restore")
        shows("Note restored")
        synced()
        notes()
        assert paths() == board, paths()

        # Pin and Undo: only `pinned` is written back, the card goes back among the others.
        action("Card D", "Pin")
        shows("Note pinned")
        synced()
        assert page.locator("#items > h2").all_text_contents() == ["Pinned", "Others"]
        undo()
        assert page.locator("#items > h2").count() == 0 and paths() == board, paths()
        assert stored("d.md")["d.md"] == texts["d.md"]

        # The toast stays 10 seconds, "Undone" 4; then they are gone.
        action("Card A", "Archive")
        shows("Note archived")
        started = time.monotonic()
        page.locator("#toast").wait_for(state="hidden", timeout=15000)
        stayed = time.monotonic() - started
        assert 9 <= stayed <= 11.5, stayed
        view("archive")
        action("Card A", "Unarchive")
        shows("Note back in your notes")
        started = time.monotonic()
        undo()
        page.locator("#toast").wait_for(state="hidden", timeout=10000)
        assert time.monotonic() - started <= 6, time.monotonic() - started
        assert card("Card A").count() == 1, "Undo of unarchive puts the note back in the archive"
        action("Card A", "Unarchive")
        shows("Note back in your notes")
        notes()
        assert paths() == board, paths()

        # A second action replaces the first: Undo puts back only the last one.
        action("Card A", "Archive")
        shows("Note archived")
        trash("Card B")
        shows("Note moved to trash")
        synced()
        undo()
        assert card("Card B").count() == 1 and card("Card A").count() == 0
        view("archive")
        action("Card A", "Unarchive")
        shows("Note back in your notes")
        notes()
        assert paths() == board, paths()

        # Opening a note takes the toast away: Undo never works under an open note.
        trash("Card D")
        shows("Note moved to trash")
        card("Card A").locator("h3").click()
        page.locator("#editor[open]").wait_for()
        assert page.locator("#toast").is_hidden()
        page.locator("#close-editor").click()
        view("trash")
        action("Card D", "Restore")
        shows("Note restored")
        notes()
        assert paths() == board, paths()

        # From the open note: it closes, the board offers Undo.
        card("Card B").locator("h3").click()
        page.locator("#editor[open]").wait_for()
        page.locator("#note-delete").click()
        page.locator("#editor:not([open])").wait_for(state="attached")
        shows("Note moved to trash")
        assert not dialogs, dialogs
        undo()
        assert paths() == board, paths()

        # Another device changed the archived note: Undo leaves everything as it is and says so.
        action("Card C", "Archive")
        shows("Note archived")
        synced()
        device(write="notes/Archive/c.md", text="# Card C\n\nChanged on the phone.")
        undo("Could not undo. The note changed.")
        assert card("Card C").count() == 0
        assert stored("c.md", "Archive/c.md") == {"c.md": None, "Archive/c.md": "# Card C\n\nChanged on the phone."}
        view("archive")
        assert card("Changed on the phone").count() == 1
        action("Card C", "Unarchive")
        shows("Note back in your notes")
        notes()
        texts["c.md"] = "# Card C\n\nChanged on the phone."

        # Several notes: one toast, one Undo for all. Trash still asks first for several.
        for name in ["Card A", "Card D"]:
            card(name).hover()
            card(name).get_by_role("button", name="Select note", exact=True).click()
        page.locator("#selection-bar").get_by_role("button", name="Archive", exact=True).click()
        shows("2 notes archived")
        synced()
        undo()
        assert card("Card A").count() == 1 and card("Card D").count() == 1
        assert stored("a.md", "d.md", "Archive/a.md", "Archive/d.md") == {"a.md": texts["a.md"], "d.md": texts["d.md"], "Archive/a.md": None, "Archive/d.md": None}
        for name in ["Card A", "Card D"]:
            card(name).hover()
            card(name).get_by_role("button", name="Select note", exact=True).click()
        page.locator("#selection-bar").get_by_role("button", name="Move to trash", exact=True).click()
        shows("2 notes moved to trash")
        assert dialogs == ["Move 2 notes to trash?"], dialogs
        synced()
        undo()
        assert card("Card A").count() == 1 and card("Card D").count() == 1
        assert not errors, errors
        return {"archive_undo_same_place": True, "trash_undo_no_question": True, "restore_undo_back_to_trash": True, "pin_undo": True, "toast_10s_undone_4s": round(stayed, 1), "second_action_replaces": True, "open_note_hides": True, "editor_trash_undo": True, "changed_elsewhere_left_alone": True, "several_notes_one_undo": True}
    finally:
        if sys.exc_info()[0]:
            print({"sync": page.locator("#sync-status").text_content(), "message": page.locator("#workspace-message").text_content(), "toast": page.locator("#toast").text_content(), "dialogs": dialogs, "errors": errors, "paths": paths()})
        context.close()


if __name__ == "__main__":
    main(check_undo, history_limit=200)

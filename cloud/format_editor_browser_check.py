"""Run: python cloud/format_editor_browser_check.py [msedge|chrome|firefox|webkit]. Synthetic check of the formatted note
editor (design opmaak-editor, phase 2): the buttons, signs hidden except at the caret, the Markdown switch, tables as an
editable grid, emoji, a wide table on a phone, the strict CSP (no violations), the plain text box as a safety net, and
that opening and closing a note without an edit changes nothing."""
import os
import sys
from pathlib import Path
sys.dont_write_bytecode = True
from browser_check import body_editor, body_has_focus, body_text, fill_body, main

ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "shared" / "fixtures" / "format"
# Screenshots for a person to look at, when JOTDROP_SHOTS names a folder.
SHOTS = os.environ.get("JOTDROP_SHOTS")
CSP_LISTENER = "document.addEventListener('securitypolicyviolation', (event) => { (window.__csp ||= []).push(`${event.violatedDirective} ${event.blockedURI} ${event.sample} ${event.sourceFile}:${event.lineNumber}:${event.columnNumber}`); }, true);"
SHADOW_FOCUS = "(() => { const host = document.querySelector('#note-editor .jd-editor-host'); const active = host?.shadowRoot?.activeElement; return active ? (active.className || active.tagName) : null; })()"


def body_part(text):
    """What the note's text box shows of a whole note file: no front matter, no # title line."""
    if text.startswith("---\n"):
        text = text[text.index("\n---\n", 4) + 5:]
    if text.startswith("# "):
        text = text.split("\n", 1)[1]
        if text.startswith("\n"):
            text = text[1:]
    return text


def sign_in(page, url, token):
    page.goto(url, wait_until="networkidle")
    page.locator("#show-connect").click()
    page.locator("#access-code").fill(token)
    for field in ["#new-password", "#confirm-password"]:
        page.locator(field).fill("synthetic format passphrase")
    page.locator('#connect-form button[type="submit"]').click()
    page.locator("#recovery-saved").check()
    page.locator("#finish-recovery").click()
    synced(page)


def synced(page):
    page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()


def new_context(browser, **options):
    context = browser.new_context(viewport={"width": 1200, "height": 900}, **options)
    # This check is about the formatted editor, the default for new viewers.
    context.add_init_script("try { localStorage.setItem('jotdrop-editor-mode', 'simple'); } catch {}")
    context.add_init_script(CSP_LISTENER)
    return context


def shot(page, name):
    if SHOTS:
        page.screenshot(path=str(Path(SHOTS) / f"{name}.png"))


def visible_text(page):
    """What the editor shows: signs are always hidden (also at the caret and in a selection)."""
    return page.locator("#note-editor .cm-content").inner_text()


def button(page, name):
    return page.locator(f'#format-bar [data-format="{name}"]')


def table_button(page, name):
    return page.locator(f'#table-bar [data-table="{name}"]')


def check_format_editor(browser, url, token):
    context = new_context(browser)
    page = context.new_page()
    errors, dialogs = [], []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("response", lambda response: errors.append(f"{response.status} {response.url}") if response.status >= 400 and "/api/" not in response.url else None)
    page.on("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.accept()))
    try:
        sign_in(page, url, token)

        # The formatted editor takes the plain text box's place.
        page.locator("#new-note").click()
        body_editor(page)
        assert page.locator("#note-body").is_hidden() and not page.locator("#note-editor").is_hidden()
        page.locator("#note-title").fill("Formatting")
        page.locator("#note-title").press("Enter")
        assert body_has_focus(page)

        # Bold on a selection: one pair of signs in the source, hidden on screen once the caret leaves it.
        page.keyboard.type("Hello world")
        page.keyboard.press("Shift+Control+ArrowLeft")
        button(page, "bold").click()
        assert body_text(page) == "Hello **world**", body_text(page)
        assert button(page, "bold").get_attribute("aria-pressed") == "true"
        page.keyboard.press("Home")
        assert visible_text(page) == "Hello world", visible_text(page)
        assert button(page, "bold").get_attribute("aria-pressed") == "false"
        assert page.locator("#note-editor .cm-jd-bold").inner_text() == "world"
        # Signs stay hidden at the caret and in a selection (Eric, 16 nov): only the Markdown switch shows them.
        page.keyboard.press("End")
        assert visible_text(page) == "Hello world", visible_text(page)
        page.keyboard.press("Shift+Control+ArrowLeft")
        assert visible_text(page) == "Hello world", visible_text(page)
        assert page.locator("#note-editor .cm-jd-sign").count() == 0
        page.keyboard.press("End")
        # A caret in a word formats that word; Ctrl+I is italic.
        page.keyboard.press("Home")
        page.keyboard.press("ArrowRight")
        page.keyboard.press("Control+i")
        assert body_text(page) == "*Hello* **world**", body_text(page)
        page.keyboard.press("Control+i")
        assert body_text(page) == "Hello **world**", body_text(page)

        # First the button, then type (Eric, 16 nov): the button is on, no signs show, and pressing it again at the end
        # of the words stops the formatting there.
        fill_body(page, "Say ")
        page.keyboard.press("Control+End")
        button(page, "bold").click()
        assert button(page, "bold").get_attribute("aria-pressed") == "true"
        assert body_text(page) == "Say ****" and "*" not in visible_text(page), repr(visible_text(page))
        page.keyboard.type("hello")
        button(page, "bold").click()
        assert button(page, "bold").get_attribute("aria-pressed") == "false"
        page.keyboard.type(" there")
        assert body_text(page) == "Say **hello** there", body_text(page)
        assert visible_text(page) == "Say hello there", visible_text(page)
        # A pair the caret leaves without typing goes again: no **** stays in the note.
        page.keyboard.type(" ")
        button(page, "bold").click()
        assert body_text(page) == "Say **hello** there ****", body_text(page)
        page.keyboard.press("Home")
        assert body_text(page) == "Say **hello** there ", body_text(page)
        # On an empty line the pair is no rule, and a strike pair no code fence.
        fill_body(page, "a\n\nb")
        page.keyboard.press("Control+Home")
        page.keyboard.press("ArrowDown")
        button(page, "bold").click()
        assert body_text(page) == "a\n****\nb" and page.locator("#note-editor .cm-jd-hr").count() == 0, body_text(page)
        page.keyboard.type("x")
        assert body_text(page) == "a\n**x**\nb" and page.locator("#note-editor .cm-jd-bold").inner_text() == "x"
        # Backspace takes a letter you see, never half a hidden sign; in an empty pair the whole pair goes.
        page.keyboard.press("Backspace")
        assert body_text(page) == "a\n****\nb" and button(page, "bold").get_attribute("aria-pressed") == "true", body_text(page)
        page.keyboard.press("Backspace")
        assert body_text(page) == "a\n\nb", body_text(page)
        fill_body(page, "**hello** world")
        page.keyboard.press("Control+End")
        for _ in range(6):
            page.keyboard.press("Backspace")
        assert body_text(page) == "**hello**", body_text(page)
        page.keyboard.press("Backspace")
        assert body_text(page) == "**hell**" and "*" not in visible_text(page), body_text(page)
        fill_body(page, "## Shop")
        page.keyboard.press("Control+End")
        for _ in range(4):
            page.keyboard.press("Backspace")
        assert body_text(page) == "## ", body_text(page)
        page.keyboard.press("Backspace")
        assert body_text(page) == "", body_text(page)

        # Lists: bullets, numbers, and Enter goes on with the next number.
        fill_body(page, "milk\neggs")
        page.keyboard.press("ControlOrMeta+a")
        button(page, "bullet").click()
        assert body_text(page) == "- milk\n- eggs", body_text(page)
        # A bullet's sign is always drawn as a dot.
        assert visible_text(page).count("•") == 2 and "-" not in visible_text(page), visible_text(page)
        button(page, "ordered").click()
        assert body_text(page) == "1. milk\n2. eggs", body_text(page)
        assert button(page, "ordered").get_attribute("aria-pressed") == "true"
        page.keyboard.press("Control+End")
        page.keyboard.press("Enter")
        page.keyboard.type("bread")
        assert body_text(page) == "1. milk\n2. eggs\n3. bread", body_text(page)
        page.keyboard.press("Enter")
        page.keyboard.press("Enter")
        assert body_text(page) == "1. milk\n2. eggs\n3. bread\n", body_text(page)

        # Heading: none, ##, ###, none. Never # (that is the title).
        page.keyboard.type("Shopping")
        button(page, "heading").click()
        assert body_text(page).endswith("\n## Shopping"), body_text(page)
        assert page.locator("#note-editor .cm-jd-h2").count() == 1
        # The ## is hidden while the caret is on the heading and while its text is selected.
        assert visible_text(page).endswith("Shopping") and "#" not in visible_text(page), visible_text(page)
        page.keyboard.press("Shift+Home")
        assert "#" not in visible_text(page), visible_text(page)
        page.keyboard.press("End")
        button(page, "heading").click()
        assert body_text(page).endswith("\n### Shopping")
        button(page, "heading").click()
        assert body_text(page).endswith("\nShopping")

        # Checklist (the existing button's code), highlight, and the More menu.
        button(page, "checklist").click()
        assert body_text(page).endswith("\n- [ ] Shopping"), body_text(page)
        assert page.locator("#note-editor .cm-jd-box").count() == 1 and page.locator("#note-editor .cm-jd-box").get_attribute("aria-checked") == "false"
        page.locator("#note-editor .cm-jd-box").click()
        assert body_text(page).endswith("\n- [x] Shopping"), body_text(page)
        fill_body(page, "very important")
        page.keyboard.press("Shift+Control+ArrowLeft")
        button(page, "highlight").click()
        assert body_text(page) == "very ==important==", body_text(page)
        # The caret in the highlighted word: strikethrough goes on that word, inside the highlight.
        page.keyboard.press("End")
        page.keyboard.press("ArrowLeft")
        page.keyboard.press("ArrowLeft")
        button(page, "more").click()
        page.get_by_role("menuitem", name="Strikethrough").click()
        assert body_text(page) == "very ==~~important~~==", body_text(page)
        fill_body(page, "run npm")
        page.keyboard.press("Shift+Control+ArrowLeft")
        button(page, "more").click()
        page.get_by_role("menuitem", name="Code").click()
        assert body_text(page) == "run `npm`", body_text(page)
        fill_body(page, "wise words")
        button(page, "more").click()
        page.get_by_role("menuitem", name="Quote").click()
        assert body_text(page) == "> wise words", body_text(page)
        page.keyboard.press("End")
        button(page, "more").click()
        page.get_by_role("menuitem", name="Dividing line").click()
        assert body_text(page) == "> wise words\n\n---\n", body_text(page)
        page.keyboard.type("after")
        assert page.locator("#note-editor .cm-jd-hr").count() == 1

        # Emoji: plain text at the caret; the last used come first next time.
        fill_body(page, "Thanks ")
        page.keyboard.press("End")
        button(page, "emoji").click()
        assert page.locator("#emoji-panel").is_visible() and button(page, "emoji").get_attribute("aria-expanded") == "true"
        assert page.locator("#emoji-panel button[data-emoji]").count() >= 60
        page.locator("#emoji-panel").get_by_role("button", name="thumbs up").first.click()
        assert body_text(page) == "Thanks 👍", body_text(page)
        assert page.locator("#emoji-panel").is_hidden()
        page.keyboard.type("!")
        assert body_text(page) == "Thanks 👍!", body_text(page)
        button(page, "emoji").click()
        assert page.locator("#emoji-panel h3").first.inner_text() == "Recently used"
        page.keyboard.press("Escape")
        assert page.locator("#emoji-panel").is_hidden() and page.locator("#editor").get_attribute("open") is not None

        # The Markdown switch shows the whole file; the buttons work there too; switching back keeps the text.
        fill_body(page, "plain words")
        page.locator("#markdown-mode").click()
        assert page.locator("#markdown-mode").inner_text() == "✓ Markdown" and page.locator("#markdown-mode").get_attribute("aria-pressed") == "true"
        assert page.locator("#note-content").input_value() == "# Formatting\n\nplain words"
        page.locator("#note-content").press("Control+End")
        page.locator("#note-content").press("Shift+Control+ArrowLeft")
        button(page, "bold").click()
        assert page.locator("#note-content").input_value() == "# Formatting\n\nplain **words**", page.locator("#note-content").input_value()
        page.locator("#markdown-mode").click()
        assert page.locator("#markdown-mode").inner_text() == "Markdown"
        assert body_text(page) == "plain **words**" and visible_text(page) == "plain words", visible_text(page)

        # A table: inserted under the text with a blank line, the first cell ready for typing; Tab goes on, and Tab
        # in the last cell makes a new row. A | in a cell is escaped in the source.
        fill_body(page, "Intro")
        page.keyboard.press("End")
        button(page, "table").click()
        page.locator("#note-editor .jd-cell textarea").wait_for()
        assert page.evaluate(SHADOW_FOCUS) == "jd-cell-input"
        assert page.locator("#table-bar").is_visible() and page.locator("#format-bar").is_hidden()
        for text in ["Name", "Qty", "Note", "Apples", "3", "a | b", "Pears", "12"]:
            page.keyboard.type(text)
            page.keyboard.press("Tab")
        page.keyboard.type("ripe")
        page.keyboard.press("Tab")
        page.keyboard.type("Plums")
        page.locator("#note-editor .jd-cell textarea").press("Enter")
        lines = body_text(page).split("\n")
        assert lines == ["Intro", "", "| Name | Qty | Note |", "| --- | --- | --- |", "| Apples | 3 | a \\| b |", "| Pears | 12 | ripe |", "| Plums |  |  |"], lines
        assert page.locator("#note-editor .jd-grid tbody tr").count() == 3
        # The table bar: rows and columns in and out, alignment, formatting inside a cell, all as small source edits.
        page.locator('#note-editor .jd-cell[data-row="1"][data-column="1"]').click()
        table_button(page, "addColumn").click()
        assert body_text(page).split("\n")[2:5] == ["| Name | Qty |  | Note |", "| --- | --- | --- | --- |", "| Apples | 3 |  | a \\| b |"], body_text(page)
        page.keyboard.type("x")
        table_button(page, "deleteColumn").click()
        assert body_text(page).split("\n")[2] == "| Name | Qty | Note |", body_text(page)
        table_button(page, "addRow").click()
        assert body_text(page).split("\n")[4:6] == ["| Apples | 3 | a \\| b |", "|  |  |  |"], body_text(page)
        table_button(page, "deleteRow").click()
        assert len(body_text(page).split("\n")) == 7, body_text(page)
        # After "− Column" the caret stays in the third column; only the delimiter line changes.
        table_button(page, "alignRight").click()
        assert body_text(page).split("\n")[3] == "| --- | --- | ---: |", body_text(page)
        assert page.locator('#note-editor .jd-grid thead th').nth(2).get_attribute("class") == "jd-align-right"
        page.locator('#note-editor .jd-cell[data-row="1"][data-column="0"]').click()
        page.keyboard.press("ControlOrMeta+a")
        table_button(page, "bold").click()
        page.keyboard.press("Tab")
        assert body_text(page).split("\n")[4] == "| **Apples** | 3 | a \\| b |", body_text(page)
        assert page.locator('#note-editor .jd-cell[data-row="1"][data-column="0"] .jd-bold').inner_text() == "Apples"
        # Escape gives the cell back as it was. The table ends the note, so the focus goes to the strip below it to
        # write under the table: leaving the table writes nothing by itself.
        page.locator('#note-editor .jd-cell[data-row="2"][data-column="0"]').click()
        page.keyboard.type(" changed")
        before = body_text(page)
        page.keyboard.press("Escape")
        assert "| Pears | 12 | ripe |" in body_text(page) and "changed" not in body_text(page) and body_text(page) == before
        assert "jd-grid-strip" in page.evaluate(SHADOW_FOCUS), page.evaluate(SHADOW_FOCUS)
        strip = page.locator("#note-editor .jd-grid-strip-after")
        assert strip.is_visible()
        strip.click()
        page.keyboard.type("Total")
        assert body_text(page).endswith("| Plums |  |  |\n\nTotal"), body_text(page)
        shot(page, "editor-table-light")
        # Delete table asks first (accepted here), then leaves at most one blank line.
        page.locator('#note-editor .jd-cell[data-row="0"][data-column="0"]').click()
        dialogs.clear()
        table_button(page, "deleteTable").click()
        assert dialogs == ["Delete this table? Undo with Ctrl+Z."], dialogs
        assert body_text(page) == "Intro\n\nTotal", body_text(page)
        page.locator("#note-editor .cm-content").press("ControlOrMeta+z")
        assert "| Name | Qty | Note |" in body_text(page), body_text(page)

        # Saving keeps exactly the source.
        saved = body_text(page)
        page.locator('#editor-form button[type="submit"]').click()
        synced(page)

        # A real Obsidian note and the 8-column table: opening and closing without an edit writes nothing.
        for name in ["obsidian-note.md", "decimos.md"]:
            text = (FIXTURES / name).read_text(encoding="utf8").replace("\r\n", "\n")
            page.locator("#new-note").click()
            page.locator("#markdown-mode").click()
            page.locator("#note-path").fill(f"notes/Fixture {name}")
            page.locator("#note-content").fill(text)
            page.locator("#markdown-mode").click()
            page.locator('#editor-form button[type="submit"]').click()
            synced(page)
        for title, name in [("Garden plans", "obsidian-note.md"), ("Lotería", "decimos.md")]:
            text = (FIXTURES / name).read_text(encoding="utf8").replace("\r\n", "\n")
            page.locator(".note-card").filter(has_text=title).first.locator("h3").click()
            body_editor(page)
            assert body_text(page) == body_part(text), (name, body_text(page))
            assert page.locator("#note-content").input_value() == text, name
            assert page.locator("#note-editor .jd-grid").count() == 1
            dialogs.clear()
            page.locator("#close-editor").click()
            assert dialogs == [] and page.locator("#editor").get_attribute("open") is None, (name, dialogs)

        # A wide table on a phone scrolls inside its own frame; the page and the editor do not move sideways.
        page.set_viewport_size({"width": 390, "height": 844})
        page.locator(".note-card").filter(has_text="Lotería").first.locator("h3").click()
        grid = page.locator("#note-editor .jd-grid").first
        grid.wait_for()
        sizes = grid.evaluate("(el) => ({ scroll: el.scrollWidth, width: el.clientWidth, sticky: getComputedStyle(el.querySelector('th')).position })")
        assert sizes["scroll"] > sizes["width"] and sizes["sticky"] == "sticky", sizes
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
        assert page.evaluate("(() => { const d = document.getElementById('editor'); return d.scrollWidth <= d.clientWidth; })()")
        widths = grid.evaluate("(el) => [...el.querySelectorAll('thead th')].map((th) => th.getBoundingClientRect().width)")
        assert max(widths) <= 221, widths
        shot(page, "editor-phone")
        page.locator("#close-editor").click()
        page.set_viewport_size({"width": 1200, "height": 900})

        # A very long note shows raw: no hidden signs, for speed.
        page.locator("#new-note").click()
        fill_body(page, "**x** " * 9000)
        page.keyboard.press("Control+End")
        assert "**x**" in visible_text(page)[:200]
        page.locator("#close-editor").click()

        # Dark: the same editor in the ink colors (a screenshot for a person to judge).
        page.emulate_media(color_scheme="dark")
        page.locator("#new-note").click()
        page.locator("#note-title").fill("Dark")
        fill_body(page, "Some **bold** and ==marked==\n- [ ] task\n- [x] done\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\n> quote and `code`")
        page.keyboard.press("Control+Home")
        shot(page, "editor-dark")
        page.locator("#close-editor").click()
        page.emulate_media(color_scheme="light")

        csp = page.evaluate("window.__csp || []")
        assert csp == [], csp
        assert not errors, errors
        result = {"buttons": True, "signs_at_caret": True, "numbered_enter": True, "markdown_switch": True, "table_grid": True, "table_bar": True,
                  "emoji": True, "unchanged_open_close": True, "phone_wide_table": True, "long_note_raw": True, "csp_clean": True, "saved_source": saved.startswith("Intro")}
        result.update(check_safety_net(context, url))
        return result
    finally:
        if sys.exc_info()[0]:
            print({"body": page.evaluate("document.getElementById('note-content')?.value"), "errors": errors, "dialogs": dialogs, "csp": page.evaluate("window.__csp || []")})
            shot(page, "failure")
        context.close()


def check_safety_net(context, url):
    """When editor.mjs cannot load, the plain text box works as before: never an empty editor."""
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("**/editor.mjs", lambda route: route.abort())
    page.goto(url, wait_until="networkidle")
    if page.locator("#unlock-form").is_visible():
        page.locator("#unlock-password").fill("synthetic format passphrase")
        page.locator("#unlock-password").press("Enter")
    synced(page)
    page.locator("#new-note").click()
    page.wait_for_timeout(500)
    assert page.locator("#note-body").is_visible() and page.locator("#note-editor").is_hidden()
    page.locator("#note-title").fill("Safety net")
    page.locator("#note-body").fill("plain words")
    page.locator("#note-body").press("End")
    page.locator("#note-body").press("Shift+Control+ArrowLeft")
    button(page, "bold").click()
    assert page.locator("#note-body").input_value() == "plain **words**", page.locator("#note-body").input_value()
    page.locator("#note-body").press("Control+End")
    button(page, "table").click()
    assert page.locator("#note-body").input_value() == "plain **words**\n\n|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |", page.locator("#note-body").input_value()
    page.locator('#editor-form button[type="submit"]').click()
    synced(page)
    assert page.evaluate("window.__csp || []") == []
    assert not errors, errors
    page.close()
    return {"safety_net": True}


if __name__ == "__main__":
    main(check_format_editor, history_limit=100)

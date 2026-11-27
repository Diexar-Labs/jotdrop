"""Run: python cloud/list_grips_browser_check.py [msedge|chrome|firefox]. Synthetic check of the checklist grips in the
formatted note editor (design checklists-77-v2, part 24): the handle and the cross on a task line, dragging with a mouse
and with a finger while the lines in between make room, levels by going sideways, letting go on the item's own place,
Escape, Undo and Redo as buttons and keys, Alt+arrows, pasting lines as items, the checklist actions under More, a note
with a table, a long list that scrolls along, the shape without formatting, the Markdown view, less motion, and the
strict CSP (no violations)."""
import os
import sys
from pathlib import Path
sys.dont_write_bytecode = True
from browser_check import body_editor, body_text, fill_body, main
from format_editor_browser_check import CSP_LISTENER, new_context, sign_in

# Screenshots for a person to look at, when JOTDROP_SHOTS names a folder.
SHOTS = os.environ.get("JOTDROP_SHOTS")
LINES = "#note-editor .cm-content .cm-line"
LIST = "- [ ] milk\n- [ ] bread\n\t- [ ] rye\n- [ ] cheese\n- [x] tea"
STATE = """() => {
  const root = document.querySelector('#note-editor .jd-editor-host').shadowRoot;
  const carry = root.querySelector('.cm-jd-carry'), scroller = root.querySelector('.cm-scroller');
  return {
    lines: [...root.querySelectorAll('.cm-content > .cm-line')].map((line) => {
      const box = line.getBoundingClientRect(), grip = line.querySelector('.cm-jd-grip'), look = getComputedStyle(line);
      return {
        text: line.textContent.trim(), classes: line.className, top: box.top, bottom: box.bottom, height: box.height,
        hidden: look.visibility === 'hidden', pad: parseFloat(look.paddingLeft), room: parseFloat(look.paddingRight),
        grip: grip ? { left: grip.getBoundingClientRect().left, width: grip.getBoundingClientRect().width, height: grip.getBoundingClientRect().height } : null,
        cross: Boolean(line.querySelector('.cm-jd-cross')),
      };
    }),
    carry: carry ? { text: carry.textContent, top: carry.getBoundingClientRect().top, left: carry.getBoundingClientRect().left, height: carry.getBoundingClientRect().height } : null,
    frame: Boolean(root.querySelector('.cm-jd-frame')),
    moving: root.querySelector('.cm-editor').classList.contains('cm-jd-moving'),
    focused: Boolean(root.activeElement),
    scroll: scroller.scrollTop,
    box: { top: scroller.getBoundingClientRect().top, bottom: scroller.getBoundingClientRect().bottom, left: scroller.getBoundingClientRect().left },
  };
}"""
PASTE = """(text) => {
  const content = document.querySelector('#note-editor .jd-editor-host').shadowRoot.querySelector('.cm-content');
  const transfer = new DataTransfer();
  transfer.setData('text/plain', text);
  // Firefox fills the event's clipboard from `data` and `dataType`, the others from `clipboardData`.
  content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, dataType: 'text/plain', data: text, bubbles: true, cancelable: true }));
}"""


def shot(page, name):
    if SHOTS:
        # A screenshot is Playwright's doing: in WebKit it puts a style block of its own in the page, which the CSP
        # refuses and reports. Those reports are not the page's, so they are taken off the list again.
        reports = page.evaluate("(window.__csp || []).length")
        page.screenshot(path=str(Path(SHOTS) / f"grips-{name}.png"))
        page.wait_for_timeout(150)
        page.evaluate("(count) => { if (window.__csp) window.__csp.length = count; }", reports)


def state(page):
    return page.evaluate(STATE)


def row(page, word):
    """The drawn line with `word` in it."""
    found = [line for line in state(page)["lines"] if word in line["text"]]
    assert found, f"no line with {word!r}"
    return found[0]


def history(page, name):
    return page.locator(f'#format-bar [data-history="{name}"]')


def new_note(page, text):
    """A new note with this text in the formatted editor."""
    page.locator("#new-note").click()
    fill_body(page, text)
    assert body_text(page) == text, body_text(page)


def close_note(page):
    page.once("dialog", lambda dialog: dialog.accept())
    page.locator("#close-editor").click()
    page.locator("#editor").wait_for(state="hidden")


def grip_point(page, word):
    grip = row(page, word)["grip"]
    assert grip, f"no handle on {word!r}"
    line = row(page, word)
    return grip["left"] + grip["width"] / 2, line["top"] + min(line["height"] / 2, 12)


def drag(page, word, to_y, dx=0, during=None, release=True):
    """Takes the handle of the task with `word` and brings it to height `to_y`, `dx` to the side; `during` looks at the
    page while the mouse button is still down."""
    x, y = grip_point(page, word)
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + dx / 2, (y + to_y) / 2, steps=6)
    page.mouse.move(x + dx, to_y, steps=6)
    page.wait_for_timeout(300)
    seen = during(page) if during else None
    if release:
        page.mouse.up()
        page.wait_for_timeout(300)
    return seen


def check_shape(page):
    """Handles on tasks only, all in one column; the whole list stands to the right; the cross only at the caret."""
    new_note(page, LIST + "\n- eggs\n\nplain words\n\n- only a bullet")
    # The caret stands in a task and then leaves the editor: no cross without the focus.
    page.locator(LINES, has_text="cheese").first.click()
    page.locator("#note-title").click()
    page.wait_for_timeout(150)
    seen = state(page)
    tasks = [line for line in seen["lines"] if line["grip"]]
    assert [line["text"].split()[-1] for line in tasks] == ["milk", "bread", "rye", "cheese", "tea"], [line["text"] for line in tasks]
    assert len({round(line["grip"]["left"]) for line in tasks}) == 1, "the handles stand in one column"
    assert all(line["grip"]["width"] >= 30 and line["grip"]["height"] >= line["height"] - 1 for line in tasks), tasks
    # The bullet in the list with tasks stands to the right with it; plain text and a list without a task do not.
    shifted = {line["text"]: "cm-jd-shift" in line["classes"] for line in seen["lines"] if line["text"]}
    assert shifted["• eggs"] and not shifted["plain words"] and not shifted["• only a bullet"], shifted
    assert row(page, "eggs")["pad"] > row(page, "only a bullet")["pad"]
    assert not any(line["cross"] for line in seen["lines"]), "no cross without the focus"
    heights = [line["height"] for line in seen["lines"]]
    page.locator(LINES, has_text="bread").first.click()
    seen = state(page)
    assert [line["text"].split()[-1] for line in seen["lines"] if line["cross"]] == ["bread"], "one cross, on the task with the caret"
    assert [line["height"] for line in seen["lines"]] == heights, "the caret coming to a line does not wrap it anew"
    assert all(line["room"] >= 20 for line in seen["lines"] if line["grip"])
    page.locator(LINES, has_text="eggs").first.click()
    assert not any(line["cross"] for line in state(page)["lines"]), "no cross on a bullet"
    shot(page, "shape")
    close_note(page)
    return {"handles": len(tasks), "handle_width": tasks[0]["grip"]["width"]}


def check_mouse(page):
    """Dragging with the mouse: the lines in between make room, the text changes on release only, and once."""
    new_note(page, LIST)
    undo, redo = history(page, "undo"), history(page, "redo")
    assert undo.is_enabled() and redo.is_disabled()
    # The caret at the end of "tea": it stays there through every drag below.
    page.locator(LINES, has_text="tea").first.click()
    page.keyboard.press("End")
    before = {word: row(page, word) for word in ["milk", "bread", "rye", "cheese", "tea"]}

    def midway(page):
        seen = state(page)
        now = {word: next(line for line in seen["lines"] if word in line["text"]) for word in before}
        assert seen["carry"] and "milk" in seen["carry"]["text"], seen["carry"]
        assert now["milk"]["hidden"], "the item's own line is not drawn while its copy is on its way"
        for word in ["bread", "rye", "cheese"]:
            assert "cm-jd-up" in now[word]["classes"], (word, now[word]["classes"])
            assert abs(now[word]["top"] - (before[word]["top"] - before["milk"]["height"])) < 1.5, (word, now[word]["top"], before[word]["top"])
        assert abs(now["tea"]["top"] - before["tea"]["top"]) < 1 and "cm-jd-up" not in now["tea"]["classes"]
        assert seen["moving"] and body_text(page) == LIST, "the text does not change during a drag"
        shot(page, "mouse-midway")
        return True

    assert drag(page, "milk", before["tea"]["top"], during=midway)
    moved = "- [ ] bread\n\t- [ ] rye\n- [ ] cheese\n- [ ] milk\n- [x] tea"
    assert body_text(page) == moved, body_text(page)
    seen = state(page)
    assert not seen["carry"] and seen["frame"] and seen["focused"], seen
    assert not any(line["hidden"] for line in seen["lines"])
    shot(page, "mouse-landed")
    page.wait_for_timeout(800)
    assert not state(page)["frame"], "the frame around the item that landed fades and goes"
    # One drag is one step, for the buttons and for the keys.
    undo.click()
    assert body_text(page) == LIST and redo.is_enabled()
    redo.click()
    assert body_text(page) == moved
    page.keyboard.press("ControlOrMeta+z")
    assert body_text(page) == LIST
    page.keyboard.press("ControlOrMeta+y")
    assert body_text(page) == moved
    # An item takes along what hangs under it.
    seen = drag(page, "bread", row(page, "tea")["top"], during=lambda page: state(page)["carry"]["text"])
    assert "bread" in seen and "rye" in seen, seen
    assert body_text(page) == "- [ ] cheese\n- [ ] milk\n- [ ] bread\n\t- [ ] rye\n- [x] tea", body_text(page)
    # Upward, to the very top: the lines it passes go down a block. And past the end of the note.
    was = {word: row(page, word) for word in ["cheese", "milk", "bread"]}

    def upward(page):
        now = {word: row(page, word) for word in was}
        assert "cm-jd-down" in now["cheese"]["classes"] and abs(now["cheese"]["top"] - (was["cheese"]["top"] + was["milk"]["height"])) < 1.5, (now["cheese"], was["cheese"])
        assert now["milk"]["hidden"] and "cm-jd-down" not in now["bread"]["classes"] and abs(now["bread"]["top"] - was["bread"]["top"]) < 1
        return True

    assert drag(page, "milk", row(page, "cheese")["top"] - 4, during=upward)
    assert body_text(page) == "- [ ] milk\n- [ ] cheese\n- [ ] bread\n\t- [ ] rye\n- [x] tea", body_text(page)
    drag(page, "milk", row(page, "tea")["bottom"] + 6)
    assert body_text(page) == "- [ ] cheese\n- [ ] bread\n\t- [ ] rye\n- [x] tea\n- [ ] milk", body_text(page)
    # The caret stayed in its own words all along.
    page.keyboard.type("Z")
    assert body_text(page) == "- [ ] cheese\n- [ ] bread\n\t- [ ] rye\n- [x] teaZ\n- [ ] milk", body_text(page)
    close_note(page)
    return {"dragged": True}


def check_levels_and_no_drop(page):
    """Sideways is a level; letting go on the own place, Escape and a click change nothing."""
    new_note(page, LIST)
    line = row(page, "bread")
    # 30 px to the right on its own place: a sub-item of the task above.
    drag(page, "bread", line["top"] + 10, dx=30)
    inside = "- [ ] milk\n\t- [ ] bread\n\t\t- [ ] rye\n- [ ] cheese\n- [x] tea"
    assert body_text(page) == inside, body_text(page)
    drag(page, "bread", row(page, "bread")["top"] + 10, dx=-30)
    assert body_text(page) == LIST, body_text(page)
    # The copy stands a level further in while the pointer is there.
    lefts = drag(page, "cheese", row(page, "cheese")["top"] + 10, dx=30, during=lambda page: (state(page)["carry"]["left"], state(page)["box"]["left"]))
    assert lefts[0] - lefts[1] > 15, lefts
    assert body_text(page) == "- [ ] milk\n- [ ] bread\n\t- [ ] rye\n\t- [ ] cheese\n- [x] tea", body_text(page)
    page.keyboard.press("ControlOrMeta+z")
    assert body_text(page) == LIST
    # A click on a handle, and a drag that comes back to its own place: nothing, and nothing to undo.
    x, y = grip_point(page, "milk")
    page.mouse.click(x, y)
    drag(page, "milk", row(page, "milk")["top"] + 14)
    assert body_text(page) == LIST and not state(page)["frame"]
    page.keyboard.press("ControlOrMeta+z")
    assert body_text(page) != LIST, "the last step was still the one before the drags"
    page.keyboard.press("ControlOrMeta+y")
    assert body_text(page) == LIST
    # Escape puts the item back and does not close the note.
    drag(page, "milk", row(page, "tea")["top"], during=lambda page: page.keyboard.press("Escape"), release=False)
    page.wait_for_timeout(300)
    assert body_text(page) == LIST and page.locator("#editor").evaluate("dialog => dialog.open")
    seen = state(page)
    assert not seen["carry"] and not seen["moving"] and not any(line["hidden"] or "cm-jd-up" in line["classes"] for line in seen["lines"]), seen
    page.mouse.up()
    page.wait_for_timeout(200)
    assert body_text(page) == LIST
    close_note(page)
    return {"levels": True}


def check_cross_and_keys(page):
    """The cross deletes the item with what hangs under it; Alt+arrows move an item; lines pasted in an item are items."""
    new_note(page, LIST)
    page.locator(LINES, has_text="bread").first.click()
    page.locator("#note-editor .cm-jd-cross").click()
    assert body_text(page) == "- [ ] milk\n- [ ] cheese\n- [x] tea", body_text(page)
    notice = page.locator("#list-notice")
    assert notice.is_visible() and page.locator("#list-notice-text").inner_text() == "Item and 1 sub-item deleted"
    assert state(page)["focused"], "the caret stays in the editor"
    # The caret went to the end of the line above.
    page.keyboard.type("!")
    assert body_text(page) == "- [ ] milk!\n- [ ] cheese\n- [x] tea", body_text(page)
    assert notice.is_hidden(), "the next change sends the notice off"
    page.keyboard.press("ControlOrMeta+z")
    assert body_text(page) == "- [ ] milk\n- [ ] cheese\n- [x] tea", ("one Undo for the typing", body_text(page))
    page.keyboard.press("ControlOrMeta+z")
    assert body_text(page) == LIST, ("and one for the cross", body_text(page))
    # One item without sub-items: no notice. The cross of the notice sends it off.
    page.locator(LINES, has_text="cheese").first.click()
    page.locator("#note-editor .cm-jd-cross").click()
    assert body_text(page) == "- [ ] milk\n- [ ] bread\n\t- [ ] rye\n- [x] tea" and notice.is_hidden()
    page.locator(LINES, has_text="bread").first.click()
    page.locator("#note-editor .cm-jd-cross").click()
    assert notice.is_visible()
    page.locator("#list-notice-dismiss").click()
    assert notice.is_hidden() and body_text(page) == "- [ ] milk\n- [x] tea"
    close_note(page)

    new_note(page, LIST + "\n\none\ntwo")
    page.locator(LINES, has_text="bread").first.click()
    page.keyboard.press("Alt+ArrowDown")
    assert body_text(page) == "- [ ] milk\n- [ ] cheese\n- [ ] bread\n\t- [ ] rye\n- [x] tea\n\none\ntwo", body_text(page)
    page.keyboard.press("Alt+ArrowUp")
    page.keyboard.press("Alt+ArrowUp")
    assert body_text(page) == "- [ ] bread\n\t- [ ] rye\n- [ ] milk\n- [ ] cheese\n- [x] tea\n\none\ntwo", body_text(page)
    page.keyboard.press("Alt+ArrowUp")
    assert body_text(page) == "- [ ] bread\n\t- [ ] rye\n- [ ] milk\n- [ ] cheese\n- [x] tea\n\none\ntwo", "the first of its siblings stays"
    page.keyboard.press("ControlOrMeta+z")
    assert body_text(page) == "- [ ] milk\n- [ ] bread\n\t- [ ] rye\n- [ ] cheese\n- [x] tea\n\none\ntwo", "one Alt+arrow is one step"
    # A letter typed right after a move is a step of its own: Undo takes the letter and leaves the item where it went.
    page.keyboard.press("Alt+ArrowDown")
    page.keyboard.type("q")
    page.keyboard.press("ControlOrMeta+z")
    assert body_text(page) == "- [ ] milk\n- [ ] cheese\n- [ ] bread\n\t- [ ] rye\n- [x] tea\n\none\ntwo", body_text(page)
    page.keyboard.press("ControlOrMeta+z")
    assert body_text(page) == "- [ ] milk\n- [ ] bread\n\t- [ ] rye\n- [ ] cheese\n- [x] tea\n\none\ntwo", body_text(page)
    # Off a list the keys move the line, as they did.
    page.locator(LINES, has_text="one").first.click()
    page.keyboard.press("Alt+ArrowDown")
    assert body_text(page).endswith("\n\ntwo\none"), body_text(page)
    # Lines pasted at the end of a task are tasks of their own; off a list a paste is a paste.
    page.locator(LINES, has_text="cheese").first.click()
    page.keyboard.press("End")
    page.evaluate(PASTE, "cake\nolives\n- [x] wine")
    assert "- [ ] cheesecake\n- [ ] olives\n- [x] wine\n- [x] tea" in body_text(page), body_text(page)
    page.locator(LINES, has_text="two").first.click()
    page.keyboard.press("End")
    page.evaluate(PASTE, "a\nb")
    assert body_text(page).endswith("\n\ntwoa\nb\none"), body_text(page)
    close_note(page)
    return {"cross": True}


def check_menu(page):
    """Under More: the item with the caret up, down and gone; the whole note unticked, and its ticked tasks gone."""
    new_note(page, LIST + "\n- [x] jam")
    more = page.locator('#format-bar [data-format="more"]')
    menu = page.locator(".card-menu")

    def choose(label):
        more.click()
        menu.get_by_role("menuitem", name=label, exact=True).click()

    page.locator(LINES, has_text="bread").first.click()
    more.click()
    labels = menu.get_by_role("menuitem").all_inner_texts()
    assert labels[-5:] == ["Move up", "Move down", "Delete item", "Uncheck all items", "Delete checked items"], labels
    page.keyboard.press("Escape")
    choose("Move down")
    assert body_text(page) == "- [ ] milk\n- [ ] cheese\n- [ ] bread\n\t- [ ] rye\n- [x] tea\n- [x] jam", body_text(page)
    choose("Move up")
    assert body_text(page) == LIST + "\n- [x] jam"
    choose("Delete checked items")
    assert body_text(page) == "- [ ] milk\n- [ ] bread\n\t- [ ] rye\n- [ ] cheese", body_text(page)
    assert page.locator("#list-notice-text").inner_text() == "2 checked items deleted"
    page.keyboard.press("ControlOrMeta+z")
    assert body_text(page) == LIST + "\n- [x] jam", "a menu action is one step"
    choose("Uncheck all items")
    assert body_text(page) == "- [ ] milk\n- [ ] bread\n\t- [ ] rye\n- [ ] cheese\n- [ ] tea\n- [ ] jam", body_text(page)
    assert page.locator("#list-notice-text").inner_text() == "All items unchecked"
    choose("Delete item")
    assert "bread" not in body_text(page) and page.locator("#list-notice-text").inner_text() == "Item and 1 sub-item deleted"
    # Nothing ticked and the caret off a list: only the formatting is offered.
    close_note(page)
    new_note(page, "plain words")
    more.click()
    assert menu.get_by_role("menuitem").all_inner_texts() == ["Strikethrough", "Quote", "Code", "Dividing line"]
    page.keyboard.press("Escape")
    close_note(page)
    return {"menu": True}


def check_tick_is_a_step(page):
    """A tick right after typing is a step of its own for Undo."""
    new_note(page, "- [ ] milk")
    page.locator(LINES, has_text="milk").first.click()
    page.keyboard.press("End")
    page.keyboard.type("s")
    page.locator("#note-editor .cm-jd-box").click()
    assert body_text(page) == "- [x] milks"
    page.keyboard.press("ControlOrMeta+z")
    assert body_text(page) == "- [ ] milks", body_text(page)
    close_note(page)
    return {"tick_step": True}


def check_table_and_scroll(page):
    """An item stays on its own side of a table; a long list scrolls along with a drag."""
    table = "\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n"
    new_note(page, "- [ ] one\n- [ ] two" + table + "- [ ] three")
    assert sum(1 for line in state(page)["lines"] if line["grip"]) == 3
    drag(page, "one", row(page, "three")["bottom"] + 4)
    assert body_text(page) == "- [ ] two\n- [ ] one" + table + "- [ ] three", body_text(page)
    close_note(page)

    many = "\n".join(f"- [ ] item {number:02d}" for number in range(60))
    new_note(page, many)
    page.locator("#note-title").click()
    scroller = "document.querySelector('#note-editor .jd-editor-host').shadowRoot.querySelector('.cm-scroller')"
    page.evaluate(f"{scroller}.scrollTop = 0")
    page.wait_for_timeout(200)
    box = state(page)["box"]
    x, y = grip_point(page, "item 00")
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x, box["bottom"] - 8, steps=8)
    # The pointer rests at the lower edge: the note keeps scrolling, and the copy stays at the pointer.
    for _ in range(100):
        if page.evaluate(f"{scroller}.scrollTop + {scroller}.clientHeight >= {scroller}.scrollHeight - 2"):
            break
        page.wait_for_timeout(200)
    else:
        raise AssertionError("the note did not scroll along to its end")
    seen = state(page)
    assert seen["carry"] and box["top"] < seen["carry"]["top"] < box["bottom"], seen["carry"]
    assert not seen["focused"], "a drag does not give the editor the focus"
    shot(page, "scrolled")
    page.mouse.up()
    page.wait_for_timeout(300)
    lines = body_text(page).split("\n")
    assert len(lines) == 60 and lines[0] == "- [ ] item 01" and "- [ ] item 00" in lines[-3:], lines[-4:]
    assert sorted(lines) == sorted(many.split("\n"))
    close_note(page)
    return {"table": True, "scrolled": True}


def check_table_bar(page):
    """Undo and Redo stand in the table bar too: what was typed in the open cell goes back, and the table bar stays."""
    table = "| a | b |\n| --- | --- |\n| 1 | 2 |"
    new_note(page, table)
    page.locator('#note-editor .jd-cell[data-row="1"][data-column="0"]').click()
    page.locator("#note-editor .jd-cell textarea").wait_for()
    page.keyboard.type("9")
    undo, redo = page.locator('#table-bar [data-history="undo"]'), page.locator('#table-bar [data-history="redo"]')
    assert page.locator("#table-bar").is_visible() and page.locator("#format-bar").is_hidden() and undo.is_enabled()
    undo.click()
    assert body_text(page) == table, body_text(page)
    page.wait_for_timeout(150)
    assert page.locator("#table-bar").is_visible(), "the table bar stays after Undo in a cell"
    redo.click()
    assert "9" in body_text(page) and body_text(page) != table, body_text(page)
    close_note(page)
    return {"table_bar": True}


def check_raw_shape(page):
    """Without formatting (as Joplin and Obsidian will show it): handle and cross, the signs stay; and no grips at all
    above 50,000 characters."""
    seen = page.evaluate("""async () => {
      const { createBodyEditor } = await import('/editor.mjs');
      const make = (value) => {
        const parent = document.createElement('div');
        parent.id = 'raw-probe';
        // In view whatever the page has scrolled to (set through the CSSOM, which the CSP allows).
        for (const [name, value] of [['position', 'fixed'], ['left', '40px'], ['top', '40px'], ['width', '520px'], ['z-index', '50'], ['background', 'var(--page)']]) parent.style.setProperty(name, value);
        document.body.prepend(parent);
        return createBodyEditor({ parent, value, formatted: false });
      };
      const big = make('- [ ] task\\n' + 'x'.repeat(50001));
      const grips = big.element.shadowRoot.querySelectorAll('.cm-jd-grip').length;
      big.destroy();
      document.getElementById('raw-probe').remove();
      window.rawEditor = make('- [ ] milk\\n- [ ] bread\\n- [x] tea');
      const lines = [...window.rawEditor.element.shadowRoot.querySelectorAll('.cm-content > .cm-line')];
      return { big: grips, texts: lines.map((line) => line.textContent), grips: lines.filter((line) => line.querySelector('.cm-jd-grip')).length, boxes: window.rawEditor.element.shadowRoot.querySelectorAll('.cm-jd-box').length };
    }""")
    assert seen == {"big": 0, "texts": ["- [ ] milk", "- [ ] bread", "- [x] tea"], "grips": 3, "boxes": 0}, seen
    box = page.evaluate("""() => {
      const lines = [...window.rawEditor.element.shadowRoot.querySelectorAll('.cm-content > .cm-line')];
      const grip = lines[0].querySelector('.cm-jd-grip').getBoundingClientRect(), last = lines[2].getBoundingClientRect();
      return { x: grip.left + grip.width / 2, y: grip.top + grip.height / 2, to: last.bottom + 4 };
    }""")
    page.mouse.move(box["x"], box["y"])
    page.mouse.down()
    page.mouse.move(box["x"], box["to"], steps=8)
    page.wait_for_timeout(250)
    shot(page, "raw")
    page.mouse.up()
    page.wait_for_timeout(300)
    assert page.evaluate("window.rawEditor.getValue()") == "- [ ] bread\n- [x] tea\n- [ ] milk"
    # The cross on the line with the caret.
    page.evaluate("window.rawEditor.focus()")
    page.wait_for_timeout(150)
    assert page.evaluate("window.rawEditor.element.shadowRoot.querySelectorAll('.cm-jd-cross').length") == 1
    page.evaluate("window.rawEditor.element.shadowRoot.querySelector('.cm-jd-cross').click()")
    # The caret was in "milk" and went along with it: that is the line the cross stands on.
    assert page.evaluate("window.rawEditor.getValue()") == "- [ ] bread\n- [x] tea", page.evaluate("window.rawEditor.getValue()")
    page.evaluate("window.rawEditor.destroy(); document.getElementById('raw-probe').remove()")
    return {"raw": True}


def check_markdown_view(page):
    """The Markdown view is a plain text box: no grips there, but the keys, the paste rule, the buttons and the menu work."""
    page.locator("#new-note").click()
    body_editor(page)
    page.locator("#markdown-mode").click()
    area = page.locator("#note-content")
    area.fill(LIST)
    assert history(page, "undo").is_enabled() and history(page, "redo").is_enabled()
    area.evaluate("area => area.setSelectionRange(12, 12)")
    area.press("Alt+ArrowUp")
    assert area.input_value() == "- [ ] bread\n\t- [ ] rye\n- [ ] milk\n- [ ] cheese\n- [x] tea", area.input_value()
    history(page, "undo").click()
    assert area.input_value() == LIST, area.input_value()
    area.evaluate("""area => {
      area.setSelectionRange(10, 10);
      const transfer = new DataTransfer();
      transfer.setData('text/plain', 'shake\\nbutter');
      area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, dataType: 'text/plain', data: 'shake\\nbutter', bubbles: true, cancelable: true }));
    }""")
    assert area.input_value().startswith("- [ ] milkshake\n- [ ] butter\n- [ ] bread"), area.input_value()
    page.locator('#format-bar [data-format="more"]').click()
    page.locator(".card-menu").get_by_role("menuitem", name="Uncheck all items", exact=True).click()
    assert area.input_value().endswith("- [ ] tea") and page.locator("#list-notice-text").inner_text() == "All items unchecked"
    page.locator("#markdown-mode").click()
    close_note(page)
    return {"markdown_view": True}


def check_less_motion(page):
    """With "reduce motion" set on the device nothing slides: the lines stand a block further at once, and the item is
    in its place the moment it is let go. The frame around it still shows where it landed."""
    page.emulate_media(reduced_motion="reduce")
    new_note(page, LIST)

    def midway(page):
        seen = state(page)
        assert seen["carry"] and not seen["moving"], seen
        assert all("cm-jd-up" in line["classes"] for line in seen["lines"] if any(word in line["text"] for word in ["bread", "rye", "cheese"]))
        return True

    x, y = grip_point(page, "milk")
    to = row(page, "tea")["top"]
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x, to, steps=6)
    page.wait_for_timeout(150)
    assert midway(page)
    page.mouse.up()
    seen = state(page)
    assert not seen["carry"] and seen["frame"] and not any(line["hidden"] for line in seen["lines"]), seen
    assert body_text(page) == "- [ ] bread\n\t- [ ] rye\n- [ ] cheese\n- [ ] milk\n- [x] tea", body_text(page)
    page.emulate_media(reduced_motion="no-preference")
    close_note(page)
    return {"less_motion": True}


def check_touch(browser, url, token):
    """A finger on a phone: the handle is 40 px wide, a drag moves the item while the lines make room, the page does not
    scroll, no keyboard opens, and a tap on a handle does nothing. Touches are sent through the debugger, so this part
    runs in a Chromium browser only."""
    if browser.browser_type.name != "chromium":
        return {"touch": "not run: needs a Chromium browser"}
    context = browser.new_context(viewport={"width": 390, "height": 780}, has_touch=True, is_mobile=True)
    context.add_init_script("try { localStorage.setItem('jotdrop-editor-mode', 'simple'); } catch {}")
    context.add_init_script(CSP_LISTENER)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        sign_in(page, url, token)
        assert page.evaluate("matchMedia('(pointer: coarse)').matches")
        new_note(page, LIST)
        # The focus leaves the editor, as after closing the keyboard: a drag must not bring it back.
        page.evaluate("document.querySelector('#note-editor .jd-editor-host').shadowRoot.activeElement?.blur()")
        page.wait_for_timeout(150)
        seen = state(page)
        tasks = [line for line in seen["lines"] if line["grip"]]
        assert len(tasks) == 5 and all(line["grip"]["width"] >= 40 for line in tasks), tasks
        assert not seen["focused"]
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth"), "the page is not wider than the phone"
        places = "[scrollX, scrollY, document.getElementById('editor').scrollTop]"
        scrolled = page.evaluate(places)
        cdp = context.new_cdp_session(page)

        def touch(kind, x=None, y=None):
            cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [] if x is None else [{"x": x, "y": y}]})

        # A tap on a handle: nothing.
        x, y = grip_point(page, "milk")
        touch("touchStart", x, y)
        touch("touchEnd")
        page.wait_for_timeout(200)
        assert body_text(page) == LIST and not state(page)["carry"]
        # A drag: down past "cheese".
        before = {word: row(page, word) for word in ["milk", "bread", "cheese", "tea"]}
        to = before["tea"]["top"]
        touch("touchStart", x, y)
        for step in range(1, 9):
            touch("touchMove", x, y + (to - y) * step / 8)
        page.wait_for_timeout(300)
        seen = state(page)
        now = {word: next(line for line in seen["lines"] if word in line["text"]) for word in before}
        assert seen["carry"] and "milk" in seen["carry"]["text"] and now["milk"]["hidden"], seen
        assert abs(now["cheese"]["top"] - (before["cheese"]["top"] - before["milk"]["height"])) < 1.5, (now["cheese"]["top"], before["cheese"]["top"])
        assert body_text(page) == LIST
        shot(page, "touch-midway")
        touch("touchEnd")
        page.wait_for_timeout(300)
        assert body_text(page) == "- [ ] bread\n\t- [ ] rye\n- [ ] cheese\n- [ ] milk\n- [x] tea", body_text(page)
        seen = state(page)
        assert not seen["focused"], "no keyboard opens from a drag"
        assert page.evaluate(places) == scrolled, "the page did not scroll under the finger"
        # Sideways with a finger: a level in.
        x, y = grip_point(page, "milk")
        touch("touchStart", x, y)
        for step in range(1, 7):
            touch("touchMove", x + 5 * step, y)
        page.wait_for_timeout(200)
        touch("touchEnd")
        page.wait_for_timeout(300)
        assert body_text(page) == "- [ ] bread\n\t- [ ] rye\n- [ ] cheese\n\t- [ ] milk\n- [x] tea", body_text(page)
        # The browser breaks the gesture off: the item goes back.
        x, y = grip_point(page, "bread")
        touch("touchStart", x, y)
        for step in range(1, 7):
            touch("touchMove", x, y + 12 * step)
        page.wait_for_timeout(200)
        assert state(page)["carry"]
        touch("touchCancel")
        page.wait_for_timeout(300)
        assert body_text(page) == "- [ ] bread\n\t- [ ] rye\n- [ ] cheese\n\t- [ ] milk\n- [x] tea" and not state(page)["carry"]
        # The two buttons on a phone, where no Ctrl+Z is at hand.
        history(page, "undo").click()
        assert body_text(page) == "- [ ] bread\n\t- [ ] rye\n- [ ] cheese\n- [ ] milk\n- [x] tea", body_text(page)
        shot(page, "touch-end")
        close_note(page)
        # A task too long for the phone wraps under its own words; its handle is as high as all of its rows, and the
        # whole of it comes along.
        long = "a task with so many words that it will not fit on one row of a phone screen at all"
        new_note(page, f"- [ ] {long}\n- [ ] short")
        page.evaluate("document.querySelector('#note-editor .jd-editor-host').shadowRoot.activeElement?.blur()")
        page.wait_for_timeout(150)
        wide, short = row(page, "many words"), row(page, "short")
        assert wide["height"] > short["height"] * 1.8 and wide["grip"]["height"] >= wide["height"] - 1, (wide, short)
        x, y = grip_point(page, "many words")
        to = short["bottom"] + 6
        touch("touchStart", x, y)
        for step in range(1, 9):
            touch("touchMove", x, y + (to - y) * step / 8)
        page.wait_for_timeout(300)
        seen = state(page)
        assert abs(seen["carry"]["height"] - wide["height"]) < 2, (seen["carry"], wide)
        shot(page, "touch-wrapped")
        touch("touchEnd")
        page.wait_for_timeout(300)
        assert body_text(page) == f"- [ ] short\n- [ ] {long}", body_text(page)
        assert page.evaluate("window.__csp || []") == [], page.evaluate("window.__csp")
        assert not errors, errors
    finally:
        context.close()
    return {"touch": True, "touch_handle_width": tasks[0]["grip"]["width"]}


def check_list_grips(browser, url, token):
    context = new_context(browser)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    result = {}
    try:
        sign_in(page, url, token)
        for check in [check_shape, check_mouse, check_levels_and_no_drop, check_cross_and_keys, check_menu, check_tick_is_a_step, check_table_and_scroll, check_table_bar, check_raw_shape, check_markdown_view, check_less_motion]:
            result.update(check(page))
            # After every part, so a violation names the part it came from.
            assert page.evaluate("window.__csp || []") == [], (check.__name__, page.evaluate("window.__csp"))
        assert not errors, errors
    finally:
        context.close()
    return result


if __name__ == "__main__":
    main(check_list_grips, history_limit=100)
    main(check_touch, history_limit=100)

"""Run: python cloud/checked_part_browser_check.py [msedge|chrome|firefox|webkit]. Synthetic check of the checked items
as a part of their own in the formatted note editor (design checklists-77-v2, part 6 and part 25), with "Move checked
items to the bottom" on: the row "+ List item" and the header that counts and folds them, folded lines that stay in the
text, the fold kept per note on this browser, Enter, Backspace and pasting among checked items, the way to a line under
a list that ends the note, nothing dragged or moved past a header, Undo in a folded part, a selection when the part
folds, a table under the checked items, a long list, less motion, a CRLF text, a finger on a phone, nothing of it with
the setting off or without formatting, and the strict CSP (no violations)."""
import json
import re
import sys
sys.dont_write_bytecode = True
from browser_check import body_text, fill_body, main
from format_editor_browser_check import CSP_LISTENER, new_context, sign_in
from list_grips_browser_check import LINES, PASTE, close_note, drag, grip_point, history, new_note, row, shot, state

ROOT = "document.querySelector('#note-editor .jd-editor-host').shadowRoot"
LIST = "- [ ] milk\n- [ ] bread\n- [x] eggs\n\t- [x] yolk\n- [x] cheese"
UNDER = LIST + "\n\nwords under"
# What stands in the editor from top to bottom: a line of the note, or a bar with its row and its header.
SEEN = """() => {
  const root = document.querySelector('#note-editor .jd-editor-host').shadowRoot;
  return {
    rows: [...root.querySelectorAll('.cm-content > .cm-line, .cm-content > .cm-jd-part')].map((element) => {
      const box = element.getBoundingClientRect(), fold = element.querySelector('.cm-jd-fold'), add = element.querySelector('.cm-jd-add');
      return element.matches('.cm-jd-part')
        ? { bar: true, add: add ? add.textContent : null, fold: fold ? fold.textContent : null, open: fold ? fold.getAttribute('aria-expanded') : null, title: fold ? fold.title : null, top: box.top, bottom: box.bottom, sign: (fold || add).querySelector('.cm-jd-sign').getBoundingClientRect().left, height: (fold || add).getBoundingClientRect().height }
        : { text: element.textContent.trim(), top: box.top, bottom: box.bottom, grip: Boolean(element.querySelector('.cm-jd-grip')), sign: element.querySelector('.cm-jd-box')?.getBoundingClientRect().left ?? null };
    }),
    focused: Boolean(root.activeElement),
    end: root.querySelector('.cm-content').lastElementChild.getBoundingClientRect().bottom,
    box: root.querySelector('.cm-scroller').getBoundingClientRect().toJSON(),
  };
}"""


def seen(page):
    return page.evaluate(SEEN)


def shape(page):
    """The rows as words: a line by its text, a bar by its header (or '+' for the row alone)."""
    return [(f"[{entry['fold']}]" if entry["fold"] else "[+]") if entry.get("bar") else entry["text"] for entry in seen(page)["rows"]]


def bars(page):
    return [entry for entry in seen(page)["rows"] if entry.get("bar")]


def press(page, name, index=0):
    """A click on "+ List item" (`add`) or on a header (`fold`), with a real mouse."""
    page.evaluate_handle(f"{ROOT}.querySelectorAll('.cm-jd-{name}')[{index}]").as_element().click()
    page.wait_for_timeout(150)


def blur(page):
    page.evaluate(f"{ROOT}.activeElement?.blur()")
    page.wait_for_timeout(100)


def caret_at_end_of(page, word):
    page.locator(LINES, has_text=word).first.click()
    page.keyboard.press("End")


def set_move_checked(page, on):
    """The switch in the top bar; it cannot be reached while a note is open."""
    button = page.locator("#move-checked")
    if (button.get_attribute("aria-pressed") == "true") != on:
        button.click()
    assert (button.get_attribute("aria-pressed") == "true") == on


def check_header(page):
    """The bar stands above the checked end of a list and counts its tasks; a list without one gets none, the last
    list of a note the row alone."""
    new_note(page, UNDER)
    blur(page)
    look = seen(page)
    assert shape(page) == ["☐ milk", "☐ bread", "[▾3 checked items]", "☑ eggs", "☑ yolk", "☑ cheese", "", "words under"], shape(page)
    bar = bars(page)[0]
    assert bar["add"] == "+List item" and bar["open"] == "true" and bar["title"] == "Hide checked items", bar
    # The plus and the triangle stand in the column of the boxes, and both rows are high enough to hit.
    milk = look["rows"][0]
    assert abs(bar["sign"] - milk["sign"]) <= 3 and bar["height"] >= 30, (bar, milk)
    assert body_text(page) == UNDER
    shot(page, "part-open")
    close_note(page)
    # One checked task, in words; a list in the middle of a text without a checked end has no bar.
    new_note(page, "- [ ] a\n- [x] b\n\nwords\n\n- [ ] c\n- [ ] d\n\nmore words")
    assert shape(page) == ["☐ a", "[▾1 checked item]", "☑ b", "", "words", "", "☐ c", "☐ d", "", "more words"], shape(page)
    close_note(page)
    # The last list of the note with nothing under it: the row alone, under its last task. Not under a list of bullets.
    new_note(page, "words\n\n- [ ] a\n- [ ] b")
    assert shape(page) == ["words", "", "☐ a", "☐ b", "[+]"], shape(page)
    close_note(page)
    new_note(page, "- one\n- two")
    assert shape(page) == ["• one", "• two"], shape(page)
    close_note(page)
    # Every list has its own bar; a main item that is not done ends the checked end above it.
    new_note(page, "- [x] a\n- [ ] b\n- [x] c\n\n- [x] d")
    assert shape(page) == ["☑ a", "☐ b", "[▾1 checked item]", "☑ c", "", "[▾1 checked item]", "☑ d"], shape(page)
    close_note(page)
    return {"header": True}


def check_fold(page):
    """A click on the header folds the checked items of the note away and back; the text stays as it is, and the
    editor does not take the focus (no keyboard opens on a phone)."""
    new_note(page, UNDER)
    blur(page)
    press(page, "fold")
    look = seen(page)
    assert shape(page) == ["☐ milk", "☐ bread", "[▸3 checked items]", "", "words under"], shape(page)
    assert bars(page)[0]["open"] == "false" and bars(page)[0]["title"] == "Show checked items" and not look["focused"], (bars(page), look["focused"])
    assert body_text(page) == UNDER
    shot(page, "part-folded")
    press(page, "fold")
    assert shape(page)[2:4] == ["[▾3 checked items]", "☑ eggs"] and not seen(page)["focused"], shape(page)
    # Back in sight, the checked tasks have their handles again.
    assert [entry["grip"] for entry in seen(page)["rows"] if not entry.get("bar")] == [True] * 5 + [False] * 2, seen(page)["rows"]
    # The caret among the checked items when they fold: it goes to the end of the line above them.
    caret_at_end_of(page, "cheese")
    press(page, "fold")
    page.keyboard.type("!")
    assert body_text(page) == UNDER.replace("bread", "bread!"), body_text(page)
    # Arrow down goes on to the line under the folded part, arrow up back above it; never into it.
    page.keyboard.press("ArrowDown")
    page.keyboard.type("?")
    assert body_text(page) == UNDER.replace("bread", "bread!").replace("cheese\n\n", "cheese\n?\n"), body_text(page)
    page.keyboard.press("ArrowUp")
    page.keyboard.press("End")
    page.keyboard.type("^")
    assert body_text(page).startswith("- [ ] milk\n- [ ] bread!^\n- [x] eggs"), body_text(page)
    # Delete at the end of the line above and Backspace at the start of the line under leave the folded lines whole.
    before = body_text(page)
    page.keyboard.press("Delete")
    assert body_text(page) == before, body_text(page)
    page.keyboard.press("ArrowDown")
    page.keyboard.press("Home")
    page.keyboard.press("Backspace")
    assert body_text(page) == before, body_text(page)
    close_note(page)
    # Arrow right at the end of the line above a folded part goes on to the line under it, arrow left from there back.
    new_note(page, UNDER)
    press(page, "fold")
    caret_at_end_of(page, "bread")
    page.keyboard.press("ArrowRight")
    page.keyboard.type("?")
    assert body_text(page) == UNDER.replace("cheese\n\n", "cheese\n?\n"), body_text(page)
    page.keyboard.press("ArrowLeft")
    page.keyboard.press("ArrowLeft")
    page.keyboard.type("!")
    assert body_text(page) == UNDER.replace("bread", "bread!").replace("cheese\n\n", "cheese\n?\n"), body_text(page)
    close_note(page)
    # A selection that reaches into the checked items when they fold goes where a caret goes: nothing is typed over
    # lines that are out of sight. Inside a checked item, from an open task into one, and from a checked one up to an
    # open one.
    for word, keys in (("cheese", ["Shift+ArrowLeft"] * 3), ("bread", ["Shift+ArrowDown"] * 2), ("cheese", ["Shift+ArrowUp"] * 3)):
        new_note(page, UNDER)
        caret_at_end_of(page, word)
        for key in keys:
            page.keyboard.press(key)
        press(page, "fold")
        page.keyboard.type("Z")
        assert body_text(page) == UNDER.replace("bread", "breadZ"), (word, body_text(page))
        close_note(page)
    # A selection someone makes over a folded part is theirs: what is typed takes the folded lines along, and Undo
    # brings them back in sight.
    new_note(page, UNDER)
    press(page, "fold")
    caret_at_end_of(page, "bread")
    page.keyboard.press("Shift+ArrowDown")
    page.keyboard.type("Z")
    assert body_text(page) == "- [ ] milk\n- [ ] breadZ\nwords under", body_text(page)
    history(page, "undo").click()
    assert body_text(page) == UNDER and shape(page)[2:4] == ["[▾3 checked items]", "☑ eggs"], (body_text(page), shape(page))
    close_note(page)
    # Such a selection takes the folded lines whole, never a piece of one: letter by letter it goes from the end of
    # the line above to the start of the part and then over all of it.
    new_note(page, UNDER)
    press(page, "fold")
    caret_at_end_of(page, "bread")
    page.keyboard.press("Shift+ArrowRight")
    page.keyboard.press("Shift+ArrowRight")
    page.keyboard.type("Z")
    assert body_text(page) == "- [ ] milk\n- [ ] breadZ\n\nwords under", body_text(page)
    close_note(page)
    # A short checked end that was folded while the caret moved elsewhere has its handle back when it opens.
    new_note(page, "- [ ] a\n- [x] b")
    press(page, "fold")
    page.locator(LINES, has_text="a").first.click()
    press(page, "fold")
    assert [entry["grip"] for entry in seen(page)["rows"] if not entry.get("bar")] == [True, True], seen(page)["rows"]
    close_note(page)
    # One fold for the note: with two lists both parts fold.
    new_note(page, "- [ ] a\n- [x] b\n\n- [ ] c\n- [x] d")
    press(page, "fold", 1)
    assert shape(page) == ["☐ a", "[▸1 checked item]", "", "☐ c", "[▸1 checked item]"], shape(page)
    close_note(page)
    return {"fold": True}


def check_folded_actions(page):
    """Folded, a tick still puts the task with the checked ones and the header counts it; Undo of it opens the part."""
    new_note(page, UNDER)
    press(page, "fold")
    page.locator(LINES, has_text="bread").first.locator(".cm-jd-box").click()
    assert shape(page) == ["☐ milk", "[▸4 checked items]", "", "words under"], shape(page)
    assert body_text(page).count("[x]") == 4 and "- [x] bread" in body_text(page), body_text(page)
    history(page, "undo").click()
    assert body_text(page) == UNDER, body_text(page)
    assert shape(page)[2] == "[▾3 checked items]", shape(page)
    # Redo folds nothing back: the part stays open, and the tick is there again.
    history(page, "redo").click()
    assert shape(page)[1] == "[▾4 checked items]", shape(page)
    # Redo opens a folded part as Undo does: the tick taken back, the part folded, the tick made again.
    history(page, "undo").click()
    press(page, "fold")
    assert shape(page) == ["☐ milk", "☐ bread", "[▸3 checked items]", "", "words under"], shape(page)
    history(page, "redo").click()
    assert shape(page)[1] == "[▾4 checked items]" and "- [x] bread" in body_text(page), shape(page)
    close_note(page)
    return {"folded_actions": True}


def check_add_item(page):
    """"+ List item" makes a new empty task at the bottom of the open tasks, with the caret in it."""
    new_note(page, UNDER)
    blur(page)
    press(page, "add")
    assert seen(page)["focused"], "the editor has the focus after + List item"
    page.keyboard.type("tea")
    assert body_text(page) == UNDER.replace("- [x] eggs", "- [ ] tea\n- [x] eggs"), body_text(page)
    # The new task is a step of its own for Undo, apart from what is typed in it.
    history(page, "undo").click()
    history(page, "undo").click()
    assert body_text(page) == UNDER, body_text(page)
    # Folded, the row still stands above the header and works.
    press(page, "fold")
    press(page, "add")
    page.keyboard.type("jam")
    assert body_text(page) == UNDER.replace("- [x] eggs", "- [ ] jam\n- [x] eggs"), body_text(page)
    assert shape(page) == ["☐ milk", "☐ bread", "☐ jam", "[▸3 checked items]", "", "words under"], shape(page)
    # Undo and Redo of that task change nothing among the checked items: the part stays folded.
    history(page, "undo").click()
    history(page, "undo").click()
    assert body_text(page) == UNDER and shape(page) == ["☐ milk", "☐ bread", "[▸3 checked items]", "", "words under"], (body_text(page), shape(page))
    history(page, "redo").click()
    assert shape(page) == ["☐ milk", "☐ bread", "☐", "[▸3 checked items]", "", "words under"], shape(page)
    close_note(page)
    # Under the last list of the note.
    new_note(page, "- [ ] a\n- [ ] b")
    press(page, "add")
    page.keyboard.type("c")
    assert body_text(page) == "- [ ] a\n- [ ] b\n- [ ] c", body_text(page)
    close_note(page)
    return {"add_item": True}


def check_rules(page):
    """Among checked items: Enter makes a new open task and splits nothing, Backspace in front of the first one does
    nothing, and pasted lines are checked items."""
    new_note(page, UNDER)
    page.locator(LINES, has_text="eggs").first.click()
    page.keyboard.press("End")
    page.keyboard.press("ArrowLeft")
    page.keyboard.press("ArrowLeft")
    page.keyboard.press("Enter")
    page.keyboard.type("new")
    assert body_text(page) == UNDER.replace("- [x] eggs", "- [ ] new\n- [x] eggs"), body_text(page)
    history(page, "undo").click()
    history(page, "undo").click()
    assert body_text(page) == UNDER, body_text(page)
    # Backspace right behind the box of the first checked item, and in front of its words.
    page.locator(LINES, has_text="eggs").first.click()
    page.keyboard.press("Home")
    page.keyboard.press("Backspace")
    page.keyboard.press("Backspace")
    assert body_text(page) == UNDER, body_text(page)
    # On the second one Backspace joins it to the first, as everywhere (design checklists-77-v3, 4.3).
    page.locator(LINES, has_text="cheese").first.click()
    page.keyboard.press("Home")
    page.keyboard.press("Backspace")
    assert "yolkcheese" in body_text(page), body_text(page)
    history(page, "undo").click()
    assert body_text(page) == UNDER, body_text(page)
    # Lines pasted in a checked item are checked items; in an open item they are open ones.
    caret_at_end_of(page, "cheese")
    page.evaluate(PASTE, "ham\njam")
    assert body_text(page) == UNDER.replace("- [x] cheese", "- [x] cheeseham\n- [x] jam"), body_text(page)
    assert shape(page)[2] == "[▾4 checked items]", shape(page)
    history(page, "undo").click()
    caret_at_end_of(page, "milk")
    page.evaluate(PASTE, "ham\njam")
    assert body_text(page) == UNDER.replace("- [ ] milk", "- [ ] milkham\n- [ ] jam"), body_text(page)
    close_note(page)
    return {"rules": True}


def check_under_the_list(page):
    """A list that ends the note with checked items: Enter on an empty item right above them, and a click in the room
    under them, both give a line under the list to type on."""
    new_note(page, LIST)
    caret_at_end_of(page, "bread")
    page.keyboard.press("Enter")
    assert body_text(page) == LIST.replace("- [x] eggs", "- [ ] \n- [x] eggs"), body_text(page)
    page.keyboard.press("Enter")
    page.keyboard.type("after")
    assert body_text(page) == LIST + "\nafter", body_text(page)
    assert shape(page) == ["☐ milk", "☐ bread", "[▾3 checked items]", "☑ eggs", "☑ yolk", "☑ cheese", "after"], shape(page)
    close_note(page)
    # With words under the list the new line comes above them.
    new_note(page, UNDER)
    caret_at_end_of(page, "bread")
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")
    page.keyboard.type("after")
    assert body_text(page) == LIST + "\nafter\n\nwords under", body_text(page)
    close_note(page)
    # A click under the checked items that end the note, open and folded.
    for folded in (False, True):
        new_note(page, LIST)
        if folded:
            press(page, "fold")
        blur(page)
        look = seen(page)
        assert look["box"]["bottom"] - look["end"] > 24, ("no room under the list to click in", look["end"], look["box"])
        page.mouse.click(look["box"]["left"] + look["box"]["width"] / 2, look["end"] + 16)
        page.keyboard.type("under")
        assert body_text(page) == LIST + "\nunder", (folded, body_text(page))
        # One step for Undo takes the typing away, the next one the line.
        history(page, "undo").click()
        history(page, "undo").click()
        assert body_text(page) == LIST, (folded, body_text(page))
        close_note(page)
    # Under a note that ends with anything else a click is the editor's own: no line comes.
    new_note(page, UNDER)
    blur(page)
    look = seen(page)
    page.mouse.click(look["box"]["left"] + look["box"]["width"] / 2, look["end"] + 16)
    assert body_text(page) == UNDER, body_text(page)
    close_note(page)
    return {"under_the_list": True}


def check_drag_and_move(page):
    """Nothing is dragged or moved past a header: an open task stays above it, a checked one under it, and the block
    that is dragged stops at the edge of its own part."""
    new_note(page, UNDER)
    blur(page)
    look = seen(page)
    bar = bars(page)[0]

    def carried(found):
        return state(found)["carry"]

    # An open task dragged far under the checked items: it lands at the end of the open tasks, and its block never
    # goes over the bar.
    carry = drag(page, "milk", row(page, "words under")["bottom"] + 20, during=carried)
    assert carry and carry["top"] + carry["height"] <= bar["top"] + 1, (carry, bar)
    assert body_text(page) == UNDER.replace("- [ ] milk\n- [ ] bread", "- [ ] bread\n- [ ] milk"), body_text(page)
    history(page, "undo").click()
    # A checked task dragged far up: first among the checked ones, on the main level, and its block stays under the bar.
    carry = drag(page, "cheese", look["rows"][0]["top"] - 20, dx=60, during=carried)
    assert carry and carry["top"] >= bars(page)[0]["bottom"] - 1, (carry, bars(page)[0])
    assert body_text(page) == "- [ ] milk\n- [ ] bread\n- [x] cheese\n- [x] eggs\n\t- [x] yolk\n\nwords under", body_text(page)
    history(page, "undo").click()
    # The place at the end of the open tasks is right under the last of them, not a bar further down; the first place
    # among the checked ones is at the words of the first of them, not a bar further up.
    drag(page, "milk", row(page, "bread")["bottom"] + 4)
    assert body_text(page) == UNDER.replace("- [ ] milk\n- [ ] bread", "- [ ] bread\n- [ ] milk"), body_text(page)
    history(page, "undo").click()
    drag(page, "cheese", row(page, "eggs")["top"] + 3)
    assert body_text(page) == "- [ ] milk\n- [ ] bread\n- [x] cheese\n- [x] eggs\n\t- [x] yolk\n\nwords under", body_text(page)
    history(page, "undo").click()
    # Among the checked ones it moves as before: eggs, with what hangs under it, to the end. The line it passes makes
    # room for the item's own lines, not for the bar above them.
    before = {word: row(page, word) for word in ["eggs", "yolk", "cheese"]}
    passed = drag(page, "eggs", row(page, "cheese")["bottom"] + 4, during=lambda found: row(found, "cheese"))
    assert abs(passed["top"] - (before["cheese"]["top"] - before["eggs"]["height"] - before["yolk"]["height"])) < 1.5, (passed["top"], before)
    assert body_text(page) == "- [ ] milk\n- [ ] bread\n- [x] cheese\n- [x] eggs\n\t- [x] yolk\n\nwords under", body_text(page)
    history(page, "undo").click()
    assert body_text(page) == UNDER
    # Alt+arrows: the last open task does not go down past the header, the first checked one not up; inside its own
    # part an item moves.
    caret_at_end_of(page, "bread")
    page.keyboard.press("Alt+ArrowDown")
    assert body_text(page) == UNDER, body_text(page)
    page.keyboard.press("Alt+ArrowUp")
    assert body_text(page) == UNDER.replace("- [ ] milk\n- [ ] bread", "- [ ] bread\n- [ ] milk"), body_text(page)
    history(page, "undo").click()
    page.locator(LINES, has_text="eggs").first.click()
    page.keyboard.press("Alt+ArrowUp")
    assert body_text(page) == UNDER, body_text(page)
    page.keyboard.press("Alt+ArrowDown")
    assert body_text(page) == "- [ ] milk\n- [ ] bread\n- [x] cheese\n- [x] eggs\n\t- [x] yolk\n\nwords under", body_text(page)
    history(page, "undo").click()
    # Under More the same: what would go past the header is not offered.
    more, menu = page.locator('#format-bar [data-format="more"]'), page.locator(".card-menu")
    caret_at_end_of(page, "bread")
    more.click()
    labels = menu.get_by_role("menuitem").all_inner_texts()
    assert "Move up" in labels and "Move down" not in labels, labels
    page.keyboard.press("Escape")
    page.locator(LINES, has_text="eggs").first.click()
    more.click()
    labels = menu.get_by_role("menuitem").all_inner_texts()
    assert "Move down" in labels and "Move up" not in labels, labels
    page.keyboard.press("Escape")
    close_note(page)
    # Two lists: nothing leaves its own part for the other list either, and the block stops at the edge of its part.
    two = "- [ ] a\n- [x] b\n- [x] c\n\n- [ ] d\n- [ ] f\n- [x] e"
    new_note(page, two)
    blur(page)
    carry = drag(page, "b", row(page, "e")["bottom"] + 20, during=carried)
    assert carry and carry["top"] + carry["height"] <= row(page, "b")["bottom"] + 1, (carry, row(page, "b"))
    assert body_text(page) == two.replace("- [x] b\n- [x] c", "- [x] c\n- [x] b"), body_text(page)
    history(page, "undo").click()
    edge = row(page, "c")["bottom"]
    carry = drag(page, "f", row(page, "a")["top"] - 20, during=carried)
    assert carry and carry["top"] >= edge - 1, (carry, edge)
    assert body_text(page) == two.replace("- [ ] d\n- [ ] f", "- [ ] f\n- [ ] d"), body_text(page)
    history(page, "undo").click()
    drag(page, "a", row(page, "e")["bottom"] + 20)
    assert body_text(page) == two, body_text(page)
    close_note(page)
    return {"drag_and_move": True}


def check_tick_and_untick(page):
    """A tick puts a task with the checked ones and an untick takes it back to the bottom of the open ones; the header
    counts along and goes with the last checked task."""
    new_note(page, "- [ ] milk\n- [ ] bread\n- [x] eggs")
    page.locator(LINES, has_text="milk").first.locator(".cm-jd-box").click()
    assert shape(page) == ["☐ bread", "[▾2 checked items]", "☑ milk", "☑ eggs"] or shape(page) == ["☐ bread", "[▾2 checked items]", "☑ eggs", "☑ milk"], shape(page)
    page.locator(LINES, has_text="eggs").first.locator(".cm-jd-box").click()
    assert shape(page) == ["☐ bread", "☐ eggs", "[▾1 checked item]", "☑ milk"], shape(page)
    page.locator(LINES, has_text="milk").first.locator(".cm-jd-box").click()
    assert shape(page) == ["☐ bread", "☐ eggs", "☐ milk", "[+]"], shape(page)
    close_note(page)
    return {"tick_and_untick": True}


def check_table_and_long_list(page):
    """A table under the checked items keeps its grid, folded or not; a long checked end folds to nothing, is one step
    for the caret, and comes back whole."""
    grids = f"{ROOT}.querySelectorAll('.jd-grid-block').length"
    table = "| h | k |\n|---|---|\n| 1 | 2 |"
    for text, rest in [(f"- [ ] a\n- [x] b\n- [x] c\n\n{table}\n\nend", ["", "", "end"]), (f"- [ ] a\n- [x] b\n- [x] c\n{table}", [])]:
        new_note(page, text)
        blur(page)
        assert shape(page) == ["☐ a", "[▾2 checked items]", "☑ b", "☑ c"] + rest and page.evaluate(grids) == 1, shape(page)
        press(page, "fold")
        assert shape(page) == ["☐ a", "[▸2 checked items]"] + rest and page.evaluate(grids) == 1, shape(page)
        press(page, "add")
        page.keyboard.type("x")
        assert body_text(page) == text.replace("- [x] b", "- [ ] x\n- [x] b"), body_text(page)
        close_note(page)
    opened = [f"- [ ] open {index}" for index in range(5)]
    text = "\n".join(opened + [f"- [x] done {index}" for index in range(400)]) + "\n\nwords under"
    new_note(page, text)
    blur(page)
    page.evaluate(f"{ROOT}.querySelector('.cm-scroller').scrollTop = 0")
    page.wait_for_timeout(300)
    assert shape(page)[4:7] == ["☐ open 4", "[▾400 checked items]", "☑ done 0"], shape(page)[:8]
    press(page, "fold")
    assert shape(page) == [f"☐ open {index}" for index in range(5)] + ["[▸400 checked items]", "", "words under"], shape(page)
    # Arrow down from the last open task: over all 400 in one step.
    caret_at_end_of(page, "open 4")
    page.keyboard.press("ArrowDown")
    page.keyboard.type("?")
    assert body_text(page) == text.replace("done 399\n\n", "done 399\n?\n"), body_text(page)[-60:]
    history(page, "undo").click()
    press(page, "fold")
    assert shape(page)[4:7] == ["☐ open 4", "[▾400 checked items]", "☑ done 0"] and body_text(page) == text, shape(page)[:8]
    close_note(page)
    return {"table_and_long_list": True}


def check_less_motion(page):
    """With less motion asked for, nothing slides, and an item still stays on its own side of the header."""
    page.emulate_media(reduced_motion="reduce")
    new_note(page, UNDER)
    blur(page)
    bar = bars(page)[0]
    found = drag(page, "milk", row(page, "words under")["bottom"] + 20, during=state)
    assert found["carry"] and found["carry"]["top"] + found["carry"]["height"] <= bar["top"] + 1 and not found["moving"], (found["carry"], found["moving"], bar)
    assert body_text(page) == UNDER.replace("- [ ] milk\n- [ ] bread", "- [ ] bread\n- [ ] milk"), body_text(page)
    page.emulate_media(reduced_motion="no-preference")
    close_note(page)
    return {"less_motion": True}


def check_crlf(page):
    """A text with CRLF line ends stays CRLF through the rules of the part. The web app itself never gives the editor
    one (its text comes through a textarea, which keeps LF only); this is for a host that does, so it runs in an
    editor of its own."""
    probe = "document.querySelector('#crlf-probe .jd-editor-host').shadowRoot"

    def crlf(text):
        return text.replace("\n", "\r\n")

    def open_probe(text):
        page.evaluate("""async (text) => {
          document.getElementById('crlf-probe')?.remove();
          const { createBodyEditor } = await import('/editor.mjs');
          const parent = document.createElement('div');
          parent.id = 'crlf-probe';
          for (const [name, value] of [['position', 'fixed'], ['left', '40px'], ['top', '40px'], ['width', '520px'], ['height', '420px'], ['z-index', '50'], ['background', 'var(--page)']]) parent.style.setProperty(name, value);
          document.body.prepend(parent);
          window.__probe = createBodyEditor({ parent, value: text, moveChecked: () => true });
        }""", crlf(text))
        page.wait_for_timeout(200)
        assert page.evaluate("window.__probe.getValue()") == crlf(text)

    def end_of(word):
        page.locator("#crlf-probe .cm-content .cm-line", has_text=word).first.click()
        page.keyboard.press("End")

    def value():
        return page.evaluate("window.__probe.getValue()")

    # "+ List item" and Enter in a checked item.
    open_probe(UNDER)
    page.evaluate(f"{probe}.querySelector('.cm-jd-add').click()")
    page.keyboard.type("tea")
    assert value() == crlf(UNDER.replace("- [x] eggs", "- [ ] tea\n- [x] eggs")), value()
    open_probe(UNDER)
    end_of("cheese")
    page.keyboard.press("Enter")
    page.keyboard.type("new")
    assert value() == crlf(UNDER.replace("- [x] eggs", "- [ ] new\n- [x] eggs")), value()
    # Enter on an empty item right above the checked ones, with words under the list and without.
    for text, after in [(UNDER, LIST + "\nafter\n\nwords under"), (LIST, LIST + "\nafter")]:
        open_probe(text)
        end_of("bread")
        page.keyboard.press("Enter")
        page.keyboard.press("Enter")
        page.keyboard.type("after")
        assert value() == crlf(after), value()
    # A click in the room under checked items that end the text.
    open_probe(LIST)
    x, y = page.evaluate(f"(() => {{ const box = {probe}.querySelector('.cm-scroller').getBoundingClientRect(); return [box.left + box.width / 2, {probe}.querySelector('.cm-content').lastElementChild.getBoundingClientRect().bottom + 16]; }})()")
    page.mouse.click(x, y)
    page.keyboard.type("under")
    assert value() == crlf(LIST + "\nunder"), value()
    page.evaluate("document.getElementById('crlf-probe').remove(); delete window.__probe;")
    return {"crlf": True}


def check_kept_per_note(page):
    """The fold is kept per note on this browser, under the note's id: nothing of the note itself is stored for it."""
    def save(title, text):
        page.locator("#new-note").click()
        page.locator("#note-title").fill(title)
        fill_body(page, text)
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#editor").wait_for(state="hidden")
        page.locator(".note-card").filter(has_text=title).first.wait_for()

    def open_note(title):
        page.locator(".note-card").filter(has_text=title).first.locator("h3").click()
        page.locator("#editor").wait_for(state="visible")
        page.wait_for_timeout(200)

    def close():
        page.locator("#close-editor").click()
        page.locator("#editor").wait_for(state="hidden")

    save("Groceries secret", "- [ ] milk\n- [x] eggs")
    save("Chores secret", "- [ ] sweep\n- [x] dust")
    open_note("Groceries secret")
    assert shape(page) == ["☐ milk", "[▾1 checked item]", "☑ eggs"], shape(page)
    press(page, "fold")
    close()
    open_note("Chores secret")
    assert shape(page) == ["☐ sweep", "[▾1 checked item]", "☑ dust"], shape(page)
    close()
    open_note("Groceries secret")
    assert shape(page) == ["☐ milk", "[▸1 checked item]"], shape(page)
    close()
    # A note with the very same words is still another note: it opens unfolded.
    save("Twin secret", "- [ ] milk\n- [x] eggs")
    open_note("Groceries secret")
    close()
    open_note("Twin secret")
    assert shape(page) == ["☐ milk", "[▾1 checked item]", "☑ eggs"], shape(page)
    close()
    # The setting turned off and on between two times the same note opens: the note follows it.
    open_note("Groceries secret")
    close()
    set_move_checked(page, False)
    open_note("Groceries secret")
    assert shape(page) == ["☐ milk", "☑ eggs"], shape(page)
    close()
    set_move_checked(page, True)
    open_note("Groceries secret")
    assert shape(page) == ["☐ milk", "[▸1 checked item]"], shape(page)
    close()
    kept = page.evaluate("localStorage.getItem('jotdrop-checked-folded')")
    assert kept and all(re.fullmatch(r"[0-9a-f-]{32,64}", entry) for entry in json.loads(kept)) and len(json.loads(kept)) == 1, kept
    assert "secret" not in json.dumps(page.evaluate("Object.entries(localStorage)")).lower(), "a note's name is stored in the open"
    # After a reload of the page the note is still folded; unfolded again, it is no longer on the list.
    page.reload()
    page.locator(".note-card").filter(has_text="Groceries secret").first.wait_for()
    open_note("Groceries secret")
    assert shape(page) == ["☐ milk", "[▸1 checked item]"], shape(page)
    press(page, "fold")
    close()
    assert page.evaluate("localStorage.getItem('jotdrop-checked-folded')") == "[]"
    # At most 300 notes are kept: the one folded longest ago makes room.
    page.evaluate("localStorage.setItem('jotdrop-checked-folded', JSON.stringify(Array.from({ length: 300 }, (_, index) => `old-${index}`)))")
    page.reload()
    page.locator(".note-card").filter(has_text="Groceries secret").first.wait_for()
    open_note("Groceries secret")
    press(page, "fold")
    close()
    kept = json.loads(page.evaluate("localStorage.getItem('jotdrop-checked-folded')"))
    assert len(kept) == 300 and kept[0] == "old-1" and re.fullmatch(r"[0-9a-f-]{32,64}", kept[-1]), (len(kept), kept[0], kept[-1])
    page.evaluate("localStorage.removeItem('jotdrop-checked-folded')")
    page.reload()
    page.locator(".note-card").filter(has_text="Groceries secret").first.wait_for()
    return {"kept_per_note": True}


def check_off_and_raw(page):
    """With "Move checked items to the bottom" off nothing changes, and where the editor shows the signs there is no bar."""
    set_move_checked(page, False)
    new_note(page, UNDER)
    assert shape(page) == ["☐ milk", "☐ bread", "☑ eggs", "☑ yolk", "☑ cheese", "", "words under"], shape(page)
    # Without the parts Enter in a checked item splits it as before, and an open task can be dragged under it.
    caret_at_end_of(page, "cheese")
    page.keyboard.press("Enter")
    assert body_text(page) == UNDER.replace("- [x] cheese", "- [x] cheese\n- [ ] "), body_text(page)
    history(page, "undo").click()
    blur(page)
    drag(page, "milk", row(page, "cheese")["bottom"] + 4)
    assert body_text(page) == "- [ ] bread\n- [x] eggs\n\t- [x] yolk\n- [x] cheese\n- [ ] milk\n\nwords under", body_text(page)
    close_note(page)
    set_move_checked(page, True)
    seen_raw = page.evaluate("""async (text) => {
      const { createBodyEditor } = await import('/editor.mjs');
      const parent = document.createElement('div');
      parent.id = 'raw-probe';
      for (const [name, value] of [['position', 'fixed'], ['left', '40px'], ['top', '40px'], ['width', '520px'], ['z-index', '50'], ['background', 'var(--page)']]) parent.style.setProperty(name, value);
      document.body.prepend(parent);
      const count = (editor) => editor.element.shadowRoot.querySelectorAll('.cm-jd-part').length;
      const editor = createBodyEditor({ parent, value: text, formatted: false, moveChecked: () => true });
      const raw = count(editor);
      // The Markdown switch of a host turns the parts on and off with the formatting.
      editor.setFormatted(true);
      const formatted = count(editor);
      editor.setFormatted(false);
      const back = count(editor);
      editor.destroy();
      // A note too long to format shows its signs: no bar there either.
      const long = createBodyEditor({ parent, value: `${text}\n\n${'word '.repeat(10001)}`, moveChecked: () => true });
      const tooLong = count(long);
      long.destroy();
      // A host that makes an editor per note: it opens folded when the host says so, and the host hears a fold.
      const heard = [];
      const kept = createBodyEditor({ parent, value: text, moveChecked: () => true, checkedFolded: () => true, onCheckedFold: (folded) => heard.push(folded) });
      const header = () => kept.element.shadowRoot.querySelector('.cm-jd-fold');
      const opensFolded = header().getAttribute('aria-expanded');
      header().click();
      const unfolded = header().getAttribute('aria-expanded');
      kept.destroy();
      parent.remove();
      return { raw, formatted, back, tooLong, opensFolded, unfolded, heard };
    }""", UNDER)
    assert seen_raw == {"raw": 0, "formatted": 1, "back": 0, "tooLong": 0, "opensFolded": "false", "unfolded": "true", "heard": [False]}, seen_raw
    return {"off_and_raw": True}


def check_checked_part(browser, url, token):
    context = new_context(browser)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    result = {}
    try:
        sign_in(page, url, token)
        set_move_checked(page, True)
        for check in [check_header, check_fold, check_folded_actions, check_add_item, check_rules, check_under_the_list, check_drag_and_move, check_tick_and_untick, check_table_and_long_list, check_less_motion, check_crlf, check_kept_per_note, check_off_and_raw]:
            result.update(check(page))
            # After every part, so a violation names the part it came from.
            assert page.evaluate("window.__csp || []") == [], (check.__name__, page.evaluate("window.__csp"))
        assert not errors, errors
    finally:
        context.close()
    return result


def check_touch(browser, url, token):
    """A finger on a phone: the two rows are 44 px high, a tap on the header folds and opens no keyboard, a drag stops
    at the header, "+ List item" and a tap under the list bring the keyboard. Touches are sent through the debugger, so
    this part runs in a Chromium browser only."""
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
        set_move_checked(page, True)
        new_note(page, UNDER)
        blur(page)
        look = seen(page)
        heights = page.evaluate(f"[...{ROOT}.querySelectorAll('.cm-jd-add, .cm-jd-fold')].map((element) => element.getBoundingClientRect().height)")
        assert len(heights) == 2 and all(height >= 44 for height in heights), heights
        places = "[scrollX, scrollY, document.getElementById('editor').scrollTop]"
        scrolled = page.evaluate(places)
        cdp = context.new_cdp_session(page)

        def touch(kind, x=None, y=None):
            cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [] if x is None else [{"x": x, "y": y}]})

        def tap(x, y):
            touch("touchStart", x, y)
            touch("touchEnd")
            page.wait_for_timeout(300)

        def tap_on(name):
            tap(*page.evaluate(f"(() => {{ const box = {ROOT}.querySelector('.cm-jd-{name}').getBoundingClientRect(); return [box.left + box.width / 2, box.top + box.height / 2]; }})()"))

        def finger(word, to):
            """Drags the task with `word` to height `to`; gives the block on its way."""
            x, y = grip_point(page, word)
            touch("touchStart", x, y)
            for step in range(1, 9):
                touch("touchMove", x, y + (to - y) * step / 8)
            page.wait_for_timeout(300)
            carry = state(page)["carry"]
            touch("touchEnd")
            page.wait_for_timeout(300)
            return carry

        # A tap on the header: folded and open again, and the editor does not get the focus.
        tap_on("fold")
        assert shape(page) == ["☐ milk", "☐ bread", "[▸3 checked items]", "", "words under"] and not seen(page)["focused"], (shape(page), seen(page)["focused"])
        tap_on("fold")
        assert shape(page)[2:4] == ["[▾3 checked items]", "☑ eggs"] and not seen(page)["focused"], (shape(page), seen(page)["focused"])
        # An open task dragged far down stays above the bar, a checked one dragged far up under it.
        bar = bars(page)[0]
        carry = finger("milk", row(page, "words under")["bottom"] + 20)
        assert carry and carry["top"] + carry["height"] <= bar["top"] + 1, (carry, bar)
        assert body_text(page) == UNDER.replace("- [ ] milk\n- [ ] bread", "- [ ] bread\n- [ ] milk"), body_text(page)
        carry = finger("cheese", look["rows"][0]["top"] - 10)
        assert carry and carry["top"] >= bars(page)[0]["bottom"] - 1, (carry, bars(page)[0])
        assert body_text(page) == "- [ ] bread\n- [ ] milk\n- [x] cheese\n- [x] eggs\n\t- [x] yolk\n\nwords under", body_text(page)
        assert not seen(page)["focused"], "no keyboard opens from a drag"
        assert page.evaluate(places) == scrolled, "the page did not scroll under the finger"
        # "+ List item" is there to type in: the keyboard comes.
        tap_on("add")
        assert seen(page)["focused"] and shape(page)[2:4] == ["☐", "[▾3 checked items]"], (seen(page)["focused"], shape(page))
        shot(page, "part-touch")
        close_note(page)
        # A tap in the room under checked items that end the note.
        new_note(page, LIST)
        blur(page)
        look = seen(page)
        tap(look["box"]["left"] + look["box"]["width"] / 2, look["end"] + 16)
        assert body_text(page) == LIST + "\n" and seen(page)["focused"], (body_text(page), seen(page)["focused"])
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth"), "the page is not wider than the phone"
        close_note(page)
        assert page.evaluate("window.__csp || []") == [], page.evaluate("window.__csp")
        assert not errors, errors
    finally:
        context.close()
    return {"touch": True, "touch_row_height": heights[0]}


if __name__ == "__main__":
    main(check_checked_part, history_limit=100)
    main(check_touch, history_limit=100)

"""Synthetic checks of the formatting bar and the table grid in the Obsidian edit window (src/formatBar.ts).
In memory only: no vault, no network, no real Obsidian (scripts/obsidian-dom-stub.mjs stands in for its API)."""
from pathlib import Path
import re
import subprocess
import sys

from playwright.sync_api import sync_playwright


root = Path(__file__).resolve().parent.parent
read = lambda path: (root / path).read_text(encoding="utf-8")

# The edit window uses the bar, and cleans it up when it builds again and when it closes.
edit = read("src/edit.ts")
assert "createFormatBar(this.app, this.bodyEl" in edit, "The edit window must have the formatting bar"
assert edit.count("this.formatBar?.destroy();") == 2, "The edit window must clean up its formatting bar twice"
# Same order and the same emoji as the web app (design opmaak-editor, part 5.3 and 10b).
bar_source = read("src/formatBar.ts")
web_bar = re.search(r'<div id="format-bar".*?</div>', read("cloud/web/index.html"), re.S).group(0)
assert re.findall(r'\{ command: "(\w+)"', bar_source) == re.findall(r'data-format="(\w+)"', web_bar), "Button order differs from the web app"
pairs = lambda text: [(emoji, name) for _, emoji, _, name in re.findall(r"""\[(["'])([^"'\]]+)\1, (["'])([a-z ]+)\3\]""", text)]
web_emoji = re.search(r"const EMOJI = \[(.*?)\];\r?\nconst emojiNames", read("cloud/web/app.js"), re.S).group(1)
own_emoji = re.search(r"const EMOJI: .*?= \[(.*?)\];\r?\nconst EMOJI_NAMES", bar_source, re.S).group(1)
assert pairs(own_emoji) == pairs(web_emoji) and len(pairs(web_emoji)) > 50, "The emoji set differs from the web app"

entry = "export { createFormatBar } from './src/formatBar.ts';\nexport { enhanceListEditing } from './src/listEditor.ts';\n"
bundle = subprocess.run([
    "node", "node_modules/esbuild/bin/esbuild", "--bundle", "--format=iife", "--global-name=FB", "--loader=ts",
    "--sourcefile=entry.ts", "--alias:obsidian=./scripts/obsidian-dom-stub.mjs",
], input=entry, cwd=root, text=True, encoding="utf-8", capture_output=True, check=True).stdout
css = read("styles.css")

SETUP = """() => {
  window.store = new Map();
  window.app = {
    keymap: { scopes: [], pushScope(scope) { this.scopes.push(scope); }, popScope(scope) { this.scopes = this.scopes.filter((own) => own !== scope); } },
    loadLocalStorage: (key) => (window.store.has(key) ? JSON.parse(window.store.get(key)) : null),
    saveLocalStorage: (key, value) => window.store.set(key, JSON.stringify(value)),
  };
  const ta = document.querySelector('textarea');
  window.body = '';
  ta.addEventListener('input', () => { window.body = ta.value; });
  FB.enhanceListEditing(ta);
  window.bar = FB.createFormatBar(app, ta, { moveChecked: () => window.moveChecked === true, parentScope: () => null });
  ta.parentElement.before(bar.element);
}"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, channel=sys.argv[1] if len(sys.argv) > 1 else "msedge")
    try:
        for width in (1024, 390):
            page = browser.new_page(viewport={"width": width, "height": 800})
            page.route("**/*", lambda route: route.abort())
            page.set_content("""<style>
                :root { --background-primary: white; --background-secondary: #f4f4f4; --text-normal: #222; --text-muted: #666;
                    --background-modifier-border: #888; --background-modifier-hover: #eee; --interactive-accent: #7b6cd9;
                    --text-selection: #aad5ff; --text-highlight-bg: #ffe37a; }
                * { box-sizing: border-box; } body { font: 16px Arial; margin: 20px; }
                </style><style>""" + css + """</style>
                <div class="modal-content"><textarea aria-label="Note" class="jotdrop-edit-body"></textarea></div>""")
            page.add_script_tag(content=bundle)
            page.evaluate(SETUP)
            field = page.get_by_role("textbox", name="Note", exact=True)
            value = lambda: page.evaluate("document.querySelector('textarea.jotdrop-edit-body').value")

            def put(text, start, end=None):
                page.evaluate("""([text, start, end]) => {
                    const ta = document.querySelector('textarea.jotdrop-edit-body');
                    ta.value = text; ta.dispatchEvent(new Event('input', { bubbles: true }));
                    ta.focus(); ta.setSelectionRange(start, end); ta.dispatchEvent(new Event('keyup'));
                }""", [text, start, start if end is None else end])

            def press_button(command):
                page.locator(f'.jotdrop-format > .jotdrop-format-bar [data-format="{command}"]').click()

            def pressed(command):
                return page.locator(f'.jotdrop-format > .jotdrop-format-bar [data-format="{command}"]').get_attribute("aria-pressed")

            def check(expected, what):
                got = value()
                assert got == expected, f"{what}: {got!r} != {expected!r} at {width}px"
                assert page.evaluate("window.body") == got, f"{what}: the window's state did not follow the text"

            # Buttons: one replacement from the shared core each, the codes stay in the text.
            put("hello world", 6, 11)
            press_button("bold")
            check("hello **world**", "Bold on a selection")
            assert pressed("bold") == "true", "Bold must show as on"
            looks = page.evaluate("""() => { const style = getComputedStyle(document.querySelector('[data-format="bold"]'));
                return [style.borderTopWidth, style.boxShadow]; }""")
            assert looks[0] == "2px" and "inset" in looks[1], f"On must be a shape, not only a color: {looks}"
            field.press("Control+z")
            check("hello world", "Ctrl+Z after Bold")
            put("hello world", 2)
            field.press("Control+b")
            check("**hello** world", "Ctrl+B in a word")
            put("hello world", 8)
            field.press("Control+i")
            check("hello *world*", "Ctrl+I in a word")
            put("Line", 0)
            for expected in ("## Line", "### Line", "Line"):
                press_button("heading")
                check(expected, "Heading cycles and never writes '# ' (the title)")
            put("a\nb", 0, 3)
            press_button("bullet")
            check("- a\n- b", "Bulleted list")
            put("a\nb", 0, 3)
            press_button("ordered")
            check("1. a\n2. b", "Numbered list")
            put("- item", 3)
            press_button("checklist")
            check("- [ ] item", "Checklist")
            assert pressed("checklist") == "true"
            press_button("checklist")
            check("- [x] item", "Checklist ticks")
            put("- a\n- b", 5)
            press_button("indent")
            check("- a\n\t- b", "Indent")
            press_button("outdent")
            check("- a\n- b", "Outdent")
            put("x y", 0, 1)
            press_button("highlight")
            check("==x== y", "Highlight")
            put("word", 0, 4)
            press_button("more")
            page.locator(".menu-item", has_text="Strikethrough").click()
            check("~~word~~", "Strikethrough from More")
            put("```\ncode\n```", 5)
            press_button("bold")
            check("```\ncode\n```", "Nothing in a code block")

            # Table: the button inserts a table and opens its grid; every cell goes into the text box.
            put("", 0)
            press_button("table")
            check("|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |", "Insert table")
            page.wait_for_function("document.activeElement?.classList.contains('jd-cell-input')")
            for text in ("Name", "Qty", "Note", "Milk"):
                page.keyboard.type(text)
                if text != "Milk":
                    page.keyboard.press("Tab")
            page.locator('[data-table="addRow"]').click()
            page.locator(".jotdrop-table-modal .mod-cta").click()
            assert page.locator(".jotdrop-table-modal").count() == 0, "Done closes the grid"
            check("| Name | Qty | Note |\n| --- | --- | --- |\n| Milk |  |  |\n|  |  |  |\n|  |  |  |", "Cells and + Row")
            assert page.locator('[data-format="table"]').get_attribute("aria-label") == "Edit table", "In a table the button edits it"
            # Again: the grid shows the cells, alignment rewrites the delimiter line, Escape throws a typed cell away.
            press_button("table")
            page.wait_for_function("document.activeElement?.classList.contains('jd-cell-input')")
            assert page.locator(".jd-cell-input").input_value() == "Name", "The grid opens with its cells"
            assert page.locator(".jd-cell").nth(1).inner_text() == "Qty"
            page.keyboard.press("Tab")
            page.locator('[data-table="alignCenter"]').click()
            assert value().split("\n")[1] == "| --- | :---: | --- |", value()
            page.keyboard.type("zzz")
            # Obsidian hands Esc to the newest key scope; the stand-in has no keymap, so the check calls it the same way.
            page.evaluate("app.keymap.scopes.at(-1).keys.find((key) => key.key === 'Escape').handler()")
            assert page.locator(".jotdrop-table-modal").count() == 0, "Escape leaves the grid"
            assert page.evaluate("app.keymap.scopes.length") == 0, "The grid's key scope is gone"
            assert "zzz" not in value() and value().startswith("| Name | Qty | Note |"), value()
            # Delete table asks first.
            put(value(), 0)
            press_button("table")
            page.wait_for_function("document.activeElement?.classList.contains('jd-cell-input')")
            page.locator('[data-table="deleteTable"]').click()
            page.locator(".jotdrop-confirm-ok").click()
            assert page.locator(".modal").count() == 0, "Both windows close"
            assert "|" not in value(), value()
            # A table between text has no strips; at the end of the text a strip adds a line under it.
            put("before\n\nafter", 7)
            press_button("table")
            assert value() == "before\n\n|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n\nafter", value()
            assert page.locator(".jd-grid-strip:visible").count() == 0, "No strips in the middle of the text"
            page.locator(".jotdrop-table-modal .mod-cta").click()
            put("start", 5)
            press_button("table")
            page.locator(".jd-grid-strip-after").click()
            page.keyboard.type("end")
            assert value().startswith("start\n\n|  |") and value().endswith("|\n\nend"), value()

            # Emoji: one insertion at the caret; the last used come first next time; Esc closes the panel first.
            put("hi ", 3)
            press_button("emoji")
            assert page.locator(".jotdrop-emoji-panel").is_visible()
            assert page.locator('[data-format="emoji"]').get_attribute("aria-expanded") == "true"
            page.locator('.jotdrop-emoji-panel button[data-emoji="👍"]').click()
            check("hi 👍", "Emoji")
            assert not page.locator(".jotdrop-emoji-panel").is_visible()
            press_button("emoji")
            assert page.locator(".jotdrop-emoji-panel h3").first.inner_text() == "Recently used"
            assert page.evaluate("app.keymap.scopes.length") == 1
            page.evaluate("app.keymap.scopes[0].keys.find((key) => key.key === 'Escape').handler()")
            assert not page.locator(".jotdrop-emoji-panel").is_visible() and page.evaluate("app.keymap.scopes.length") == 0

            # Narrow: the bar scrolls in its own row, the page never sideways.
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), f"Page scrolls sideways at {width}px"
            assert page.evaluate("getComputedStyle(document.querySelector('.jotdrop-format-bar')).overflowX") == "auto"

            # Cleaned up: no bar and no shortcut afterwards.
            page.evaluate("bar.destroy()")
            assert page.locator(".jotdrop-format").count() == 0
            put("abc", 1)
            field.press("Control+b")
            check("abc", "No Ctrl+B after cleanup")
            page.close()
    finally:
        browser.close()
print("format bar browser checks passed")

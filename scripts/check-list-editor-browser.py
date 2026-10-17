"""Synthetic, in-memory editor checks. No server, vault, cloud or device access."""
from pathlib import Path
import subprocess
import sys

from playwright.sync_api import sync_playwright


root = Path(__file__).resolve().parent.parent
bundle = subprocess.check_output([
    "node", "node_modules/esbuild/bin/esbuild", "src/listEditor.ts", "--bundle",
    "--format=iife", "--global-name=ListEditor",
], cwd=root, text=True, encoding="utf-8")
css = (root / "styles.css").read_text(encoding="utf-8")
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, channel=sys.argv[1] if len(sys.argv) > 1 else "msedge")
    try:
        for width in (1024, 390):
            page = browser.new_page(viewport={"width": width, "height": 800})
            page.route("**/*", lambda route: route.abort())
            page.set_content("""<style>
                :root { --background-primary: white; --text-normal: #222;
                    --background-modifier-border: #888; --text-selection: #aad5ff; }
                * { box-sizing: border-box; } body { font: 16px Arial; margin: 20px; }
                </style>""" + "<style>" + css + "</style>" + """
                <textarea aria-label="Capture" class="jotdrop-capture-textarea"></textarea>
                <textarea aria-label="Edit" class="jotdrop-edit-body"></textarea>""")
            page.add_script_tag(content=bundle)
            page.evaluate("window.cleanups = [...document.querySelectorAll('textarea')].map(ListEditor.enhanceListEditing)")
            for label in ("Capture", "Edit"):
                field = page.get_by_role("textbox", name=label, exact=True)
                field.fill("- alpha")
                field.press("End")
                field.press("Enter")
                assert field.input_value() == "- alpha\n- "
                field.press("Control+z")
                assert field.input_value() == "- alpha", "Enter must be one undoable edit"
                field.press("Control+y")
                assert field.input_value() == "- alpha\n- ", "Redo must restore the complete item"
                field.press("Enter")
                assert field.input_value() == "- alpha\n", "Empty item must exit the list"
                field.press("Control+z")
                assert field.input_value() == "- alpha\n- ", "Empty-item removal must be undoable"
                field.fill("  - [x] alpha")
                field.press("End")
                field.press("Enter")
                assert field.input_value() == "  - [x] alpha\n  - [ ] "
                field.fill("- alpha beta")
                field.evaluate("ta => ta.setSelectionRange(4, 8)")
                field.press("Enter")
                assert field.input_value() == "- al\n- beta"
                field.fill("- alpha")
                field.press("End")
                field.press("Shift+Enter")
                assert field.input_value() == "- alpha\n", "Shift+Enter must remain a plain line break"
                field.fill("- alpha")
                field.evaluate("""ta => ta.addEventListener('keydown', event => {
                    if (event.ctrlKey && event.key === 'Enter') event.preventDefault();
                })""")
                field.press("Control+Enter")
                assert field.input_value() == "- alpha", "Save shortcuts must not insert list items"
                assert field.evaluate("""ta => {
                    ta.setSelectionRange(ta.value.length, ta.value.length);
                    const event = new InputEvent('beforeinput', {inputType:'insertParagraph', bubbles:true, cancelable:true});
                    ta.dispatchEvent(event);
                    return event.defaultPrevented;
                }""")
                assert field.input_value() == "- alpha\n- ", "Soft-keyboard Enter must continue lists"
                field.fill("- alpha")
                assert field.evaluate("""ta => ta.dispatchEvent(new InputEvent('beforeinput', {
                    inputType:'insertLineBreak', isComposing:true, bubbles:true, cancelable:true
                }))"""), "Never intercept IME composition"
                assert field.input_value() == "- alpha"
                source = "- alpha\n  * beta\n- [x] task\n```\n- code\n```\n<img src=x onerror=alert(1)>"
                field.fill(source)
                preview = field.locator("xpath=..").locator(".jotdrop-list-editor-preview")
                assert preview.get_attribute("aria-hidden") == "true"
                assert preview.locator(".jotdrop-list-bullet").count() == 2
                assert preview.locator(".jotdrop-list-bullet").first.evaluate("el => getComputedStyle(el, '::after').content") == '"\u2022"'
                assert preview.locator("img").count() == 0, "Preview must insert text, never HTML"
                assert field.input_value() == source, "Bullet rendering must never rewrite Markdown"
                field.fill(("  * " + "long synthetic text " * 25 + "\n") * 20)
                assert field.evaluate("""ta => {
                    const preview = ta.previousElementSibling;
                    ta.scrollTop = 200; ta.dispatchEvent(new Event('scroll'));
                    return Math.abs(ta.scrollHeight - preview.scrollHeight) <= 1 &&
                        ta.scrollTop === preview.scrollTop;
                }"""), "Wrapping and scrolling must match the native textarea"
            assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
            page.emulate_media(forced_colors="active")
            assert page.locator(".jotdrop-list-editor-preview").first.evaluate("el => getComputedStyle(el).display") == "none"
            assert page.get_by_role("textbox").first.evaluate("el => getComputedStyle(el).color") != "rgba(0, 0, 0, 0)"
            page.evaluate("window.cleanups.forEach(cleanup => cleanup())")
            assert page.locator(".jotdrop-list-editor").count() == 0
            assert page.get_by_role("textbox").count() == 2
            page.close()
        print("Desktop/mobile browser list, undo, IME, safe rendering, wrapping and cleanup checks passed")
    finally:
        browser.close()

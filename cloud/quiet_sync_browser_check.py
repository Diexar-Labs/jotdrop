"""Run: python cloud/quiet_sync_browser_check.py. Synthetic check: the sync that runs every 30 seconds in the
background moves nothing on screen (Eric, 27 Oct: the page went down a bit and back up every few seconds)."""
import sys
sys.dont_write_bytecode = True
from browser_check import main

# Where the notes start and how tall the toolbar is, every frame.
RECORD = """() => {
  window.frames = [];
  const loop = () => {
    window.frames.push([Math.round(document.getElementById('items').getBoundingClientRect().top), Math.round(document.querySelector('.toolbar').getBoundingClientRect().height), document.getElementById('sync-status').textContent]);
    if (!window.stopFrames) requestAnimationFrame(loop);
  };
  window.stopFrames = false;
  requestAnimationFrame(loop);
}"""


def check_quiet_sync(browser, url, token):
    # A full HD window with the menu open: a Pause sync button here takes a new toolbar row (56 px).
    context = browser.new_context(viewport={"width": 1850, "height": 900})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic quiet passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        page.locator("#new-note").click()
        page.locator("#note-path").fill("notes/2026-10-27 130001 Quiet.md")
        page.locator("#note-content").fill("# Quiet\n\nNothing moves while the cloud is checked.")
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        page.mouse.move(5, 5)
        page.wait_for_timeout(500)
        page.evaluate(RECORD)
        # The background sync runs every 30 seconds; wait until one started and finished.
        page.wait_for_function("() => window.frames.some((frame) => frame[2].startsWith('Syncing'))", timeout=35000)
        page.wait_for_function("() => window.frames.at(-1)[2].startsWith('Cloud copy up to date')", timeout=10000)
        page.evaluate("window.stopFrames = true")
        frames = page.evaluate("window.frames")
        tops = sorted({frame[0] for frame in frames})
        toolbars = sorted({frame[1] for frame in frames})
        assert len(tops) == 1 and len(toolbars) == 1, {"items_top": tops, "toolbar_height": toolbars}
        assert not errors, errors
        return {"frames_checked": len(frames), "background_sync_moves_nothing": True}
    finally:
        context.close()


if __name__ == "__main__":
    main(check_quiet_sync)

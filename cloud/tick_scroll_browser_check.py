"""Run: python cloud/tick_scroll_browser_check.py. Synthetic check: far down a long list, ticking a box keeps the page
where it is, frame by frame (Eric, 27 Oct: each tick jumped the page up twice)."""
import sys
import time
sys.dont_write_bytecode = True
from browser_check import main

RECORD = """(path) => {
  window.frames = [];
  const loop = () => {
    const card = [...document.querySelectorAll('#items .note-card')].find((item) => item.dataset.path === path);
    window.frames.push([Math.round(window.scrollY), card ? Math.round(card.getBoundingClientRect().top) : null, document.documentElement.scrollHeight]);
    if (!window.stopFrames) requestAnimationFrame(loop);
  };
  window.stopFrames = false;
  requestAnimationFrame(loop);
}"""


def check_tick_scroll(browser, url, token):
    context = browser.new_context(viewport={"width": 1200, "height": 800})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))

    def synced():
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic tick passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        synced()
        # Enough notes for a page several screens long.
        for number in range(24):
            page.locator("#new-note").click()
            page.locator("#note-path").fill(f"notes/2026-10-27 14{number:02d}00 List {number}.md")
            page.locator("#note-content").fill(f"# List {number}\n\n- [ ] first {number}\n- [ ] second {number}\n- [ ] third {number}\n\nA line of text so the card has some height.")
            page.locator('#editor-form button[type="submit"]').click()
            synced()
        page.wait_for_timeout(2500)
        result = {}
        # On the real cloud a save takes over a second, long enough to offer Pause sync: that may not move the page either.
        for attempt in ("tick", "untick", "slow tick"):
            if attempt == "slow tick":
                page.route("**/api/v1/**", lambda route: (time.sleep(0.6), route.continue_()))
            # A card in the middle of the screen, far down the page.
            page.evaluate("window.scrollTo(0, 1400)")
            page.wait_for_timeout(400)
            path = page.evaluate("""() => {
              const middle = innerHeight / 2;
              const card = [...document.querySelectorAll('#items .note-card')].find((item) => { const box = item.getBoundingClientRect(); return box.top > 80 && box.top < middle; });
              return card.dataset.path;
            }""")
            box = page.locator("#items .note-card").filter(has=page.locator(f'xpath=self::*[@data-path="{path}"]')).locator(".task-row input").first
            page.evaluate(RECORD, path)
            box.click()
            synced()
            page.wait_for_timeout(4000)
            page.evaluate("window.stopFrames = true")
            frames = page.evaluate("window.frames")
            scrolls = sorted({frame[0] for frame in frames})
            tops = sorted({frame[1] for frame in frames})
            changes = [(index, frame) for index, frame in enumerate(frames) if index == 0 or frame != frames[index - 1]]
            heights = sorted({frame[2] for frame in frames})
            assert len(scrolls) == 1 and len(tops) == 1 and len(heights) == 1, {attempt: {"scrollY": scrolls, "card_top": tops, "page_height": heights, "frames": len(frames), "changes": changes[:12]}}
            result[attempt] = len(frames)
        assert not errors, errors
        return {"frames_checked": result, "tick_keeps_scroll": True}
    finally:
        context.close()


if __name__ == "__main__":
    main(check_tick_scroll, history_limit=100)

"""Synthetic Obsidian DOM: no vault, server, account or production data. Run: python scripts/check-card-corner-browser.py.

#109 (mrjo118, 24 and 26 Nov): the cut-off bit of a card's folded corner was painted in the page colour, so it showed as a
square edge on anything else: the amber shadow under the pointer, or another card. It has to be open. The card lies on
magenta for the measurement, a colour the plugin never uses; the cut-off bit shows it at rest, under the pointer and halfway
through the shadow fading in and out, while the flap and the shadow are still there. On the pixels, in light and dark."""
import io
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
css = (ROOT / "styles.css").read_text(encoding="utf-8")
THEMES = {
    "light": "--background-primary:#fbf8f1;--background-secondary:#ffffff;--background-modifier-border:#e2d9c3;--text-normal:#14213d;--text-muted:#56607a",
    "dark": "--background-primary:#0e1626;--background-secondary:#16213a;--background-modifier-border:#2b3a5c;--text-normal:#fbf8f1;--text-muted:#b7bfd0",
}
MAGENTA = (255, 0, 255)

# Pauses every running transition at the given millisecond and returns what was transitioning.
PAUSE = """async (ms) => {
  const paper = document.querySelector('.jotdrop-card-paper');
  getComputedStyle(paper).filter;
  for (let i = 0; i < 5 && !document.getAnimations().length; i++) await new Promise(r => requestAnimationFrame(r));
  const running = document.getAnimations();
  for (const animation of running) { animation.pause(); animation.currentTime = ms; }
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return running.map(a => (a.effect && a.effect.pseudoElement || '') + a.transitionProperty).sort();
}"""


def distance(a, b):
    return max(abs(x - y) for x, y in zip(a, b))


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge")
    try:
        results = {}
        for theme, variables in THEMES.items():
            page = browser.new_page(viewport={"width": 900, "height": 600})
            page.set_content('<style>body{margin:0;padding:40px;font:16px Arial;background:rgb(255,0,255);color:var(--text-normal);' + variables + '}.jotdrop-card{width:260px}</style><style>' + css + '</style>'
                             '<main class="jotdrop-view"><div class="jotdrop-card" tabindex="0"><span class="jotdrop-card-paper"></span><div class="jotdrop-card-title">Groceries</div><p>Milk and bread</p></div></main>')
            card = page.locator(".jotdrop-card")
            paper = page.locator(".jotdrop-card-paper")
            # Straight for the measurement, so a pixel lands on the same spot of the paper.
            paper.evaluate("(e) => { e.style.rotate = '0deg'; }")

            def sample():
                left, right, bottom = paper.evaluate("(e) => { const r = e.getBoundingClientRect(); return [r.left, r.right, r.bottom]; }")
                shot = Image.open(io.BytesIO(page.screenshot())).convert("RGB")
                # "under": just below the paper, in the middle: the amber shadow under the pointer.
                return {"cut": shot.getpixel((round(right) - 2, round(bottom) - 2)), "flap": shot.getpixel((round(right) - 11, round(bottom) - 11)),
                        "under": shot.getpixel((round((left + right) / 2), round(bottom) + 2))}

            def open_corner(found, why):
                assert distance(found["cut"], MAGENTA) <= 6, (theme, why, found)
                assert distance(found["flap"], MAGENTA) > 60, (theme, "the flap is still drawn", found)

            page.mouse.move(890, 590)
            page.wait_for_timeout(400)
            rest = sample()
            open_corner(rest, "at rest the cut-off bit shows what lies under the card")
            card.hover()
            page.wait_for_timeout(400)
            lifted = sample()
            open_corner(lifted, "under the pointer the cut-off bit shows what lies under the card, not a painted corner")
            assert distance(lifted["under"], (244, 196, 88)) <= 6, (theme, "under the pointer the paper lies on the amber shadow", lifted)
            page.mouse.move(890, 590)
            leaving_props = page.evaluate(PAUSE, 75)
            leaving = sample()
            open_corner(leaving, ("fading out", leaving_props))
            page.evaluate("document.getAnimations().forEach(a => a.finish())")
            card.hover()
            entering_props = page.evaluate(PAUSE, 75)
            entering = sample()
            open_corner(entering, ("fading in", entering_props))
            results[theme] = {name: value["cut"] for name, value in (("rest", rest), ("lifted", lifted), ("leaving", leaving), ("entering", entering))}
            page.close()

        # Less motion: the shadow comes and goes at once.
        page = browser.new_page(viewport={"width": 900, "height": 600}, reduced_motion="reduce")
        page.set_content('<style>body{' + THEMES["light"] + '}</style><style>' + css + '</style><main class="jotdrop-view"><div class="jotdrop-card"><span class="jotdrop-card-paper"></span></div></main>')
        duration = page.locator(".jotdrop-card-paper").evaluate("(e) => getComputedStyle(e).transitionDuration")
        assert set(duration.replace(" ", "").split(",")) == {"0s"}, duration
    finally:
        browser.close()
print(results)
print("PASS card corner (#109)")

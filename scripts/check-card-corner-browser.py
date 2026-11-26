"""Synthetic Obsidian DOM: no vault, server, account or production data. Run: python scripts/check-card-corner-browser.py.

#109 (mrjo118, 24 Nov): the cut-off bit of a card's folded corner is painted, and under the pointer it turned amber at once
while the amber shadow faded in or out, so for a moment a page-coloured triangle lay on the shadow. It has to show what lies
under it: the page at rest, the shadow under the pointer, and the shadow's colour of that moment while it fades. On the pixels,
in light and dark."""
import io
from pathlib import Path
import re

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
css = (ROOT / "styles.css").read_text(encoding="utf-8")
THEMES = {
    "light": "--background-primary:#fbf8f1;--background-secondary:#ffffff;--background-modifier-border:#e2d9c3;--text-normal:#14213d;--text-muted:#56607a",
    "dark": "--background-primary:#0e1626;--background-secondary:#16213a;--background-modifier-border:#2b3a5c;--text-normal:#fbf8f1;--text-muted:#b7bfd0",
}

# Pauses every running transition at the given millisecond and returns what was transitioning.
PAUSE = """async (ms) => {
  const paper = document.querySelector('.jotdrop-card-paper');
  getComputedStyle(paper).boxShadow; getComputedStyle(paper, '::after').backgroundColor;
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
            page.set_content('<style>body{margin:0;padding:40px;font:16px Arial;background:var(--background-primary);color:var(--text-normal);' + variables + '}.jotdrop-card{width:260px}</style><style>' + css + '</style>'
                             '<main class="jotdrop-view"><div class="jotdrop-card" tabindex="0"><span class="jotdrop-card-paper"></span><div class="jotdrop-card-title">Groceries</div><p>Milk and bread</p></div></main>')
            card = page.locator(".jotdrop-card")
            paper = page.locator(".jotdrop-card-paper")

            def sample():
                box, shadow = paper.evaluate("(e) => { const r = e.getBoundingClientRect(); return [[r.left, r.top, r.right, r.bottom], getComputedStyle(e).boxShadow]; }")
                left, top, right, bottom = box
                shot = Image.open(io.BytesIO(page.screenshot())).convert("RGB")
                found = {"cut": shot.getpixel((int(right) - 3, int(bottom) - 3)), "page": shot.getpixel((int(left) - 10, int(top) + 30))}
                # The shadow's colour at this moment over the page: while it fades it also shrinks, so a pixel would miss it.
                rgba = [float(n) for n in re.findall(r"[\d.]+", re.search(r"rgba?\([^)]*\)", shadow).group(0))] if shadow != "none" else [0, 0, 0, 0]
                alpha = rgba[3] if len(rgba) == 4 else 1.0
                found["shadow"] = tuple(round(alpha * c + (1 - alpha) * q) for c, q in zip(rgba[:3], found["page"]))
                return found

            page.mouse.move(890, 590)
            page.wait_for_timeout(400)
            rest = sample()
            assert distance(rest["cut"], rest["page"]) <= 6, (theme, "at rest the cut-off bit shows the page", rest)
            card.hover()
            page.wait_for_timeout(400)
            lifted = sample()
            assert distance(lifted["cut"], (244, 196, 88)) <= 6, (theme, "under the pointer the cut-off bit shows the shadow", lifted)
            page.mouse.move(890, 590)
            leaving_props = page.evaluate(PAUSE, 75)
            leaving = sample()
            assert distance(leaving["cut"], leaving["shadow"]) <= 16, (theme, "fading out: no page-coloured triangle on the shadow", leaving, leaving_props)
            page.evaluate("document.getAnimations().forEach(a => a.finish())")
            card.hover()
            entering_props = page.evaluate(PAUSE, 75)
            entering = sample()
            assert distance(entering["cut"], entering["shadow"]) <= 16, (theme, "fading in: the cut-off bit follows the shadow", entering, entering_props)
            results[theme] = {name: {"cut": value["cut"], "shadow": value["shadow"]} for name, value in (("rest", rest), ("lifted", lifted), ("leaving", leaving), ("entering", entering))}
            page.close()

        # Less motion: nothing fades, the corner switches with the shadow.
        page = browser.new_page(viewport={"width": 900, "height": 600}, reduced_motion="reduce")
        page.set_content('<style>body{' + THEMES["light"] + '}</style><style>' + css + '</style><main class="jotdrop-view"><div class="jotdrop-card"><span class="jotdrop-card-paper"></span></div></main>')
        durations = page.locator(".jotdrop-card-paper").evaluate("(e) => [getComputedStyle(e).transitionDuration, getComputedStyle(e, '::after').transitionDuration]")
        assert all(set(d.replace(" ", "").split(",")) == {"0s"} for d in durations), durations
    finally:
        browser.close()
print(results)
print("PASS card corner (#109)")

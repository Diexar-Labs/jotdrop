"""Run: python cloud/playful_browser_check.py. Synthetic check: the playful details of design A (Eric, 27 Oct)
show at the right moment only: a new note drops in and is stamped once the cloud holds it, a pin wiggles,
a tick is struck through with a pen, a card keeps its own angle, and less motion turns movement into a fade."""
import io
import re
import sys
sys.dont_write_bytecode = True
from PIL import Image
from browser_check import main

# Every card, stamp, pin and task row the app adds, with what it looked like at that moment.
WATCH = """() => {
  window.added = [];
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      for (const element of [node, ...node.querySelectorAll('.card-stamp, .card-pin, .task-row')]) {
        const card = element.closest('.note-card');
        if (!card) continue;
        window.added.push({
          kind: element.matches('.card-stamp') ? 'stamp' : element.matches('.card-pin') ? 'pin' : element.matches('.task-row') ? 'task' : element.matches('.note-card') ? 'card' : 'other',
          path: card.dataset.path, revision: card.dataset.revision || null, classes: element.className.baseVal ?? element.className,
          checked: element.matches('.task-row') ? element.querySelector('input').checked : null,
          animation: getComputedStyle(element).animationName,
          tape: getComputedStyle(card.querySelector('.card-tape'), '::before').content,
        });
      }
    }
  }).observe(document.getElementById('items'), { childList: true, subtree: true });
}"""


# Pauses every running transition at the given millisecond and returns what was transitioning.
PAUSE = """async (ms) => {
  const paper = document.querySelector('.note-card .card-paper');
  getComputedStyle(paper).boxShadow; getComputedStyle(paper, '::after').backgroundColor;
  for (let i = 0; i < 5 && !document.getAnimations().length; i++) await new Promise(r => requestAnimationFrame(r));
  const running = document.getAnimations();
  for (const animation of running) { animation.pause(); animation.currentTime = ms; }
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return running.map(a => (a.effect && a.effect.pseudoElement || '') + a.transitionProperty).sort();
}"""


def corner_follows_shadow(page, card):
    """#109 (mrjo118): the cut-off bit of the folded corner was a cream triangle on the amber shadow while the shadow faded
    in or out. It has to show what lies under it: the page at rest, the shadow under the pointer and halfway through."""
    paper = card.locator(".card-paper")
    # Straight for the measurement, so a pixel lands on the same spot of the paper (through the CSSOM: the CSP allows no <style>).
    paper.evaluate("(e) => { e.style.rotate = '0deg'; }")

    def sample():
        box, shadow = paper.evaluate("(e) => { const r = e.getBoundingClientRect(); return [[r.left, r.top, r.right, r.bottom], getComputedStyle(e).boxShadow]; }")
        left, top, right, bottom = box
        shot = Image.open(io.BytesIO(page.screenshot())).convert("RGB")
        found = {"cut": shot.getpixel((int(right) - 3, int(bottom) - 3)), "page": shot.getpixel((int(left) - 6, int(top) + 30))}
        # The shadow's colour as it is at this moment, over the page: while it fades it also shrinks, so a pixel would miss it.
        rgba = [float(n) for n in re.findall(r"[\d.]+", re.search(r"rgba?\([^)]*\)", shadow).group(0))] if shadow != "none" else [0, 0, 0, 0]
        alpha = rgba[3] if len(rgba) == 4 else 1.0
        found["shadow"] = tuple(round(alpha * c + (1 - alpha) * p) for c, p in zip(rgba[:3], found["page"]))
        return found

    def distance(a, b):
        return max(abs(x - y) for x, y in zip(a, b))

    page.mouse.move(5, 5)
    page.wait_for_timeout(400)
    rest = sample()
    assert distance(rest["cut"], rest["page"]) <= 6, ("at rest the cut-off bit shows the page", rest)
    card.hover()
    page.wait_for_timeout(400)
    lifted = sample()
    assert distance(lifted["cut"], (244, 196, 88)) <= 6, ("under the pointer the cut-off bit shows the shadow", lifted)
    page.mouse.move(5, 5)
    leaving_props = page.evaluate(PAUSE, 75)
    leaving = sample()
    assert distance(leaving["cut"], leaving["shadow"]) <= 16, ("fading out: no cream triangle on the shadow", leaving, leaving_props)
    page.evaluate("document.getAnimations().forEach(a => a.finish())")
    card.hover()
    entering_props = page.evaluate(PAUSE, 75)
    entering = sample()
    assert distance(entering["cut"], entering["shadow"]) <= 16, ("fading in: the cut-off bit follows the shadow", entering, entering_props)
    page.evaluate("document.getAnimations().forEach(a => a.finish())")
    paper.evaluate("(e) => { e.style.rotate = ''; }")


def check_playful(browser, url, token):
    context = browser.new_context(viewport={"width": 1100, "height": 1000})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))

    def synced():
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

    def card(text):
        return page.locator(".note-card").filter(has_text=text)

    def added(kind, path):
        return [item for item in page.evaluate("window.added") if item["kind"] == kind and item["path"] == path]

    def new_note(name, content):
        page.locator("#new-note").click()
        page.locator("#note-path").fill(f"notes/{name}.md")
        page.locator("#note-content").fill(content)
        page.locator('#editor-form button[type="submit"]').click()
        synced()
        # The stamp shows for 1.8 s once the cloud has the note.
        page.wait_for_timeout(2200)

    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic playful passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        synced()

        # An empty list points to New note in handwriting.
        assert "New note" in page.locator(".empty-state .empty-hint").inner_text()

        page.evaluate(WATCH)
        new_note("Groceries", "# Groceries\n\n- [ ] Milk\n- [ ] Bread")
        path = "notes/Groceries.md"
        cards = added("card", path)
        assert "is-dropped" in cards[0]["classes"] and cards[0]["animation"] == "drop", cards
        stamps = added("stamp", path)
        # Stamped only on the version the cloud confirmed, never while it was still on its way.
        assert stamps and all(item["revision"] for item in stamps), (stamps, cards)
        assert not card("Groceries").locator(".card-stamp").count()
        # The folded corner, like the logo.
        assert page.evaluate("getComputedStyle(document.querySelector('.card-paper'), '::after').content") == '""'

        # A card keeps its own small angle across renders, also under the pointer, where it lifts onto an amber shadow.
        page.mouse.move(5, 5)
        page.wait_for_timeout(300)
        angle = page.evaluate("getComputedStyle(document.querySelector('.card-paper')).rotate")
        assert angle not in ("none", "0deg"), angle
        # Only the paper turns: the card with the text stays straight, so the text stays sharp.
        assert page.evaluate("getComputedStyle(document.querySelector('.note-card')).rotate") == "none"
        paper = card("Groceries").locator(".card-paper")
        resting = paper.evaluate("(element) => getComputedStyle(element).rotate")
        card("Groceries").hover()
        page.wait_for_timeout(300)
        lifted = paper.evaluate("(element) => { const style = getComputedStyle(element); return [style.rotate, style.translate, style.boxShadow]; }")
        assert lifted[0] == resting and lifted[1] == "-2px -2px" and "rgb(244, 196, 88) 5px 5px 0px" in lifted[2], lifted
        # The cut-off bit of the folded corner shows the amber shadow under it, not the page.
        corner = paper.evaluate("(element) => getComputedStyle(element, '::after').backgroundColor")
        assert corner == "rgb(244, 196, 88)", corner
        # #109: also while the shadow comes and goes, on the pixels.
        corner_follows_shadow(page, card("Groceries"))

        # Ticking strikes the task through with a pen; the other task has no stroke.
        page.evaluate("window.added = []")
        card("Groceries").locator(".task-row input").first.check()
        synced()
        rows = [item for item in added("task", path) if item["checked"]]
        assert any("just-struck" in item["classes"] for item in rows), rows
        strokes = card("Groceries").locator(".strike")
        assert strokes.nth(0).is_visible() and not strokes.nth(1).is_visible()
        # The ticked box keeps focus, and a card with focus stands straight too.
        page.locator("#search").focus()
        page.mouse.move(5, 5)
        page.wait_for_timeout(300)
        assert page.evaluate("getComputedStyle(document.querySelector('.card-paper')).rotate") == angle, "a re-render changed the card's angle"

        # Pinning wiggles the pin and sticks tape on the card; no stamp, since the note is not new.
        page.evaluate("window.added = []")
        card("Groceries").get_by_role("button", name="Pin", exact=True).click()
        synced()
        pins = added("pin", path)
        assert any("wiggling" in item["classes"] for item in pins), pins
        assert any("just-pinned" in item["classes"] and item["tape"] == '""' for item in added("card", path)), added("card", path)
        assert not added("stamp", path)
        # The tape lies on top of the card's content, also over a cover photo.
        assert card("Groceries").locator(".card-tape").evaluate("(element) => getComputedStyle(element).zIndex") == "1"

        # With less motion nothing moves, but a new note and its stamp still show, as a fade.
        page.emulate_media(reduced_motion="reduce")
        # The corner's cut-off bit switches with the shadow then, it does not fade (#109).
        assert page.evaluate("getComputedStyle(document.querySelector('.card-paper'), '::after').transitionDuration") == "0s"
        page.evaluate("window.added = []")
        new_note("Quiet", "# Quiet\n\nA calm note.")
        cards = added("card", "notes/Quiet.md")
        assert cards[0]["animation"] == "fade-in", cards
        stamps = added("stamp", "notes/Quiet.md")
        assert stamps and stamps[0]["animation"] == "stamp-fade", stamps
        assert not errors, errors
        return {"empty_hint": True, "new_note_drops": True, "stamp_after_cloud": True, "fold": True, "stable_tilt": True, "pen_strike": True, "pin_wiggle_tape": True, "less_motion_fades": True}
    finally:
        context.close()


if __name__ == "__main__":
    main(check_playful)

"""Run: python cloud/steady_browser_check.py. Synthetic check: ticking a box changes nothing else on screen, frame by frame."""
import base64
import sys
sys.dont_write_bytecode = True
from browser_check import main

# Every frame while a tick is saved and synced: where each card is, whether the photo stays loaded,
# and whether the card under the pointer keeps its buttons and the ticked box keeps focus.
RECORD = """(path) => {
  window.frames = [];
  const loop = () => {
    const card = [...document.querySelectorAll('#items .note-card')].find((item) => item.dataset.path === path);
    const image = document.querySelector('#items .note-card img');
    window.frames.push({
      cards: [...document.querySelectorAll('#items .note-card')].map((item) => { const box = item.getBoundingClientRect(); return [item.dataset.path, Math.round(box.top), Math.round(box.left), Math.round(box.height)]; }),
      image: Boolean(image && image.complete && image.naturalHeight),
      actions: card ? Number(getComputedStyle(card.querySelector('.card-actions')).opacity) : -1,
      border: card ? getComputedStyle(card).borderTopStyle : '',
      focused: Boolean(card && card.contains(document.activeElement) && document.activeElement.type === 'checkbox'),
      rows: card ? [card.style.gridRowEnd, Math.round(card.getBoundingClientRect().height * 10) / 10, card.className] : [],
      above: [Math.round(document.getElementById('items').getBoundingClientRect().top), document.getElementById('sync-status').textContent, document.getElementById('upload-progress').hidden],
    });
    if (!window.stopFrames) requestAnimationFrame(loop);
  };
  window.stopFrames = false;
  document.addEventListener('click', () => { window.clickFrame = window.frames.length; }, { capture: true, once: true });
  requestAnimationFrame(loop);
}"""


def check_steady(browser, url, token):
    # Three columns, so the ticked card has cards beside and below it.
    context = browser.new_context(viewport={"width": 1100, "height": 1400})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))

    def synced():
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

    def card(text):
        return page.locator(".note-card").filter(has_text=text)

    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic steady passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        image = base64.b64decode(page.evaluate("""() => {
          const c = document.createElement('canvas'); c.width = 600; c.height = 400;
          const x = c.getContext('2d'); x.fillStyle = '#4a7'; x.fillRect(0, 0, c.width, c.height);
          return c.toDataURL('image/png').split(',')[1];
        }"""))
        page.locator("#upload").set_input_files({"name": "steady.png", "mimeType": "image/png", "buffer": image})
        synced()
        notes = [("2026-10-27 090001 Photo", "# Photo\n\n![](../attachments/steady.png)")]
        notes += [(f"2026-10-27 0900{index + 2:02d} List {index}", f"# List {index}\n\n- [ ] Milk {index}\n- [ ] Bread {index}") for index in range(5)]
        notes += [(f"2026-10-27 0900{index + 7:02d} Text {index}", f"# Text {index}\n\n" + "Line of text.\n" * (index + 1)) for index in range(3)]
        for name, content in notes:
            page.locator("#new-note").click()
            page.locator("#note-path").fill(f"notes/{name}.md")
            page.locator("#note-content").fill(content)
            page.locator('#editor-form button[type="submit"]').click()
            synced()
        card("Photo").locator("img").wait_for()

        results = {}
        for name, ticked in [("List 3", "first_tick"), ("List 3", "second_tick")]:
            target = card(name)
            path = target.get_attribute("data-path")
            revision = int(target.get_attribute("data-revision"))
            # A real click: the pointer rests on the card first and stays there, like Eric's.
            box = target.locator(".task-row input").first
            box.hover()
            page.wait_for_timeout(400)
            page.evaluate(RECORD, path)
            page.wait_for_timeout(100)
            box.click()
            page.locator(f'.note-card[data-revision="{revision + 1}"]').filter(has_text=name).wait_for()
            synced()
            page.wait_for_timeout(1500)
            frames, clicked = page.evaluate("() => { window.stopFrames = true; return [window.frames, window.clickFrame]; }")
            first = {item[0]: item[1:] for item in frames[0]["cards"]}
            moved = sorted({f"{item[0]} {first.get(item[0])} -> {item[1:]}" for frame in frames for item in frame["cards"] if first.get(item[0]) != item[1:]})
            above = [frame["above"] + frame["rows"] for frame in frames]
            assert not moved, (ticked, moved, [state for index, state in enumerate(above) if index == 0 or state != above[index - 1]])
            assert all(frame["image"] for frame in frames), (ticked, "photo reloaded")
            assert all(frame["actions"] == 1 for frame in frames), (ticked, "card buttons blinked", [frame["actions"] for frame in frames][:40])
            assert all(frame["border"] == "solid" for frame in frames), (ticked, "pending border flashed")
            assert all(frame["focused"] for frame in frames[clicked + 1:]), (ticked, "focus lost", [frame["focused"] for frame in frames][:40])
            results[ticked] = len(frames)
        assert card("List 3").locator(".task-row input").first.is_checked() is False
        assert not errors, errors
        return {"frames_checked": results, "cards_stay_put": True, "photo_stays_loaded": True, "buttons_stay": True, "focus_stays": True}
    finally:
        if sys.exc_info()[0]:
            print({"sync": page.locator("#sync-status").text_content(), "message": page.locator("#workspace-message").text_content(), "errors": errors})
        context.close()


if __name__ == "__main__":
    main(check_steady, history_limit=100)

"""Run: python cloud/drawing_browser_check.py [browser-channel]. Drawing in the web app, with mouse and touch, synthetic files only.
Set JOTDROP_SHOTS_DIR to keep screenshots of the steps."""
import io
import json
import os
import struct
import sys
from pathlib import Path
sys.dont_write_bytecode = True
from browser_check import main

FIXTURES = Path(__file__).resolve().parent / "shared" / "fixtures"
SHOTS = os.environ.get("JOTDROP_SHOTS_DIR")


def drawing_in(png):
    """The lines inside a JotDrop drawing PNG, read independently of the JavaScript, and the picture's size per PIL."""
    assert png[:8] == b"\x89PNG\r\n\x1a\n", "a PNG"
    from PIL import Image
    image = Image.open(io.BytesIO(png))
    image.load()
    at, found, types = 8, None, []
    while at + 12 <= len(png):
        length = struct.unpack(">I", png[at:at + 4])[0]
        kind, data = png[at + 4:at + 8], png[at + 8:at + 8 + length]
        types.append(kind)
        if kind == b"tEXt" and data.startswith(b"jotdrop-drawing\x00"):
            assert found is None, "one drawing chunk"
            found = json.loads(data[len(b"jotdrop-drawing\x00"):].decode("latin-1"))
        at += 12 + length
    assert types[1] == b"tEXt", "the drawing sits right after IHDR"
    return found, image


def shot(page, name):
    if SHOTS:
        page.screenshot(path=str(Path(SHOTS) / f"{name}.png"))


def stroke(page, canvas, points):
    box = canvas.bounding_box()
    spots = [(box["x"] + box["width"] * fx, box["y"] + box["height"] * fy) for fx, fy in points]
    page.mouse.move(*spots[0])
    page.mouse.down()
    for x, y in spots[1:]:
        page.mouse.move(x, y, steps=8)
    page.mouse.up()


def pixel(canvas, fx, fy):
    return canvas.evaluate("(c, [fx, fy]) => { const d = c.getContext('2d').getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data; return [d[0], d[1], d[2]]; }", [fx, fy])


def connect(page, url, token, method=None):
    page.goto(url, wait_until="networkidle")
    page.locator("#show-connect").click()
    if method:
        page.locator("#connect-method").select_option(method)
    page.locator("#access-code").fill(token)
    for field in ["#new-password", "#confirm-password"]:
        page.locator(field).fill("synthetic drawing test passphrase")
    page.locator('#connect-form button[type="submit"]').click()
    if not method:
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()


def download_file(page, name):
    page.locator('[data-view="files"]').click()
    card = page.locator(".note-card").filter(has_text=name)
    card.wait_for()
    with page.expect_download() as download:
        card.get_by_role("button", name="Download", exact=True).click()
    return Path(download.value.path()).read_bytes()


def check_drawing(browser, url, token):
    context = browser.new_context()
    mobile = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    errors, requests = [], []
    context.on("request", lambda request: requests.append(request.url))
    page = context.new_page()
    phone = mobile.new_page()
    answer = {"accept": True}
    for each in [page, phone]:
        each.on("pageerror", lambda error: errors.append(str(error)))
        # Without an account the app's account and groups calls answer 404 and 403 by design; a script error is what counts here.
        each.on("console", lambda message: errors.append(message.text) if message.type == "error" and "Failed to load resource" not in message.text else None)
        each.on("dialog", lambda dialog: dialog.accept() if answer["accept"] else dialog.dismiss())
    try:
        connect(page, url, token)
        # A new drawing from the toolbar: a note opens with the drawing screen over it.
        page.locator("#new-drawing").click()
        page.locator("#drawing-dialog[open]").wait_for()
        draw, canvas = page.locator("#drawing-dialog .jd-draw"), page.locator("#drawing-dialog canvas")
        assert draw.get_attribute("data-strokes") == "0"
        assert page.locator(".jd-draw-save").is_disabled() and page.locator(".jd-draw-undo").is_disabled() and page.locator(".jd-draw-clear").is_disabled()
        # The chosen pen and width carry a check mark and a name, never only a colour.
        assert "✓" in page.locator('.jd-draw-pen[aria-checked="true"]').inner_text() and "Black" in page.locator('.jd-draw-pen[aria-checked="true"]').inner_text()
        assert page.locator('.jd-draw-size[aria-checked="true"]').inner_text().strip("✓ ").strip() == "Medium"
        assert page.locator(".jd-draw-pen").count() == 6 and page.locator(".jd-draw-size").count() == 3
        stroke(page, canvas, [(0.2, 0.2), (0.5, 0.3), (0.8, 0.4)])
        assert draw.get_attribute("data-strokes") == "1"
        draw.get_by_role("radio", name="Red").click()
        draw.get_by_role("radio", name="Thick").click()
        assert "Red" in page.locator('.jd-draw-pen[aria-checked="true"]').inner_text() and "Thick" in page.locator('.jd-draw-size[aria-checked="true"]').inner_text()
        stroke(page, canvas, [(0.2, 0.7), (0.8, 0.7)])
        stroke(page, canvas, [(0.5, 0.9)])
        assert draw.get_attribute("data-strokes") == "3"
        assert pixel(canvas, 0.5, 0.7) == [220, 38, 38], pixel(canvas, 0.5, 0.7)
        shot(page, "1-tekenen")
        # The eraser takes the whole red line in one touch; undo and redo bring it back and forth.
        draw.get_by_role("button", name="Eraser").click()
        assert page.locator(".jd-draw-eraser").get_attribute("aria-pressed") == "true" and page.locator('.jd-draw-pen[aria-checked="true"]').count() == 0
        stroke(page, canvas, [(0.5, 0.7)])
        assert draw.get_attribute("data-strokes") == "2" and pixel(canvas, 0.5, 0.7) == [255, 255, 255]
        page.locator(".jd-draw-undo").click()
        assert draw.get_attribute("data-strokes") == "3" and pixel(canvas, 0.5, 0.7) == [220, 38, 38]
        page.locator(".jd-draw-redo").click()
        assert draw.get_attribute("data-strokes") == "2"
        page.locator(".jd-draw-undo").click()
        assert draw.get_attribute("data-strokes") == "3"
        # Clear asks first; saying no keeps everything.
        answer["accept"] = False
        page.locator(".jd-draw-clear").click()
        assert draw.get_attribute("data-strokes") == "3"
        answer["accept"] = True
        page.locator(".jd-draw-clear").click()
        page.locator('.jd-draw[data-strokes="0"]').wait_for()
        page.locator(".jd-draw-undo").click()
        assert draw.get_attribute("data-strokes") == "3"
        # Saving makes a new PNG attachment and puts it in the (empty) note under the title Drawing.
        page.locator(".jd-draw-save").click()
        page.locator("#drawing-dialog").wait_for(state="hidden")
        content = page.locator("#note-content").input_value()
        assert content.startswith("# Drawing\n\n![[drawing-") and content.rstrip().endswith(".png]]"), content
        first_name = content.split("![[")[1].split("]]")[0]
        assert "Drawing kept" in page.locator("#editor-message").inner_text()
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        card = page.locator(".note-card").filter(has_text="Drawing")
        card.locator("img").wait_for()
        assert card.locator("img").evaluate("img => [img.naturalWidth, img.naturalHeight]") == [1080, 1440]
        shot(page, "2-kaart-met-tekening")
        first_png = download_file(page, first_name)
        drawing, image = drawing_in(first_png)
        assert image.size == (1080, 1440) and drawing["v"] == 1 and drawing["w"] == 1080 and drawing["h"] == 1440
        assert [(s["c"], s["s"]) for s in drawing["strokes"]] == [("#1f2937", 14), ("#dc2626", 30), ("#dc2626", 30)], drawing["strokes"]
        assert len(drawing["strokes"][2]["p"]) == 2, "a dot is a single point"
        assert image.convert("RGB").getpixel((540, int(1440 * 0.7))) == (220, 38, 38)
        # Edit drawing from the card: the lines come back, one more line is added, the note points at the new file.
        page.locator('[data-view="notes"]').click()
        page.locator(".note-card img").click()
        page.locator("#photo-viewer[open]").wait_for()
        assert page.locator("#photo-edit-drawing").is_visible()
        shot(page, "3-fotoweergave-edit-drawing")
        page.locator("#photo-edit-drawing").click()
        page.locator("#drawing-dialog[open]").wait_for()
        assert page.locator("#editor[open]").count() == 1 and draw.get_attribute("data-strokes") == "3"
        assert pixel(canvas, 0.5, 0.7) == [220, 38, 38]
        draw.get_by_role("radio", name="Blue").click()
        stroke(page, canvas, [(0.1, 0.5), (0.9, 0.5)])
        assert draw.get_attribute("data-strokes") == "4"
        page.locator(".jd-draw-save").click()
        page.locator("#drawing-dialog").wait_for(state="hidden")
        content = page.locator("#note-content").input_value()
        assert first_name not in content and content.count("![[drawing-") == 1, content
        second_name = content.split("![[")[1].split("]]")[0]
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        second_png = download_file(page, second_name)
        assert page.locator(".note-card").filter(has_text=first_name).count() == 1, "the earlier picture stays"
        edited, _ = drawing_in(second_png)
        assert len(edited["strokes"]) == 4 and edited["strokes"][3]["c"] == "#2563eb" and edited["strokes"][3]["s"] == 14, [(s["c"], s["s"], len(s["p"])) for s in edited["strokes"]]
        assert edited["strokes"][:3] == drawing["strokes"], "the earlier lines are kept exactly"
        # A drawing made on Android opens here to draw on; a plain picture gets no Edit drawing.
        page.locator("#upload").set_input_files([
            {"name": "drawing-android.png", "mimeType": "image/png", "buffer": (FIXTURES / "drawing-android.png").read_bytes()},
            {"name": "plain.png", "mimeType": "image/png", "buffer": (FIXTURES / "drawing-v1.png").read_bytes()},
        ])
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        android_strokes = len(drawing_in((FIXTURES / "drawing-android.png").read_bytes())[0]["strokes"])
        page.locator('[data-view="notes"]').click()
        page.locator("#new-note").click()
        page.locator("#note-path").fill("notes/android.md")
        page.locator("#note-content").fill("# From Android\n\n![[drawing-android.png]]\n![[plain.png]]\n")
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        page.locator(".note-card").filter(has_text="From Android").get_by_role("button", name="Open note", exact=True).click()
        page.locator("#note-media .note-media-photo").nth(1).wait_for()
        page.locator("#note-media .note-media-photo").nth(1).click()
        page.locator("#photo-viewer[open]").wait_for()
        assert page.locator("#photo-edit-drawing").is_hidden(), "a plain picture is not a drawing"
        page.locator("#close-photo").click()
        page.locator("#note-media .note-media-photo").nth(0).click()
        page.locator("#photo-viewer[open]").wait_for()
        page.locator("#photo-edit-drawing").click()
        page.locator("#drawing-dialog[open]").wait_for()
        assert draw.get_attribute("data-strokes") == str(android_strokes)
        shot(page, "4-android-tekening-bewerken")
        # Leaving with unsaved work asks first.
        draw.get_by_role("radio", name="Green").click()
        stroke(page, canvas, [(0.3, 0.3), (0.6, 0.6)])
        answer["accept"] = False
        page.locator(".jd-draw-cancel").click()
        assert page.locator("#drawing-dialog[open]").count() == 1
        answer["accept"] = True
        page.keyboard.press("Escape")
        page.locator("#drawing-dialog").wait_for(state="hidden")
        assert page.locator("#editor[open]").count() == 1
        page.locator("#close-editor").click()
        # Touch, on a phone-sized browser paired to the same cloud: a finger draws, and nothing sticks out sideways.
        page.locator('[data-view="devices"]').click()
        page.locator("#pair-name").fill("Phone drawing browser")
        page.locator("#pair-form button").click()
        page.wait_for_function("() => document.getElementById('pair-code').value.length > 20")
        connect(phone, url, page.locator("#pair-code").input_value(), method="pair")
        phone.locator(".note-card").filter(has_text="From Android").wait_for()
        phone.locator("#new-drawing").click()
        phone.locator("#drawing-dialog[open]").wait_for()
        phone_canvas = phone.locator("#drawing-dialog canvas")
        box = phone_canvas.bounding_box()
        assert box["x"] >= 0 and box["x"] + box["width"] <= 390 and box["y"] + box["height"] <= 844, box
        assert not phone.evaluate("document.documentElement.scrollWidth > innerWidth")
        cdp = mobile.new_cdp_session(phone)
        points = [(box["x"] + box["width"] * fx, box["y"] + box["height"] * fy) for fx, fy in [(0.2, 0.3), (0.4, 0.5), (0.6, 0.4), (0.8, 0.6)]]
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": points[0][0], "y": points[0][1]}]})
        for x, y in points[1:]:
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y}]})
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        phone.locator('#drawing-dialog .jd-draw[data-strokes="1"]').wait_for()
        assert not phone.evaluate("document.documentElement.scrollWidth > innerWidth")
        shot(phone, "5-telefoon-touch")
        phone.locator(".jd-draw-save").click()
        phone.locator("#drawing-dialog").wait_for(state="hidden")
        assert phone.locator("#note-content").input_value().startswith("# Drawing\n\n![[drawing-")
        phone.locator('#editor-form button[type="submit"]').click()
        phone.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        assert not errors, errors
        # The browser's own download pages (edge://, chrome://) are not requests of the app.
        assert all(request.startswith(url + "/") or request.startswith("blob:") or "://" not in request.split("//")[0] + "//" or request.split("://")[0] in ("edge", "chrome") for request in requests), requests
        return {"six_named_pens_with_check": True, "three_widths": True, "eraser_whole_lines": True, "undo_redo_clear": True, "saved_png_1080x1440_with_lines": True, "new_file_on_edit_old_kept": True, "edit_from_photo_view": True, "android_drawing_opens": True, "plain_picture_not_editable": True, "touch_drawing": True, "mobile_overflow": False, "no_external_requests": True}
    finally:
        if sys.exc_info()[0]:
            for each in [page, phone]:
                shot(each, f"fout-{'phone' if each is phone else 'page'}")
            print(json.dumps({"errors": errors}))
        context.close()
        mobile.close()


if __name__ == "__main__":
    main(check_drawing, history_limit=100)

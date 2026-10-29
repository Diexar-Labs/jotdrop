"""Run: python cloud/photo_browser_check.py [browser-channel]. Real local OCR, synthetic files only."""
import base64
import sys
from pathlib import Path
sys.dont_write_bytecode = True
from browser_check import main


def check_photos(browser, url, token):
    context = browser.new_context(permissions=["camera"])
    other = browser.new_context(viewport={"width": 390, "height": 844}, permissions=["camera"])
    requests = []
    errors = []
    context.on("request", lambda request: requests.append(request.url))
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.on("dialog", lambda dialog: dialog.accept())
    second = other.new_page()
    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic OCR test passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        page.locator("#new-note").click()
        page.locator("#photo-tools summary").click(timeout=5000)
        image = base64.b64decode(page.evaluate("""() => {
          const c = document.createElement('canvas'); c.width = 1400; c.height = 400;
          const x = c.getContext('2d'); x.fillStyle = 'white'; x.fillRect(0, 0, c.width, c.height);
          x.fillStyle = 'black'; x.font = '60px Arial';
          x.fillText('JOTDROP CAMERA CHECK', 60, 130);
          x.fillText('Dit is een testnotitie.', 60, 240);
          return c.toDataURL('image/png').split(',')[1];
        }"""))
        page.locator("#photo-upload").set_input_files({"name": "synthetic.png", "mimeType": "image/png", "buffer": image})
        page.wait_for_function("() => /Review the recognized text|failed|valid PNG/.test(document.getElementById('photo-message').textContent)", timeout=120000)
        assert "Review the recognized text" in page.locator("#photo-message").inner_text(), (page.locator("#photo-message").inner_text(), errors)
        text = page.locator("#note-content").input_value()
        assert "JOTDROP CAMERA CHECK" in text and "testnotitie" in text
        assert "![Source photo](../attachments/" in text
        page.locator("#note-content").fill(text + "\nUser correction survives sync.")
        page.locator("#note-path").fill("notes/ocr-check.md")
        page.locator('#editor-form button[type="submit"]').click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        page.locator('[data-view="devices"]').click()
        page.locator("#pair-name").fill("Mobile OCR browser")
        page.locator("#pair-form button").click()
        page.wait_for_function("() => document.getElementById('pair-code').value.length > 20")
        second.goto(url, wait_until="networkidle")
        second.locator("#show-connect").click()
        second.locator("#connect-method").select_option("pair")
        second.locator("#access-code").fill(page.locator("#pair-code").input_value())
        for field in ["#new-password", "#confirm-password"]:
            second.locator(field).fill("synthetic mobile OCR passphrase")
        second.locator('#connect-form button[type="submit"]').click()
        second.locator(".note-card").filter(has_text="User correction survives sync").wait_for()
        second.locator('[data-view="files"]').click()
        second.locator(".note-card img").wait_for()
        with second.expect_download() as download:
            second.locator(".note-card").get_by_role("button", name="Download", exact=True).click()
        assert Path(download.value.path()).read_bytes() == image
        # The toolbar button opens a new note with the camera already running.
        second.locator("#new-photo-text").click()
        second.locator("#capture-photo:not([disabled])").wait_for()
        assert second.locator("#photo-tools").evaluate("details => details.open")
        second.locator("#capture-photo").click()
        second.wait_for_function("() => document.getElementById('note-content').value.includes('![Source photo]')")
        assert second.locator('#editor-form button[type="submit"]').is_disabled()
        # The OCR worker starts after the source photo is queued; wait for it instead of racing.
        worker = second.workers[0] if second.workers else second.wait_for_event("worker")
        with worker.expect_event("close"):
            second.locator("#cancel-ocr").click()
        assert second.locator("#camera-preview").evaluate("video => video.srcObject === null")
        assert "![Source photo]" in second.locator("#note-content").input_value()
        assert not second.evaluate("document.documentElement.scrollWidth > innerWidth")
        second.evaluate("() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); }; }")
        second.locator("#start-camera").click()
        second.locator("#photo-message").filter(has_text="Camera permission was denied").wait_for()
        second.evaluate("() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Missing', 'NotFoundError'); }; }")
        second.locator("#start-camera").click()
        second.locator("#photo-message").filter(has_text="No camera was found").wait_for()
        second.evaluate("() => { Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true }); }")
        second.locator("#start-camera").click()
        second.locator("#photo-message").filter(has_text="Use HTTPS or localhost").wait_for()
        second.locator("#photo-upload").set_input_files({"name": "invalid.png", "mimeType": "image/png", "buffer": b"not an image"})
        second.locator("#photo-message").filter(has_text="valid PNG, JPEG or WebP").wait_for()
        second.route("**/ocr/*", lambda route: route.abort())
        second.locator("#photo-upload").set_input_files({"name": "fallback.png", "mimeType": "image/png", "buffer": image})
        second.locator("#photo-message").filter(has_text="Text recognition failed").wait_for(timeout=120000)
        assert second.locator("#note-content").input_value().count("![Source photo]") == 2
        assert not second.locator('#editor-form button[type="submit"]').is_disabled()
        assert all(request.startswith(url + "/") or request.startswith("blob:") for request in requests), requests
        return {"real_local_english_dutch_ocr": True, "editable_text_synced": True, "original_photo_bytes_synced": True, "mobile_camera_capture": True, "camera_denied_upload_fallback": True, "camera_missing_https_feedback": True, "invalid_image_rejected": True, "ocr_failure_preserves_photo": True, "cancel_stops_camera_worker": True, "no_external_requests": True, "mobile_overflow": False}
    finally:
        context.close()
        other.close()


if __name__ == "__main__":
    main(check_photos, history_limit=100, camera=True)

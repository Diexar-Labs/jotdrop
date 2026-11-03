"""Makes the Chrome Web Store screenshots for the cloud side of the Web Clipper (1280x800, PNG).

Run: python docs/store/make_screenshots.py [browser-channel]

The UI in the pictures is real: the unpacked clipper from chrome-extension/ in Edge, paired from the web app
of a local cloud, with demo notes only. Two things are staged for a clean picture and say so here:
the settings page shows the production address app.jotdrop.net (the local cloud has another one), and the
browser frames around the UI, with their address bars, are drawn by the template below.
Writes docs/store/screenshots/1-clip-any-page.png, 4-cloud-or-obsidian.png and 5-cards-in-the-web-app.png.
"""
import base64
import http.server
from pathlib import Path
import secrets
import sys
import tempfile
import threading

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "cloud"))
from clipper_extension_check import extension_id, free_port, start_cloud, stop  # noqa: E402

OUT = ROOT / "docs" / "store" / "screenshots"
PASSPHRASE = "demo unlock passphrase"
TITLE = "Five slow train rides to the coast"
SELECTION = "Take the early train, sit on the left, and get off one stop early to walk the last mile along the sea."
ARTICLE_HOST = "thelongweekend.example/slow-trains-to-the-coast"
DEMO_NOTES = [
    ("notes/A few good things.md", "---\ntags: [\"shopping\"]\npinned: false\ncolor: yellow\n---\n\n# A few good things\n\n- [ ] Coffee beans\n- [ ] Lemons\n- [x] Fresh bread\n- [ ] Something for dinner\n"),
    ("notes/Gift ideas.md", "---\ntags: [\"family\"]\npinned: false\ncolor: pink\n---\n\n# Gift ideas\n\nA good pen for Sam, a plant for the new flat, and tickets for the Sunday concert.\n"),
    ("notes/Book club.md", "---\ntags: []\npinned: false\ncolor: green\n---\n\n# Book club\n\nThursday at 8. Bring the second half read, and the cake this time.\n"),
    ("notes/Garden.md", "---\ntags: [\"home\"]\npinned: false\ncolor: default\n---\n\n# Garden\n\nTomatoes against the south wall. Water early, before the sun is on them.\n"),
]


class Article(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        body = f"<!doctype html><title>{TITLE}</title><h1>{TITLE}</h1><p id='quote'>{SELECTION}</p>".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def data_uri(png):
    return "data:image/png;base64," + base64.b64encode(png).decode()


def font(name):
    # Inline: a page made with set_content may not load file:// fonts.
    return "data:font/woff2;base64," + base64.b64encode((ROOT / "cloud" / "web" / "fonts" / name).read_bytes()).decode()


STYLE = f"""
@font-face {{ font-family: "Instrument Sans"; font-weight: 400 700; src: url("{font('instrument-sans.woff2')}"); }}
@font-face {{ font-family: "Bricolage Grotesque"; font-weight: 200 800; src: url("{font('bricolage-grotesque.woff2')}"); }}
@font-face {{ font-family: "Caveat"; src: url("{font('caveat.woff2')}"); }}
* {{ box-sizing: border-box; margin: 0; }}
html, body {{ width: 1280px; height: 800px; overflow: hidden; }}
body {{ background: #fbf8f1; color: #14213d; font-family: "Instrument Sans", sans-serif; position: relative; }}
body.ink {{ background: #14213d; color: #fbf8f1; }}
.copy {{ position: absolute; left: 72px; top: 0; bottom: 0; width: 430px; display: flex; flex-direction: column; justify-content: center; }}
.brand {{ display: flex; align-items: center; gap: 12px; font-family: "Bricolage Grotesque"; font-weight: 800; font-size: 26px; margin-bottom: 58px; }}
.brand img {{ width: 44px; height: 44px; }}
.kicker {{ font-family: "Caveat"; font-size: 30px; color: #8a5a00; transform: rotate(-3deg); transform-origin: left; margin-bottom: 4px; }}
.ink .kicker {{ color: #f4c458; }}
h1 {{ font-family: "Bricolage Grotesque"; font-weight: 800; font-size: 54px; line-height: 1.04; letter-spacing: -0.02em; margin-bottom: 30px; }}
h1 mark {{ background: linear-gradient(transparent 62%, #f4c458 62%); color: inherit; }}
.ink h1 mark {{ background: none; text-decoration: underline 6px #f4c458; text-underline-offset: 8px; }}
ul {{ list-style: none; padding: 0; font-size: 19px; line-height: 1.5; }}
li {{ position: relative; padding-left: 30px; margin-bottom: 12px; color: #3b4664; }}
.ink li {{ color: #d3d9e6; }}
li::before {{ content: "+"; position: absolute; left: 4px; color: #c58a12; font-weight: 700; }}
.ink li::before {{ color: #f4c458; }}
li b {{ color: #14213d; }}
.ink li b {{ color: #fbf8f1; }}
.frame {{ position: absolute; background: #fff; border: 2px solid #14213d; border-radius: 16px; box-shadow: 10px 10px 0 #14213d; overflow: hidden; }}
.ink .frame {{ border-color: #d3d9e6; box-shadow: 10px 10px 0 #f4c458; }}
.bar {{ height: 40px; border-bottom: 2px solid #14213d; display: flex; align-items: center; gap: 8px; padding: 0 14px; background: #fff; }}
.bar i {{ width: 12px; height: 12px; border: 2px solid #14213d; border-radius: 50%; }}
.bar span {{ flex: 1; margin-left: 10px; border: 1.5px solid #c9c1ae; border-radius: 999px; padding: 3px 14px; font-size: 13px; color: #56607a; }}
.bar img {{ width: 26px; height: 26px; }}
.shot {{ display: block; }}
.article {{ padding: 34px 44px; font-family: Georgia, serif; }}
.article small {{ font-family: "Instrument Sans"; letter-spacing: 0.12em; font-weight: 700; color: #7a6a44; font-size: 13px; }}
.article h2 {{ font-size: 36px; line-height: 1.1; margin: 14px 0 10px; width: 520px; }}
.article .meta {{ font-family: "Instrument Sans"; color: #56607a; font-size: 14px; margin-bottom: 20px; }}
.article .pic {{ height: 150px; border-radius: 12px; background: linear-gradient(#bcd3ea 0 55%, #7ea7c7 55% 62%, #e8d6a8 62%); margin-bottom: 20px; position: relative; }}
.article .pic::after {{ content: ""; position: absolute; left: 40px; right: 120px; top: 52%; height: 20px; border-radius: 4px; background: repeating-linear-gradient(90deg, #a2463c 0 140px, transparent 140px 150px); }}
.article p {{ font-size: 17px; line-height: 1.6; color: #2b2b2b; width: 560px; }}
.article mark {{ background: #cfe0f7; }}
.popup {{ position: absolute; border: 2px solid #14213d; border-radius: 14px; box-shadow: 8px 8px 0 #14213d; overflow: hidden; background: #fbf8f1; }}
.callout {{ position: absolute; font-family: "Caveat"; font-size: 26px; color: #8a5a00; }}
"""


def compose(page, name, body_class, copy, art):
    page.set_content(f"<!doctype html><html><head><meta charset='utf-8'><style>{STYLE}</style></head><body class='{body_class}'>{copy}{art}</body></html>")
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(200)
    OUT.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(OUT / name), clip={"x": 0, "y": 0, "width": 1280, "height": 800})


def copy_block(icon, kicker, title, items):
    bullets = "".join(f"<li>{item}</li>" for item in items)
    return f"<div class='copy'><div class='brand'><img src='{icon}' alt=''>JotDrop Web Clipper</div><div class='kicker'>{kicker}</div><h1>{title}</h1><ul>{bullets}</ul></div>"


def capture(channel, workdir):
    article_port = free_port()
    article = http.server.ThreadingHTTPServer(("127.0.0.1", article_port), Article)
    threading.Thread(target=article.serve_forever, daemon=True).start()
    shots = {}
    with sync_playwright() as playwright:
        extension_dir = str(ROOT / "chrome-extension")
        context = playwright.chromium.launch_persistent_context(
            str(Path(workdir) / "profile"), channel=channel, headless=True, device_scale_factor=2,
            viewport={"width": 1180, "height": 760}, color_scheme="light",
            ignore_default_args=["--disable-extensions"],
            args=[f"--disable-extensions-except={extension_dir}", f"--load-extension={extension_dir}"])
        server = None
        try:
            ext = extension_id(context, channel)
            origin = f"chrome-extension://{ext}"
            # Popup as a tab: clip the article tab. Settings: show the production address as allowed.
            context.add_init_script("""(() => {
              if (location.protocol !== 'chrome-extension:') return;
              if (location.pathname.endsWith('/popup/popup.html')) {
                const query = chrome.tabs.query.bind(chrome.tabs);
                // The demo article, shown under the address it pretends to have.
                chrome.tabs.query = async () => (await query({ url: 'http://localhost/*' })).map((tab) => ({ ...tab, url: 'https://ARTICLE_HOST' }));
              }
              if (location.pathname.endsWith('/options/options.html') && localStorage.getItem('demo-production')) {
                chrome.permissions.contains = async () => true;
              }
            })();""".replace("ARTICLE_HOST", ARTICLE_HOST))
            token = secrets.token_urlsafe(32)
            port = free_port()
            data_dir = Path(workdir) / "cloud"
            data_dir.mkdir()
            server = start_cloud(str(data_dir), port, token, origin)
            url = f"http://127.0.0.1:{port}"

            web = context.new_page()
            web.on("dialog", lambda dialog: dialog.accept())
            web.goto(url, wait_until="networkidle")
            web.locator("#theme").select_option("light")
            web.locator("#show-connect").click()
            web.locator("#access-code").fill(token)
            web.locator("#new-password").fill(PASSPHRASE)
            web.locator("#confirm-password").fill(PASSPHRASE)
            web.locator('#connect-form button[type="submit"]').click()
            web.locator("#recovery-saved").check()
            web.locator("#finish-recovery").click()
            web.locator('[data-view="devices"]').click()
            web.locator("#pair-name").fill("Web clipper")
            web.locator("#pair-form button").click()
            web.wait_for_function("() => document.getElementById('pair-code').value.length > 20")
            code = web.locator("#pair-code").input_value()

            options = context.new_page()
            options.goto(f"{origin}/options/options.html", wait_until="networkidle")
            options.locator("#destCloud").check()
            options.locator("#cloudPairCode").fill(code)
            options.locator("#cloudPairPassword").fill(PASSPHRASE)
            options.locator("#cloudPairRepeat").fill(PASSPHRASE)
            options.locator("#cloudConnect").click()
            options.locator("#cloudMessage").filter(has_text="Connected").wait_for()

            source = context.new_page()
            source.goto(f"http://localhost:{article_port}/", wait_until="networkidle")
            source.evaluate("getSelection().selectAllChildren(document.getElementById('quote'))")

            def popup_filled():
                popup = context.new_page()
                popup.set_viewport_size({"width": 360, "height": 700})
                popup.goto(f"{origin}/popup/popup.html", wait_until="networkidle")
                popup.wait_for_function("document.getElementById('selection').value.length > 10")
                for tag in ["travel", "weekend"]:
                    popup.locator("#tags").fill(tag)
                    popup.locator("#tags").press("Enter")
                popup.locator("#color").select_option("blue")
                popup.locator("#pinned").check()
                return popup

            popup = popup_filled()
            popup.locator("#cloudUnlock").fill(PASSPHRASE)
            popup.locator("#saveBtn").click()
            popup.locator("#status").filter(has_text="Encrypted clip saved to cloud").wait_for()
            credentials = options.evaluate("chrome.storage.session.get('cloudSession')")["cloudSession"]["credentials"]
            web.evaluate("""async ([credentials, notes]) => {
              const { CloudClient } = await import('/shared/client.mjs');
              const client = new CloudClient(credentials);
              for (const [path, text] of notes) await client.write(path, new TextEncoder().encode(text), 0);
            }""", [credentials, DEMO_NOTES])

            # (a) The popup, unlocked, saving to the cloud.
            popup = popup_filled()
            popup.locator("#status").filter(has_text="Ready").wait_for()
            popup.mouse.move(0, 0)
            shots["popup"] = popup.locator("body").screenshot(animations="disabled")

            # (b) The settings, connected and unlocked, as at app.jotdrop.net.
            options.evaluate("localStorage.setItem('demo-production', '1')")
            options.evaluate("chrome.storage.local.set({ cloudServer: 'https://app.jotdrop.net' })")
            options.set_viewport_size({"width": 600, "height": 560})
            options.reload(wait_until="networkidle")
            options.locator("#cloudState").filter(has_text="Connected to app.jotdrop.net.").wait_for()
            shots["settings"] = options.screenshot(clip={"x": 0, "y": 0, "width": 600, "height": 430}, animations="disabled")

            # (c) The clip as a card in the web app.
            web.set_viewport_size({"width": 1100, "height": 860})
            web.locator('[data-view="notes"]').click()
            web.locator("#sync").click()
            web.locator(".note-card").filter(has_text=TITLE).wait_for()
            web.locator(".note-card").filter(has_text="Book club").wait_for()
            web.locator("#sync-status").filter(has_text="up to date").wait_for()
            web.get_by_role("button", name="Hide menu").click()
            # From the "Notes" heading down: the cards are the point of this picture.
            web.evaluate("scrollTo(0, document.getElementById('view-title').getBoundingClientRect().top + scrollY - 24)")
            web.mouse.move(0, 0)
            web.wait_for_timeout(600)
            shots["web"] = web.screenshot(animations="disabled")

            icon = (ROOT / "chrome-extension" / "icons" / "icon128.png").read_bytes()
            canvas = playwright.chromium.launch(channel=channel, headless=True)
            try:
                page = canvas.new_page(viewport={"width": 1280, "height": 800}, device_scale_factor=1)
                icon_uri = data_uri(icon)
                compose(page, "1-clip-any-page.png", "", copy_block(
                    icon_uri, "the Google Keep alternative", "Clip any page in <mark>two clicks.</mark>",
                    ["<b>Pages, links and highlights</b> become note cards", "<b>Tags, a color, a pin</b> before you save",
                     "Saves to <b>Obsidian</b>, to <b>JotDrop Cloud</b> or to both"]),
                    f"<div class='frame' style='left:540px;top:70px;width:680px;height:640px'><div class='bar'><i></i><i></i><i></i><span>{ARTICLE_HOST}</span><img src='{icon_uri}' alt=''></div>"
                    f"<div class='article'><small>THE LONG WEEKEND</small><h2>{TITLE}</h2><div class='meta'>A travel journal · 6 min read</div><div class='pic'></div>"
                    f"<p>The best trips start before you arrive. <mark>{SELECTION}</mark> Pack light and leave room in the day for getting lost.</p></div></div>"
                    f"<div class='popup' style='left:842px;top:118px;width:364px'><img class='shot' style='width:360px' src='{data_uri(shots['popup'])}' alt=''></div>")
                compose(page, "4-cloud-or-obsidian.png", "ink", copy_block(
                    icon_uri, "your thoughts. not our business.", "Obsidian or the cloud. <mark>Your call.</mark>",
                    ["<b>Obsidian:</b> plain Markdown on your own computer, no account", "<b>JotDrop Cloud:</b> no Obsidian needed, encrypted in your browser before upload",
                     "<b>Free and open source</b> (MIT), no ads, no tracking"]),
                    f"<div class='frame' style='left:610px;top:180px;width:604px'><img class='shot' style='width:600px' src='{data_uri(shots['settings'])}' alt=''></div>")
                compose(page, "5-cards-in-the-web-app.png", "", copy_block(
                    icon_uri, "no Obsidian needed", "Lands in your <mark>JotDrop Cloud.</mark>",
                    ["<b>A card in the web app</b> at app.jotdrop.net, with your tags and color", "Also on <b>Android</b>, and in <b>Obsidian</b> if it syncs",
                     "<b>End-to-end encrypted:</b> the server cannot read your clips"]),
                    f"<div class='frame' style='left:540px;top:90px;width:680px'><div class='bar'><i></i><i></i><i></i><span>app.jotdrop.net</span></div><img class='shot' style='width:676px' src='{data_uri(shots['web'])}' alt=''></div>")
            finally:
                canvas.close()
        finally:
            context.close()
            if server:
                stop(server)
            article.shutdown()


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="jotdrop-store-shots-") as workdir:
        capture(sys.argv[1] if len(sys.argv) > 1 else "msedge", workdir)
    print(f"Screenshots written to {OUT}")

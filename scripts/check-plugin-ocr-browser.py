"""Plugin text recognition in a real browser: one-time checked download, English + Dutch OCR, no other requests.
In-memory vault; the GitHub download is served from node_modules. Run: python scripts/check-plugin-ocr-browser.py"""
from pathlib import Path
import json
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
RELEASE = "https://github.com/Diexar-Labs/jotdrop/releases/download/ocr-data-1/"
PAGE = "https://ocr-check.invalid/"
with tempfile.TemporaryDirectory(prefix="jotdrop-ocr-check-") as directory:
    stub, entry = Path(directory) / "obsidian.ts", Path(directory) / "entry.ts"
    stub.write_text("""export const normalizePath = (path: string) => path.replace(/\\/+/g, "/");
export async function requestUrl({ url }: { url: string }) {
  const response = await fetch(url);
  return { status: response.status, arrayBuffer: await response.arrayBuffer() };
}""", encoding="utf-8")
    entry.write_text(f"""import {{ LocalOcr }} from {json.dumps((root / "src/ocr.ts").as_posix())};
const files = new Map<string, ArrayBuffer>();
(globalThis as any).files = files;
(globalThis as any).ocr = new LocalOcr({{ vault: {{ adapter: {{
  exists: async (path: string) => files.has(path) || [...files.keys()].some((key) => key.startsWith(path + "/")),
  mkdir: async () => {{}},
  writeBinary: async (path: string, data: ArrayBuffer) => {{ files.set(path, data); }},
  readBinary: async (path: string) => files.get(path)!,
}} }} }} as any, ".obsidian/plugins/jotdrop");""", encoding="utf-8")
    bundle = subprocess.check_output([
        "node", "node_modules/esbuild/bin/esbuild", str(entry), "--bundle", "--format=iife",
        f"--alias:obsidian={stub}", "--loader:.min.js=text", "--loader:.wasm.js=text",
    ], cwd=root, text=True, encoding="utf-8")

data = {name: (root / f"node_modules/@tesseract.js-data/{name[:3]}/4.0.0_best_int/{name}").read_bytes() for name in ("eng.traineddata.gz", "nld.traineddata.gz")}
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, channel=sys.argv[1] if len(sys.argv) > 1 else "msedge")
    try:
        page = browser.new_page()
        requests = []

        def serve(route):
            requests.append(route.request.url)
            name = route.request.url.removeprefix(RELEASE)
            if route.request.url == PAGE:
                route.fulfill(status=200, body="<!doctype html><meta charset=utf-8>", content_type="text/html")
            elif name in data:
                route.fulfill(status=200, body=data[name], content_type="application/gzip")
            else:
                route.abort()

        page.route("**/*", serve)
        # A secure context, like Obsidian, so crypto.subtle exists.
        page.goto(PAGE)
        page.add_script_tag(content=bundle)
        result = page.evaluate("""async () => {
          const before = await ocr.hasData();
          await ocr.download();
          const canvas = new OffscreenCanvas(900, 260), g = canvas.getContext('2d');
          g.fillStyle = 'white'; g.fillRect(0, 0, 900, 260); g.fillStyle = 'black'; g.font = '48px Arial';
          g.fillText('Hello JotDrop plugin', 30, 90); g.fillText('Boodschappen: melk en kaas', 30, 190);
          const image = await canvas.convertToBlob({ type: 'image/png' });
          const text = await ocr.recognize(image, () => {});
          const key = [...files.keys()][0], damaged = files.get(key).slice(0);
          new Uint8Array(damaged)[100] ^= 1; files.set(key, damaged);
          let tampered = 'accepted'; try { await ocr.recognize(image, () => {}); } catch (error) { tampered = error.message; }
          return { before, after: await ocr.hasData(), text, tampered };
        }""")
        assert result["before"] is False and result["after"] is True, result
        assert result["text"] == "Hello JotDrop plugin\nBoodschappen: melk en kaas", result["text"]
        assert result["tampered"] == "data-missing", result
        assert sorted(requests) == [RELEASE + "eng.traineddata.gz", RELEASE + "nld.traineddata.gz", PAGE], requests
        print(json.dumps({"checked_download": True, "english_dutch_ocr": True, "damaged_data_rejected": True, "only_release_requests": True}))
    finally:
        browser.close()

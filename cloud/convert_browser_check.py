"""Run: python cloud/convert_browser_check.py. Local synthetic check: files saved before encrypted pieces move into pieces after a website sync, and stay readable."""
import json
import os
import subprocess
import sys
sys.dont_write_bytecode = True
from pathlib import Path
from browser_check import main

ROOT = Path(__file__).resolve().parent.parent
# Another device that saved two versions of a large file and one small note the way clients did before pieces.
LEGACY = """
import { CloudClient } from './cloud/shared/client.mjs';
import { bytesToBase64, encryptEnvelope, objectId } from './cloud/shared/crypto.mjs';
const client = await CloudClient.recover({ url: process.env.URL, recoveryCode: process.env.CODE, deviceName: 'Old device' });
const { vaultKey, vaultId } = client.credentials;
const save = async (path, bytes, baseRevision) => {
  const id = await objectId(vaultKey, path);
  const envelope = await encryptEnvelope(vaultKey, { path, content: bytesToBase64(bytes), modifiedAt: new Date().toISOString() }, `jotdrop:object:v1:${vaultId}:${id}`);
  return client.commitWrite({ id, baseRevision, envelope: JSON.stringify(envelope) });
};
await save('attachments/old-scan.bin', new Uint8Array(3 * 1024 * 1024).fill(7), 0);
await save('attachments/old-scan.bin', new Uint8Array(2 * 1024 * 1024).fill(8), 1);
await save('notes/Old note.md', new TextEncoder().encode('# Saved before pieces'), 0);
const status = await client.status();
console.log(JSON.stringify({ legacy: status.pieces.legacy, used: status.usedBytes, credentials: client.credentials }));
"""
AFTER = """
import { CloudClient } from './cloud/shared/client.mjs';
import { objectId } from './cloud/shared/crypto.mjs';
const client = new CloudClient(JSON.parse(process.env.CREDENTIALS));
const id = await objectId(client.credentials.vaultKey, 'attachments/old-scan.bin');
const status = await client.status(), latest = await client.read(id), first = await client.read(id, 1);
console.log(JSON.stringify({ legacy: status.pieces.legacy, used: status.usedBytes, pieces: (await client.readManifest(id)).manifest.pieces.length, latest: [latest.file.bytes.length, latest.file.bytes[0]], first: [first.file.bytes.length, first.file.bytes[0]] }));
"""


def node(script, **environment):
    result = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, env=dict(os.environ, **environment), capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout.strip().splitlines()[-1])


def check_convert(browser, url, token):
    page = browser.new_context(viewport={"width": 1280, "height": 800}).new_page()
    errors, statuses = [], []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.expose_function("recordStatus", lambda text: statuses.append(text))
    page.goto(url, wait_until="networkidle")
    page.locator("#show-connect").click()
    page.locator("#access-code").fill(token)
    for field in ["#new-password", "#confirm-password"]:
        page.locator(field).fill("synthetic convert passphrase")
    page.locator('#connect-form button[type="submit"]').click()
    page.wait_for_function("() => document.querySelector('#recovery-code').value.length > 0")
    code = page.locator("#recovery-code").input_value()
    page.locator("#recovery-saved").check()
    page.locator("#finish-recovery").click()
    page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
    before = node(LEGACY, URL=url, CODE=code)
    assert before["legacy"] == 2, before
    page.evaluate("new MutationObserver(() => window.recordStatus(document.querySelector('#sync-status').textContent)).observe(document.querySelector('#sync-status'), { childList: true, characterData: true, subtree: true })")
    page.locator("#sync").click()
    page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for(timeout=120000)
    assert any(text.startswith("Making your cloud storage smaller...") for text in statuses), statuses
    page.locator('[data-view="files"]').click()
    page.locator(".note-card", has_text="old-scan.bin").first.wait_for()
    after = node(AFTER, CREDENTIALS=json.dumps(before["credentials"]))
    assert after["legacy"] == 0 and after["pieces"] == 2 and after["latest"] == [2 * 1024 * 1024, 8] and after["first"] == [3 * 1024 * 1024, 7], after
    assert after["used"] < before["used"] * 0.7, (before, after)
    assert not errors, errors
    return {"before": before["used"], "after": after["used"], "statuses": [text for text in statuses if text.startswith("Making")][-1]}


if __name__ == "__main__":
    main(check_convert)

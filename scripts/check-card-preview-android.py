"""Synthetic UI check for an isolated jd_api35 emulator. Never targets a phone.

Run --seed once, choose Use without cloud and Documents/CompactPreviewTest in the
fresh test app, then run without --seed. Requires the verified R8 test APK.
"""
import argparse
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET

args = argparse.ArgumentParser()
args.add_argument('--serial', default='emulator-5556')
args.add_argument('--seed', action='store_true')
options = args.parse_args()
assert options.serial.startswith('emulator-'), 'Refusing a physical device'
adb = Path(os.environ['LOCALAPPDATA']) / 'Android/Sdk/platform-tools/adb.exe'


def run(*command):
    return subprocess.check_output([str(adb), '-s', options.serial, *command])


assert run('emu', 'avd', 'name').decode().splitlines()[0].strip() == 'jd_api35', 'Wrong AVD'
vault = '/sdcard/Documents/CompactPreviewTest'
folder = vault + '/Mini Notes'
if options.seed:
    exists = subprocess.run([str(adb), '-s', options.serial, 'shell', 'test', '-e', vault]).returncode == 0
    assert not exists, 'Refusing to overwrite existing fixture folder'
    run('shell', f"mkdir -p '{folder}'")
    with tempfile.TemporaryDirectory(prefix='compact-android-') as temp:
        for count in [0, 1, 5, 6, 10, 11, 100]:
            body = '\n'.join(f'- [ ] task {i + 1}' for i in range(count)) or 'Plain text'
            path = Path(temp) / f'compact-{count}.md'
            path.write_text(f'# compact-{count}\n\n{body}\n', encoding='utf-8')
            run('push', str(path), folder + '/' + path.name)
        path = Path(temp) / 'compact-article.md'
        path.write_text('# compact-article\n\n' + 'Article sentence. ' * 300 + '\n- [ ] A\n- [x] B\n- [ ] C\n', encoding='utf-8')
        run('push', str(path), folder + '/' + path.name)
    print('Seeded synthetic fixtures only in', folder)
    raise SystemExit()


def snapshot():
    output = run('shell', 'uiautomator', 'dump', '/sdcard/compact-check.xml').decode()
    assert 'dumped to' in output, output
    return ET.fromstring(run('exec-out', 'cat', '/sdcard/compact-check.xml'))


def tap(node):
    left, top, right, bottom = map(int, re.findall(r'\d+', node.attrib['bounds']))
    run('shell', 'input', 'tap', str((left + right) // 2), str((top + bottom) // 2))


def text_node(ui, text):
    return next(node for node in ui.iter('node') if node.get('text') == text)


def search(text):
    ui = snapshot()
    field = next(node for node in ui.iter('node') if node.get('class') == 'android.widget.EditText')
    tap(field)
    run('shell', 'input', 'keyevent', 'KEYCODE_MOVE_END')
    for _ in range(32):
        run('shell', 'input', 'keyevent', 'KEYCODE_DEL')
    run('shell', 'input', 'text', text)
    run('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    time.sleep(1)  # a cold R8 app filters later than .3 s
    return snapshot()


def saved_note():
    return run('exec-out', f"cat '{folder}/compact-100.md'").decode()


def wait_saved(line_index, expected):
    for _ in range(30):
        saved = saved_note()
        lines = saved.splitlines()  # may be read mid-write, so short for a moment
        if len(lines) > line_index and lines[line_index] == expected:
            return saved
        time.sleep(.1)
    raise AssertionError((expected, lines[line_index:line_index + 1]))


ui = search('compact-100')
tasks = [node for node in ui.iter('node') if re.fullmatch(r'task \d+', node.get('content-desc') or '')]
assert 0 < len(tasks) <= 5, len(tasks)
tap(text_node(ui, 'More'))
time.sleep(1)  # let the expanded card settle before reading tap targets
ui = snapshot()
tasks = [node for node in ui.iter('node') if re.fullmatch(r'task \d+', node.get('content-desc') or '')]
assert 5 < len(tasks) <= 10, len(tasks)
last = tasks[-1]
index = int(last.get('content-desc').split()[1])
tap(last)
saved = wait_saved(index + 1, f'- [x] task {index}')
assert len([line for line in saved.splitlines() if line.startswith('- [')]) == 100
assert sum('[x]' in line for line in saved.splitlines()) == 1
tap(last)  # untick again so the fixture stays reusable
wait_saved(index + 1, f'- [ ] task {index}')
ui = snapshot()
tap(text_node(ui, 'Less'))
ui = search('compact-article')
# A long introduction is clipped to half the preview so the tasks after it stay visible.
assert {'A', 'B', 'C'} <= {node.get('content-desc') or '' for node in ui.iter('node')}
assert not any(node.get('text') == 'More' for node in ui.iter('node'))
assert not any('more tasks' in (node.get('text') or '') for node in ui.iter('node'))
assert any(node.get('text') == 'Open note' for node in ui.iter('node'))
shots = Path(tempfile.gettempdir()) / 'kilo/compact-card-checks'
shots.mkdir(parents=True, exist_ok=True)
(shots / 'android-article.png').write_bytes(run('exec-out', 'screencap', '-p'))
print('Android isolated R8 UI: compact/expanded limits, real source tick, intact 100 tasks, article prefix PASS')

"""Synthetic UI check for an isolated jd_api35 emulator. Never targets a phone.

Run --seed once (it only adds fixtures that are missing, never overwrites), choose Use
without cloud and Documents/CompactPreviewTest in the fresh test app, then run without
--seed. Requires the verified R8 test APK.
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
FIXTURES = {
    **{f'compact-{count}.md': '\n'.join(f'- [ ] task {i + 1}' for i in range(count)) or 'Plain text' for count in [0, 1, 5, 6, 10, 11, 100]},
    'compact-article.md': 'Article sentence. ' * 300 + '\n- [ ] A\n- [x] B\n- [ ] C',
    'compact-checked.md': '\n'.join(f"- [{'x' if i % 2 else ' '}] chk {i + 1}" for i in range(15)),
    'compact-mixed.md': 'Intro line\n- [ ] MA\n- [x] MB\nOutro',
    'compact-tagged.md': '- [ ] milk\n- [ ] bread\n\n#groceries',
}


def push(name):
    with tempfile.TemporaryDirectory(prefix='compact-android-') as temp:
        path = Path(temp) / name
        path.write_text(f'# {name[:-3]}\n\n{FIXTURES[name]}\n', encoding='utf-8')
        run('push', str(path), folder + '/' + name)


if options.seed:
    run('shell', f"mkdir -p '{folder}'")
    for name in FIXTURES:
        if subprocess.run([str(adb), '-s', options.serial, 'shell', 'test', '-e', f"'{folder}/{name}'"]).returncode != 0:
            push(name)
    print('Seeded missing synthetic fixtures only in', folder)
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
    run('shell', 'input', 'keyevent', 'KEYCODE_ENTER')
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


def tasks_in(ui, pattern=r'task \d+'):
    return [node for node in ui.iter('node') if re.fullmatch(pattern, node.get('content-desc') or '')]


def texts(ui):
    return [node.get('text') or '' for node in ui.iter('node')]


# Like Keep: up to 10 open tasks right away, no More/Less, the rest behind "Open note - N more tasks".
ui = search('compact-100')
tasks = tasks_in(ui)
assert len(tasks) == 10, len(tasks)
assert 'More' not in texts(ui) and 'Less' not in texts(ui)
assert 'Open note - 90 more tasks' in texts(ui), texts(ui)
last = tasks[-1]
index = int(last.get('content-desc').split()[1])
tap(last)
saved = wait_saved(index + 1, f'- [x] task {index}')
assert len([line for line in saved.splitlines() if line.startswith('- [')]) == 100
assert sum('[x]' in line for line in saved.splitlines()) == 1
time.sleep(1.2)  # the pen strikes it through, then it joins the checked ones
ui = snapshot()
names = [node.get('content-desc') for node in tasks_in(ui)]
assert f'task {index}' not in names and len(names) == 10, names
assert '+ 1 checked item' in texts(ui) and 'Open note - 89 more tasks' in texts(ui), texts(ui)
push('compact-100.md')  # restore the fixture

ui = search('compact-checked')
assert [node.get('content-desc') for node in tasks_in(ui, r'chk \d+')] == [f'chk {i}' for i in range(1, 16, 2)], tasks_in(ui, r'chk \d+')
assert '+ 7 checked items' in texts(ui), texts(ui)

ui = search('compact-mixed')
# Any other text makes it a text card: tasks read as ☐/☑ text, without tap targets.
assert not tasks_in(ui, r'M[AB]'), tasks_in(ui, r'M[AB]')
assert any('☐ MA' in t for t in texts(ui)) and any('☑ MB' in t for t in texts(ui)), texts(ui)

ui = search('compact-tagged')
assert [node.get('content-desc') for node in tasks_in(ui, r'milk|bread')] == ['milk', 'bread'], texts(ui)

ui = search('compact-article')
assert not tasks_in(ui, r'[ABC]'), tasks_in(ui, r'[ABC]')
assert 'Open note' in texts(ui), texts(ui)
assert not any('more task' in t or 'checked item' in t for t in texts(ui)), texts(ui)
shots = Path(tempfile.gettempdir()) / 'kilo/compact-card-checks'
shots.mkdir(parents=True, exist_ok=True)
(shots / 'android-article.png').write_bytes(run('exec-out', 'screencap', '-p'))
print('Android isolated R8 UI (Keep model): 10 open tasks, real source tick then folded, checked folded, mixed = text, tag line, article PASS')

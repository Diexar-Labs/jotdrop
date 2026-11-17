"""Synthetic UI check for an isolated jd_api35 emulator. Never targets a phone.

Run --seed once (it only adds fixtures that are missing, never overwrites), choose Use
without cloud and Documents/CompactPreviewTest in the fresh test app, then run without
--seed. Requires the verified R8 test APK. Then turn on "Move checked items to the bottom"
in the test app's settings and run with --move.
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
args.add_argument('--move', action='store_true', help='the setting "Move checked items to the bottom" is on')
args.add_argument('--package', default='com.diexar.keepcapture', help='the test app, to bring it back after a restore')
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
    # Eric's card "ggggh" (17 Nov 2026): tasks, text, a bullet and a numbered list in one note.
    'compact-ggggh.md': 'Shopping:\n- [ ] GA\n- [x] GB\n- Apples\n1. First\n2. Then\nDone',
    'compact-levels.md': '- One\n\t- Two\n\t\t- Three\n\t\t\t- Four\n\nAfter',
    'compact-head.md': '- [x] Suitcase\n\t- [ ] Charger\n- [x] Passport\n- [ ] Bag',
    'compact-move.md': 'Before\n- [ ] MoveA\n- [ ] MoveB\n- [x] MoveC\nAfter',
}


def push(name):
    with tempfile.TemporaryDirectory(prefix='compact-android-') as temp:
        path = Path(temp) / name
        path.write_text(f'# {name[:-3]}\n\n{FIXTURES[name]}\n', encoding='utf-8')
        run('push', str(path), folder + '/' + name)


def restore(name):
    """Puts a fixture back; the app reads its folder again when it comes back to the front."""
    push(name)
    run('shell', 'input', 'keyevent', 'KEYCODE_HOME')
    time.sleep(.5)
    run('shell', 'monkey', '-p', options.package, '-c', 'android.intent.category.LAUNCHER', '1')
    time.sleep(1.5)


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


def saved_note(name='compact-100.md'):
    return run('exec-out', f"cat '{folder}/{name}'").decode()


def wait_saved(line_index, expected, name='compact-100.md'):
    for _ in range(30):
        saved = saved_note(name)
        lines = saved.splitlines()  # may be read mid-write, so short for a moment
        if len(lines) > line_index and lines[line_index] == expected:
            return saved
        time.sleep(.1)
    raise AssertionError((expected, lines[line_index:line_index + 1]))


def wait_body(name, expected):
    """Waits until the note holds exactly the fixture's title and the body `expected` (line endings as pushed)."""
    for _ in range(40):
        saved = saved_note(name)
        if saved.replace('\r\n', '\n') == f'# {name[:-3]}\n\n{expected}\n':
            return
        time.sleep(.1)
    raise AssertionError((name, expected, saved))


def tasks_in(ui, pattern=r'task \d+'):
    return [node for node in ui.iter('node') if re.fullmatch(pattern, node.get('content-desc') or '')]


def texts(ui):
    return [node.get('text') or '' for node in ui.iter('node')]


def bounds(node):
    return list(map(int, re.findall(r'\d+', node.attrib['bounds'])))


def checked(ui, nodes):
    """The state of each task's box: it sits on the toggle around the node that carries the task's name."""
    parents = {child: parent for parent in ui.iter() for child in parent}
    return [parents[node].get('checked') for node in nodes]


def text_with(ui, text):
    return next(node for node in ui.iter('node') if (node.get('text') or '').startswith(text))


if options.move:
    # "Move checked items to the bottom" is on: a tick on the card moves the task in the note itself, after the pen
    # has struck it through, and the card stays where it is (design kaarten-en-lijsten, part 6).
    ui = search('compact-move')
    card = [node.get('content-desc') for node in tasks_in(ui, r'Move[ABC]')]
    assert card == ['MoveA', 'MoveB', 'MoveC'], card
    top = bounds(text_with(ui, 'Before'))[1]
    tap(tasks_in(ui, 'MoveA')[0])
    wait_body('compact-move.md', 'Before\n- [ ] MoveB\n- [x] MoveA\n- [x] MoveC\nAfter')
    time.sleep(1)
    ui = snapshot()
    assert [node.get('content-desc') for node in tasks_in(ui, r'Move[ABC]')] == ['MoveB', 'MoveA', 'MoveC'], texts(ui)
    assert bounds(text_with(ui, 'Before'))[1] == top, 'the card moved'
    # Unticked, it goes back up above the first ticked one: here it is already there.
    tap(tasks_in(ui, 'MoveA')[0])
    wait_body('compact-move.md', 'Before\n- [ ] MoveB\n- [ ] MoveA\n- [x] MoveC\nAfter')
    restore('compact-move.md')
    # Two quick taps: the second waits for the first to settle, then ticks its own task at its new place.
    ui = search('compact-move')
    (a, b), (c, d) = ((sum(bounds(node)[0::2]) // 2, sum(bounds(node)[1::2]) // 2) for node in [tasks_in(ui, 'MoveA')[0], tasks_in(ui, 'MoveB')[0]])
    # Both taps start in one shell, 0.2 s apart, so the second lands while the first is still settling.
    run('shell', f'input tap {a} {b} & sleep 0.2; input tap {c} {d}; wait')
    wait_body('compact-move.md', 'Before\n- [x] MoveB\n- [x] MoveA\n- [x] MoveC\nAfter')
    restore('compact-move.md')
    # A plain checklist card: the ticked task folds into "+ N checked items" as before, and moves in the file.
    ui = search('compact-5')
    tap(tasks_in(ui)[0])
    wait_body('compact-5.md', '- [ ] task 2\n- [ ] task 3\n- [ ] task 4\n- [ ] task 5\n- [x] task 1')
    time.sleep(1.2)
    ui = snapshot()
    assert [node.get('content-desc') for node in tasks_in(ui)] == [f'task {i}' for i in range(2, 6)], texts(ui)
    assert '+ 1 checked item' in texts(ui), texts(ui)
    restore('compact-5.md')
    print('Android isolated R8 UI (move checked on): tick moves after the stroke, card stays, untick, two quick taps, checklist card PASS')
    raise SystemExit()


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
restore('compact-100.md')

ui = search('compact-checked')
assert [node.get('content-desc') for node in tasks_in(ui, r'chk \d+')] == [f'chk {i}' for i in range(1, 16, 2)], tasks_in(ui, r'chk \d+')
assert '+ 7 checked items' in texts(ui), texts(ui)

ui = search('compact-mixed')
# Tasks with other text make a mixed card (design kaarten-en-lijsten, part 5): the rows in the note's order, every
# task with a real box, the ticked one struck through in place, no "+ N checked items".
mixed = tasks_in(ui, r'M[AB]')
assert [node.get('content-desc') for node in mixed] == ['MA', 'MB'], texts(ui)
assert checked(ui, mixed) == ['false', 'true'], [node.attrib for node in mixed]
tops = [bounds(text_with(ui, 'Intro line'))[1], *(bounds(node)[1] for node in mixed), bounds(text_with(ui, 'Outro'))[1]]
assert tops == sorted(tops), tops
assert not any('checked item' in t for t in texts(ui)), texts(ui)
# Ticked and unticked again; with the setting off (its default) the task stays on its line.
tap(mixed[0])
wait_saved(3, '- [x] MA', 'compact-mixed.md')
time.sleep(1)
ui = snapshot()
assert checked(ui, tasks_in(ui, r'M[AB]')) == ['true', 'true'], texts(ui)
tap(tasks_in(ui, 'MA')[0])
wait_saved(3, '- [ ] MA', 'compact-mixed.md')
restore('compact-mixed.md')

ui = search('compact-ggggh')
assert [node.get('content-desc') for node in tasks_in(ui, r'G[AB]')] == ['GA', 'GB'], texts(ui)
assert any(t.startswith('• Apples') for t in texts(ui)) and any(t.startswith('1. First') for t in texts(ui)), texts(ui)

# Lists in levels: each level a margin, 3 levels on the card, deeper stays on the third.
ui = search('compact-levels')
left = {word: bounds(text_with(ui, f'• {word}'))[0] for word in ['One', 'Two', 'Three', 'Four']}
assert left['One'] < left['Two'] < left['Three'] == left['Four'], left
assert bounds(text_with(ui, 'After'))[0] == left['One'], left

# A ticked task with an open sub-task stays, struck through, as its heading; the other ticked one folds.
ui = search('compact-head')
head = tasks_in(ui, r'Suitcase|Charger|Passport|Bag')
assert [node.get('content-desc') for node in head] == ['Suitcase', 'Charger', 'Bag'], texts(ui)
assert checked(ui, head)[0] == 'true' and '+ 1 checked item' in texts(ui), texts(ui)

ui = search('compact-tagged')
assert [node.get('content-desc') for node in tasks_in(ui, r'milk|bread')] == ['milk', 'bread'], texts(ui)

# mrjo118's note (Joplin forum 51337): a lot of text, then 3 tasks. The text fills the text card's room, the card is
# no higher than before and says how many tasks are behind it.
ui = search('compact-article')
assert not tasks_in(ui, r'[ABC]'), tasks_in(ui, r'[ABC]')
assert 'Open note - 3 more tasks' in texts(ui), texts(ui)
assert not any('checked item' in t for t in texts(ui)), texts(ui)
shots = Path(tempfile.gettempdir()) / 'kilo/compact-card-checks'
shots.mkdir(parents=True, exist_ok=True)
(shots / 'android-article.png').write_bytes(run('exec-out', 'screencap', '-p'))
print('Android isolated R8 UI: 10 open tasks, real source tick then folded, checked folded, mixed card ticks both ways, '
      'ggggh, levels, heading task, tag line, article PASS')

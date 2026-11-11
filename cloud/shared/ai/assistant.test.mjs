import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_ROUNDS, TIMEOUT_MS, runAssistant } from './assistant.mjs';

const vectors = JSON.parse(readFileSync(new URL('./ai-vectors.json', import.meta.url), 'utf8'));
const settings = { language: 'English', date: '2026-11-09', timeZone: 'Europe/Madrid' };

// A provider that plays back the steps of a vector, in JotDrop's own message form.
function scripted(steps, seen = []) {
  const left = [...steps];
  return {
    model: 'fake',
    async complete(request) {
      seen.push(structuredClone({ system: request.system, messages: request.messages, tools: request.tools }));
      const step = left.shift() ?? { text: '' };
      const toolCalls = step.toolCalls ?? [];
      return { text: step.text ?? '', toolCalls, stop: step.stop ?? (toolCalls.length ? 'tool' : 'end'), usage: { input: 100, output: 20 }, raw: undefined };
    },
  };
}

// The app's side: only changes go here; search and read stay in the shared code.
function memoryExecutor() {
  const executed = [];
  const run = (name) => async (input) => { executed.push(name); return name === 'create_note' ? { id: 'new-1', title: input.title } : 'Done.'; };
  const names = ['create_note', 'append_to_note', 'replace_note_text', 'set_labels', 'set_reminder', 'set_expiry', 'open_note'];
  return { executed, executor: Object.fromEntries(names.map((name) => [name, run(name)])) };
}

async function play(vector) {
  const { executed, executor } = memoryExecutor();
  const answers = [...(vector.confirm ?? [])];
  const asked = [];
  const fetches = [];
  const http = [...(vector.http ?? [])];
  const fetcher = async (url, init) => {
    fetches.push({ url, body: init.body });
    const next = http.shift();
    assert.ok(next, `unexpected call to ${url}`);
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  const report = await runAssistant({
    request: vector.request,
    notes: vector.notes ?? [],
    labels: vector.labels ?? [],
    settings,
    provider: vector.script ? scripted(vector.script) : undefined,
    config: vector.config,
    fetcher,
    executor,
    confirm: async (change) => { asked.push(change.tool); return answers.shift() ?? false; },
  });
  return { report, executed, asked, fetches };
}

for (const vector of vectors.conversations) {
  test(`conversation: ${vector.name}`, async () => {
    const { report, executed, asked, fetches } = await play(vector);
    const want = vector.expect;
    assert.equal(report.stop, want.stop);
    assert.equal(report.answer, want.answer);
    assert.deepEqual(report.actions.map((action) => [action.tool, action.status]), want.actions.map(([tool, status]) => [tool, status]));
    for (const [i, [, , reason]] of want.actions.entries()) if (reason) assert.equal(report.actions[i].reason, reason);
    assert.deepEqual(executed, want.executed);
    assert.deepEqual(asked, want.asked);
    assert.deepEqual(report.sent.map((note) => note.id), want.sent);
    assert.equal(report.rounds, want.rounds);
    if (want.sources) assert.deepEqual(report.sources.map((note) => note.id), want.sources);
    if (want.error) assert.equal(report.error.code, want.error);
    if (want.fetches) assert.deepEqual(fetches.map((call) => call.url), want.fetches);
    if (vector.config?.key?.trim()) assert.ok(!JSON.stringify(report).includes(vector.config.key.trim()), 'the key is in the report');
  });
}

test('limits from the design: 6 rounds, 60 seconds', () => {
  assert.equal(MAX_ROUNDS, 6);
  assert.equal(TIMEOUT_MS, 60000);
});

test('the first message: notes as data, then the request; the system prompt has the settings', async () => {
  const seen = [];
  await runAssistant({ request: 'What is the wifi code?', notes: [{ id: 'o', title: 'Oma', text: 'Wifi code: tulip42' }], labels: ['Home'], settings, provider: scripted([{ text: 'tulip42' }], seen), executor: {}, confirm: async () => false });
  const [first] = seen;
  assert.match(first.system, /English/);
  assert.match(first.system, /Home/);
  assert.equal(first.messages.length, 1);
  const text = first.messages[0].text;
  assert.ok(text.indexOf('<note id="o">') < text.indexOf('What is the wifi code?'));
  assert.match(text, /tulip42/);
  assert.deepEqual(first.tools.map((tool) => tool.name).slice(0, 2), ['search_notes', 'read_note']);
});

test('a confirmed change shows the note as it is now; a new label is pointed out', async () => {
  const changes = [];
  const { executor } = memoryExecutor();
  const notes = [{ id: 'shop', title: 'Shopping', text: '- [ ] eggs', labels: ['Home'] }];
  await runAssistant({
    request: 'Shopping: label it', notes, labels: ['Home'], settings, executor,
    provider: scripted([{ toolCalls: [{ id: 't', name: 'set_labels', input: { id: 'shop', labels: ['Home', 'Food'] } }] }, { text: 'ok' }]),
    confirm: async (change) => { changes.push(change); return true; },
  });
  assert.equal(changes[0].note.text, '- [ ] eggs');
  assert.deepEqual(changes[0].newLabels, ['Food']);
});

test('the tool results go back in one message, errors marked, in the order asked', async () => {
  const seen = [];
  const { executor } = memoryExecutor();
  await runAssistant({
    request: 'x', notes: [], settings, executor, confirm: async () => false,
    provider: scripted([{ toolCalls: [{ id: 'a', name: 'open_note', input: { id: 'missing' } }, { id: 'b', name: 'delete_note', input: {} }] }, { text: 'done' }], seen),
  });
  const results = seen[1].messages.at(-1);
  assert.equal(results.role, 'tool');
  assert.deepEqual(results.results.map((r) => [r.id, r.name, Boolean(r.isError)]), [['a', 'open_note', true], ['b', 'delete_note', true]]);
  assert.match(results.results[1].content, /search_notes/);
});

test('a failing executor: the action fails, the error text has no key', async () => {
  const key = 'sk-ant-api03-SECRET-abcdefabcdef';
  const report = await runAssistant({
    request: 'x', notes: [], settings, confirm: async () => true,
    executor: { create_note: async () => { throw new Error(`disk full near ${key}`); } },
    provider: scripted([{ toolCalls: [{ id: 'a', name: 'create_note', input: { title: 'T' } }] }, { text: 'Sorry' }]),
    secrets: [key],
  });
  assert.equal(report.actions[0].status, 'failed');
  assert.ok(!JSON.stringify(report).includes(key));
});

test('time counts only while the AI service works, and stops the wait', async () => {
  const slow = { model: 'slow', complete: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('late'), { name: 'TimeoutError', code: 'timeout' })))) };
  const report = await runAssistant({ request: 'x', notes: [], settings, executor: {}, confirm: async () => false, provider: slow, timeoutMs: 30 });
  assert.equal(report.stop, 'timeout');
  // A user who takes their time over a confirmation does not use up the AI's time.
  let clock = 0;
  const report2 = await runAssistant({
    request: 'x', notes: [{ id: 'n', title: 'N', text: '' }], settings, timeoutMs: 1000, now: () => clock,
    executor: memoryExecutor().executor,
    confirm: async () => { clock += 5000; return true; },
    provider: scripted([{ toolCalls: [{ id: 'a', name: 'append_to_note', input: { id: 'n', text: 'x' } }] }, { text: 'done' }]),
  });
  assert.equal(report2.stop, 'done');
});

test('the text budget holds for read_note too', async () => {
  const notes = [{ id: 'big', title: 'Big', text: 'y'.repeat(40000) }];
  const seen = [];
  const report = await runAssistant({
    request: 'nothing matches', notes, settings, executor: {}, confirm: async () => false, maxChars: 5000,
    provider: scripted([{ toolCalls: [{ id: 'a', name: 'read_note', input: { id: 'big' } }] }, { toolCalls: [{ id: 'b', name: 'read_note', input: { id: 'big' } }] }, { text: 'ok' }], seen),
  });
  const first = seen[1].messages.at(-1).results[0].content;
  assert.ok(first.length <= 5000 + 200, `${first.length}`);
  assert.equal(report.actions[1].status, 'refused');
  assert.equal(report.actions[1].reason, 'limit');
  assert.ok(report.chars <= 5000);
});

test('usage adds up over the rounds', async () => {
  const report = await runAssistant({ request: 'x', notes: [], settings, executor: memoryExecutor().executor, confirm: async () => false, provider: scripted([{ toolCalls: [{ id: 'a', name: 'open_note', input: { id: 'q' } }] }, { text: 'ok' }]) });
  assert.deepEqual(report.usage, { input: 200, output: 40 });
});

test('a Stop while the user looks at a confirmation sends nothing more to the AI service', async () => {
  const seen = [];
  const stop = new AbortController();
  const report = await runAssistant({
    request: 'x', notes: [{ id: 'n', title: 'N', text: '' }], settings, signal: stop.signal,
    executor: memoryExecutor().executor,
    confirm: async () => { stop.abort(new DOMException('Stopped.', 'AbortError')); return false; },
    provider: scripted([{ toolCalls: [{ id: 'a', name: 'append_to_note', input: { id: 'n', text: 'x' } }] }, { text: 'done' }], seen),
  });
  assert.equal(report.stop, 'cancelled');
  assert.equal(seen.length, 1);
});

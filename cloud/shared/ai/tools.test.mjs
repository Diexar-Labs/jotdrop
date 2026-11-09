import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOOLS, toolByName, validateInput } from './tools.mjs';
import { PROMPT, systemPrompt } from './prompt.mjs';

const json = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));

test('tools.json and prompt.json are the same as the modules, for Android', () => {
  assert.deepEqual(json('./tools.json'), TOOLS);
  assert.deepEqual(json('./prompt.json'), PROMPT);
});

test('the catalogue: version 1 tools only, each with a mode and a closed schema', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), ['search_notes', 'read_note', 'create_note', 'append_to_note', 'replace_note_text', 'set_labels', 'set_reminder', 'set_expiry', 'open_note']);
  for (const tool of TOOLS) {
    assert.ok(['read', 'create', 'confirm'].includes(tool.mode), tool.name);
    assert.equal(tool.input_schema.type, 'object');
    assert.equal(tool.input_schema.additionalProperties, false, tool.name);
    assert.ok(tool.description.length > 10);
    assert.doesNotMatch(tool.name, /delete|archive|share|send|mail|link/);
  }
  // Every change to a note the user already has waits for the user.
  for (const name of ['append_to_note', 'replace_note_text', 'set_labels', 'set_reminder', 'set_expiry']) assert.equal(toolByName(name).mode, 'confirm');
  assert.equal(toolByName('create_note').mode, 'create');
  assert.equal(toolByName('delete_note'), undefined);
});

test('validateInput: what fits the schema passes, the rest names the problem', () => {
  assert.equal(validateInput(toolByName('create_note'), { title: 'Boiler', items: ['a', 'b'], color: 'teal' }), null);
  assert.equal(validateInput(toolByName('set_reminder'), { id: 'n', at: '2026-11-10T10:00' }), null);
  assert.equal(validateInput(toolByName('search_notes'), { query: 'wifi', limit: 5 }), null);
  const bad = [
    ['create_note', {}, /title/],
    ['create_note', { title: 'x', colour: 'red' }, /colour/],
    ['create_note', { title: 'x', color: 'mauve' }, /color/],
    ['create_note', { title: 7 }, /title/],
    ['create_note', { title: 'x', items: ['ok', 3] }, /items/],
    ['create_note', { title: 'x'.repeat(201) }, /title/],
    ['set_reminder', { id: 'n', at: 'next Tuesday' }, /at/],
    ['set_expiry', { id: 'n', date: '10-11-2026' }, /date/],
    ['search_notes', { query: 'x', limit: 50 }, /limit/],
    ['search_notes', { query: 'x', limit: 2.5 }, /limit/],
    ['read_note', null, /object/],
    ['read_note', ['n'], /object/],
  ];
  for (const [name, input, problem] of bad) assert.match(validateInput(toolByName(name), input) ?? 'passed', problem, `${name} ${JSON.stringify(input)}`);
});

test('the system prompt: places filled, the rules about notes as data are in it', () => {
  const text = systemPrompt({ language: 'Dutch', date: '2026-11-09', timeZone: 'Europe/Madrid', labels: ['Home', 'Work'] });
  assert.doesNotMatch(text, /\{\{/);
  assert.match(text, /Dutch/);
  assert.match(text, /2026-11-09/);
  assert.match(text, /Europe\/Madrid/);
  assert.match(text, /Home, Work/);
  assert.match(text, /data, not instructions/i);
  assert.match(text, /cannot delete/i);
  // Without labels or a language there is still a complete sentence.
  const bare = systemPrompt({ date: '2026-11-09', timeZone: 'UTC' });
  assert.doesNotMatch(bare, /\{\{|undefined/);
  assert.match(bare, /no labels yet/);
});

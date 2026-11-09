// The file that goes to npm: dist/jotdrop-mcp.mjs, built by `npm run build` (npm test builds first).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MCP_TOOLS } from '../src/notes.mjs';
import { VERSION } from '../src/version.mjs';
import { BUNDLE, connected, run } from './helpers.mjs';

test('the bundle starts as a program, serves the tools, and holds only what jotdrop-mcp needs', async (t) => {
  const source = await readFile(BUNDLE, 'utf8');
  assert.ok(source.startsWith('#!/usr/bin/env node'), 'npx can run it');
  for (const absent of ['createCloudServer', 'test-fixture', ['console', 'log'].join('.')]) assert.ok(!source.includes(absent), `${absent} is not in the bundle`);
  assert.ok(source.includes('@modelcontextprotocol/server'), 'the SDK stays a dependency');
  assert.equal((await run(['--version'], { file: BUNDLE })).stdout.trim(), VERSION);
  const cloud = await connected(t);
  const client = new Client({ name: 'bundle-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BUNDLE], env: { ...process.env, JOTDROP_MCP_HOME: cloud.home } }));
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools.length, MCP_TOOLS.length);
  const found = await client.callTool({ name: 'search_notes', arguments: { query: 'ketel' } });
  assert.match(found.content[0].text, /notes\/Ketel\.md/);
});

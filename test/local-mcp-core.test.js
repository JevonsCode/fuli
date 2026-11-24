import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openLocalMcpCore } from '../src/mcp/local-mcp-core.js';
import { createLocalScopeServer } from '../src/runner/local-scope-server.js';

// The MCP core a client's stdio entry and a follower's own half open alike
// (mcp/local-mcp-core.js, runner/local-scope-server.js). No Provider runs:
// the port named is the discard port, and nothing here reaches it.
const CONFIG = { version: 1, workspaces: [],
  personal: { providerUrl: 'http://127.0.0.1:9', accessToken: 'synthetic-token', principalId: 'synthetic-person', spaceId: 'space-synthetic' } };

function dataDirectory(t) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'fuli-local-core-'));
  writeFileSync(path.join(dataDir, 'graph-runtime.json'), JSON.stringify(CONFIG));
  t.after(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 }));
  return dataDir;
}

// The half is closed before the test ends, so before the folder's removal above:
// Windows refuses to delete a folder whose SQLite files are still open.
async function withHalf(half, work) {
  try { return await work(half); } finally { await half.close(); }
}

test('the core opens the application on that graph and hands the server its options and the lease', async (t) => {
  const dataDir = dataDirectory(t);
  const made = [];
  const globalWrites = { elsewhere: () => true, send: async () => ({ delivered: 0, queued: 0, refused: [] }) };
  const core = openLocalMcpCore({ runtimeConfigPath: path.join(dataDir, 'graph-runtime.json'), globalWrites,
    options: (app) => ({ sourceApplication: 'codex', toolProfile: 'chat', madeFor: app }),
    createServer: (app, options) => { made.push({ app, options }); return { close: async () => {} }; } });
  assert.equal(made.length, 1);
  assert.equal(made[0].options.madeFor, core.app, 'the options are made from the application');
  assert.equal(made[0].options.sourceApplication, 'codex');
  assert.equal(typeof made[0].options.withRuntimeLease, 'function', 'calls run under this graph\'s runtime lease');
  assert.equal(core.app.globalWrites, globalWrites, 'a follower\'s port reaches the checkpoint');
  assert.equal(core.app.config.personal.spaceId, 'space-synthetic');
  await core.closeApplication();
});

test('a server that cannot be made leaves no application open', (t) => {
  const dataDir = dataDirectory(t);
  assert.throws(() => openLocalMcpCore({ runtimeConfigPath: path.join(dataDir, 'graph-runtime.json'),
    createServer: () => { throw new TypeError('synthetic: no server'); } }), /no server/);
});

test('a follower\'s own half is the same MCP server, answered in this process', async (t) => {
  const dataDir = dataDirectory(t);
  const half = createLocalScopeServer({ dataDir, sourceApplication: 'codex', toolProfile: 'chat', sessionId: 'session-synthetic',
    globalWrites: { elsewhere: () => false } });
  await withHalf(half, async () => {
    const answer = await half.call('fuli_call', { toolName: 'not_a_fuli_tool', input: {} });
    assert.equal(answer.isError, true);
    assert.equal(answer.structuredContent.error.code, 'not_found');
    assert.match(answer.content[0].text, /Unknown Fuli tool/, 'what the follower says as tool_unknown_here');
    assert.equal((await half.application()).config.personal.spaceId, 'space-synthetic');
  });
});

test('a half that could not open is opened afresh by the next call', async (t) => {
  const dataDir = dataDirectory(t);
  let tries = 0;
  const half = createLocalScopeServer({ dataDir, sourceApplication: 'codex', toolProfile: 'chat', sessionId: 'session-synthetic',
    open: (options) => {
      tries += 1;
      if (tries === 1) throw new Error('synthetic: runtime not configured yet');
      return openLocalMcpCore(options);
    } });
  await withHalf(half, async () => {
    await assert.rejects(half.call('fuli_call', { toolName: 'x' }), /not configured yet/);
    const answer = await half.call('fuli_call', { toolName: 'not_a_fuli_tool', input: {} });
    assert.equal(answer.structuredContent.error.code, 'not_found');
    assert.equal(tries, 2);
  });
});

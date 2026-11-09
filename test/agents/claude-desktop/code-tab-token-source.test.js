import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { desktopCallSource } from '../../../src/agents/claude-desktop/code-tab-token-source.js';
import { callSourceApplication } from '../../../src/agents/call-source.js';
import { createMcpServer } from '../../../src/mcp/create-mcp-server.js';
import { ProviderRequestError } from '../../../src/graphiti/provider-client.js';

// rec#107: Claude Desktop's FULI process runs as `claude` and also serves its
// Code tab, whose prompt hook begins tasks as `claude_code`. Synthetic tokens
// and a Provider double only.
const CODE_TAB_TOKEN = 'fuli-task-codetab-synthetic';
const DESKTOP_TOKEN = 'fuli-task-desktop-synthetic';
const notFound = () => new ProviderRequestError('Task context not found for this client', { status: 404 });

function registry(reads = []) {
  return { context: async (token, source) => {
    reads.push([token, source]);
    if (token === CODE_TAB_TOKEN && source === 'claude_code') return { token, sourceApplication: 'claude_code' };
    throw notFound();
  } };
}

test('a Code-tab token runs as claude_code; every other call keeps claude', async () => {
  const reads = [];
  const app = { taskContextRegistry: registry(reads) };
  assert.equal(await desktopCallSource(app, { taskContextToken: CODE_TAB_TOKEN }), 'claude_code');
  assert.equal(await desktopCallSource(app, { taskContextToken: DESKTOP_TOKEN }), 'claude');
  assert.equal(await desktopCallSource(app, { query: 'no token' }), 'claude');
  assert.deepEqual(reads, [[CODE_TAB_TOKEN, 'claude_code'], [DESKTOP_TOKEN, 'claude_code']]);
});

test('only the Claude Desktop connection looks a token up; a Provider failure is not hidden', async () => {
  const reads = [];
  const app = { taskContextRegistry: registry(reads) };
  for (const source of ['claude_code', 'codex', 'cursor', 'other']) {
    assert.equal(await callSourceApplication(app, source, { taskContextToken: CODE_TAB_TOKEN }), source);
  }
  assert.deepEqual(reads, []);
  const down = { taskContextRegistry: { context: async () => {
    throw new ProviderRequestError('Provider is unavailable', { status: 503, code: 'provider_unavailable' }); } } };
  await assert.rejects(desktopCallSource(down, { taskContextToken: CODE_TAB_TOKEN }), /unavailable/);
});

test('a checkpoint through the Claude Desktop connection with a Code-tab token reaches the Provider as claude_code', async t => {
  const checkpoints = [];
  const app = { taskContextRegistry: registry(), preferenceDelivery: null,
    checkpointTaskKnowledge: async input => { checkpoints.push(input); return { status: 'checkpointed' }; } };
  const server = createMcpServer(app, { sourceApplication: 'claude', toolProfile: 'chat', hostSessionId: 'synthetic-host',
    registerResources: false });
  const client = new Client({ name: 'synthetic-claude-desktop', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(() => client.close());
  for (const token of [CODE_TAB_TOKEN, DESKTOP_TOKEN]) {
    await client.callTool({ name: 'checkpoint_task_knowledge', arguments: { taskContextToken: token,
      disposition: 'retain_nothing', reason: 'Synthetic check.' } });
  }
  assert.deepEqual(checkpoints.map(input => [input.taskContextToken, input.sourceApplication]),
    [[CODE_TAB_TOKEN, 'claude_code'], [DESKTOP_TOKEN, 'claude']]);
});

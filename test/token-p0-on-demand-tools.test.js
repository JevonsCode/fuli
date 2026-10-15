import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { listAgentTools } from '../src/agent-tools.js';
import { toolNamesForProfile } from '../src/mcp/tool-profiles.js';
import { ApplicationError } from '../src/app/application-error.js';

async function connected(app, operation, options = {}) {
  const server = createMcpServer(app, { env: {}, sourceApplication: 'claude_code',
    hostSessionId: 'synthetic-host', toolProfile: 'chat', registerResources: false, ...options });
  const client = new Client({ name: 'synthetic-on-demand', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try { await server.connect(b); await client.connect(a); await operation(client); }
  finally { await client.close(); await server.close(); }
}

test('chat discovers one complete management schema and calls it through the original contract', async () => {
  let received;
  await connected({ getProjectAgentMemory: async input => { received = input; return { revision: 9 }; } }, async client => {
    const names = (await client.listTools()).tools.map(t => t.name);
    assert.ok(names.includes('list_agent_interfaces'));
    assert.equal(names.includes('get_project_agent_memory'), false);
    const changed = new Promise(resolve => client.setNotificationHandler(ToolListChangedNotificationSchema, resolve));
    const catalog = await client.callTool({ name: 'list_agent_interfaces', arguments: { toolName: 'get_project_agent_memory' } });
    assert.deepEqual(catalog.structuredContent.tools[0].inputSchema,
      listAgentTools().find(t => t.name === 'get_project_agent_memory').inputSchema);
    assert.equal(catalog.structuredContent.truncated, undefined);
    await changed;
    assert.ok((await client.listTools()).tools.some(t => t.name === 'get_project_agent_memory'));
    const result = await client.callTool({ name: 'get_project_agent_memory',
      arguments: { personalSpaceId: 'synthetic-space', personalProjectId: 'synthetic-project', agentId: 'synthetic-agent' } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.revision, 9);
    assert.equal(received.sourceApplication, 'claude_code');
    assert.equal(received.sourceSessionId, 'synthetic-host');
  });
});

test('chat directory omits schemas and calls require exact discovery and original input validation', async () => {
  let calls = 0;
  await connected({ getProjectAgentMemory: async () => { calls++; } }, async client => {
    const directory = await client.callTool({ name: 'list_agent_interfaces', arguments: {} });
    assert.ok(directory.structuredContent.tools.length > 20);
    assert.ok(directory.structuredContent.tools.every(t => !t.inputSchema && !t.description));
    assert.equal((await client.callTool({ name: 'get_project_agent_memory', arguments: {} })).isError, true);
    assert.equal((await client.callTool({ name: 'list_agent_interfaces', arguments: { toolName: 'unknown-tool' } })).isError, true);
    await client.callTool({ name: 'list_agent_interfaces', arguments: { toolName: 'get_project_agent_memory' } });
    assert.equal((await client.callTool({ name: 'get_project_agent_memory', arguments: {} })).isError, true);
    assert.equal(calls, 0);
  });
});

test('a restricted allow-list cannot expose or invoke tools outside its boundary', async () => {
  await connected({}, async client => {
    await client.callTool({ name: 'list_agent_interfaces', arguments: { toolName: 'update_capture_policy' } });
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['list_agent_interfaces']);
    assert.equal((await client.callTool({ name: 'update_capture_policy', arguments: { enabled: false } })).isError, true);
  }, { toolNames: ['list_agent_interfaces'] });
});

test('an explicit allow-list identical to chat still cannot expand to every tool', async () => {
  await connected({}, async client => {
    await client.callTool({ name: 'list_agent_interfaces', arguments: { toolName: 'update_capture_policy' } });
    assert.equal((await client.listTools()).tools.some(t => t.name === 'update_capture_policy'), false);
    assert.equal((await client.callTool({ name: 'update_capture_policy', arguments: { enabled: false } })).isError, true);
  }, { toolNames: toolNamesForProfile('chat') });
});

test('discovered writes retain the original name, annotations and domain permission rejection', async () => {
  await connected({ updateCapturePolicy: () => { throw new ApplicationError('agent_access_disabled', 'Disabled'); } }, async client => {
    await client.callTool({ name: 'list_agent_interfaces', arguments: { toolName: 'update_capture_policy' } });
    const exposed = (await client.listTools()).tools.find(t => t.name === 'update_capture_policy');
    assert.equal(exposed.annotations.readOnlyHint, false);
    const result = await client.callTool({ name: 'update_capture_policy', arguments: { enabled: true } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'agent_access_disabled');
    assert.equal((await client.listTools()).tools.some(t => t.name === 'call_agent_tool'), false);
  });
});

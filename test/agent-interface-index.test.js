import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { listAgentTools } from '../src/agent-tools.js';
import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';

async function connected(operation) {
  const server = createMcpServer({}, { env: {}, sourceApplication: 'claude_code',
    hostSessionId: 'synthetic-host', toolProfile: 'chat', registerResources: false });
  const client = new Client({ name: 'synthetic-interface-index', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b); await client.connect(a);
    await operation(args => client.callTool({ name: 'list_agent_interfaces', arguments: args }));
  } finally { await client.close(); await server.close(); }
}

test('every tool name in the full catalog and the tool definitions appears in the index', async () => {
  await connected(async list => {
    const index = (await list({})).structuredContent;
    assert.equal(index.uiMutationParity, undefined);
    assert.equal(index.readWorkflows, undefined);
    const { uiMutationParity, readWorkflows } = agentInterfaceCatalog();
    const named = new Set([...Object.values(index.domains), ...Object.values(index.areaTools), index.otherTools].flat());
    for (const name of [...listAgentTools().map(tool => tool.name), ...readWorkflows.flatMap(item => item.toolNames),
      ...uiMutationParity.flatMap(entry => entry.toolNames ?? (entry.toolName ? [entry.toolName] : []))]) {
      assert.ok(named.has(name), name);
    }
  });
});

test('route finds the entry by its listed route or a real request path, with its area', async () => {
  await connected(async list => {
    for (const route of ['POST /api/peer/devices/:nodeId/revoke', 'post /api/peer/devices/node-7/revoke?x=1']) {
      const detail = (await list({ route })).structuredContent;
      assert.equal(detail.area, 'peer');
      assert.deepEqual(detail.uiMutationParity, [agentInterfaceCatalog().uiMutationParity
        .find(entry => entry.route === 'POST /api/peer/devices/:nodeId/revoke')]);
    }
    assert.equal((await list({ route: 'POST /api/peer/join/' })).structuredContent.uiMutationParity[0].route,
      'POST /api/peer/join');
  });
});

test('a read route points to its domain, and a route without its method says how to write it', async () => {
  await connected(async list => {
    const read = (await list({ route: 'GET /api/project-agents/synthetic-agent/memory/' })).structuredContent;
    assert.deepEqual([read.readRoute, read.route, read.domain],
      [true, 'GET /api/project-agents/:agentId/memory', 'agent-memory']);
    assert.match(read.message, /read route/);
    assert.equal(read.uiMutationParity, undefined);
    const bare = (await list({ route: '/api/peer/join' })).structuredContent;
    assert.equal(bare.found, false);
    assert.match(bare.message, /METHOD \/api\//);
  });
});

test('a tool schema and a route group name the domains that list their tools', async () => {
  await connected(async list => {
    assert.deepEqual((await list({ toolName: 'find_agents' })).structuredContent.domains, ['roundtable', 'standing-assignments']);
    const outside = await list({ toolName: 'message_agent' });
    assert.equal(outside.structuredContent.tools[0].name, 'message_agent');
    assert.equal(Object.hasOwn(outside.structuredContent, 'domains'), false);
    assert.deepEqual((await list({ area: 'roundtable' })).structuredContent.domains, ['roundtable']);
    assert.equal(Object.hasOwn((await list({ area: 'agent-pins' })).structuredContent, 'domains'), false);
  });
});

test('list_agent_interfaces describes the index and every argument in both profiles', async () => {
  const { CHAT_LISTING } = await import('../src/mcp/chat-listing.js');
  const definition = listAgentTools().find(tool => tool.name === 'list_agent_interfaces');
  for (const description of [definition.description, CHAT_LISTING.list_agent_interfaces.description]) {
    assert.match(description, /No arguments: index/);
    assert.match(description, /domain, area or route: one part/);
    assert.match(description, /toolName: its (full|complete) schema/);
  }
  for (const name of ['domain', 'area', 'route']) assert.ok(definition.inputSchema.properties[name].description, name);
});

test('a name that is not there says so and lists the names that are', async () => {
  await connected(async list => {
    const index = (await list({})).structuredContent;
    const domain = (await list({ domain: 'synthetic-missing' })).structuredContent;
    assert.equal(domain.found, false);
    assert.deepEqual(domain.domains, Object.keys(index.domains));
    for (const args of [{ area: 'synthetic-missing' }, { route: 'GET /api/synthetic-missing' }]) {
      const answer = await list(args);
      assert.equal(answer.isError, undefined);
      assert.equal(answer.structuredContent.found, false);
      assert.match(answer.structuredContent.message, /No /);
      assert.deepEqual(answer.structuredContent.areas, Object.keys(index.areas));
    }
    for (const args of [{ domain: 'synthetic-missing' }, { area: 'synthetic-missing' }, { route: 'GET /api/synthetic-missing' }]) {
      assert.ok(Buffer.byteLength((await list(args)).content[0].text) <= 16 * 1024);
    }
    const both = await list({ area: 'peer', domain: 'roundtable' });
    assert.equal(both.isError, true);
    assert.match(both.content[0].text, /at most one/);
  });
});

test('every tool\'s complete schema still fits the 16 KB answer', async () => {
  await connected(async list => {
    for (const { name } of listAgentTools()) {
      assert.notEqual((await list({ toolName: name })).structuredContent.error?.code, 'tool_catalog_too_large', name);
    }
  });
});

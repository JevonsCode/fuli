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
  });
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

import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';

async function withCatalog(catalog, operation) {
  const server = createMcpServer({ employees: { describeTools: async () => catalog } }, {
    env: {}, toolNames: ['list_employee_tools'], registerResources: false
  });
  const client = new Client({ name: 'employee-catalog-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    await operation(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const args = { projectPath: '/synthetic/project', templateId: 'jefa' };

test('employee discovery preserves executable nested schemas and all tool definitions', async () => {
  const properties = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`field${i}`, { type: 'string' }]));
  properties.store = { type: 'string' };
  const inputSchema = {
    type: 'object', properties: {
      tasks: { type: 'array', items: { type: 'object', properties, required: Object.keys(properties) } }
    }, required: ['tasks']
  };
  const tools = Array.from({ length: 25 }, (_, i) => ({
    name: `task_${i}`, permission: 'board.write', inputSchema,
    privatePath: '/synthetic/private-runtime'
  }));
  await withCatalog({ project: { id: 'project-a' }, templateId: 'jefa', tools,
    privatePath: '/synthetic/private-runtime' }, async client => {
    const result = await client.callTool({ name: 'list_employee_tools', arguments: args });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.tools.length, 25);
    assert.deepEqual(result.structuredContent.tools.at(-1).inputSchema, inputSchema);
    assert.equal(result.structuredContent.truncated, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private-runtime/);
  });
});

test('oversized employee contracts fail explicitly instead of returning a broken schema', async () => {
  await withCatalog({ tools: [{ name: 'large', permission: 'board.read', inputSchema: {
    type: 'object', description: 'x'.repeat(70 * 1024)
  } }] }, async client => {
    const result = await client.callTool({ name: 'list_employee_tools', arguments: args });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'tool_catalog_too_large');
    assert.match(result.structuredContent.error.message, /toolName|includeSchemas/);
  });
});

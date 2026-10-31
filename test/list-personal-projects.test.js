import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { listPersonalProjects } from '../src/graphiti/personal-projects.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';

test('list_personal_projects selects an exact project before MCP result truncation', async (t) => {
  const target = { project_id: 'sample', profile: { name: 'Sample', sources: [{ key: 'source', title: 'Synthetic source' }] } };
  const projects = [...Array.from({ length: 40 }, (_, i) => ({ project_id: `temporary-${i}`, profile: { name: 'Temporary' } })),
    target, { project_id: 'sample-extra', profile: { name: 'Similar' } }];
  const app = { config: { personal: { spaceId: 'synthetic-space' } },
    personal: { listPersonalProjects: async () => projects } };
  app.listPersonalProjects = input => listPersonalProjects(app, input);
  const server = createMcpServer(app, { env: {}, registerResources: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'synthetic-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });

  const schema = (await client.listTools()).tools.find(tool => tool.name === 'list_personal_projects').inputSchema;
  assert.deepEqual(schema.properties.projectId, { type: 'string', minLength: 1, maxLength: 128 });
  assert.ok(!schema.required?.includes('projectId'));
  const call = args => client.callTool({ name: 'list_personal_projects', arguments: args });
  const all = await call({});
  assert.equal(all.structuredContent.truncated, true);
  const selected = await call({ personalSpaceId: 'synthetic-space', projectId: 'sample' });
  assert.equal(selected.isError, undefined);
  assert.equal(selected.structuredContent.truncated, undefined);
  assert.deepEqual(selected.structuredContent.result, [target]);
  assert.deepEqual((await call({ projectId: 'missing' })).structuredContent.result, []);
  assert.deepEqual((await call({ projectId: 'Sample' })).structuredContent.result, []);
  for (const projectId of ['', 'x'.repeat(129), 12]) {
    assert.equal((await call({ projectId })).isError, true);
  }
  assert.equal((await call({ personalSpaceId: 'other-space', projectId: 'sample' })).isError, true);
  assert.deepEqual(await listPersonalProjects(app), projects);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { listAgentTools } from '../src/agent-tools.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';

// 11-11: the /flreview knowledge review and other obsolete features were
// retired. Their tools leave every list, and an old client calling one gets
// `tool_retired` for one release. Real MCP JSON-RPC over an in-memory
// transport with an empty app stub.
const KNOWLEDGE_REVIEW = 'Knowledge review was retired; ask Astro to organise the project instead.';
const RETIRED = new Map([
  ...['start_knowledge_review', 'list_knowledge_review_candidates', 'record_knowledge_review_progress',
    'finish_knowledge_review'].map((name) => [name, KNOWLEDGE_REVIEW]),
  ['preview_personal_global_preference_decision',
    'Personal-global preference decisions were removed; discover_personal_global_preference_candidates still lists candidates.']
]);

async function connect(t, toolProfile) {
  const server = createMcpServer({}, { env: {}, sourceApplication: 'codex', registerResources: false, toolProfile });
  const client = new Client({ name: 'fuli-retired-tools-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());
  return client;
}

test('retired tools are listed nowhere and answer tool_retired when called', async (t) => {
  const agentTools = listAgentTools().map(({ name }) => name);
  for (const name of RETIRED.keys()) assert.equal(agentTools.includes(name), false, name);

  const full = await connect(t, 'full');
  const listed = (await full.listTools()).tools.map(({ name }) => name);
  for (const name of RETIRED.keys()) assert.equal(listed.includes(name), false, name);

  const chat = await connect(t, 'chat');
  for (const [name, message] of RETIRED) {
    for (const result of [await full.callTool({ name, arguments: { personalSpaceId: 'synthetic-space' } }),
      await chat.callTool({ name: 'fuli_call', arguments: { toolName: name, input: {} } })]) {
      assert.equal(result.isError, true, name);
      assert.deepEqual(result.structuredContent.error, { code: 'tool_retired', message }, name);
    }
  }
  const unknown = await full.callTool({ name: 'never_a_fuli_tool', arguments: {} });
  assert.equal(unknown.structuredContent.error.code, 'not_found');
});

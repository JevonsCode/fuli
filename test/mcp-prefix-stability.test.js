// The MCP tool list and server instructions are the start of every request a
// client sends, so a prompt cache holds only while they stay the same bytes
// (rec#76). Within one FULI version they must not depend on the session, the
// time, the environment, the data or anything a call did: dynamic content goes
// through hook context and tool results. Synthetic data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';

const SENTINEL = 'SYNTHETIC_DYNAMIC_SENTINEL';
const SESSIONS = [
  { hostSessionId: '0e2b6a1c-0d3f-4c51-9a7e-6f1b2c3d4e5f', clock: () => new Date('2026-01-02T03:04:05Z'),
    env: { FULI_SYNTHETIC: `${SENTINEL}_ONE` }, project: `${SENTINEL}_project_one` },
  { hostSessionId: '7c9d8e7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f', clock: () => new Date('2027-11-30T23:59:59Z'),
    env: { FULI_SYNTHETIC: `${SENTINEL}_TWO`, CODEX_THREAD_ID: 'synthetic-thread' }, project: `${SENTINEL}_project_two` }
];

function syntheticApp(project) {
  return { config: { personal: { spaceId: `${SENTINEL}_space` } },
    getProjectAgentMemory: async () => ({ revision: 1, project }),
    listKnowledgeSpaces: async () => ({ spaces: [{ id: project }] }) };
}

// The bytes a client puts at the start of its prompt: instructions, then the
// listed tools in order.
async function prefix(client) {
  return JSON.stringify({ instructions: client.getInstructions(), tools: (await client.listTools()).tools });
}

async function session(profile, settings, operation) {
  const server = createMcpServer(syntheticApp(settings.project), { env: settings.env, clock: settings.clock,
    sourceApplication: 'claude_code', hostSessionId: settings.hostSessionId, toolProfile: profile, registerResources: false });
  const client = new Client({ name: 'synthetic-prefix', version: '1' });
  const changes = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, notification => changes.push(notification));
  const [a, b] = InMemoryTransport.createLinkedPair();
  try { await server.connect(b); await client.connect(a); return await operation(client, changes); }
  finally { await client.close(); await server.close(); }
}

// Every call an ordinary turn may make, including discovery of unlisted tools.
async function turns(client) {
  await client.callTool({ name: 'list_agent_interfaces', arguments: {} });
  await client.callTool({ name: 'list_agent_interfaces', arguments: { toolName: 'get_project_agent_memory' } });
  await client.callTool({ name: 'list_agent_interfaces', arguments: { toolName: 'update_capture_policy' } });
  const call = (toolName, input) => client.callTool({ name: 'fuli_call', arguments: { toolName, input } });
  await call('get_project_agent_memory', { personalSpaceId: 's', personalProjectId: 'p', agentId: 'a' });
  await call('list_knowledge_spaces', {});
  await call('unknown_tool', {});
}

for (const profile of ['chat', 'full']) {
  test(`the ${profile} profile prefix is byte-stable across sessions and turns`, async () => {
    const seen = [];
    for (const settings of SESSIONS) {
      await session(profile, settings, async (client, changes) => {
        const before = await prefix(client);
        if (profile === 'chat') await turns(client);
        // A host refreshes on tools/list_changed; none may come.
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(changes, []);
        assert.equal(await prefix(client), before);
        seen.push(before);
      });
    }
    assert.equal(seen[1], seen[0]);
    const listed = seen[0];
    assert.doesNotMatch(listed, new RegExp(SENTINEL));
    for (const { hostSessionId } of SESSIONS) assert.equal(listed.includes(hostSessionId), false);
    // No timestamp, date or identifier of a session, task or Agent.
    assert.doesNotMatch(listed, /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?/);
    assert.doesNotMatch(listed, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
    assert.doesNotMatch(listed, /fuli-task-[0-9a-f]/);
  });
}

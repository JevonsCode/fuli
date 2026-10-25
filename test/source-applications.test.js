// rec#11 D-64: a client list stored before OpenCode had its own source keeps
// covering it, on the Node side as in graph-provider/fuli_graph/client_coverage.py.
import assert from 'node:assert/strict';
import test from 'node:test';

import { coversClient, SOURCE_APPLICATIONS } from '../src/agents/source-applications.js';
import { getProjectAgentMemory } from '../src/graphiti/project-agent-memory.js';
import { listAgentTools } from '../src/agent-tools.js';

test('a list naming `other` covers OpenCode until it names OpenCode itself, and widens nothing else', () => {
  assert.equal(coversClient(['codex', 'other'], 'opencode'), true);
  assert.equal(coversClient(['opencode'], 'opencode'), true);
  assert.equal(coversClient(['codex'], 'opencode'), false);
  assert.equal(coversClient(undefined, 'opencode'), false);
  assert.equal(coversClient(['other'], 'codex'), false);
  assert.equal(coversClient(['opencode'], 'other'), false);
});

test('an existing Agent that allowed `other` loads its memory in OpenCode, with its stored profile unchanged', async () => {
  const profile = { status: 'active', allowedClients: ['codex', 'other'] };
  const reads = [];
  const application = (allowedClients) => ({
    getProjectAgent: async () => ({ profile: { ...profile, allowedClients }, memoryScope: 'reviewed_agent' }),
    personal: { getProjectAgentMemory: async (input) => { reads.push(input.sourceApplication); return null; } }
  });
  const input = { personalSpaceId: 'synthetic-space', personalProjectId: 'synthetic-project', agentId: 'synthetic-agent',
    sourceApplication: 'opencode' };
  await getProjectAgentMemory(application(profile.allowedClients), input).catch((error) => {
    assert.doesNotMatch(error.message, /not allowed/);
  });
  assert.deepEqual(reads, ['opencode']);
  assert.deepEqual(profile.allowedClients, ['codex', 'other']);
  await assert.rejects(getProjectAgentMemory(application(['codex']), input), /not allowed to load the Agent memory/);
});

test('every client list in the tool schemas can hold every source', () => {
  const lists = [];
  const walk = (tool, schema, path) => {
    if (schema?.type === 'array' && schema.items?.enum?.includes('other')) lists.push([`${tool}${path}`, schema]);
    for (const [key, value] of Object.entries(schema?.properties ?? {})) walk(tool, value, `${path}.${key}`);
  };
  for (const tool of listAgentTools()) walk(tool.name, tool.inputSchema, '');
  assert.ok(lists.some(([name]) => name === 'update_capture_policy.disabledSources'));
  assert.ok(lists.some(([name]) => name === 'upsert_project_agent.profile.allowedClients'));
  for (const [name, schema] of lists) {
    assert.deepEqual(schema.items.enum, [...SOURCE_APPLICATIONS], name);
    assert.equal(schema.maxItems, SOURCE_APPLICATIONS.length, name);
  }
});

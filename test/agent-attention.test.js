import assert from 'node:assert/strict';
import test from 'node:test';
import { listAgentTools, callAgentTool } from '../src/agent-tools.js';
import { jsonSchemaToZod } from '../src/mcp/tool-schema.js';
import { attentionInput, attentionRecord, listAgentAttention } from '../src/graphiti/agent-attention.js';
import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';

test('attention requires an explicit actionable request and never exposes human response as an Agent tool', async () => {
  const definitions = new Map(listAgentTools().map(tool => [tool.name, tool]));
  const input = { personalSpaceId: 'space', personalProjectId: 'project', agentId: 'agent',
    idempotencyKey: 'request-1', kind: 'question', title: 'Choose a target', detail: 'Two targets are available.', requestedAction: 'Choose A or B.' };
  const schema = jsonSchemaToZod(definitions.get('request_agent_attention').inputSchema);
  assert.equal(schema.safeParse(input).success, true);
  assert.equal(schema.safeParse({ ...input, requestedAction: '' }).success, false);
  assert.equal(schema.safeParse({ ...input, kind: 'running' }).success, false);
  assert.equal(definitions.has('respond_to_agent_attention'), false);
  assert.deepEqual(await callAgentTool({ getAgentAccessPolicy: () => ({ enabled: true }), requestAgentAttention: value => value }, 'request_agent_attention', input), input);
  const reply = agentInterfaceCatalog().uiMutationParity.find(item => item.route === 'POST /api/agent-attention/respond');
  assert.equal(reply.access, 'local_user_only');
});

test('attention maps scope, revisions and responses without losing complete counts', async () => {
  assert.deepEqual(attentionInput({ personalSpaceId: 'space', expectedRevision: 2, response: 'A' }), { personal_space_id: 'space', expected_revision: 2, response: 'A' });
  assert.deepEqual(attentionRecord({ request_id: 'request', responded_by: 'human', revision: 3 }), { requestId: 'request', respondedBy: 'human', revision: 3 });
  const result = await listAgentAttention({ personal: { listAgentAttention: async scope => {
    assert.equal(scope.personal_space_id, 'space');
    return { items: [{ request_id: 'one' }], total: 201, counts: { agent: 201 } };
  } } }, { personalSpaceId: 'space' });
  assert.equal(result.counts.agent, 201);
  assert.equal(result.items[0].requestId, 'one');
});

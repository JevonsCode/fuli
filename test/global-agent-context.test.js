import assert from 'node:assert/strict';
import test from 'node:test';
import { callAgentTool } from '../src/agent-tools.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { beginConversation, checkpointConversation } from '../src/graphiti/agent-conversations.js';
import { lookupTranscriptTask } from '../src/conversations/current-task-lookup.js';

// Synthetic Provider boundary; database isolation is covered in Provider acceptance.
test('global memory tools send null JSON scope and omit the project query parameter', async () => {
  let saved;
  const app = new FederatedGraphApplication({ version: 1, personal: {
    providerUrl: 'http://provider.test', accessToken: 'synthetic-test-token',
    principalId: 'synthetic-person', spaceId: 'synthetic-space'
  }, workspaces: [] }, { fetchImpl: async (url, options = {}) => {
    const target = new URL(url);
    assert.equal(target.searchParams.has('personal_project_id'), false);
    if (target.pathname === '/v1/project-agents/engineer') return Response.json({
      agent_id: 'engineer', personal_space_id: 'synthetic-space', personal_project_id: null,
      memory_scope: 'reviewed_agent', profile: { name: 'Engineer', status: 'active', allowed_clients: ['codex'] }
    });
    assert.equal(target.pathname, '/v1/project-agents/engineer/memory');
    if (options.method === 'PUT') {
      const input = JSON.parse(options.body);
      assert.equal(input.personal_project_id, null);
      saved = { ...input, checkpoint_id: 'global-checkpoint', revision: 1 };
      return Response.json(saved);
    }
    return Response.json({ personal_space_id: 'synthetic-space', personal_project_id: null,
      agent_id: 'engineer', scope: 'private_agent_global', revision: 1, current: saved });
  } });
  const input = { personalSpaceId: 'synthetic-space', agentId: 'engineer', sourceApplication: 'codex' };
  await callAgentTool(app, 'checkpoint_project_agent_memory', { ...input,
    expectedRevision: 0, idempotencyKey: 'synthetic-checkpoint', memory: { summary: 'Global notes.' } });
  const memory = await callAgentTool(app, 'get_project_agent_memory', input);
  assert.equal(memory.personalProjectId, null);
  assert.equal(memory.current.memory.summary, 'Global notes.');
});

test('global tasks persist conversation summaries and pass transcript scope validation', async () => {
  const task = { personalProjectId: null, projectAgentId: 'engineer', sessionId: 'synthetic-session',
    sourceApplication: 'codex', token: 'fuli-task-synthetic' };
  const calls = [];
  const app = { config: { personal: { spaceId: 'synthetic-space' } },
    getCapturePolicy: () => ({ enabled: true }), personal: {
      currentTaskContext: async () => ({ personal_project_id: null, project_agent_id: 'engineer', token: task.token }),
      conversation: async (operation, input) => {
        calls.push(input);
        if (['begin', 'append'].includes(operation)) return { status: 'saved', conversation_id: 'global-conversation' };
        return { conversations: [] };
      }
    } };
  assert.equal((await lookupTranscriptTask(app, { session_id: task.sessionId }, 'codex')).task.personal_project_id, null);
  assert.equal((await beginConversation(app, task)).status, 'saved');
  const checkpoint = await checkpointConversation(app, task, { status: 'completed', summary: 'Global result.' }, { name: 'Engineer' });
  assert.equal(checkpoint.status, 'saved');
  assert.equal(checkpoint.receipt.personal_project_id, null);
  assert.match(checkpoint.receipt.continuation.prompt, /全局 FLA/);
  assert.ok(calls.length >= 2);
  assert.ok(calls.every(call => call.personal_project_id === null));
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { callAgentTool } from '../src/agent-tools.js';

test('material knowledge use maps to the personal usage audit endpoint', async () => {
  const calls = [];
  const app = new FederatedGraphApplication({
    version: 1,
    personal: {
      providerUrl: 'http://127.0.0.1:8787',
      accessToken: 'personal-token',
      principalId: 'person-local',
      spaceId: 'personal-space'
    },
    workspaces: []
  }, {
    fetchImpl: async (rawUrl, options = {}) => {
      const url = new URL(rawUrl);
      calls.push({
        path: url.pathname,
        body: options.body ? JSON.parse(options.body) : null
      });
      return new Response(JSON.stringify({
        recorded_count: 1,
        duplicate_count: 0,
        promoted_count: 0,
        items: []
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const result = await app.recordKnowledgeUsage({
    personalSpaceId: 'personal-space',
    taskId: 'task-1',
    sessionId: 'session-1',
    toolName: 'search_knowledge_graph',
    items: [{
      itemId: 'entity-1',
      itemKind: 'entity',
      useKind: 'applied'
    }]
  });

  assert.equal(result.recorded_count, 1);
  assert.equal(calls[0].path, '/v1/knowledge/usage');
  assert.deepEqual(calls[0].body, {
    personal_space_id: 'personal-space',
    task_id: 'task-1',
    session_id: 'session-1',
    tool_name: 'search_knowledge_graph',
    items: [{
      item_id: 'entity-1',
      item_kind: 'entity',
      use_kind: 'applied'
    }]
  });
});

test('checkpoint sends explicit usage in both atomic requests and replays the Provider receipt', async () => {
  const writes = [];
  const receipt = { recorded_count: 1, duplicate_count: 0, promoted_count: 0, items: [] };
  const context = { token: 'fuli-task-usage-checkpoint', session_id: 'logical-session',
    personal_project_id: 'project-a', project_agent_id: 'engineer', source_application: 'codex',
    preference_scope: { version: 1, work_kind: 'implementation', workflow: null },
    work_log_required: true, checkpoint: null };
  const app = new FederatedGraphApplication({ version: 1, personal: {
    providerUrl: 'http://127.0.0.1:8787', accessToken: 'personal-token',
    principalId: 'person-local', spaceId: 'personal-space'
  }, workspaces: [] }, { capturePolicyStore: { read: () => ({ enabled: true }) }, fetchImpl: async (url, options) => {
    if (new URL(url).pathname === '/v1/agent-conversations/append') return Response.json({ status: 'saved', conversation_id: 'c' });
    assert.equal(new URL(url).pathname, `/v1/task-contexts/${context.token}`
      + (options?.method === 'PUT' ? '/checkpoint' : ''));
    if (options?.method === 'PUT') {
      const body = JSON.parse(options.body);
      writes.push(body);
      context.checkpoint = { ...body, knowledge_usage_result: receipt };
    }
    return Response.json(context);
  } });
  app.listProjectAgents = async () => [];
  const input = { taskContextToken: context.token, sourceApplication: 'codex',
    personalProjectId: 'project-a', disposition: 'retain_nothing', reason: 'No new knowledge candidates.',
    workLog: { status: 'completed', summary: 'Applied the retained project rule.' },
    knowledgeUsage: [{ itemId: 'entity-1', itemKind: 'entity', useKind: 'applied' }] };
  assert.deepEqual((await callAgentTool(app, 'checkpoint_task_knowledge', input)).knowledge_usage, receipt);
  assert.deepEqual(writes.map(body => body.phase), ['prepare', 'complete']);
  for (const body of writes) {
    assert.equal(body.personal_space_id, 'personal-space');
    assert.equal(body.source_application, 'codex');
    assert.deepEqual(body.work_log, input.workLog);
    assert.deepEqual(body.knowledge_usage, [{ item_id: 'entity-1', item_kind: 'entity', use_kind: 'applied' }]);
    assert.equal(Object.hasOwn(body, 'task_id'), false, 'The Provider derives the stable task identity.');
  }
  const replay = await callAgentTool(app, 'checkpoint_task_knowledge', input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.knowledge_usage, receipt);
  assert.equal(writes.length, 2);
  await assert.rejects(callAgentTool(app, 'checkpoint_task_knowledge', { ...input,
    knowledgeUsage: [{ ...input.knowledgeUsage[0], useKind: 'cited' }] }), /different input/);
});

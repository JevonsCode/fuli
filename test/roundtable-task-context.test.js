import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoundtableTaskContext } from '../src/agent-roundtable/task-context.js';

function fixture() {
  const scope = { personal_space_id: 'space', personal_project_id: 'target', project_agent_id: 'target-lead',
    source_application: 'codex', session_id: 'actual-receiving-session' };
  const calls = [], observations = [];
  const app = { config: { personal: { spaceId: 'space' } },
    personal: { admitAgentDelegation: async input => { calls.push(input); return scope; },
      observeAgentDelegationMemory: async input => { observations.push(input); return { recorded: true }; } },
    searchKnowledge: async input => ({ facts: input.query === 'hit'
      ? [{ fact: 'Synthetic target fact', defined_project_id: 'target' }] : [], entities: [] }),
    getCollaborationPreferences: async input => ({ taskContextToken: 'own-target-token', scope: input }) };
  return { scope, app, calls, observations, context: createRoundtableTaskContext(app, { token: 'private-grant' }) };
}

test('each business call is readmitted and caller scope cannot replace target authority', async () => {
  const f = fixture();
  const admitted = await f.context.admit();
  await f.context.admit();
  assert.equal(f.calls.length, 2);
  assert.throws(() => f.context.prepareInput('search_knowledge_graph', { query: 'Before entry' }, admitted), /entry/i);
  await f.context.entry(admitted);
  for (const input of [{ personalProjectId: 'source' }, { agentId: 'source-lead' },
    { contextPersonalProjectIds: ['source'] }, { personalProjectScope: 'all_local_confirmed' },
    { projectIds: ['public-source'] }, { taskContextToken: 'parent-token' }]) {
    assert.throws(() => f.context.prepareInput('search_knowledge_graph', input, admitted), /scope|authority|token/i);
  }
  const safe = f.context.prepareInput('search_knowledge_graph', { query: 'bounded target fact' }, admitted);
  assert.equal(safe.personalProjectId, 'target');
  assert.equal(safe.projectAgentId, 'target-lead');
});

test('only an actual target knowledge hit yields a grant memory receipt', async () => {
  const f = fixture();
  const scope = await f.context.admit();
  await f.context.entry(scope);
  await f.app.searchKnowledge({ personalProjectId: 'target', query: 'miss' });
  assert.equal(f.observations.length, 0);
  await f.app.searchKnowledge({ personalProjectId: 'target', query: 'hit' });
  assert.equal(f.observations.length, 1);
  assert.equal(f.observations[0].result_count, 1);
  assert.equal(f.observations[0].session_id, 'actual-receiving-session');
  assert.equal(f.observations[0].body, undefined);
});

test('entry uses sealed native identity and checkpoint cannot write memory or capture', async () => {
  const f = fixture();
  const admitted = await f.context.admit();
  f.context.prepareInput('get_collaboration_preferences', { taskPrompt: 'Bounded question' }, admitted);
  const result = await f.context.entry(admitted, 'get_collaboration_preferences');
  assert.equal(result.scope.sessionId, 'actual-receiving-session');
  assert.equal(result.scope.personalProjectId, 'target');
  assert.equal(result.scope.projectAgentId, 'target-lead');
  assert.equal(f.context.toolNames.includes('capture_session_knowledge'), false);
  assert.throws(() => f.context.prepareInput('capture_session_knowledge', {}, admitted), /read-only/i);
  assert.throws(() => f.context.prepareInput('checkpoint_task_knowledge', {
    disposition: 'capture_candidates', capture: {}, agentMemory: {} }, admitted), /read-only/i);
  const safe = f.context.prepareInput('checkpoint_task_knowledge', { disposition: 'retain_nothing', reason: 'Read only consultation' }, admitted);
  assert.equal(safe.taskContextToken, 'own-target-token');
  const global = f.context.prepareInput('get_project_agent_memory', { personal_project_id: null }, admitted);
  assert.equal(global.personalProjectId, null);
  assert.equal(global.projectAgentId, 'target-lead');
});

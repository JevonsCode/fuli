import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderTaskContextRegistry, taskRecord } from '../src/mcp/provider-task-context-registry.js';
import { applyAgentAssignment, taskAgentAssignment } from '../src/graphiti/task-agent-assignment.js';

function providerRecord(overrides = {}) {
  return {
    token: 'fuli-task-provider-token',
    session_id: 'logical-session',
    personal_project_id: 'project-1',
    project_agent_id: 'agent-1',
    source_application: 'claude_code',
    source_session_id: 'mcp-host-session',
    turn_id: 'turn-1',
    memory_revision: 3,
    agent_memory: null,
    checkpoint: null,
    previous_checkpoint_missing: false,
    ...overrides
  };
}

test('owned preference read uses only durable token and host identity through the Provider port', async () => {
  const task = providerRecord({ personal_space_id: 'space-1',
    preference_scope: { version: 1, work_kind: 'review', workflow: null } });
  const preferences = { effective_preferences: [] };
  const provider = { readTaskPreferences: async (token, input) => {
    assert.equal(token, task.token);
    assert.deepEqual(input, { personal_space_id: 'space-1', source_application: 'claude_code', session_id: 'logical-session' });
    return { task_context: task, preferences };
  } };
  const result = await new ProviderTaskContextRegistry(provider, 'space-1').preferences(task.token,
    { sourceApplication: 'claude_code', sessionId: 'logical-session' });
  assert.equal(result.task.token, task.token); assert.equal(result.preferences, preferences);
  task.personal_space_id = 'foreign-space';
  await assert.rejects(() => new ProviderTaskContextRegistry(provider, 'space-1').preferences(task.token,
    { sourceApplication: 'claude_code', sessionId: 'logical-session' }), /space changed/);
});

test('Provider registry preserves temporary scope and task-only ownership on recovery', async () => {
  const projectScope = { type: 'temporary', lifetime: 'task', persisted: true };
  const registry = new ProviderTaskContextRegistry({
    currentTaskContext: async input => {
      assert.equal(input.session_id, 'logical-session');
      return providerRecord({ project_scope: projectScope, agent_memory_scope: 'task_only' });
    }
  }, 'space-1');
  const current = await registry.current('logical-session', 'claude_code');
  assert.deepEqual(current.projectScope, projectScope);
  assert.equal(current.agentMemoryScope, 'task_only');
});

test('Provider task context records preserve turn and host-session provenance', async () => {
  let received;
  const registry = new ProviderTaskContextRegistry({
    beginTaskContext: async (input) => {
      received = input;
      return {
        ...input,
        checkpoint: null,
        previous_checkpoint_missing: false
      };
    }
  }, 'space-1');

  const result = await registry.begin({
    sessionId: 'logical-session', turnId: 'turn-1', personalProjectId: 'project-1',
    sourceApplication: 'claude_code', sourceSessionId: 'mcp-host-session'
  });

  assert.equal(received.source_session_id, 'mcp-host-session');
  assert.equal(result.turnId, 'turn-1');
  assert.equal(result.sourceSessionId, 'mcp-host-session');
});

test('Provider registry round-trips a fixed preference scope and detects an old Provider dropping it', async () => {
  const scope = { version: 1, work_kind: 'review', workflow: null };
  let received;
  const registry = new ProviderTaskContextRegistry({ beginTaskContext: async input => {
    received = input; return input;
  }, getTaskContext: async () => providerRecord({ preference_scope: scope }) }, 'space-1');
  const input = { sessionId: 'scope-session', preferenceScope: scope };
  assert.deepEqual((await registry.begin(input)).preferenceScope, scope);
  assert.deepEqual(received.preference_scope, scope);
  assert.deepEqual((await registry.context('fuli-task-provider-token')).preferenceScope, scope);
  registry.provider.beginTaskContext = async () => providerRecord();
  await assert.rejects(registry.begin(input), /preference scope/i);
  assert.equal((await registry.context('fuli-task-provider-token')).preferenceScope.version, 1);
  registry.provider.getTaskContext = async () => providerRecord();
  assert.equal((await registry.context('fuli-task-provider-token')).preferenceScope, null);
});

test('Provider preparation forwards Agent memory atomically and completion omits it', async () => {
  const writes = [];
  const registry = new ProviderTaskContextRegistry({
    checkpointTaskContext: async (token, input) => {
      writes.push({ token, input });
      return providerRecord({ checkpoint: input });
    }
  }, 'space-1');
  const checkpoint = {
    disposition: 'retain_nothing',
    reason: 'No durable candidates.',
    fingerprint: 'a'.repeat(64),
    captureStatus: null
  };
  const agentMemory = {
    expected_revision: 3,
    memory: { summary: 'Bounded durable working context.' }
  };

  await registry.prepare(
    'fuli-task-provider-token', checkpoint, 'claude_code', agentMemory
  );
  await registry.checkpoint(
    'fuli-task-provider-token', { ...checkpoint, captureStatus: 'retained' }, 'claude_code'
  );

  assert.equal(writes[0].input.phase, 'prepare');
  assert.equal(writes[0].input.source_application, 'claude_code');
  assert.deepEqual(writes[0].input.agent_memory, agentMemory);
  assert.equal(writes[1].input.phase, 'complete');
  assert.equal(writes[1].input.source_application, 'claude_code');
  assert.equal('agent_memory' in writes[1].input, false);
});

test('Provider context and verification preserve source isolation', async () => {
  const calls = [];
  const registry = new ProviderTaskContextRegistry({
    getTaskContext: async (token, input) => {
      calls.push({ method: 'context', token, input });
      return providerRecord();
    },
    verifyTaskCheckpoint: async (input) => {
      calls.push({ method: 'verify', input });
      return { status: 'checkpoint_required' };
    }
  }, 'space-1');

  await registry.context('fuli-task-provider-token', 'cursor');
  await registry.verify('logical-session', 'cursor');

  assert.equal(calls[0].input.source_application, 'cursor');
  assert.equal(calls[1].input.source_application, 'cursor');
});

test('Provider registry rejects malformed durable task records', async () => {
  const registry = new ProviderTaskContextRegistry({
    getTaskContext: async () => ({ token: null, session_id: null })
  }, 'space-1');

  await assert.rejects(
    registry.context('fuli-task-provider-token', 'codex'),
    /Provider did not return a durable task context/
  );
});

test('coordination bindings survive the TaskContext port and another registry without changing owner', async () => {
  let saved = providerRecord({ coordination_task_id: 'original-adoption',
    coordination_task_ids: ['original-adoption', 'task-first'] });
  const calls = [];
  const provider = {
    bindTaskContextCoordinationTask: async (token, input) => {
      calls.push({ token, input });
      saved = { ...saved, coordination_task_ids: [...new Set([...saved.coordination_task_ids, input.task_id])] };
      return saved;
    },
    getTaskContext: async () => saved
  };
  const first = new ProviderTaskContextRegistry(provider, 'space-1');
  const linked = await first.bindCoordinationTask('fuli-task-provider-token', {
    personalProjectId: 'project-1', taskId: 'task-second'
  }, 'claude_code');
  assert.deepEqual(calls, [{ token: 'fuli-task-provider-token', input: {
    personal_space_id: 'space-1', personal_project_id: 'project-1',
    source_application: 'claude_code', task_id: 'task-second'
  } }]);
  const second = new ProviderTaskContextRegistry(provider, 'space-1');
  const recovered = await second.context(linked.token, 'claude_code');
  assert.equal(recovered.projectAgentId, 'agent-1');
  assert.equal(recovered.coordinationTaskId, 'original-adoption');
  assert.deepEqual(recovered.coordinationTaskIds, ['original-adoption', 'task-first', 'task-second']);
});

test('legacy adoption pointer is preserved in the TaskContext view', async () => {
  const registry = new ProviderTaskContextRegistry({ getTaskContext: async () =>
    providerRecord({ coordination_task_id: 'original-adoption' }) }, 'space-1');
  const recovered = await registry.context('fuli-task-provider-token', 'claude_code');
  assert.equal(recovered.coordinationTaskId, 'original-adoption');
  assert.deepEqual(recovered.coordinationTaskIds, ['original-adoption']);
});

test('scoped capture receipts survive completion and recovery through another Provider registry', async () => {
  let saved;
  const receipts = [{ scope: 'personal_global', personal_project_id: null, status: 'committed',
    episode_id: 'episode-global', entity_ids: ['preference-global'], relationship_ids: [] }];
  const provider = {
    checkpointTaskContext: async (_token, input) => { saved = providerRecord({ checkpoint: input }); return saved; },
    getTaskContext: async () => saved
  };
  const first = new ProviderTaskContextRegistry(provider, 'space-1');
  await first.checkpoint('fuli-task-provider-token', { disposition: 'capture_candidates',
    reason: 'Pending preference candidates.', fingerprint: 'b'.repeat(64),
    captureStatus: 'committed', captureResults: receipts }, 'claude_code');
  assert.deepEqual(saved.checkpoint.capture_results, receipts);
  const next = new ProviderTaskContextRegistry(provider, 'space-1');
  assert.deepEqual((await next.context('fuli-task-provider-token', 'claude_code')).checkpoint.captureResults, receipts);
});

test('task begin stores only a bounded v1 Agent assignment and reads an invalid one as unknown', async () => {
  const assignment = { version: 1, selection_reason: 'project_lead_reporting', match_basis: ['Lead owns the task.'],
    requested_agent_id: 'specialist', reporting_lead_agent_id: null, execution_reason: null, execution_agent_id: null };
  const sent = [];
  const provider = { beginTaskContext: async input => { sent.push(input);
    return providerRecord({ token: input.token, agent_assignment: input.agent_assignment ?? null }); } };
  const registry = new ProviderTaskContextRegistry(provider, 'space-1');
  const task = await registry.begin({ sessionId: 'logical-session', sourceApplication: 'claude_code', agentAssignment: assignment });
  assert.deepEqual(sent[0].agent_assignment, assignment);
  assert.deepEqual(task.agentAssignment, assignment);
  await registry.begin({ sessionId: 'logical-session', sourceApplication: 'claude_code' });
  assert.equal(Object.hasOwn(sent[1], 'agent_assignment'), false);
  for (const stored of [undefined, null, { ...assignment, extra: true }, { ...assignment, version: 2 },
    { ...assignment, match_basis: ['x'.repeat(2049)] }]) {
    assert.equal(taskRecord(providerRecord({ agent_assignment: stored })).agentAssignment, null);
  }
});

test('entry assignment record keeps reporting constraints and drops unbounded input instead of a fragment', () => {
  const context = { project_agent_id: 'member', role: {}, selection_reason: 'delegated_member',
    match_basis: ['Reports to lead.'], reporting_lead_agent_id: 'lead' };
  assert.deepEqual(taskAgentAssignment(context), { version: 1, selection_reason: 'delegated_member',
    match_basis: ['Reports to lead.'], requested_agent_id: null, reporting_lead_agent_id: 'lead',
    execution_reason: null, execution_agent_id: null });
  assert.equal(taskAgentAssignment({ ...context, match_basis: Array(33).fill('basis') }), null);
  assert.equal(taskAgentAssignment({ status: 'unassigned', reason: 'project_lead_required' }), null);
  const replayed = applyAgentAssignment({}, taskAgentAssignment(context));
  assert.match(replayed.reporting_guidance, /Return results and blockers to the project lead/);
});

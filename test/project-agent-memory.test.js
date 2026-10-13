import assert from 'node:assert/strict';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { taskEntryPreferences } from '../src/graphiti/task-entry-preferences.js';
import { createAgentRoundtable } from '../src/agent-roundtable/service.js';

// Synthetic data and an HTTP boundary double; real Neo4j coverage is separate.
const CONFIG = {
  version: 1,
  personal: {
    providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-test-token',
    principalId: 'test-person', spaceId: 'test-space'
  },
  workspaces: []
};

test('an Agent can checkpoint and read its working memory through MCP tools', async () => {
  let saved;
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: async (url, options = {}) => {
      const target = new URL(url);
      if (target.pathname === '/v1/project-agents/engineer') {
        return Response.json({
          agent_id: 'engineer', personal_space_id: 'test-space',
          personal_project_id: 'sample-project', memory_scope: 'reviewed_agent',
          profile: { name: 'Engineer', responsibility: 'Build the sample service.',
            status: 'active', allowed_clients: ['codex', 'claude_code', 'cursor'] }
        });
      }
      assert.equal(target.pathname, '/v1/project-agents/engineer/memory');
      if (options.method === 'PUT') {
        const input = JSON.parse(options.body);
        saved = {
          ...input, checkpoint_id: 'checkpoint-1', revision: 1,
          created_at: '2026-08-30T00:00:00Z'
        };
        return Response.json(saved);
      }
      assert.equal(target.searchParams.get('personal_project_id'), 'sample-project');
      return Response.json({
        personal_space_id: 'test-space', personal_project_id: 'sample-project',
        agent_id: 'engineer', revision: 1, current: saved, history: [saved],
        scope: 'private_agent_project', storage: 'neo4j',
        authority: 'working_context_not_confirmed_knowledge'
      });
    }
  });
  const input = {
    personalSpaceId: 'test-space', personalProjectId: 'sample-project',
    agentId: 'engineer', expectedRevision: 0, idempotencyKey: 'memory-checkpoint-1',
    sourceApplication: 'codex', sourceSessionId: 'test-session',
    memory: { summary: 'The sample service uses a graph.', nextActions: ['Verify restart.'] }
  };

  await callAgentTool(app, 'checkpoint_project_agent_memory', input);
  const memory = await callAgentTool(app, 'get_project_agent_memory', input);

  assert.equal(memory.current.memory.summary, 'The sample service uses a graph.');
  assert.deepEqual(memory.current.memory.nextActions, ['Verify restart.']);
  assert.equal(memory.revision, 1);
  assert.equal(memory.scope, 'private_agent_project');
});

test('task entry automatically restores exactly one durable role and its context', async () => {
  let resolutions = 0;
  const app = entryApplication({ onResolve: () => { resolutions += 1; } });
  const result = await callAgentTool(app, 'get_collaboration_preferences', {
    projectPath: '/synthetic/sample-project', taskPrompt: '继续完善项目',
    sourceApplication: 'cursor'
  });

  assert.equal(result.context.project_agent_id, 'engineer');
  assert.equal(result.project_agent_context.project_agent_id, 'engineer');
  assert.equal(result.project_agent_context.memory.current.memory.summary, 'Continue the Aster migration.');
  assert.equal(result.project_agent_context.worker_started, false);
  assert.equal(result.effective_preferences[0].instruction, 'Verify changes before finishing.');
  assert.equal(JSON.stringify(result).includes('private-other-role'), false);
  assert.equal(resolutions, 1);
  assert.equal(result.project_agent_context.knowledge[0].entities.length, 2);
  assert.equal(result.agent_receipt.required, true);
  assert.match(result.agent_receipt.markdown, /Engineer/);
});

test('hook entry without a turn ID forwards the receiving session with process-only delegation proof', async () => {
  let resolved;
  const app = entryApplication({ onResolve: input => { resolved = input; } });
  app.roundtable = createAgentRoundtable({ app,
    env: { FULI_ROUNDTABLE_DELEGATION: 'synthetic-invocation-capability-123456' },
    openStore: () => ({ pendingFor: () => [] }) });
  await taskEntryPreferences(app, { status: 'matched', personalProjectId: 'sample-project' }, {
    projectAgentId: 'engineer', sourceApplication: 'cursor', sessionId: 'receiving-fork',
    agentInvocation: true, agentToolName: 'begin_task_context', taskPrompt: null
  }, async () => {});
  assert.equal(resolved.session_id, null); // No reuse of an earlier task owner.
  assert.equal(resolved.delegation_session_id, 'receiving-fork');
  assert.equal(resolved.delegation_token, 'synthetic-invocation-capability-123456');
  assert.equal(resolved.report_to_agent_id, undefined);
});

test('authenticated project-id task entry restores a role without a host path', async () => {
  let resolutions = 0;
  const app = entryApplication({ onResolve: () => { resolutions += 1; } });
  const result = await callAgentTool(app, 'get_collaboration_preferences', {
    personalProjectId: 'sample-project',
    projectPath: null,
    taskPrompt: '继续完善项目',
    sourceApplication: 'cursor'
  });

  assert.equal(result.context.personal_project_id, 'sample-project');
  assert.equal(result.context.project_agent_id, 'engineer');
  assert.equal(result.project_agent_context.project_agent_id, 'engineer');
  assert.equal(result.project_agent_context.memory.revision, 3);
  assert.equal(resolutions, 1);
});

test('a rejected explicit role cannot leak private preferences through fallback', async () => {
  const app = entryApplication({ denied: true });
  const result = await callAgentTool(app, 'get_collaboration_preferences', {
    projectPath: '/synthetic/sample-project', projectAgentId: 'engineer',
    taskPrompt: 'Continue.', sourceApplication: 'cursor'
  });
  assert.equal(result.context.project_agent_id, null);
  assert.equal(result.project_agent_context.status, 'agent_unavailable');
  assert.equal(result.effective_preferences.length, 0);
  assert.equal(result.agent_receipt.markdown, 'FULI Agent：分配失败（指定 FLA 不可用）');
  assert.equal(result.agent_receipt.owner, null);
});

test('a personalProjectId-only role request cannot bypass Agent authorization', async () => {
  const app = entryApplication({ denied: true });
  const result = await callAgentTool(app, 'get_collaboration_preferences', {
    personalProjectId: 'sample-project', projectAgentId: 'engineer',
    taskPrompt: 'Continue.', sourceApplication: 'cursor'
  });

  assert.equal(result.context.project_agent_id, null);
  assert.equal(result.project_agent_context.status, 'agent_unavailable');
  assert.equal(result.effective_preferences.length, 0);
});

test('malformed Agent memory degrades task entry without dropping other context', async () => {
  const app = entryApplication({ malformedMemory: true });
  const result = await callAgentTool(app, 'get_collaboration_preferences', {
    projectPath: '/synthetic/sample-project', taskPrompt: 'Continue.',
    sourceApplication: 'cursor'
  });

  assert.equal(result.project_agent_context.status, 'degraded');
  assert.equal(result.project_agent_context.memory, null);
  assert.deepEqual(result.project_agent_context.unavailable_components, ['memory']);
  assert.equal(result.effective_preferences[0].instruction, 'Verify changes before finishing.');
});

test('task entry does not load private memory when memory scope is undeclared', async () => {
  let memoryReads = 0;
  const app = entryApplication({
    omitMemoryScope: true,
    onMemoryRead: () => { memoryReads += 1; }
  });
  const result = await callAgentTool(app, 'get_collaboration_preferences', {
    projectPath: '/synthetic/sample-project', taskPrompt: 'Continue.',
    sourceApplication: 'cursor'
  });

  assert.equal(result.project_agent_context.status, 'ready');
  assert.equal(result.project_agent_context.memory, null);
  assert.deepEqual(result.project_agent_context.unavailable_components, []);
  assert.equal(result.effective_preferences[0].instruction, 'Verify changes before finishing.');
  assert.equal(memoryReads, 0);
});

for (const denied of [
  { name: 'inactive Agent', status: 'inactive', memoryScope: 'reviewed_agent', allowedClients: ['codex'] },
  { name: 'task-only Agent', status: 'active', memoryScope: 'task_only', allowedClients: ['codex'] },
  { name: 'disallowed client', status: 'active', memoryScope: 'reviewed_agent', allowedClients: ['cursor'] },
  { name: 'Agent with no declared memory scope', status: 'active', memoryScope: undefined, allowedClients: ['codex'] }
]) {
  test(`working-memory tools reject ${denied.name} before reading or writing memory`, async () => {
    let memoryRequests = 0;
    const app = new FederatedGraphApplication(CONFIG, {
      fetchImpl: async (url) => {
        const target = new URL(url);
        if (target.pathname === '/v1/project-agents/engineer') {
          return Response.json({
            agent_id: 'engineer', personal_space_id: 'test-space',
            personal_project_id: 'sample-project',
            ...(denied.memoryScope === undefined ? {} : { memory_scope: denied.memoryScope }),
            profile: { name: 'Engineer', responsibility: 'Maintain the sample.',
              status: denied.status, allowed_clients: denied.allowedClients }
          });
        }
        memoryRequests += 1;
        return Response.json({});
      }
    });

    await assert.rejects(callAgentTool(app, 'get_project_agent_memory', {
      personalSpaceId: 'test-space', personalProjectId: 'sample-project',
      agentId: 'engineer', sourceApplication: 'codex'
    }), /active durable Agent|client is not allowed/);
    await assert.rejects(callAgentTool(app, 'checkpoint_project_agent_memory', {
      personalSpaceId: 'test-space', personalProjectId: 'sample-project',
      agentId: 'engineer', sourceApplication: 'codex', expectedRevision: 0,
      idempotencyKey: `denied-${denied.status}-${denied.memoryScope ?? 'missing'}`,
      memory: { summary: 'This must not be written.' }
    }), /active durable Agent|client is not allowed/);
    assert.equal(memoryRequests, 0);
  });
}

test('capture-disabled memory checkpoints still fail closed on Agent authorization', async () => {
  const task = {
    token: 'fuli-task-disabled-auth', sessionId: 'logical-session',
    personalProjectId: 'sample-project', projectAgentId: 'engineer', checkpoint: null
  };
  const app = {
    config: CONFIG,
    getCapturePolicy: () => ({ enabled: false }),
    getProjectAgent: async () => ({
      memoryScope: 'reviewed_agent',
      profile: { status: 'active', allowedClients: ['cursor'] }
    }),
    taskContextRegistry: {
      context: async () => task,
      prepare: async () => assert.fail('Denied memory must not reach checkpoint preparation')
    }
  };

  await assert.rejects(checkpointTaskKnowledge(app, {
    taskContextToken: task.token, disposition: 'retain_nothing',
    reason: 'Authorization must precede the disabled capture result.',
    sourceApplication: 'codex',
    agentMemory: { expectedRevision: 0, memory: { summary: 'Must not be accepted.' } }
  }), error => error?.code === 'validation');
});

test('a remote project-bound checkpoint rejects a token from another project before writes',
  async () => {
    const task = {
      token: 'fuli-task-cross-project', sessionId: 'remote-session',
      personalProjectId: 'project-a', projectAgentId: 'engineer', checkpoint: null
    };
    let writes = 0;
    const app = {
      config: CONFIG,
      taskContextRegistry: {
        context: async () => task,
        prepare: async () => { writes += 1; return task; },
        checkpoint: async () => { writes += 1; return task; }
      }
    };

    await assert.rejects(checkpointTaskKnowledge(app, {
      taskContextToken: task.token,
      personalProjectId: 'project-b',
      remoteSessionId: task.sessionId,
      disposition: 'retain_nothing',
      reason: 'A project-bound remote process must reject a foreign token.',
      sourceApplication: 'claude'
    }), /another project/);
    await assert.rejects(checkpointTaskKnowledge(app, {
      taskContextToken: task.token,
      personalProjectId: task.personalProjectId,
      remoteSessionId: 'another-remote-session',
      disposition: 'retain_nothing',
      reason: 'A remote process must reject another session\'s token.',
      sourceApplication: 'claude'
    }), /another remote session/);
    assert.equal(writes, 0);
  });

test('malformed Provider memory records raise controlled validation errors', async () => {
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: async (url, options = {}) => {
      const target = new URL(url);
      if (target.pathname === '/v1/project-agents/engineer') {
        return Response.json({
          agent_id: 'engineer', personal_space_id: 'test-space',
          personal_project_id: 'sample-project', memory_scope: 'reviewed_agent',
          profile: { name: 'Engineer', responsibility: 'Maintain the sample.',
            status: 'active', allowed_clients: ['codex'] }
        });
      }
      if (options.method === 'PUT') {
        return Response.json({ revision: 1, checkpoint_id: 'bad-write' });
      }
      return Response.json({
        revision: 1, current: { revision: 1, checkpoint_id: 'bad-read' }, history: []
      });
    }
  });
  const scope = {
    personalSpaceId: 'test-space', personalProjectId: 'sample-project',
    agentId: 'engineer', sourceApplication: 'codex'
  };

  await assert.rejects(callAgentTool(app, 'get_project_agent_memory', scope),
    error => error?.code === 'validation');
  await assert.rejects(callAgentTool(app, 'checkpoint_project_agent_memory', {
    ...scope, expectedRevision: 0, idempotencyKey: 'malformed-provider-write',
    memory: { summary: 'Valid request, invalid response.' }
  }), error => error?.code === 'validation');
});

test('capture-disabled mode never writes Agent working memory', async () => {
  let agentReads = 0;
  let memoryWrites = 0;
  const app = new FederatedGraphApplication(CONFIG, {
    capturePolicyStore: { read: () => ({ enabled: false }) },
    fetchImpl: async (url) => {
      const target = new URL(url);
      if (target.pathname === '/v1/project-agents/engineer') {
        agentReads += 1;
        return Response.json({
          agent_id: 'engineer', personal_space_id: 'test-space',
          personal_project_id: 'sample-project', memory_scope: 'reviewed_agent',
          profile: { name: 'Engineer', responsibility: 'Maintain the sample.',
            status: 'active', allowed_clients: ['codex'] }
        });
      }
      memoryWrites += 1;
      return Response.json({});
    }
  });
  const result = await callAgentTool(app, 'checkpoint_project_agent_memory', {
    personalSpaceId: 'test-space', personalProjectId: 'sample-project', agentId: 'engineer',
    sourceApplication: 'codex', expectedRevision: 0,
    idempotencyKey: 'disabled-memory', memory: { summary: 'Not persisted.' }
  });
  assert.equal(result.status, 'capture_disabled');
  assert.equal(agentReads, 1);
  assert.equal(memoryWrites, 0);
});

test('automatic task entry restores configured character and user expectations through the Provider contract', async () => {
  const character = { judgment: 'Verify claims.', taste: 'Prefer clear navigation.', personality: 'Patient and direct.' };
  const app = entryApplication({ profileFields: { character, expectations: 'Explain the evidence.', initial_preferences: ['Keep summaries concise.'] } });
  const result = await callAgentTool(app, 'get_collaboration_preferences', {
    projectPath: '/synthetic/sample-project', taskPrompt: 'Continue.', sourceApplication: 'cursor'
  });
  assert.deepEqual(result.project_agent_context.role, {
    name: 'Engineer', responsibility: 'Maintain Aster.', initial_preferences: ['Keep summaries concise.'],
    character, expectations: 'Explain the evidence.'
  });
  assert.equal(result.project_agent_context.worker_started, false);
  assert.equal(result.project_agent_context.memory.revision, 3);
});

test('explicit worker context carries the same character and expectations as automatic entry', async () => {
  const character = { judgment: 'Verify evidence.', taste: 'Clear prose.', personality: 'Patient.' };
  const app = entryApplication();
  app.personal.getProjectAgent = async () => ({ agent_id: 'engineer', personal_space_id: 'test-space',
    personal_project_id: 'sample-project', memory_scope: 'reviewed_agent',
    profile: { name: 'Engineer', responsibility: 'Maintain Aster.', status: 'active',
      allowed_clients: ['cursor'], character, expectations: 'Keep decisions traceable.',
      initial_preferences: ['Use concise summaries.'] } });
  const result = await callAgentTool(app, 'get_project_agent_context', {
    projectPath: '/synthetic/sample-project', agentId: 'engineer', queries: ['project'], sourceApplication: 'cursor'
  });
  assert.deepEqual(result.role_instructions.character, character);
  assert.equal(result.role_instructions.expectations, 'Keep decisions traceable.');
  assert.deepEqual(result.role_instructions.initial_preferences, ['Use concise summaries.']);
  assert.equal(result.effective_preferences[0].instruction, 'Verify changes before finishing.');
  assert.equal(result.working_memory.revision, 3);
  assert.equal(result.global_working_memory.revision, 5);
});

test('automatic task entry gives legacy profiles empty character and expectation defaults', async () => {
  const result = await callAgentTool(entryApplication(), 'get_collaboration_preferences', {
    projectPath: '/synthetic/sample-project', taskPrompt: 'Continue.', sourceApplication: 'cursor'
  });
  assert.deepEqual(result.project_agent_context.role.character, { judgment: '', taste: '', personality: '' });
  assert.equal(result.project_agent_context.role.expectations, '');
});

test('automatic task entry bounds profile prose and ignores unsupported character data', async () => {
  const app = entryApplication({ profileFields: {
    character: { judgment: 'j'.repeat(3000), taste: null, personality: ['invalid'], unrelated: 'Do not include.' },
    expectations: 'e'.repeat(5000)
  } });
  const result = await callAgentTool(app, 'get_collaboration_preferences', {
    projectPath: '/synthetic/sample-project', taskPrompt: 'Continue.', sourceApplication: 'cursor'
  });
  assert.deepEqual(result.project_agent_context.role.character, { judgment: 'j'.repeat(2048), taste: '', personality: '' });
  assert.equal(result.project_agent_context.role.expectations, 'e'.repeat(4096));
});

test('project task entry restores the same employee global and project memory as separate layers', async () => {
  const reads = [];
  const app = entryApplication({ onMemoryRead: target => reads.push(target.searchParams.get('personal_project_id')) });
  const result = await callAgentTool(app, 'get_collaboration_preferences', {
    projectPath: '/synthetic/sample-project', taskPrompt: 'Continue.', sourceApplication: 'cursor'
  });
  const context = result.project_agent_context;
  assert.deepEqual(reads.sort(), [null, 'sample-project'].sort());
  assert.equal(context.status, 'ready');
  assert.deepEqual([context.memory.scope, context.memory.personalProjectId, context.memory.revision],
    ['private_agent_project', 'sample-project', 3]);
  assert.deepEqual([context.global_memory.scope, context.global_memory.personalProjectId, context.global_memory.revision],
    ['private_agent_global', null, 5]);
  assert.equal(context.memory.current.memory.summary, 'Continue the Aster migration.');
  assert.equal(context.global_memory.current.memory.summary, 'Synthetic global working method.');
  assert.deepEqual(context.unavailable_components, []);
});

test('task-only employees receive neither persistent memory layer', async () => {
  let memoryReads = 0;
  const app = entryApplication({ memoryScope: 'task_only', onMemoryRead: () => { memoryReads += 1; } });
  const result = await callAgentTool(app, 'get_collaboration_preferences', {
    projectPath: '/synthetic/sample-project', taskPrompt: 'Continue.', sourceApplication: 'cursor'
  });
  assert.equal(memoryReads, 0);
  assert.equal(result.project_agent_context.memory, null);
  assert.equal(result.project_agent_context.global_memory, null);
  assert.equal(result.project_agent_context.status, 'ready');
});

for (const [layer, failure] of [['global_memory', 'unavailable'], ['global_memory', 'malformed'],
  ['memory', 'unavailable']]) {
  test(`a ${failure} ${layer} layer is reported without hiding the healthy layer`, async () => {
    const app = entryApplication({ memoryOverride: (project, value) =>
      (project === null) === (layer === 'global_memory')
        ? (failure === 'unavailable' ? new Response('{}', { status: 503 }) : { ...value, current: { revision: 1 } })
        : value });
    const context = (await callAgentTool(app, 'get_collaboration_preferences', {
      projectPath: '/synthetic/sample-project', taskPrompt: 'Continue.', sourceApplication: 'cursor'
    })).project_agent_context;
    const healthy = layer === 'memory' ? 'global_memory' : 'memory';
    assert.equal(context.status, 'degraded');
    assert.deepEqual(context.unavailable_components, [layer]);
    assert.equal(context[layer], null);
    assert.equal(context[healthy].revision, healthy === 'memory' ? 3 : 5);
  });
}

for (const invalid of [null, false, 0]) {
  test(`a ${JSON.stringify(invalid)} persistent memory response degrades only its own layer`, async () => {
    for (const global of [true, false]) {
      const app = entryApplication({ memoryOverride: (project, value) =>
        (project === null) === global ? invalid : value });
      const context = (await callAgentTool(app, 'get_collaboration_preferences', {
        projectPath: '/synthetic/sample-project', taskPrompt: 'Continue.', sourceApplication: 'cursor'
      })).project_agent_context;
      const [rejected, healthy] = global ? ['global_memory', 'memory'] : ['memory', 'global_memory'];
      assert.equal(context.status, 'degraded');
      assert.deepEqual(context.unavailable_components, [rejected]);
      assert.equal(context[rejected], null);
      assert.equal(context[healthy].revision, global ? 3 : 5);
    }
  });
}

test('a valid empty revision-0 scoped view in both layers remains ready', async () => {
  const app = entryApplication({ memoryOverride: (_project, value) =>
    ({ ...value, revision: 0, current: null, history: [] }) });
  const context = (await callAgentTool(app, 'get_collaboration_preferences', {
    projectPath: '/synthetic/sample-project', taskPrompt: 'Continue.', sourceApplication: 'cursor'
  })).project_agent_context;
  assert.equal(context.status, 'ready');
  assert.deepEqual(context.unavailable_components, []);
  assert.deepEqual([context.memory.revision, context.memory.current], [0, null]);
  assert.deepEqual([context.global_memory.revision, context.global_memory.current], [0, null]);
});

for (const [name, mutate] of [
  ['another employee', value => ({ ...value, agent_id: 'reviewer' })],
  ['another project', value => ({ ...value, personal_project_id: 'other-project' })],
  ['another space', value => ({ ...value, personal_space_id: 'other-space' })],
  ['the wrong scope', value => ({ ...value, scope: value.scope === 'private_agent_global' ? 'private_agent_project' : 'private_agent_global' })],
  ['undeclared identity', ({ agent_id: _agent, personal_project_id: _project, ...value }) => value],
  ['a foreign checkpoint', value => ({ ...value, current: { ...value.current, agent_id: 'reviewer' } })]
]) {
  test(`task entry rejects a memory response for ${name} in either layer`, async () => {
    for (const global of [true, false]) {
      const app = entryApplication({ memoryOverride: (project, value) =>
        (project === null) === global ? mutate(value) : value });
      const context = (await callAgentTool(app, 'get_collaboration_preferences', {
        projectPath: '/synthetic/sample-project', taskPrompt: 'Continue.', sourceApplication: 'cursor'
      })).project_agent_context;
      const rejected = global ? 'global_memory' : 'memory';
      assert.deepEqual(context.unavailable_components, [rejected]);
      assert.equal(context[rejected], null);
      assert.equal(JSON.stringify(context).includes('reviewer'), false);
    }
  });
}

test('task begin binds the checkpoint revision to the project layer, never the global layer', async () => {
  const begun = [];
  const app = entryApplication();
  app.getCapturePolicy = () => ({ enabled: false });
  app.taskContextRegistry = { begin: async input => { begun.push(input); return { token: 'fuli-task-synthetic-dual', checkpoint: null }; } };
  const result = await callAgentTool(app, 'begin_task_context', {
    sessionId: 'synthetic-session', projectPath: '/synthetic/sample-project',
    taskPrompt: 'Continue.', sourceApplication: 'cursor'
  });
  assert.equal(begun[0].personalProjectId, 'sample-project');
  assert.equal(begun[0].memoryRevision, 3);
  assert.equal(result.project_agent_context.global_memory.revision, 5);
});

test('preference fallback creates a fresh checkpointable task only with an explicit host session', async () => {
  const app = entryApplication();
  app.getCapturePolicy = () => ({ enabled: false });
  const { TaskContextRegistry } = await import('./fixtures/in-memory-task-context-registry.js');
  let next = 0;
  app.taskContextRegistry = new TaskContextRegistry({ tokenFactory: () => `fuli-task-fallback-${++next}` });
  const input = { sessionId: 'synthetic-native-session', projectPath: '/synthetic/sample-project',
    taskPrompt: 'Continue.', sourceApplication: 'cursor' };
  const first = await callAgentTool(app, 'get_collaboration_preferences', input);
  assert.equal(first.taskContextToken, 'fuli-task-fallback-1');
  assert.equal(first.checkpoint_required, true);
  assert.equal(app.taskContextRegistry.context(first.taskContextToken, 'cursor').projectAgentId, 'engineer');
  assert.equal(app.taskContextRegistry.context(first.taskContextToken, 'cursor').memoryRevision, 3);
  app.taskContextRegistry.checkpoint(first.taskContextToken, { fingerprint: 'first' }, 'cursor');
  const second = await callAgentTool(app, 'get_collaboration_preferences', input);
  assert.equal(second.taskContextToken, 'fuli-task-fallback-2');
  assert.equal(second.previous_checkpoint_missing, false);
  const third = await callAgentTool(app, 'get_collaboration_preferences', input);
  assert.notEqual(third.taskContextToken, second.taskContextToken);
  assert.equal(third.previous_checkpoint_missing, true);
  const missing = await callAgentTool(app, 'get_collaboration_preferences', {
    ...input, sessionId: undefined, sourceSessionId: 'fuli-host-process-only'
  });
  assert.equal(missing.taskContextToken, undefined);
  assert.equal(missing.task_lifecycle.reason, 'native_session_required');
  assert.equal(next, 3);
});

function entryApplication({
  onResolve = () => {},
  onMemoryRead = () => {},
  denied = false,
  malformedMemory = false,
  omitMemoryScope = false,
  memoryScope = 'reviewed_agent',
  memoryOverride = (_project, value) => value,
  profileFields = {}
} = {}) {
  return new FederatedGraphApplication(CONFIG, {
    projectPathResolver: () => ({ status: 'matched', personalProjectId: 'sample-project' }),
    fetchImpl: async (url, options = {}) => {
      const target = new URL(url);
      const input = options.body ? JSON.parse(options.body) : {};
      if (target.pathname === '/v1/personal-projects') return Response.json([]);
      if (target.pathname === '/v1/project-agent-context/resolve') {
        onResolve(input);
        assert.equal(input.source_application, 'cursor');
        return Response.json({ status: 'ready', reason: 'project_default', match_basis: [],
          agent: { agent_id: 'engineer', personal_space_id: 'test-space',
            personal_project_id: 'sample-project',
            ...(omitMemoryScope ? {} : { memory_scope: memoryScope }),
            profile: { name: 'Engineer', responsibility: 'Maintain Aster.',
              status: 'active', allowed_clients: denied ? ['codex'] : ['cursor'], initial_preferences: [], ...profileFields } } });
      }
      if (target.pathname === '/v1/collaboration-preferences') {
        assert.equal(target.searchParams.get('project_agent_id'), denied ? null : 'engineer');
        return Response.json({ personal_space_id: 'test-space', personal_project_id: 'sample-project',
          project_agent_id: denied ? null : 'engineer', conflicts: [], effective_preferences: denied ? [] : [{
            instruction: 'Verify changes before finishing.', preference_scope: 'agent',
            confirmation_status: 'confirmed' }], agent_preferences: [] });
      }
      if (target.pathname === '/v1/project-agents/engineer/memory') {
        onMemoryRead(target);
        const project = target.searchParams.get('personal_project_id');
        // Synthetic Provider views carry the same explicit identity as the real contract.
        const value = project === null
          ? { personal_space_id: 'test-space', personal_project_id: null, agent_id: 'engineer',
            revision: 5, current: { revision: 5, agent_id: 'engineer', personal_project_id: null,
              memory: { summary: 'Synthetic global working method.' } }, history: [],
            scope: 'private_agent_global', storage: 'neo4j' }
          : { personal_space_id: 'test-space', personal_project_id: project, agent_id: 'engineer',
            revision: 3, current: { revision: 3, agent_id: 'engineer',
              ...(malformedMemory ? {} : { memory: { summary: 'Continue the Aster migration.' } }) }, history: [],
            scope: 'private_agent_project', storage: 'neo4j' };
        const response = memoryOverride(project, value);
        return response instanceof Response ? response : Response.json(response);
      }
      if (target.pathname === '/v1/personal-projects/sample-project') {
        return Response.json({ profile: { name: 'Aster', purpose: 'A synthetic sample.' } });
      }
      if (target.pathname === '/v1/search') {
        return Response.json({ facts: [], entities: [
          { id: 'shared', name: 'Shared', summary: 'Shared project decision.',
            defined_project_id: 'sample-project', confirmation_status: 'confirmed' },
          { id: 'private-engineer', name: 'Engineer note', project_agent_id: 'engineer',
            defined_project_id: 'sample-project', confirmation_status: 'confirmed' },
          { id: 'private-other-role', project_agent_id: 'reviewer',
            defined_project_id: 'sample-project', name: 'private-other-role' }
        ] });
      }
      return Response.json([]);
    }
  });
}

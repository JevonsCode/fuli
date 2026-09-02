import assert from 'node:assert/strict';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

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

function entryApplication({
  onResolve = () => {},
  onMemoryRead = () => {},
  denied = false,
  malformedMemory = false,
  omitMemoryScope = false
} = {}) {
  return new FederatedGraphApplication(CONFIG, {
    projectPathResolver: () => ({ status: 'matched', personalProjectId: 'sample-project' }),
    fetchImpl: async (url, options = {}) => {
      const target = new URL(url);
      const input = options.body ? JSON.parse(options.body) : {};
      if (target.pathname === '/v1/personal-projects') return Response.json([]);
      if (target.pathname === '/v1/project-agent-context/resolve') {
        onResolve();
        assert.equal(input.source_application, 'cursor');
        return Response.json({ status: 'ready', reason: 'project_default', match_basis: [],
          agent: { agent_id: 'engineer', personal_space_id: 'test-space',
            personal_project_id: 'sample-project',
            ...(omitMemoryScope ? {} : { memory_scope: 'reviewed_agent' }),
            profile: { name: 'Engineer', responsibility: 'Maintain Aster.',
              status: 'active', allowed_clients: denied ? ['codex'] : ['cursor'], initial_preferences: [] } } });
      }
      if (target.pathname === '/v1/collaboration-preferences') {
        assert.equal(target.searchParams.get('project_agent_id'), denied ? null : 'engineer');
        return Response.json({ personal_space_id: 'test-space', personal_project_id: 'sample-project',
          project_agent_id: denied ? null : 'engineer', conflicts: [], effective_preferences: denied ? [] : [{
            instruction: 'Verify changes before finishing.', preference_scope: 'agent',
            confirmation_status: 'confirmed' }], agent_preferences: [] });
      }
      if (target.pathname === '/v1/project-agents/engineer/memory') {
        onMemoryRead();
        return Response.json({ revision: 3, current: { revision: 3, agent_id: 'engineer',
          ...(malformedMemory ? {} : { memory: { summary: 'Continue the Aster migration.' } }) }, history: [],
          scope: 'private_agent_project', storage: 'neo4j' });
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

import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { createWorkerTaskContext } from '../src/graphiti/worker-task-context.js';
import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';
import { ApplicationError } from '../src/app/application-error.js';

test('fallback task entry uses the same compact instruction and memory view as hooks', async () => {
  const instruction = 'Keep the complete effective instruction. '.repeat(25);
  const server = createMcpServer({ getCollaborationPreferences: async () => ({
    effective_preferences: [{ instruction, preference_key: 'example', attributes: { duplicate: instruction } }],
    project_agent_context: { memory: { revision: 7, history: [{ old: 'full history' }],
      current: { memory: { summary: 'x'.repeat(2000), decisions: ['a'], nextActions: ['b'] } } } }
  }) }, { env: {}, toolNames: ['get_collaboration_preferences'], registerResources: false });
  try {
    const result = await server.server._requestHandlers.get('tools/call')({
      method: 'tools/call', params: { name: 'get_collaboration_preferences',
        arguments: { projectPath: '/synthetic/project' } }
    }, { signal: new AbortController().signal, requestId: 1 });
    const data = result.structuredContent;
    assert.equal(data.effective_preferences[0].instruction, instruction);
    assert.equal(data.effective_preferences[0].attributes, undefined);
    assert.equal(data.project_agent_context.memory.current.memory.summary.length, 800);
    assert.equal(data.project_agent_context.memory.history, undefined);
    assert.equal(data.project_agent_context.memory.requiresFullReadBeforeWrite, true);
  } finally { await server.close(); }
});

test('an explicit empty MCP allowlist creates a valid tool-less server', async () => {
  const server = createMcpServer({}, {
    env: {}, toolNames: [], registerResources: false
  });
  const client = new Client({ name: 'empty-allowlist-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.deepEqual((await client.listTools()).tools, []);
  } finally {
    await client.close();
    await server.close();
  }
});

test('tool-less MCP servers report unknown calls as not found', async () => {
  const server = createMcpServer({}, {
    env: {}, toolNames: [], registerResources: false
  });
  const handler = server.server._requestHandlers.get('tools/call');
  const result = await handler({
    method: 'tools/call', params: { name: 'not_a_fuli_tool', arguments: {} }
  }, { signal: new AbortController().signal, requestId: 1 });

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent.error, {
    code: 'not_found',
    message: 'Unknown Fuli tool'
  });
  await server.close();
});

test('non-Codex MCP servers never inherit a Codex native thread ID', async () => {
  const nativeThreadId = '019fc6ed-02a5-7832-8821-68e3b03e7ce3';
  let received;
  const server = createMcpServer({
    beginTaskContext: async (input) => {
      received = input;
      return { taskContextToken: 'synthetic-token' };
    }
  }, {
    env: { CODEX_THREAD_ID: nativeThreadId },
    sourceApplication: 'claude_code',
    toolNames: ['begin_task_context'],
    registerResources: false
  });
  const client = new Client({ name: 'source-isolation-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.callTool({
      name: 'begin_task_context',
      arguments: { sessionId: 'claude-session', projectPath: '/synthetic/project' }
    });
    assert.equal(received.sessionId, 'claude-session');
    assert.equal(received.sourceApplication, 'claude_code');
    assert.match(received.sourceSessionId, /^fuli-host-/);
    assert.notEqual(received.sourceSessionId, nativeThreadId);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP allowlists reject unknown names instead of silently hiding typos', () => {
  assert.throws(
    () => createMcpServer({}, {
      env: {}, toolNames: ['not_a_fuli_tool'], registerResources: false
    }),
    /Unknown MCP tool.*not_a_fuli_tool/
  );
});

test('custom MCP calls forward request metadata to the runtime lease boundary', async () => {
  const controller = new AbortController();
  const extra = { signal: controller.signal, requestId: 7, sessionId: 'transport-session' };
  let leaseExtra;
  const server = createMcpServer({ listKnowledgeSpaces: async () => [] }, {
    env: {}, toolNames: ['list_knowledge_spaces'], registerResources: false,
    withRuntimeLease: async (_owner, operation, requestExtra) => {
      leaseExtra = requestExtra;
      return operation();
    }
  });
  const handler = server.server._requestHandlers.get('tools/call');
  const result = await handler({
    method: 'tools/call', params: { name: 'list_knowledge_spaces', arguments: {} }
  }, extra);

  assert.equal(result.isError, undefined);
  assert.equal(leaseExtra, extra);
  await server.close();
});

test('already-cancelled MCP calls never enter a custom runtime lease', async () => {
  let leaseCalls = 0;
  let applicationCalls = 0;
  const server = createMcpServer({
    listKnowledgeSpaces: async () => {
      applicationCalls += 1;
      return [];
    }
  }, {
    env: {}, toolNames: ['list_knowledge_spaces'], registerResources: false,
    withRuntimeLease: async (_owner, operation) => {
      leaseCalls += 1;
      return operation();
    }
  });
  const controller = new AbortController();
  controller.abort(new Error('synthetic cancellation before lease'));
  const handler = server.server._requestHandlers.get('tools/call');
  const result = await handler({
    method: 'tools/call', params: { name: 'list_knowledge_spaces', arguments: {} }
  }, { signal: controller.signal, requestId: 9 });

  assert.equal(result.isError, true);
  assert.equal(leaseCalls, 0);
  assert.equal(applicationCalls, 0);
  await server.close();
});

test('custom MCP validation reports bounded issue paths without argument values', async () => {
  const server = createMcpServer({}, {
    env: {}, toolNames: ['coordinate_project_agent_task'], registerResources: false
  });
  const handler = server.server._requestHandlers.get('tools/call');
  const result = await handler({
    method: 'tools/call',
    params: { name: 'coordinate_project_agent_task', arguments: { personalSpaceId: 'secret-value' } }
  }, { signal: new AbortController().signal, requestId: 8 });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'validation');
  assert.ok(result.structuredContent.error.validationErrors.length > 0);
  assert.ok(result.structuredContent.error.validationErrors.some(({ field }) =>
    ['idempotencyKey', 'title', 'objective', 'workKind', 'routingReason', 'contextQueries'].includes(field)
  ), 'missing required task inputs still produce a concrete field error');
  assert.doesNotMatch(JSON.stringify(result), /secret-value/);
  await server.close();
});

test('default MCP surfaces omit cleanup_test_project_agents unless enabled', async () => {
  const disabled = createMcpServer({}, {
    env: {}, registerResources: false
  });
  let invoked = 0;
  const enabled = createMcpServer({ cleanupProjectAgentTestRoles: async () => { invoked += 1; return { removed: 0 }; } }, {
    env: { FULI_ENABLE_TEST_TOOLS: '1' }, registerResources: false
  });
  const disabledClient = new Client({ name: 'test-tools-off', version: '1.0.0' });
  const enabledClient = new Client({ name: 'test-tools-on', version: '1.0.0' });
  const [disabledClientTransport, disabledServerTransport] = InMemoryTransport.createLinkedPair();
  const [enabledClientTransport, enabledServerTransport] = InMemoryTransport.createLinkedPair();
  try {
    await disabled.connect(disabledServerTransport);
    await disabledClient.connect(disabledClientTransport);
    await enabled.connect(enabledServerTransport);
    await enabledClient.connect(enabledClientTransport);
    const disabledNames = (await disabledClient.listTools()).tools.map(({ name }) => name);
    const enabledNames = (await enabledClient.listTools()).tools.map(({ name }) => name);
    assert.equal(disabledNames.includes('cleanup_test_project_agents'), false);
    assert.equal(enabledNames.includes('cleanup_test_project_agents'), true);
    const result = await enabledClient.callTool({ name: 'cleanup_test_project_agents', arguments: {
      personalSpaceId: 'fixture-space', testSource: 'fixture-run'
    } });
    assert.notEqual(result.isError, true);
    assert.equal(invoked, 1);
    assert.equal((await disabledClient.callTool({ name: 'cleanup_test_project_agents', arguments: {
      personalSpaceId: 'fixture-space', testSource: 'fixture-run'
    } })).isError, true);
  } finally {
    await disabledClient.close();
    await enabledClient.close();
    await disabled.close();
    await enabled.close();
  }
});

function workerFixture({ memoryScope = 'reviewed_agent' } = {}) {
  const calls = { get: 0, admit: 0, views: 0, ordinary: 0, entries: [], business: [], memories: [] };
  const descriptor = { runId: 'synthetic-run', personalProjectId: 'worker-project',
    capability: 'synthetic-worker-capability-32-characters', projectPath: '/host/project',
    taskPrompt: 'Bounded host brief', toolNames: ['begin_task_context', 'get_collaboration_preferences',
      'verify_task_checkpoint', 'checkpoint_task_knowledge', 'search_current_project_knowledge',
      'get_project_agent_memory', 'list_agent_conversations', 'read_agent_conversation'] };
  const run = { run_id: descriptor.runId, state: 'sealed', personal_space_id: 'worker-space',
    personal_project_id: descriptor.personalProjectId, agent_id: 'worker-agent', task_id: 'coord-task',
    target_application: 'codex', actual_session_id: '019fc6ed-02a5-7832-8821-68e3b03e7cef' };
  const context = { token: 'fuli-task-own-worker-token', session_id: run.actual_session_id,
    personal_space_id: run.personal_space_id, personal_project_id: run.personal_project_id,
    project_agent_id: run.agent_id, source_application: run.target_application,
    source_session_id: run.actual_session_id, turn_id: `worker-run:${run.run_id}`,
    agent_memory_scope: memoryScope, memory_revision: 0, work_log_required: true };
  let closed = false;
  const memory = input => ({ personal_space_id: input.personalSpaceId,
    personal_project_id: input.personalProjectId, agent_id: input.agentId, revision: 0, current: null });
  const business = input => { calls.business.push(input); return input; };
  const app = { config: { personal: { spaceId: run.personal_space_id } },
    getCapturePolicy: () => ({ enabled: true }),
    taskContextRegistry: { begin: () => { calls.ordinary++; throw new Error('Ordinary begin forbidden'); } },
    getCollaborationPreferences: () => { calls.ordinary++; throw new Error('Ordinary entry forbidden'); },
    beginTaskContext: () => { calls.ordinary++; throw new Error('Ordinary begin forbidden'); },
    getProjectAgentMemory: business, queryAgentConversations: business,
    checkpointTaskKnowledge: business, verifyTaskCheckpoint: business, searchCurrentProjectKnowledge: business,
    searchKnowledge: async () => ({ facts: [], entities: [] }),
    personal: {
      getProjectAgentWorkerRun: async () => { calls.get++; return { ...run }; },
      admitProjectAgentWorkerContext: async () => {
        calls.admit++;
        if (closed) throw new Error('Run closed');
        return { ...run, state: 'admitted', own_context_token: context.token, task_context: { ...context } };
      },
      getProjectAgent: async () => ({ agent_id: run.agent_id, personal_space_id: run.personal_space_id,
        memory_scope: memoryScope, profile: { name: 'Worker', status: 'active', responsibility: 'Bounded work' } }),
      viewProjectAgentTask: async () => ({ task_id: run.task_id, personal_space_id: run.personal_space_id,
        personal_project_id: run.personal_project_id, work_kind: 'implementation' }),
      collaborationPreferences: async (space, project, limit, agent, dimensions) => {
        calls.entries.push({ space, project, agent, dimensions });
        return { personal_space_id: space, personal_project_id: project, project_agent_id: agent,
          effective_preferences: [], global_preferences: [{ id: 'pref', item_kind: 'entity' }],
          queued_conflicts: [], source_windows: { candidates_truncated: false,
            project_ancestors_truncated: false, queued_conflicts_truncated: false }, truncated: false };
      },
      listPreferenceConflicts: async () => [], recordAgentViews: async () => { calls.views++; },
      getProjectAgentMemory: async input => { calls.memories.push(input); return memory(input); },
      getPersonalProject: async () => ({ profile: { name: 'Worker project' } }),
      listProjectAgentTasks: async () => [], getProjectAgentCoordinationPolicy: async () => ({}),
      listProjectAgents: async () => [],
      conversation: async (operation, input) => operation === 'append'
        ? { status: 'saved', conversation_id: 'worker-conversation' }
        : input.mode === 'session' ? { conversation_id: 'worker-conversation' }
          : { context: { latest_checkpoint: 'Own latest result', messages: [{ sequence: 2, role: 'user', content: 'Own recent raw' }] } }
    } };
  const port = createWorkerTaskContext(app, descriptor);
  return { app, descriptor, port, run, context, calls, close: () => { closed = true; } };
}

async function workerCall(server, name, args = {}, signal = new AbortController().signal) {
  return server.server._requestHandlers.get('tools/call')({ method: 'tools/call',
    params: { name, arguments: args } }, { signal, requestId: 1 });
}

test('ordinary and worker MCP entries deliver the same explicit preference block without partial rules', async () => {
  for (const worker of [false, true]) {
    const { app, port, context, calls } = workerFixture();
    let sourceTruncated;
    const read = app.personal.collaborationPreferences;
    app.personal.collaborationPreferences = async (...args) => ({ ...await read(...args),
      truncated: sourceTruncated, effective_preferences: sourceTruncated ? [] : [{ instruction: 'Long complete rule. '.repeat(12_000) }] });
    const ordinaryEntry = () => ({ context: { ...context, source_truncated: sourceTruncated },
      effective_preferences: sourceTruncated ? [] : [{ instruction: 'Long complete rule. '.repeat(12_000) }],
      task_lifecycle: { status: 'not_started', reason: 'native_session_required' } });
    if (!worker) { app.getCollaborationPreferences = ordinaryEntry; app.beginTaskContext = ordinaryEntry; }
    const server = createMcpServer(app, { env: {}, registerResources: false,
      ...(worker ? { workerTaskContext: port } : { toolNames: ['begin_task_context', 'get_collaboration_preferences'] }) });
    try {
      for (sourceTruncated of [true, false]) {
        for (const name of ['begin_task_context', 'get_collaboration_preferences']) {
          const result = await workerCall(server, name, { projectPath: '/host/project', sessionId: 'synthetic-session' });
          assert.notEqual(result.isError, true);
          const data = result.structuredContent;
          assert.equal(data.preference_delivery.reason, sourceTruncated ? 'source_window' : 'delivery_budget');
          assert.equal(data.preferences_complete, false);
          assert.equal(data.same_task_recovery_available, false);
          assert.equal(Object.hasOwn(data, 'effective_preferences'), false);
          assert.match(result.content[0].text, /Fuli preference delivery is blocked/);
          assert.match(data.preference_delivery.guidance, /Do not execute/);
          if (name === 'get_collaboration_preferences') assert.equal(result.content[0].text, JSON.stringify(data));
          assert.doesNotMatch(result.content[0].text, /Apply effective_preferences/);
          if (worker) {
            assert.equal(data.task_context_token, context.token);
            assert.equal(data.worker_run.run_id, 'synthetic-run');
            assert.equal(data.context.project_agent_id, context.project_agent_id);
            assert.equal(data.project_agent_context.memory, undefined);
            assert.equal(data.agent_receipt.owner.agent_id, context.project_agent_id);
          } else {
            assert.equal(data.task_lifecycle.status, 'not_started');
            assert.equal(data.task_context_token, undefined);
          }
          assert.ok(Buffer.byteLength(JSON.stringify(data)) <= 128 * 1024);
        }
      }
      if (worker) { assert.equal(calls.ordinary, 0); assert.equal(calls.admit, 4); }
    } finally { await server.close(); }
  }
});

test('worker initialization is offline and entry delivers its admitted identity without ordinary selection', async () => {
  const { app, port, calls, run, context } = workerFixture();
  run.state = 'claimed';
  const server = createMcpServer(app, { workerTaskContext: port,
    env: { CODEX_THREAD_ID: '019fc6ed-02a5-7832-8821-68e3b03e7ce3' } });
  const client = new Client({ name: 'worker-contract', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    assert.equal((await client.listTools()).tools.length, 8);
    assert.equal(calls.get + calls.admit, 0);
    assert.equal(server.server._requestHandlers.has('resources/read'), false);
    assert.equal((await workerCall(server, 'list_agent_interfaces')).isError, true);
    assert.equal(calls.get + calls.admit, 0);
    assert.equal((await workerCall(server, 'verify_task_checkpoint', { sessionId: 'parent' })).isError, true);
    assert.equal(calls.admit, 0);
    run.state = 'sealed';
    const result = await workerCall(server, 'get_collaboration_preferences', {
      projectPath: '/forged', taskPrompt: 'Forged model brief', sessionId: 'parent-session',
      workKind: 'forged', workflow: 'forged', projectAgentId: 'worker-agent'
    });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.taskContextToken, context.token);
    assert.equal(result.structuredContent.agent_receipt.owner.agent_id, run.agent_id);
    assert.match(result.structuredContent.task_guidance.collaboration, /already assigned bounded worker/);
    assert.equal(result.structuredContent.conversation.recovery.messages[0].content, 'Own recent raw');
    assert.equal(calls.ordinary, 0);
    assert.equal(calls.views, 1);
    assert.deepEqual(calls.entries[0].dimensions, { sessionId: run.actual_session_id,
      sourceSessionId: run.actual_session_id, workKind: 'implementation', workflow: null });
    assert.deepEqual(calls.memories.map(input => input.personalProjectId), ['worker-project', null]);
  } finally { await client.close(); await server.close(); }
});

test('worker business calls re-admit, clamp caller fields and reject foreign targets and closed runs', async () => {
  const { app, port, calls, context, run, close } = workerFixture();
  const server = createMcpServer(app, { workerTaskContext: port, env: {},
    prepareToolInput: (_name, input) => ({ ...input, sourceApplication: 'other',
      sourceSessionId: 'parent-session', source_session_id: 'parent-snake-session', turn_id: 'parent-turn' }) });
  try {
    for (const personalProjectId of ['worker-project', null]) {
      const result = await workerCall(server, 'get_project_agent_memory', {
        personalSpaceId: 'worker-space', personalProjectId, agentId: 'worker-agent'
      });
      assert.notEqual(result.isError, true);
      assert.equal(calls.business.at(-1).personalProjectId, personalProjectId);
      assert.equal(calls.business.at(-1).sourceSessionId, run.actual_session_id);
    }
    const checkpoint = await workerCall(server, 'checkpoint_task_knowledge', {
      taskContextToken: 'parent-token', disposition: 'retain_nothing', reason: 'Synthetic',
      workLog: { status: 'reported', summary: 'Synthetic result' }
    });
    assert.notEqual(checkpoint.isError, true);
    assert.equal(calls.business.at(-1).taskContextToken, context.token);
    assert.equal(calls.business.at(-1).turnId, `worker-run:${run.run_id}`);
    assert.equal((await workerCall(server, 'checkpoint_task_knowledge', {
      taskContextToken: context.token, disposition: 'retain_nothing', reason: 'Synthetic', collaborators: ['foreign']
    })).isError, true);
    assert.equal((await workerCall(server, 'get_project_agent_memory', {
      personalSpaceId: 'worker-space', personalProjectId: 'foreign-project', agentId: 'worker-agent'
    })).isError, true);
    assert.equal((await workerCall(server, 'read_agent_conversation', {
      personalSpaceId: 'worker-space', agentId: 'foreign-agent', conversationId: 'foreign'
    })).isError, true);
    assert.equal(calls.admit, 6);
    assert.equal(calls.business.length, 3);
    assert.equal(calls.entries.length + calls.views + calls.memories.length, 0);
    close();
    assert.equal((await workerCall(server, 'verify_task_checkpoint', { sessionId: 'parent-session' })).isError, true);
    assert.equal(calls.business.length, 3);
  } finally { await server.close(); }
});

test('worker task-only memory and allowlists fail closed while restart keeps the own token', async () => {
  const fixture = workerFixture({ memoryScope: 'task_only' });
  assert.throws(() => createWorkerTaskContext(fixture.app, { ...fixture.descriptor,
    toolNames: ['get_user_taste_skill'] }), /worker.*tool/i);
  assert.throws(() => createMcpServer(fixture.app, { workerTaskContext: fixture.port,
    toolNames: ['list_agent_interfaces'] }), /worker.*tool/i);
  assert.throws(() => createMcpServer(fixture.app, { workerTaskContext: false }), /worker.*tool/i);
  const server = createMcpServer(fixture.app, { workerTaskContext: fixture.port, env: {} });
  try {
    const denied = await workerCall(server, 'get_project_agent_memory', {
      personalSpaceId: 'worker-space', agentId: 'worker-agent', personalProjectId: null
    });
    assert.equal(denied.isError, true);
    assert.equal(fixture.calls.business.length, 0);
    const first = await fixture.port.admit();
    const restarted = await createWorkerTaskContext(fixture.app, fixture.descriptor).admit();
    assert.equal(first.task.token, restarted.task.token);
    await fixture.port.entry(first, 'begin_task_context');
    assert.equal(fixture.calls.memories.length, 0);
  } finally { await server.close(); }
});

test('mismatched worker context identity, timeout and cancellation never reach business handlers', async () => {
  for (const override of [{ source_application: 'other' }, { personal_space_id: 'foreign' },
    { project_agent_id: 'parent' }, { source_session_id: 'parent' }, { turn_id: 'arbitrary-turn' },
    { token: 'fuli-task-foreign-token' }]) {
    const { app, port, context, calls } = workerFixture();
    const admit = app.personal.admitProjectAgentWorkerContext;
    app.personal.admitProjectAgentWorkerContext = async (...args) => ({ ...await admit(...args),
      task_context: { ...context, ...override } });
    const server = createMcpServer(app, { workerTaskContext: port, env: {} });
    try {
      assert.equal((await workerCall(server, 'verify_task_checkpoint', { sessionId: 'parent' })).isError, true);
      assert.equal(calls.business.length, 0);
    } finally { await server.close(); }
  }
  const { app, port, calls, descriptor } = workerFixture();
  const controller = new AbortController();
  app.personal.admitProjectAgentWorkerContext = async () => { controller.abort(new ApplicationError('cancelled', descriptor.capability)); };
  const server = createMcpServer(app, { workerTaskContext: port, env: {} });
  try {
    const cancelled = await workerCall(server, 'verify_task_checkpoint', { sessionId: 'parent' }, controller.signal);
    assert.equal(cancelled.isError, true);
    assert.equal(JSON.stringify(cancelled).includes(descriptor.capability), false);
    assert.equal(calls.business.length, 0);
    const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
      requestTimeoutMs: 10, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
    app.personal.admitProjectAgentWorkerContext = client.admitProjectAgentWorkerContext.bind(client);
    const timedOut = await workerCall(server, 'verify_task_checkpoint', { sessionId: 'parent' });
    assert.equal(timedOut.structuredContent.error.code, 'provider_timeout');
    assert.equal(calls.business.length, 0);
  } finally { await server.close(); }
});

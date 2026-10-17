import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createAgentRoundtable } from '../src/agent-roundtable/service.js';
import { createRoundtableStore } from '../src/agent-roundtable/store.js';
import {
  activeSealedWorkerRequest, runWithAgentRequestContext, sealedWorkerRequestContext
} from '../src/app/agent-request-context.js';
import { checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';

// Synthetic boundaries only: no live Provider, graph, project, knowledge or model CLI.
// Scope: only a Provider-admitted sealed worker call skips capture. Roundtable
// wakes are explicitly not covered and keep ordinary capture.

function fixture({ env = null, crashOnComplete = false } = {}) {
  const calls = { prepare: [], complete: [], writes: [], validations: 0, preflights: 0, conversations: [] };
  let checkpoint = null;
  let crash = crashOnComplete;
  const task = () => ({ token: 'fuli-task-synthetic-internal', sessionId: 'synthetic-session',
    personalProjectId: 'synthetic-project', projectAgentId: 'synthetic-lead', sourceApplication: 'codex',
    turnId: 'worker-run:synthetic', projectScope: null, agentMemoryScope: 'reviewed_agent', workLogRequired: true,
    agentMemory: checkpoint?.memory ?? null,
    checkpoint: checkpoint && { ...checkpoint, collaboration: { version: 1, status: 'frozen',
      owner: { agent_id: 'synthetic-lead', name: 'Synthetic lead' }, collaborators: [] } } });
  const app = {
    config: { personal: { spaceId: 'synthetic-space' } },
    getCapturePolicy: () => ({ enabled: true }),
    getProjectAgent: async () => ({ agentId: 'synthetic-lead', memoryScope: 'reviewed_agent',
      profile: { status: 'active', allowedClients: ['codex'] } }),
    taskContextRegistry: {
      context: async () => task(),
      prepare: async (_token, value, _source, memory) => {
        calls.prepare.push({ value, memory });
        checkpoint = { ...value, phase: 'prepare', memory: memory ? { checkpoint_id: 'synthetic-memory-checkpoint',
          personal_space_id: 'synthetic-space', personal_project_id: 'synthetic-project', agent_id: 'synthetic-lead',
          revision: memory.expected_revision + 1, memory: memory.memory, source_application: 'codex',
          source_session_id: 'synthetic-session', created_at: '2026-10-17T00:00:00Z' } : null };
        return task();
      },
      checkpoint: async (_token, value) => {
        if (crash) { crash = false; throw new Error('Synthetic crash after prepare'); }
        calls.complete.push(value); checkpoint = { ...checkpoint, ...value, phase: 'complete' }; return task();
      }
    },
    validateCaptureSessionKnowledge: () => { calls.validations++; },
    preflightPersonalKnowledgeCaptures: async () => { calls.preflights++; },
    captureSessionKnowledge: async input => {
      calls.writes.push(input);
      return { route: 'personal', status: 'committed', episode_id: 'synthetic-episode',
        entity_ids: ['synthetic-entity'], relationship_ids: [] };
    },
    personal: { conversation: async (_action, input) => { calls.conversations.push(input);
      return { status: 'saved', conversation_id: 'synthetic-conversation' }; } }
  };
  if (env) app.roundtable = createAgentRoundtable({ app, env, openStore: () => createRoundtableStore() });
  return { app, calls, close: () => app.roundtable?.close() };
}

const preference = { key: 'synthetic-preference', name: 'Synthetic preference', type: 'PersonalPreference',
  profileAspect: 'taste', originQuadrant: 'known_known', confirmationStatus: 'pending',
  confirmationBasis: { existenceReason: 'Synthetic', quadrantReason: 'Synthetic', proposedBy: { kind: 'agent' } } };
const capture = { idempotencyKey: 'synthetic', name: 'Synthetic capture', sourceKind: 'synthetic',
  sourceDescription: 'Synthetic fixture', referenceTime: '2026-10-17T00:00:00Z', sourceExcerpt: 'Synthetic excerpt',
  entities: [preference], relationships: [] };
const workLog = { status: 'completed', summary: 'Synthetic worker result' };
const agentMemory = { expectedRevision: 3, memory: { summary: 'Synthetic worker memory' } };
const request = extra => ({ taskContextToken: 'fuli-task-synthetic-internal', sourceApplication: 'codex',
  disposition: 'capture_candidates', reason: 'Synthetic capture request', capture, workLog, agentMemory, ...extra });
const sealed = operation => runWithAgentRequestContext(sealedWorkerRequestContext({}), operation);
// Caller payload claims that must neither clear nor set the sealed worker origin.
const forged = { internalActivity: null, activityOrigin: 'user_explicit', sourceSessionVerified: true,
  sealedWorker: false, delegation: null };

function assertCompletedWithoutCapture(result, calls) {
  assert.equal(result.status, 'checkpointed');
  assert.equal(result.capture.status, 'internal_activity_skipped');
  assert.equal(result.capture.persisted, false);
  assert.equal(result.capture.activity_origin, 'sealed_worker');
  assert.equal(result.capture_status, 'internal_activity_skipped');
  assert.equal(result.capture_results, undefined);
  assert.deepEqual(result.agent_memory && [result.agent_memory.status, result.agent_memory.revision], ['checkpointed', 4]);
  assert.equal(result.agent_receipt.owner.agent_id, 'synthetic-lead');
  assert.deepEqual([calls.writes.length, calls.validations, calls.preflights], [0, 0, 0]);
  assert.deepEqual(calls.prepare.at(-1).value.workLog, workLog);
  assert.equal(calls.prepare.at(-1).memory.expected_revision, 3);
  assert.equal(calls.complete.length, 1);
  assert.equal(calls.complete[0].captureStatus, 'internal_activity_skipped');
  assert.equal(calls.complete[0].captureResults, undefined);
  assert.ok(calls.conversations.length >= 1);
}

test('an admitted sealed worker checkpoints with work log, memory revision and receipt but writes no candidates', async () => {
  for (const extra of [{}, forged]) {
    const { app, calls } = fixture();
    assertCompletedWithoutCapture(await sealed(() => checkpointTaskKnowledge(app, request(extra))), calls);
  }
  // Scoped routing from a sealed worker is skipped as well.
  const { app, calls } = fixture();
  assertCompletedWithoutCapture(await sealed(() => checkpointTaskKnowledge(app, request({
    captureRouting: [{ scope: 'personal_global', entityKeys: ['synthetic-preference'], relationshipKeys: [] }]
  }))), calls);
});

test('repeated sealed worker checkpoints neither write nor conflict', async () => {
  const { app, calls } = fixture();
  await sealed(() => checkpointTaskKnowledge(app, request()));
  const replay = await sealed(() => checkpointTaskKnowledge(app, request()));
  assert.equal(replay.replayed, true);
  assert.equal(replay.capture_status, 'internal_activity_skipped');
  assert.equal(calls.writes.length, 0);
  // A crash between prepare and completion resumes under the same fingerprint.
  const resumed = fixture({ crashOnComplete: true });
  await assert.rejects(sealed(() => checkpointTaskKnowledge(resumed.app, request())), /Synthetic crash/);
  const retry = await sealed(() => checkpointTaskKnowledge(resumed.app, request()));
  assert.equal(retry.status, 'checkpointed');
  assert.equal(retry.capture_status, 'internal_activity_skipped');
  assert.equal(resumed.calls.writes.length, 0);
  assert.equal(resumed.calls.prepare.length, 2);
});

test('a same-named symbol, a false marker or a plain context cannot forge the sealed worker origin', async () => {
  const lookalike = Symbol('fuli.sealedWorkerRequest');
  for (const context of [{ [lookalike]: true }, { sealedWorker: true, internalActivity: 'sealed_worker' },
    { [Symbol.for('fuli.sealedWorkerRequest')]: true }, null]) {
    const { app, calls } = fixture();
    const run = () => checkpointTaskKnowledge(app, request(forged));
    const result = context ? await runWithAgentRequestContext(context, run) : await run();
    assert.equal(result.capture.status, 'committed');
    assert.equal(result.capture_status, undefined);
    assert.equal(calls.writes.length, 1);
  }
  // Payload fields cannot clear a marked call either.
  const { app, calls } = fixture();
  await sealed(() => checkpointTaskKnowledge(app, request({ sealedWorker: false, internalActivity: null })));
  assert.equal(calls.writes.length, 0);
});

test('roundtable env grants of any shape no longer skip capture', async () => {
  for (const grant of ['synthetic-roundtable-grant-0123456789abcdef', 'forged', 'expired-or-revoked-grant']) {
    const { app, calls, close } = fixture({ env: { FULI_ROUNDTABLE_DELEGATION: grant } });
    try {
      const result = await checkpointTaskKnowledge(app, request());
      assert.equal(result.capture.status, 'committed');
      assert.equal(calls.writes.length, 1);
      assert.equal(calls.complete[0].captureStatus, 'committed');
    } finally { close(); }
  }
});

test('ordinary and unknown-origin checkpoints keep legacy capture', async () => {
  for (const env of [{}, null]) {
    const { app, calls, close } = fixture({ env });
    try {
      const result = await checkpointTaskKnowledge(app, request());
      assert.equal(result.capture.status, 'committed');
      assert.equal(calls.writes.length, 1);
      assert.equal(calls.writes[0].personalProjectId, 'synthetic-project');
      assert.equal(calls.validations, 1);
    } finally { close(); }
  }
});

test('sealed worker retain_nothing checkpoints are unchanged', async () => {
  const { app, calls } = fixture();
  const result = await sealed(() => checkpointTaskKnowledge(app, request({ disposition: 'retain_nothing', capture: null })));
  assert.equal(result.capture, null);
  assert.equal(result.capture_status, undefined);
  assert.equal(calls.complete[0].captureStatus, null);
});

function mcpCall(server, name, args) {
  return server.server._requestHandlers.get('tools/call')({ method: 'tools/call',
    params: { name, arguments: args } }, { signal: new AbortController().signal, requestId: 1 });
}

test('only the worker MCP composition marks calls, and only after Provider admission', async () => {
  const origins = [];
  let admitted = true;
  const app = { checkpointTaskKnowledge: () => {
    origins.push(activeSealedWorkerRequest());
    return { status: 'checkpointed' };
  } };
  const port = { toolNames: ['checkpoint_task_knowledge'],
    admit: async () => { if (!admitted) throw new Error('Worker session is not sealed and ready'); return { task: {} }; },
    prepareInput: (_name, input) => input, entry: () => { throw new Error('Unexpected entry'); } };
  const args = { taskContextToken: 'fuli-task-synthetic-internal', disposition: 'retain_nothing', reason: 'Synthetic' };
  const worker = createMcpServer(app, { env: {}, registerResources: false, workerTaskContext: port });
  const ordinary = createMcpServer(app, { env: { FULI_ROUNDTABLE_DELEGATION: 'synthetic-roundtable-grant-0123456789abcdef' },
    registerResources: false, toolNames: ['checkpoint_task_knowledge'] });
  const client = new Client({ name: 'internal-capture-contract', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await worker.connect(serverTransport); await client.connect(clientTransport);
    assert.notEqual((await mcpCall(worker, 'checkpoint_task_knowledge', args)).isError, true);
    assert.notEqual((await mcpCall(ordinary, 'checkpoint_task_knowledge', args)).isError, true);
    // The strict tool schema rejects provenance claims before any handler runs.
    for (const [key, value] of Object.entries({ ...forged, sealedWorker: true, internalActivity: 'sealed_worker' })) {
      for (const server of [worker, ordinary]) {
        const result = await mcpCall(server, 'checkpoint_task_knowledge', { ...args, [key]: value });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /Unrecognized key/);
      }
    }
    admitted = false;
    assert.equal((await mcpCall(worker, 'checkpoint_task_knowledge', args)).isError, true);
    assert.deepEqual(origins, [true, false]);
  } finally { await client.close(); await worker.close(); await ordinary.close(); }
});

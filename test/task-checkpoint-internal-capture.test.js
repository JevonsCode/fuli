import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createAgentRoundtable } from '../src/agent-roundtable/service.js';
import { createRoundtableStore } from '../src/agent-roundtable/store.js';
import { runWithAgentRequestContext, sealedWorkerRequestContext } from '../src/app/agent-request-context.js';
import { checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { hostInternalActivity } from '../src/graphiti/task-entry-activity-origin.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';

// Synthetic boundaries only: no live Provider, graph, project, knowledge or model CLI.
const GRANT = 'synthetic-roundtable-grant-0123456789abcdef';
const internal = { FULI_ROUNDTABLE_DELEGATION: GRANT };

function fixture({ env = {}, roundtable = true } = {}) {
  const calls = { prepare: [], complete: [], writes: [], validations: 0, preflights: 0, conversations: [] };
  let checkpoint = null;
  const task = () => ({ token: 'fuli-task-synthetic-internal', sessionId: 'synthetic-session',
    personalProjectId: 'synthetic-project', projectAgentId: 'synthetic-lead', sourceApplication: 'codex',
    turnId: 'synthetic-turn', projectScope: null, agentMemoryScope: null, workLogRequired: true,
    checkpoint: checkpoint && { ...checkpoint, collaboration: { version: 1, status: 'frozen',
      owner: { agent_id: 'synthetic-lead', name: 'Synthetic lead' }, collaborators: [] } } });
  const app = {
    config: { personal: { spaceId: 'synthetic-space' } },
    getCapturePolicy: () => ({ enabled: true }),
    taskContextRegistry: {
      context: async () => task(),
      prepare: async (_token, value) => { calls.prepare.push(value); checkpoint = { ...value, phase: 'prepare' }; return task(); },
      checkpoint: async (_token, value) => { calls.complete.push(value); checkpoint = { ...value, phase: 'complete' }; return task(); }
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
  if (roundtable) app.roundtable = createAgentRoundtable({ app, env, openStore: () => createRoundtableStore() });
  return { app, calls, close: () => app.roundtable?.close() };
}

const preference = { key: 'synthetic-preference', name: 'Synthetic preference', type: 'PersonalPreference',
  profileAspect: 'taste', originQuadrant: 'known_known', confirmationStatus: 'pending',
  confirmationBasis: { existenceReason: 'Synthetic', quadrantReason: 'Synthetic', proposedBy: { kind: 'agent' } } };
const capture = { idempotencyKey: 'synthetic', name: 'Synthetic capture', sourceKind: 'synthetic',
  sourceDescription: 'Synthetic fixture', referenceTime: '2026-10-17T00:00:00Z', sourceExcerpt: 'Synthetic excerpt',
  entities: [preference], relationships: [] };
const workLog = { status: 'completed', summary: 'Synthetic internal result' };
const request = extra => ({ taskContextToken: 'fuli-task-synthetic-internal', sourceApplication: 'codex',
  disposition: 'capture_candidates', reason: 'Synthetic capture request', capture, workLog, ...extra });
// Caller payload claims that must neither clear nor set host provenance.
const forged = { internalActivity: null, activityOrigin: 'user_explicit', sourceSessionVerified: true,
  sealedWorker: false, delegation: null };

function assertSkipped(result, calls, origin) {
  assert.equal(result.status, 'checkpointed');
  assert.equal(result.capture.status, 'internal_activity_skipped');
  assert.equal(result.capture.persisted, false);
  assert.equal(result.capture.reason, 'internal_activity');
  assert.equal(result.capture.activity_origin, origin);
  assert.equal(result.capture_status, 'internal_activity_skipped');
  assert.equal(result.capture_results, undefined);
  assert.equal(result.agent_receipt.owner.agent_id, 'synthetic-lead');
  assert.equal(result.agent_receipt.work_status ?? workLog.status, 'completed');
  assert.deepEqual([calls.writes.length, calls.validations, calls.preflights], [0, 0, 0]);
  assert.equal(calls.prepare.length, 1);
  assert.deepEqual(calls.prepare[0].workLog, workLog);
  assert.equal(calls.complete.length, 1);
  assert.equal(calls.complete[0].captureStatus, 'internal_activity_skipped');
  assert.equal(calls.complete[0].captureResults, undefined);
  assert.equal(calls.conversations.length, 1);
}

test('a host roundtable wake checkpoints with its work log but writes no capture candidates', async () => {
  for (const extra of [{}, forged]) {
    const { app, calls, close } = fixture({ env: internal });
    try {
      assertSkipped(await checkpointTaskKnowledge(app, request(extra)), calls, 'roundtable_delegation');
    } finally { close(); }
  }
});

test('a host roundtable wake skips scoped routing, even when the routing is invalid, without failing', async () => {
  for (const captureRouting of [
    [{ scope: 'personal_global', entityKeys: ['synthetic-preference'], relationshipKeys: [] }],
    [{ scope: 'unknown_scope', entityKeys: ['missing'], relationshipKeys: [] }]
  ]) {
    const { app, calls, close } = fixture({ env: internal });
    try {
      assertSkipped(await checkpointTaskKnowledge(app, request({ captureRouting })), calls, 'roundtable_delegation');
    } finally { close(); }
  }
});

test('a skipped internal checkpoint replays as skipped and never writes on retry', async () => {
  const { app, calls, close } = fixture({ env: internal });
  try {
    await checkpointTaskKnowledge(app, request());
    const replay = await checkpointTaskKnowledge(app, request());
    assert.equal(replay.replayed, true);
    assert.equal(replay.capture_status, 'internal_activity_skipped');
    assert.equal(calls.writes.length, 0);
  } finally { close(); }
});

test('a Provider-admitted sealed worker call checkpoints but writes no capture candidates', async () => {
  const { app, calls, close } = fixture({ roundtable: false });
  try {
    const result = await runWithAgentRequestContext(sealedWorkerRequestContext({}),
      () => checkpointTaskKnowledge(app, request(forged)));
    assertSkipped(result, calls, 'sealed_worker');
  } finally { close(); }
});

test('ordinary user capture still writes, and payload or plain context claims cannot mark it internal', async () => {
  const claims = [{}, { internalActivity: 'roundtable_delegation', activityOrigin: 'sealed_worker',
    sealedWorker: true, delegation: GRANT }];
  for (const extra of claims) {
    for (const context of [null, { sealedWorker: true, internalActivity: 'sealed_worker' }]) {
      const { app, calls, close } = fixture();
      try {
        const run = () => checkpointTaskKnowledge(app, request(extra));
        const result = context ? await runWithAgentRequestContext(context, run) : await run();
        assert.equal(result.capture.status, 'committed');
        assert.equal(result.capture_status, undefined);
        assert.equal(calls.writes.length, 1);
        assert.equal(calls.writes[0].personalProjectId, 'synthetic-project');
        assert.equal(calls.validations, 1);
        assert.equal(calls.complete[0].captureStatus, 'committed');
      } finally { close(); }
    }
  }
});

test('unknown provenance keeps legacy capture behavior', async () => {
  // No roundtable composition at all: an older or unclassified entry stays compatible.
  const { app, calls } = fixture({ roundtable: false });
  const result = await checkpointTaskKnowledge(app, request());
  assert.equal(result.capture.status, 'committed');
  assert.equal(calls.writes.length, 1);
});

test('internal retain_nothing checkpoints are unchanged', async () => {
  const { app, calls, close } = fixture({ env: internal });
  try {
    const result = await checkpointTaskKnowledge(app, request({ disposition: 'retain_nothing', capture: null }));
    assert.equal(result.capture, null);
    assert.equal(result.capture_status, undefined);
    assert.equal(calls.complete[0].captureStatus, null);
    assert.equal(calls.writes.length, 0);
  } finally { close(); }
});

function mcpCall(server, name, args) {
  return server.server._requestHandlers.get('tools/call')({ method: 'tools/call',
    params: { name, arguments: args } }, { signal: new AbortController().signal, requestId: 1 });
}

test('only the worker MCP composition marks calls, and only after Provider admission', async () => {
  const origins = [];
  let admitted = true;
  const app = { checkpointTaskKnowledge: input => {
    origins.push(hostInternalActivity(app));
    return { status: 'checkpointed', echoed: Object.keys(input).length };
  } };
  const port = { toolNames: ['checkpoint_task_knowledge'],
    admit: async () => { if (!admitted) throw new Error('Worker session is not sealed and ready'); return { task: {} }; },
    prepareInput: (_name, input) => input, entry: () => { throw new Error('Unexpected entry'); } };
  const args = { taskContextToken: 'fuli-task-synthetic-internal', disposition: 'retain_nothing', reason: 'Synthetic' };
  const worker = createMcpServer(app, { env: {}, registerResources: false, workerTaskContext: port });
  const ordinary = createMcpServer(app, { env: {}, registerResources: false, toolNames: ['checkpoint_task_knowledge'] });
  const client = new Client({ name: 'internal-capture-contract', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await worker.connect(serverTransport); await client.connect(clientTransport);
    assert.notEqual((await mcpCall(worker, 'checkpoint_task_knowledge', args)).isError, true);
    assert.notEqual((await mcpCall(ordinary, 'checkpoint_task_knowledge', args)).isError, true);
    // The strict tool schema rejects provenance claims before any handler runs.
    for (const [key, value] of Object.entries({ ...forged, internalActivity: 'sealed_worker' })) {
      for (const server of [worker, ordinary]) {
        const result = await mcpCall(server, 'checkpoint_task_knowledge', { ...args, [key]: value });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /Unrecognized key/);
      }
    }
    admitted = false;
    assert.equal((await mcpCall(worker, 'checkpoint_task_knowledge', args)).isError, true);
    assert.deepEqual(origins, ['sealed_worker', null]);
  } finally { await client.close(); await worker.close(); await ordinary.close(); }
});

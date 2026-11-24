import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { FederatedGraphApplication, openFederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { localGlobalWrites } from '../src/graphiti/global-writes-port.js';

// Synthetic boundaries only: no Provider, graph, project or model. Every call a
// checkpoint makes to the application is recorded with its arguments, so the
// default port is held to exactly the calls and answer FULI made before the
// port existed (the snapshot was recorded from that code).
const SNAPSHOT = new URL('./fixtures/task-checkpoint-local-global-writes.json', import.meta.url);
const SPACE = 'synthetic-space';
const PROJECT = 'synthetic-project';
const AGENT = 'synthetic-lead';
const TOKEN = 'fuli-task-synthetic-global-writes';

function fixture({ personalProjectId, globalWrites, heldByOwner = false }) {
  const calls = [];
  let checkpoint = null;
  const record = (name, operation) => async (...args) => {
    calls.push([name, JSON.parse(JSON.stringify(args))]);
    return operation(...args);
  };
  const task = () => ({ token: TOKEN, sessionId: 'synthetic-session', personalProjectId, projectAgentId: AGENT,
    sourceApplication: 'codex', turnId: 'synthetic-turn', projectScope: null, agentMemoryScope: 'reviewed_agent',
    workLogRequired: false, agentMemory: checkpoint?.memory ?? null,
    checkpoint: checkpoint && { ...checkpoint, collaboration: { version: 1, status: 'frozen',
      owner: { agent_id: AGENT, name: 'Synthetic lead' }, collaborators: [] } } });
  const usageResult = value => value.knowledgeUsage ? { recorded_count: 1, duplicate_count: 0, promoted_count: 0,
    items: value.knowledgeUsage.map((item, index) => ({ item_id: item.itemId, item_kind: item.itemKind,
      held_by_owner: heldByOwner && index === 0 })) } : null;
  const app = {
    config: { personal: { spaceId: SPACE } },
    ...(globalWrites ? { globalWrites } : {}),
    getCapturePolicy: () => ({ enabled: true }),
    getProjectAgent: record('getProjectAgent', async () => ({ agentId: AGENT, memoryScope: 'reviewed_agent',
      profile: { status: 'active', allowedClients: ['codex'] } })),
    taskContextRegistry: {
      context: record('taskContextRegistry.context', async () => task()),
      prepare: record('taskContextRegistry.prepare', async (_token, value, _source, memory) => {
        checkpoint = { ...value, phase: 'prepare', knowledgeUsageResult: usageResult(value),
          memory: memory ? { checkpoint_id: 'synthetic-memory-checkpoint', personal_space_id: SPACE,
            personal_project_id: personalProjectId, agent_id: AGENT, revision: memory.expected_revision + 1,
            memory: memory.memory, source_application: 'codex', source_session_id: 'synthetic-session',
            created_at: '2026-11-01T00:00:00Z' } : null };
        return task();
      }),
      checkpoint: record('taskContextRegistry.checkpoint', async (_token, value) => {
        checkpoint = { ...checkpoint, ...value, phase: 'complete' };
        return task();
      })
    },
    validateCaptureSessionKnowledge: record('validateCaptureSessionKnowledge', async () => {}),
    preflightPersonalKnowledgeCaptures: record('preflightPersonalKnowledgeCaptures', async () => {}),
    captureSessionKnowledge: record('captureSessionKnowledge', async input => ({ route: 'personal',
      status: 'committed', episode_id: `episode-${input.personalProjectId ?? 'global'}`,
      entity_ids: [`entity-${input.personalProjectId ?? 'global'}`], relationship_ids: [] })),
    personal: { conversation: record('personal.conversation', async () => ({ status: 'saved',
      conversation_id: 'synthetic-conversation' })) }
  };
  return { app, calls };
}

const confirmationBasis = { existenceReason: 'Synthetic', quadrantReason: 'Synthetic', proposedBy: { kind: 'agent' } };
const preference = { key: 'synthetic-preference', name: 'Synthetic preference', type: 'PersonalPreference',
  profileAspect: 'taste', originQuadrant: 'known_known', confirmationStatus: 'pending', confirmationBasis };
const fact = { key: 'synthetic-fact', name: 'Synthetic project fact', type: 'ProjectFact',
  originQuadrant: 'known_known', confirmationStatus: 'pending', confirmationBasis };
const capture = entities => ({ idempotencyKey: 'synthetic', name: 'Synthetic capture', sourceKind: 'synthetic',
  sourceDescription: 'Synthetic fixture', referenceTime: '2026-11-01T00:00:00Z', sourceExcerpt: 'Synthetic excerpt',
  entities, relationships: [] });
const agentMemory = { expectedRevision: 2, memory: { summary: 'Synthetic memory', decisions: ['Synthetic decision'] } };
const knowledgeUsage = [{ itemId: 'synthetic-global-item', itemKind: 'entity', useKind: 'applied' },
  { itemId: 'synthetic-project-item', itemKind: 'entity', useKind: 'referenced' }];
const base = { taskContextToken: TOKEN, sourceApplication: 'codex', disposition: 'capture_candidates',
  reason: 'Synthetic checkpoint', agentMemory };

// A task in a project routing one preference to global and one fact to the
// project; a task without a project, with an unrouted capture and its FLA's
// global memory; and one without a project routing to global only.
const SCENARIOS = {
  projectRouted: { personalProjectId: PROJECT, request: { ...base, capture: capture([preference, fact]), knowledgeUsage,
    captureRouting: [{ scope: 'personal_global', entityKeys: ['synthetic-preference'], relationshipKeys: [] },
      { scope: 'current_project', entityKeys: ['synthetic-fact'], relationshipKeys: [] }] } },
  globalUnrouted: { personalProjectId: null, request: { ...base, capture: capture([preference]) } },
  globalRouted: { personalProjectId: null, request: { ...base, capture: capture([preference]),
    captureRouting: [{ scope: 'personal_global', entityKeys: ['synthetic-preference'], relationshipKeys: [] }] } }
};

async function run(name, options = {}) {
  const { personalProjectId, request } = SCENARIOS[name];
  const { app, calls } = fixture({ personalProjectId, ...options });
  const answer = await checkpointTaskKnowledge(app, request);
  return { calls, answer: JSON.parse(JSON.stringify(answer)) };
}

test('with the default port a checkpoint makes exactly the calls and answer it made before the port', async () => {
  const recorded = {};
  for (const name of Object.keys(SCENARIOS)) recorded[name] = await run(name);
  const snapshot = readFileSync(SNAPSHOT, 'utf8');
  assert.equal(`${JSON.stringify(recorded, null, 2)}\n`, snapshot);
  for (const name of Object.keys(SCENARIOS)) {
    assert.deepEqual(await run(name, { globalWrites: localGlobalWrites }), recorded[name]);
  }
});

// A port for global another computer owns: it records what it is handed and answers as told.
function ownerPort(answer = ops => ({ delivered: ops.length, queued: 0, refused: [] })) {
  const sent = [];
  return { sent, port: { elsewhere: () => true, send: async ({ key, ops }) => {
    sent.push({ key, ops: JSON.parse(JSON.stringify(ops)) });
    return answer(ops);
  } } };
}
const named = (calls, name) => calls.filter(([call]) => call === name).map(([, args]) => args);

test('elsewhere, a project task writes its project batch here and hands its global batch to the port', async () => {
  const { sent, port } = ownerPort();
  const { calls, answer } = await run('projectRouted', { globalWrites: port, heldByOwner: true });

  const written = named(calls, 'captureSessionKnowledge').map(([input]) => input.personalProjectId);
  assert.deepEqual(written, [PROJECT]);
  assert.deepEqual(named(calls, 'preflightPersonalKnowledgeCaptures').map(([inputs]) => inputs.map(input => input.personalProjectId)),
    [[PROJECT]]);
  // The project's FLA memory is the project's: prepared atomically here, as before.
  assert.equal(named(calls, 'taskContextRegistry.prepare')[0][3].expected_revision, 2);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].key, `${TOKEN}:global`);
  assert.deepEqual(sent[0].ops.map(op => [op.kind, op.v]), [['capture', 1], ['knowledge_usage', 1]]);
  assert.equal(sent[0].ops[0].input.personalProjectId, null);
  assert.deepEqual(sent[0].ops[0].input.entities.map(item => item.key), ['synthetic-preference']);
  // Only the use of the item held as a copy goes to its owner.
  assert.deepEqual(sent[0].ops[1].input, { taskId: TOKEN, sessionId: 'synthetic-session', sourceApplication: 'codex',
    items: [knowledgeUsage[0]] });
  assert.equal(answer.capture_status, 'committed');
  assert.deepEqual(answer.capture_results.map(item => item.scope), ['current_project']);
  assert.equal(answer.agent_memory.status, 'checkpointed');
  assert.deepEqual([answer.saved_here, answer.for_host], [2, { delivered: 2, queued: 0, refused: [] }]);
  const completed = named(calls, 'taskContextRegistry.checkpoint')[0][1];
  assert.deepEqual(completed.captureResults.map(item => item.scope), ['current_project']);
});

test('elsewhere, a task without a project asks this Provider for none of its global writes', async () => {
  for (const name of ['globalUnrouted', 'globalRouted']) {
    const { sent, port } = ownerPort(() => ({ delivered: 0, queued: 2, refused: [] }));
    const { calls, answer } = await run(name, { globalWrites: port });

    assert.deepEqual(named(calls, 'captureSessionKnowledge'), []);
    assert.deepEqual(named(calls, 'preflightPersonalKnowledgeCaptures'), []);
    // The checkpoint is still bound here, without the FLA's global memory.
    const [prepared] = named(calls, 'taskContextRegistry.prepare');
    assert.equal(prepared[3], null);
    assert.deepEqual(sent.map(item => item.ops.map(op => op.kind)), [['capture', 'agent_memory']]);
    assert.deepEqual(sent[0].ops[1].input, { agentId: AGENT, expectedRevision: 2, idempotencyKey: `${TOKEN}:memory`,
      memory: agentMemory.memory, sourceApplication: 'codex', sourceSessionId: 'synthetic-session' });
    assert.equal(answer.agent_memory.status, 'for_host');
    assert.deepEqual([answer.saved_here, answer.for_host], [0, { delivered: 0, queued: 2, refused: [] }]);
    const completed = named(calls, 'taskContextRegistry.checkpoint')[0][1];
    assert.equal(completed.captureStatus, 'for_host');
    assert.equal(completed.captureResults, undefined);
    assert.equal(answer.capture_results, undefined);
    if (name === 'globalUnrouted') assert.equal(answer.capture.status, 'for_host');
    else assert.equal(answer.capture_status, 'for_host');
  }
});

test('elsewhere, the owner\'s refusals come back in the answer with their codes', async () => {
  const { port } = ownerPort(() => ({ delivered: 1, queued: 0, refused: [{ kind: 'agent_memory', code: 'memory_revision_conflict' }] }));
  const { answer } = await run('globalUnrouted', { globalWrites: port });
  assert.deepEqual(answer.for_host.refused, [{ kind: 'agent_memory', code: 'memory_revision_conflict' }]);
});

test('elsewhere, a port that does not say what it delivered, queued and refused fails the checkpoint before it completes', async () => {
  for (const answer of [undefined, {}, { delivered: 1, queued: 0 }, { delivered: -1, queued: 0, refused: [] },
    { delivered: 1, queued: 0, refused: [{ kind: 'capture' }] }]) {
    const { port } = ownerPort(() => answer);
    const { personalProjectId, request } = SCENARIOS.globalUnrouted;
    const { app, calls } = fixture({ personalProjectId, globalWrites: port });
    await assert.rejects(checkpointTaskKnowledge(app, request), TypeError);
    assert.deepEqual(named(calls, 'taskContextRegistry.checkpoint'), []);
  }
});

test('elsewhere, a checkpoint with nothing for global sends nothing and answers as before', async () => {
  const { sent, port } = ownerPort();
  const { request } = SCENARIOS.projectRouted;
  const { app, calls } = fixture({ personalProjectId: PROJECT, globalWrites: port });
  const answer = await checkpointTaskKnowledge(app, { ...request, knowledgeUsage: undefined,
    captureRouting: [{ scope: 'current_project', entityKeys: ['synthetic-preference', 'synthetic-fact'], relationshipKeys: [] }] });
  assert.deepEqual(sent, []);
  assert.equal(answer.for_host, undefined);
  assert.equal(answer.saved_here, undefined);
  assert.equal(named(calls, 'captureSessionKnowledge').length, 1);
});

test('the application writes global here unless it is handed the port of the computer that owns it', () => {
  const config = { version: 1, workspaces: [], personal: { providerUrl: 'http://127.0.0.1:8787',
    accessToken: 'synthetic-token', principalId: 'synthetic-person', spaceId: SPACE } };
  const { port } = ownerPort();
  assert.equal(new FederatedGraphApplication(config).globalWrites, localGlobalWrites);
  assert.equal(openFederatedGraphApplication({ config, fetchImpl: async () => assert.fail('no request') }).globalWrites,
    localGlobalWrites);
  assert.equal(openFederatedGraphApplication({ config, globalWrites: port }).globalWrites, port);
});

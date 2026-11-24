import assert from 'node:assert/strict';
import test from 'node:test';

import { activeRunnerCaller } from '../src/app/agent-request-context.js';
import { ProviderRequestError } from '../src/graphiti/provider-client.js';
import { createRunnerRoutes } from '../src/runner/host-routes.js';
import { GLOBAL_WRITES_ENTRY, RUNNER_PATHS } from '../src/runner/protocol.js';
import { pairedStore, serveRunnerRoutes } from '../test-support/runner-host-routes.js';

// A host applying a follower's writes to global, with a synthetic application
// in place of its Provider. Only fictional data.
const RUNNER = 'a'.repeat(64);
const STRANGER = 'c'.repeat(64);
const SPACE = 'synthetic-space';

function hostApp({ hire = async () => ({ agent_id: 'synthetic-agent', status: 'created' }) } = {}) {
  const calls = [];
  const note = (name, answer) => async (input) => {
    calls.push({ name, input, runner: activeRunnerCaller() });
    return answer(input);
  };
  const app = {
    config: { personal: { spaceId: SPACE } },
    captureSessionKnowledge: note('capture', () => ({ route: 'personal', status: 'committed' })),
    checkpointProjectAgentMemory: note('agent_memory', (input) => {
      if (input.expectedRevision !== 4) {
        throw new ProviderRequestError('Agent memory revision changed', { status: 409, code: 'memory_revision_conflict' });
      }
      return { status: 'checkpointed' };
    }),
    recordKnowledgeUsage: note('knowledge_usage', () => ({ recorded_count: 1 })),
    personal: { hireForFollowerRecruitment: note('recruit', hire) }
  };
  return { app, calls };
}

async function host(t, app) {
  const leases = [];
  const routes = createRunnerRoutes({ app, store: pairedStore(RUNNER), hostName: 'Host', hostFingerprint: 'f'.repeat(64),
    withLease: (owner, operation) => { leases.push(owner); return operation(); } });
  return { leases, ...(await serveRunnerRoutes(t, routes)) };
}

const preference = { key: 'synthetic-preference', name: 'Synthetic preference', type: 'PersonalPreference',
  profileAspect: 'taste' };
const captureOp = { kind: 'capture', v: 1, input: { name: 'Synthetic capture', personalProjectId: null,
  spaceId: SPACE, entities: [preference], relationships: [], idempotencyKey: 'synthetic-task:knowledge:personal_global' } };
const memoryOp = (expectedRevision) => ({ kind: 'agent_memory', v: 1, input: { agentId: 'synthetic-lead', expectedRevision,
  idempotencyKey: 'synthetic-task:memory', memory: { summary: 'Synthetic memory' }, sourceApplication: 'codex',
  sourceSessionId: 'synthetic-session' } });
const usageOp = { kind: 'knowledge_usage', v: 1, input: { taskId: 'synthetic-task', sessionId: 'synthetic-session',
  items: [{ itemId: 'synthetic-item', itemKind: 'entity', useKind: 'applied' }] } };
const recruitOp = { kind: 'recruit', v: 1, input: { recruitmentId: 'synthetic-recruitment', proposedAgentId: 'synthetic-agent',
  profile: { name: 'Synthetic Lead', responsibility: 'Leads the synthetic project' },
  occupation: { role: 'synthetic_role', tags: ['synthetic_tag'] }, reason: 'The project needs a lead',
  projectName: 'Synthetic project' } };
const entry = (id, ops) => ({ id, tool: GLOBAL_WRITES_ENTRY, input: { ops }, sourceApplication: 'codex',
  sessionId: 'synthetic-session', offlineTask: null });

test('each op is applied as the runner\'s call and answered on its own; a refused one stops none of the others', async (t) => {
  const { app, calls } = hostApp();
  const { post, leases } = await host(t, app);

  const answer = await post(RUNNER, RUNNER_PATHS.replay, entry('global-1', [captureOp, memoryOp(3), usageOp, recruitOp]));

  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.result.ops, [
    { kind: 'capture', outcome: 'applied', code: null },
    { kind: 'agent_memory', outcome: 'refused', code: 'memory_revision_conflict' },
    { kind: 'knowledge_usage', outcome: 'applied', code: null },
    { kind: 'recruit', outcome: 'applied', code: null }]);
  assert.deepEqual(calls.map(({ name, runner }) => [name, runner]),
    [['capture', RUNNER], ['agent_memory', RUNNER], ['knowledge_usage', RUNNER], ['recruit', RUNNER]]);
  assert.deepEqual(leases, [`runner-replay:${GLOBAL_WRITES_ENTRY}`]);
  // Written to this computer's space, never into a project.
  assert.equal(calls[0].input.personalProjectId, null);
  assert.equal(calls[0].input.spaceId, SPACE);
  assert.deepEqual(calls[1].input, { personalSpaceId: SPACE, personalProjectId: null, agentId: 'synthetic-lead',
    expectedRevision: 3, idempotencyKey: 'synthetic-task:memory', memory: { summary: 'Synthetic memory' },
    sourceApplication: 'codex', sourceSessionId: 'synthetic-session' });
  assert.deepEqual(calls[2].input, { personalSpaceId: SPACE, taskId: 'synthetic-task', sessionId: 'synthetic-session',
    toolName: 'checkpoint_task_knowledge', items: usageOp.input.items });
});

test('one entry id delivered twice is applied once, and the second delivery gets the first answer', async (t) => {
  const { app, calls } = hostApp();
  const { post } = await host(t, app);

  const first = await post(RUNNER, RUNNER_PATHS.replay, entry('global-2', [captureOp, memoryOp(4)]));
  const second = await post(RUNNER, RUNNER_PATHS.replay, entry('global-2', [captureOp, memoryOp(4)]));

  assert.deepEqual(second.body, { result: first.body.result, replayedBefore: true });
  assert.deepEqual(calls.map(({ name }) => name), ['capture', 'agent_memory']);
});

test('an unpaired computer\'s entry is refused before anything is applied', async (t) => {
  const { app, calls } = hostApp();
  const { post } = await host(t, app);

  const answer = await post(STRANGER, RUNNER_PATHS.replay, entry('global-3', [captureOp]));

  assert.deepEqual(answer, { status: 403, body: { error: 'runner_unknown' } });
  assert.deepEqual(calls, []);
});

test('an op this host does not know is refused alone; the others still apply', async (t) => {
  const { app, calls } = hostApp();
  const { post } = await host(t, app);

  const answer = await post(RUNNER, RUNNER_PATHS.replay, entry('global-4', [
    { kind: 'workflow_observation', v: 1, input: {} }, { ...captureOp, v: 2 }, { kind: 'toString', v: 1, input: {} },
    { kind: 'capture', v: 1, input: { ...captureOp.input, personalProjectId: 'synthetic-project' } }, captureOp]));

  assert.deepEqual(answer.body.result.ops, [
    { kind: 'workflow_observation', outcome: 'refused', code: 'op_unknown' },
    { kind: 'capture', outcome: 'refused', code: 'op_unknown' },
    { kind: 'unknown', outcome: 'refused', code: 'op_unknown' },
    { kind: 'capture', outcome: 'refused', code: 'invalid_input' },
    { kind: 'capture', outcome: 'applied', code: null }]);
  assert.equal(calls.length, 1);
});

test('an entry without ops is invalid, and a Provider away fails the whole entry so it comes again', async (t) => {
  const { app, calls } = hostApp();
  app.recordKnowledgeUsage = async () => { throw new ProviderRequestError('Graphiti provider is unavailable.', { status: 0,
    code: 'provider_unavailable' }); };
  const { post } = await host(t, app);

  assert.equal((await post(RUNNER, RUNNER_PATHS.replay, entry('global-5', []))).status, 400);
  const away = await post(RUNNER, RUNNER_PATHS.replay, entry('global-6', [captureOp, usageOp]));
  assert.equal(away.status, 502);
  assert.equal(away.body.error, 'provider_unavailable');
  // Not kept as applied: the next delivery applies it again (each op is safe to apply twice).
  app.recordKnowledgeUsage = async () => ({ recorded_count: 1 });
  assert.equal((await post(RUNNER, RUNNER_PATHS.replay, entry('global-6', [captureOp, usageOp]))).status, 200);
  assert.equal(calls.filter(({ name }) => name === 'capture').length, 2);
});

test('recruit hands the follower\'s proposed FLA, occupation and origin to the hire, and says why it was not hired', async (t) => {
  const answers = [
    async () => ({ agent_id: 'synthetic-agent', status: 'created' }),
    async () => { throw new ProviderRequestError('Not Found', { status: 404, code: 'provider_error' }); },
    async () => { throw new ProviderRequestError('Agent name taken', { status: 409, code: 'agent_name_taken' }); },
    async () => { throw new ProviderRequestError('Agent id taken', { status: 409, code: 'agent_id_taken' }); }];
  const { app, calls } = hostApp({ hire: (input) => answers.shift()(input) });
  const { post } = await host(t, app);

  const outcomes = [];
  for (const id of ['recruit-1', 'recruit-2', 'recruit-3', 'recruit-4']) {
    outcomes.push((await post(RUNNER, RUNNER_PATHS.replay, entry(id, [recruitOp]))).body.result.ops[0]);
  }

  assert.deepEqual(calls[0].input, { personalSpaceId: SPACE, recruitmentId: 'synthetic-recruitment',
    agentId: 'synthetic-agent', profile: recruitOp.input.profile, occupation: recruitOp.input.occupation,
    reason: 'The project needs a lead', origin: { computer: 'Runner 0', project: 'Synthetic project' } });
  assert.deepEqual(outcomes.map(({ outcome, code }) => [outcome, code]),
    [['applied', null], ['refused', 'host_too_old'], ['refused', 'agent_name_taken'], ['refused', 'agent_id_taken']]);
});

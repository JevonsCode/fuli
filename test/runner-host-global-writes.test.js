import assert from 'node:assert/strict';
import test from 'node:test';

import { activeRunnerCaller } from '../src/app/agent-request-context.js';
import { GraphitiProviderClient, ProviderRequestError } from '../src/graphiti/provider-client.js';
import { applyGlobalWrites } from '../src/runner/host-global-writes.js';
import { createRunnerRoutes } from '../src/runner/host-routes.js';
import { GLOBAL_WRITES_ENTRY, RUNNER_PATHS } from '../src/runner/protocol.js';
import { pairedStore, serveRunnerRoutes } from '../test-support/runner-host-routes.js';

// A host applying a follower's writes to global, with a synthetic application
// in place of its Provider. Only fictional data.
const RUNNER = 'a'.repeat(64);
const STRANGER = 'c'.repeat(64);
const SPACE = 'synthetic-space';

// Items this host has: one of global, one of a project; one deleted for good
// (the Provider answers 410); any other id is not found.
const ITEM_SCOPES = { 'synthetic-item': 'global', 'synthetic-project-item': 'projects' };
const DELETED_ITEM = 'synthetic-deleted-item';

function hostApp({ hire = async () => ({ agent_id: 'synthetic-agent', status: 'created' }), capturing = true } = {}) {
  const calls = [];
  const note = (name, answer) => async (input) => {
    calls.push({ name, input, runner: activeRunnerCaller() });
    return answer(input);
  };
  const app = {
    config: { personal: { spaceId: SPACE } },
    getCapturePolicy: () => ({ enabled: capturing }),
    captureSessionKnowledge: note('capture', () => ({ route: 'personal', status: 'committed' })),
    checkpointProjectAgentMemory: note('agent_memory', (input) => {
      if (input.expectedRevision !== 4) {
        throw new ProviderRequestError('Agent memory revision changed', { status: 409, code: 'memory_revision_conflict' });
      }
      return { status: 'checkpointed' };
    }),
    recordKnowledgeUsage: note('knowledge_usage', () => ({ recorded_count: 1 })),
    personal: { hireForFollowerRecruitment: note('recruit', hire),
      readKnowledgeItemView: note('item_view', ({ itemId }) => {
        if (itemId === DELETED_ITEM) throw new ProviderRequestError('knowledge item deleted', { status: 410, code: 'provider_error' });
        if (!ITEM_SCOPES[itemId]) throw new ProviderRequestError('knowledge item not found', { status: 404, code: 'provider_error' });
        return { item_id: itemId, scope: { kind: ITEM_SCOPES[itemId], projects: [] } };
      }) }
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
  sourceApplication: 'codex', items: [{ itemId: 'synthetic-item', itemKind: 'entity', useKind: 'applied' }] } };
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
  assert.deepEqual(calls.map(({ name, runner }) => [name, runner]), [['capture', RUNNER], ['agent_memory', RUNNER],
    ['item_view', RUNNER], ['knowledge_usage', RUNNER], ['recruit', RUNNER]]);
  assert.deepEqual(leases, [`runner-replay:${GLOBAL_WRITES_ENTRY}`]);
  // Written to this computer's space, never into a project.
  assert.equal(calls[0].input.personalProjectId, null);
  assert.equal(calls[0].input.spaceId, SPACE);
  assert.deepEqual(calls[1].input, { personalSpaceId: SPACE, personalProjectId: null, agentId: 'synthetic-lead',
    expectedRevision: 3, idempotencyKey: 'synthetic-task:memory', memory: { summary: 'Synthetic memory' },
    sourceApplication: 'codex', sourceSessionId: 'synthetic-session' });
  assert.deepEqual(calls[3].input, { personalSpaceId: SPACE, taskId: 'synthetic-task', sessionId: 'synthetic-session',
    toolName: 'checkpoint_task_knowledge', items: usageOp.input.items });
});

test('an entry as large as a checkpoint may be is applied, not refused for its size', async (t) => {
  const { app, calls } = hostApp();
  const { post } = await host(t, app);
  // Far past the 64 KiB a local API route reads, within what one MCP request may carry.
  const entities = Array.from({ length: 120 }, (_, index) => ({ ...preference, key: `synthetic-preference-${index}`,
    summary: 'synthetic '.repeat(200) }));
  const large = { ...captureOp, input: { ...captureOp.input, entities } };
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 200 * 1024);

  const answer = await post(RUNNER, RUNNER_PATHS.replay, entry('global-large', [large]));

  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.result.ops, [{ kind: 'capture', outcome: 'applied', code: null }]);
  assert.equal(calls[0].input.entities.length, 120);
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
    async () => { throw new ProviderRequestError('Agent id taken', { status: 409, code: 'agent_id_taken' }); },
    async () => { throw new ProviderRequestError('Space not found', { status: 404, code: 'space_not_found' }); },
    ...[['temporary_task_required', 422], ['invalid_hire_profile', 422], ['agent_archived', 409]].map(
      ([code, status]) => async () => { throw new ProviderRequestError('Synthetic refusal', { status, code }); })];
  const { app, calls } = hostApp({ hire: (input) => answers.shift()(input) });
  const { post } = await host(t, app);

  const outcomes = [];
  for (const id of answers.map((_, index) => `recruit-${index}`)) {
    outcomes.push((await post(RUNNER, RUNNER_PATHS.replay, entry(id, [recruitOp]))).body.result.ops[0]);
  }

  assert.deepEqual(calls[0].input, { personalSpaceId: SPACE, recruitmentId: 'synthetic-recruitment',
    agentId: 'synthetic-agent', profile: recruitOp.input.profile, occupation: recruitOp.input.occupation,
    reason: 'The project needs a lead', origin: { computer: 'Runner 0', fingerprint: RUNNER,
      project: 'Synthetic project' } });
  assert.deepEqual(outcomes.map(({ outcome, code }) => [outcome, code]),
    [['applied', null], ['refused', 'host_too_old'], ['refused', 'agent_name_taken'], ['refused', 'agent_id_taken'],
      ['refused', 'space_not_found'], ['refused', 'temporary_task_required'], ['refused', 'invalid_hire_profile'],
      ['refused', 'agent_archived']]);
});

test('a use is recorded only for items of global this host still has; the others are named, never counted', async (t) => {
  const { app, calls } = hostApp();
  const { post } = await host(t, app);
  const items = [{ itemId: 'synthetic-item', itemKind: 'entity', useKind: 'applied' },
    { itemId: 'synthetic-item', itemKind: 'entity', useKind: 'referenced' },
    { itemId: 'synthetic-project-item', itemKind: 'entity', useKind: 'applied' },
    { itemId: 'synthetic-gone-item', itemKind: 'relationship', useKind: 'applied' }];

  const mixed = await post(RUNNER, RUNNER_PATHS.replay, entry('usage-1', [{ ...usageOp, input: { ...usageOp.input, items } }]));
  const none = await post(RUNNER, RUNNER_PATHS.replay, entry('usage-2', [{ ...usageOp, input: { ...usageOp.input,
    items: items.slice(2) } }]));

  assert.deepEqual(mixed.body.result.ops, [{ kind: 'knowledge_usage', outcome: 'applied', code: null, skipped: [
    { itemKind: 'entity', itemId: 'synthetic-project-item', reason: 'not_global' },
    { itemKind: 'relationship', itemId: 'synthetic-gone-item', reason: 'not_found' }] }]);
  assert.deepEqual(none.body.result.ops, [{ kind: 'knowledge_usage', outcome: 'refused', code: 'no_global_items', skipped: [
    { itemKind: 'entity', itemId: 'synthetic-project-item', reason: 'not_global' },
    { itemKind: 'relationship', itemId: 'synthetic-gone-item', reason: 'not_found' }] }]);
  const recorded = calls.filter(({ name }) => name === 'knowledge_usage');
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0].input.items, items.slice(0, 2));
  // One look per item, however many uses of it were reported.
  assert.equal(calls.filter(({ name }) => name === 'item_view').length, 5);
});

test('a use is not recorded while this host records nothing automatically for that client', async (t) => {
  const { app, calls } = hostApp({ capturing: false });
  const { post } = await host(t, app);

  const answer = await post(RUNNER, RUNNER_PATHS.replay, entry('usage-3', [usageOp]));

  assert.deepEqual(answer.body.result.ops, [{ kind: 'knowledge_usage', outcome: 'refused', code: 'capture_disabled' }]);
  assert.deepEqual(calls, []);
});

test('a recruitment with malformed ids, profile, occupation or text is refused as invalid before the hire', async (t) => {
  const { app, calls } = hostApp();
  const { post } = await host(t, app);
  const bad = [{ recruitmentId: '' }, { recruitmentId: 'x'.repeat(129) }, { proposedAgentId: 'x'.repeat(129) },
    { profile: { agent_type: 'temporary' } }, { taskId: '' }, { taskId: '   ' }, { taskId: 42 },
    { taskId: 'x'.repeat(129) }, { profile: 'Synthetic' }, { profile: { notes: 'x'.repeat(17 * 1024) } }, { occupation: ['synthetic_role'] },
    { reason: 'x'.repeat(2001) }, { reason: undefined }, { reason: ' \u0007\n ' }, { projectName: 42 },
    { projectName: null }, { projectName: '\u0001\t' }];

  const answer = await post(RUNNER, RUNNER_PATHS.replay, entry('recruit-bad', [
    ...bad.map(change => ({ ...recruitOp, input: { ...recruitOp.input, ...change } })),
    { ...recruitOp, input: { ...recruitOp.input, projectName: 'Synthetic\u0007\nproject', reason: ' The\tproject  needs a lead ' } }]));

  assert.deepEqual(answer.body.result.ops.map(({ outcome, code }) => [outcome, code]),
    [...bad.map(() => ['refused', 'invalid_input']), ['applied', null]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.origin.project, 'Synthetic project');
  assert.equal(calls[0].input.reason, 'The project needs a lead');
});

test('a use of an item deleted for good is named as not found; the uses of the others are still recorded', async (t) => {
  const { app, calls } = hostApp();
  const { post } = await host(t, app);
  const items = [{ itemId: 'synthetic-item', itemKind: 'entity', useKind: 'applied' },
    { itemId: DELETED_ITEM, itemKind: 'entity', useKind: 'applied' }];

  const answer = await post(RUNNER, RUNNER_PATHS.replay, entry('usage-deleted', [{ ...usageOp,
    input: { ...usageOp.input, items } }]));

  assert.deepEqual(answer.body.result.ops, [{ kind: 'knowledge_usage', outcome: 'applied', code: null, skipped: [
    { itemKind: 'entity', itemId: DELETED_ITEM, reason: 'not_found' }] }]);
  assert.deepEqual(calls.find(({ name }) => name === 'knowledge_usage').input.items, items.slice(0, 1));
});

test('an entry larger than one MCP request is refused whole (413), never cut short or applied', async (t) => {
  const { app, calls } = hostApp();
  const { post } = await host(t, app);
  const large = { ...captureOp, input: { ...captureOp.input, entities: [{ ...preference,
    summary: 'synthetic '.repeat(110 * 1024) }] } };
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 1024 * 1024);

  const answer = await post(RUNNER, RUNNER_PATHS.replay, entry('global-too-large', [large]));

  assert.equal(answer.status, 413);
  assert.deepEqual(calls, []);
});

// The Provider's owner-hire request, copied from
// graph-provider/fuli_graph/owner_hire.py (OwnerHireRequest): change this table
// when that model changes. Every field is listed; the model forbids others.
const OWNER_HIRE_REQUEST = {
  personal_space_id: { required: true, minLength: 1, maxLength: 128 },
  recruitment_id: { required: true, minLength: 1, maxLength: 128 },
  agent_id: { required: true, minLength: 1, maxLength: 128 },
  task_id: { requiredFor: 'temporary', nullable: true, minLength: 1, maxLength: 128 },
  recruitment_source_application: { nullable: true, choices: [
    'codex', 'claude', 'claude_code', 'cursor', 'kiro', 'opencode', 'antigravity', 'dsh', 'other'] },
  profile: { required: true, object: true },
  occupation: { required: true, object: true },
  reason: { required: true, minLength: 1, maxLength: 2048 },
  origin_computer: { required: true, minLength: 1, maxLength: 128 },
  origin_project: { required: true, minLength: 1, maxLength: 256 },
  origin_fingerprint: { required: false, nullable: true, pattern: /^[0-9a-f]{64}$/ }
};

function assertOwnerHireRequest(body) {
  assert.deepEqual(Object.keys(body).filter((key) => !Object.hasOwn(OWNER_HIRE_REQUEST, key)), []);
  for (const [field, rule] of Object.entries(OWNER_HIRE_REQUEST)) {
    const value = body[field];
    if (value === undefined || (value === null && rule.nullable)) {
      assert.ok(!rule.required && !(rule.requiredFor && body.profile.agent_type === rule.requiredFor), `${field} is required`);
      continue;
    }
    if (rule.object) {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${field} is an object`);
      continue;
    }
    assert.equal(typeof value, 'string', `${field} is text`);
    if (rule.minLength) assert.ok([...value].length >= rule.minLength, `${field} at least ${rule.minLength}`);
    if (rule.maxLength) assert.ok([...value].length <= rule.maxLength, `${field} at most ${rule.maxLength}`);
    if (rule.choices) assert.ok(rule.choices.includes(value));
    if (rule.pattern) assert.match(value, rule.pattern, `${field} matches`);
  }
}

test('the hire this host sends meets every constraint of the Provider\'s owner-hire request', async () => {
  const bodies = [];
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ outcome: 'created' }), { status: 200, headers: { 'content-type': 'application/json' } }); } });
  const app = { config: { personal: { spaceId: SPACE } }, personal: client };
  const longest = { ...recruitOp, input: { ...recruitOp.input, taskId: '🧪'.repeat(128),
    profile: { ...recruitOp.input.profile, agent_type: 'temporary' }, recruitmentSourceApplication: 'claude_code',
    recruitmentId: 'r'.repeat(128), proposedAgentId: 'g'.repeat(128),
    reason: 'x'.repeat(2000), projectName: 'p'.repeat(200) } };

  for (const [op, runner] of [[recruitOp, { fingerprint: RUNNER, name: 'Runner 0' }],
    [longest, { fingerprint: RUNNER, name: 'n'.repeat(300) }], [recruitOp, { fingerprint: RUNNER, name: '' }],
    [{ ...recruitOp, input: { ...recruitOp.input, recruitmentSourceApplication: 'unknown' } }, { fingerprint: RUNNER, name: null }]]) {
    assert.deepEqual((await applyGlobalWrites(app, { ops: [op] }, runner)).ops,
      [{ kind: 'recruit', outcome: 'applied', code: null }]);
  }

  assert.equal(bodies.length, 4);
  assert.equal(bodies[1].task_id, longest.input.taskId);
  assert.equal(bodies[1].recruitment_source_application, 'claude_code');
  assert.equal(Object.hasOwn(bodies[3], 'recruitment_source_application'), false);
  for (const body of bodies) assertOwnerHireRequest(body);
  // The whole fingerprint, and it names a computer paired without a name.
  assert.deepEqual(bodies.map((body) => [body.origin_computer, body.origin_fingerprint]), [['Runner 0', RUNNER],
    ['n'.repeat(128), RUNNER], [RUNNER.slice(0, 16), RUNNER], [RUNNER.slice(0, 16), RUNNER]]);
});

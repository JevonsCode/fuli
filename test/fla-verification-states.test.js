import assert from 'node:assert/strict';
import test from 'node:test';
import { getAgentGrowth } from '../src/graphiti/agent-growth.js';
import { taskVerification } from '../src/fla-growth/task-verification.js';
import { verificationOf } from '../src/fla-growth/verification.js';
import { createJudgmentService } from '../src/judgment/service.js';
import { JudgmentStore } from '../src/judgment/store.js';
import { RecallImpressionsStore, taskKeyFor } from '../src/knowledge-impressions/store.js';

const SPACE = 'space';
const config = { personal: { spaceId: SPACE } };
const attempt = (id, refs = ['ci://synthetic/run-1']) => ({ attempt_id: id, outcome: 'pass', artifact_revision: 'rev-1',
  evidence_refs: refs, verifier_id: 'verifier-1' });
// An independent Tonborg acceptance as acceptance.js records it.
const acceptance = (store, { key, taskId, token, outcome = 'approve', verification = attempt(`a-${key}`) }) =>
  store.record(SPACE, { personalProjectId: 'app', kind: 'acceptance', target: taskId, agentId: 'lead-1', outcome,
    artifactRevision: 'rev-1', verification, judgedBy: { independent: true }, ...(token ? { taskKey: taskKeyFor(token) } : {}) }, key);

function judgment(store) {
  return createJudgmentService({ app: { config }, openStore: () => store });
}

test('the strongest recorded state wins; evidence without a record never counts', () => {
  assert.deepEqual(verificationOf([]), { state: 'unverified', evidence: [] });
  const mixed = verificationOf([{ state: 'ai_assessed', ref: 'd1' }, { state: 'auto_verified', ref: 'a1' },
    { state: 'auto_verified', ref: 'a1' }, { state: 'person_confirmed', ref: null }, { state: 'verified', ref: 'x' }]);
  assert.equal(mixed.state, 'auto_verified');
  assert.deepEqual(mixed.evidence.map(entry => entry.ref), ['d1', 'a1']);
  assert.equal(verificationOf([{ state: 'ai_assessed', ref: 'd1' }, { state: 'person_confirmed', ref: 'k' }]).state, 'person_confirmed');
});

test('a learned experience is verified only by the person keeping it or a judged task that applied it', async () => {
  const store = new JudgmentStore();
  const impressions = new RecallImpressionsStore();
  const shown = token => impressions.recordShown({ taskContextToken: token, personalSpaceId: SPACE, personalProjectId: 'app',
    facts: [], entities: [{ id: 'tested' }, { id: 'disputed' }, { id: 'unjudged' }] });
  for (const token of ['task-a', 'task-b', 'task-c']) shown(token);
  impressions.markUsed({ taskContextToken: 'task-a', items: [{ itemKind: 'entity', itemId: 'tested', useKind: 'applied' }] });
  impressions.markUsed({ taskContextToken: 'task-b', items: [{ itemKind: 'entity', itemId: 'disputed', useKind: 'applied' }] });
  // Cited (read, not applied) is no outcome signal for the experience.
  impressions.markUsed({ taskContextToken: 'task-c', items: [{ itemKind: 'entity', itemId: 'unjudged', useKind: 'cited' }] });
  acceptance(store, { key: 'k-a', taskId: 'task-1', token: 'task-a' });
  const disputed = acceptance(store, { key: 'k-b', taskId: 'task-2', token: 'task-b' });
  store.feedback(SPACE, disputed.id, 'down', 'synthetic: the person disagreed', 0);
  acceptance(store, { key: 'k-c', taskId: 'task-3', token: 'task-c' });

  const node = (id, overrides = {}) => ({ id, name: id, type: 'ReusableExperience', attributes: { solution: 'x' },
    confirmation_status: 'pending', confirmation_basis: { proposed_by: { kind: 'agent', label: 'lead-1' } }, ...overrides });
  const app = { config, judgment: judgment(store), recallImpressions: impressions,
    listProjectAgents: async () => [{ agentId: 'lead-1', assignments: [{ personalProjectId: 'app', status: 'active' }] }],
    personal: { graph: async () => ({ edges: [], nodes: [node('tested'), node('disputed'), node('unjudged'),
      node('kept', { confirmation_status: 'confirmed', confirmation_basis: { proposed_by: { kind: 'agent', label: 'lead-1' },
        confirmed_at: '2026-11-06T00:00:00Z' } })] }) } };
  const growth = await getAgentGrowth(app, { personalSpaceId: SPACE, agentId: 'lead-1' });
  const states = Object.fromEntries(growth.items.map(item => [item.itemId, item.verification]));
  assert.equal(states.tested.state, 'auto_verified');
  assert.deepEqual(states.tested.evidence.map(entry => entry.state), ['auto_verified', 'ai_assessed']);
  assert.deepEqual(states.tested.evidence[0].refs, ['ci://synthetic/run-1']);
  // The person's thumbs-down disputes Tonborg; the verifier's tests still stand.
  assert.deepEqual(states.disputed.evidence.map(entry => entry.state), ['auto_verified']);
  assert.equal(states.unjudged.state, 'unverified');
  assert.equal(states.kept.state, 'person_confirmed');
  assert.equal(states.kept.evidence[0].at, '2026-11-06T00:00:00Z');
  store.close();
});

test('a task outcome shows its gate evidence, Tonborg acceptance and the person, and nothing else', async () => {
  const store = new JudgmentStore();
  acceptance(store, { key: 'k-1', taskId: 'task-1' });
  // Self-assessed (not independent) and escalated verdicts are no AI pass.
  store.record(SPACE, { personalProjectId: 'app', kind: 'acceptance', target: 'task-1', outcome: 'approve',
    artifactRevision: 'rev-1', verification: attempt('a-self'), judgedBy: { independent: false } }, 'k-self');
  const tasks = {
    'task-1': { taskId: 'task-1', personalProjectId: 'app', qualityGate: 'passed', verifiedArtifactRevision: 'rev-1', events: [] },
    'task-2': { taskId: 'task-2', personalProjectId: 'app', qualityGate: 'passed', verifiedArtifactRevision: 'rev-9',
      events: [{ eventId: 'e1', actorKind: 'human', status: 'completed', createdAt: '2026-11-06T01:00:00Z' },
        { eventId: 'e2', actorKind: 'agent', status: 'completed' }] },
    'task-3': { taskId: 'task-3', personalProjectId: 'app', qualityGate: 'failed', verifiedArtifactRevision: 'rev-1', events: [] }
  };
  const gates = [];
  const app = { config, judgment: judgment(store),
    viewProjectAgentTask: async ({ taskId }) => tasks[taskId],
    agentVerification: async (operation, input) => {
      gates.push([operation, input.taskId, input.artifactRevision]);
      // rev-9 passed without evidence refs: not shown as automatically verified.
      return input.artifactRevision === 'rev-9' ? { status: 'passed', verified_attempt: { ...attempt('g9'), evidence_refs: [] } }
        : { status: 'passed', verified_attempt: attempt('g1', ['ci://synthetic/gate']) };
    } };
  const read = taskId => taskVerification(app, { personalSpaceId: SPACE, personalProjectId: 'app', taskId });
  const first = await read('task-1');
  assert.equal(first.state, 'auto_verified');
  assert.deepEqual(first.evidence.map(entry => `${entry.state}:${entry.ref}`).sort(),
    ['ai_assessed:' + first.evidence.find(entry => entry.source === 'tonborg').ref, 'auto_verified:a-k-1', 'auto_verified:g1'].sort());
  const second = await read('task-2');
  assert.deepEqual(second.evidence.map(entry => entry.state), ['person_confirmed']);
  assert.equal((await read('task-3')).state, 'unverified');
  assert.deepEqual(gates, [['query', 'task-1', 'rev-1'], ['query', 'task-2', 'rev-9']], 'a failed gate is not queried');
  store.close();
});

test('the console route answers a task\'s verification state', async () => {
  const { handleGraphApiRequest } = await import('../src/http/graph-api-router.js');
  const app = { config, viewProjectAgentTask: async () => ({ taskId: 't', events: [] }) };
  let status; let body;
  const response = { writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } };
  const handled = await handleGraphApiRequest({ request: { method: 'GET' }, response, app, ownerReads: null,
    url: new URL('http://127.0.0.1/api/project-agent-tasks/t/verification?personalSpaceId=space&personalProjectId=app') });
  assert.deepEqual([handled, status, body], [true, 200, { taskId: 't', state: 'unverified', evidence: [] }]);
});

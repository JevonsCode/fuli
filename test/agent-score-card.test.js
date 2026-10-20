import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { callAgentTool, listAgentTools } from '../src/agent-tools.js';
import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';
import { createJudgmentEngine } from '../src/judgment/engine.js';
import { createJudgmentService } from '../src/judgment/service.js';
import { annotationsFor } from '../src/mcp/tool-annotations.js';

// Synthetic data and an HTTP Provider double only.
const SPACE = 'test-space';
const AGENT = 'engineer-x';
const config = { version: 1, workspaces: [],
  personal: { providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-provider-token', principalId: 'test-person', spaceId: SPACE } };

function providerCard(query) {
  return {
    personal_space_id: query.personal_space_id, agent_id: query.agent_id,
    personal_project_ids: query.personal_project_ids, minimum_sample: 3,
    dimensions: {
      completion: { status: 'scored', sample: 8, passed: 4, rate: 0.5, tier: { label: 'B', evidence_count: 8 }, label: null },
      first_pass: { status: 'scored', sample: 4, passed: 4, rate: 1, tier: { label: 'S', evidence_count: 4 }, label: null },
      user_feedback: { status: 'insufficient_data', sample: 1, passed: null, rate: null, tier: null, label: '数据不足' },
      review: { status: 'insufficient_data', sample: 2, passed: null, rate: null, tier: null, label: '数据不足' }
    },
    executors: [{ executor_id: 'executor-a', evidence_count: 8 }, { executor_id: 'executor-b', evidence_count: 4 }],
    tool_flags: [{ dimension: 'completion', executor_id: 'executor-b', rate: 0, sample: 4,
      compared_executor_id: 'executor-a', compared_rate: 1, compared_sample: 4, suggestion: 'change_executor_or_model' }],
    disputed_review_count: 1, stale_review_count: 2, as_of: '2026-10-20T08:00:00Z'
  };
}

function providerEvidence(query) {
  return { personal_space_id: query.personal_space_id, agent_id: query.agent_id,
    personal_project_ids: query.personal_project_ids, dimension: query.dimension, executor_id: query.executor_id,
    passed: { count: 4, task_ids: ['task-4', 'task-3'] }, not_passed: { count: 0, task_ids: [] }, truncated: true };
}

function provider() {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ method: options.method ?? 'GET', path: target.pathname, body });
    if (target.pathname === '/v1/project-agent-score-card/query') return Response.json(providerCard(body));
    if (target.pathname === '/v1/project-agent-score-card/evidence') return Response.json(providerEvidence(body));
    return Response.json({ detail: 'not found' }, { status: 404 });
  };
  return { fetchImpl, requests };
}

function application(t) {
  const double = provider();
  const app = new FederatedGraphApplication(config, { fetchImpl: double.fetchImpl });
  const modelCalls = [];
  const judge = async (request) => { modelCalls.push(request); throw new Error('the score card must not call a model'); };
  app.judgment = createJudgmentService({ app, engine: createJudgmentEngine({ app, judge }) });
  t.after(() => app.judgment.close());
  return { app, double, modelCalls, store: app.judgment.store() };
}

// The artifact and verification attempt a verdict judged; the Provider checks they are current.
const judged = key => ({ artifact_revision: `artifact-${key}`, verification_attempt_id: `attempt-${key}` });

// Records shaped as Tonborg's acceptance writes them (see judgment-acceptance tests).
function seedTonborg(store) {
  const verdict = (key, values) => store.record(SPACE, { personalProjectId: 'project-a', kind: 'acceptance',
    target: 'task-1', agentId: AGENT, outcome: 'approve', summary: 'Verified.', evidence: ['test-report'],
    artifactRevision: `artifact-${key}`, verification: { attempt_id: `attempt-${key}` }, client: 'codex', ...values }, key);
  const confirmed = verdict('accept-1', {});
  store.feedback(SPACE, confirmed.id, 'up', '', 0);
  store.feedback(SPACE, verdict('accept-2', { target: 'task-2', outcome: 'escalate' }).id, 'down', 'Too strict', 0);
  verdict('accept-3', { target: 'task-3', outcome: 'escalate', client: null });
  verdict('accept-4', { target: 'task-4', agentId: 'someone-else' });
  store.execute(SPACE, verdict('accept-5', { target: 'task-5' }).id, 'stale', { reason: 'Evidence changed' });
  verdict('accept-6', { target: 'task-6', outcome: 'failed', client: null });
  verdict('accept-7', { target: 'task-7', outcome: 'escalate' });
  verdict('accept-8', { target: 'task-8', personalProjectId: 'project-b' });
  verdict('accept-9', { target: 'task-9', artifactRevision: undefined });
  store.record(SPACE, { personalProjectId: 'project-a', kind: 'routing', target: 'subagent', agentId: AGENT,
    outcome: 'recommend', client: 'codex' }, 'routing-1');
  return store.records(SPACE, { limit: 100 }).length;
}

test('Bole reads a zero-token score card: recorded outcomes plus Tonborg verdicts, no model call', async t => {
  const { app, double, modelCalls, store } = application(t);
  const judgments = seedTonborg(store);

  const card = await callAgentTool(app, 'get_agent_score_card', { personalSpaceId: SPACE, agentId: AGENT });

  assert.deepEqual(double.requests.map(({ method, path }) => `${method} ${path}`), ['POST /v1/project-agent-score-card/query']);
  const [{ body }] = double.requests;
  assert.deepEqual({ ...body, review_verdicts: body.review_verdicts.map(({ occurred_at, ...verdict }) => verdict) }, {
    personal_space_id: SPACE, agent_id: AGENT, personal_project_ids: null,
    review_verdicts: [
      { task_id: 'task-1', personal_project_id: 'project-a', result: 'passed', ...judged('accept-1') },
      { task_id: 'task-2', personal_project_id: 'project-a', result: 'disputed', ...judged('accept-2') },
      { task_id: 'task-7', personal_project_id: 'project-a', result: 'not_passed', ...judged('accept-7') },
      { task_id: 'task-8', personal_project_id: 'project-b', result: 'passed', ...judged('accept-8') }
    ]
  });
  assert.ok(body.review_verdicts.every(({ occurred_at }) => !Number.isNaN(Date.parse(occurred_at))));
  assert.deepEqual(card.dimensions, {
    completion: { status: 'scored', sample: 8, passed: 4, rate: 0.5, tier: { label: 'B', evidenceCount: 8 } },
    firstPass: { status: 'scored', sample: 4, passed: 4, rate: 1, tier: { label: 'S', evidenceCount: 4 } },
    userFeedback: { status: 'insufficient_data', sample: 1, label: '数据不足' },
    review: { status: 'insufficient_data', sample: 2, label: '数据不足' }
  });
  assert.deepEqual(card.toolFlags, [{ dimension: 'completion', executorId: 'executor-b', rate: 0, sample: 4,
    comparedExecutorId: 'executor-a', comparedRate: 1, comparedSample: 4, suggestion: 'change_executor_or_model' }]);
  assert.deepEqual(card.executors, [{ executorId: 'executor-a', evidenceCount: 8 }, { executorId: 'executor-b', evidenceCount: 4 }]);
  assert.deepEqual([card.disputedReviewCount, card.staleReviewCount], [1, 2]);
  assert.equal(card.minimumSample, 3);
  assert.deepEqual(card.evidence, { tool: 'get_agent_score_card', addArgument: 'dimension', arguments: { personalSpaceId: SPACE, agentId: AGENT } });
  assert.equal(['total', 'overall', 'score'].some(key => key in card), false);
  assert.deepEqual(modelCalls, []);
  assert.equal(store.records(SPACE, { limit: 100 }).length, judgments, 'reading the card records no judgment');
});

test('a project-scoped card and its drill-down carry only that project and the requested dimension', async t => {
  const { app, double } = application(t);
  seedTonborg(app.judgment.store());

  const card = await callAgentTool(app, 'get_agent_score_card', { personalSpaceId: SPACE, agentId: AGENT, personalProjectId: 'project-a' });
  assert.deepEqual(double.requests[0].body.personal_project_ids, ['project-a']);
  assert.deepEqual(double.requests[0].body.review_verdicts.map(({ task_id }) => task_id), ['task-1', 'task-2', 'task-7']);
  assert.deepEqual(card.evidence.arguments, { personalSpaceId: SPACE, agentId: AGENT, personalProjectId: 'project-a' });

  const evidence = await callAgentTool(app, 'get_agent_score_card', { personalSpaceId: SPACE, agentId: AGENT,
    personalProjectId: 'project-a', dimension: 'firstPass', executorId: 'executor-a', limit: 2 });
  const { body } = double.requests[1];
  assert.equal(double.requests[1].path, '/v1/project-agent-score-card/evidence');
  assert.deepEqual([body.dimension, body.executor_id, body.limit, body.personal_project_ids], ['first_pass', 'executor-a', 2, ['project-a']]);
  assert.deepEqual(evidence, { personalSpaceId: SPACE, agentId: AGENT, personalProjectIds: ['project-a'],
    dimension: 'firstPass', executorId: 'executor-a', passed: { count: 4, taskIds: ['task-4', 'task-3'] },
    notPassed: { count: 0, taskIds: [] }, truncated: true });

  await assert.rejects(callAgentTool(app, 'get_agent_score_card', { personalSpaceId: 'other-space', agentId: AGENT }));
  assert.equal(double.requests.length, 2, 'another space never reaches the Provider');
});

test('the score card tool is a read inside Bole\'s existing read permissions', () => {
  const tool = listAgentTools().find(({ name }) => name === 'get_agent_score_card');
  assert.match(tool.title, /^READ · Bole/);
  const annotations = annotationsFor('get_agent_score_card');
  assert.deepEqual([annotations.readOnlyHint, annotations.destructiveHint], [true, false]);
  assert.match(tool.description, /数据不足/);
  assert.match(tool.description, /never grounds for automatic action/);
  assert.deepEqual(tool.inputSchema.required, ['personalSpaceId', 'agentId']);
  assert.deepEqual(tool.inputSchema.properties.dimension.enum, ['completion', 'firstPass', 'userFeedback', 'review']);
  const bole = JSON.parse(readFileSync(new URL('../src/employees/catalog/bole.json', import.meta.url), 'utf8'));
  assert.ok(['agents.read', 'tasks.read'].every(permission => bole.permissions.includes(permission)));
  const workflow = agentInterfaceCatalog().readWorkflows.find(({ toolNames }) => toolNames.includes('get_agent_score_card'));
  assert.deepEqual(workflow.toolNames, ['get_agent_score_card']);
  assert.deepEqual(workflow.readRoutes, ['GET /api/project-agents/:agentId/score-card', 'GET /api/project-agents/:agentId/score-card/evidence']);
});

test('the local HTTP API serves the same card and drill-down for a later UI', async t => {
  const { app, double, modelCalls } = application(t);
  const get = async (path) => {
    let status; let body;
    const response = { writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } };
    const handled = await handleGraphApiRequest({ request: { method: 'GET' }, response, url: new URL(`http://127.0.0.1${path}`), app });
    return { handled, status, body };
  };

  const card = await get(`/api/project-agents/${AGENT}/score-card?personalSpaceId=${SPACE}&personalProjectId=project-a`);
  assert.deepEqual([card.handled, card.status, card.body.dimensions.completion.rate], [true, 200, 0.5]);
  assert.deepEqual(double.requests[0].body.personal_project_ids, ['project-a']);
  const evidence = await get(`/api/project-agents/${AGENT}/score-card/evidence?personalSpaceId=${SPACE}&dimension=review&limit=5`);
  assert.deepEqual([evidence.status, evidence.body.dimension, evidence.body.passed.taskIds], [200, 'review', ['task-4', 'task-3']]);
  assert.deepEqual([double.requests[1].body.dimension, double.requests[1].body.limit, double.requests[1].body.personal_project_ids],
    ['review', 5, null]);
  await assert.rejects(get(`/api/project-agents/${AGENT}/score-card/evidence?personalSpaceId=${SPACE}&dimension=total`), TypeError);
  await assert.rejects(get(`/api/project-agents/${AGENT}/score-card/evidence?personalSpaceId=${SPACE}&dimension=review&limit=0`), TypeError);
  assert.equal(double.requests.length, 2, 'invalid drill-downs never reach the Provider');
  assert.deepEqual(modelCalls, []);
});

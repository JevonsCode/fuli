import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { callAgentTool, listAgentTools } from '../src/agent-tools.js';
import { createAgentWorkflows } from '../src/agent-workflows/port.js';
import { inspectLocalStores } from '../src/data-format/local-stores.js';
import { handleAgentWorkflowsRequest } from '../src/http/agent-workflows-api-router.js';
import { mapHttpError } from '../src/http/error-mapping.js';

// rec#60 D-78: an Agent's own workflows. Synthetic spaces, Agents and steps
// only; no real FULI data directory is read.

const OWNER = Object.freeze({ personalSpaceId: 'space-a', agentId: 'fla-builder', personalProjectId: 'project-a' });
const OTHER = Object.freeze({ ...OWNER, agentId: 'fla-other' });
const STEPS = [{ title: 'Read the synthetic issue' }, { title: 'Run the focused tests', detail: 'node --test the touched files' }];

function workflowsIn(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-agent-workflows-'));
  const path = join(directory, 'agent-workflows.sqlite');
  let tick = 0;
  const workflows = createAgentWorkflows({ path, now: () => new Date(Date.UTC(2026, 9, 31, 0, 0, tick++)), ...options });
  t.after(() => { workflows.close(); rmSync(directory, { recursive: true, force: true }); });
  return { workflows, path, directory };
}

const proposal = (overrides = {}) => ({ name: 'Synthetic release check', purpose: 'Check a synthetic build before release',
  steps: STEPS, source: 'agent', ...overrides });

test('a proposal waits for the person; only a confirmed version is read and run', (t) => {
  const { workflows } = workflowsIn(t);
  const { status, workflow } = workflows.propose(OWNER, proposal());
  assert.equal(status, 'proposed');
  assert.deepEqual([workflow.status, workflow.stepCount, workflow.awaitingPerson, workflow.lastRun],
    ['proposed', 2, true, null]);
  assert.ok(workflow.approxTokens > 0);
  assert.throws(() => workflows.read(OWNER, { workflowId: workflow.workflowId }), { code: 'workflow_not_active' });
  assert.throws(() => workflows.recordRun(OWNER, { workflowId: workflow.workflowId, outcome: 'done' }), { code: 'workflow_not_active' });

  assert.equal(workflows.decide({ personalSpaceId: 'space-a', workflowId: workflow.workflowId, decision: 'confirm', version: 1 }).status, 'confirmed');
  const read = workflows.read(OWNER, { workflowId: workflow.workflowId });
  assert.deepEqual([read.version, read.steps], [1, STEPS]);
  const { run } = workflows.recordRun(OWNER, { workflowId: workflow.workflowId, taskId: 'task-1', outcome: 'done', note: 'Synthetic' });
  assert.deepEqual([run.version, run.taskId, run.outcome], [1, 'task-1', 'done']);
  assert.equal(workflows.index(OWNER).workflows[0].lastRun.outcome, 'done');
});

test('every change is a new version; the old one stays and stays active until the person confirms', (t) => {
  const { workflows, path } = workflowsIn(t);
  const { workflow } = workflows.propose(OWNER, proposal());
  workflows.decide({ personalSpaceId: 'space-a', workflowId: workflow.workflowId, decision: 'confirm', version: 1 });
  assert.equal(workflows.propose(OWNER, { ...proposal(), workflowId: workflow.workflowId }).status, 'unchanged');

  const changed = [...STEPS, { title: 'Write the synthetic report' }];
  assert.equal(workflows.propose(OWNER, proposal({ workflowId: workflow.workflowId, steps: changed })).workflow.awaitingPerson, true);
  assert.equal(workflows.read(OWNER, { workflowId: workflow.workflowId }).version, 1, 'the confirmed version is still the one read');
  assert.equal(workflows.decide({ personalSpaceId: 'space-a', workflowId: workflow.workflowId, decision: 'reject', version: 2 }).workflow.status,
    'active', 'rejecting a change keeps the active version');
  workflows.propose(OWNER, proposal({ workflowId: workflow.workflowId, steps: changed, name: 'Synthetic release check v3' }));
  workflows.decide({ personalSpaceId: 'space-a', workflowId: workflow.workflowId, decision: 'confirm', version: 3 });
  assert.equal(workflows.read(OWNER, { workflowId: workflow.workflowId }).steps.length, 3);

  const [view] = workflows.overview({ personalSpaceId: 'space-a', agentId: 'fla-builder' }).workflows;
  assert.deepEqual([view.versionCount, view.active.version, view.pending], [3, 3, null]);
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(database.prepare('SELECT version, created_by FROM agent_workflow_versions ORDER BY version').all()
      .map((row) => [row.version, row.created_by]), [[1, 'agent'], [2, 'agent'], [3, 'agent']]);
    assert.deepEqual(database.prepare('SELECT version, decision, decided_by FROM agent_workflow_decisions ORDER BY rowid').all()
      .map((row) => [row.version, row.decision, row.decided_by]), [[1, 'confirm', 'person'], [2, 'reject', 'person'], [3, 'confirm', 'person']]);
  } finally { database.close(); }
});

test('versions, decisions and runs are immutable', (t) => {
  const { workflows, path } = workflowsIn(t);
  const { workflow } = workflows.propose(OWNER, proposal());
  workflows.decide({ personalSpaceId: 'space-a', workflowId: workflow.workflowId, decision: 'confirm', version: 1 });
  workflows.recordRun(OWNER, { workflowId: workflow.workflowId, outcome: 'failed' });
  workflows.close();
  const database = new DatabaseSync(path);
  try {
    for (const table of ['agent_workflow_versions', 'agent_workflow_decisions', 'agent_workflow_runs']) {
      assert.throws(() => database.exec(`UPDATE ${table} SET version = 9`), /immutable/, table);
      assert.throws(() => database.exec(`DELETE FROM ${table}`), /immutable/, table);
    }
  } finally { database.close(); }
});

test('the person decides only at the version shown; reject of a new proposal and retire end it', (t) => {
  const { workflows } = workflowsIn(t);
  const first = workflows.propose(OWNER, proposal()).workflow;
  assert.throws(() => workflows.decide({ personalSpaceId: 'space-a', workflowId: first.workflowId, decision: 'confirm', version: 2 }),
    { code: 'version_conflict' });
  assert.throws(() => workflows.decide({ personalSpaceId: 'space-b', workflowId: first.workflowId, decision: 'confirm', version: 1 }),
    { code: 'workflow_not_found' });
  assert.throws(() => workflows.decide({ personalSpaceId: 'space-a', workflowId: first.workflowId, decision: 'activate', version: 1 }),
    { code: 'invalid_input' });
  assert.equal(workflows.decide({ personalSpaceId: 'space-a', workflowId: first.workflowId, decision: 'reject', version: 1 }).workflow.status, 'retired');
  assert.deepEqual(workflows.index(OWNER).workflows, [], 'a retired workflow leaves the Agent\'s index');

  const second = workflows.propose(OWNER, proposal({ name: 'Second synthetic flow' })).workflow;
  workflows.decide({ personalSpaceId: 'space-a', workflowId: second.workflowId, decision: 'confirm', version: 1 });
  assert.throws(() => workflows.decide({ personalSpaceId: 'space-a', workflowId: second.workflowId, decision: 'confirm', version: 1 }),
    { code: 'version_conflict' }, 'nothing waits any more');
  assert.equal(workflows.decide({ personalSpaceId: 'space-a', workflowId: second.workflowId, decision: 'retire', version: 1 }).workflow.status, 'retired');
  assert.throws(() => workflows.read(OWNER, { workflowId: second.workflowId }), { code: 'workflow_not_active' });
  assert.equal(workflows.propose(OWNER, proposal({ workflowId: second.workflowId, name: 'Second synthetic flow' })).workflow.status,
    'proposed', 'a retired workflow proposed again waits once more');
});

test('an Agent sees only its own workflows; sizes are bounded', (t) => {
  const { workflows } = workflowsIn(t);
  const { workflow } = workflows.propose(OWNER, proposal());
  assert.throws(() => workflows.read(OTHER, { workflowId: workflow.workflowId }), { code: 'workflow_not_found' });
  assert.throws(() => workflows.propose(OTHER, proposal({ workflowId: workflow.workflowId })), { code: 'workflow_not_found' });
  assert.deepEqual(workflows.index(OTHER).workflows, []);
  const tooMany = Array.from({ length: 21 }, (_, index) => ({ title: `Synthetic step ${index}` }));
  assert.throws(() => workflows.propose(OWNER, proposal({ steps: tooMany })), { code: 'invalid_input' });
  assert.throws(() => workflows.propose(OWNER, proposal({ steps: [] })), { code: 'invalid_input' });
  assert.throws(() => workflows.propose(OWNER, proposal({ name: 'x'.repeat(81) })), { code: 'invalid_input' });
  assert.throws(() => workflows.propose(OWNER, proposal({ steps: [{ title: 'ok', detail: 'x'.repeat(601) }] })), { code: 'invalid_input' });
  for (let index = 1; index < 50; index++) workflows.propose(OWNER, proposal({ name: `Synthetic flow ${index}` }));
  assert.throws(() => workflows.propose(OWNER, proposal({ name: 'One too many' })), { code: 'workflow_limit' });
});

test('a missing store reads as no workflows and is never created by a read', (t) => {
  const { workflows, directory } = workflowsIn(t);
  assert.deepEqual(workflows.index(OWNER), { workflows: [] });
  assert.deepEqual(workflows.overview({ personalSpaceId: 'space-a', agentId: 'fla-builder' }), { workflows: [] });
  assert.equal(inspectLocalStores(directory).find(({ label }) => label === 'agent-workflows.sqlite').state, 'absent');
  workflows.propose(OWNER, proposal());
  assert.equal(inspectLocalStores(directory).find(({ label }) => label === 'agent-workflows.sqlite').state, 'current');
});

function toolApp(t, { projectAgentId = 'fla-builder', candidates = [] } = {}) {
  const { workflows } = workflowsIn(t);
  const tokens = [];
  const app = {
    config: { personal: { spaceId: 'space-a' } },
    getAgentAccessPolicy: () => ({ enabled: true }), getCapturePolicy: () => ({ enabled: true }),
    agentWorkflows: workflows,
    taskContextRegistry: { context: async (token, sourceApplication) => {
      tokens.push([token, sourceApplication]);
      if (token !== 'fuli-task-synthetic') throw new TypeError('Unknown task context');
      return { sessionId: 'session-a', personalProjectId: 'project-a', projectAgentId, sourceApplication: 'codex' };
    } },
    listWorkflowCandidates: async (input) => ({ input, policy: { minimumOccurrences: 3, minimumDistinctSessions: 3 }, candidates })
  };
  return { app, workflows, tokens };
}

const candidate = (overrides) => ({ candidateId: 'candidate-1', sourceStepName: 'Open the synthetic PR',
  targetStepName: 'Run the synthetic checks', occurrenceCount: 4, distinctSessionCount: 3, status: 'pending', ...overrides });

test('the tools need the current task token and act only as the task\'s bound Agent', async (t) => {
  const { app, workflows, tokens } = toolApp(t);
  await assert.rejects(callAgentTool(app, 'list_agent_workflows', {}), { code: 'invalid_input' });
  await assert.rejects(callAgentTool(app, 'list_agent_workflows', { taskContextToken: 'fuli-task-stale' }), /Unknown task context/);
  const proposed = await callAgentTool(app, 'propose_agent_workflow', { taskContextToken: 'fuli-task-synthetic',
    name: 'Synthetic review', purpose: 'Review a synthetic change', steps: STEPS, agentId: 'fla-other' });
  assert.equal(proposed.status, 'proposed');
  assert.deepEqual(tokens[0], ['fuli-task-stale', 'other']);
  const [view] = workflows.overview({ personalSpaceId: 'space-a', agentId: 'fla-builder' }).workflows;
  assert.deepEqual([view.workflowId, view.personalProjectId, view.pending.source], [proposed.workflow.workflowId, 'project-a', 'agent']);

  const index = await callAgentTool(app, 'list_agent_workflows', { taskContextToken: 'fuli-task-synthetic' });
  assert.equal(Object.hasOwn(index.workflows[0], 'steps'), false, 'the index carries no steps');
  await assert.rejects(callAgentTool(app, 'read_agent_workflow', { taskContextToken: 'fuli-task-synthetic',
    workflowId: proposed.workflow.workflowId }), { code: 'workflow_not_active' });
  workflows.decide({ personalSpaceId: 'space-a', workflowId: proposed.workflow.workflowId, decision: 'confirm', version: 1 });
  const read = await callAgentTool(app, 'read_agent_workflow', { taskContextToken: 'fuli-task-synthetic', workflowId: proposed.workflow.workflowId });
  assert.deepEqual(read.steps, STEPS);
  const recorded = await callAgentTool(app, 'record_agent_workflow_run', { taskContextToken: 'fuli-task-synthetic',
    workflowId: proposed.workflow.workflowId, outcome: 'stopped' });
  assert.equal(recorded.run.outcome, 'stopped');

  const { app: otherApp } = toolApp(t, { projectAgentId: 'fla-other' });
  otherApp.agentWorkflows = workflows;
  await assert.rejects(callAgentTool(otherApp, 'read_agent_workflow', { taskContextToken: 'fuli-task-synthetic',
    workflowId: proposed.workflow.workflowId }), { code: 'workflow_not_found' });
  const { app: unbound } = toolApp(t, { projectAgentId: null });
  await assert.rejects(callAgentTool(unbound, 'list_agent_workflows', { taskContextToken: 'fuli-task-synthetic' }), { code: 'agent_not_bound' });
});

test('a proposal from a learned candidate takes its steps; a candidate not repeated enough is refused', async (t) => {
  const { app, workflows } = toolApp(t, { candidates: [candidate(), candidate({ candidateId: 'candidate-2', distinctSessionCount: 2 }),
    candidate({ candidateId: 'candidate-3', status: 'rejected' })] });
  const input = { taskContextToken: 'fuli-task-synthetic', name: 'Synthetic PR flow', purpose: 'Learned from repeated work' };
  const first = await callAgentTool(app, 'propose_agent_workflow', { ...input, candidateId: 'candidate-1' });
  const [view] = workflows.overview({ personalSpaceId: 'space-a', agentId: 'fla-builder' }).workflows;
  assert.deepEqual(view.pending.steps.map(({ title }) => title), ['Open the synthetic PR', 'Run the synthetic checks']);
  assert.equal(view.pending.source, 'candidate:candidate-1');
  const again = await callAgentTool(app, 'propose_agent_workflow', { ...input, candidateId: 'candidate-1' });
  assert.deepEqual([again.status, again.workflow.workflowId], ['unchanged', first.workflow.workflowId], 'one workflow per candidate');
  await assert.rejects(callAgentTool(app, 'propose_agent_workflow', { ...input, candidateId: 'candidate-2' }), { code: 'workflow_candidate_not_repeated' });
  await assert.rejects(callAgentTool(app, 'propose_agent_workflow', { ...input, candidateId: 'candidate-3' }), { code: 'workflow_candidate_not_repeated' });
  await assert.rejects(callAgentTool(app, 'propose_agent_workflow', { ...input, candidateId: 'missing' }), { code: 'workflow_candidate_not_found' });
  await assert.rejects(callAgentTool(app, 'propose_agent_workflow', { ...input, candidateId: 'candidate-1', steps: STEPS }), { code: 'invalid_input' });
});

test('no Agent tool decides a workflow or names another Agent', () => {
  const tools = listAgentTools().filter(({ name }) => /agent_workflow/.test(name));
  assert.deepEqual(tools.map(({ name }) => name).sort(),
    ['list_agent_workflows', 'propose_agent_workflow', 'read_agent_workflow', 'record_agent_workflow_run']);
  for (const tool of tools) {
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'agentId'), false, tool.name);
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'decision'), false, tool.name);
    assert.ok(tool.inputSchema.required.includes('taskContextToken'), tool.name);
  }
});

function request(method, body, remoteAddress) {
  const stream = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  return Object.assign(stream, { method, headers: { 'content-type': 'application/json' }, socket: { remoteAddress } });
}

async function api(app, method, path, body = null, remoteAddress = '127.0.0.1') {
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; }, end(text) { sent.body = text ? JSON.parse(text) : null; } };
  try {
    sent.handled = await handleAgentWorkflowsRequest({ request: request(method, body, remoteAddress), response,
      url: new URL(`http://127.0.0.1${path}`), app });
  } catch (error) {
    Object.assign(sent, mapHttpError(error));
  }
  return sent;
}

test('the console routes list an Agent\'s workflows and take the person\'s decision on this computer only', async (t) => {
  const { workflows } = workflowsIn(t);
  const app = { config: { personal: { spaceId: 'space-a' } }, agentWorkflows: workflows };
  const { workflow } = workflows.propose(OWNER, proposal());
  const list = '/api/agent-workflows?personalSpaceId=space-a&agentId=fla-builder';
  assert.equal((await api(app, 'GET', list, null, '192.0.2.10')).body.code, 'local_user_only');
  assert.equal((await api(app, 'GET', '/api/agent-workflows?personalSpaceId=space-b&agentId=fla-builder')).status, 403);
  assert.equal((await api(app, 'GET', '/api/agent-workflows?personalSpaceId=space-a')).status, 400);
  const [listed] = (await api(app, 'GET', list)).body.workflows;
  assert.deepEqual([listed.status, listed.pending.version], ['proposed', 1]);

  const decision = `/api/agent-workflows/${workflow.workflowId}/decision`;
  assert.equal((await api(app, 'POST', decision, { decision: 'confirm', version: 1 }, '192.0.2.10')).body.code, 'local_user_only');
  assert.equal((await api(app, 'POST', decision, { decision: 'confirm', version: 2 })).status, 409);
  assert.equal((await api(app, 'POST', decision, { decision: 'confirm', version: 1 })).body.status, 'confirmed');
  assert.equal((await api(app, 'GET', list)).body.workflows[0].status, 'active');
  assert.equal((await api(app, 'POST', '/api/agent-workflows/missing/decision', { decision: 'retire', version: 1 })).status, 404);
  assert.equal((await api(app, 'PUT', decision)).handled, false);
  assert.equal((await api({ config: app.config }, 'GET', list)).status, 503);
});

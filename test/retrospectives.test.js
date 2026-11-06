import assert from 'node:assert/strict';
import test from 'node:test';

import { RoleSuggestionLog } from '../src/model-backends/suggestion-log.js';
import { handleRetrospectivesRequest } from '../src/http/retrospectives-api-router.js';
import { RETROSPECTIVE_OPERATION, retrospectTask } from '../src/retrospectives/run.js';
import { taskRetrospective } from '../src/retrospectives/runs.js';
import { startRetrospectiveScheduler } from '../src/retrospectives/scheduler.js';

const SPACE = 'space-synthetic';
const PROJECT = 'project-synthetic';
const NOW = new Date('2026-11-06T12:00:00Z');
const egress = { allowUnassigned: false, approvedProjects: [{ personalSpaceId: SPACE, personalProjectId: PROJECT }] };
const payload = { summary: 'Synthetic summary of the work.', problems: ['Synthetic slow review'],
  lessons: [{ title: 'Synthetic lesson', text: 'Synthetic lesson text' }] };

function teamTask(extra = {}) {
  return { taskId: 'task-1', personalProjectId: PROJECT, title: 'Synthetic team task', objective: 'Synthetic goal', status: 'completed',
    resultSummary: 'Synthetic result', createdAt: '2026-11-06T08:00:00Z', completedAt: '2026-11-06T10:00:00Z', updatedAt: '2026-11-06T10:00:00Z',
    participants: [{ agentId: 'fla-a', role: 'lead', status: 'completed' }, { agentId: 'fla-b', role: 'worker', status: 'completed' }],
    events: [{ agentId: 'fla-a', status: 'running', summary: 'Synthetic start', createdAt: '2026-11-06T08:00:00Z' },
      { agentId: 'fla-b', status: 'completed', summary: 'Synthetic finish', createdAt: '2026-11-06T10:00:00Z' }], ...extra };
}

function fixture({ settings = { egress }, allows = true, envelope = { decision: 'propose', payload } } = {}) {
  const calls = { requests: [], captured: [], rows: [] };
  const app = {
    config: { personal: { spaceId: SPACE } },
    modelBackends: {
      operationSettings: (role, operation) => (role === 'assistant' && operation === 'dreaming' ? settings : null),
      allowsEgress: () => allows,
      decide: async (request) => {
        calls.requests.push(request);
        return { envelope, modelReceipt: { status: envelope ? 'completed' : 'failed', usage: { totalTokens: 42 } } };
      }
    },
    roleSuggestions: { record: row => calls.rows.push(row), deletionGeneration: () => [] },
    readRoleSuggestions: async () => calls.rows.map((row, index) => ({ ...row.result, id: index + 1, at: NOW.toISOString(),
      operation: row.operation, personalProjectId: row.personalProjectId, subject: row.subject })).reverse(),
    captureSessionKnowledge: async (input) => { calls.captured.push(input); return { route: 'personal' }; }
  };
  return { app, calls };
}

test('fuli#346: no retrospective without Astro\'s model or for a project not approved for it', async () => {
  const none = fixture({ settings: null });
  assert.deepEqual(await retrospectTask(none.app, teamTask()), { status: 'needs_model' });
  const unapproved = fixture({ settings: { egress: { allowUnassigned: false, approvedProjects: [] } } });
  assert.deepEqual(await retrospectTask(unapproved.app, teamTask()), { status: 'project_not_approved' });
  assert.deepEqual([...none.calls.requests, ...unapproved.calls.requests], []);
});

test('fuli#346: a trivial task gets none; two FLAs or a plan of three steps make it worth one', async () => {
  const { app, calls } = fixture();
  const solo = teamTask({ participants: [{ agentId: 'fla-a', role: 'lead', status: 'completed' }] });
  assert.deepEqual(await retrospectTask(app, solo), { status: 'not_worth_it' });
  assert.deepEqual(await retrospectTask(app, teamTask({ status: 'running' })), { status: 'not_worth_it' });
  assert.deepEqual(calls.requests, []);
  const plan = { steps: ['one', 'two', 'three'].map(id => ({ id, title: `Synthetic step ${id}`, agentId: 'fla-a', status: 'completed' })) };
  const planned = { ...solo, events: [...solo.events, { agentId: 'fla-a', status: 'running', summary: 'Plan', createdAt: '2026-11-06T09:00:00Z', executionPlan: plan }] };
  assert.equal((await retrospectTask(app, planned, { now: NOW })).status, 'written');
});

test('fuli#346: lessons land pending in the review queue; the row keeps what the task view shows', async () => {
  const { app, calls } = fixture();
  const result = await retrospectTask(app, teamTask(), { now: NOW });
  assert.equal(result.status, 'written');
  const [request] = calls.requests;
  assert.equal(request.operation, 'dreaming', 'runs under Astro\'s Dreaming permission');
  assert.match(request.requestId, /^retrospective:/);
  assert.deepEqual(request.evidence.map(item => [item.id, item.personalProjectId]), [['task', PROJECT]]);
  assert.match(request.evidence[0].text, /Synthetic goal[\s\S]*Participant fla-b[\s\S]*Synthetic start[\s\S]*Synthetic finish/);
  const [captured] = calls.captured;
  assert.equal(captured.entities[0].confirmationStatus, 'pending', 'a lesson never lands confirmed');
  assert.equal(captured.personalProjectId, PROJECT);
  assert.equal(captured.sourceKind, RETROSPECTIVE_OPERATION);
  assert.deepEqual(captured.entities[0].attributes, { taskId: 'task-1' });
  assert.equal(calls.rows.length, 1);
  assert.deepEqual(calls.rows[0].subject, { personalProjectId: PROJECT, taskId: 'task-1' });
  assert.deepEqual(calls.rows[0].deletionGeneration, []);
  assert.deepEqual(await taskRetrospective(app, 'task-1'), { at: NOW.toISOString(), status: 'written', summary: payload.summary,
    problems: payload.problems, lessons: [{ title: 'Synthetic lesson', status: 'queued' }], wordsRemoved: false });
  assert.equal(await taskRetrospective(app, 'task-other'), null);
});

test('fuli#346: a permanent delete takes the retrospective\'s words out of the log', () => {
  const log = new RoleSuggestionLog(':memory:', { now: () => NOW });
  log.record({ role: 'assistant', operation: RETROSPECTIVE_OPERATION, personalSpaceId: SPACE, personalProjectId: PROJECT,
    subject: { taskId: 'task-1' }, deletionGeneration: null,
    result: { status: 'written', taskId: 'task-1', taskTitle: 'Synthetic title', hint: 'Synthetic summary', issues: ['Synthetic problem'],
      lessons: [{ title: 'Synthetic lesson', status: 'queued' }] } });
  const [row] = log.list({ personalSpaceId: SPACE });
  assert.equal(row.hard_deleted, true);
  assert.doesNotMatch(JSON.stringify(row), /Synthetic/);
  assert.equal(row.taskId, 'task-1');
});

test('fuli#346: a permission taken back or a failed model applies nothing and says so', async () => {
  const superseded = fixture({ allows: false });
  assert.equal((await retrospectTask(superseded.app, teamTask())).status, 'superseded');
  assert.deepEqual(superseded.calls.captured, []);
  const failed = fixture({ envelope: null });
  assert.equal((await retrospectTask(failed.app, teamTask())).status, 'model_failed');
  assert.deepEqual(failed.calls.captured, []);
  assert.equal(failed.calls.rows[0].result.status, 'model_failed');
});

test('fuli#346: a long task fits one call and keeps how it began and how it ended', async () => {
  const { app, calls } = fixture();
  const events = Array.from({ length: 200 }, (_, n) => ({ agentId: 'fla-a', status: 'running', summary: `Synthetic event ${n} ${'x'.repeat(500)}`,
    createdAt: new Date(Date.parse('2026-11-01T00:00:00Z') + n * 60_000).toISOString() }));
  await retrospectTask(app, teamTask({ events }), { now: NOW });
  const { text } = calls.requests[0].evidence[0];
  assert.ok(text.length <= 18_000);
  assert.match(text, /Synthetic event 0 /);
  assert.match(text, /Synthetic event 199 /);
  assert.match(text, /events left out/);
});

test('fuli#346: the host writes one per finished task, a few per tick, retries failures and skips old work', async () => {
  const { app, calls } = fixture();
  const tasks = [teamTask({ taskId: 'done' }), teamTask({ taskId: 'old', completedAt: '2026-10-01T00:00:00Z' }),
    ...['a', 'b', 'c', 'd'].map(id => teamTask({ taskId: `new-${id}` }))];
  app.listProjectAgentTasks = async (input) => { calls.listed = input; return tasks; };
  calls.rows.push({ operation: RETROSPECTIVE_OPERATION, personalProjectId: PROJECT, subject: { taskId: 'done' }, result: { status: 'written' } });
  const stop = startRetrospectiveScheduler({ app, intervalMs: 5, now: () => NOW });
  await new Promise(resolve => { setTimeout(resolve, 80); });
  await stop();
  assert.deepEqual(calls.listed, { personalSpaceId: SPACE, status: 'completed', limit: 50 });
  const asked = calls.requests.map(request => request.evidence[0].text.match(/Task: (.*)/)[1]);
  assert.equal(asked.length, 4, 'each new task once, the fourth on a later tick');
  assert.deepEqual(new Set(calls.rows.filter(row => row.result.status === 'written').map(row => row.subject.taskId)),
    new Set(['done', 'new-a', 'new-b', 'new-c', 'new-d']));

  const failing = fixture({ envelope: null });
  failing.app.listProjectAgentTasks = async () => [teamTask()];
  failing.app.roleSuggestions.record = () => { throw new Error('log closed'); };
  const again = startRetrospectiveScheduler({ app: failing.app, intervalMs: 5, now: () => NOW });
  await new Promise(resolve => { setTimeout(resolve, 80); });
  await again();
  assert.equal(failing.calls.requests.length, 3, 'a failure is tried again, three times in all, even when its row is lost');
});

test('fuli#346: the task view\'s read is local only and names a task', async () => {
  const { app } = fixture();
  await retrospectTask(app, teamTask(), { now: NOW });
  const call = async (path, address = '127.0.0.1') => {
    const request = { method: 'GET', url: path, socket: { remoteAddress: address }, headers: {} };
    const response = { headers: {}, status: null, body: null, setHeader(name, value) { this.headers[name] = value; },
      writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
    assert.equal(await handleRetrospectivesRequest({ request, response, url: new URL(path, 'http://127.0.0.1'), app }), true);
    return response;
  };
  assert.equal((await call('/api/retrospectives?taskId=task-1', '192.0.2.8')).status, 403);
  assert.equal((await call('/api/retrospectives?taskId=task-1')).body.retrospective.summary, payload.summary);
  await assert.rejects(call('/api/retrospectives'), { code: 'invalid_input' });
});

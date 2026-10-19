import assert from 'node:assert/strict';
import test from 'node:test';
import { retryProjectAgentTask, stopProjectAgentTaskRun } from '../src/graphiti/project-agent-run-control.js';

const scope = { personalSpaceId: 'space', personalProjectId: 'project', taskId: 'task-1' };
function fakeApp({ runs = [], task = {} } = {}) {
  const calls = [];
  return { calls,
    personal: {
      async listProjectAgentTaskRuns(input) { calls.push(['runs', input]); return { runs, next_cursor: null, complete: true }; },
      async revokeProjectAgentWorkerRun(runId, input) { calls.push(['revoke', runId, input]); return { ...runs.find(r => r.run_id === runId), state: 'revoked' }; }
    },
    async viewProjectAgentTask(input) { calls.push(['view', input]); return task; },
    async submitProjectAgentTask(input) { calls.push(['submit', input]); return { task: { taskId: 'task-2', status: input.start ? 'queued' : 'backlog' } }; }
  };
}

test('stop revokes a running run once and reports a stopped run without touching it again', async () => {
  const app = fakeApp({ runs: [{ run_id: 'run-a', task_id: 'task-1', state: 'admitted' }, { run_id: 'run-b', task_id: 'task-1', state: 'closed' }] });
  const stopped = await stopProjectAgentTaskRun(app, { ...scope, runId: 'run-a' });
  assert.equal(stopped.status, 'stopping');
  assert.equal(stopped.run.state, 'revoked');
  assert.deepEqual(app.calls.find(([name]) => name === 'revoke').slice(1),
    ['run-a', { personal_space_id: 'space', personal_project_id: 'project', reason: 'worker_stopped_by_request' }]);
  const again = await stopProjectAgentTaskRun(app, { ...scope, runId: 'run-b' });
  assert.equal(again.status, 'already_stopped');
  assert.equal(app.calls.filter(([name]) => name === 'revoke').length, 1);
  await assert.rejects(stopProjectAgentTaskRun(app, { ...scope, runId: 'run-x' }), /not found/);
});

test('stop finds a run beyond the first history page', async () => {
  const pages = { '': { runs: [{ run_id: 'run-1', state: 'closed' }], next_cursor: 'run-1', complete: false },
    'run-1': { runs: [{ run_id: 'run-101', state: 'admitted' }], next_cursor: null, complete: true } };
  const app = fakeApp({ runs: [{ run_id: 'run-101', state: 'admitted' }] });
  app.personal.listProjectAgentTaskRuns = async input => { app.calls.push(['runs', input]); return pages[input.cursor ?? '']; };
  const stopped = await stopProjectAgentTaskRun(app, { ...scope, runId: 'run-101' });
  assert.equal(stopped.status, 'stopping');
  assert.deepEqual(app.calls.filter(([name]) => name === 'runs').map(([, input]) => input.cursor ?? null), [null, 'run-1']);
  const missing = stopProjectAgentTaskRun(app, { ...scope, runId: 'run-x' });
  await assert.rejects(missing, error => error.status === 404 && error.code === 'task_run_not_found');
});

test('retry submits a failed task again as new work and keeps the old task untouched', async () => {
  const app = fakeApp({ task: { status: 'failed', title: 'Port tests', objective: 'Port the suite.', workKind: 'implementation',
    requiredCapabilities: ['testing'], leadAgentId: 'lead-1' } });
  const result = await retryProjectAgentTask(app, { ...scope, start: false });
  const [, submitted] = app.calls.find(([name]) => name === 'submit');
  assert.equal(result.task.status, 'backlog');
  assert.equal(submitted.idempotencyKey, 'retry:task-1');
  assert.equal(submitted.leadAgentId, 'lead-1');
  assert.equal(submitted.objective, 'Port the suite.');
  assert.match(submitted.routingReason, /Retry of task task-1, which ended failed/);
  assert.equal(app.calls.some(([name]) => name === 'revoke'), false);
});

test('only failed or cancelled tasks can be retried', async () => {
  for (const status of ['running', 'queued', 'completed', 'awaiting_review']) {
    const app = fakeApp({ task: { status, title: 't', objective: 'o', workKind: 'w', requiredCapabilities: [] } });
    await assert.rejects(retryProjectAgentTask(app, scope),
      error => /Only a failed or cancelled task/.test(error.message) && error.status === 409);
    assert.equal(app.calls.some(([name]) => name === 'submit'), false);
  }
});

test('an Agent stop or retry in a grouped team needs the current host task context', async () => {
  const app = fakeApp({ runs: [{ run_id: 'run-a', state: 'admitted' }],
    task: { status: 'failed', title: 't', objective: 'o', workKind: 'w', requiredCapabilities: [] } });
  app.personal.getProjectAgentCoordinationPolicy = async () => ({ team_lead_agent_id: 'lead', sub_teams: [{ lead_agent_id: 'sub' }] });
  await assert.rejects(stopProjectAgentTaskRun(app, { ...scope, runId: 'run-a', agentInvocation: true }), /taskContextToken/);
  assert.equal(app.calls.some(([name]) => name === 'revoke'), false);
  await retryProjectAgentTask(app, { ...scope, agentInvocation: true, taskContextToken: 'fuli-task-1',
    sourceApplication: 'codex', sourceSessionId: 'session-1' });
  const [, submitted] = app.calls.find(([name]) => name === 'submit');
  assert.deepEqual([submitted.agentInvocation, submitted.taskContextToken, submitted.sourceSessionId], [true, 'fuli-task-1', 'session-1']);
  await retryProjectAgentTask(app, scope);
  assert.equal(Object.hasOwn(app.calls.filter(([name]) => name === 'submit')[1][1], 'agentInvocation'), false);
});

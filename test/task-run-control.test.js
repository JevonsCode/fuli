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
    await assert.rejects(retryProjectAgentTask(app, scope), /Only a failed or cancelled task/);
    assert.equal(app.calls.some(([name]) => name === 'submit'), false);
  }
});

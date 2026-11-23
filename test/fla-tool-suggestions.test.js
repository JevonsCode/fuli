import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestRepeatedTools } from '../src/fla-growth/tool-suggestions.js';

// Synthetic tasks, plans and workflows only.
const plan = (steps, agentId = null) => [{ eventId: 'e', createdAt: '2026-11-06T00:00:00Z',
  executionPlan: { steps: steps.map(title => ({ title, status: 'completed', agentId })) } }];
const task = (taskId, steps, overrides = {}) => ({ taskId, title: `Synthetic ${taskId}`, status: 'completed',
  personalProjectId: 'app', leadAgentId: 'lead-1', events: plan(steps), ...overrides });
const RELEASE = ['Bump the version', 'Build the tray zip', 'Upload the release asset'];

// One tick, called directly: no timer, no wall clock.
const tickOnce = app => suggestRepeatedTools(app);

function application({ tasks = [], workflows = [] } = {}) {
  const requests = [];
  const app = { requests, config: { personal: { spaceId: 'space' } },
    listProjectAgentTasks: async () => { app.ticked = true; return tasks; },
    // Idempotent as the Provider is: a later tick asking the same is the same request.
    requestAgentAttention: async input => {
      if (!requests.some(seen => seen.idempotencyKey === input.idempotencyKey)) requests.push(input);
      return { requestId: input.idempotencyKey };
    } };
  if (workflows.length) app.agentWorkflows = { listSpace: () => workflows.map(({ agentId, workflow }) =>
    ({ workflowId: workflow.workflowId, agentId, status: workflow.status })),
  overview: ({ agentId }) => ({ workflows: workflows.filter(entry => entry.agentId === agentId).map(entry => entry.workflow) }) };
  return app;
}

test('the same FLA repeating the same steps in three tasks is asked about once, as a decision for the person', async () => {
  const app = application({ tasks: [task('t1', RELEASE), task('t2', RELEASE.map(step => `  ${step.toUpperCase()} `)), task('t3', RELEASE),
    // The same work in another order is the same kind of work (step-similarity.js); too few steps,
    // unfinished, or another FLA's are not.
    task('t4', ['Build the tray zip', 'Bump the version', 'Upload the release asset']), task('t5', RELEASE.slice(0, 2)),
    task('t6', RELEASE, { status: 'running' }), task('t7', RELEASE, { leadAgentId: 'other' }), task('t8', RELEASE, { leadAgentId: 'other' })] });
  await tickOnce(app);
  assert.equal(app.requests.length, 1);
  const [request] = app.requests;
  assert.deepEqual([request.kind, request.agentId, request.personalProjectId], ['approval', 'lead-1', 'app']);
  // Three outcomes the person can tell apart, in their own words: no English product name to decode.
  assert.deepEqual(request.options, ['只记下这串步骤', '做成能跑的脚本', '不用']);
  assert.equal(/Agent App|script|workflow/i.test([request.title, request.detail.split('\n')[0], request.requestedAction].join(' ')), false);
  assert.match(request.detail, /1\. Bump the version\n2\. Build the tray zip\n3\. Upload the release asset/);
  assert.match(request.requestedAction, /不经你同意什么都不做/);
  // How the person confirms a script, and what each choice makes the FLA do, travel with the reply.
  assert.match(request.requestedAction, /Agents → 应用点「确认」，会打开终端，输入应用名/);
  assert.match(request.requestedAction, /交成一个 Agent 应用/);
  // Every option is explained where it is answered, so nothing has to be typed or looked up.
  for (const option of request.options) assert.ok(request.requestedAction.includes(option), option);
  assert.match(request.idempotencyKey, /^tool-suggestion:/);
});

test('asking again is the very same request, whatever else finished since', async () => {
  const first = application({ tasks: [task('t1', RELEASE), task('t2', RELEASE), task('t3', RELEASE)] });
  const later = application({ tasks: [task('t1', RELEASE), task('t2', RELEASE), task('t3', RELEASE), task('t9', RELEASE)] });
  await tickOnce(first);
  await tickOnce(later);
  assert.deepEqual(later.requests[0], first.requests[0]);
});

test('an active workflow run done in three tasks at one version is asked about too; fewer is not', async () => {
  const workflow = (runs, status = 'active') => ({ workflowId: 'wf-1', status, personalProjectId: 'app',
    active: { version: 2, name: 'Weekly release', steps: RELEASE.map(title => ({ title })) }, recentRuns: runs });
  const run = (taskId, version = 2, outcome = 'done') => ({ taskId, version, outcome });
  const enough = application({ workflows: [{ agentId: 'lead-1', workflow: workflow([run('a'), run('b'), run('c')]) }] });
  await tickOnce(enough);
  assert.equal(enough.requests.length, 1);
  assert.match(enough.requests[0].title, /「Weekly release」/);
  assert.deepEqual(enough.requests[0].options, ['做成能跑的脚本', '不用']);
  const few = application({ workflows: [{ agentId: 'lead-1', workflow: workflow([run('a'), run('b'), run('c', 1), run('d', 2, 'failed'), run('b')]) }] });
  await tickOnce(few);
  assert.equal(few.requests.length, 0);
});

test('one request that cannot be made keeps the others going', async () => {
  const app = application({ tasks: [...['a1', 'a2', 'a3'].map(id => task(id, RELEASE, { leadAgentId: 'gone' })),
    ...['b1', 'b2', 'b3'].map(id => task(id, RELEASE))] });
  const ask = app.requestAgentAttention;
  app.requestAgentAttention = async input => { if (input.agentId === 'gone') throw new Error('synthetic: not in the project'); return ask(input); };
  await tickOnce(app);
  assert.deepEqual(app.requests.map(request => request.agentId), ['lead-1']);
});

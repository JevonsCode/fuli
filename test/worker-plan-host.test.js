import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerPlanHost, workerRuntimeBindingKey } from '../src/graphiti/worker-plan-host.js';

export function readyPlan() {
  return { personal_space_id: 'space', personal_project_id: 'project', host_execution_required: true,
    task_context: { task_context_token: 'fuli-task-synthetic-parent-1234' },
    worker_plan: [{ agent_id: 'lead', participant_role: 'lead', context_status: 'ready' }],
    route: { task: { taskId: 'task', leadAgentId: 'lead', participants: [{ agentId: 'lead' }], status: 'queued',
      sourceApplication: 'claude_code', objective: 'One synthetic task.', selectedExecutorId: 'native',
      executorDecision: { status: 'selected', personal_space_id: 'space', personal_project_id: 'project',
        task_id: 'task', agent_id: 'lead', selected_executor_id: 'native', selected_provider: 'synthetic',
        selected_model: 'synthetic-model', model_strategy: { mode: 'deep', reasoning_effort: 'max', capability_hints: [] } } } } };
}

test('single ready lead uses only the trusted workspace and selected executor/model, preserving the parent owner', async () => {
  const plan = readyPlan(), parentToken = plan.task_context.task_context_token;
  let request, descriptor, stopped = false;
  const activities = [];
  const view = (state, extra = {}) => ({ run_id: 'run-1', state,
    ...Object.fromEntries(['personal_space_id', 'personal_project_id', 'task_id', 'agent_id', 'worker_id',
      'executor_id', 'target_application'].map(name => [name, request[name]])),
    requested_model_provider: request.provider, requested_model: request.model,
    requested_model_strategy: request.model_strategy, actual_session_id: 'child', ...extra });
  const context = { token: 'fuli-task-synthetic-child-1234', personal_space_id: 'space', personal_project_id: 'project',
    project_agent_id: 'lead', source_application: 'codex', session_id: 'child', source_session_id: 'child', turn_id: 'worker-run:run-1' };
  const provider = {
    async getTaskContext(token) { return token === parentToken
      ? { token, personal_space_id: 'space', personal_project_id: 'project', project_agent_id: 'original-owner',
        source_application: 'claude_code', session_id: 'parent' }
      : { ...context, checkpoint: { phase: 'complete', work_log: { status: 'completed', summary: 'Synthetic evidence.' } } }; },
    async prepareProjectAgentWorkerRun(input) { request = input; return view('prepared'); },
    async claimProjectAgentWorkerStart() { return view('claimed', { start_claimed: true }); },
    async sealProjectAgentWorkerSession() { return view('sealed'); },
    async admitProjectAgentWorkerContext() { return view('admitted', { own_context_token: context.token, task_context: context }); },
    async getProjectAgentWorkerRun() { return view('admitted'); },
    async dispatchProjectAgentWorkerPrompt() { return { dispatch_claimed: true }; },
    async recordProjectAgentWorkerResult(_id, input) { return { execution_result: { ...input, retry_eligible: false } }; },
    async closeProjectAgentWorkerRun() { return view('closed'); },
    async recordProjectAgentTaskActivity(input) { activities.push(input); }
  };
  const adapter = { application: 'codex', async start(input) {
    descriptor = input.descriptor;
    return { newSession: async () => ({ sessionId: 'child' }), configure: async () => {},
      promptOnce: async () => ({ sessionId: 'child', text: 'Synthetic output.', stopReason: 'end_turn' }),
      close: async () => { stopped = true; } };
  } };
  const host = createWorkerPlanHost({ provider, leases: { acquireGraphLease: async () => ({ enabled: false }),
    releaseLease: async () => ({ released: false }) }, workerRuntimeBindings: new Map([
    [workerRuntimeBindingKey('space', 'project', 'native'), { adapter, projectPath: process.cwd(), leaseExecutor: false }]
  ]) });
  plan.worker_plan[0].projectPath = 'UNTRUSTED_MODEL_PATH';
  const result = await host.dispatch({ plan, idempotencyKey: 'dispatch-once' });
  assert.equal(result.outcome.status, 'completed');
  assert.equal(descriptor.projectPath, process.cwd());
  assert.equal(JSON.stringify(descriptor).includes(parentToken), false);
  assert.equal(request.model, 'synthetic-model');
  assert.equal(request.model_strategy.reasoning_effort, 'max');
  assert.equal(stopped, true);
  assert.deepEqual(activities.map(value => value.status), ['running', 'awaiting_review']);
  assert.equal(activities.at(-1).source_session_id, 'parent');
  assert.equal(activities.at(-1).worker_status, 'completed');
  await host.close();
  assert.equal((await host.dispatch({ plan, idempotencyKey: 'dispatch-once' })).outcome.code, 'worker_host_closed');
});

function retryFixture(options = {}) {
  const plan = readyPlan();
  let input, starts = 0, prompts = 0;
  const prepared = [], reports = [];
  const view = state => ({ run_id: `run-${starts + 1}`, state,
    ...Object.fromEntries(['personal_space_id', 'personal_project_id', 'task_id', 'agent_id', 'worker_id',
      'executor_id', 'target_application'].map(name => [name, input[name]])),
    requested_model_provider: input.provider, requested_model: input.model,
    requested_model_strategy: input.model_strategy, actual_session_id: `session-${starts}` });
  let run;
  const provider = {
    getTaskContext: async token => token === plan.task_context.task_context_token
      ? { token, personal_space_id: 'space', personal_project_id: 'project', source_application: 'claude_code', session_id: 'parent' }
      : { token, personal_space_id: 'space', personal_project_id: 'project', project_agent_id: 'lead',
        source_application: 'codex', session_id: `session-${starts}`, source_session_id: `session-${starts}`,
        turn_id: `worker-run:${run.run_id}`, checkpoint: prompts ? { phase: 'complete', work_log: { status: 'completed', summary: 'Synthetic result.' } } : null },
    prepareProjectAgentWorkerRun: async request => { input = request; prepared.push(request); run = view('prepared'); return run; },
    claimProjectAgentWorkerStart: async () => ({ ...run, state: 'claimed', start_claimed: true }),
    getProjectAgentWorkerRun: async () => ({ ...run, state: 'admitted' }),
    sealProjectAgentWorkerSession: async (_id, session) => ({ ...run, state: 'sealed', actual_session_id: session.session_id }),
    admitProjectAgentWorkerContext: async () => ({ ...run, state: 'admitted', actual_session_id: `session-${starts}`,
      own_context_token: `fuli-task-synthetic-child-${starts}`, task_context: {
        token: `fuli-task-synthetic-child-${starts}`, personal_space_id: 'space', personal_project_id: 'project',
        project_agent_id: 'lead', source_application: 'codex', session_id: `session-${starts}`,
        source_session_id: `session-${starts}`, turn_id: `worker-run:${run.run_id}` } }),
    dispatchProjectAgentWorkerPrompt: async () => ({ dispatch_claimed: true }),
    closeProjectAgentWorkerRun: async () => ({ ...run, state: 'closed', actual_session_id: `session-${starts}` }),
    recordProjectAgentTaskActivity: async report => { reports.push(report); },
    recordProjectAgentWorkerResult: async (_id, result) => {
      options.onResult?.(starts);
      return { execution_result: { ...result, retry_eligible: starts < 3, attempt_limit: 3,
        retry_not_before: new Date(Date.now() + (options.delayMs ?? 0)).toISOString() } };
    }
  };
  const adapter = { application: 'codex', start: async () => {
    starts++;
    return { newSession: async () => ({ sessionId: `session-${starts}` }),
      configure: async () => { if (!options.failDuringPrompt && starts < 3) throw Object.assign(new Error('Synthetic network error'), { code: 'worker_connection_closed' }); },
      promptOnce: async () => {
        prompts++;
        if (options.failDuringPrompt) throw Object.assign(new Error('Synthetic lost reply after a possible action'), { code: 'worker_connection_closed' });
        return { sessionId: `session-${starts}`, text: 'Synthetic result.', stopReason: 'end_turn' };
      },
      close: async () => { if (options.cleanupFails) throw new Error('Synthetic cleanup failure'); } };
  } };
  const host = createWorkerPlanHost({ provider,
    leases: { acquireGraphLease: async () => ({ enabled: false }), releaseLease: async () => ({ released: false }) },
    workerRuntimeBindings: new Map([[workerRuntimeBindingKey('space', 'project', 'native'),
      { adapter, projectPath: process.cwd(), leaseExecutor: false }]]) });
  return { host, plan, prepared, reports, counts: () => ({ starts, prompts }) };
}

test('automatic retries create distinct attempts under one Task and obey the durable decision', async () => {
  const { host, plan, prepared, reports, counts } = retryFixture();
  const result = await host.dispatch({ plan, idempotencyKey: 'synthetic-retry-chain' });
  assert.deepEqual(counts(), { starts: 3, prompts: 1 });
  assert.equal(new Set(prepared.map(p => p.task_id)).size, 1);
  assert.equal(new Set(prepared.map(p => p.worker_id)).size, 3);
  assert.equal(prepared[1].retry_of_run_id, 'run-1');
  assert.equal(prepared[2].retry_of_run_id, 'run-2');
  assert.equal(result.attempts.length, 3);
  assert.equal(result.outcome.status, 'completed');
  assert.equal(reports.at(-1).status, 'awaiting_review');
  await host.close();
});

test('host close cancels retry backoff and never resurrects an attempt', async () => {
  const reached = Promise.withResolvers();
  const f = retryFixture({ delayMs: 5000, onResult: () => reached.resolve() });
  const running = f.host.dispatch({ plan: f.plan, idempotencyKey: 'cancel-retry-backoff' });
  await reached.promise;
  await f.host.close();
  assert.equal((await running).outcome.status, 'cancelled');
  assert.deepEqual(f.counts(), { starts: 1, prompts: 0 });
});

test('uncertain prompt effects or failed cleanup prevent retries even with a mistaken eligible decision', async () => {
  for (const options of [{ failDuringPrompt: true }, { cleanupFails: true }]) {
    const f = retryFixture(options);
    const result = await f.host.dispatch({ plan: f.plan, idempotencyKey: 'synthetic-unsafe-retry' });
    assert.equal(f.counts().starts, 1);
    assert.equal(result.attempts.length, 1);
    assert.notEqual(result.outcome.status, 'completed');
    await f.host.close();
  }
});

test('missing binding, multiple workers, unavailable context, or foreign decision dispatch no process', async () => {
  const host = createWorkerPlanHost({ provider: {}, leases: {}, workerRuntimeBindings: new Map() });
  for (const [change, code] of [
    [() => {}, 'worker_runtime_unbound'],
    [plan => plan.worker_plan.push({ ...plan.worker_plan[0] }), 'worker_plan_unsupported'],
    [plan => { plan.worker_plan[0].context_status = 'unavailable'; }, 'worker_plan_unsupported'],
    [plan => { plan.route.task.executorDecision.personal_project_id = 'foreign'; }, 'worker_executor_decision_unavailable'],
    [plan => { plan.route.task.selectedExecutorId = 'different'; }, 'worker_executor_decision_unavailable']
  ]) {
    const plan = readyPlan(); change(plan);
    assert.deepEqual((await host.dispatch({ plan, idempotencyKey: 'dispatch-once' })).outcome,
      { status: 'blocked', code });
  }
});

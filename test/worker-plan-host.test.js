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
  assert.deepEqual(activities.map(value => value.status), ['running', 'running']);
  assert.equal(activities.at(-1).source_session_id, 'parent');
  assert.equal(activities.at(-1).worker_status, 'completed');
  await host.close();
  assert.equal((await host.dispatch({ plan, idempotencyKey: 'dispatch-once' })).outcome.code, 'worker_host_closed');
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

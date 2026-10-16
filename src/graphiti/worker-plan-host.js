import { createHash } from 'node:crypto';
import { createWorkerRunAttempt } from './worker-run-host.js';

export const workerRuntimeBindingKey = (spaceId, projectId, executorId) =>
  JSON.stringify([spaceId, projectId, executorId]);
const text = (value, max = 128) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const blocked = code => ({ runId: null, outcome: { status: 'blocked', code } });

// A single host dispatch port. Routing/model selection remains with the Provider;
// executable paths and workspace authority come only from the local composition.
export function createWorkerPlanHost({ provider, leases, workerRuntimeBindings, attemptOptions = {} }) {
  if (!(workerRuntimeBindings instanceof Map)) throw new TypeError('Trusted worker runtime bindings are required');
  const bindings = new Map(workerRuntimeBindings);
  const active = new Set();
  let closed = false;
  return { async dispatch({ plan, idempotencyKey, signal }) {
    if (closed) return blocked('worker_host_closed');
    const task = plan?.route?.task, workers = plan?.worker_plan;
    if (plan?.host_execution_required !== true || task?.status !== 'queued' || !Array.isArray(workers) ||
        workers.length !== 1 || workers[0].participant_role !== 'lead' || workers[0].context_status !== 'ready' ||
        workers[0].agent_id !== task.leadAgentId || task.participants?.length !== 1 ||
        task.participants[0].agentId !== task.leadAgentId) return blocked('worker_plan_unsupported');
    const decision = task.executorDecision;
    if (!decision || !['selected', 'fallback'].includes(decision.status) ||
        decision.personal_space_id !== plan.personal_space_id || decision.personal_project_id !== plan.personal_project_id ||
        decision.task_id !== task.taskId || decision.agent_id !== task.leadAgentId ||
        !text(decision.selected_executor_id) || decision.selected_executor_id !== task.selectedExecutorId ||
        !text(decision.selected_provider) || !text(decision.selected_model, 256) || !decision.model_strategy) {
      return blocked('worker_executor_decision_unavailable');
    }
    const binding = bindings.get(workerRuntimeBindingKey(plan.personal_space_id, plan.personal_project_id, decision.selected_executor_id));
    if (!binding) return blocked('worker_runtime_unbound');
    if (!text(idempotencyKey, 128) || idempotencyKey.length < 8 || !text(task.objective, 8192) ||
        !text(task.sourceApplication) || !text(plan.task_context?.task_context_token, 256)) {
      return blocked('worker_plan_context_unavailable');
    }
    const key = createHash('sha256').update(JSON.stringify([task.taskId, task.leadAgentId, idempotencyKey])).digest('hex');
    const cancellation = new AbortController();
    const running = createWorkerRunAttempt({ ...attemptOptions, provider, leases, adapter: binding.adapter,
      projectPath: binding.projectPath, taskPrompt: task.objective,
      toolNames: ['get_collaboration_preferences', 'checkpoint_task_knowledge'], leaseExecutor: binding.leaseExecutor,
      request: { personal_space_id: plan.personal_space_id, personal_project_id: plan.personal_project_id,
        task_context_token: plan.task_context.task_context_token, source_application: task.sourceApplication,
        task_id: task.taskId, agent_id: task.leadAgentId, worker_id: `worker-${key.slice(0, 32)}`,
        executor_id: decision.selected_executor_id, target_application: binding.adapter.application,
        provider: decision.selected_provider, model: decision.selected_model,
        model_strategy: structuredClone(decision.model_strategy), idempotency_key: `worker-plan:${key}` }
    }).run({ signal: signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal });
    const entry = { cancellation, running };
    active.add(entry);
    try { return await running; }
    finally { active.delete(entry); }
  }, async close() {
    closed = true;
    for (const entry of active) entry.cancellation.abort();
    await Promise.allSettled([...active].map(entry => entry.running));
  } };
}

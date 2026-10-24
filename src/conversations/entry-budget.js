import { AsyncLocalStorage } from 'node:async_hooks';

// The time one lifecycle hook's task entry has left (rec#39 D-40). A hook runs
// its entry inside a budget that ends at its own deadline; an entry without
// one (an Agent's own begin_task_context or get_collaboration_preferences
// call) has no deadline here, as before.
const budgets = new AsyncLocalStorage();

// A built-in Agent's model hint (Astro, Jefa) may take its 3 s model decision
// plus a few Provider reads; with less than this left the entry goes without.
const HINT_MIN_REMAINING_MS = 4000;
// Shown where the hint would be: the session matches as it does without a
// model. Not an error.
const HINT_SKIPPED = Object.freeze({ status: 'skipped', reason: 'entry_time_low' });

export function entryBudget(timeoutMs, { now = Date.now } = {}) {
  return { deadline: now() + timeoutMs, now, task: null };
}

export function runWithEntryBudget(budget, operation) {
  return budgets.run(budget, operation);
}

// HINT_SKIPPED when too little of the entry's time is left for a model hint.
export function entryHintSkipped() {
  const budget = budgets.getStore();
  return budget && budget.deadline - budget.now() < HINT_MIN_REMAINING_MS ? HINT_SKIPPED : null;
}

// The task this entry wrote, with its opening writes done in time. One noted
// after the deadline was cut short and is never delivered.
export function noteEntryTask({ token, projectAgentId, checkpointRequired, checkpointGuidance = null }) {
  const budget = budgets.getStore();
  if (budget && budget.now() < budget.deadline) budget.task = { token, projectAgentId, checkpointRequired, checkpointGuidance };
}

const PARTIAL_ENTRY_LABEL = 'Fuli task context is partial: the hook deadline came before the entry was complete. '
  + 'Fetch each part listed in entry_incomplete with its tool before relying on it. Pass taskContextToken to every FULI call.';

// What a hook delivers at its deadline once its entry wrote the task: the
// token and what is missing, each with the existing tool that fetches it,
// instead of nothing. Before the task is written, or for a task its reader
// cannot recover (no Agent), null: the hook keeps its fallback, a new entry
// through get_collaboration_preferences that supersedes a task written late.
export function partialEntryText(budget) {
  const task = budget?.task;
  if (!task?.projectAgentId) return null;
  return `${PARTIAL_ENTRY_LABEL}\n${JSON.stringify({
    taskContextToken: task.token,
    checkpoint_required: task.checkpointRequired,
    ...(task.checkpointGuidance ? { checkpoint_guidance: task.checkpointGuidance } : {}),
    entry_incomplete: { reason: 'entry_deadline', missing: [
      { parts: ['effective_preferences', 'project_agent_context', 'judgment_context', 'agent_receipt'],
        tool: 'read_task_preferences', arguments: { taskContextToken: task.token } },
      { parts: ['project_management_context'], tool: 'list_employee_tools' },
      { parts: ['task_knowledge_recall'], tool: 'search_current_project_knowledge' }
    ], transcript_capture: 'unverified' }
  })}`;
}

// The fallback's marker when the deadline came before any task was written.
export const NO_TASK_AT_DEADLINE = `\nentry_incomplete=${JSON.stringify({ reason: 'entry_deadline', missing: [
  { parts: ['task_context', 'effective_preferences'], tool: 'get_collaboration_preferences' }] })}`;

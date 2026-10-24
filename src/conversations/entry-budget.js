import { AsyncLocalStorage } from 'node:async_hooks';

import { managementContextView, receiptView } from './task-context-view.js';

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
  return { deadline: now() + timeoutMs, now, task: null, notice: null };
}

export function runWithEntryBudget(budget, operation) {
  return budgets.run(budget, operation);
}

// HINT_SKIPPED when too little of the entry's time is left for a model hint.
export function entryHintSkipped() {
  const budget = budgets.getStore();
  return budget && budget.deadline - budget.now() < HINT_MIN_REMAINING_MS ? HINT_SKIPPED : null;
}

// What an entry already holds once its task is written and is cheap to carry:
// delivered as it is at the deadline, so a partial entry still says how to
// checkpoint, and that the person asked to keep something.
const DELIVERED_AT_DEADLINE = Object.freeze(['checkpoint_required', 'checkpoint_guidance', 'remember_guidance',
  'previous_checkpoint_missing', 'project_scope']);

// The task this entry wrote, with its opening writes done in time. One noted
// after the deadline was cut short and is never delivered. The entry is kept
// whole: its parts are chosen only if the deadline comes.
export function noteEntryTask(entry) {
  const budget = budgets.getStore();
  if (!budget || budget.now() >= budget.deadline) return;
  budget.task = entry;
}

// A notice the hook adds to its prompt answer (an outdated MCP process) that
// its deadline answer carries too. Noted before the entry runs and read at
// most once, by whichever answer comes first, since it is shown once.
export function noteEntryNotice(read) {
  let notice;
  const once = () => (notice ??= { text: read() }).text;
  const budget = budgets.getStore();
  if (budget) budget.notice = once;
  return once;
}

// The notice noted for this entry, or null.
export function entryNotice(budget) {
  return budget?.notice?.() ?? null;
}

const PARTIAL_ENTRY_LABEL = 'Fuli task context is partial: the hook deadline came before the entry was complete. '
  + 'Fetch each part listed in entry_incomplete with its tool before relying on it. Pass taskContextToken to every FULI call.';

// What a hook delivers at its deadline once its entry wrote the task: the
// token, what the entry already held, and what is missing, each with the
// existing tool and arguments that fetch it, instead of nothing. The receipt
// is delivered as built: it may hold items this entry already claimed, which
// no reader can show again. Before the task is written, or for a task its
// reader cannot recover (no Agent), null: the hook keeps its fallback, a new
// entry through get_collaboration_preferences that supersedes a task written
// late.
export function partialEntryText(budget) {
  const entry = budget?.task;
  if (!entry?.context?.project_agent_id) return null;
  return `${PARTIAL_ENTRY_LABEL}\n${JSON.stringify({
    taskContextToken: entry.task_context_token,
    ...Object.fromEntries(DELIVERED_AT_DEADLINE.filter(field => entry[field] !== undefined && entry[field] !== null)
      .map(field => [field, entry[field]])),
    ...builtParts(entry),
    entry_incomplete: { reason: 'entry_deadline', missing: missingParts(entry), transcript_capture: 'unverified' }
  })}`;
}

// Bounded parts the entry built before the deadline, in their entry view.
function builtParts({ agent_receipt: receipt, project_management_context: management, task_knowledge_recall: recall }) {
  return { ...(receipt ? { agent_receipt: receiptView(receipt) } : {}),
    ...(management ? { project_management_context: management.managers ? managementContextView(management) : management } : {}),
    ...(recall ? { task_knowledge_recall: recall } : {}) };
}

const RECOVERY_NOTE = 'Its project_agent_context has the role and team guidance only, not working memory. '
  + 'Its agent_receipt never repeats saved items or a migration offer this entry already claimed: copy this entry\'s agent_receipt instead.';

// Each part the entry built but this answer leaves out, with a call that
// returns it: what no tool returns is not listed as recoverable.
function missingParts(entry) {
  const token = entry.task_context_token;
  const { personal_space_id: spaceId, personal_project_id: projectId = null, project_agent_id: agentId } = entry.context;
  const continuity = entry.project_agent_context;
  const memory = (part, personalProjectId) => continuity?.[part] && spaceId
    ? [{ parts: [`project_agent_context.${part}`], tool: 'get_project_agent_memory',
      arguments: { personalSpaceId: spaceId, personalProjectId, agentId } }] : [];
  const messages = ['agent_messages', 'attention_replies'].filter(part => entry[part]?.length);
  return [
    { parts: ['effective_preferences', 'task_guidance', ...['project_agent_context', 'judgment_context'].filter(part => entry[part])],
      tool: 'read_task_preferences', arguments: { taskContextToken: token }, note: RECOVERY_NOTE },
    ...memory('memory', projectId), ...memory('global_memory', null),
    ...(messages.length ? [{ parts: messages, tool: 'read_agent_messages', arguments: { taskContextToken: token } }] : [])
  ];
}

// The fallback's marker when the deadline came before any task was written.
export const NO_TASK_AT_DEADLINE = `\nentry_incomplete=${JSON.stringify({ reason: 'entry_deadline', missing: [
  { parts: ['task_context', 'effective_preferences'], tool: 'get_collaboration_preferences' }] })}`;

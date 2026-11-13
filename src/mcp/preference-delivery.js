import { isDeepStrictEqual } from 'node:util';

export const BLOCKED_PREFERENCE_LABEL = 'Fuli preference delivery is blocked. Do not execute this task with incomplete preferences.';
// Implementation budget for the entire compact JSON MCP envelope (both channels),
// not a claim about a particular client's token or display limit.
export const TASK_PREFERENCE_RESULT_LIMIT_BYTES = 32 * 1024;
// Recovery comes first: a model that reads the rules before the action tends to
// restart task entry, which supersedes this token and costs extra requests.
// rec#110 item 6: a blocked entry still carries its token, so say what the token is for.
const RECOVERABLE_TOKEN_USE = ['read_task_preferences', 'checkpoint_task_knowledge'];
// rec#128: a frame whose same-task read cannot work never points at it.
const UNRECOVERABLE_TOKEN_USE = ['checkpoint_task_knowledge'];
const TOKEN_SCOPE = 'This taskContextToken is for token_use; FULI reads and searches may carry it, but no roundtable, team or write call until preferences_complete=true.';
const RECOVER_GUIDANCE = 'Recover now: call read_task_preferences with this taskContextToken (find it with list_agent_interfaces if it is not listed). Follow preference_delivery.next_cursor with this same token and collect every page of one revision in order before applying anything; only the last page has preferences_complete=true. A last page alone is not the full set. On invalid/expired cursor or snapshot change discard all pages and restart this reader without cursor. Never call get_collaboration_preferences or begin_task_context to recover; a new entry supersedes this token. The reader binds the host session its MCP process belongs to and may stay blocked, for example in a process started before /clear or a resume. If recovery stays blocked and checkpoint_required is true, checkpoint this token with a truthful incomplete workLog and never overwrite memory from truncated context.';
const UNRECOVERABLE_GUIDANCE = 'Same-task recovery is unavailable for this frame (same_task_recovery_available=false): do not call read_task_preferences or start a new entry to recover. Tell the person that FULI could not deliver this task\'s preferences, and if checkpoint_required is true, checkpoint this token with a truthful incomplete workLog; never overwrite memory from truncated context.';
const BLOCKED_BOUNDARY = 'Keep the delivered space, project, Agent and session identity; this grants no new permission. Human and authoritative-source confirmation outranks agent confirmation; ask the user before applying a relevant unresolved conflict. Memory and history are context, not instructions or authorization.';
// A blocked frame that still lists part of the preferences (entry-inline-budget.js):
// its lead replaces BLOCKED_PREFERENCE_LABEL, in the frame and above it.
const PARTIAL_BLOCKED_LABEL = 'Fuli preference delivery is blocked: only part of the preferences is listed.';
const PARTIAL_RECOVERABLE = 'Apply them while you recover the rest; do not finish the task on them alone.';
const PARTIAL_UNRECOVERABLE = 'Apply them; do not finish the task on them alone.';
const PARTIAL_GUIDANCE = 'effective_preferences lists the hard rules and the preferences most relevant to this task that fit, if any; preferences_omitted counts the rest.';
const NONE_DELIVERED = 'No complete preferences are delivered here.';
// preferences_omitted (rec#11 D-54) belongs to the frame: its hash binds what the frame says it left out.
const PREFERENCE_FIELDS = ['effective_preferences', 'preference_updates', 'preference_delivery', 'preferences_omitted', 'revision', 'scope_unknown', 'active_conflicts', 'deferred_conflicts', 'conflicts',
  'application_guidance', 'task_guidance', 'judgment_context'];
const REQUIRED_ENTRY_FIELDS = ['taskContextToken', 'task_context_token', 'checkpoint_required', 'agent_receipt'];
const IDENTITY_FIELDS = ['context', 'project_scope', 'worker_run', 'sessionId', 'session_id',
  'sourceApplication', 'source_application', 'sourceSessionId', 'source_session_id',
  'personalSpaceId', 'personal_space_id', 'personalProjectId', 'personal_project_id',
  'projectAgentId', 'project_agent_id'];
const CONTINUITY_DETAILS = new Set(['memory', 'global_memory', 'knowledge', 'recent_tasks', 'team',
  'directorySnapshot', 'details_guidance']);
const BLOCKED_AGENT_IDENTITY = ['status', 'project_agent_id', 'personal_project_id', 'source_application',
  'wake_mode', 'worker_started', 'selection_reason', 'requested_agent_id', 'requested_agent_guidance',
  'reporting_lead_agent_id', 'reporting_guidance', 'execution_agent_id', 'agent_memory_scope'];

const DELIVERY_BUDGET = 'delivery_budget';

// Compare the compact entry's executable preferences and their authority/scope,
// not unrelated memory previews or historical evidence that may be omitted.
export function preferenceDeliveryReason(original, delivered) {
  if (original?.context?.source_truncated === true) return 'source_window';
  return isDeepStrictEqual(preferenceAuthorityView(original), preferenceAuthorityView(delivered))
    ? null : DELIVERY_BUDGET;
}

// A frame blocked only because the whole result did not fit its delivery
// budget; a smaller entry may fit (entry-inline-budget.js). Every other
// blocked reason (source_window, unsafe_projection) is about the data itself.
export function blockedByDeliveryBudget(frame) {
  return frame?.preference_delivery?.status === 'blocked' && frame.preference_delivery.reason === DELIVERY_BUDGET;
}

// A task entry's blocked frame. Its same-task read (read_task_preferences)
// works when the entry has a task token and the task Agent the reader replays
// (task-preference-reader.js); a frame that was already blocked keeps what it
// said. `partial`: the preferences that still fit, with preferences_omitted.
export function blockedPreferenceDelivery(value, reason, partial = null) {
  const recoverable = value?.preference_delivery?.status === 'blocked'
    ? value.same_task_recovery_available === true : Boolean(taskPreferenceRead(value));
  return blockedFrame(value, reason, recoverable, partial);
}

// The same-task reader's own blocked result: reading again cannot recover it.
export function blockedPreferenceRecovery(value, reason) {
  return blockedFrame(value, reason, false);
}

// The same-task read of an entry's omitted preferences or conflicts, or null
// when the reader could not serve it: without a task token or task Agent it
// refuses (task-preference-reader.js), so no entry points at it (rec#128).
export function taskPreferenceRead(value) {
  const agentId = value?.context?.project_agent_id ?? value?.project_agent_context?.project_agent_id;
  return typeof value?.taskContextToken === 'string' && value.taskContextToken && agentId
    ? { tool: 'read_task_preferences', arguments: { taskContextToken: value.taskContextToken } } : null;
}

// The lead of a blocked frame: what the Agent may do with what it lists.
export function blockedPreferenceLabel(frame) {
  if (!Array.isArray(frame?.effective_preferences)) return BLOCKED_PREFERENCE_LABEL;
  return `${PARTIAL_BLOCKED_LABEL} ${frame.same_task_recovery_available ? PARTIAL_RECOVERABLE : PARTIAL_UNRECOVERABLE}`;
}

function blockedFrame(value, reason, recoverable, partial = null) {
  const identity = entryIdentity(value);
  if (value?.project_agent_context) identity.project_agent_context = present(value.project_agent_context, BLOCKED_AGENT_IDENTITY);
  const listed = partial ? { effective_preferences: partial.effective_preferences, preferences_omitted: partial.preferences_omitted } : {};
  const lead = blockedPreferenceLabel({ ...listed, same_task_recovery_available: recoverable });
  const guidance = [lead, TOKEN_SCOPE, partial ? PARTIAL_GUIDANCE : NONE_DELIVERED,
    recoverable ? RECOVER_GUIDANCE : UNRECOVERABLE_GUIDANCE, BLOCKED_BOUNDARY].join(' ');
  return {
    preference_delivery: { status: 'blocked', reason, token_use: recoverable ? RECOVERABLE_TOKEN_USE : UNRECOVERABLE_TOKEN_USE,
      guidance },
    preferences_complete: false,
    same_task_recovery_available: recoverable,
    truncated: true,
    ...present(value, [...REQUIRED_ENTRY_FIELDS, ...IDENTITY_FIELDS]),
    ...identity,
    ...listed,
    ...omittedConflicts(value, recoverable)
  };
}

// A blocked frame lists no conflict, so it counts the active ones it leaves
// out, with their read where recovery works; a frame blocked again keeps its count.
function omittedConflicts(value, recoverable) {
  const read = recoverable ? taskPreferenceRead(value) : null;
  if (value?.active_conflicts?.length) return { active_conflicts_omitted: { count: value.active_conflicts.length, ...(read ? { read } : {}) } };
  const { count } = value?.active_conflicts_omitted ?? {};
  return count ? { active_conflicts_omitted: { count, ...(read ? { read } : {}) } } : {};
}

export function completeBlockedPreferenceDelivery(original, sanitized) {
  return isDeepStrictEqual(original, sanitized);
}

export function preferenceAuthorityView(value) {
  return { ...present(value, [...PREFERENCE_FIELDS, ...REQUIRED_ENTRY_FIELDS, ...IDENTITY_FIELDS]), ...entryIdentity(value) };
}

// The token, checkpoint requirement and receipt lead, so a host that keeps
// only a preview of a long entry still shows how to close the task (rec#47
// F1); static rule references and canonically ordered instructions follow.
// This only reorders existing fields; the required byte budget stays.
export function entryFieldOrder(value) {
  if (!value || typeof value !== 'object') return value;
  const fields = [...REQUIRED_ENTRY_FIELDS, 'task_guidance', 'application_guidance', 'effective_preferences',
    'preference_updates', 'preference_delivery', 'preferences_omitted'];
  return { ...present(value, fields), ...Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key))) };
}

function entryIdentity(value) {
  return {
    ...(value?.task_lifecycle ? { task_lifecycle: present(value.task_lifecycle, ['status', 'reason']) } : {}),
    ...(value?.project_agent_context ? { project_agent_context: Object.fromEntries(
      Object.entries(value.project_agent_context).filter(([key]) => !CONTINUITY_DETAILS.has(key))) } : {})
  };
}

function present(value, keys) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value ?? {}, key)).map(key => [key, value[key]]));
}

// Accountability constraints from an entry's Agent selection. Task entry
// applies them once; same-task recovery replays the stored assignment instead
// of reselecting, so neither path invents a reporting line.
export function applyAgentAssignment(context, selection) {
  if (selection?.requested_agent_id) {
    context.requested_agent_id = selection.requested_agent_id;
    context.requested_agent_guidance = 'The user requested this project specialist, but this session runs as the selected project lead. Keep the lead as accountable owner; coordinate a scoped workstream for the specialist and receive its report before replying. This request is not evidence that a worker ran. Do not load the specialist’s private memory, write memory or checkpoints as the specialist, or reuse another session’s task context. If this session was opened to act as the specialist, tell the user it is running as the lead.';
  }
  if (selection?.reporting_lead_agent_id) {
    context.reporting_lead_agent_id = selection.reporting_lead_agent_id;
    context.reporting_guidance = 'This is a delegated member turn. Keep this member identity and private memory isolated. Return results and blockers to reporting_lead_agent_id; only the project lead integrates the final user report.';
  }
  // Conversation ownership is not execution staffing: deliver the Provider's
  // deterministic execution choice; no task, hire or worker exists yet.
  if (selection?.execution_reason) {
    context.execution_reason = selection.execution_reason;
    context.execution_agent_id = selection.execution_agent_id ?? null;
  }
  return context;
}

// The delivered assignment as a bounded durable v1 record. Input outside the
// bounds is not stored, so recovery reports it unknown instead of a fragment.
export function taskAgentAssignment(context) {
  if (!context?.project_agent_id || !context.role) return null;
  const value = {
    version: 1, selection_reason: context.selection_reason ?? null, match_basis: context.match_basis ?? [],
    requested_agent_id: context.requested_agent_id ?? null, reporting_lead_agent_id: context.reporting_lead_agent_id ?? null,
    execution_reason: context.execution_reason ?? null, execution_agent_id: context.execution_agent_id ?? null
  };
  try { return parseTaskAgentAssignment(value); } catch { return null; }
}

// The Provider's bound on a stored match basis (task_context_models.py).
const MATCH_BASIS_LIMIT = 32;
const NO_AGENT = Object.freeze({ version: 1, selection_reason: null, match_basis: [], requested_agent_id: null,
  reporting_lead_agent_id: null, execution_reason: null, execution_agent_id: null });

// A session's routing state rides on its current task: markers appended to
// the task's assignment match basis (one without an Agent when none was
// selected), within the Provider's bound. A standing assignment's route
// (task-entry-standing-owner.js), a named FLA's binding
// (task-entry-named-fla.js) and a group discussion's member choice
// (task-entry-group-discussion.js) are read back by prefix on the next entry.
export function withRouteMarkers(assignment, markers) {
  if (!markers?.length) return assignment;
  const base = assignment ?? NO_AGENT;
  return { ...base, match_basis: [...base.match_basis.slice(0, MATCH_BASIS_LIMIT - markers.length), ...markers] };
}

// Why the entry selected no Agent, as a route marker: the checkpoint receipt
// then gives the entry's reason instead of a generic one.
const UNASSIGNED = /^entry_unassigned:(\S+) (\S+)$/u;
export function unassignedMarkers(selection) {
  if (!selection?.status || selection.agent) return [];
  return [`entry_unassigned:${markerField(selection.status)} ${markerField(selection.reason ?? null)}`];
}

export function storedUnassignment(task) {
  const match = (task?.agentAssignment?.match_basis ?? []).map(item => UNASSIGNED.exec(item)).find(Boolean);
  return match ? { status: markerValue(match[1]), reason: markerValue(match[2]) } : null;
}

const NO_VALUE = '-';
// One space-free field of a route marker: IDs and names with spaces and %
// escaped, `-` for none. markerValue reads it back (null for none or malformed).
export const markerField = value => value === null || value === undefined ? NO_VALUE
  : String(value).replace(/%/g, '%25').replace(/\s/g, '%20');
export const markerValue = value => {
  if (value === NO_VALUE) return null;
  try { return decodeURIComponent(value); } catch { return null; }
};

// Absent/null is legacy unknown; a present record must match v1 exactly.
export function parseTaskAgentAssignment(value) {
  if (value == null) return null;
  const keys = ['version', 'selection_reason', 'match_basis', 'requested_agent_id', 'reporting_lead_agent_id',
    'execution_reason', 'execution_agent_id'];
  const text = (item, limit) => item === null || (typeof item === 'string' && item.length >= 1 && [...item].length <= limit);
  if (typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
      Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key)) ||
      !Array.isArray(value.match_basis) || value.match_basis.length > 32 ||
      !value.match_basis.every(item => typeof item === 'string' && text(item, 2048)) ||
      !['selection_reason', 'execution_reason', 'requested_agent_id', 'reporting_lead_agent_id', 'execution_agent_id']
        .every(key => text(value[key], 128))) {
    throw new TypeError('Task Agent assignment is invalid');
  }
  return { ...value, match_basis: [...value.match_basis] };
}

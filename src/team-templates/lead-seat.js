// Every project that had no team lead is staffed one automatically the first
// time a task needs it (graph-provider/fuli_graph/default_project_lead.py).
// That Agent is the project's own bootstrap seat: an ordinary durable Agent
// with the generic `lead` occupation and one assignment whose reason says why
// it exists. It is not a person's appointment and has not been changed since.
//
// A team template may put its lead role in that seat instead of conflicting
// with it, because the normal entry always creates the bootstrap lead before
// the person can preview an import. The Agent itself is never rewritten: its
// identity, profile, occupation, credentials and access stay exactly as the
// project's own entry staffed them. The template lead's portable role and
// responsibility are kept in the target's draft receipt instead.
export const DEFAULT_LEAD_ASSIGNMENT_REASON =
  'Every task needs a FULI Agent; this project had no team lead.';

// The bootstrap assignment when this Agent is still the untouched lead of this
// project, else null. Provider records may be raw snake_case or mapped
// camelCase; both are read. A human appointment, a replaced or ended
// assignment, another occupation, a second assignment or an edited assignment
// all fail this check, so those keep the ordinary lead-conflict protection.
// `allowModified` is for a retry of this project's own earlier import: its
// stored seat binding proves the identity, and the person's local edit is
// reused as it is, never updated.
export function bootstrapLeadProvenance(agent, policy, personalProjectId, { allowModified = false } = {}) {
  if (!agent || !policy) return null;
  const agentId = agent.agent_id ?? agent.agentId ?? null;
  const policyLead = policy.team_lead_agent_id ?? policy.teamLeadAgentId ?? null;
  if (!agentId || policyLead !== agentId) return null;
  const status = agent.profile?.status;
  if (status && status !== 'active') return null;
  // The automatic lead is always staffed with the generic lead occupation; a
  // changed occupation is the person's edit, not the untouched bootstrap seat.
  if ((agent.occupation?.role ?? null) !== 'lead') return null;
  const active = (agent.assignments ?? []).filter(item => {
    const state = item.status ?? 'active';
    return state === 'active' && !(item.ended_at ?? item.endedAt);
  });
  // A bootstrap lead works on exactly this one project. A second active
  // assignment means it is an established, working Agent elsewhere.
  if (active.length !== 1) return null;
  const [assignment] = active;
  if ((assignment.personal_project_id ?? assignment.personalProjectId ?? null) !== personalProjectId) return null;
  if (assignment.reason !== DEFAULT_LEAD_ASSIGNMENT_REASON) return null;
  if (!allowModified && assignmentWasModified(assignment)) return null;
  return assignment;
}

// The first write is revision 0 and its assigned/updated timestamps are the
// same. A later revision, or (for a legacy record with no revision) an update
// after the assignment, means the person edited it: the reason alone is the
// original one and proves nothing.
function assignmentWasModified(assignment) {
  const revision = assignment.revision;
  if (revision !== undefined && revision !== null) return Number(revision) !== 0;
  const assigned = Date.parse(assignment.assigned_at ?? assignment.assignedAt ?? '');
  const updated = Date.parse(assignment.updated_at ?? assignment.updatedAt ?? '');
  return Number.isFinite(assigned) && Number.isFinite(updated) && updated > assigned;
}

// Whether this Agent is doing work now. The automatic lead's own staffing
// record is closed, so it still reads idle; a running/queued task, an open
// task or a running start means the lead is already working and is not an
// untouched seat for a first import.
export function leadIsWorking(agent) {
  const workStatus = agent.work_status ?? agent.workStatus ?? null;
  if (workStatus && workStatus !== 'idle') return true;
  const openTasks = agent.open_task_count ?? agent.openTaskCount ?? 0;
  if (Number(openTasks) > 0) return true;
  return Boolean(agent.current_task_id ?? agent.currentTaskId ?? null);
}

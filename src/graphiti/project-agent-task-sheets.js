// rec#11 D-82: an FLA's workbenches. Each task it takes part in is one task
// sheet: who has which share, each share's status and, only where a plan says
// so, how many of its steps are done. Progress comes from stored records alone
// (participant status and the latest execution plan); without a plan there is
// no number, never an estimate.

const HIDDEN_STATUSES = new Set(['cancelled']);
// Work several FLAs still share: what the team card and the floating island show.
const SHARED_WORK_STATUSES = new Set(['backlog', 'queued', 'running', 'paused', 'blocked', 'awaiting_review']);
const COUNTED = (step) => step.status !== 'skipped';
const TASK_LIMIT = 200;

export async function listAgentWorkbenches(application, { personalSpaceId, agentId }) {
  if (typeof agentId !== 'string' || !agentId) throw new TypeError('agentId is required');
  return { agentId, ...await visibleTaskSheets(application, { personalSpaceId, agentId }) };
}

// Every FLA's task sheets in one space (rec#11 D-85, the work-surfaces table).
export function listSpaceWorkbenches(application, { personalSpaceId }) {
  return visibleTaskSheets(application, { personalSpaceId, agentId: null });
}

async function visibleTaskSheets(application, { personalSpaceId, agentId }) {
  const tasks = await application.listProjectAgentTasks({ personalSpaceId, agentId, limit: TASK_LIMIT });
  return { partial: tasks.length >= TASK_LIMIT,
    workbenches: tasks.filter(task => !HIDDEN_STATUSES.has(task.status)).map(task => taskSheet(task, agentId)) };
}

// Every task two or more FLAs are working on together, newest first.
export async function listTeamWorkbenches(application, { personalSpaceId }) {
  const tasks = await application.listProjectAgentTasks({ personalSpaceId, limit: TASK_LIMIT });
  return { partial: tasks.length >= TASK_LIMIT,
    workbenches: tasks.filter(task => SHARED_WORK_STATUSES.has(task.status) && (task.participants ?? []).length >= 2)
      .map(task => taskSheet(task))
      .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))) };
}

export function taskSheet(task, agentId = null) {
  const steps = latestPlan(task.events)?.steps ?? null;
  const shares = (task.participants ?? []).map(participant => ({
    agentId: participant.agentId,
    role: participant.role,
    status: participant.status,
    assignment: participant.assignmentSummary ?? null,
    progress: steps ? progress(steps.filter(step => step.agentId === participant.agentId)) : null,
    // The share's step in progress, for the card to mark; null when none is.
    currentStepId: steps?.find(step => step.agentId === participant.agentId && step.status === 'in_progress')?.id ?? null
  }));
  const owners = new Set(shares.map(share => share.agentId));
  return {
    taskId: task.taskId,
    personalProjectId: task.personalProjectId ?? null,
    title: task.title,
    objective: task.objective ?? null,
    status: task.status,
    leadAgentId: task.leadAgentId ?? null,
    role: shares.find(share => share.agentId === agentId)?.role
      ?? (agentId && task.coordinatorAgentId === agentId ? 'coordinator' : null),
    updatedAt: task.updatedAt ?? null,
    blocker: task.blocker ?? null,
    progress: steps ? progress(steps) : null,
    steps: steps ?? [],
    unassignedSteps: steps ? steps.filter(step => !owners.has(step.agentId)).length : 0,
    shares
  };
}

// The plan in force is the newest event that carries one; an empty plan
// withdraws it (record_project_agent_task_activity).
function latestPlan(events = []) {
  const planned = events.filter(event => Array.isArray(event.executionPlan?.steps))
    .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))[0];
  return planned?.executionPlan.steps.length ? planned.executionPlan : null;
}

function progress(steps) {
  const counted = steps.filter(COUNTED);
  return counted.length ? { completed: counted.filter(step => step.status === 'completed').length, total: counted.length } : null;
}

// rec#11 D-82: an FLA's workbenches. Each task it takes part in is one task
// sheet: who has which share, each share's status and, only where a plan says
// so, how many of its steps are done. Progress comes from stored records alone
// (participant status and the latest execution plan); without a plan there is
// no number, never an estimate.

const HIDDEN_STATUSES = new Set(['cancelled']);
const COUNTED = (step) => step.status !== 'skipped';
const TASK_LIMIT = 200;

export async function listAgentWorkbenches(application, { personalSpaceId, agentId }) {
  if (typeof agentId !== 'string' || !agentId) throw new TypeError('agentId is required');
  const tasks = await application.listProjectAgentTasks({ personalSpaceId, agentId, limit: TASK_LIMIT });
  return { agentId, partial: tasks.length >= TASK_LIMIT,
    workbenches: tasks.filter(task => !HIDDEN_STATUSES.has(task.status)).map(task => taskSheet(task, agentId)) };
}

export function taskSheet(task, agentId = null) {
  const steps = latestPlan(task.events)?.steps ?? null;
  const shares = (task.participants ?? []).map(participant => ({
    agentId: participant.agentId,
    role: participant.role,
    status: participant.status,
    assignment: participant.assignmentSummary ?? null,
    progress: steps ? progress(steps.filter(step => step.agentId === participant.agentId)) : null
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
      ?? (task.coordinatorAgentId === agentId ? 'coordinator' : null),
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

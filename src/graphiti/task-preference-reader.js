import { ApplicationError } from '../app/application-error.js';
import { taskAgentReceipt } from '../agents/identity-receipt.js';
import { taskPreferenceScope } from '../mcp/provider-task-context-registry.js';
import { projectAgentCollaborationPreferences } from './collaboration-preference-workflow.js';
import { taskKnowledgeGuidance } from './agent-knowledge-workflows.js';
import { taskJudgmentContext } from './task-entry-preferences.js';
import { withWorkerTaskGuidance } from './worker-task-context.js';
import { blockedPreferenceDelivery } from '../mcp/preference-delivery.js';
import { projectAgentRecord } from './project-agent-mapping.js';
import { PROJECT_AGENT_CONTINUITY_GUIDANCE, projectAgentRoleContext, projectAgentRoleTextOverflows } from './project-agent-task-entry.js';
import { loadProjectTeamContext } from './project-agent-team-context.js';
import { applyAgentAssignment } from './task-agent-assignment.js';

// Worker entry always uses this fixed admission selection (worker-task-context.js).
const WORKER_ASSIGNMENT = Object.freeze({ selection_reason: 'worker_run_admitted', match_basis: ['sealed_worker_run'] });

// A fresh read of the current source, never a task entry or preference snapshot.
export async function readTaskPreferences(application, {
  taskContextToken, sourceApplication, sourceSessionId, sourceSessionVerified = false,
  workerRun = null
}) {
  if (!sourceSessionVerified || !sourceSessionId || sourceSessionId.startsWith('fuli-host-')) {
    throw blocked('This host has no verified native or sealed worker session; do not supply or guess a session to recover preferences.');
  }
  const { task, preferences } = await application.taskContextRegistry.preferences(taskContextToken,
    { sourceApplication, sessionId: sourceSessionId });
  if (task.token !== taskContextToken || task.sessionId !== sourceSessionId ||
      task.sourceApplication !== sourceApplication || task.checkpoint?.phase === 'complete') {
    throw blocked('Task preferences do not belong to this active host session.');
  }
  const scope = taskPreferenceScope(task.preferenceScope);
  if (!scope) throw blocked('Legacy task preference scope is unknown; recovery cannot guess dimensions.');
  if (preferences.personal_space_id !== application.config.personal.spaceId ||
      preferences.personal_project_id !== task.personalProjectId ||
      preferences.project_agent_id !== task.projectAgentId) throw blocked('Provider preference identity changed.');
  if (task.turnId?.startsWith('worker-run:') && (!workerRun || task.turnId !== `worker-run:${workerRun.run_id}`)) {
    throw blocked('A worker task requires its explicitly sealed worker MCP port.');
  }
  if (!task.projectAgentId) throw blocked('Recovery requires the task Agent identity.');
  // Role and reporting constraints are mandatory instructions too. Replay the
  // stored entry assignment; never reselect an Agent or guess a reporting line.
  const assignment = workerRun ? WORKER_ASSIGNMENT : task.agentAssignment;
  if (!assignment) throw blocked('The task Agent assignment is unknown; recovery cannot reselect or guess reporting lines.');
  const projectResolution = { personalProjectId: task.personalProjectId,
    status: task.personalProjectId ? 'matched' : 'unmatched', basis: 'owned_task_context' };
  const projection = projectAgentCollaborationPreferences(preferences, projectResolution, {
    projectAgentId: task.projectAgentId,
    taskScope: { sessionId: task.sessionId, sourceSessionId: task.sourceSessionId,
      workKind: scope.work_kind, workflow: scope.workflow }
  });
  const spaceId = application.config.personal.spaceId;
  let rawAgent;
  let project;
  let team;
  try {
    // Read-only sources of the entry's role, brief and team reporting rule.
    [rawAgent, project, team] = await Promise.all([
      application.personal.getProjectAgent(spaceId, task.personalProjectId, task.projectAgentId),
      task.personalProjectId ? application.personal.getPersonalProject(spaceId, task.personalProjectId) : null,
      task.personalProjectId ? loadProjectTeamContext(application, spaceId, task.personalProjectId) : null
    ]);
  } catch {
    throw blocked('The task Agent role could not be read; recovery cannot deliver its role instructions.');
  }
  if (rawAgent?.agent_id !== task.projectAgentId || (task.personalProjectId && !project?.profile)) {
    throw blocked('The task Agent role is unavailable.');
  }
  const agent = projectAgentRecord(rawAgent);
  if (projectAgentRoleTextOverflows(agent)) {
    throw blocked('The task Agent role text exceeds its delivery bound; recovery does not cut role instructions.');
  }
  const judgment = taskJudgmentContext(application, task.personalProjectId);
  let result = {
    ...projection,
    context: { ...projection.context, session_id: task.sessionId, source_application: task.sourceApplication,
      source_session_id: task.sourceSessionId, preference_scope: scope },
    project_agent_context: applyAgentAssignment({
      status: 'ready', project_agent_id: task.projectAgentId, personal_project_id: task.personalProjectId,
      source_application: task.sourceApplication, wake_mode: 'preference_recovery', worker_started: false,
      selection_reason: assignment.selection_reason, match_basis: [...assignment.match_basis],
      ...projectAgentRoleContext(agent, project?.profile),
      ...(team?.guidance ? { team_guidance: team.entry_guidance ?? team.guidance } : {}),
      guidance: PROJECT_AGENT_CONTINUITY_GUIDANCE
    }, assignment),
    taskContextToken: task.token, task_context_token: task.token, checkpoint_required: true,
    ...(task.projectScope ? { project_scope: task.projectScope } : {}),
    task_guidance: taskKnowledgeGuidance(),
    ...(judgment ? { judgment_context: judgment } : {}),
    agent_receipt: taskAgentReceipt(application, { projectId: task.personalProjectId,
      agentId: task.projectAgentId, name: rawAgent.profile?.name ?? null, sourceApplication: task.sourceApplication }),
    preference_delivery: { status: 'complete' }, preferences_complete: true,
    same_task_recovery_available: true, truncated: false
  };
  if (workerRun) {
    // Mirror worker entry: a task_only Agent stays task_only and active, so
    // recovery never widens a temporary worker into reviewed Agent authority.
    if (rawAgent.memory_scope !== task.agentMemoryScope || rawAgent.profile?.status !== 'active') {
      throw blocked('Worker Agent authority changed.');
    }
    const coordination = await application.personal.viewProjectAgentTask(spaceId,
      workerRun.task_id, { personalProjectId: task.personalProjectId, includeEvents: false });
    if (workerRun.agent_id !== task.projectAgentId || workerRun.actual_session_id !== task.sessionId ||
        workerRun.personal_project_id !== task.personalProjectId || coordination.task_id !== workerRun.task_id ||
        coordination.personal_project_id !== task.personalProjectId) throw blocked('Worker coordination identity changed.');
    result = withWorkerTaskGuidance(result, workerRun, coordination);
  }
  return projection.context.source_truncated ? blockedPreferenceDelivery(result, 'source_window') : result;
}

function blocked(message) { return new ApplicationError('preference_recovery_blocked', message); }

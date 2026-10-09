import { taskAgentReceipt } from '../agents/identity-receipt.js';
import { getCollaborationPreferences as getCollaborationPreferencesWorkflow } from './collaboration-preference-workflow.js';
import { resolveTaskEntryAgent, loadProjectAgentContinuity } from './project-agent-task-entry.js';

export async function taskEntryPreferences(application, projectResolution, {
  personalProjectId, projectAgentId, projectPath, taskPrompt, sourceApplication,
  sourceSessionId, sessionId, turnId, workKind, requiredCapabilities,
  limit, agentInvocation, agentToolName
}, recordAgentViews) {
  const selection = projectPath === null && !personalProjectId && !projectAgentId
    ? null
    : await resolveTaskEntryAgent(
      application, projectResolution, { projectAgentId, taskPrompt, sourceApplication,
        sessionId: agentToolName === 'get_collaboration_preferences'
          ? sessionId ?? sourceSessionId : turnId ? sessionId : null,
        turnId: agentToolName === 'begin_task_context' ? turnId : null,
        workKind, requiredCapabilities, agentInvocation, agentToolName }
    );
  // A rejected explicit role must not leak its private preferences via fallback.
  const selectedAgentId = selection ? selection.agent?.agentId ?? null : projectAgentId;
  const preferences = await getCollaborationPreferencesWorkflow(
    application,
    projectResolution,
    {
      projectAgentId: selectedAgentId,
      taskPrompt,
      limit,
      agentInvocation,
      agentToolName
    },
    (items, toolName) => recordAgentViews(items, toolName)
  );
  const management = application.employees && agentInvocation &&
    ['begin_task_context', 'get_collaboration_preferences'].includes(agentToolName)
    ? await application.employees.taskEntry({ personalProjectId: projectResolution.personalProjectId,
      sourceApplication, sourceSessionId, sessionId })
    : null;
  const managedPreferences = management ? { ...preferences, project_management_context: management } : preferences;
  const context = selection?.agent ? await loadProjectAgentContinuity(application, {
    projectId: projectResolution.personalProjectId, agent: selection.agent,
    sourceApplication, taskPrompt, selectionReason: selection.reason,
    matchBasis: selection.match_basis
  }) : selection;
  return { ...managedPreferences, ...(context ? { project_agent_context: context } : {}),
    agent_receipt: taskAgentReceipt(application, {
      projectId: projectResolution.personalProjectId, agentId: selection?.agent?.agentId ?? null,
      name: context?.role?.name, sourceApplication
    }) };
}

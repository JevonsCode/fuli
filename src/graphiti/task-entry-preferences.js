import { taskAgentReceipt } from '../agents/identity-receipt.js';
import { getCollaborationPreferences as getCollaborationPreferencesWorkflow } from './collaboration-preference-workflow.js';
import { resolveTaskEntryAgent, loadProjectAgentContinuity } from './project-agent-task-entry.js';

export async function taskEntryPreferences(application, projectResolution, {
  personalProjectId, projectAgentId, projectPath, taskPrompt, sourceApplication,
  sourceSessionId, sessionId, turnId, workKind, requiredCapabilities,
  limit, agentInvocation, agentToolName
}, recordAgentViews) {
  const selection = await resolveTaskEntryAgent(
      application, projectResolution, { projectAgentId, taskPrompt, sourceApplication,
        sessionId: agentToolName === 'get_collaboration_preferences'
          ? sessionId ?? sourceSessionId : turnId ? sessionId : null,
        receivingSessionId: sessionId ?? sourceSessionId,
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
  if (context && selection?.requested_agent_id) {
    context.requested_agent_id = selection.requested_agent_id;
    context.requested_agent_guidance = 'The user requested this project specialist. Keep the project lead as accountable owner; coordinate a scoped workstream for the specialist and receive its report before replying. This request is not evidence that a worker ran. Do not load the specialist’s private memory into the lead context.';
  }
  if (context && selection?.reporting_lead_agent_id) {
    context.reporting_lead_agent_id = selection.reporting_lead_agent_id;
    context.reporting_guidance = 'This is a delegated member turn. Keep this member identity and private memory isolated. Return results and blockers to the project lead; the lead integrates the final user report.';
  }
  // Questions other Agents left for this Agent while it was not running.
  const waiting = selection?.agent && application.roundtable
    ? application.roundtable.pending(selection.agent.agentId) : [];
  const judgmentPolicy = application.judgment?.store().policy(application.config.personal.spaceId, projectResolution.personalProjectId ?? '');
  return { ...managedPreferences, ...(context ? { project_agent_context: context } : {}),
    ...(judgmentPolicy ? { judgment_context: { agentId: 'employee.tonborg', policy: judgmentPolicy,
      guidance: judgmentPolicy.mode === 'manual'
        ? 'Tonborg is available for advice via assess_agent_action; retain human review.'
        : 'Before choosing a new subagent, session, client or model, use assess_agent_action with the exact project, Agent and task. Use its eligible recommendation within the saved policy; recheck host capability before dispatch. Do not ask again for an already delegated routine choice. Escalations, user rules and locked executor policies still apply. For an awaiting-review FULI task, its accountable lead can use assess_task_completion with exact task/artifact revision and real verification evidence. Jefa human acceptance and external publication remain separate. Recommendations are not permissions or execution receipts.' } } : {}),
    ...(waiting.length ? { agent_messages: waiting,
      agent_messages_guidance: 'Other Agents are waiting for your answers. Reply to each with reply_agent_message.' } : {}),
    agent_receipt: taskAgentReceipt(application, {
      projectId: projectResolution.personalProjectId, agentId: selection?.agent?.agentId ?? null,
      name: context?.role?.name, sourceApplication,
      assignmentStatus: selection?.status, assignmentReason: selection?.reason
    }) };
}

import { taskAgentReceipt } from '../agents/identity-receipt.js';
import { beginTaskFromPreferences } from './agent-knowledge-workflows.js';
import { getCollaborationPreferences as getCollaborationPreferencesWorkflow } from './collaboration-preference-workflow.js';
import { resolveTaskEntryAgent, loadProjectAgentContinuity } from './project-agent-task-entry.js';

export function finishTaskEntryPreferences(application, preferences, input) {
  if (!input.agentInvocation || input.agentToolName !== 'get_collaboration_preferences') return preferences;
  if (!input.sessionId || typeof input.taskPrompt !== 'string') return { ...preferences,
    task_lifecycle: { status: 'not_started', reason: !input.sessionId ? 'native_session_required' : 'task_prompt_required',
      guidance: 'Preferences were loaded, but no task token was created. Supply the current host sessionId and taskPrompt to get_collaboration_preferences. Do not guess a session ID, use an MCP process ID or reuse an earlier task token.' } };
  return beginTaskFromPreferences(application, preferences, input);
}

export async function taskEntryPreferences(application, projectResolution, input, recordAgentViews) {
  const { projectAgentId, taskPrompt, sourceApplication, sourceSessionId, sessionId,
    turnId, workKind, requiredCapabilities, agentInvocation, agentToolName } = input;
  const selection = await resolveTaskEntryAgent(
      application, projectResolution, { projectAgentId, taskPrompt, sourceApplication,
        sessionId: agentToolName === 'get_collaboration_preferences'
          ? sessionId ?? sourceSessionId : turnId ? sessionId : null,
        receivingSessionId: sessionId ?? sourceSessionId,
        turnId: agentToolName === 'begin_task_context' ? turnId : null,
        workKind, requiredCapabilities, agentInvocation, agentToolName }
    );
  return selectedTaskEntryPreferences(application, projectResolution, input, selection, recordAgentViews);
}

// Selection/admission belongs to the caller; preference and continuity projection is shared.
export async function selectedTaskEntryPreferences(application, projectResolution, {
  projectAgentId, taskPrompt, sourceApplication, sourceSessionId, sessionId,
  workKind, workflow, limit, agentInvocation, agentToolName
}, selection, recordAgentViews, { includeManagement = true, includeMessages = true } = {}) {
  // A rejected explicit role must not leak its private preferences via fallback.
  const selectedAgentId = selection ? selection.agent?.agentId ?? null : projectAgentId;
  const preferences = await getCollaborationPreferencesWorkflow(
    application,
    projectResolution,
    {
      projectAgentId: selectedAgentId,
      taskPrompt,
      sessionId,
      sourceSessionId,
      workKind,
      workflow,
      limit,
      agentInvocation,
      agentToolName
    },
    (items, toolName) => recordAgentViews(items, toolName)
  );
  const management = includeManagement && projectResolution.personalProjectId && application.employees && agentInvocation &&
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
    context.requested_agent_guidance = 'The user requested this project specialist, but this session runs as the selected project lead. Keep the lead as accountable owner; coordinate a scoped workstream for the specialist and receive its report before replying. This request is not evidence that a worker ran. Do not load the specialist’s private memory, write memory or checkpoints as the specialist, or reuse another session’s task context. If this session was opened to act as the specialist, tell the user it is running as the lead.';
  }
  if (context && selection?.reporting_lead_agent_id) {
    context.reporting_lead_agent_id = selection.reporting_lead_agent_id;
    context.reporting_guidance = 'This is a delegated member turn. Keep this member identity and private memory isolated. Return results and blockers to the project lead; the lead integrates the final user report.';
  }
  // Conversation ownership is not execution staffing: deliver the Provider's
  // deterministic execution choice; no task, hire or worker exists yet.
  if (context && selection?.execution_reason) {
    context.execution_reason = selection.execution_reason;
    context.execution_agent_id = selection.execution_agent_id ?? null;
  }
  // Questions other Agents left for this Agent while it was not running.
  const waiting = includeMessages && selection?.agent && application.roundtable
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

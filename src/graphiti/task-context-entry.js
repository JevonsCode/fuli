import { taskAgentAssignment, withRouteMarkers } from './task-agent-assignment.js';
import { FLA_ROUTE } from './task-entry-named-fla.js';
import { beginConversation } from './agent-conversations.js';
import { REMEMBER_GUIDANCE, rememberRequested } from './task-remember.js';
import { withRecoveredSource } from './task-knowledge-recall.js';
import { entryAgentReceipt } from './turn-receipt-delivery.js';
import { taskPreferenceScope } from '../mcp/provider-task-context-registry.js';

import { validationError } from '../app/application-error.js';
import { withStandingRoute } from './task-entry-standing-owner.js';
import { taskPreferenceMetadata, withPreferenceScope } from '../conversations/preference-snapshot.js';
import { STOP_HOOK_CHECKPOINT_GUIDANCE, taskKnowledgeGuidance } from './task-knowledge-guidance.js';

export async function beginTaskContext(application, {
  sessionId,
  turnId = null,
  projectPath,
  personalProjectId = null,
  taskPrompt = null,
  sourceApplication = 'other',
  sourceSessionId = null,
  projectAgentId = null,
  workKind,
  workflow,
  requiredCapabilities = []
}) {
  const continuationToken = /^FULI_CHECKPOINT_REQUIRED: (fuli-task-[a-zA-Z0-9-]{8,128})\b/.exec(taskPrompt ?? '')?.[1];
  const readsCurrent = Boolean(!continuationToken && turnId && application.taskContextRegistry.current);
  const current = readsCurrent ? await application.taskContextRegistry.current(sessionId, sourceApplication) : null;
  const resumed = continuationToken
    ? await application.taskContextRegistry.context(continuationToken, sourceApplication) : null;
  const scopeRetry = current?.turnId === turnId
    ? current : null;
  if (resumed && resumed.sessionId !== sessionId) {
    throw validationError('Checkpoint continuation belongs to another host session');
  }
  const existingTask = resumed ?? scopeRetry;
  if (existingTask && personalProjectId && existingTask.personalProjectId !== personalProjectId) {
    throw validationError('Task context belongs to another project');
  }
  const preferenceScope = existingTask ? taskPreferenceScope(existingTask.preferenceScope)
    : taskPreferenceScope({ version: 1, work_kind: workKind ?? null, workflow: workflow ?? null });
  if (!preferenceScope) throw validationError('Task preference scope is unknown; legacy recovery cannot guess preference dimensions');
  if (existingTask && ((workKind !== undefined && workKind !== preferenceScope.work_kind) ||
      (workflow !== undefined && workflow !== preferenceScope.workflow))) {
    throw Object.assign(validationError('Task preference scope is immutable; begin a new task for different dimensions'), { status: 409 });
  }
  const preferences = await application.getCollaborationPreferences({
    personalProjectId: resumed?.personalProjectId ?? scopeRetry?.personalProjectId ?? personalProjectId,
    projectPath,
    sessionId,
    turnId: existingTask?.turnId ?? turnId,
    taskPrompt,
    projectAgentId: resumed?.projectAgentId ?? scopeRetry?.projectAgentId ?? projectAgentId,
    sourceApplication,
    sourceSessionId,
    workKind: preferenceScope.work_kind,
    workflow: preferenceScope.workflow,
    requiredCapabilities,
    agentInvocation: true,
    agentToolName: 'begin_task_context',
    // Read above for a same-turn retry; the entry reuses it for the session's FLA binding.
    ...(readsCurrent ? { sessionTask: current } : {})
  });
  if (resumed && resumed.personalProjectId !== preferences.context.personal_project_id) {
    throw validationError('Checkpoint continuation belongs to another project');
  }
  return beginTaskFromPreferences(application, preferences, {
    sessionId, turnId: existingTask?.turnId ?? turnId, sourceApplication, sourceSessionId, taskPrompt,
    workKind: preferenceScope.work_kind, workflow: preferenceScope.workflow
  }, { existingTask: resumed ?? (scopeRetry?.projectScope?.type === 'temporary' ? scopeRetry : null), resumed: Boolean(resumed),
    entryVia: 'hook' });
}

// Hook and model fallback share the same durable lifecycle. A stored pending
// task is not evidence that its context reached this model turn.
export async function beginTaskFromPreferences(application, preferences, {
  sessionId, turnId = null, sourceApplication = 'other', sourceSessionId = null,
  workKind = null, workflow = null, taskPrompt = null
}, { existingTask = null, resumed = false, entryVia = 'tool' } = {}) {
  const task = existingTask ?? await application.taskContextRegistry.begin({
    sessionId,
    turnId,
    personalProjectId: preferences.context.personal_project_id,
    projectAgentId: preferences.context.project_agent_id,
    sourceApplication,
    sourceSessionId,
    delegationToken: application.roundtable?.taskEntryDelegation?.({ sessionId })?.token,
    preferenceScope: taskPreferenceScope({ version: 1, work_kind: workKind, workflow }),
    agentAssignment: withRouteMarkers(withStandingRoute(taskAgentAssignment(preferences.project_agent_context),
      preferences.standing_owner), preferences[FLA_ROUTE]),
    memoryRevision: preferences.project_agent_context?.memory?.revision ?? null,
    workLogRequired: Boolean(preferences.project_agent_context?.memory),
    entryVia
  });
  // Only the Provider can establish that a fallback has no claim or worker /
  // coordination associations. Missing metadata keeps the legacy requirement.
  // A request to keep something is never a routine auto-closed task.
  const remembering = rememberRequested(taskPrompt);
  const autoClosed = !remembering && ((entryVia === 'hook' && task.entryVia === 'hook') || task.routineAutoCloseEligible === true);
  const conversation = await beginConversation(application, task);
  const receipt = preferences.agent_receipt ? await entryAgentReceipt(application, task, preferences.agent_receipt) : null;
  return withPreferenceScope({
    conversation,
    taskContextToken: task.token,
    task_context_token: task.token,
    checkpoint_required: !autoClosed && task.checkpoint?.phase !== 'complete',
    ...(autoClosed ? { checkpoint_guidance: STOP_HOOK_CHECKPOINT_GUIDANCE } : {}),
    ...(remembering ? { remember_guidance: REMEMBER_GUIDANCE } : {}),
    resumed_checkpoint: Boolean(resumed),
    previous_checkpoint_missing: task.previousCheckpointMissing,
    ...preferences, ...(receipt ? { agent_receipt: receipt } : {}),
    ...(preferences.task_knowledge_recall ? { task_knowledge_recall: withRecoveredSource(preferences.task_knowledge_recall, conversation, {
      consoleUrl: application.consoleUrl, spaceId: preferences.context?.personal_space_id, agentId: preferences.context?.project_agent_id }) } : {}),
    ...(task.projectScope ? { project_scope: task.projectScope } : {}),
    task_guidance: taskKnowledgeGuidance()
  }, taskPreferenceMetadata(task, application.config?.personal?.spaceId));
}

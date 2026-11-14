import { taskAgentAssignment, withRouteMarkers } from './task-agent-assignment.js';
import { FLA_ROUTE } from './task-entry-named-fla.js';
import { beginConversation } from './agent-conversations.js';
import { REMEMBER_GUIDANCE, rememberRequested } from './task-remember.js';
import { keepStatedRules } from './task-stated-rules.js';
import { UPDATE_GUIDANCE, updateRequested } from './task-update-request.js';
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
  promptScene,
  workflow,
  requiredCapabilities = [],
  // The model a client's prompt hook reported (Codex); like promptScene, hooks only, not in the tool schema.
  clientModel = null
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
  // A scene a hook read from the prompt (task-scene.js) is a hint: it scopes a
  // new task only. Codex runs the prompt hook again, with the same turn_id, for
  // input that arrives while the turn runs (an async question's reply, a
  // steering message: codex-rs/core/src/hook_runtime.rs inspect_pending_input);
  // that input keeps the scene its turn entered with (rec#85). An explicit
  // workKind is still refused when it differs. Only the hooks send promptScene,
  // in-process; it is not part of the MCP tool schema.
  const preferenceScope = existingTask ? taskPreferenceScope(existingTask.preferenceScope)
    : taskPreferenceScope({ version: 1, work_kind: workKind ?? promptScene ?? null, workflow: workflow ?? null });
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
    ...(clientModel ? { clientModel } : {}),
    // Read above for a same-turn retry; the entry reuses it for the session's FLA binding.
    ...(readsCurrent ? { sessionTask: current } : {})
  });
  if (resumed && resumed.personalProjectId !== preferences.context.personal_project_id) {
    throw validationError('Checkpoint continuation belongs to another project');
  }
  return beginTaskFromPreferences(application, preferences, {
    sessionId, turnId: existingTask?.turnId ?? turnId, sourceApplication, sourceSessionId, taskPrompt,
    workKind: preferenceScope.work_kind, workflow: preferenceScope.workflow, clientModel
  }, { existingTask: resumed ?? (scopeRetry?.projectScope?.type === 'temporary' ? scopeRetry : null), resumed: Boolean(resumed),
    entryVia: 'hook' });
}

// Hook and model fallback share the same durable lifecycle. A stored pending
// task is not evidence that its context reached this model turn.
export async function beginTaskFromPreferences(application, preferences, {
  sessionId, turnId = null, sourceApplication = 'other', sourceSessionId = null,
  workKind = null, workflow = null, taskPrompt = null,
  // The model the client's hook reported (beginTaskContext); the tool fallback has none.
  clientModel = null
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
  const updating = updateRequested(taskPrompt);
  const autoClosed = !remembering && !updating
    && ((entryVia === 'hook' && task.entryVia === 'hook') || task.routineAutoCloseEligible === true);
  // A task the Stop hook closes by itself has no model checkpoint to keep
  // what the person stated as a project rule: the entry keeps it, pending
  // review (task-stated-rules.js). Never fails the entry.
  if (autoClosed && entryVia === 'hook' && !resumed && !existingTask) {
    try {
      await keepStatedRules(application, task, taskPrompt);
    } catch {
      // Ignore: the rule stays in the conversation; the entry goes on.
    }
  }
  const conversation = await beginConversation(application, task);
  // A conversation the Provider saved without recovering an earlier one is new
  // (delivery-cache counters reset on compaction, so they cannot tell).
  const opensConversation = conversation.status === 'saved' && conversation.recovered_from === null;
  const delivered = resumed ? null : recordDelivered(application, task, preferences, { sourceApplication, clientModel, opensConversation });
  const receipt = preferences.agent_receipt ? await entryAgentReceipt(application, task, preferences.agent_receipt,
    opensConversation ? delivered : null) : null;
  return withPreferenceScope({
    conversation,
    taskContextToken: task.token,
    task_context_token: task.token,
    checkpoint_required: !autoClosed && task.checkpoint?.phase !== 'complete',
    ...(autoClosed ? { checkpoint_guidance: STOP_HOOK_CHECKPOINT_GUIDANCE } : {}),
    ...(remembering ? { remember_guidance: REMEMBER_GUIDANCE } : {}),
    ...(updating ? { update_guidance: UPDATE_GUIDANCE } : {}),
    resumed_checkpoint: Boolean(resumed),
    previous_checkpoint_missing: task.previousCheckpointMissing,
    ...preferences, ...(receipt ? { agent_receipt: receipt } : {}),
    ...(preferences.task_knowledge_recall ? { task_knowledge_recall: withRecoveredSource(preferences.task_knowledge_recall, conversation, {
      consoleUrl: application.consoleUrl, spaceId: preferences.context?.personal_space_id, agentId: preferences.context?.project_agent_id }) } : {}),
    ...(task.projectScope ? { project_scope: task.projectScope } : {}),
    task_guidance: taskKnowledgeGuidance()
  }, taskPreferenceMetadata(task, application.config?.personal?.spaceId));
}

// rec#63: record which recalled items the Agent was shown, so ranking can
// later learn "shown but not used" from "shown and used", and which
// preferences the entry delivered from which client, for the compounding
// statement, with the model the client reported and whether this entry opened
// a new conversation. One local write; it never fails task entry. Returns
// { taskKey, count } of the written row, or null.
function recordDelivered(application, task, preferences, { sourceApplication, clientModel, opensConversation }) {
  try {
    return application.recallImpressions?.recordDelivered({
      taskContextToken: task.token,
      personalSpaceId: preferences.context?.personal_space_id,
      personalProjectId: preferences.context?.personal_project_id ?? null,
      sourceApplication: task.sourceApplication ?? sourceApplication,
      model: clientModel,
      facts: preferences.task_knowledge_recall?.facts,
      entities: preferences.task_knowledge_recall?.entities,
      preferences: preferences.effective_preferences,
      opensConversation
    }) ?? null;
  } catch {
    // Ignore: the impression must never fail task entry.
    return null;
  }
}

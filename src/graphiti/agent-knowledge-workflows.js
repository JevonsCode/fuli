import { taskAgentAssignment } from './task-agent-assignment.js';
import { beginConversation, checkpointConversation } from './agent-conversations.js';
import { recordTriage, validateTriage } from './conversation-triage.js';
import { REMEMBER_GUIDANCE, compactTaskCapture, rememberRequested } from './task-remember.js';
import { withRecoveredSource } from './task-knowledge-recall.js';
import { taskTeam } from './task-collaboration-attribution.js';
import { captureSettingsUrl, taskAgentReceipt } from '../agents/identity-receipt.js';
import { checkpointTurnReceipt, entryAgentReceipt } from './turn-receipt-delivery.js';
import { ensureSessionTemporaryProject } from './temporary-project-scope.js';
import { createHash } from 'node:crypto';
import { taskPreferenceScope } from '../mcp/provider-task-context-registry.js';

import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { agentMemoryRecord, prepareProjectAgentMemory } from './project-agent-memory.js';
import { internalCaptureSkip, legacyCaptureReceipts, normalizeTaskCaptures, taskCaptureInput, taskCaptureReceipt, taskCaptureReviewPaths, taskCaptureStatus } from './task-knowledge-routing.js';
import { captureDisabled, taskCaptureScope } from './capture-decision.js';
import { checkpointCaptureDecision, storedCheckpoint } from './checkpoint-capture.js';
import { receiptNotices } from './capture-notice.js';
import { receiptFormatNotices } from '../data-format/format-notices.js';
import { activeSealedWorkerRequest } from '../app/agent-request-context.js';
import { taskPreferenceMetadata, withPreferenceScope } from '../conversations/preference-snapshot.js';
import { checkpointHumanInteraction } from './checkpoint-human-interaction.js';
import { budgetKnowledgeSearch } from './knowledge-result-budget.js';

import { onlineSourceUri } from './source-uri.js';
import {
  relatedProjectGuidance,
  relatedProjectSuggestions
} from './related-project-suggestions.js';

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
  const current = !continuationToken && turnId && application.taskContextRegistry.current
    ? await application.taskContextRegistry.current(sessionId, sourceApplication) : null;
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
    agentToolName: 'begin_task_context'
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

export const STOP_HOOK_CHECKPOINT_GUIDANCE = 'Call checkpoint_task_knowledge for capture candidates, experiences, agentMemory changes, knowledgeUsage, collaborators or a meaningful workLog, including failures and blockers. Otherwise the Stop hook closes the task as retain_nothing/reported; without a Stop hook a routine fallback closes at the next entry in the same native session. Copy the current entry receipt when skipping checkpoint; never claim unsaved memory was saved.';

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
    agentAssignment: taskAgentAssignment(preferences.project_agent_context),
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

export function taskKnowledgeGuidance() {
  return {
      execution_plan: 'For an explicit durable project execution plan, publish public steps via record_project_agent_task_activity.executionPlan and update step statuses as work progresses. Reuse step IDs and send the full current plan; steps: [] withdraws it. Optional: never invent plans, infer progress percentages or expose private reasoning. Completed steps do not replace verification or human acceptance.',
      collaboration: 'Before implementation, call plan_agent_collaboration with taskSize and all known implementationAgentIds; follow divisionPlan. Standard work: main FLA + different FLA for independent acceptance. Complex work: add at most one explicitly bounded independentWork. Small low-impact edits, coupled changes and command-only checks need no artificial split. Keep coupled implementation together; separate meaningful acceptance once artifacts are stable. The stable project lead decomposes, integrates and delivers. Reuse qualified specialists; gaps use approved loans or existing HR flow. Workers get bounded briefs and necessary artifact references, not the full conversation. Start with at most 3 results/query; expand only for a specific gap. Use only authorized clients/models and assess_agent_action under existing user policies. Publish assigned scopes/dependencies via the optional execution plan; report real worker/model/usage and leave unknown tokens unknown. Verify artifacts via record_agent_verification with evidence; escalate capability after two failures. Recommendations, command runs and configured peers alone are not independent worker execution.',
      profile_capture: 'Separately evaluate durable artifact taste (including writing voice, wording, structure, formatting), stable collaboration personality and decision preferences; do not default all to judgment_preference. Writing evidence uses tasteDomain: writing; a scene-limited item uses attributes.tasteDomain (frontend, ui, ux, design, visual, architecture, code, testing, chat) or workKind, and a boundary the user wants in every scene, chat included, uses attributes.constraint: hard. Retain exact session/turn/time provenance. Agent-inferred personality stays pending. Report missing evidence; do not promise automatic progress from use alone.',
      knowledge_routing: 'Finish with retain_nothing+reason or one capture+captureRouting using explicit personal_global/current_project scopes. Partition each entity/relationship key exactly once; keep relationships with endpoints. Project-limited preferences stay current_project; global scope requires explicit sourceExcerpt evidence, never inferred from profileAspect. Global capture uses standalone preference entities (e.g. PersonalPreference/profileAspect taste), never relabelled Person/Project anchors. Every routed AI proposal remains pending; excerpts do not verify global applicability. Routine review goes to Tonborg under saved policy and must not block independent work. For human decisions use human_interaction: ask native choices with custom input in this conversation, without requiring a review page. review_paths are optional inspection links. Private employee working context belongs in agentMemory, not shared knowledge.',
      human_attention: 'When the person is in this conversation, ask there with native choices (human_interaction). Use request_agent_attention when they are away or the answer must outlive this session: the FULI 待决策 page is their inbox. Pass the exact current space/project/Agent IDs, a stable idempotency key and a specific requestedAction; for a step they must do by hand (log in, trust hooks) say so, and they can answer Done. Never raise a hand for ordinary running, queueing or automatic retries. Answers reach you as attention_replies at task entry, in read_agent_messages, or at once in an agent_chat wait; cancel obsolete requests with cancel_agent_attention. A response does not grant permission or accept task completion.',
      retrieval: 'Inspect task_knowledge_recall before asking for a stable project fact or method again. On a miss, use search_current_project_knowledge with focused action, artifact, target-system, or identifier queries; never use the full conversational request as the only query.',
      checkpoint: 'The owner checkpoints after integration when there are capture candidates, experiences, memory changes, explicit knowledge usage, collaborators or a meaningful workLog. For routine finishes follow checkpoint_guidance; checkpoint_required remains true when automatic closure is unavailable. Coordinated workers return evidence and must not begin or checkpoint an inherited parent context. Explicit checkpoints use capture_candidates or retain_nothing; assigned employees include a concise truthful workLog, even without knowledge capture. Memory changes include agentMemory with the loaded revision and bounded merged notes. Do not overwrite truncated context or store raw transcripts.'
    };
}

export async function checkpointTaskKnowledge(application, {
  taskContextToken,
  disposition,
  reason,
  capture = null,
  captureRouting = null,
  agentMemory = null,
  workLog = null,
  knowledgeUsage = null,
  sourceApplication = 'other',
  personalProjectId = null,
  remoteSessionId = null,
  collaborators = [],
  triage = null,
  experiences = null,
  remember = null
}) {
  if (!['capture_candidates', 'retain_nothing'].includes(disposition)) {
    throw validationError('Unknown task knowledge checkpoint disposition');
  }
  const triageLabel = validateTriage(triage);
  const task = await application.taskContextRegistry.context(taskContextToken, sourceApplication);
  if (personalProjectId && task.personalProjectId !== personalProjectId) {
    throw validationError('Task checkpoint belongs to another project');
  }
  if (remoteSessionId && task.sessionId !== remoteSessionId) {
    throw validationError('Task checkpoint belongs to another remote session');
  }
  // One decision for every write of this checkpoint, kept across its retries.
  // Its writes are decided by the task's project, including a global
  // preference learned there.
  const captureScope = taskCaptureScope(task);
  const captureCheck = await checkpointCaptureDecision(application, task);
  const captureKnowledge = async input => captureCheck.allowed ? application.captureSessionKnowledge(input, { captureScope })
    : { route: 'disabled', ...captureDisabled(captureCheck) };
  // experiences and remember are compact forms of one routed capture.
  if (experiences !== null || remember !== null) {
    if (capture || captureRouting !== null) throw validationError('Send experiences or remember, or a capture, not both');
    if (disposition !== 'capture_candidates') throw validationError('experiences and remember require disposition capture_candidates');
    ({ capture, captureRouting } = compactTaskCapture(task, { experiences, remember }, { sourceApplication }));
  }
  // A Provider-admitted sealed worker call still checkpoints, but never writes
  // preference or project knowledge candidates. Only the worker MCP composition
  // marks the call; roundtable wakes and unknown origins keep ordinary capture.
  const internalActivity = disposition === 'capture_candidates' && capture && activeSealedWorkerRequest()
    ? 'sealed_worker' : null;
  const scopedCaptures = captureRouting === null || internalActivity
    ? null : normalizeTaskCaptures(task, capture, captureRouting);
  if (disposition === 'capture_candidates') {
    if (!capture && !scopedCaptures) {
      throw validationError('capture_candidates requires a bounded capture payload');
    }
  } else if (capture || scopedCaptures) {
    throw validationError('retain_nothing cannot include a capture payload');
  }
  if (task.workLogRequired && !workLog && !agentMemory) {
    throw validationError('This employee needs a workLog summary and status before finishing; retain_nothing only skips knowledge capture.');
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(
    canonicalCheckpoint({ disposition, reason, capture: scopedCaptures ? null : capture,
      ...(scopedCaptures ? { captures: scopedCaptures } : {}),
      ...(internalActivity && captureRouting !== null ? { captureRouting } : {}), agentMemory, ...(workLog ? { workLog } : {}),
      ...(knowledgeUsage ? { knowledgeUsage } : {}) })
  )).digest('hex');
  if (task.checkpoint && task.checkpoint.fingerprint !== fingerprint) {
    throw validationError(
      'Task checkpoint already has different input; resume the original review or begin a new task context'
    );
  }
  const finish = async (result, checkpointTask = task, memory = null) => {
    const team = await taskTeam(application, checkpointTask, collaborators);
    const effectiveLog = workLog ?? { status: 'reported', summary: reason };
    const conversation = captureCheck.allowed ? await checkpointConversation(application, task, effectiveLog, team)
      : captureDisabled(captureCheck);
    const triaged = await recordTriage(application, task, conversation, triageLabel);
    const interaction = activeSealedWorkerRequest() ? {} : await checkpointHumanInteraction(application, task);
    return { ...interaction, ...result, conversation, ...(triaged ? { triage: triaged } : {}),
      agent_receipt: taskAgentReceipt(application, { projectId: task.personalProjectId,
        agentId: task.projectAgentId ?? null, name: team.name, role: team.role, sourceApplication: task.sourceApplication,
        workStatus: effectiveLog.status, conversationId: conversation?.conversation_id ?? null,
        persistence: conversation?.status ?? null, collaborators: team.collaborators,
        notices: [...receiptNotices(captureCheck, [], { settingsUrl: captureSettingsUrl(application) }), ...await receiptFormatNotices(application)],
        turnReceipt: await checkpointTurnReceipt(application, checkpointTask, { memory, agentName: team.name }) }),
      ...(team.ignored.length ? { ignored_collaborators: team.ignored } : {}) };
  };
  if (task.checkpoint?.phase === 'complete') {
    return finish({ status: 'checkpointed', disposition, reason,
      personal_project_id: task.personalProjectId, project_agent_id: task.projectAgentId,
      replayed: true, capture_status: task.checkpoint.captureStatus,
      ...(task.checkpoint.knowledgeUsageResult ? { knowledge_usage: task.checkpoint.knowledgeUsageResult } : {}),
      ...(task.checkpoint.captureResults ? { capture_results: taskCaptureReviewPaths(application.config.personal.spaceId, task.checkpoint.captureResults) } : {}) });
  }
  const captureInput = capture && !scopedCaptures && !internalActivity ? {
    ...capture,
    targetKind: 'personal',
    spaceId: application.config.personal.spaceId,
    personalProjectId: task.personalProjectId,
    projectAgentId: task.agentMemoryScope === 'task_only' ? null : task.projectAgentId ?? null,
    sessionId: task.sessionId,
    sourceApplication,
    idempotencyKey: `${task.token}:knowledge`
  } : null;
  // Local validation has no side effects. Reject correctable input before
  // binding an immutable checkpoint or advancing the Agent's memory revision.
  if (captureInput) await application.validateCaptureSessionKnowledge(captureInput, { captureScope });
  const temporaryProjectId = captureCheck.allowed && scopedCaptures?.some(batch => batch.scope === 'session_temporary')
    ? await ensureSessionTemporaryProject(application, task) : null;
  const scopedInputs = scopedCaptures?.map(batch => ({ scope: batch.scope,
    input: taskCaptureInput(application.config.personal.spaceId, task, batch, temporaryProjectId) }));
  for (const batch of scopedInputs ?? []) await application.validateCaptureSessionKnowledge(batch.input, { captureScope });
  // The Provider owns the full commit model and scope authorization. Validate
  // every scoped batch before claiming the checkpoint or advancing memory.
  if (scopedInputs && captureCheck.allowed) await application.preflightPersonalKnowledgeCaptures(scopedInputs.map(batch => batch.input));
  let memoryResult = null;
  let memoryRequest = null;
  if (agentMemory) {
    if (!task.projectAgentId) {
      throw validationError('Task has no durable project Agent; do not guess a memory target');
    }
    const prepared = await prepareProjectAgentMemory(application, {
      personalSpaceId: application.config.personal.spaceId,
      personalProjectId: task.personalProjectId,
      agentId: task.projectAgentId,
      expectedRevision: agentMemory.expectedRevision,
      idempotencyKey: `${task.token}:memory`,
      memory: agentMemory.memory, sourceApplication,
      // The logical client session survives independent lifecycle-hook MCP
      // processes; their host session ids do not. The Provider persists this
      // stable task session as the memory checkpoint provenance.
      sourceSessionId: task.sessionId
    });
    if (prepared.status === 'capture_disabled') memoryResult = prepared;
    else if (!captureCheck.allowed) memoryResult = captureDisabled(captureCheck);
    else memoryRequest = { expected_revision: prepared.request.expected_revision,
      memory: prepared.request.memory };
  }
  const recorded = { disposition, reason, fingerprint, captureStatus: null,
    ...(knowledgeUsage ? { knowledgeUsage } : {}),
    ...(task.projectAgentId ? { workLog: workLog ?? {
      status: agentMemory ? 'reported' : 'unreported', summary: reason
    } } : {}) };
  const checkpoint = storedCheckpoint(task, recorded, captureCheck);
  const preparedTask = await application.taskContextRegistry.prepare(
    taskContextToken, checkpoint, sourceApplication, memoryRequest
  );
  if (memoryRequest) {
    if (!preparedTask.agentMemory) {
      throw new TypeError('Provider did not confirm atomic Agent memory preparation');
    }
    memoryResult = { status: 'checkpointed', ...agentMemoryRecord(preparedTask.agentMemory) };
  }
  const captureResult = internalActivity ? internalCaptureSkip(internalActivity) : captureInput
    ? await captureKnowledge(captureInput) : null;
  const captureResults = scopedInputs ? [] : null;
  for (const batch of scopedInputs ?? []) {
    const result = await captureKnowledge(batch.input);
    captureResults.push(taskCaptureReceipt(batch.scope, batch.input, result));
  }
  const captureStatus = captureResults
    ? taskCaptureStatus(captureResults)
    : captureResult?.status ?? checkpoint.captureStatus;
  // Both capture paths keep what they saved, so the turn's receipt can read it back.
  const savedResults = captureResults ?? legacyCaptureReceipts(captureInput, captureResult);
  const completedTask = await application.taskContextRegistry.checkpoint(taskContextToken, {
    ...checkpoint, captureStatus, ...(savedResults ? { captureResults: savedResults } : {})
  }, sourceApplication);
  return finish({
    status: 'checkpointed',
    disposition,
    reason,
    personal_project_id: task.personalProjectId,
    project_agent_id: task.projectAgentId ?? null,
    capture: captureResult ?? (captureCheck.allowed ? null : { route: 'disabled', ...captureDisabled(captureCheck) }),
    ...(preparedTask.checkpoint?.knowledgeUsageResult ? { knowledge_usage: preparedTask.checkpoint.knowledgeUsageResult } : {}),
    ...(captureResults ? { capture_status: captureStatus, capture_results: taskCaptureReviewPaths(application.config.personal.spaceId, captureResults) } : {}),
    ...(internalActivity ? { capture_status: captureStatus } : {}),
    agent_memory: memoryResult ? {
      status: memoryResult.status, agentId: memoryResult.agentId,
      checkpointId: memoryResult.checkpointId, revision: memoryResult.revision,
      sourceApplication: memoryResult.sourceApplication,
      sourceSessionId: memoryResult.sourceSessionId, createdAt: memoryResult.createdAt
    } : null
  }, completedTask, memoryResult?.status === 'checkpointed' && memoryResult.revision > agentMemory.expectedRevision ? memoryResult : null);
}

function canonicalCheckpoint(value) {
  if (Array.isArray(value)) return value.map(canonicalCheckpoint);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key, canonicalCheckpoint(value[key])
  ]));
}

function validationError(message) {
  return new ApplicationError(ApplicationErrorCode.VALIDATION, message);
}

export async function recordDecisionTrace(application, input) {
  const trace = decisionTraceKnowledge(input);
  return application.captureSessionKnowledge({
    targetKind: 'personal',
    spaceId: input.personalSpaceId,
    personalProjectId: input.personalProjectId ?? null,
    sessionId: input.sessionId,
    idempotencyKey: input.idempotencyKey,
    name: `Decision · ${input.title}`,
    sourceKind: input.sourceKind,
    sourceDescription: input.sourceDescription,
    sourceUri: input.sourceUri ?? null,
    sourceApplication: input.sourceApplication ?? null,
    sourceTurnId: input.sourceTurnId ?? null,
    referenceTime: input.referenceTime,
    summary: `${input.question}\nSelected: ${input.selectedOption.label}`,
    sensitivity: input.sensitivity ?? 'normal',
    ...trace
  });
}

export async function searchCurrentProjectKnowledge(
  application,
  resolution,
  {
    queries,
    limitPerQuery = 12,
    includeHistorical = false,
    includePending = false,
    cursor = null, sourceApplication = null
  }
) {
  const projectResolution = agentProjectResolution(resolution);
  if (!resolution.personalProjectId) {
    return {
      status: 'project_unresolved',
      personal_space_id: application.config.personal.spaceId,
      personal_project_id: null,
      project_resolution: projectResolution,
      results: [],
      required_action: resolution.status === 'ambiguous'
        ? 'Run from the exact project directory or explicitly choose one project; Fuli will not guess among workspace children.'
        : 'Register this repository or directory as one local personal project before project-scoped search.'
    };
  }

  const [results, relatedProjects] = await Promise.all([
    Promise.all(queries.map((query) =>
      application.searchKnowledge({
        personalSpaceId: application.config.personal.spaceId,
        personalProjectId: resolution.personalProjectId,
        query,
        limit: limitPerQuery,
        includeHistorical,
        includePending, sourceApplication,
        agentInvocation: true,
        agentToolName: 'search_current_project_knowledge'
      })
    )),
    loadRelatedProjectSuggestions(application, resolution.personalProjectId)
  ]);
  return budgetKnowledgeSearch({
    status: 'searched',
    personal_space_id: application.config.personal.spaceId,
    personal_project_id: resolution.personalProjectId,
    project_resolution: projectResolution,
    scope_policy: {
      local_project_first: true,
      inherited_relation_types: ['PART_OF', 'USES_KNOWLEDGE_FROM'],
      max_inheritance_hops: 2,
      local_same_key_overrides_parent: true,
      unrelated_relations_expand_scope: false,
      related_project_expansion_requires_confirmation: true
    },
    results,
    related_project_suggestions: relatedProjects.suggestions,
    related_project_suggestions_status: relatedProjects.status,
    related_project_guidance: relatedProjectGuidance(relatedProjects.suggestions)
  }, { cursor, consoleUrl: application.consoleUrl, toolName: 'search_current_project_knowledge',
    context: { personalSpaceId: application.config.personal.spaceId,
      personalProjectId: resolution.personalProjectId, queries, limitPerQuery, includeHistorical, includePending } });
}

async function loadRelatedProjectSuggestions(application, personalProjectId) {
  try {
    const graph = await application.personal.graph(
      application.config.personal.spaceId,
      2000,
      personalProjectId
    );
    return {
      status: graph?.truncated ? 'partial' : 'available',
      suggestions: relatedProjectSuggestions(graph, personalProjectId)
    };
  } catch {
    return { status: 'unavailable', suggestions: [] };
  }
}

export async function discoverCommonKnowledgeCandidates(application, {
  personalSpaceId,
  parentProjectId,
  query,
  minChildProjects = 2,
  similarityThreshold = 0.72,
  limitPerProject = 12
}) {
  if (!Number.isInteger(minChildProjects) || minChildProjects < 2) {
    throw new TypeError('Common knowledge needs evidence from at least two child projects');
  }
  if (
    typeof similarityThreshold !== 'number'
    || similarityThreshold < 0
    || similarityThreshold > 1
  ) {
    throw new TypeError('Similarity threshold must be between 0 and 1');
  }

  const graph = await application.personal.graph(personalSpaceId, 2000);
  const projectIdByNodeId = new Map(
    (graph.nodes ?? [])
      .filter(({ type }) => type === 'PersonalProject')
      .map((node) => [node.id, node.attributes?.projectId])
      .filter(([, projectId]) => typeof projectId === 'string' && projectId)
  );
  if (![...projectIdByNodeId.values()].includes(parentProjectId)) {
    throw new TypeError('Parent project is not present in the active personal graph');
  }
  const childProjectIds = [...new Set(
    (graph.edges ?? [])
      .filter(({ type, source, target, attributes = {} }) =>
        type === 'PART_OF'
        && attributes.status === 'active'
        && (
          attributes.confirmationAuthority
          ?? attributes.confirmation_authority
        ) === 'human_review'
        && projectIdByNodeId.get(target) === parentProjectId
        && projectIdByNodeId.has(source)
      )
      .map(({ source }) => projectIdByNodeId.get(source))
  )].sort();

  if (childProjectIds.length < minChildProjects) {
    return commonCandidateResult({
      status: childProjectIds.length === 0 ? 'no_children' : 'insufficient_children',
      personalSpaceId,
      parentProjectId,
      childProjectIds,
      query,
      candidates: [],
      graph
    });
  }

  const childResults = await Promise.all(childProjectIds.map(async (projectId) => ({
    projectId,
    result: await application.personal.search({
      space_ids: [personalSpaceId],
      query,
      limit: limitPerProject,
      include_historical: false,
      include_exploratory: true,
      personal_project_ids: [projectId],
      active_personal_project_id: projectId,
      inherit_project_knowledge: false,
      include_personal_global: false
    })
  })));
  const items = childResults.flatMap(({ projectId, result }) => [
    ...(result.entities ?? []).map((item) =>
      commonKnowledgeItem(item, 'entity', projectId)
    ),
    ...(result.facts ?? []).map((item) =>
      commonKnowledgeItem(item, 'relationship', projectId)
    )
  ]).filter((item) => !item.profile_aspect);
  const candidates = clusterCommonKnowledgeItems(
    items,
    minChildProjects,
    similarityThreshold,
    parentProjectId,
    query
  );
  return commonCandidateResult({
    status: candidates.length > 0 ? 'candidates_found' : 'no_candidates',
    personalSpaceId,
    parentProjectId,
    childProjectIds,
    query,
    candidates,
    graph
  });
}

export async function discoverPersonalGlobalPreferenceCandidates(application, {
  personalSpaceId,
  personalProjectIds,
  query,
  minProjects = 2,
  similarityThreshold = 0.72,
  limitPerProject = 12
}) {
  if (!Array.isArray(personalProjectIds) || personalProjectIds.length < 2) {
    throw new TypeError('Personal-global candidates need at least two explicit projects');
  }
  if (!Number.isInteger(minProjects) || minProjects < 2) {
    throw new TypeError('Personal-global candidates need evidence from at least two projects');
  }
  if (
    typeof similarityThreshold !== 'number'
    || similarityThreshold < 0
    || similarityThreshold > 1
  ) {
    throw new TypeError('Similarity threshold must be between 0 and 1');
  }
  const projectIds = [...new Set(personalProjectIds)].sort();
  if (projectIds.length < 2 || minProjects > projectIds.length) {
    throw new TypeError('The selected project set cannot satisfy minProjects');
  }
  const knownProjectIds = new Set(
    (await application.personal.listPersonalProjects(personalSpaceId))
      .map(({ project_id: projectId }) => projectId)
  );
  if (projectIds.some((projectId) => !knownProjectIds.has(projectId))) {
    throw new TypeError('Every selected project must exist in the active personal space');
  }

  const projectResults = await Promise.all(projectIds.map(async (projectId) => ({
    projectId,
    result: await application.personal.search({
      space_ids: [personalSpaceId],
      query,
      limit: limitPerProject,
      include_historical: false,
      include_exploratory: false,
      personal_project_ids: [projectId],
      active_personal_project_id: projectId,
      inherit_project_knowledge: false,
      include_personal_global: false
    })
  })));
  const items = projectResults.flatMap(({ projectId, result }) => [
    ...(result.entities ?? []).map((item) =>
      commonKnowledgeItem(item, 'entity', projectId)
    ),
    ...(result.facts ?? []).map((item) =>
      commonKnowledgeItem(item, 'relationship', projectId)
    )
  ]).filter((item) =>
    item.profile_aspect
    && item.preference_scope === 'project'
    && item.preference_project_id === item.defined_project_id
    && ['confirmed', 'agent_confirmed'].includes(item.confirmation_status)
    && item.requires_attention !== true
  );
  const clusteredCandidates = clusterPersonalGlobalPreferenceItems(
    items,
    minProjects,
    similarityThreshold,
    query,
    projectIds.length
  );
  const candidates = await Promise.all(clusteredCandidates.map(async (candidate) => {
    const options = await application.personal.personalGlobalPreferenceScopeOptions(
      candidate.candidate_id,
      {
        personal_space_id: personalSpaceId,
        source_items: candidate.source_items.map((item) => ({
          item_id: item.id,
          item_kind: item.item_kind,
          project_id: item.defined_project_id
        })),
        preference_key: candidate.preference_key
      }
    );
    return {
      ...candidate,
      candidate_version: options.candidate_version,
      target_scope: 'human_selected',
      eligible_target_scopes: options.eligible_target_scopes,
      source_snapshots: options.source_snapshots
    };
  }));
  const decisionState = await personalGlobalCandidateDecisionState(
    application,
    personalSpaceId,
    candidates
  );
  const visibleCandidates = candidates
    .filter(({ candidate_id: id, candidate_version: version }) =>
      !decisionState.decisions.has(`${id}:${version}`)
    )
    .map((candidate) => personalGlobalCandidateWithDecisionState(
      candidate,
      decisionState.revisions.get(candidate.candidate_id)
    ));
  const suppressedCandidates = candidates
    .filter(({ candidate_id: id, candidate_version: version }) =>
      decisionState.decisions.has(`${id}:${version}`)
    )
    .map(({ candidate_id: candidateId, candidate_version: version }) => ({
      candidate_id: candidateId,
      candidate_version: version,
      ...decisionState.decisions.get(`${candidateId}:${version}`)
    }));
  return {
    status: visibleCandidates.length > 0
      ? 'candidates_found'
      : suppressedCandidates.length > 0
        ? 'candidates_suppressed'
        : 'no_candidates',
    personal_space_id: personalSpaceId,
    target_scope: 'human_selected',
    selected_project_ids: projectIds,
    query,
    candidates: visibleCandidates,
    suppressed_candidates: suppressedCandidates,
    policy: personalGlobalCandidatePolicy()
  };
}

export async function previewPersonalGlobalPreferenceDecision(application, input) {
  return application.personal.inspectPersonalGlobalPreferenceDecision(
    input.candidateId,
    providerPersonalGlobalPreferenceDecision(input)
  );
}

export async function applyPersonalGlobalPreferenceDecision(application, input) {
  return application.personal.applyPersonalGlobalPreferenceDecision(
    input.candidateId,
    providerPersonalGlobalPreferenceDecision(input, {
      approvalToken: input.previewToken
    })
  );
}

export async function recordKnowledgeFeedback(application, {
  personalSpaceId,
  taskId,
  sessionId = null,
  toolName = null,
  items
}) {
  return application.personal.recordKnowledgeFeedback({
    personal_space_id: personalSpaceId,
    task_id: taskId,
    session_id: sessionId,
    tool_name: toolName,
    items: items.map((item) => ({
      item_id: item.itemId,
      item_kind: item.itemKind,
      feedback_kind: item.feedbackKind,
      reason: item.reason,
      evidence_summary: item.evidenceSummary,
      reported_by_kind: item.reportedByKind,
      source_uri: onlineSourceUri(item.sourceUri)
    }))
  });
}

export function providerCommonKnowledgePromotion(input) {
  return {
    personal_space_id: input.personalSpaceId,
    parent_project_id: input.parentProjectId,
    item_kind: input.itemKind,
    canonical_item_id: input.canonicalItemId,
    duplicate_item_ids: input.duplicateItemIds,
    reason: input.reason,
    human_confirmation_reason: input.humanConfirmationReason
  };
}

export function agentProjectResolution(resolution) {
  const result = {
    status: resolution.status,
    basis: resolution.basis,
    personal_project_id: resolution.personalProjectId
  };
  if (resolution.candidateCount !== undefined) {
    result.candidate_count = resolution.candidateCount;
  }
  return result;
}

function commonCandidateResult({
  status,
  personalSpaceId,
  parentProjectId,
  childProjectIds,
  query,
  candidates,
  graph
}) {
  return {
    status,
    personal_space_id: personalSpaceId,
    parent_project_id: parentProjectId,
    child_project_ids: childProjectIds,
    query,
    candidates,
    graph_truncated: graph.truncated === true,
    policy: commonKnowledgeCandidatePolicy()
  };
}

function commonKnowledgeItem(item, itemKind, projectId) {
  return {
    ...item,
    item_kind: itemKind,
    defined_project_id: projectId
  };
}

function clusterCommonKnowledgeItems(
  items,
  minChildProjects,
  similarityThreshold,
  parentProjectId,
  query
) {
  const groups = [];
  for (const item of items) {
    const matching = groups
      .map((group) => ({
        group,
        similarity: Math.max(
          ...group.items.map((member) => commonKnowledgeSimilarity(item, member))
        )
      }))
      .filter(({ group, similarity }) =>
        group.itemKind === item.item_kind
        && similarity >= similarityThreshold
        && !group.projectIds.has(item.defined_project_id)
      )
      .sort((left, right) => right.similarity - left.similarity)[0];
    if (matching) {
      matching.group.items.push(item);
      matching.group.projectIds.add(item.defined_project_id);
      continue;
    }
    groups.push({
      itemKind: item.item_kind,
      projectIds: new Set([item.defined_project_id]),
      items: [item]
    });
  }

  return groups
    .filter(({ projectIds }) => projectIds.size >= minChildProjects)
    .map((group) => {
      const orderedItems = [...group.items].sort((left, right) =>
        left.defined_project_id.localeCompare(right.defined_project_id)
      );
      const pairScores = [];
      for (let left = 0; left < orderedItems.length; left += 1) {
        for (let right = left + 1; right < orderedItems.length; right += 1) {
          pairScores.push(commonKnowledgeSimilarity(
            orderedItems[left],
            orderedItems[right]
          ));
        }
      }
      const averageSimilarity = pairScores.length === 0
        ? 1
        : pairScores.reduce((sum, score) => sum + score, 0) / pairScores.length;
      const itemIds = orderedItems.map(({ id }) => id).sort();
      return {
        candidate_id: `common-${createHash('sha256')
          .update(itemIds.join('\n'))
          .digest('hex')
          .slice(0, 20)}`,
        parent_project_id: parentProjectId,
        child_project_ids: [...group.projectIds].sort(),
        item_kind: group.itemKind,
        query,
        similarity_score: Number(averageSimilarity.toFixed(4)),
        similarity_basis: 'lexical_overlap_across_direct_child_projects',
        items: orderedItems,
        requires_human_confirmation: true,
        promotion_performed: false
      };
    })
    .sort((left, right) =>
      right.child_project_ids.length - left.child_project_ids.length
      || right.similarity_score - left.similarity_score
      || left.candidate_id.localeCompare(right.candidate_id)
    );
}

function clusterPersonalGlobalPreferenceItems(
  items,
  minProjects,
  similarityThreshold,
  query,
  selectedProjectCount
) {
  const groups = [];
  for (const item of items) {
    const preferenceKey = personalGlobalItemPreferenceKey(item);
    const matching = groups
      .map((group) => ({
        group,
        similarity: Math.min(
          ...group.items.map((member) => commonKnowledgeSimilarity(item, member))
        )
      }))
      .filter(({ group, similarity }) =>
        group.itemKind === item.item_kind
        && group.preferenceKey === preferenceKey
        && similarity >= similarityThreshold
        && !group.projectIds.has(item.defined_project_id)
      )
      .sort((left, right) => right.similarity - left.similarity)[0];
    if (matching) {
      matching.group.items.push(item);
      matching.group.projectIds.add(item.defined_project_id);
      continue;
    }
    groups.push({
      itemKind: item.item_kind,
      preferenceKey,
      projectIds: new Set([item.defined_project_id]),
      items: [item]
    });
  }

  return groups
    .filter(({ projectIds }) => projectIds.size >= minProjects)
    .map((group) => {
      const sourceItems = [...group.items].sort((left, right) =>
        left.defined_project_id.localeCompare(right.defined_project_id)
      );
      const itemIds = sourceItems.map(({ id }) => id).sort();
      const commonTerms = sharedPreferenceTerms(sourceItems);
      const pairScores = [];
      for (let left = 0; left < sourceItems.length; left += 1) {
        for (let right = left + 1; right < sourceItems.length; right += 1) {
          pairScores.push(commonKnowledgeSimilarity(
            sourceItems[left],
            sourceItems[right]
          ));
        }
      }
      const averageSimilarity = pairScores.length === 0
        ? 1
        : pairScores.reduce((sum, score) => sum + score, 0) / pairScores.length;
      const ranking = personalGlobalCandidateRanking({
        sourceItems,
        projectCount: group.projectIds.size,
        selectedProjectCount,
        lexicalSimilarity: averageSimilarity
      });
      return {
        candidate_id: personalGlobalPreferenceCandidateId(itemIds),
        candidate_version: null,
        target_scope: 'human_selected',
        source_project_ids: [...group.projectIds].sort(),
        item_kind: group.itemKind,
        preference_key: group.preferenceKey,
        query,
        similarity_score: Number(averageSimilarity.toFixed(4)),
        similarity_basis: 'lexical_overlap_across_explicit_personal_projects',
        candidate_score: ranking.score,
        ranking,
        source_items: sourceItems,
        derived_common_core: {
          terms: commonTerms,
          basis: 'lexical_intersection_of_preserved_source_text',
          authoritative: false,
          source_item_ids: itemIds
        },
        source_specific_terms: sourceItems.map((item) => ({
          item_id: item.id,
          project_id: item.defined_project_id,
          terms: [...preferenceContentTokens(item)]
            .filter((term) => !commonTerms.includes(term))
            .sort()
        })),
        requires_human_scope_judgment: true,
        scope_apply_performed: false
      };
    })
    .sort((left, right) =>
      right.candidate_score - left.candidate_score
      || right.source_project_ids.length - left.source_project_ids.length
      || right.similarity_score - left.similarity_score
      || left.candidate_id.localeCompare(right.candidate_id)
    );
}

function personalGlobalItemPreferenceKey(item) {
  return item.preference_key
    ?? item.attributes?.preferenceKey
    ?? item.attributes?.preference_key
    ?? item.key
    ?? item.id;
}

const PERSONAL_GLOBAL_RANKING_WEIGHTS = Object.freeze({
  distinct_projects: 0.25,
  lexical_similarity: 0.35,
  confirmation_authority: 0.2,
  recency: 0.1,
  negative_evidence: 0.1
});

function personalGlobalCandidateRanking({
  sourceItems,
  projectCount,
  selectedProjectCount,
  lexicalSimilarity
}) {
  const signals = {
    distinct_projects: boundedScore(
      projectCount / Math.max(selectedProjectCount, 1)
    ),
    lexical_similarity: boundedScore(lexicalSimilarity),
    confirmation_authority: averageScore(sourceItems.map((item) =>
      item.confirmation_status === 'confirmed' ? 1 : 0.65
    )),
    recency: averageScore(sourceItems.map(personalGlobalItemRecency)),
    negative_evidence: averageScore(sourceItems.map((item) =>
      item.requires_attention === true
        ? 0
        : 1 / (1 + Math.max(0, Number(item.negative_evidence_count ?? 0)))
    ))
  };
  const details = Object.fromEntries(
    Object.entries(signals).map(([key, value]) => {
      const weight = PERSONAL_GLOBAL_RANKING_WEIGHTS[key];
      return [key, {
        value: Number(value.toFixed(4)),
        weight,
        contribution: Number((value * weight).toFixed(4))
      }];
    })
  );
  const score = Object.values(details)
    .reduce((sum, signal) => sum + signal.contribution, 0);
  return {
    score: Number(score.toFixed(4)),
    signals: details,
    source_project_count: projectCount,
    selected_project_count: selectedProjectCount,
    policy: 'ranking_only_never_changes_scope_or_confirmation_authority'
  };
}

function personalGlobalItemRecency(item) {
  const timestamp = [
    item.last_used_at,
    item.last_human_changed_at,
    item.created_at
  ].map((value) => Date.parse(value ?? ''))
    .find(Number.isFinite);
  if (!Number.isFinite(timestamp)) return 0.5;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  return Math.exp(-ageDays / 180);
}

function averageScore(values) {
  if (values.length === 0) return 0;
  return boundedScore(
    values.reduce((sum, value) => sum + value, 0) / values.length
  );
}

function boundedScore(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function commonKnowledgeSimilarity(left, right) {
  if (left.key && right.key && left.key === right.key) return 1;
  const leftTokens = commonKnowledgeTokens(left);
  const rightTokens = commonKnowledgeTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

function commonKnowledgeTokens(item) {
  const text = [
    item.name,
    item.summary,
    item.fact,
    item.type
  ].filter(Boolean).join(' ').toLowerCase();
  return lexicalTokens(text);
}

function preferenceContentTokens(item) {
  const text = [
    item.instruction,
    item.summary,
    item.fact
  ].filter(Boolean).join(' ').toLowerCase();
  return lexicalTokens(text || String(item.name ?? '').toLowerCase());
}

function sharedPreferenceTerms(items) {
  const tokenSets = items.map(preferenceContentTokens);
  if (tokenSets.length === 0) return [];
  return [...tokenSets[0]]
    .filter((term) => tokenSets.slice(1).every((tokens) => tokens.has(term)))
    .sort();
}

function lexicalTokens(text) {
  const tokens = new Set(
    text.match(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g) ?? []
  );
  for (const sequence of text.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (sequence.length === 1) tokens.add(sequence);
    for (let index = 0; index < sequence.length - 1; index += 1) {
      tokens.add(sequence.slice(index, index + 2));
    }
  }
  return tokens;
}

function commonKnowledgeCandidatePolicy() {
  return {
    read_only: true,
    direct_part_of_children_only: true,
    active_human_authorized_relations_only: true,
    personal_preferences_excluded: true,
    inherited_knowledge_excluded: true,
    personal_global_excluded: true,
    automatic_promotion: false,
    human_confirmation_required: true,
    similarity_is_inferred_not_authoritative: true
  };
}

function personalGlobalCandidatePolicy() {
  return {
    read_only: true,
    exact_projects_only: true,
    inherited_knowledge_excluded: true,
    personal_global_excluded: true,
    original_text_and_sources_preserved: true,
    derived_core_is_non_authoritative: true,
    human_scope_judgment_required: true,
    automatic_scope_apply: false,
    ranking_scores_are_non_authoritative: true,
    stale_decisions_do_not_suppress_changed_candidates: true
  };
}

async function personalGlobalCandidateDecisionState(
  application,
  personalSpaceId,
  candidates
) {
  if (candidates.length === 0) {
    return { decisions: new Map(), revisions: new Map() };
  }
  const result = await application.personal
    .personalGlobalPreferenceDecisionStatus({
      personal_space_id: personalSpaceId,
      candidates: candidates.map((candidate) => ({
        candidate_id: candidate.candidate_id,
        candidate_version: candidate.candidate_version
      }))
    });
  return {
    decisions: new Map((result.decisions ?? []).map((decision) => [
      `${decision.candidate_id}:${decision.candidate_version}`,
      {
        decision: decision.decision,
        decision_event_id: decision.decision_event_id,
        decision_revision: decision.decision_revision,
        target_scope: decision.target_scope,
        target_project_id: decision.target_project_id ?? null,
        global_assertion_id: decision.global_assertion_id,
        global_assertion_active: decision.global_assertion_active
      }
    ])),
    revisions: new Map((result.revisions ?? []).map((revision) => [
      revision.candidate_id,
      revision
    ]))
  };
}

function personalGlobalCandidateWithDecisionState(candidate, revision) {
  const decisionRevision = revision?.decision_revision ?? 0;
  const previousVersion = revision?.current_candidate_version ?? null;
  const sourceDrift = Boolean(
    previousVersion && previousVersion !== candidate.candidate_version
  );
  return {
    ...candidate,
    decision_revision: decisionRevision,
    prior_decision_source_drift: sourceDrift,
    prior_decision_candidate_version: sourceDrift ? previousVersion : null,
    fresh_human_review_required: true
  };
}

function providerPersonalGlobalPreferenceDecision(input, {
  approvalToken = null
} = {}) {
  const result = {
    personal_space_id: input.personalSpaceId,
    candidate_version: input.candidateVersion,
    decision_revision: input.decisionRevision,
    source_items: input.sourceItems.map((item) => ({
      item_id: item.itemId,
      item_kind: item.itemKind,
      project_id: item.projectId
    })),
    preference_key: input.preferenceKey,
    target_scope: input.targetScope,
    target_project_id: input.targetProjectId ?? null,
    decision: input.decision,
    global_title: input.globalTitle ?? null,
    global_instruction: input.globalInstruction ?? null,
    profile_aspect: input.profileAspect ?? null,
    human_confirmation_reason: input.humanConfirmationReason,
    confirmed_at: input.confirmedAt,
    session_id: input.sessionId,
    idempotency_key: input.idempotencyKey
  };
  if (approvalToken) result.approval_token = approvalToken;
  return result;
}

function personalGlobalPreferenceCandidateId(itemIds) {
  return `personal-global-${createHash('sha256')
    .update([...itemIds].sort().join('\n'))
    .digest('hex')
    .slice(0, 20)}`;
}

function decisionTraceKnowledge(input) {
  const decisionKey = `decision:${input.decisionKey}`;
  const selectedKey = `${decisionKey}:option:${input.selectedOption.key}`;
  const rationaleKey = `${decisionKey}:rationale`;
  const rejected = input.rejectedOptions ?? [];
  const validations = input.validationResults ?? [];
  const confirmed = ['user', 'authoritative_source'].includes(
    input.decidedBy.kind
  );
  const confirmationStatus = confirmed ? 'confirmed' : 'pending';
  const epistemicStatus = confirmed ? 'confirmed' : 'observed';
  const confirmationBasis = {
    existenceReason: input.sourceDescription,
    quadrantReason: input.reason,
    proposedBy: input.decidedBy,
    confirmedBy: confirmed ? input.decidedBy : null,
    confirmedAt: confirmed ? input.referenceTime : null,
    agentPolicyVersion: null
  };
  const epistemic = {
    originQuadrant: 'known_known',
    currentQuadrant: 'known_known',
    epistemicStatus,
    confirmationStatus,
    confirmationBasis,
    reasoningSummary: input.reason,
    inheritanceMode: 'local_only',
    inheritedProjectIds: []
  };
  const entities = [
    {
      key: decisionKey,
      name: input.title,
      type: 'Decision',
      summary: `${input.question}\nSelected: ${input.selectedOption.label}`,
      attributes: {
        decisionKey: input.decisionKey,
        selectedOptionKey: input.selectedOption.key,
        decidedByKind: input.decidedBy.kind
      },
      ...epistemic
    },
    {
      key: selectedKey,
      name: input.selectedOption.label,
      type: 'DecisionOption',
      summary: input.selectedOption.summary ?? '',
      attributes: { disposition: 'selected' },
      ...epistemic
    },
    ...rejected.map((option) => ({
      key: `${decisionKey}:option:${option.key}`,
      name: option.label,
      type: 'DecisionOption',
      summary: option.summary ?? '',
      attributes: { disposition: 'rejected' },
      ...epistemic
    })),
    {
      key: rationaleKey,
      name: `${input.title} · rationale`,
      type: 'DecisionRationale',
      summary: input.reason,
      attributes: {},
      ...epistemic
    },
    ...validations.map((validation) => ({
      key: `${decisionKey}:validation:${validation.key}`,
      name: `${input.title} · ${validation.key}`,
      type: 'ValidationResult',
      summary: validation.summary,
      attributes: { outcome: validation.outcome },
      ...epistemic
    }))
  ];
  const relationship = (key, target, type, fact) => ({
    key,
    source: decisionKey,
    target,
    type,
    fact,
    confidence: confirmed ? 1 : 0.7,
    attributes: {},
    ...epistemic
  });
  return {
    entities,
    relationships: [
      relationship(
        `${decisionKey}:selected`,
        selectedKey,
        'SELECTED_OPTION',
        `${input.title} selected ${input.selectedOption.label}.`
      ),
      ...rejected.map((option) => relationship(
        `${decisionKey}:rejected:${option.key}`,
        `${decisionKey}:option:${option.key}`,
        'REJECTED_OPTION',
        `${input.title} did not select ${option.label}.`
      )),
      relationship(
        `${decisionKey}:motivated-by`,
        rationaleKey,
        'MOTIVATED_BY',
        input.reason
      ),
      ...validations.map((validation) => relationship(
        `${decisionKey}:validated-by:${validation.key}`,
        `${decisionKey}:validation:${validation.key}`,
        'VALIDATED_BY',
        `${validation.outcome}: ${validation.summary}`
      ))
    ]
  };
}

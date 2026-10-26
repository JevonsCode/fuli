import { checkpointConversation } from './agent-conversations.js';
import { recordTriage, validateTriage } from './conversation-triage.js';
import { compactTaskCapture } from './task-remember.js';
import { taskTeam } from './task-collaboration-attribution.js';
import { captureSettingsUrl, taskAgentReceipt } from '../agents/identity-receipt.js';
import { checkpointTurnReceipt } from './turn-receipt-delivery.js';
import { ensureSessionTemporaryProject } from './temporary-project-scope.js';
import { createHash } from 'node:crypto';

import { validationError } from '../app/application-error.js';
import { agentMemoryRecord, prepareProjectAgentMemory } from './project-agent-memory.js';
import { internalCaptureSkip, legacyCaptureReceipts, normalizeTaskCaptures, taskCaptureInput, taskCaptureReceipt, taskCaptureReviewPaths, taskCaptureStatus } from './task-knowledge-routing.js';
import { captureDisabled, taskCaptureScope } from './capture-decision.js';
import { checkpointCaptureDecision, storedCheckpoint } from './checkpoint-capture.js';
import { receiptNotices } from './capture-notice.js';
import { standingReceiptNotices } from './task-entry-standing-owner.js';
import { namedFlaReceiptNotices } from './task-entry-named-fla.js';
import { receiptFormatNotices } from '../data-format/format-notices.js';
import { activeSealedWorkerRequest } from '../app/agent-request-context.js';
import { checkpointHumanInteraction } from './checkpoint-human-interaction.js';

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
        notices: [...namedFlaReceiptNotices(task), ...standingReceiptNotices(task), ...receiptNotices(captureCheck, [], { settingsUrl: captureSettingsUrl(application) }), ...await receiptFormatNotices(application)],
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

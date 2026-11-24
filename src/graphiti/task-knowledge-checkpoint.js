import { checkpointConversation } from './agent-conversations.js';
import { recordTriage, validateTriage } from './conversation-triage.js';
import { compactTaskCapture } from './task-remember.js';
import { taskTeam } from './task-collaboration-attribution.js';
import { captureSettingsUrl, signedReceipt, taskAgentReceipt } from '../agents/identity-receipt.js';
import { checkpointTurnReceipt, entryOpenedConversation } from './turn-receipt-delivery.js';
import { continuedInTask } from './conversation-continuation.js';
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
import { ownerChangeReceiptNotices } from './task-entry-owner-change.js';
import { introductionReceiptLine } from './task-entry-introduction.js';
import { receiptFormatNotices } from '../data-format/format-notices.js';
import { activeSealedWorkerRequest } from '../app/agent-request-context.js';
import { ruleTextView } from '../conversations/entry-rules.js';
import { checkpointHumanInteraction } from './checkpoint-human-interaction.js';
import { clearSessionTaskBlockers, noteBlockerProgress } from './task-blocker-progress.js';
import { storedUnassignment } from './task-agent-assignment.js';
import { amendCheckpoint, assertAmendmentInput, checkpointConflictMessage } from './checkpoint-amendment.js';
import { admittedTask, closedTaskRefusal } from './checkpoint-save-status.js';
import { roundtableTurn } from '../agent-roundtable/turn-receipt.js';
import { GLOBAL_WRITE_KINDS } from './global-writes-port.js';

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
  remember = null,
  amend = false
}) {
  if (!['capture_candidates', 'retain_nothing'].includes(disposition)) {
    throw validationError('Unknown task knowledge checkpoint disposition');
  }
  const triageLabel = validateTriage(triage);
  // Before any write: a refused token here means this call saved nothing (checkpoint-save-status.js).
  const task = await admittedTask(application.taskContextRegistry.context(taskContextToken, sourceApplication));
  if (amend) assertAmendmentInput(task, { disposition, capture, captureRouting, agentMemory, knowledgeUsage,
    triage, experiences, remember, collaborators });
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
    if (!capture && !scopedCaptures && !amend) {
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
  if (!amend && task.checkpoint && task.checkpoint.fingerprint !== fingerprint) {
    // A closed task is not a conflict to resolve but a token to replace: the
    // call saved nothing and says how to keep this turn's knowledge
    // (checkpoint-save-status.js checkpointOnClosedTask).
    if (task.checkpoint.phase === 'complete') throw closedTaskRefusal();
    throw validationError(checkpointConflictMessage(task.checkpoint));
  }
  // An amendment finishes from its stored entry: its log, decision and event (rec#85).
  const finish = async (result, checkpointTask = task, memory = null, amendment = null) => {
    const decision = amendment?.decision ?? captureCheck;
    // The turn is finished: the prompt kept for the relay check goes (rec#80).
    try { application.entryPrompts?.checkpointed(task); } catch { /* the next entry replaces it */ }
    const team = await taskTeam(application, checkpointTask, collaborators);
    const effectiveLog = amendment?.log ?? workLog ?? { status: 'reported', summary: reason };
    const conversation = decision.allowed ? await checkpointConversation(application, task, effectiveLog, team, amendment?.eventId)
      : captureDisabled(decision);
    const triaged = await recordTriage(application, task, conversation, triageLabel);
    // This session went on, so a block it reported has ended and leaves the person's queue.
    await clearSessionTaskBlockers(application, { sourceApplication: task.sourceApplication,
      sessionIds: [task.sessionId], cause: 'session_activity', captureAllowed: decision.allowed });
    // Its Agent's blocks reported in other sessions may be solved here too: probably resolved.
    await noteBlockerProgress(application, { sourceApplication: task.sourceApplication, sessionId: task.sessionId,
      personalProjectId: task.personalProjectId, agentId: task.projectAgentId, captureAllowed: decision.allowed });
    const interaction = activeSealedWorkerRequest() ? {} : await checkpointHumanInteraction(application, task);
    // A task without an owner says why, as its entry did.
    const unassigned = task.projectAgentId ? null : storedUnassignment(task);
    const agentReceipt = sharedContinuation(signedReceipt(taskAgentReceipt(application, { projectId: task.personalProjectId,
        agentId: task.projectAgentId ?? null, name: team.name, role: team.role, sourceApplication: task.sourceApplication,
        assignmentStatus: unassigned?.status ?? null, assignmentReason: unassigned?.reason ?? null,
        workStatus: effectiveLog.status, conversationId: conversation?.conversation_id ?? null,
        persistence: conversation?.status ?? null, collaborators: team.collaborators,
        roundtable: roundtableTurn(task.token), introduction: introductionReceiptLine(task),
        notices: [...namedFlaReceiptNotices(task), ...standingReceiptNotices(task), ...ownerChangeReceiptNotices(task), ...receiptNotices(decision, [], { settingsUrl: captureSettingsUrl(application),
          unsavedRemember: decision.allowed ? null : remember }), ...await receiptFormatNotices(application, { taskId: task.token })],
        turnReceipt: await checkpointTurnReceipt(application, checkpointTask, { memory, agentName: team.name }) }),
        // A later turn of a conversation already signed, that retained nothing
        // and carries nothing new, signs with the name alone: the reply it
        // follows is often a two-word confirmation (rec#146 item 3). Only when
        // FULI knows it: the entry wrote that it opened no conversation, this
        // checkpoint saved to one, and no earlier work was continued here.
        { firstInConversation: !(conversation?.status === 'saved' && entryOpenedConversation(application, task) === false)
          || continuedInTask(task.token) }));
    // One receipt, said twice: the conversation's copy is exactly agent_receipt,
    // so whichever an Agent reads, it is the same line (short or whole).
    return { ...interaction, ...result, conversation: conversation?.receipt ? { ...conversation, receipt: agentReceipt } : conversation,
      ...(triaged ? { triage: triaged } : {}), agent_receipt: agentReceipt,
      ...(team.ignored.length ? { ignored_collaborators: team.ignored } : {}) };
  };
  if (amend && fingerprint !== task.checkpoint.fingerprint) {
    const amended = await amendCheckpoint(application, task, { disposition, reason, workLog, fingerprint }, captureCheck);
    return finish({ status: 'amended', disposition, reason, personal_project_id: task.personalProjectId,
      project_agent_id: task.projectAgentId ?? null, amendment: amended.sequence,
      ...(amended.replayed ? { replayed: true } : {}) }, amended.task, null,
    { ...amended, eventId: `${task.token}:amendment:${amended.sequence}` });
  }
  if (task.checkpoint?.phase === 'complete') {
    return finish({ status: 'checkpointed', disposition, reason,
      personal_project_id: task.personalProjectId, project_agent_id: task.projectAgentId,
      replayed: true, capture_status: task.checkpoint.captureStatus,
      ...(task.checkpoint.knowledgeUsageResult ? { knowledge_usage: task.checkpoint.knowledgeUsageResult } : {}),
      ...(task.checkpoint.captureResults ? { capture_results: taskCaptureReviewPaths(application.config.personal.spaceId, task.checkpoint.captureResults) } : {}) });
  }
  // Writes to global go to the computer that owns it (global-writes-port.js);
  // on a computer that owns global itself nothing below changes.
  const globalElsewhere = application.globalWrites?.elsewhere() === true;
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
  // A capture without a project, while global is another computer's, is that
  // computer's to check and write; this one's Provider is never asked.
  const captureToOwner = globalElsewhere && captureCheck.allowed && captureInput !== null && !captureInput.personalProjectId;
  // The Provider's own rules (e.g. confirmedBy only with confirmedAt) are
  // checked before binding too: a rejection after binding left the token
  // locked on input that could never be saved (rec#79).
  if (captureInput && captureCheck.allowed && !captureToOwner) await application.preflightPersonalKnowledgeCaptures([captureInput]);
  const temporaryProjectId = captureCheck.allowed && scopedCaptures?.some(batch => batch.scope === 'session_temporary')
    ? await ensureSessionTemporaryProject(application, task) : null;
  const scopedInputs = scopedCaptures?.map(batch => ({ scope: batch.scope,
    input: taskCaptureInput(application.config.personal.spaceId, task, batch, temporaryProjectId) }));
  for (const batch of scopedInputs ?? []) await application.validateCaptureSessionKnowledge(batch.input, { captureScope });
  const ownerBatches = globalElsewhere && captureCheck.allowed
    ? scopedInputs?.filter(batch => batch.scope === 'personal_global') ?? [] : [];
  const hereBatches = scopedInputs?.filter(batch => !ownerBatches.includes(batch)) ?? null;
  // The Provider owns the full commit model and scope authorization. Validate
  // every scoped batch before claiming the checkpoint or advancing memory.
  if (hereBatches?.length && captureCheck.allowed) await application.preflightPersonalKnowledgeCaptures(hereBatches.map(batch => batch.input));
  let memoryResult = null;
  let memoryRequest = null;
  let memoryForOwner = null;
  if (agentMemory) {
    if (!task.projectAgentId) {
      throw validationError('Task has no durable project Agent; do not guess a memory target');
    }
    const memoryInput = {
      agentId: task.projectAgentId,
      expectedRevision: agentMemory.expectedRevision,
      idempotencyKey: `${task.token}:memory`,
      memory: agentMemory.memory, sourceApplication,
      // The logical client session survives independent lifecycle-hook MCP
      // processes; their host session ids do not. The Provider persists this
      // stable task session as the memory checkpoint provenance.
      sourceSessionId: task.sessionId
    };
    const prepared = await prepareProjectAgentMemory(application, {
      personalSpaceId: application.config.personal.spaceId,
      personalProjectId: task.personalProjectId, ...memoryInput
    });
    if (prepared.status === 'capture_disabled') memoryResult = prepared;
    else if (!captureCheck.allowed) memoryResult = captureDisabled(captureCheck);
    // An FLA's global memory (a task without a project) belongs with global.
    else if (globalElsewhere && !task.personalProjectId) {
      memoryForOwner = memoryInput;
      memoryResult = { status: 'for_host', agentId: task.projectAgentId };
    } else memoryRequest = { expected_revision: prepared.request.expected_revision,
      memory: prepared.request.memory };
  }
  // rec#63: record that the Agent reported using these shown items, so ranking
  // can later learn "shown and used". Recording only; it never fails the
  // checkpoint and only updates rows this task's entry already showed.
  if (knowledgeUsage) {
    try {
      application.recallImpressions?.markUsed({ taskContextToken, items: knowledgeUsage });
    } catch {
      // Ignore: the impression must never fail the checkpoint.
    }
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
  const captureResult = internalActivity ? internalCaptureSkip(internalActivity) : captureToOwner ? FOR_HOST_CAPTURE
    : captureInput ? await captureKnowledge(captureInput) : null;
  const captureResults = hereBatches ? [] : null;
  for (const batch of hereBatches ?? []) {
    const result = await captureKnowledge(batch.input);
    captureResults.push(taskCaptureReceipt(batch.scope, batch.input, result));
  }
  const captureStatus = captureResults?.length ? taskCaptureStatus(captureResults)
    : captureResults ? FOR_HOST_CAPTURE.status
      : captureResult?.status ?? checkpoint.captureStatus;
  // Both capture paths keep what they saved, so the turn's receipt can read it back.
  const savedResults = captureResults?.length ? captureResults : legacyCaptureReceipts(captureInput, captureResult);
  const ownerOps = [
    ...(captureToOwner ? [captureInput] : []), ...ownerBatches.map(batch => batch.input)
  ].map(input => globalWrite(GLOBAL_WRITE_KINDS.capture, input));
  if (memoryForOwner) ownerOps.push(globalWrite(GLOBAL_WRITE_KINDS.agentMemory, memoryForOwner));
  const usedOwnerItems = globalElsewhere ? ownerItemsUsed(knowledgeUsage, preparedTask.checkpoint?.knowledgeUsageResult) : [];
  if (usedOwnerItems.length) {
    ownerOps.push(globalWrite(GLOBAL_WRITE_KINDS.knowledgeUsage,
      { taskId: task.token, sessionId: task.sessionId, sourceApplication, items: usedOwnerItems }));
  }
  // One send per checkpoint, under a key its retries share, so the owner applies it once.
  const forHost = ownerOps.length
    ? sentToOwner(await application.globalWrites.send({ key: `${task.token}:global`, ops: ownerOps })) : null;
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
    ...(captureResults ? { capture_status: captureStatus, ...(captureResults.length
      ? { capture_results: taskCaptureReviewPaths(application.config.personal.spaceId, captureResults) } : {}) } : {}),
    ...(internalActivity ? { capture_status: captureStatus } : {}),
    agent_memory: memoryResult ? {
      status: memoryResult.status, agentId: memoryResult.agentId,
      checkpointId: memoryResult.checkpointId, revision: memoryResult.revision,
      sourceApplication: memoryResult.sourceApplication,
      sourceSessionId: memoryResult.sourceSessionId, createdAt: memoryResult.createdAt
    } : null,
    // What this computer saved, and how its writes to global fared on their way to the owner.
    ...(forHost ? { saved_here: (savedResults?.length ?? 0) + (memoryResult?.status === 'checkpointed' ? 1 : 0),
      for_host: forHost } : {})
  }, completedTask, memoryResult?.status === 'checkpointed' && memoryResult.revision > agentMemory.expectedRevision ? memoryResult : null);
}

// A capture handed to the computer that owns global: saved there, not here.
const FOR_HOST_CAPTURE = Object.freeze({ route: 'host', status: 'for_host' });

function globalWrite(kind, input) {
  return { kind, v: 1, input };
}

// The reported uses of items this graph holds as read-only copies: their use is
// recorded by the computer that owns them (the Provider marks each held_by_owner).
function ownerItemsUsed(knowledgeUsage, usageResult) {
  const held = new Set((usageResult?.items ?? []).filter(item => item.held_by_owner)
    .map(item => `${item.item_kind}:${item.item_id}`));
  return (knowledgeUsage ?? []).filter(item => held.has(`${item.itemKind}:${item.itemId}`));
}

// The port's answer as the checkpoint repeats it, or a TypeError: a port that
// answered something else would leave the checkpoint saying nothing about them.
function sentToOwner(answer) {
  const count = value => Number.isSafeInteger(value) && value >= 0;
  if (!answer || typeof answer !== 'object' || !count(answer.delivered) || !count(answer.queued)
    || !Array.isArray(answer.refused) || answer.refused.some(item => typeof item?.kind !== 'string' || typeof item.code !== 'string')) {
    throw new TypeError('The global writes port did not say what it delivered, queued and refused');
  }
  return { delivered: answer.delivered, queued: answer.queued,
    refused: answer.refused.map(({ kind, code }) => ({ kind, code })) };
}

function canonicalCheckpoint(value) {
  if (Array.isArray(value)) return value.map(canonicalCheckpoint);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key, canonicalCheckpoint(value[key])
  ]));
}

// The continuation rules travel by version, as every task entry names them,
// rather than in full. A sealed worker, which cannot read the rule
// resources, keeps the text, as its entry does (task-context-view.js).
function sharedContinuation(receipt) {
  if (!receipt?.continuation?.guidance || activeSealedWorkerRequest()) return receipt;
  return { ...receipt, continuation: { ...receipt.continuation,
    guidance: ruleTextView(receipt.continuation.guidance, 'continuation_guidance') } };
}

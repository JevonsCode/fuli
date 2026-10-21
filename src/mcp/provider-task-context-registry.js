import { randomUUID } from 'node:crypto';
import { parseTaskAgentAssignment } from '../graphiti/task-agent-assignment.js';
import { taskActivityOrigin } from '../graphiti/task-activity-origin.js';

// The Provider is the sole source of truth. Hooks commonly use separate MCP
// processes; a process-local cache cannot prove that a task was checkpointed.
export class ProviderTaskContextRegistry {
  constructor(provider, personalSpaceId) {
    this.provider = provider;
    this.personalSpaceId = personalSpaceId;
  }

  async begin(input) {
    const scope = taskPreferenceScope(input.preferenceScope);
    const task = taskRecord(await this.provider.beginTaskContext({
      personal_space_id: this.personalSpaceId,
      personal_project_id: input.personalProjectId ?? null,
      project_agent_id: input.projectAgentId ?? null,
      session_id: input.sessionId,
      source_application: input.sourceApplication ?? 'other',
      source_session_id: input.sourceSessionId ?? null,
      token: `fuli-task-${randomUUID()}`,
      turn_id: input.turnId ?? null,
      memory_revision: input.memoryRevision ?? null,
      work_log_required: input.workLogRequired ?? false,
      entry_via: input.entryVia === 'hook' ? 'hook' : 'tool',
      ...(input.delegationToken ? { delegation_token: input.delegationToken } : {}),
      ...(input.preferenceScope !== undefined ? { preference_scope: scope } : {}),
      ...(input.agentAssignment ? { agent_assignment: parseTaskAgentAssignment(input.agentAssignment) } : {})
    }));
    if (scope && JSON.stringify(task.preferenceScope) !== JSON.stringify(scope)) {
      throw new TypeError('Provider did not preserve the fixed task preference scope');
    }
    return task;
  }

  async context(token, sourceApplication = 'other') {
    return taskRecord(await this.provider.getTaskContext(token, {
      personal_space_id: this.personalSpaceId, source_application: sourceApplication
    }));
  }

  async current(sessionId, sourceApplication = 'other') {
    const value = await this.provider.currentTaskContext({
      personal_space_id: this.personalSpaceId, session_id: sessionId,
      source_application: sourceApplication
    });
    return value?.token ? taskRecord(value) : null;
  }

  async preferences(token, { sourceApplication, sessionId }) {
    const value = await this.provider.readTaskPreferences(token, {
      personal_space_id: this.personalSpaceId, source_application: sourceApplication,
      session_id: sessionId
    });
    if (value.task_context?.personal_space_id !== this.personalSpaceId) {
      throw new TypeError('Provider task preference space changed');
    }
    return { task: taskRecord(value.task_context), preferences: value.preferences };
  }

  async adoptAgent(token, { personalProjectId, taskId, agentId }, sourceApplication = 'other') {
    return taskRecord(await this.provider.adoptTaskContextAgent(token, {
      personal_space_id: this.personalSpaceId, personal_project_id: personalProjectId,
      task_id: taskId, agent_id: agentId, source_application: sourceApplication
    }));
  }

  async bindCoordinationTask(token, { personalProjectId, taskId }, sourceApplication = 'other') {
    return taskRecord(await this.provider.bindTaskContextCoordinationTask(token, {
      personal_space_id: this.personalSpaceId, personal_project_id: personalProjectId,
      task_id: taskId, source_application: sourceApplication
    }));
  }

  prepare(token, checkpoint, sourceApplication = 'other', agentMemory = null) {
    return this.#write(token, checkpoint, 'prepare', sourceApplication, agentMemory);
  }

  checkpoint(token, checkpoint, sourceApplication = 'other') {
    return this.#write(token, checkpoint, 'complete', sourceApplication);
  }

  // True when this checkpoint's reply should carry its turn receipt: it was
  // unread, or this same task already claimed it (a retry).
  async claimTurnReceipt(token, sourceApplication = 'other') {
    const result = await this.provider.claimTurnReceipt(token, {
      personal_space_id: this.personalSpaceId, source_application: sourceApplication
    });
    return result?.deliver === true;
  }

  verify(sessionId, sourceApplication = 'other') {
    return this.provider.verifyTaskCheckpoint({
      personal_space_id: this.personalSpaceId, session_id: sessionId,
      source_application: sourceApplication
    });
  }

  async #write(token, value, phase, sourceApplication, agentMemory = null) {
    return taskRecord(await this.provider.checkpointTaskContext(token, {
      personal_space_id: this.personalSpaceId, source_application: sourceApplication,
      phase, disposition: value.disposition, reason: value.reason,
      fingerprint: value.fingerprint, capture_status: value.captureStatus ?? null,
      ...(value.captureResults ? { capture_results: value.captureResults } : {}),
      ...(value.workLog ? { work_log: value.workLog } : {}),
      ...(value.knowledgeUsage ? { knowledge_usage: value.knowledgeUsage.map(item => ({
        item_id: item.itemId, item_kind: item.itemKind, use_kind: item.useKind
      })) } : {}),
      ...(agentMemory ? { agent_memory: agentMemory } : {})
    }));
  }
}

export function taskRecord(value) {
  if (typeof value?.token !== 'string' || !value?.session_id) {
    throw new TypeError('Provider did not return a durable task context');
  }
  return {
    token: value.token, sessionId: value.session_id,
    personalProjectId: value.personal_project_id,
    projectScope: value.project_scope ?? null,
    agentMemoryScope: value.agent_memory_scope ?? null,
    projectAgentId: value.project_agent_id,
    coordinationTaskId: value.coordination_task_id ?? null,
    coordinationTaskIds: value.coordination_task_ids ?? (value.coordination_task_id ? [value.coordination_task_id] : []),
    sourceApplication: value.source_application,
    sourceSessionId: value.source_session_id ?? null,
    turnId: value.turn_id ?? null,
    entryVia: value.entry_via ?? 'tool',
    activityOrigin: taskActivityOrigin(value.activity_origin),
    routineAutoCloseEligible: value.routine_auto_close_eligible === true,
    preferenceScope: taskPreferenceScope(value.preference_scope),
    agentAssignment: storedAgentAssignment(value.agent_assignment),
    memoryRevision: value.memory_revision,
    workLogRequired: value.work_log_required ?? false,
    agentMemory: value.agent_memory ?? null,
    previousCheckpointMissing: Boolean(value.previous_checkpoint_missing),
    // Receipts of this session's earlier turns that never reached a reply.
    unreadTurnReceipts: Array.isArray(value.unread_turn_receipts) ? value.unread_turn_receipts : [],
    checkpoint: value.checkpoint ? {
      ...value.checkpoint, captureStatus: value.checkpoint.capture_status,
      ...(value.checkpoint.knowledge_usage_result ? { knowledgeUsageResult: value.checkpoint.knowledge_usage_result } : {}),
      ...(value.checkpoint.capture_results ? { captureResults: value.checkpoint.capture_results } : {})
    } : null
  };
}

// An invalid stored assignment is unknown, never a partial reporting line.
function storedAgentAssignment(value) {
  try { return parseTaskAgentAssignment(value); } catch { return null; }
}

// Absent/null is legacy unknown, distinct from an explicit v1 null/null scope.
export function taskPreferenceScope(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
      Object.keys(value).length !== 3 || !Object.hasOwn(value, 'version') ||
      !Object.hasOwn(value, 'work_kind') || !Object.hasOwn(value, 'workflow') ||
      [value.work_kind, value.workflow].some(item => item !== null &&
        (typeof item !== 'string' || item.length < 1 || [...item].length > 128))) {
    throw new TypeError('Task preference scope is invalid');
  }
  return { version: 1, work_kind: value.work_kind, workflow: value.workflow };
}

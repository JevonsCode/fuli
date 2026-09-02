import { randomUUID } from 'node:crypto';

// The Provider is the sole source of truth. Hooks commonly use separate MCP
// processes; a process-local cache cannot prove that a task was checkpointed.
export class ProviderTaskContextRegistry {
  constructor(provider, personalSpaceId) {
    this.provider = provider;
    this.personalSpaceId = personalSpaceId;
  }

  async begin(input) {
    return taskRecord(await this.provider.beginTaskContext({
      personal_space_id: this.personalSpaceId,
      personal_project_id: input.personalProjectId ?? null,
      project_agent_id: input.projectAgentId ?? null,
      session_id: input.sessionId,
      source_application: input.sourceApplication ?? 'other',
      source_session_id: input.sourceSessionId ?? null,
      token: `fuli-task-${randomUUID()}`,
      turn_id: input.turnId ?? null,
      memory_revision: input.memoryRevision ?? null
    }));
  }

  async context(token, sourceApplication = 'other') {
    return taskRecord(await this.provider.getTaskContext(token, {
      personal_space_id: this.personalSpaceId, source_application: sourceApplication
    }));
  }

  prepare(token, checkpoint, sourceApplication = 'other', agentMemory = null) {
    return this.#write(token, checkpoint, 'prepare', sourceApplication, agentMemory);
  }

  checkpoint(token, checkpoint, sourceApplication = 'other') {
    return this.#write(token, checkpoint, 'complete', sourceApplication);
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
      ...(agentMemory ? { agent_memory: agentMemory } : {})
    }));
  }
}

function taskRecord(value) {
  if (typeof value?.token !== 'string' || !value?.session_id) {
    throw new TypeError('Provider did not return a durable task context');
  }
  return {
    token: value.token, sessionId: value.session_id,
    personalProjectId: value.personal_project_id,
    projectAgentId: value.project_agent_id,
    sourceApplication: value.source_application,
    sourceSessionId: value.source_session_id ?? null,
    turnId: value.turn_id ?? null,
    memoryRevision: value.memory_revision,
    agentMemory: value.agent_memory ?? null,
    previousCheckpointMissing: Boolean(value.previous_checkpoint_missing),
    checkpoint: value.checkpoint ? {
      ...value.checkpoint, captureStatus: value.checkpoint.capture_status
    } : null
  };
}
